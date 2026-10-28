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

  mockIPC((cmd, args) => {
    const a = (args ?? {}) as Record<string, any>;
    switch (cmd) {
      case "launch_path":
        return fx.repo.root;
      case "open_repo":
      case "refresh":
        return { work: { dirty: 2, stashes: 1 }, ...fx.repo, changes };
      case "open_terminal":
        return null;
      case "fetch_all":
        return new Promise((r) => setTimeout(r, 600));
      case "build_graph":
        return fx.meta;
      case "graph_rows":
        return fx.rows.slice(a.start, a.end);
      case "find_row": {
        const i = fx.rows.findIndex((r: { sha: string }) => r.sha === a.sha);
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
          setTimeout(() => r({ message: `devMock: ${a.action.kind} (nothing ran)`, repo: { work: { dirty: 2, stashes: 1 }, ...fx.repo, changes } }), 300),
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
