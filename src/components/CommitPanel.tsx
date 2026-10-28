import { useEffect, useMemo, useState } from "react";
import { api, CommitDetail, FileChange } from "../api";
import { useStore } from "../store";
import { formatDate, reflow, splitPath } from "../util";
import { Avatar } from "./Icons";

export function CommitPanel() {
  const selected = useStore((s) => s.selected);
  const jumpTo = useStore((s) => s.jumpTo);
  const [detail, setDetail] = useState<CommitDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    if (!selected) {
      setDetail(null);
      return;
    }
    let live = true;
    api
      .commitDetail(selected)
      .then((d) => live && setDetail(d))
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [selected]);

  if (!selected) {
    return (
      <aside className="detail empty-detail">
        <p className="muted">Select a commit to see what it changed.</p>
      </aside>
    );
  }
  if (error) {
    return (
      <aside className="detail">
        <p className="error-text">{error}</p>
      </aside>
    );
  }
  if (!detail || detail.sha !== selected) return <aside className="detail" />;

  const counts = { M: 0, A: 0, D: 0, R: 0 };
  for (const f of detail.files) {
    const k = (f.status === "C" ? "A" : f.status === "T" ? "M" : f.status) as keyof typeof counts;
    if (k in counts) counts[k]++;
  }

  return (
    <aside className="detail">
      <div className="detail-bar small">
        commit:{" "}
        <button className="link mono" title="Copy sha" onClick={() => navigator.clipboard.writeText(detail.sha)}>
          {detail.sha.slice(0, 7)}
        </button>
      </div>
      <div className="detail-head">
        <h2>{detail.subject}</h2>
        {detail.body && <pre className="body">{reflow(detail.body)}</pre>}
        <div className="byline">
          <Avatar name={detail.author} email={detail.email} size={30} />
          <div>
            <div>{detail.author}</div>
            <div className="muted small">authored {formatDate(detail.authorTime)}</div>
          </div>
          <span className="spacer" />
          {detail.parents.length > 0 && (
            <span className="small muted">
              {detail.parents.length > 1 ? "parents" : "parent"}:{" "}
              {detail.parents.map((p) => (
                <button key={p} className="link mono" onClick={() => jumpTo(p)}>
                  {p.slice(0, 7)}{" "}
                </button>
              ))}
            </span>
          )}
        </div>
      </div>
      <div className="files-head small">
        {counts.M > 0 && <span className="s-M">✎ {counts.M} modified</span>}
        {counts.A > 0 && <span className="s-A">+ {counts.A} added</span>}
        {counts.D > 0 && <span className="s-D">− {counts.D} deleted</span>}
        {counts.R > 0 && <span className="s-R">→ {counts.R} renamed</span>}
        {detail.files.length === 0 && <span className="muted">no file changes</span>}
        {detail.parents.length > 1 && <span className="muted">vs first parent</span>}
      </div>
      <FileList detail={detail} />
    </aside>
  );
}

interface Entry {
  path: string;
  change: FileChange | null;
}

interface Dir {
  name: string;
  path: string;
  dirs: Map<string, Dir>;
  files: Entry[];
  /** Changed files anywhere below, by status. */
  changed: Record<string, number>;
}

function buildTree(entries: Entry[]): Dir {
  const root: Dir = { name: "", path: "", dirs: new Map(), files: [], changed: {} };
  for (const e of entries) {
    const parts = e.path.split("/");
    let d = root;
    const bump = (dir: Dir) => {
      if (e.change) dir.changed[e.change.status] = (dir.changed[e.change.status] ?? 0) + 1;
    };
    bump(d);
    for (let i = 0; i < parts.length - 1; i++) {
      let next = d.dirs.get(parts[i]);
      if (!next) {
        next = { name: parts[i], path: parts.slice(0, i + 1).join("/"), dirs: new Map(), files: [], changed: {} };
        d.dirs.set(parts[i], next);
      }
      d = next;
      bump(d);
    }
    d.files.push(e);
  }
  return root;
}

