import { useEffect, useMemo, useState } from "react";
import { api, WIP, WipFile } from "../api";
import { useStore } from "../store";
import { LayoutToggle } from "./CommitPanel";
import { FileTree, TreeEntry } from "./FileTree";

/** Summary length GitHub and most tools show without truncating. */
const SUMMARY_LIMIT = 72;

/**
 * The working tree, selected through the WIP row: unstaged and staged files,
 * and the commit form.
 */
export function WipPanel() {
  const wip = useStore((s) => s.wip);
  const repo = useStore((s) => s.repo);
  const loadWip = useStore((s) => s.loadWip);

  useEffect(() => {
    loadWip();
  }, [loadWip]);

  if (!wip || !repo) return <aside className="detail" />;
  const total = new Set([...wip.unstaged, ...wip.staged].map((f) => f.path)).size + wip.conflicted.length;
  const branch = wip.branch ?? repo.head.branch;

  const discardAll = async () => {
    const ok = await useStore.getState().confirm({
      title: "Discard all changes?",
      body: "Every uncommitted change, staged or not, is thrown away and untracked files are deleted. Ignored files are left alone. This cannot be undone.",
      confirm: "Discard all",
      danger: true,
    });
    if (ok) await useStore.getState().discard(null);
  };

  return (
    <aside className="detail wip-panel">
      <div className="wip-head">
        {branch ? <span className="branch-chip">{branch}</span> : <span className="muted">detached HEAD</span>}
        <span className="wip-title">
          {total} changed file{total === 1 ? "" : "s"}
        </span>
      </div>
      <div className="files-tools small">
        <span className="spacer" />
        <LayoutToggle />
        <span className="spacer" />
      </div>
      <div className="wip-lists">
        {wip.conflicted.length > 0 && (
          <div className="wip-conflicts small">
            {wip.conflicted.length} conflicted file{wip.conflicted.length === 1 ? "" : "s"}: resolve them in your editor, then
            stage them here.
            <ul>
              {wip.conflicted.map((p) => (
                <li key={p} className="mono">
                  {p}
                </li>
              ))}
            </ul>
          </div>
        )}
        <Section title="Changes" files={wip.unstaged} staged={false} onDiscardAll={discardAll} />
        <Section title="Staged" files={wip.staged} staged />
      </div>
      <CommitForm stagedCount={wip.staged.length} unstagedCount={wip.unstaged.length} />
    </aside>
  );
}

function Section({
  title,
  files,
  staged,
  onDiscardAll,
}: {
  title: string;
  files: WipFile[];
  staged: boolean;
  onDiscardAll?: () => void;
}) {
  const [open, setOpen] = useState(true);
  const layout = useStore((s) => s.filePrefs.fileList);
  const openFile = useStore((s) => s.openFile);
  const current = useStore((s) => s.file);
  const busy = useStore((s) => s.busy);
  const { stage, unstage, discard, confirm } = useStore.getState();
  const byPath = useMemo(() => new Map(files.map((f) => [f.path, f])), [files]);
  const entries: TreeEntry[] = useMemo(
    () => files.map((f) => ({ path: f.path, status: f.status, oldPath: f.oldPath })),
    [files],
  );

  const discardOne = async (f: WipFile) => {
    const ok = await confirm({
      title: `Discard changes to ${f.path}?`,
      body: f.untracked
        ? "The file is untracked, so it is deleted. This cannot be undone."
        : "Unstaged changes to this file are thrown away; anything staged stays. This cannot be undone.",
      confirm: "Discard",
      danger: true,
    });
    if (ok) await discard([f]);
  };

  return (
    <section className={`wip-section${open ? "" : " closed"}`}>
      <div className="wip-section-head">
        <button className="wip-section-title" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <span className="caret">{open ? "▾" : "▸"}</span>
          {title} <span className="count">{files.length}</span>
        </button>
        {files.length > 0 && (
          <span className="wip-section-actions">
            {onDiscardAll && (
              <button className="link danger-link small" disabled={busy} onClick={onDiscardAll}>
                Discard all
              </button>
            )}
            <button
              className={`btn small ${staged ? "" : "stage-all"}`}
              disabled={busy}
              onClick={() => (staged ? unstage(null) : stage(null))}
            >
              {staged ? "Unstage all" : "Stage all"}
            </button>
          </span>
        )}
      </div>
      {open && (
        <div className="wip-section-body">
          {files.length === 0 ? (
            <p className="muted small wip-empty">
              {staged ? "Stage files to include them in the next commit." : "Everything is staged."}
            </p>
          ) : (
            <FileTree
              entries={entries}
              layout={layout}
              openPath={current?.wip?.staged === staged ? current.path : undefined}
              onOpen={(e) => {
                const f = byPath.get(e.path)!;
                openFile({ sha: WIP, path: f.path, oldPath: f.oldPath, status: f.status, wip: { file: f, staged } }, "diff");
              }}
              actions={(e) => {
                const f = byPath.get(e.path)!;
                return (
                  <>
                    {!staged && (
                      <button className="row-action" title="Discard changes" disabled={busy} onClick={() => discardOne(f)}>
                        <TrashIcon small />
                      </button>
                    )}
                    <button
                      className={`row-action ${staged ? "unstage" : "stage"}`}
                      disabled={busy}
                      onClick={() => (staged ? unstage([f.path]) : stage([f.path]))}
                    >
                      {staged ? "Unstage" : "Stage"}
                    </button>
                  </>
                );
              }}
            />
          )}
        </div>
      )}
    </section>
  );
}

