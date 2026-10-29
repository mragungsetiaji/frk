import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";

/**
 * macOS draws the traffic lights over our content (the window uses an overlay
 * title bar), so the tab strip starts after them. Elsewhere the system title
 * bar stays and the strip starts at the edge.
 */
const IS_MAC = navigator.userAgent.includes("Mac");

const repoName = (root: string) => root.split(/[\\/]/).pop() ?? root;

async function pickRepo() {
  const dir = await open({ directory: true, multiple: false, title: "Open a git repository" });
  if (typeof dir === "string") await useStore.getState().open(dir);
}

export function TopBar() {
  const repo = useStore((s) => s.repo);
  return (
    <header className="topbar-wrap">
      <TabStrip />
      {repo && <Toolbar />}
    </header>
  );
}

function TabStrip() {
  const tabs = useStore((s) => s.tabs);
  const active = useStore((s) => s.repo?.root);
  const openRepo = useStore((s) => s.open);
  const closeTab = useStore((s) => s.closeTab);
  const loading = useStore((s) => s.loading);

  return (
    <div className={`tabstrip${IS_MAC ? " mac" : ""}`} data-tauri-drag-region>
      {tabs.map((root) => (
        <div key={root} className={`repo-tab${root === active ? " on" : ""}`} title={root}>
          <button className="repo-tab-main" onClick={() => root !== active && !loading && openRepo(root)}>
            <BranchGlyph />
            <span className="ellipsis">{repoName(root)}</span>
          </button>
          <button className="repo-tab-close" aria-label={`Close ${repoName(root)}`} onClick={() => closeTab(root)}>
            ✕
          </button>
        </div>
      ))}
      <button className="strip-btn" title="Open another repository in a new tab" aria-label="New tab" onClick={pickRepo}>
        +
      </button>
      <div className="strip-fill" data-tauri-drag-region />
    </div>
  );
}

function Toolbar() {
  const repo = useStore((s) => s.repo)!;
  const refIndex = useStore((s) => s.refIndex);
  const busy = useStore((s) => s.busy);
  const fetching = useStore((s) => s.fetching);
  const undoStack = useStore((s) => s.undoStack);
  const redoStack = useStore((s) => s.redoStack);
  const st = useStore.getState;

  const head = repo.head;
  const headRef = head.branch ? refIndex.get(`refs/heads/${head.branch}`) : undefined;
  const lastUndo = undoStack[undoStack.length - 1];
  const lastRedo = redoStack[redoStack.length - 1];
  const disabled = busy || fetching;

  const createBranch = async () => {
    if (!head.sha) return;
    const v = await st().prompt({
      title: `Create branch at ${head.branch ?? head.sha.slice(0, 7)}`,
      label: "Branch name",
      confirm: "Create branch",
      option: { label: "Check it out", initial: true },
    });
    if (v?.value.trim()) await st().runAction({ kind: "createBranch", name: v.value.trim(), at: head.sha, checkout: v.option });
  };

  const openTerminal = async () => {
    try {
      await api.openTerminal(st().terminalApp || null);
    } catch (e) {
      useStore.setState({ error: String(e) });
    }
  };

  return (
    <div className="toolbar">
      <div className="tb-left">
        <RepoPicker />
        <span className="crumb-sep">›</span>
        <BranchPicker />
      </div>
      <div className="tb-center">
        <div className="tool-group">
          <ToolButton
            iconOnly
            label="Undo"
            title={lastUndo ? `Undo ${lastUndo.label}` : "Nothing to undo"}
            disabled={disabled || !lastUndo}
            onClick={() => st().undo()}
            icon={<UndoIcon />}
          />
          <ToolButton
            iconOnly
            label="Redo"
            title={lastRedo ? `Redo ${lastRedo.label}` : "Nothing to redo"}
            disabled={disabled || !lastRedo}
            onClick={() => st().redo()}
            icon={<UndoIcon redo />}
          />
        </div>
        <div className="tool-group">
          <PullButton disabled={disabled} canPull={!!headRef?.upstream} branch={head.branch} />
          <ToolButton
            label="Push"
            title={
              head.branch
                ? `Push ${head.branch}${headRef?.upstream ? ` to ${headRef.upstream}` : " and set its upstream"}`
                : "HEAD is detached"
            }
            disabled={disabled || !head.branch}
            onClick={() => head.branch && st().runAction({ kind: "push", branch: head.branch })}
            icon={<PushIcon />}
          />
        </div>
        <div className="tool-group">
          <ToolButton
            label="Branch"
            title="Create a branch at HEAD"
            disabled={disabled || !head.sha}
            onClick={createBranch}
            icon={<BranchIcon />}
          />
          <ToolButton
            label="Stash"
            title={
              repo.work.dirty > 0
                ? `Stash ${repo.work.dirty} changed file${repo.work.dirty === 1 ? "" : "s"}`
                : "No local changes"
            }
            disabled={disabled || repo.work.dirty === 0}
            onClick={() => st().runAction({ kind: "stash", message: null })}
            icon={<StashIcon />}
          />
          <ToolButton
            label="Unstash"
            title={
              repo.work.stashes > 0
                ? `Apply and drop the latest of ${repo.work.stashes} stash${repo.work.stashes === 1 ? "" : "es"}`
                : "No stashes"
            }
            disabled={disabled || repo.work.stashes === 0}
            onClick={() => st().runAction({ kind: "stashPop" })}
            icon={<StashIcon pop />}
          />
        </div>
      </div>
      <div className="tb-right">
        <span className="tool-divider" />
        <ToolButton
          label="Terminal"
          title="Open a terminal in this repository"
          onClick={openTerminal}
          icon={<TerminalIcon />}
        />
      </div>
    </div>
  );
}