function FileList({ detail }: { detail: CommitDetail }) {
  const prefs = useStore((s) => s.filePrefs);
  const setPrefs = useStore((s) => s.setFilePrefs);
  const openFile = useStore((s) => s.openFile);
  const open = useStore((s) => s.file);
  const [all, setAll] = useState<string[] | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string> | null>(null);

  useEffect(() => {
    setAll(null);
    if (!prefs.viewAllFiles) return;
    let live = true;
    api.treeFiles(detail.sha).then((f) => live && setAll(f));
    return () => {
      live = false;
    };
  }, [prefs.viewAllFiles, detail.sha]);

  const entries: Entry[] = useMemo(() => {
    const byPath = new Map(detail.files.map((f) => [f.path, f]));
    if (prefs.viewAllFiles && all) {
      // Deleted files are not in the commit's tree; keep them listed.
      const paths = new Set([...all, ...detail.files.map((f) => f.path)]);
      return [...paths].sort().map((p) => ({ path: p, change: byPath.get(p) ?? null }));
    }
    return detail.files.map((f) => ({ path: f.path, change: f }));
  }, [detail, all, prefs.viewAllFiles]);

  const tree = useMemo(() => buildTree(entries), [entries]);

  // In "all files", folders without changes start closed; everything else open.
  const isCollapsed = (d: Dir) =>
    collapsed ? collapsed.has(d.path) : prefs.viewAllFiles && Object.keys(d.changed).length === 0;
  const toggle = (d: Dir) => {
    const next = new Set(collapsed ?? allDirs(tree).filter((x) => isCollapsed(x)).map((x) => x.path));
    if (next.has(d.path)) next.delete(d.path);
    else next.add(d.path);
    setCollapsed(next);
  };
  const anyOpen = allDirs(tree).some((d) => !isCollapsed(d));

  const openEntry = (e: Entry) =>
    openFile({
      sha: detail.sha,
      path: e.path,
      oldPath: e.change?.oldPath ?? null,
      status: e.change?.status ?? null,
    });

  return (
    <>
      <div className="files-tools small">
        <div className="segmented" role="group" aria-label="File list layout">
          <button className={prefs.fileList === "path" ? "on" : ""} onClick={() => setPrefs({ fileList: "path" })}>
            ☰ Path
          </button>
          <button className={prefs.fileList === "tree" ? "on" : ""} onClick={() => setPrefs({ fileList: "tree" })}>
            ⊞ Tree
          </button>
        </div>
        {prefs.fileList === "tree" && (
          <button
            className="link"
            onClick={() => setCollapsed(anyOpen ? new Set(allDirs(tree).map((d) => d.path)) : new Set())}
          >
            {anyOpen ? "Collapse all" : "Expand all"}
          </button>
        )}
        <span className="spacer" />
        <label className="check">
          <input
            type="checkbox"
            checked={prefs.viewAllFiles}
            onChange={(e) => {
              setCollapsed(null);
              setPrefs({ viewAllFiles: e.target.checked });
            }}
          />
          View all files
        </label>
      </div>
      <ul className="file-list">
        {prefs.viewAllFiles && !all && <li className="muted small file-loading">Loading files…</li>}
        {prefs.fileList === "path"
          ? entries.map((e) => (
              <li key={e.path}>
                <FileRow entry={e} label={e.path} depth={0} on={open?.path === e.path} onOpen={openEntry} />
              </li>
            ))
          : renderDir(tree, 0, isCollapsed, toggle, open?.path, openEntry)}
      </ul>
    </>
  );
}

function allDirs(d: Dir): Dir[] {
  return [...d.dirs.values()].flatMap((x) => [x, ...allDirs(x)]);
}

function renderDir(
  d: Dir,
  depth: number,
  isCollapsed: (d: Dir) => boolean,
  toggle: (d: Dir) => void,
  openPath: string | undefined,
  onOpen: (e: Entry) => void,
): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const dirs = [...d.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const sub of dirs) {
    const closed = isCollapsed(sub);
    out.push(
      <li key={`d:${sub.path}`}>
        <button className="tree-dir" style={{ paddingLeft: 8 + depth * 14 }} onClick={() => toggle(sub)} aria-expanded={!closed}>
          <span className="caret">{closed ? "▸" : "▾"}</span>
          <span className="ellipsis">{sub.name}</span>
          <ChangeCounts changed={sub.changed} />
        </button>
      </li>,
    );
    if (!closed) out.push(...renderDir(sub, depth + 1, isCollapsed, toggle, openPath, onOpen));
  }
  for (const f of d.files) {
    out.push(
      <li key={`f:${f.path}`}>
        <FileRow entry={f} label={splitPath(f.path)[1]} depth={depth} on={openPath === f.path} onOpen={onOpen} />
      </li>,
    );
  }
  return out;
}

function ChangeCounts({ changed }: { changed: Record<string, number> }) {
  const mod = (changed.M ?? 0) + (changed.T ?? 0) + (changed.R ?? 0);
  const add = (changed.A ?? 0) + (changed.C ?? 0);
  const del = changed.D ?? 0;
  return (
    <span className="dir-counts small">
      {mod > 0 && <span className="s-M">✎ {mod}</span>}
      {add > 0 && <span className="s-A">+ {add}</span>}
      {del > 0 && <span className="s-D">− {del}</span>}
    </span>
  );
}

function FileRow({
  entry,
  label,
  depth,
  on,
  onOpen,
}: {
  entry: Entry;
  label: string;
  depth: number;
  on: boolean;
  onOpen: (e: Entry) => void;
}) {
  const f = entry.change;
  const icon = !f ? "" : f.status === "A" || f.status === "C" ? "+" : f.status === "D" ? "−" : f.status === "R" ? "→" : "✎";
  const [dir, name] = depth === 0 && label.includes("/") ? splitPath(label) : ["", label];
  return (
    <button
      className={`file-item${on ? " on" : ""}${f ? "" : " unchanged"}`}
      style={{ paddingLeft: 8 + depth * 14 + (depth > 0 || label !== entry.path ? 14 : 0) }}
      onClick={() => onOpen(entry)}
      title={f?.oldPath ? `${f.oldPath} → ${entry.path}` : entry.path}
    >
      <span className={`status s-${f?.status ?? "none"}`}>{icon}</span>
      <span className="ellipsis">
        <span className="muted">{dir}</span>
        {name}
      </span>
      <span className="small">
        {f &&
          (f.additions == null ? (
            <span className="muted">bin</span>
          ) : (
            <>
              <span className="add">+{f.additions}</span> <span className="del">−{f.deletions}</span>
            </>
          ))}
      </span>
    </button>
  );
}
