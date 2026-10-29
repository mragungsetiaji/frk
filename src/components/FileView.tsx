import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, Blame, FileVersions, HistoryEntry } from "../api";
import { highlightLines, languageFor, lineText, Lines, plainLine, Run } from "../code/highlight";
import { parseDiff, Range, Row, SplitRow, toSplit } from "../code/diffModel";
import { FileMode, OpenFile, useStore } from "../store";
import { personColor, splitPath, timeAgo } from "../util";
import { Avatar } from "./Icons";

const LINE_H = 20;

/** Full-page view of one file in one commit: diff, whole file, blame or history. */
export function FileView() {
  const file = useStore((s) => s.file);
  const mode = useStore((s) => s.fileMode);
  const prefs = useStore((s) => s.filePrefs);
  const setMode = useStore((s) => s.setFileMode);
  const setPrefs = useStore((s) => s.setFilePrefs);
  const closeFile = useStore((s) => s.closeFile);
  const nav = useRef<{ step: (dir: 1 | -1) => void } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !useStore.getState().dialog && !useStore.getState().menu) closeFile();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeFile]);

  if (!file) return null;
  const [dir, name] = splitPath(file.path);
  const hasDiff = file.status != null;
  const lang = languageFor(file.path);

  return (
    <section className="file-view">
      <header className="fv-head">
        <span className={`fv-status s-${file.status ?? "none"}`}>{statusIcon(file.status)}</span>
        <span className="fv-path ellipsis" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
          {file.oldPath && <span className="muted">{file.oldPath} → </span>}
          <span className="muted">{dir}</span>
          <span className="fv-name">{name}</span>
        </span>
        <span className="spacer" />
        {file.wip && <WipSide file={file} />}
        <span className="muted small">{lang ?? "plain text"}</span>
        <button className="icon-btn" title="Close (Esc)" aria-label="Close file" onClick={closeFile}>
          ✕
        </button>
      </header>
      <div className="fv-toolbar">
        <div className="segmented" role="group" aria-label="View">
          <ModeButton mode="file" current={mode} onClick={setMode}>
            File View
          </ModeButton>
          <ModeButton mode="diff" current={mode} onClick={setMode} disabled={!hasDiff}>
            Diff View
          </ModeButton>
        </div>
        <span className="spacer" />
        <div className="segmented" role="group" aria-label="More">
          <ModeButton mode="blame" current={mode} onClick={setMode} disabled={file.status === "D" || !!file.wip}>
            Blame
          </ModeButton>
          <ModeButton mode="history" current={mode} onClick={setMode} disabled={!!file.wip}>
            History
          </ModeButton>
        </div>
        {mode === "diff" && (
          <>
            <div className="segmented" role="group" aria-label="Changes">
              <button title="Previous change" aria-label="Previous change" onClick={() => nav.current?.step(-1)}>
                ↑
              </button>
              <button title="Next change" aria-label="Next change" onClick={() => nav.current?.step(1)}>
                ↓
              </button>
            </div>
            <div className="segmented" role="group" aria-label="Layout">
              <button
                className={prefs.diffLayout === "unified" ? "on" : ""}
                title="Unified"
                onClick={() => setPrefs({ diffLayout: "unified" })}
              >
                <UnifiedIcon />
              </button>
              <button
                className={prefs.diffLayout === "split" ? "on" : ""}
                title="Split"
                onClick={() => setPrefs({ diffLayout: "split" })}
              >
                <SplitIcon />
              </button>
            </div>
            <button
              className={`btn ws-toggle${prefs.ignoreWhitespace ? " on" : ""}`}
              title={prefs.ignoreWhitespace ? "Whitespace changes hidden" : "Hide whitespace changes"}
              aria-pressed={prefs.ignoreWhitespace}
              onClick={() => setPrefs({ ignoreWhitespace: !prefs.ignoreWhitespace })}
            >
              ¶
            </button>
          </>
        )}
      </div>
      <div className="fv-body">
        {mode === "history" ? (
          <HistoryList file={file} />
        ) : (
          <CodePane key={`${file.sha}:${file.path}`} file={file} mode={mode} lang={lang} nav={nav} />
        )}
      </div>
    </section>
  );
}

/**
 * Which side of the index an uncommitted file is shown from, and a button to
 * move it across. The view follows the file to the other side.
 */
