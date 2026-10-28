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
        return { ...fx.repo, changes };
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
      case "mark_seen":
        changes = a.names ? changes.filter((c) => !a.names.includes(c.name)) : [];
        return changes;
      case "plugin:dialog|open":
        return null;
    }
    return Promise.reject(`devMock: unhandled ${cmd}`);
  });
}