function ToolButton({
  label,
  title,
  icon,
  onClick,
  disabled,
  iconOnly,
}: {
  label: string;
  title: string;
  icon: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  iconOnly?: boolean;
}) {
  return (
    <button
      className={`tool${iconOnly ? " icon-only" : ""}`}
      title={title}
      aria-label={iconOnly ? label : undefined}
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
      {!iconOnly && <span className="tool-label">{label}</span>}
    </button>
  );
}

function PullButton({ disabled, canPull, branch }: { disabled: boolean; canPull: boolean; branch: string | null }) {
  const [open, setOpen] = useState(false);
  const pull = () => branch && useStore.getState().runAction({ kind: "pull", branch });
  return (
    <div className="tool-split">
      <ToolButton
        label="Pull"
        title={canPull ? `Fast-forward ${branch} to its upstream` : branch ? `${branch} has no upstream` : "HEAD is detached"}
        disabled={disabled || !canPull}
        onClick={pull}
        icon={<PullIcon />}
      />
      <button
        className="tool-caret"
        aria-label="Pull options"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        <Chevron />
      </button>
      {open && (
        <Popover onClose={() => setOpen(false)} align="right">
          <button
            className="ctx-item"
            onClick={() => {
              setOpen(false);
              useStore.getState().fetch();
            }}
          >
            Fetch all
          </button>
          <button
            className="ctx-item"
            disabled={!canPull}
            onClick={() => {
              setOpen(false);
              pull();
            }}
          >
            Pull (fast-forward if possible)
          </button>
        </Popover>
      )}
    </div>
  );
}

function RepoPicker() {
  const repo = useStore((s) => s.repo)!;
  const tabs = useStore((s) => s.tabs);
  const recent = useStore((s) => s.recent);
  const openRepo = useStore((s) => s.open);
  const [open, setOpen] = useState(false);
  const others = [...new Set([...tabs, ...recent])].filter((r) => r !== repo.root);

  return (
    <div className="crumb">
      <span className="crumb-label">repository</span>
      <button className="crumb-btn" onClick={() => setOpen((o) => !o)} aria-expanded={open} title={repo.root}>
        <span className="ellipsis">{repoName(repo.root)}</span>
        <span className="caret-down"><Chevron /></span>
      </button>
      {open && (
        <Popover onClose={() => setOpen(false)}>
          {others.map((r) => (
            <button
              key={r}
              className="ctx-item"
              title={r}
              onClick={() => {
                setOpen(false);
                openRepo(r);
              }}
            >
              <span className="ellipsis">{repoName(r)}</span>
              <span className="ctx-hint">{tabs.includes(r) ? "open" : ""}</span>
            </button>
          ))}
          {others.length > 0 && <div className="ctx-sep" />}
          <button
            className="ctx-item"
            onClick={() => {
              setOpen(false);
              pickRepo();
            }}
          >
            Open repository…
          </button>
        </Popover>
      )}
    </div>
  );
}

