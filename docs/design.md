# How frk works

The README says what frk does. This is how, and why it is built the way it is.

## Layout

```
crates/frk-core   everything that talks to git: refs, the commit walk and lane
                  layout, the "since last seen" snapshot, commit and file
                  detail, the working tree, and every write action
src-tauri         Tauri commands over frk-core, holding one session per
                  window; git work runs off the main thread
src               React UI: the graph (canvas + virtual list), sidebar,
                  commit / WIP panels, file view, toolbar
```

All git access goes through the git CLI rather than a library binding, so the
user's config, credential helpers, SSH agent, hooks and `commit-graph` file
apply exactly as they do in a terminal. `git log` over a few thousand commits
is far below what the UI can notice. If the walk ever becomes the bottleneck on
a very large repository, `graph` is the one module worth moving to gitoxide.

## Staying light

- **Layout runs once per filter change, in Rust.** The UI asks for rows by
  index range; only the rows on screen exist in the DOM.
- **The graph is one `<canvas>`** the size of the viewport, repainted on
  scroll from the visible rows only. React never re-renders on scroll.
- **Few lanes by default.** Merged and inactive branches (no commits in 30
  days) are left out of the walk, so a repository with hundreds of refs draws
  a dozen lanes rather than hundreds.
- **Every long list is virtualized**: graph rows, diff lines, whole files,
  blame.
- **System webview**, not a bundled Chromium.

Measured on a 432-ref, 1.4k-commit repository: ref listing ~110 ms, commit walk
50–100 ms, lane layout under 1 ms. The release app is 4.9 MB and the .dmg
2.4 MB.

## The lane layout

Each lane is a line heading down to one expected commit. A commit takes the
first lane expecting it (or a free one if nothing does: a branch tip) and every
other lane expecting it converges into it and ends. Its first parent continues
straight down in the same lane, so a branch reads as one vertical line; further
parents of a merge reuse a lane already heading to that parent or open a new
one.

Two branches that fork from one commit therefore run as parallel lines until
they meet there. That is deliberate: it is what makes every in-flight branch
visible as its own line instead of being folded into its neighbour. Lanes are
never shifted sideways to close gaps; a freed slot is reused by the next branch
that needs one, which keeps unrelated lines still.

HEAD's history is marked in the same single pass (children always precede
parents), and every edge carries whether it belongs to it, so everything else
can be drawn dimmed.

## "Since last seen"

A per-repository snapshot (`<app data>/snapshots/`) records which commit each
branch pointed at when the user last acknowledged it. On first open every
branch is recorded as seen. After that, the current refs are diffed against
the snapshot: new, moved (with the commits and authors that arrived),
force-pushed (the old tip is no longer an ancestor) and deleted branches.

The snapshot only moves when the user marks something seen. A fetch never
advances it, so a branch someone pushed while you were away stays flagged
until you have actually looked at it. Flagged branches are always drawn, even
when old or merged.

## Write actions

Everything in the right-click menu and the toolbar is a typed action in
`crates/frk-core/src/actions.rs`; the UI can only ask for what is listed there,
never pass git arguments through. Names are checked with
`git check-ref-format`, commit ids are resolved to a full sha first, and shas
from the UI must be hex, which also rules out anything git would read as an
option. Paths reach git through `--pathspec-from-file` on stdin.

Actions touch only the refs they name. Pull fetches the one upstream branch it
needs rather than the whole remote, so after an action every ref that moved
moved because the user asked it to, and is marked seen instead of reported back
as news.

Destructive actions ask first. The integration branch cannot be deleted from
the menu, and there is no pull request into it from itself.

### Undo

Undo covers what can be reversed locally: checkout, create / rename / delete
branch, reset, tag, stash, commit and amend. The steps to reverse an action are
worked out *before* it runs, from the state it started in. Undoing "create
branch" refuses if the branch has gained commits since; undoing a commit is a
soft reset, so its changes come back staged. Anything that cannot be undone
(push, pull, revert, …) clears the history rather than leave steps that no
longer apply.

## The working tree

Uncommitted work is a pseudo-commit (`WORKING`) inserted above HEAD before the
lane layout, so it gets a real lane and counts as HEAD's history. Status is
`git status --porcelain=v2 -z`, re-read whenever the window regains focus.

Staging, unstaging and discarding run straight against git and return the new
status, without reloading refs or the graph; only a commit, which moves HEAD,
does. Untracked files being discarded are deleted directly, and only if they
resolve to a path inside the repository.

## The file view

Syntax highlighting (Prism) runs over the whole file once, and the diff's lines
are picked out of the result, so block comments and multi-line strings colour
correctly; highlighting hunks on their own would not. Word-level marks come
from an LCS over word, space and punctuation tokens of each removed line and
the added line that replaced it, and are dropped when they would cover most of
the line. Split view keeps both sides at half width and scrolls them sideways
together.
