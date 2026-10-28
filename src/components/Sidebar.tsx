import { useMemo, useState } from "react";
import { RefChange, RefInfo } from "../api";
import { useStore } from "../store";
import { timeAgo } from "../util";
import { ChangeDot } from "./GraphView";
import { CheckIcon, EyeIcon } from "./Icons";

const DAY_OPTIONS = [
  { label: "7d", value: 7 },
  { label: "30d", value: 30 },
  { label: "90d", value: 90 },
  { label: "All", value: 0 },
];

export function Sidebar() {
  return (
    <aside className="sidebar">
      <Changes />
      <Filters />
      <Branches />
    </aside>
  );
}

function shortName(refIndex: Map<string, RefInfo>, name: string) {
  return refIndex.get(name)?.short ?? name.replace(/^refs\/(heads|remotes|tags)\//, "");
}

function Changes() {
  const repo = useStore((s) => s.repo);
  const refIndex = useStore((s) => s.refIndex);
  const markSeen = useStore((s) => s.markSeen);
  const jumpTo = useStore((s) => s.jumpTo);
  if (!repo) return null;
  const changes = repo.changes;

  return (
    <div className="panel changes">
      <div className="panel-title">
        <span>
          Since last seen <span className="count">{changes.length}</span>
        </span>
        {changes.length > 0 && (
          <button className="link" onClick={() => markSeen()}>
            Mark all seen
          </button>
        )}
      </div>
      {changes.length === 0 && (
        <p className="muted small">
          {repo.baseline
            ? "First open: every branch is recorded as seen. New and moved branches show up here after the next fetch."
            : "Nothing new since you last looked."}
        </p>
      )}
      <ul className="change-list">
        {changes.map((c) => (
          <li key={c.name} className="change-item">
            <button
              className="change-main"
              disabled={c.kind === "removed"}
              onClick={() => jumpTo(c.kind === "updated" ? c.to : c.sha, c.name)}
            >
              <span className="change-name">
                <ChangeDot change={c} />
                <span className="ellipsis">{shortName(refIndex, c.name)}</span>
              </span>
              <span className="muted small">{describe(c, refIndex)}</span>
            </button>
            <button className="icon-btn" title="Mark seen" onClick={() => markSeen([c.name])}>
              <CheckIcon />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function describe(c: RefChange, refIndex: Map<string, RefInfo>): string {
  const ref = refIndex.get(c.name);
  const when = ref ? ` · ${timeAgo(ref.time)}` : "";
  const who = (authors: string[]) =>
    authors.length === 0 ? "" : ` by ${authors.slice(0, 2).join(", ")}${authors.length > 2 ? ` +${authors.length - 2}` : ""}`;
  const n = (k: number) => `${k} commit${k === 1 ? "" : "s"}`;
  switch (c.kind) {
    case "added":
      return `new branch · ${n(c.commits)} ahead${who(c.authors)}${when}`;
    case "updated":
      return c.forced ? `force-pushed${ref ? ` by ${ref.author}` : ""}${when}` : `+${n(c.commits)}${who(c.authors)}${when}`;
    case "removed":
      return "deleted";
  }
}

function Filters() {
  const filter = useStore((s) => s.filter);
  const setFilter = useStore((s) => s.setFilter);
  return (
    <div className="panel filters">
      <div className="segmented" role="group" aria-label="Active within">
        {DAY_OPTIONS.map((o) => (
          <button
            key={o.value}
            className={filter.days === o.value ? "on" : ""}
            onClick={() => setFilter({ days: o.value })}
          >
            {o.label}
          </button>
        ))}
      </div>
      <label className="check">
        <input type="checkbox" checked={filter.hideMerged} onChange={(e) => setFilter({ hideMerged: e.target.checked })} />
        Hide merged
      </label>
      <label className="check">
        <input type="checkbox" checked={filter.tags} onChange={(e) => setFilter({ tags: e.target.checked })} />
        Tags
      </label>
    </div>
  );
}

function Branches() {
  const repo = useStore((s) => s.repo);
  const meta = useStore((s) => s.meta);
  const filter = useStore((s) => s.filter);
  const changeIndex = useStore((s) => s.changeIndex);
  const setFilter = useStore((s) => s.setFilter);
  const jumpTo = useStore((s) => s.jumpTo);
  const openMenu = useStore((s) => s.openMenu);
  const [tab, setTab] = useState<"local" | "remote">("remote");
  const [query, setQuery] = useState("");

  const visible = useMemo(() => new Set(meta?.visible ?? []), [meta]);
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (repo?.refs ?? []).filter(
      (r) => r.kind === tab && (!q || r.short.toLowerCase().includes(q) || r.author.toLowerCase().includes(q)),
    );
  }, [repo, tab, query]);
  const counts = useMemo(() => {
    const refs = repo?.refs ?? [];
    return {
      local: refs.filter((r) => r.kind === "local").length,
      remote: refs.filter((r) => r.kind === "remote").length,
    };
  }, [repo]);

  if (!repo) return null;

  const toggleHidden = (name: string) => {
    const hidden = filter.hidden.includes(name)
      ? filter.hidden.filter((n) => n !== name)
      : [...filter.hidden, name];
    setFilter({ hidden, include: filter.include.filter((n) => n !== name) });
  };

  return (
    <div className="panel branches">
      <div className="segmented" role="tablist">
        <button className={tab === "remote" ? "on" : ""} onClick={() => setTab("remote")}>
          Remote <span className="count">{counts.remote}</span>
        </button>
        <button className={tab === "local" ? "on" : ""} onClick={() => setTab("local")}>
          Local <span className="count">{counts.local}</span>
        </button>
      </div>
      <input
        className="search"
        placeholder="Filter by branch or author"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <ul className="branch-list">
        {list.map((r) => {
          const shown = visible.has(r.name);
          const hidden = filter.hidden.includes(r.name);
          const change = changeIndex.get(r.name);
          const isHead = r.kind === "local" && r.short === repo.head.branch;
          return (
            <li
              key={r.name}
              className={`branch-item${shown ? "" : " dim"}${isHead ? " head" : ""}`}
              onContextMenu={(e) => {
                e.preventDefault();
                openMenu({ x: e.clientX, y: e.clientY, sha: r.sha, refs: [r.name] });
              }}
            >
              <button className="icon-btn" title={hidden ? "Show in graph" : "Hide from graph"} onClick={() => toggleHidden(r.name)}>
                <EyeIcon off={hidden} />
              </button>
              <button className="branch-main" onClick={() => jumpTo(r.sha, r.name)} title={r.subject}>
                <span className="branch-name">
                  {isHead && <span className="head-check">✓</span>}
                  <span className="ellipsis">{r.short}</span>
                  {change && <ChangeDot change={change} />}
                  {r.merged && <span className="tag-merged">merged</span>}
                </span>
                <span className="muted small ellipsis">
                  {timeAgo(r.time)} · {r.author}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