function WipSide({ file }: { file: OpenFile }) {
  const busy = useStore((s) => s.busy);
  const { stage, unstage, openFile, closeFile } = useStore.getState();
  const staged = file.wip!.staged;
  const move = async () => {
    await (staged ? unstage([file.path]) : stage([file.path]));
    const wip = useStore.getState().wip;
    const next = (staged ? wip?.unstaged : wip?.staged)?.find((f) => f.path === file.path);
    if (next) openFile({ ...file, status: next.status, wip: { file: next, staged: !staged } }, "diff");
    else closeFile();
  };
  return (
    <>
      <span className={`side-chip${staged ? " staged" : ""}`}>{staged ? "Staged" : "Unstaged"}</span>
      <button className={`btn small ${staged ? "" : "stage-all"}`} disabled={busy} onClick={move}>
        {staged ? "Unstage File" : "Stage File"}
      </button>
    </>
  );
}

function ModeButton({
  mode,
  current,
  onClick,
  disabled,
  children,
}: {
  mode: FileMode;
  current: FileMode;
  onClick: (m: FileMode) => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button className={current === mode ? "on" : ""} disabled={disabled} onClick={() => onClick(mode)}>
      {children}
    </button>
  );
}

function statusIcon(status: string | null) {
  switch (status) {
    case "A":
      return "+";
    case "D":
      return "−";
    case "R":
    case "C":
      return "→";
    case null:
      return "·";
    default:
      return "✎";
  }
}

const UnifiedIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
    <rect x="2" y="2.5" width="12" height="11" rx="1" />
    <path d="M4.5 6h7M4.5 8h7M4.5 10h7" />
  </svg>
);

const SplitIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
    <rect x="2" y="2.5" width="12" height="11" rx="1" />
    <path d="M8 2.5v11" />
  </svg>
);

interface Loaded {
  versions: FileVersions | null;
  diff: string | null;
  blame: Blame | null;
  error: string | null;
}