function BranchPicker() {
  const repo = useStore((s) => s.repo)!;
  const busy = useStore((s) => s.busy);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const head = repo.head;
  const locals = useMemo(() => {
    const query = q.trim().toLowerCase();
    return repo.refs
      .filter((r) => r.kind === "local" && (!query || r.short.toLowerCase().includes(query)))
      .sort((a, b) => Number(b.short === head.branch) - Number(a.short === head.branch) || b.time - a.time);
  }, [repo, q, head.branch]);

  return (
    <div className="crumb">
      <span className="crumb-label">branch</span>
      <button className="crumb-btn" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="ellipsis">{head.branch ?? (head.sha ? `detached ${head.sha.slice(0, 7)}` : "no commits")}</span>
        <span className="caret-down"><Chevron /></span>
      </button>
      {open && (
        <Popover onClose={() => setOpen(false)} wide>
          <input
            className="search popover-search"
            placeholder="Switch to a local branch"
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          {head.sha && (
            <button
              className="ctx-item"
              onClick={() => {
                setOpen(false);
                useStore.getState().jumpTo(head.sha!);
              }}
            >
              Jump to HEAD in the graph
            </button>
          )}
          <div className="ctx-sep" />
          <div className="popover-list">
            {locals.map((r) => (
              <button
                key={r.name}
                className="ctx-item"
                disabled={busy || r.short === head.branch}
                onClick={() => {
                  setOpen(false);
                  useStore.getState().runAction({ kind: "checkout", branch: r.short });
                }}
              >
                <span className="ellipsis">
                  {r.short === head.branch ? "✓ " : ""}
                  {r.short}
                </span>
                <span className="ctx-hint">{r.upstream ?? ""}</span>
              </button>
            ))}
            {locals.length === 0 && <div className="muted small popover-empty">No matching branch</div>}
          </div>
        </Popover>
      )}
    </div>
  );
}

function Popover({
  children,
  onClose,
  align = "left",
  wide,
}: {
  children: React.ReactNode;
  onClose: () => void;
  align?: "left" | "right";
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const host = ref.current?.parentElement;
      if (host && !host.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  return (
    <div ref={ref} className={`ctx-menu popover ${align}${wide ? " wide" : ""}`} role="menu">
      {children}
    </div>
  );
}

const svg = {
  width: 17,
  height: 17,
  viewBox: "0 0 20 20",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

const UndoIcon = ({ redo }: { redo?: boolean }) => (
  <svg {...svg} style={redo ? { transform: "scaleX(-1)" } : undefined}>
    <path d="M7 4.5 3.5 8 7 11.5" />
    <path d="M3.5 8H12a4.5 4.5 0 0 1 0 9H8" />
  </svg>
);

const PullIcon = () => (
  <svg {...svg}>
    <path d="M10 3v10M6 9.5l4 4 4-4M4 17h12" />
  </svg>
);

const PushIcon = () => (
  <svg {...svg}>
    <path d="M10 14V4M6 7.5l4-4 4 4M4 17h12" />
  </svg>
);

const BranchIcon = () => (
  <svg {...svg}>
    <circle cx="6" cy="4.5" r="1.8" />
    <circle cx="6" cy="15.5" r="1.8" />
    <circle cx="14" cy="6.5" r="1.8" />
    <path d="M6 6.3v7.4M14 8.3c0 3.2-8 2.2-8 5.4" />
  </svg>
);

const StashIcon = ({ pop }: { pop?: boolean }) => (
  <svg {...svg}>
    <path d="M3 11v4.5h14V11M3 11l2-5h10l2 5M3 11h4l1 2h4l1-2h4" />
    <path d={pop ? "M10 9V2.5M7.5 5 10 2.5 12.5 5" : "M10 2.5V9M7.5 6.5 10 9l2.5-2.5"} />
  </svg>
);

const TerminalIcon = () => (
  <svg {...svg}>
    <path d="M3.5 6 8 10l-4.5 4M10 15h6.5" />
  </svg>
);

const BranchGlyph = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
    <circle cx="5" cy="3.5" r="1.4" />
    <circle cx="5" cy="12.5" r="1.4" />
    <circle cx="11" cy="5" r="1.4" />
    <path d="M5 5v6M11 6.4c0 2.6-6 1.8-6 4.4" />
  </svg>
);

const Chevron = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" aria-hidden>
    <path d="M1.5 3.2h7L5 7.2z" />
  </svg>
);
