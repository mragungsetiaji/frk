import { useMemo, useState } from "react";
import { splitPath } from "../util";

export interface TreeEntry {
  path: string;
  /** Change status (A, M, D, R, …), or null for a file that did not change. */
  status: string | null;
  oldPath?: string | null;
  additions?: number | null;
  deletions?: number | null;
}

interface Dir {
  name: string;
  path: string;
  dirs: Map<string, Dir>;
  files: TreeEntry[];
  /** Changed files anywhere below, by status. */
  changed: Record<string, number>;
}

function buildTree(entries: TreeEntry[]): Dir {
  const root: Dir = { name: "", path: "", dirs: new Map(), files: [], changed: {} };
  for (const e of entries) {
    const parts = e.path.split("/");
    let d = root;
    const bump = (dir: Dir) => {
      if (e.status) dir.changed[e.status] = (dir.changed[e.status] ?? 0) + 1;
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

function allDirs(d: Dir): Dir[] {
  return [...d.dirs.values()].flatMap((x) => [x, ...allDirs(x)]);
}

/**
 * Files as a flat list of paths or as a collapsible folder tree with change
 * counts per folder. `actions` renders per-file buttons shown on hover.
 */
export function FileTree({
  entries,
  layout,
  openPath,
  onOpen,
  actions,
  collapseUnchanged,
}: {
  entries: TreeEntry[];
  layout: "path" | "tree";
  openPath: string | undefined;
  onOpen: (e: TreeEntry) => void;
  actions?: (e: TreeEntry) => React.ReactNode;
  /** Start folders without changes closed (for "view all files"). */
  collapseUnchanged?: boolean;
}) {
  const tree = useMemo(() => buildTree(entries), [entries]);
  const [collapsed, setCollapsed] = useState<Set<string> | null>(null);

  const isCollapsed = (d: Dir) =>
    collapsed ? collapsed.has(d.path) : !!collapseUnchanged && Object.keys(d.changed).length === 0;
  const toggle = (d: Dir) => {
    const next = new Set(collapsed ?? allDirs(tree).filter((x) => isCollapsed(x)).map((x) => x.path));
    if (next.has(d.path)) next.delete(d.path);
    else next.add(d.path);
    setCollapsed(next);
  };
  const dirs = allDirs(tree);
  const anyOpen = dirs.some((d) => !isCollapsed(d));

  if (layout === "path") {
    return (
      <ul className="file-list">
        {entries.map((e) => (
          <li key={e.path}>
            <FileRow entry={e} label={e.path} depth={0} on={openPath === e.path} onOpen={onOpen} actions={actions} />
          </li>
        ))}
      </ul>
    );
  }

  const render = (d: Dir, depth: number): React.ReactNode[] => {
    const out: React.ReactNode[] = [];
    for (const sub of [...d.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      const closed = isCollapsed(sub);
      out.push(
        <li key={`d:${sub.path}`}>
          <button
            className="tree-dir"
            style={{ paddingLeft: 8 + depth * 14 }}
            onClick={() => toggle(sub)}
            aria-expanded={!closed}
          >
            <span className="caret">{closed ? "▸" : "▾"}</span>
            <span className="ellipsis">{sub.name}</span>
            <ChangeCounts changed={sub.changed} />
          </button>
        </li>,
      );
      if (!closed) out.push(...render(sub, depth + 1));
    }
    for (const f of d.files) {
      out.push(
        <li key={`f:${f.path}`}>
          <FileRow
            entry={f}
            label={splitPath(f.path)[1]}
            depth={depth}
            on={openPath === f.path}
            onOpen={onOpen}
            actions={actions}
          />
        </li>,
      );
    }
    return out;
  };

  return (
    <ul className="file-list">
      {dirs.length > 0 && (
        <li>
          <button
            className="link small tree-toggle-all"
            onClick={() => setCollapsed(anyOpen ? new Set(dirs.map((d) => d.path)) : new Set())}
          >
            {anyOpen ? "Collapse All" : "Expand All"}
          </button>
        </li>
      )}
      {render(tree, 0)}
    </ul>
  );
}

function ChangeCounts({ changed }: { changed: Record<string, number> }) {
  const mod = (changed.M ?? 0) + (changed.T ?? 0) + (changed.R ?? 0) + (changed.U ?? 0);
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

export function statusIcon(status: string | null): string {
  switch (status) {
    case null:
      return "";
    case "A":
    case "C":
      return "+";
    case "D":
      return "−";
    case "R":
      return "→";
    case "U":
      return "!";
    default:
      return "✎";
  }
}

function FileRow({
  entry,
  label,
  depth,
  on,
  onOpen,
  actions,
}: {
  entry: TreeEntry;
  label: string;
  depth: number;
  on: boolean;
  onOpen: (e: TreeEntry) => void;
  actions?: (e: TreeEntry) => React.ReactNode;
}) {
  const [dir, name] = depth === 0 && label.includes("/") ? splitPath(label) : ["", label];
  const nested = depth > 0 || label !== entry.path;
  return (
    <div className={`file-item${on ? " on" : ""}${entry.status ? "" : " unchanged"}`}>
      <button
        className="file-open"
        style={{ paddingLeft: 8 + depth * 14 + (nested ? 14 : 0) }}
        onClick={() => onOpen(entry)}
        title={entry.oldPath ? `${entry.oldPath} → ${entry.path}` : entry.path}
      >
        <span className={`status s-${entry.status ?? "none"}`}>{statusIcon(entry.status)}</span>
        <span className="ellipsis">
          <span className="muted">{dir}</span>
          {name}
        </span>
        <span className="small">
          {entry.additions === null ? (
            <span className="muted">bin</span>
          ) : entry.additions !== undefined ? (
            <>
              <span className="add">+{entry.additions}</span> <span className="del">−{entry.deletions}</span>
            </>
          ) : null}
        </span>
      </button>
      {actions && <span className="file-actions">{actions(entry)}</span>}
    </div>
  );
}
