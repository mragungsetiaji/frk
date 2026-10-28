/**
 * Turns git's unified diff for one file into rows for the unified and split
 * views, and finds the words that changed between a removed line and the
 * added line that replaced it.
 */

export type Row =
  | { kind: "hunk"; text: string; hunk: number }
  | { kind: "ctx"; old: number; new: number; text: string }
  | { kind: "del"; old: number; text: string; marks?: Range[] }
  | { kind: "add"; new: number; text: string; marks?: Range[] }
  | { kind: "meta"; text: string };

/** Character range [start, end) within a line. */
export type Range = [number, number];

export interface ParsedDiff {
  rows: Row[];
  /** Row index of each hunk header, for jumping between changes. */
  hunks: number[];
  binary: boolean;
}

export function parseDiff(diff: string): ParsedDiff {
  const rows: Row[] = [];
  const hunks: number[] = [];
  let o = 0;
  let n = 0;
  let inHunk = false;
  let binary = false;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      o = m ? Number(m[1]) : 0;
      n = m ? Number(m[2]) : 0;
      inHunk = true;
      hunks.push(rows.length);
      rows.push({ kind: "hunk", text: raw, hunk: hunks.length - 1 });
    } else if (!inHunk) {
      if (raw.startsWith("Binary files")) binary = true;
    } else if (raw.startsWith("+")) {
      rows.push({ kind: "add", new: n++, text: raw.slice(1) });
    } else if (raw.startsWith("-")) {
      rows.push({ kind: "del", old: o++, text: raw.slice(1) });
    } else if (raw.startsWith(" ")) {
      rows.push({ kind: "ctx", old: o++, new: n++, text: raw.slice(1) });
    } else if (raw.startsWith("\\")) {
      rows.push({ kind: "meta", text: raw });
    }
  }
  markWordChanges(rows);
  return { rows, hunks, binary };
}

/**
 * Pairs each block of removed lines with the block of added lines right after
 * it, line by line, and marks the words that differ within each pair.
 */
function markWordChanges(rows: Row[]) {
  let i = 0;
  while (i < rows.length) {
    if (rows[i].kind !== "del") {
      i++;
      continue;
    }
    const delStart = i;
    while (i < rows.length && rows[i].kind === "del") i++;
    const addStart = i;
    while (i < rows.length && rows[i].kind === "add") i++;
    const pairs = Math.min(addStart - delStart, i - addStart);
    for (let k = 0; k < pairs; k++) {
      const d = rows[delStart + k] as Extract<Row, { kind: "del" }>;
      const a = rows[addStart + k] as Extract<Row, { kind: "add" }>;
      const marks = wordDiff(d.text, a.text);
      if (marks) [d.marks, a.marks] = marks;
    }
  }
}

const TOKEN = /\w+|\s+|[^\w\s]/g;
const MAX_TOKENS = 400;

/**
 * Word-level diff of two lines via LCS over word, space and punctuation
 * tokens. Returns null when the lines share too little for the marks to help:
 * marking nearly a whole line says less than not marking it.
 */
export function wordDiff(a: string, b: string): [Range[], Range[]] | null {
  const ta = a.match(TOKEN) ?? [];
  const tb = b.match(TOKEN) ?? [];
  if (ta.length > MAX_TOKENS || tb.length > MAX_TOKENS) return null;
  const m = ta.length;
  const n = tb.length;
  const dp: Uint16Array[] = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = ta[i] === tb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const keepA = new Array<boolean>(m).fill(false);
  const keepB = new Array<boolean>(n).fill(false);
  for (let i = 0, j = 0; i < m && j < n; ) {
    if (ta[i] === tb[j]) {
      keepA[i++] = true;
      keepB[j++] = true;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  const toRanges = (tokens: string[], keep: boolean[]): Range[] => {
    const out: Range[] = [];
    let pos = 0;
    tokens.forEach((t, i) => {
      if (!keep[i]) {
        const last = out[out.length - 1];
        if (last && last[1] === pos) last[1] = pos + t.length;
        else out.push([pos, pos + t.length]);
      }
      pos += t.length;
    });
    return out;
  };
  const ra = toRanges(ta, keepA);
  const rb = toRanges(tb, keepB);
  const changed = (rs: Range[]) => rs.reduce((s, [x, y]) => s + y - x, 0);
  const share = Math.max(changed(ra) / Math.max(a.length, 1), changed(rb) / Math.max(b.length, 1));
  if (share > 0.7 || (ra.length === 0 && rb.length === 0)) return null;
  return [ra, rb];
}

export type SplitRow =
  | { kind: "hunk"; text: string; hunk: number }
  | { kind: "meta"; text: string }
  | {
      kind: "line";
      left?: Extract<Row, { kind: "del" | "ctx" }>;
      right?: Extract<Row, { kind: "add" | "ctx" }>;
    };

/** Side by side: context on both sides, removed lines opposite their replacements. */
export function toSplit(rows: Row[]): { rows: SplitRow[]; hunks: number[] } {
  const out: SplitRow[] = [];
  const hunks: number[] = [];
  let i = 0;
  while (i < rows.length) {
    const r = rows[i];
    if (r.kind === "hunk") {
      hunks.push(out.length);
      out.push(r);
      i++;
    } else if (r.kind === "meta") {
      out.push(r);
      i++;
    } else if (r.kind === "ctx") {
      out.push({ kind: "line", left: r, right: r });
      i++;
    } else {
      const dels: Extract<Row, { kind: "del" }>[] = [];
      const adds: Extract<Row, { kind: "add" }>[] = [];
      while (i < rows.length && rows[i].kind === "del") dels.push(rows[i++] as Extract<Row, { kind: "del" }>);
      while (i < rows.length && rows[i].kind === "add") adds.push(rows[i++] as Extract<Row, { kind: "add" }>);
      for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
        out.push({ kind: "line", left: dels[k], right: adds[k] });
      }
    }
  }
  return { rows: out, hunks };
}