/** Loads what the current mode needs, once per file (and per whitespace setting for the diff). */
function useFileData(file: OpenFile, mode: FileMode, ignoreWs: boolean): Loaded {
  const [versions, setVersions] = useState<FileVersions | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [blame, setBlame] = useState<Blame | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    (file.wip ? api.wipFileVersions(file.wip.file, file.wip.staged) : api.fileVersions(file.sha, file.path, file.oldPath))
      .then((v) => live && setVersions(v))
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [file.sha, file.path, file.oldPath, file.wip]);

  useEffect(() => {
    if (file.status == null) {
      setDiff("");
      return;
    }
    let live = true;
    setDiff(null);
    (file.wip
      ? api.wipFileDiff(file.wip.file, file.wip.staged, ignoreWs)
      : api.fileDiff(file.sha, file.path, file.oldPath, ignoreWs)
    )
      .then((d) => live && setDiff(d))
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [file.sha, file.path, file.oldPath, file.status, file.wip, ignoreWs]);

  useEffect(() => {
    if (mode !== "blame" || blame) return;
    let live = true;
    api
      .blame(file.sha, file.path)
      .then((b) => live && setBlame(b))
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [mode, blame, file.sha, file.path]);

  return { versions, diff, blame, error };
}

function CodePane({
  file,
  mode,
  lang,
  nav,
}: {
  file: OpenFile;
  mode: FileMode;
  lang: string | null;
  nav: React.MutableRefObject<{ step: (dir: 1 | -1) => void } | null>;
}) {
  const prefs = useStore((s) => s.filePrefs);
  const { versions, diff, blame, error } = useFileData(file, mode, prefs.ignoreWhitespace);

  const oldLines = useMemo(() => (versions?.old != null ? highlightLines(versions.old, lang) : null), [versions, lang]);
  const newLines = useMemo(() => (versions?.new != null ? highlightLines(versions.new, lang) : null), [versions, lang]);
  const parsed = useMemo(() => (diff != null ? parseDiff(diff) : null), [diff]);

  if (error) return <p className="error-text">{error}</p>;
  if (!versions || diff == null) return <div className="fv-loading muted">Loading…</div>;
  if (versions.binary || parsed?.binary) return <Empty text="Binary file; there is nothing to show as text." />;

  if (mode === "diff") {
    if (!parsed || parsed.rows.length === 0) {
      return <Empty text={prefs.ignoreWhitespace ? "Only whitespace changed." : "No textual changes (a mode change or a pure rename)."} />;
    }
    return prefs.diffLayout === "split" ? (
      <SplitDiff rows={parsed.rows} oldLines={oldLines} newLines={newLines} nav={nav} />
    ) : (
      <UnifiedDiff rows={parsed.rows} hunks={parsed.hunks} oldLines={oldLines} newLines={newLines} nav={nav} />
    );
  }

  // File and blame views show the file as of this commit (or, for a deleted
  // file, as it was just before).
  const lines = newLines ?? oldLines;
  if (versions.tooLarge || !lines) return <Empty text="This file is too large to show in full; Diff View still works." />;
  const added = new Set(parsed?.rows.filter((r) => r.kind === "add").map((r) => (r as { new: number }).new));
  if (mode === "blame") {
    return blame ? <BlameView lines={lines} blame={blame} file={file} /> : <div className="fv-loading muted">Blaming…</div>;
  }
  return <WholeFile lines={lines} added={newLines ? added : new Set()} />;
}

function Empty({ text }: { text: string }) {
  return <div className="fv-empty muted">{text}</div>;
}

/** Prism classes become `t-*` so they cannot collide with the app's own. */
function tokenClass(cls: string): string | undefined {
  return cls ? cls.split(" ").map((c) => `t-${c}`).join(" ") : undefined;
}

/** Renders syntax runs, splitting them where word-level change marks begin and end. */
function Code({ runs, marks }: { runs: Run[]; marks?: Range[] }) {
  if (!marks || marks.length === 0) {
    return (
      <>
        {runs.map((r, i) => (
          <span key={i} className={tokenClass(r.cls)}>
            {r.text}
          </span>
        ))}
      </>
    );
  }
  const out: React.ReactNode[] = [];
  let pos = 0;
  let mi = 0;
  runs.forEach((r, ri) => {
    let start = 0;
    while (start < r.text.length) {
      const abs = pos + start;
      while (mi < marks.length && marks[mi][1] <= abs) mi++;
      const m = marks[mi];
      const inMark = !!m && abs >= m[0];
      const end = inMark ? Math.min(r.text.length, m[1] - pos) : m ? Math.min(r.text.length, m[0] - pos) : r.text.length;
      const cls = [tokenClass(r.cls), inMark ? "wd" : ""].filter(Boolean).join(" ");
      out.push(
        <span key={`${ri}:${start}`} className={cls || undefined}>
          {r.text.slice(start, end)}
        </span>,
      );
      start = end;
    }
    pos += r.text.length;
  });
  return <>{out}</>;
}

/**
 * The highlighted line for a diff row, taken from the whole-file highlighting
 * when it matches what git printed. With whitespace ignored, git may print the
 * other side's spacing, and then the row falls back to plain text.
 */
function runsFor(lines: Lines | null, num: number, text: string): Run[] {
  const runs = lines?.[num - 1];
  return runs && lineText(runs) === text.replace(/\r$/, "") ? runs : plainLine(text);
}

function maxChars(texts: string[]): number {
  let max = 0;
  for (const t of texts) max = Math.max(max, t.length + (t.split("\t").length - 1) * 3);
  return max;
}

function useHunkNav(
  nav: React.MutableRefObject<{ step: (dir: 1 | -1) => void } | null>,
  hunks: number[],
  virt: ReturnType<typeof useVirtualizer<HTMLDivElement, Element>>,
  scrollRef: React.RefObject<HTMLDivElement | null>,
) {
  useEffect(() => {
    nav.current = {
      step(dir) {
        const top = Math.floor((scrollRef.current?.scrollTop ?? 0) / LINE_H);
        const target = dir === 1 ? hunks.find((h) => h > top) : [...hunks].reverse().find((h) => h < top);
        if (target != null) virt.scrollToIndex(target, { align: "start" });
      },
    };
    return () => {
      nav.current = null;
    };
  }, [nav, hunks, virt, scrollRef]);
}

function UnifiedDiff({
  rows,
  hunks,
  oldLines,
  newLines,
  nav,
}: {
  rows: Row[];
  hunks: number[];
  oldLines: Lines | null;
  newLines: Lines | null;
  nav: React.MutableRefObject<{ step: (dir: 1 | -1) => void } | null>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => LINE_H,
    overscan: 20,
  });
  useHunkNav(nav, hunks, virt, scrollRef);
  const width = `calc(112px + ${maxChars(rows.map((r) => r.text)) + 4}ch)`;

  return (
    <div ref={scrollRef} className="code-scroll mono">
      <div style={{ height: virt.getTotalSize(), width, minWidth: "100%", position: "relative" }}>
        {virt.getVirtualItems().map((item) => {
          const r = rows[item.index];
          const style = { transform: `translateY(${item.start}px)` };
          if (r.kind === "hunk" || r.kind === "meta") {
            return (
              <div key={item.key} className={`cl ${r.kind}`} style={style}>
                <span className="ln" />
                <span className="ln" />
                <span className="mk" />
                <span className="code">{r.text}</span>
              </div>
            );
          }
          const runs =
            r.kind === "del" ? runsFor(oldLines, r.old, r.text) : runsFor(newLines, r.new, r.text);
          return (
            <div key={item.key} className={`cl ${r.kind}`} style={style}>
              <span className="ln">{r.kind !== "add" ? r.old : ""}</span>
              <span className="ln">{r.kind !== "del" ? r.new : ""}</span>
              <span className="mk">{r.kind === "add" ? "+" : r.kind === "del" ? "−" : ""}</span>
              <span className="code">
                <Code runs={runs} marks={r.kind === "add" || r.kind === "del" ? r.marks : undefined} />
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SplitDiff({
  rows,
  oldLines,
  newLines,
  nav,
}: {
  rows: Row[];
  oldLines: Lines | null;
  newLines: Lines | null;
  nav: React.MutableRefObject<{ step: (dir: 1 | -1) => void } | null>;
}) {
  const split = useMemo(() => toSplit(rows), [rows]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const virt = useVirtualizer({
    count: split.rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => LINE_H,
    overscan: 20,
  });
  useHunkNav(nav, split.hunks, virt, scrollRef);
  const half = "50%";
  const longest = useMemo(() => maxChars(rows.map((r) => r.text)), [rows]);

  // Each side is half the width; long lines scroll sideways on both sides at
  // once, with the line numbers held still, so the two versions stay aligned.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let x = 0;
    const onWheel = (e: WheelEvent) => {
      const dx = e.shiftKey && e.deltaX === 0 ? e.deltaY : e.deltaX;
      if (dx === 0) return;
      e.preventDefault();
      const ch = parseFloat(getComputedStyle(el).fontSize) * 0.6;
      const max = Math.max(0, (longest + 4) * ch - (el.clientWidth / 2 - 62));
      x = Math.min(max, Math.max(0, x + dx));
      el.style.setProperty("--sx", `${x}px`);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [longest]);

  const side = (r: SplitRow, which: "left" | "right") => {
    if (r.kind !== "line") return null;
    const line = which === "left" ? r.left : r.right;
    if (!line) return <div className="sd blank" style={{ width: half }} />;
    const num = which === "left" ? (line as { old: number }).old : (line as { new: number }).new;
    const runs = which === "left" ? runsFor(oldLines, num, line.text) : runsFor(newLines, num, line.text);
    const kind = line.kind;
    return (
      <div className={`sd ${kind}`} style={{ width: half }}>
        <span className="ln">{num}</span>
        <span className="mk">{kind === "add" ? "+" : kind === "del" ? "−" : ""}</span>
        <span className="code">
          <Code runs={runs} marks={kind === "add" || kind === "del" ? line.marks : undefined} />
        </span>
      </div>
    );
  };

  return (
    <div ref={scrollRef} className="code-scroll split-scroll mono">
      <div style={{ height: virt.getTotalSize(), width: "100%", position: "relative" }}>
        {virt.getVirtualItems().map((item) => {
          const r = split.rows[item.index];
          const style = { transform: `translateY(${item.start}px)` };
          if (r.kind !== "line") {
            return (
              <div key={item.key} className={`cl ${r.kind}`} style={style}>
                <span className="code">{r.text}</span>
              </div>
            );
          }
          return (
            <div key={item.key} className="cl split" style={style}>
              {side(r, "left")}
              {side(r, "right")}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function WholeFile({ lines, added }: { lines: Lines; added: Set<number> }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virt = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => LINE_H,
    overscan: 20,
  });
  const width = `calc(76px + ${maxChars(lines.map(lineText)) + 4}ch)`;
  // Open on the first line this commit changed.
  useEffect(() => {
    const first = Math.min(...added);
    if (Number.isFinite(first)) virt.scrollToIndex(first - 1, { align: "center" });
    // Only when the file first renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div ref={scrollRef} className="code-scroll mono">
      <div style={{ height: virt.getTotalSize(), width, minWidth: "100%", position: "relative" }}>
        {virt.getVirtualItems().map((item) => {
          const n = item.index + 1;
          return (
            <div key={item.key} className={`cl file${added.has(n) ? " add" : ""}`} style={{ transform: `translateY(${item.start}px)` }}>
              <span className="ln">{n}</span>
              <span className="mk">{added.has(n) ? "+" : ""}</span>
              <span className="code">
                <Code runs={lines[item.index]} />
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function BlameView({ lines, blame, file }: { lines: Lines; blame: Blame; file: OpenFile }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const select = useStore((s) => s.select);
  const openFile = useStore((s) => s.openFile);
  const virt = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => LINE_H,
    overscan: 20,
  });
  // Age shading: the newest commit in the file is brightest.
  const [minT, maxT] = useMemo(() => {
    const ts = blame.commits.map((c) => c.time);
    return [Math.min(...ts), Math.max(...ts)];
  }, [blame]);
  const width = `calc(300px + ${maxChars(lines.map(lineText)) + 4}ch)`;

  const open = async (sha: string) => {
    await select(sha);
    openFile({ sha, path: file.path, oldPath: null, status: "M" }, "blame");
  };

  return (
    <div ref={scrollRef} className="code-scroll mono">
      <div style={{ height: virt.getTotalSize(), width, minWidth: "100%", position: "relative" }}>
        {virt.getVirtualItems().map((item) => {
          const i = item.index;
          const ci = blame.lines[i];
          const c = ci != null ? blame.commits[ci] : undefined;
          const startsRun = i === 0 || blame.lines[i - 1] !== ci;
          const age = c && maxT > minT ? (c.time - minT) / (maxT - minT) : 1;
          const mine = c?.sha === file.sha;
          return (
            <div
              key={item.key}
              className={`cl blame${startsRun ? " run-start" : ""}${mine ? " add" : ""}`}
              style={{ transform: `translateY(${item.start}px)` }}
            >
              <button
                className="bl-gutter"
                style={{ borderLeftColor: `rgba(63, 182, 232, ${0.15 + 0.85 * age})` }}
                title={c ? `${c.summary}\n${c.author} · ${c.sha.slice(0, 7)} · ${new Date(c.time * 1000).toLocaleString()}` : undefined}
                onClick={() => c && !mine && open(c.sha)}
              >
                {startsRun && c && (
                  <>
                    <Avatar name={c.author} email={c.email} size={15} />
                    <span className="bl-author ellipsis" style={{ color: personColor(c.email || c.author) }}>
                      {c.author}
                    </span>
                    <span className="bl-sum ellipsis">{c.summary}</span>
                    <span className="bl-when">{timeAgo(c.time)}</span>
                  </>
                )}
              </button>
              <span className="ln">{i + 1}</span>
              <span className="code">
                <Code runs={lines[i]} />
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function HistoryList({ file }: { file: OpenFile }) {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const select = useStore((s) => s.select);
  const openFile = useStore((s) => s.openFile);

  useEffect(() => {
    let live = true;
    api
      .fileHistory(file.sha, file.path)
      .then((h) => live && setEntries(h))
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
    // History is anchored where it was opened; moving along it must not reload it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.path]);

  if (error) return <p className="error-text">{error}</p>;
  if (!entries) return <div className="fv-loading muted">Loading history…</div>;

  return (
    <ul className="history">
      {entries.map((h) => (
        <li key={h.sha}>
          <button
            className={`history-item${h.sha === file.sha ? " on" : ""}`}
            onClick={async () => {
              await select(h.sha);
              openFile({ sha: h.sha, path: h.path, oldPath: h.oldPath, status: h.status }, "diff");
            }}
          >
            <Avatar name={h.author} email={h.email} size={22} />
            <span className="history-main">
              <span className="ellipsis">{h.subject}</span>
              <span className="muted small ellipsis">
                {h.author} · {timeAgo(h.time)}
                {h.oldPath ? ` · renamed from ${h.oldPath}` : ""}
              </span>
            </span>
            <span className={`status s-${h.status}`}>{h.status}</span>
            <span className="mono muted small">{h.sha.slice(0, 7)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
