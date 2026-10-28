import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { useStore } from "../store";
import { FolderIcon, RefreshIcon } from "./Icons";

const AUTO_FETCH = [0, 2, 5, 15];

export function TopBar() {
  const repo = useStore((s) => s.repo);
  const meta = useStore((s) => s.meta);
  const recent = useStore((s) => s.recent);
  const fetching = useStore((s) => s.fetching);
  const lastFetch = useStore((s) => s.lastFetch);
  const autoFetchMin = useStore((s) => s.autoFetchMin);
  const openRepo = useStore((s) => s.open);
  const fetch = useStore((s) => s.fetch);
  const setAutoFetch = useStore((s) => s.setAutoFetch);
  const [, tick] = useState(0);

  // Keep "fetched 2m ago" honest without re-rendering anything else.
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const pick = async () => {
    const dir = await open({ directory: true, multiple: false, title: "Open a git repository" });
    if (typeof dir === "string") await openRepo(dir);
  };

  const name = repo?.root.split(/[\\/]/).pop();
  const head = repo?.head.branch ?? (repo?.head.sha ? `detached ${repo.head.sha.slice(0, 7)}` : null);

  return (
    <header className="topbar">
      <div className="repo-picker">
        <button className="btn" onClick={pick} title={repo?.root}>
          <FolderIcon /> {name ?? "Open repository"}
        </button>
        {recent.length > 1 && (
          <select
            className="btn"
            value=""
            onChange={(e) => e.target.value && openRepo(e.target.value)}
            aria-label="Recent repositories"
          >
            <option value="">Recent…</option>
            {recent
              .filter((r) => r !== repo?.root)
              .map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
          </select>
        )}
      </div>
      {repo && (
        <>
          {head && (
            <span className="pill" title="HEAD">
              ✓ {head}
            </span>
          )}
          {repo.target && (
            <span className="pill muted" title="Integration target, used to decide what counts as merged">
              target {repo.target.replace(/^refs\/(remotes|heads)\//, "")}
            </span>
          )}
          {meta && (
            <span className="muted small">
              {meta.visible.length} of {repo.refs.length} refs · {meta.rows.toLocaleString()} commits · {meta.maxLanes} lanes
            </span>
          )}
          <span className="spacer" />
          <span className="muted small">{lastFetch ? `fetched ${ago(lastFetch)}` : "not fetched yet"}</span>
          <select
            className="btn"
            value={autoFetchMin}
            onChange={(e) => setAutoFetch(Number(e.target.value))}
            aria-label="Auto fetch interval"
          >
            {AUTO_FETCH.map((m) => (
              <option key={m} value={m}>
                {m === 0 ? "Auto fetch off" : `Auto fetch ${m}m`}
              </option>
            ))}
          </select>
          <button className="btn primary" onClick={fetch} disabled={fetching}>
            <RefreshIcon spinning={fetching} /> {fetching ? "Fetching" : "Fetch"}
          </button>
        </>
      )}
    </header>
  );
}

function ago(ms: number) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  return `${Math.floor(s / 60)}m ago`;
}