function CommitForm({ stagedCount, unstagedCount }: { stagedCount: number; unstagedCount: number }) {
  const draft = useStore((s) => s.draft);
  const setDraft = useStore((s) => s.setDraft);
  const busy = useStore((s) => s.busy);
  const headSha = useStore((s) => s.repo?.head.sha);
  const [tab, setTab] = useState<"commit" | "stash">("commit");
  const [options, setOptions] = useState(false);
  const [stashMessage, setStashMessage] = useState("");
  const { commit, runAction } = useStore.getState();

  // Amending starts from the message being replaced.
  const toggleAmend = async (amend: boolean) => {
    if (amend && headSha && !draft.summary.trim() && !draft.description.trim()) {
      const d = await api.commitDetail(headSha);
      setDraft({ amend, summary: d.subject, description: d.body });
    } else {
      setDraft({ amend });
    }
  };

  const remaining = SUMMARY_LIMIT - draft.summary.length;
  const canCommit = !busy && draft.summary.trim().length > 0 && (stagedCount > 0 || draft.amend);

  const branch = useStore((s) => s.repo?.head.branch);
  let label: string;
  if (draft.amend) label = "Amend last commit";
  else if (stagedCount > 0)
    label = `Commit ${stagedCount} file${stagedCount === 1 ? "" : "s"}${branch ? ` to ${branch}` : ""}`;
  else label = "Nothing staged";

  const submit = () => {
    if (canCommit) commit();
  };

  return (
    <div className="commit-form">
      <div className="commit-tabs" role="tablist">
        <button role="tab" aria-selected={tab === "commit"} className={tab === "commit" ? "on" : ""} onClick={() => setTab("commit")}>
          Commit
        </button>
        <button role="tab" aria-selected={tab === "stash"} className={tab === "stash" ? "on" : ""} onClick={() => setTab("stash")}>
          Stash
        </button>
      </div>
      {tab === "commit" ? (
        <>
          <label className="check amend">
            <input type="checkbox" checked={draft.amend} disabled={!headSha} onChange={(e) => toggleAmend(e.target.checked)} />
            Amend last commit
          </label>
          <div className="message-box">
            <div className="summary-row">
              <input
                className="summary"
                placeholder="Summary"
                value={draft.summary}
                onChange={(e) => setDraft({ summary: e.target.value })}
                onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === "Enter" && submit()}
                aria-label="Commit summary"
              />
              <span className={`remaining${remaining < 0 ? " over" : ""}`} title="Characters left before the summary is truncated">
                {remaining}
              </span>
            </div>
            <textarea
              className="description"
              placeholder="Details (optional)"
              value={draft.description}
              onChange={(e) => setDraft({ description: e.target.value })}
              onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === "Enter" && submit()}
              aria-label="Commit description"
            />
          </div>
          <button className="options-toggle" aria-expanded={options} onClick={() => setOptions((o) => !o)}>
            <span className="caret">{options ? "▾" : "›"}</span> More options
          </button>
          {options && (
            <div className="commit-options">
              <label className="check">
                <input type="checkbox" checked={draft.noVerify} onChange={(e) => setDraft({ noVerify: e.target.checked })} />
                Skip commit hooks <span className="muted">(--no-verify)</span>
              </label>
              <label className="check">
                <input type="checkbox" checked={draft.signOff} onChange={(e) => setDraft({ signOff: e.target.checked })} />
                Add Signed-off-by <span className="muted">(--signoff)</span>
              </label>
            </div>
          )}
          <button
            className={`commit-btn${canCommit ? " ready" : ""}`}
            disabled={!canCommit}
            onClick={submit}
            title={
              stagedCount === 0 && !draft.amend
                ? "Stage the changes to commit first"
                : draft.summary.trim()
                  ? "Commit (⌘↩)"
                  : "Write a summary first"
            }
          >
            <CommitGlyph /> {label}
          </button>
        </>
      ) : (
        <>
          <div className="message-box">
            <input
              className="summary"
              placeholder="Stash message (optional)"
              value={stashMessage}
              onChange={(e) => setStashMessage(e.target.value)}
              aria-label="Stash message"
            />
          </div>
          <button
            className="commit-btn ready"
            disabled={busy || stagedCount + unstagedCount === 0}
            onClick={async () => {
              if (await runAction({ kind: "stash", message: stashMessage.trim() || null })) setStashMessage("");
            }}
          >
            Stash all changes
          </button>
        </>
      )}
    </div>
  );
}

const TrashIcon = ({ small }: { small?: boolean }) => (
  <svg width={small ? 13 : 16} height={small ? 13 : 16} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
    <path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4M6.8 6.5v5M9.2 6.5v5" />
  </svg>
);

const CommitGlyph = () => (
  <svg width="16" height="12" viewBox="0 0 20 12" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
    <circle cx="10" cy="6" r="3.2" />
    <path d="M1 6h5.8M13.2 6H19" />
  </svg>
);
