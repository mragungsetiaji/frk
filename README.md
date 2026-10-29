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

## The checked-out branch reads first

Commits in HEAD's history are drawn at full strength: bright messages, solid
thick lines, the HEAD chip lit up. Everything else is dimmed into the
background. The `✓ branch` pill in the top bar jumps to HEAD.

## Right-click

On a commit or a branch label (in the graph or the sidebar): pull
(fast-forward only), push / push and set upstream, set upstream, checkout
(branch, remote branch as a tracking branch, or detached), create branch,
reset the current branch soft / mixed / hard, reword the HEAD commit, revert,
push and open a pull request, rename, delete local or remote, copy branch name,
sha or web links, save a patch, solo / hide, and create plain or annotated tags.

Each is a typed action in `crates/frk-core/src/actions.rs`, never raw git
arguments from the UI; names go through `git check-ref-format` and commits are
resolved to a sha first. Destructive ones ask first, and the integration
branch cannot be deleted from here. Refs an action moves are marked seen, so
your own push does not show up as news. Pull fetches only the one upstream
branch it needs, so it never marks other people's work as seen.

Not there yet: drop commit, move commit, apply patch, compare against the
working tree, and rewording anything older than HEAD (all need a rebase).

## File view

Clicking a file in the commit panel opens it full page over the graph (Esc
closes it and the graph is where you left it):

- **Diff View**, unified or split, with syntax highlighting (Prism, whole file
  highlighted once so multi-line comments and strings colour correctly),
  word-level change marks within edited lines, ↑/↓ between changes, and a ¶
  toggle that hides whitespace-only changes (`git diff -w`).
- **File View**: the whole file at that commit, with this commit's added lines
  marked.
- **Blame** and **History** (follows renames); clicking an entry opens that
  commit's version.

The commit panel lists files as paths or as a collapsible tree, and "View all
files" shows the commit's whole tree. Every long list (diff lines, file, blame)
is virtualized.

## Committing

Uncommitted work shows as a dashed `// WIP` row above HEAD. Selecting it opens
the commit panel: unstaged and staged files (as paths or a tree), Stage /
Unstage per file or all at once, discard per file or everything (with a
confirmation; untracked files are deleted), and the commit form — a summary
with the 72-character count, a description, amend (prefilled with the message
being replaced), and options to skip hooks or add a sign-off. ⌘↩ commits.
Clicking a file opens its working-tree diff in the file view, with a button
to move it across the index. A commit or an amend can be undone from the
toolbar (soft reset to the previous HEAD).

Staging runs straight against git without reloading the graph; only the
commit, which moves HEAD, does. Paths reach git through
`--pathspec-from-file`, never the command line.

## Toolbar

Repository tabs sit in the title bar (macOS overlay title bar; the system title
bar elsewhere). Below them: repository and branch pickers, then Undo / Redo,
Pull (▾ for fetch all), Push, Branch, Stash, Pop and Terminal.

Undo covers what can be reversed locally — checkout, create / rename / delete
branch, reset, tag, stash — and is worked out before the action runs, from the
state it started in. Undoing "create branch" refuses if the branch has gained
commits since. Anything that cannot be undone (push, pull, revert, …) clears
the history rather than leave steps that no longer apply.

The footer shows fetch status; the gear opens settings for the auto-fetch
interval and the terminal application.

## Develop

Requires Node 22 (`.nvmrc`; Vite 8 needs ≥ 20.19) and Rust (pinned in
`rust-toolchain.toml`).

```sh
make install             # frontend dependencies
make dev                 # tauri dev; REPO=~/code/some-repo opens it on launch
make check               # rustfmt, clippy, tests, type check
make dmg                 # release build → target/release/bundle/dmg/frk_<version>_<arch>.dmg
make install-app         # release build copied into /Applications
```

The app is signed ad hoc, which is enough to run a build made on the same
Mac. A .dmg handed to someone else needs a Developer ID signature and
notarization (`APPLE_*` environment variables, see Tauri's docs), or macOS
will refuse to open it.

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
