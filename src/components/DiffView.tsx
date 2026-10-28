import { useEffect, useState } from "react";
import { api, FileChange } from "../api";

interface Line {
  kind: "hunk" | "add" | "del" | "ctx" | "meta";
  old?: number;
  new?: number;
  text: string;
}

/** A diff past this many lines is cut off; rendering it all is not useful. */
const MAX_LINES = 4000;

function parse(diff: string): Line[] {
  const out: Line[] = [];
  let o = 0;
  let n = 0;
  let inHunk = false;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      o = m ? Number(m[1]) : 0;
      n = m ? Number(m[2]) : 0;
      inHunk = true;
      out.push({ kind: "hunk", text: raw });
    } else if (!inHunk) {
      if (raw.startsWith("Binary files")) out.push({ kind: "meta", text: raw });
    } else if (raw.startsWith("+")) {
      out.push({ kind: "add", new: n++, text: raw.slice(1) });
    } else if (raw.startsWith("-")) {
      out.push({ kind: "del", old: o++, text: raw.slice(1) });
    } else if (raw.startsWith(" ")) {
      out.push({ kind: "ctx", old: o++, new: n++, text: raw.slice(1) });
    } else if (raw.startsWith("\\")) {
      out.push({ kind: "meta", text: raw });
    }
  }
  return out;
}

export function DiffView({ sha, file }: { sha: string; file: FileChange }) {
  const [lines, setLines] = useState<Line[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setLines(null);
    setError(null);
    api
      .fileDiff(sha, file.path, file.oldPath)
      .then((d) => live && setLines(parse(d)))
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [sha, file.path, file.oldPath]);

  return (
    <div className="diff">
      <div className="diff-title small mono ellipsis">{file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}</div>
      {error && <p className="error-text">{error}</p>}
      {lines && lines.length === 0 && <p className="muted small">No textual changes (mode or rename only).</p>}
      {lines && (
        <div className="diff-body mono">
          {lines.slice(0, MAX_LINES).map((l, i) => (
            <div key={i} className={`dl ${l.kind}`}>
              <span className="ln">{l.old ?? ""}</span>
              <span className="ln">{l.new ?? ""}</span>
              <span className="code">{l.text || " "}</span>
            </div>
          ))}
          {lines.length > MAX_LINES && (
            <div className="dl meta">
              <span className="ln" />
              <span className="ln" />
              <span className="code">… {lines.length - MAX_LINES} more lines not shown</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
