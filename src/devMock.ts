import { mockIPC } from "@tauri-apps/api/mocks";

/**
 * Browser-only preview: answers the app's commands from a fixture dumped from a
 * real repository, so the UI can be worked on with `pnpm dev` in any browser.
 * Only loaded in development when there is no Tauri runtime (see main.tsx).
 *
 *   cargo run -p frk-core --example fixture -- <repo> public/dev-fixture.json
 */
export async function installDevMock() {
  const res = await fetch("/dev-fixture.json");
  if (!res.ok) {
    console.warn("frk: no public/dev-fixture.json; see src/devMock.ts");
    return;
  }
  const fx = await res.json();
  let changes = fx.repo.changes as { name: string }[];

  // A dirty working tree, so the WIP row and commit panel have something in
  // them. Paths come from the fixture's first commit so diffs can be shown.
  type F = { path: string; oldPath: null; status: string; untracked: boolean };
  const firstFiles: string[] = Object.keys(fx.diffs).map((k: string) => k.slice(k.indexOf(":") + 1));
  const wip: { branch: string; unstaged: F[]; staged: F[]; conflicted: string[] } = {
    branch: fx.repo.head.branch,
    unstaged: [
      ...firstFiles.slice(0, 2).map((path) => ({ path, oldPath: null, status: "M", untracked: false })),
      { path: "notes/scratch.md", oldPath: null, status: "A", untracked: true },
    ],
    staged: [],
    conflicted: [],
  };
  const wipView = () => JSON.parse(JSON.stringify(wip));
  const move = (from: F[], to: F[], paths: string[] | null) => {
    const picked = from.filter((f) => !paths || paths.includes(f.path));
    for (const f of picked) {
      from.splice(from.indexOf(f), 1);
      if (!to.some((t) => t.path === f.path)) to.push(f);
    }
  };
  const anyByPath = (table: Record<string, unknown> | undefined, path: string) =>
    table && Object.entries(table).find(([k]) => k.endsWith(`:${path}`))?.[1];

  // Put a WIP row above HEAD, carrying its lane down to HEAD's row.
  const rows = [...fx.rows];
  const headIndex = rows.findIndex((r: { sha: string }) => r.sha === fx.repo.head.sha);
  if (headIndex >= 0) {
    const h = rows[headIndex];
    const edge = { from: h.lane, to: h.lane, color: h.color, head: true };
    for (let i = 0; i < headIndex; i++) {
      rows[i] = { ...rows[i], top: [...rows[i].top, edge], bottom: [...rows[i].bottom, edge] };
    }
    rows[headIndex] = { ...h, top: [...h.top, edge] };
    rows.unshift({
      sha: "WORKING",
      parents: [h.sha],
      author: "",
      email: "",
      time: Math.floor(Date.now() / 1000),
      subject: "// WIP",
      lane: h.lane,
      color: h.color,
      onHead: true,
      top: [],
      bottom: [edge],
      refs: [],
    });
  }
  const meta = { ...fx.meta, rows: rows.length };

  mockIPC((cmd, args) => {
    const a = (args ?? {}) as Record<string, any>;
    switch (cmd) {
      case "launch_path":
        return fx.repo.root;
      case "open_repo":
      case "refresh":
        return { ...fx.repo, work: { dirty: 3, stashes: 1 }, changes };
      case "open_terminal":
        return null;
      case "wip_status":
        return wipView();
      case "wip_stage":
        move(wip.unstaged, wip.staged, a.paths);
        return wipView();
      case "wip_unstage":
        move(wip.staged, wip.unstaged, a.paths);
        return wipView();
      case "wip_discard":
        return wipView();
      case "wip_file_diff":
        return (
          anyByPath(fx.diffs, a.file.path) ??
          "diff --git a/notes/scratch.md b/notes/scratch.md\n@@ -0,0 +1,2 @@\n+# Scratch\n+Uncommitted notes.\n"
        );
      case "wip_file_versions":
        return anyByPath(fx.versions, a.file.path) ?? { old: null, new: "# Scratch\nUncommitted notes.\n", binary: false, tooLarge: false };
      case "fetch_all":
        return new Promise((r) => setTimeout(r, 600));
      case "build_graph":
        return meta;
      case "graph_rows":
        return rows.slice(a.start, a.end);
      case "find_row": {
        const i = rows.findIndex((r: { sha: string }) => r.sha === a.sha);
        return i < 0 ? null : i;
      }
      case "commit_detail":
        return fx.details[a.sha] ?? Promise.reject("not in the fixture (only the first 40 commits are)");
      case "file_diff":
        return fx.diffs[`${a.sha}:${a.path}`] ?? "";
      case "file_versions":
        return fx.versions?.[`${a.sha}:${a.path}`] ?? Promise.reject("not in the fixture");
      case "blame":
        return fx.blames?.[`${a.sha}:${a.path}`] ?? Promise.reject("not in the fixture");
      case "file_history":
        return fx.histories?.[`${a.sha}:${a.path}`] ?? [];
      case "tree_files":
        return fx.trees?.[a.sha] ?? Promise.reject("not in the fixture (first 5 commits only)");
      case "mark_seen":
        changes = a.names ? changes.filter((c) => !a.names.includes(c.name)) : [];
        return changes;
      case "run_action":
        return new Promise((r) =>
          setTimeout(() => r({ message: `devMock: ${a.action.kind} (nothing ran)`, repo: { ...fx.repo, work: { dirty: 3, stashes: 1 }, changes } }), 300),
        );
      case "plugin:opener|open_url":
        window.open(a.url, "_blank", "noopener");
        return null;
      case "plugin:dialog|open":
      case "plugin:dialog|save":
        return null;
    }
    return Promise.reject(`devMock: unhandled ${cmd}`);
  });
}
