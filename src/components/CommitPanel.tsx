import { useEffect, useMemo, useState } from "react";
import { api, CommitDetail } from "../api";
import { useStore } from "../store";
import { formatDate, reflow } from "../util";
import { FileTree, TreeEntry } from "./FileTree";
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

function FileList({ detail }: { detail: CommitDetail }) {
  const prefs = useStore((s) => s.filePrefs);
  const setPrefs = useStore((s) => s.setFilePrefs);
  const openFile = useStore((s) => s.openFile);
  const open = useStore((s) => s.file);
  const [all, setAll] = useState<string[] | null>(null);

  useEffect(() => {
    setAll(null);
    if (!prefs.viewAllFiles) return;
    let live = true;
    api.treeFiles(detail.sha).then((f) => live && setAll(f));
    return () => {
      live = false;
    };
  }, [prefs.viewAllFiles, detail.sha]);

  const entries: TreeEntry[] = useMemo(() => {
    const changed = detail.files.map((f) => ({
      path: f.path,
      status: f.status,
      oldPath: f.oldPath,
      additions: f.additions,
      deletions: f.deletions,
    }));
    if (!prefs.viewAllFiles || !all) return changed;
    // Deleted files are not in the commit's tree; keep them listed.
    const byPath = new Map(changed.map((e) => [e.path, e]));
    const paths = new Set([...all, ...byPath.keys()]);
    return [...paths].sort().map((p) => byPath.get(p) ?? { path: p, status: null });
  }, [detail, all, prefs.viewAllFiles]);

  return (
    <>
      <div className="files-tools small">
        <LayoutToggle />
        <span className="spacer" />
        <label className="check">
          <input
            type="checkbox"
            checked={prefs.viewAllFiles}
            onChange={(e) => setPrefs({ viewAllFiles: e.target.checked })}
          />
          View all files
        </label>
      </div>
      {prefs.viewAllFiles && !all && <div className="muted small file-loading">Loading files…</div>}
      <FileTree
        key={`${detail.sha}:${prefs.viewAllFiles}`}
        entries={entries}
        layout={prefs.fileList}
        openPath={open?.sha === detail.sha ? open.path : undefined}
        collapseUnchanged={prefs.viewAllFiles}
        onOpen={(e) =>
          openFile({ sha: detail.sha, path: e.path, oldPath: e.oldPath ?? null, status: e.status })
        }
      />
    </>
  );
}

/** Path / Tree switch, shared by the commit and WIP panels. */
export function LayoutToggle() {
  const layout = useStore((s) => s.filePrefs.fileList);
  const setPrefs = useStore((s) => s.setFilePrefs);
  return (
    <div className="segmented" role="group" aria-label="File list layout">
      <button className={layout === "path" ? "on" : ""} onClick={() => setPrefs({ fileList: "path" })}>
        ☰ Path
      </button>
      <button className={layout === "tree" ? "on" : ""} onClick={() => setPrefs({ fileList: "tree" })}>
        ⊞ Tree
      </button>
    </div>
  );
}
