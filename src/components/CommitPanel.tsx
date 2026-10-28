import { useEffect, useState } from "react";
import { api, CommitDetail, FileChange } from "../api";
import { useStore } from "../store";
import { formatDate, splitPath } from "../util";
import { DiffView } from "./DiffView";
import { Avatar } from "./Icons";

export function CommitPanel() {
  const selected = useStore((s) => s.selected);
  const jumpTo = useStore((s) => s.jumpTo);
  const [detail, setDetail] = useState<CommitDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<FileChange | null>(null);

  useEffect(() => {
    setFile(null);
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
  if (error) return <aside className="detail"><p className="error-text">{error}</p></aside>;
  if (!detail || detail.sha !== selected) return <aside className="detail" />;

  const adds = detail.files.reduce((n, f) => n + (f.additions ?? 0), 0);
  const dels = detail.files.reduce((n, f) => n + (f.deletions ?? 0), 0);

  return (
    <aside className="detail">
      <div className="detail-head">
        <h2>{detail.subject}</h2>
        {detail.body && <pre className="body">{detail.body}</pre>}
        <div className="byline">
          <Avatar name={detail.author} email={detail.email} size={28} />
          <div>
            <div>{detail.author}</div>
            <div className="muted small">authored {formatDate(detail.authorTime)}</div>
          </div>
        </div>
        <div className="shas small">
          <span>
            commit{" "}
            <button className="link mono" title="Copy" onClick={() => navigator.clipboard.writeText(detail.sha)}>
              {detail.sha.slice(0, 7)}
            </button>
          </span>
          {detail.parents.length > 0 && (
            <span>
              {detail.parents.length > 1 ? "parents" : "parent"}{" "}
              {detail.parents.map((p) => (
                <button key={p} className="link mono" onClick={() => jumpTo(p)}>
                  {p.slice(0, 7)}
                </button>
              ))}
            </span>
          )}
        </div>
      </div>
      <div className="files-head small">
        <span>
          {detail.files.length} file{detail.files.length === 1 ? "" : "s"}
        </span>
        <span className="add">+{adds}</span>
        <span className="del">−{dels}</span>
        {detail.parents.length > 1 && <span className="muted">vs first parent</span>}
      </div>
      <ul className={`file-list${file ? " compact" : ""}`}>
        {detail.files.map((f) => {
          const [dir, name] = splitPath(f.path);
          return (
            <li key={f.path}>
              <button className={`file-item${file?.path === f.path ? " on" : ""}`} onClick={() => setFile(f)}>
                <span className={`status s-${f.status}`}>{f.status}</span>
                <span className="ellipsis" title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}>
                  <span className="muted">{dir}</span>
                  {name}
                </span>
                <span className="small">
                  {f.additions == null ? (
                    <span className="muted">bin</span>
                  ) : (
                    <>
                      <span className="add">+{f.additions}</span> <span className="del">−{f.deletions}</span>
                    </>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {file && <DiffView sha={detail.sha} file={file} />}
    </aside>
  );
}
