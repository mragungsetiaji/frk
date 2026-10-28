# frk

A desktop git graph that shows every branch at once, and what changed since you
last looked. Built for staying aware of the work other people push: new
branches, branches that moved, and force-pushes show up in a "since last seen"
panel until you acknowledge them.

Tauri v2 (system webview, no bundled Chromium) + React, with the git read model
in a separate Rust crate.

```
crates/frk-core   refs, commit walk + lane layout, snapshot diff, commit detail
src-tauri         Tauri commands over frk-core; per-repo session state
src               React UI: graph (canvas + virtual list), sidebar, commit panel
```

## How it stays light

- Lane layout runs once per filter change, in Rust. The UI asks for rows by
  index range and only the rows on screen exist in the DOM.
- The graph column is one `<canvas>` the size of the viewport, repainted on
  scroll from the visible rows only; React never re-renders on scroll.
- Merged and inactive branches are filtered out of the walk by default
  (active within 30 days, hide merged), so a repository with hundreds of refs
  draws a dozen lanes rather than hundreds.
- All git access goes through the git CLI, so your config, credential helpers,
  SSH agent and `commit-graph` file apply as they do in a terminal.

On `cekat-data-platform` (432 refs, 1.4k commits): ref listing ~110 ms, commit
walk ~50–100 ms, lane layout < 1 ms; the app's core process sits around 60 MB.

## "Since last seen"

On first open, every branch is recorded as seen (`<app data>/snapshots/`).
After that, any branch that is new, moved, force-pushed or deleted is listed
with its commit count and authors, and stays listed until you mark it seen. A
fetch alone never clears it. Changed branches are always drawn in the graph,
even when old or merged.

## Develop

Requires Node 22 (`.nvmrc`; Vite 8 needs ≥ 20.19) and Rust (pinned in
`rust-toolchain.toml`).

```sh
pnpm install
pnpm app                 # tauri dev
pnpm app -- -- ~/code/some-repo   # open a repository on launch
cargo test -p frk-core
```

### Faster Rust rebuilds with blaze

[blaze](https://github.com/indexable-inc/blaze) rebuilds after an edit in
milliseconds instead of seconds. It is a dev-loop tool only; release builds and
CI stay on cargo.

```sh
curl -fsSL https://ix.dev/blaze | sh    # macOS Apple silicon / Linux
pnpm app:blaze                          # tauri dev --runner blaze
```

Things to know: blaze builds with its own pinned nightly regardless of
`rust-toolchain.toml`, its daemon holds a few GB of memory, and on Windows it
needs a manual install and `BLAZE_SANDBOX=off` for proc macros. Keep
`cargo check` / `cargo test` as the final word.

### UI in a plain browser

`pnpm dev` without Tauri answers every command from a fixture dumped from a
real repository (`src/devMock.ts`), which is handy for UI work:

```sh
pnpm fixture ../some-repo public/dev-fixture.json
pnpm dev                 # open http://localhost:1420
```

`public/dev-fixture.json` holds real commit messages and author emails; it is
git-ignored and should stay that way.
