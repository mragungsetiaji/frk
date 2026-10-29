# Contributing to frk

Thanks for helping. This covers setting up, the day-to-day loop, and what a
change should look like. How the app is put together is in
[docs/design.md](docs/design.md).

## Setup

- **Rust**, pinned in `rust-toolchain.toml`; rustup installs it on first build.
- **Node 22** (`.nvmrc`). Vite 8 needs at least 20.19. The Makefile picks up
  an nvm-installed Node 22 automatically.
- **pnpm**.
- **git** on `PATH`; frk drives the git CLI.

```sh
make install
make dev                          # tauri dev
make dev REPO=~/code/some-repo    # …opening a repository on launch
```

## The loop

```sh
make check      # rustfmt, clippy -D warnings, frk-core tests, TypeScript check
make dmg        # release .dmg in target/release/bundle/dmg/
make help       # everything else
```

### UI work in a plain browser

`pnpm dev` without Tauri answers every command from a fixture dumped from a real
repository (`src/devMock.ts`), so the UI can be worked on in any browser:

```sh
pnpm fixture ../some-repo public/dev-fixture.json
make browser    # http://localhost:1420
```

`public/dev-fixture.json` holds real commit messages and author emails. It is
git-ignored; keep it that way.

### Faster Rust rebuilds with blaze

[blaze](https://github.com/indexable-inc/blaze) rebuilds after an edit in
milliseconds instead of seconds. It is for the dev loop only; release builds
and CI stay on cargo.

```sh
curl -fsSL https://ix.dev/blaze | sh    # macOS (Apple silicon) / Linux
pnpm app:blaze                          # tauri dev --runner blaze
```

blaze builds with its own pinned nightly whatever `rust-toolchain.toml` says,
its daemon holds a few GB of memory, and on Windows it needs a manual install
and `BLAZE_SANDBOX=off` for proc macros. Keep `make check` as the final word.

## What a change should look like

- **Anything that touches git goes in `frk-core`**, with a test. Tests that
  need a repository build a throwaway one (see `actions::tests::scratch`).
- **A new write operation is a new `Action` variant**, not a command that
  passes arguments through. Validate names with `check-ref-format`, resolve
  commits to a sha, and send paths through `--pathspec-from-file`.
- **If it can be reversed locally, give it an undo** in `undoFor`
  (`src/store.ts`), computed from the state before the action runs.
- **Keep the scroll path out of React.** The graph canvas repaints itself;
  anything per-row and long belongs in a virtualized list.
- Match the comments around you: they explain *why*, briefly, where the code
  cannot.

## Signing builds

`make dmg` signs ad hoc, which is enough to run a build on the Mac that made
it. A .dmg for anyone else needs a Developer ID signature and notarization
(Tauri reads the `APPLE_*` environment variables), or macOS refuses to open it.
