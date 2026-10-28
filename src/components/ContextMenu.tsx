import { save } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, RefInfo, Remote, RepoView } from "../api";
import { MenuTarget, useStore } from "../store";

type Item =
  | {
      label: string;
      run?: () => void | Promise<unknown>;
      disabled?: boolean;
      danger?: boolean;
      hint?: string;
      sub?: Item[];
    }
  | "sep";

/** Branch paths keep their slashes in URLs; each segment is escaped. */
const enc = (branch: string) => branch.split("/").map(encodeURIComponent).join("/");

function branchUrl(r: Remote, branch: string): string {
  switch (r.host) {
    case "gitlab":
      return `${r.web}/-/tree/${enc(branch)}`;
    case "bitbucket":
      return `${r.web}/branch/${enc(branch)}`;
    default:
      return `${r.web}/tree/${enc(branch)}`;
  }
}

function commitUrl(r: Remote, sha: string): string {
  switch (r.host) {
    case "gitlab":
      return `${r.web}/-/commit/${sha}`;
    case "bitbucket":
      return `${r.web}/commits/${sha}`;
    default:
      return `${r.web}/commit/${sha}`;
  }
}

function pullRequestUrl(r: Remote, branch: string, base: string | null): string {
  switch (r.host) {
    case "gitlab":
      return `${r.web}/-/merge_requests/new?merge_request[source_branch]=${encodeURIComponent(branch)}`;
    case "bitbucket":
      return `${r.web}/pull-requests/new?source=${encodeURIComponent(branch)}`;
    default:
      return `${r.web}/compare/${base ? `${enc(base)}...` : ""}${enc(branch)}?expand=1`;
  }
}

/** `origin/feat/x` → origin and `feat/x`, matching the longest remote name. */
function splitRemote(short: string, remotes: Remote[]): [Remote, string] | null {
  const r = [...remotes]
    .sort((a, b) => b.name.length - a.name.length)
    .find((r) => short.startsWith(`${r.name}/`));
  return r ? [r, short.slice(r.name.length + 1)] : null;
}

function defaultRemote(repo: RepoView): Remote | undefined {
  return repo.remotes.find((r) => r.name === "origin") ?? repo.remotes[0];
}

function buildItems(menu: MenuTarget): Item[] {
  const st = useStore.getState();
  const repo = st.repo!;
  const { refIndex, filter, runAction, prompt, confirm, notify, setFilter } = st;
  const { sha } = menu;
  const short = sha.slice(0, 7);
  const headBranch = repo.head.branch;
  const headSha = repo.head.sha;

  const refs = menu.refs.map((n) => refIndex.get(n)).filter((r): r is RefInfo => !!r);
  const local = refs.find((r) => r.kind === "local");
  const remote =
    refs.find((r) => r.kind === "remote") ??
    (local?.upstream ? refIndex.get(`refs/remotes/${local.upstream}`) : undefined);
  const tag = refs.find((r) => r.kind === "tag");
  const remoteSplit = remote ? splitRemote(remote.short, repo.remotes) : null;
  const linkRemote = remoteSplit?.[0] ?? defaultRemote(repo);
  const targetBranch = repo.target ? splitRemote(repo.target.replace(/^refs\/remotes\//, ""), repo.remotes)?.[1] ?? null : null;

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      notify(`Copied ${what}`);
    } catch {
      useStore.setState({ error: "Could not write to the clipboard." });
    }
  };

  const items: Item[] = [];

  if (local) {
    const b = local.short;
    items.push(
      {
        label: "Pull (fast-forward if possible)",
        disabled: !local.upstream,
        hint: local.upstream ? undefined : "no upstream",
        run: () => runAction({ kind: "pull", branch: b }),
      },
      { label: local.upstream ? "Push" : "Push and set upstream", run: () => runAction({ kind: "push", branch: b }) },
      {
        label: "Set Upstream…",
        disabled: repo.remotes.length === 0,
        run: async () => {
          const v = await prompt({
            title: `Set upstream for ${b}`,
            label: "Remote branch",
            initial: local.upstream ?? `${defaultRemote(repo)?.name ?? "origin"}/${b}`,
            confirm: "Set upstream",
          });
          if (v?.value.trim()) await runAction({ kind: "setUpstream", branch: b, upstream: v.value.trim() });
        },
      },
      "sep",
    );
    if (b !== headBranch) items.push({ label: `Checkout ${b}`, run: () => runAction({ kind: "checkout", branch: b }) });
  } else if (remote) {
    items.push({
      label: `Checkout ${remote.short}`,
      hint: "local tracking branch",
      run: () => runAction({ kind: "checkoutRemote", remoteBranch: remote.short }),
    });
  }
  items.push(
    {
      label: "Checkout this commit",
      hint: "detached",
      disabled: sha === headSha,
      run: () => runAction({ kind: "checkoutDetached", sha }),
    },
    "sep",
    {
      label: "Create branch here…",
      run: async () => {
        const v = await prompt({
          title: `Create branch at ${short}`,
          label: "Branch name",
          confirm: "Create branch",
          option: { label: "Check it out", initial: true },
        });
        if (v?.value.trim()) await runAction({ kind: "createBranch", name: v.value.trim(), at: sha, checkout: v.option });
      },
    },
  );
  if (headBranch && sha !== headSha) {
    items.push({
      label: `Reset ${headBranch} to this commit`,
      sub: [
        { label: "Soft", hint: "keep changes staged", run: () => runAction({ kind: "reset", mode: "soft", to: sha }) },
        { label: "Mixed", hint: "keep changes unstaged", run: () => runAction({ kind: "reset", mode: "mixed", to: sha }) },
        {
          label: "Hard",
          hint: "discard changes",
          danger: true,
          run: async () => {
            const ok = await confirm({
              title: `Hard reset ${headBranch} to ${short}?`,
              body: `Every uncommitted change in the working tree is discarded. Commits after ${short} on ${headBranch} stay recoverable only through the reflog.`,
              confirm: "Reset hard",
              danger: true,
            });
            if (ok) await runAction({ kind: "reset", mode: "hard", to: sha });
          },
        },
      ],
    });
  }
  items.push(
    {
      label: "Edit commit message…",
      disabled: sha !== headSha,
      hint: sha !== headSha ? "HEAD commit only" : undefined,
      run: async () => {
        const d = await api.commitDetail(sha);
        const initial = d.body ? `${d.subject}\n\n${d.body}` : d.subject;
        const v = await prompt({ title: "Edit commit message", label: "Message", initial, multiline: true, confirm: "Save" });
        if (v && v.value.trim() && v.value !== initial) await runAction({ kind: "reword", message: v.value });
      },
    },
    {
      label: "Revert commit",
      disabled: !headSha,
      run: async () => {
        const ok = await confirm({
          title: `Revert ${short}?`,
          body: `Creates a new commit on ${headBranch ?? "HEAD"} that undoes ${short}. A merge is reverted against its first parent.`,
          confirm: "Revert",
        });
        if (ok) await runAction({ kind: "revert", sha });
      },
    },
    "sep",
  );

  if (local) {
    const b = local.short;
    const pushRemote = (local.upstream ? splitRemote(local.upstream, repo.remotes)?.[0] : undefined) ?? defaultRemote(repo);
    const remoteName = local.upstream ? splitRemote(local.upstream, repo.remotes)?.[1] ?? b : b;
    // Nothing to open a pull request into when this is the integration branch.
    if (pushRemote?.web && remoteName !== targetBranch) {
      items.push(
        {
          label: `Push ${b} and start a pull request`,
          run: async () => {
            if (await runAction({ kind: "push", branch: b })) {
              await openUrl(pullRequestUrl(pushRemote, remoteName, targetBranch));
            }
          },
        },
        "sep",
      );
    }
    items.push(
      {
        label: `Rename ${b}…`,
        run: async () => {
          const v = await prompt({ title: `Rename ${b}`, label: "New name", initial: b, confirm: "Rename" });
          if (v?.value.trim() && v.value.trim() !== b) await runAction({ kind: "rename", from: b, to: v.value.trim() });
        },
      },
      {
        label: `Delete ${b}`,
        danger: true,
        disabled: b === headBranch,
        hint: b === headBranch ? "checked out" : undefined,
        run: async () => {
          if (!(await confirm({ title: `Delete ${b}?`, body: "Deletes the local branch only.", confirm: "Delete", danger: true })))
            return;
          if (await runAction({ kind: "deleteLocal", branch: b, force: false })) return;
          if (!/not fully merged/i.test(useStore.getState().error ?? "")) return;
          const force = await confirm({
            title: `${b} is not fully merged`,
            body: "Some of its commits are on no other branch. Delete it anyway? They stay recoverable through the reflog for a while.",
            confirm: "Delete anyway",
            danger: true,
          });
          if (force) await runAction({ kind: "deleteLocal", branch: b, force: true });
        },
      },
    );
  }
  if (remote && remoteSplit) {
    const isTarget = remote.name === repo.target;
    items.push({
      label: `Delete ${remote.short}`,
      danger: true,
      disabled: isTarget,
      hint: isTarget ? "integration branch" : undefined,
      run: async () => {
        const ok = await confirm({
          title: `Delete ${remote.short}?`,
          body: `Deletes ${remoteSplit[1]} on ${remoteSplit[0].name} for everyone who uses it.`,
          confirm: "Delete remote branch",
          danger: true,
        });
        if (ok) await runAction({ kind: "deleteRemote", remoteBranch: remote.short });
      },
    });
  }
  items.push("sep");

  const named = local ?? remote ?? tag;
  if (named) {
    const name = named === remote && remoteSplit ? remoteSplit[1] : named.short;
    items.push({ label: "Copy branch name", run: () => copy(name, name) });
  }
  items.push({ label: "Copy commit sha", run: () => copy(sha, short) });
  if (remote && remoteSplit?.[0].web) {
    items.push({
      label: `Copy link to branch: ${remote.short}`,
      run: () => copy(branchUrl(remoteSplit[0], remoteSplit[1]), "branch link"),
    });
  }
  if (linkRemote?.web) {
    items.push({
      label: `Copy link to this commit on remote: ${linkRemote.name}`,
      run: () => copy(commitUrl(linkRemote, sha), "commit link"),
    });
  }
  items.push(
    {
      label: "Create patch from commit…",
      run: async () => {
        const path = await save({ defaultPath: `${short}.patch`, filters: [{ name: "Patch", extensions: ["patch"] }] });
        if (path) await runAction({ kind: "createPatch", sha, path });
      },
    },
    "sep",
  );

  if (refs.length > 0) {
    const names = refs.map((r) => r.name);
    const soloed = names.some((n) => filter.solo.includes(n));
    items.push(
      soloed
        ? { label: "Unsolo", run: () => setFilter({ solo: filter.solo.filter((n) => !names.includes(n)) }) }
        : { label: "Solo", run: () => setFilter({ solo: [...filter.solo, ...names] }) },
      {
        label: "Hide",
        run: () =>
          setFilter({
            hidden: [...filter.hidden, ...names],
            include: filter.include.filter((n) => !names.includes(n)),
          }),
      },
    );
  }
  if (filter.solo.length > 0) items.push({ label: "Show all branches", run: () => setFilter({ solo: [] }) });
  items.push(
    "sep",
    {
      label: "Create tag here…",
      run: async () => {
        const v = await prompt({ title: `Tag ${short}`, label: "Tag name", confirm: "Create tag" });
        if (v?.value.trim()) await runAction({ kind: "tag", name: v.value.trim(), at: sha, message: null });
      },
    },
    {
      label: "Create annotated tag here…",
      run: async () => {
        const name = await prompt({ title: `Annotated tag at ${short}`, label: "Tag name", confirm: "Next" });
        if (!name?.value.trim()) return;
        const msg = await prompt({ title: `Message for ${name.value.trim()}`, label: "Message", multiline: true, confirm: "Create tag" });
        if (msg?.value.trim()) await runAction({ kind: "tag", name: name.value.trim(), at: sha, message: msg.value });
      },
    },
  );

  // Drop separators that ended up leading, trailing or doubled.
  return items.filter((it, i, all) => it !== "sep" || (i > 0 && i < all.length - 1 && all[i - 1] !== "sep"));
}

export function ContextMenu() {
  const menu = useStore((s) => s.menu);
  const busy = useStore((s) => s.busy);
  const closeMenu = useStore((s) => s.closeMenu);
  if (!menu) return null;
  // Rebuilt per open: the items depend on the repository at that moment.
  return <MenuPanel key={`${menu.x}:${menu.y}:${menu.sha}`} menu={menu} busy={busy} onClose={closeMenu} />;
}

function MenuPanel({ menu, busy, onClose }: { menu: MenuTarget; busy: boolean; onClose: () => void }) {
  const [items] = useState(() => buildItems(menu));
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: menu.x, top: menu.y });
  const [active, setActive] = useState(-1);
  const [openSub, setOpenSub] = useState<number | null>(null);

  // Keep the whole menu on screen, flipping up or left near the edges.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const left = menu.x + width > window.innerWidth - 8 ? Math.max(8, menu.x - width) : menu.x;
    const top = menu.y + height > window.innerHeight - 8 ? Math.max(8, window.innerHeight - height - 8) : menu.y;
    setPos({ left, top });
    el.focus();
  }, [menu]);

  useEffect(() => {
    const close = () => onClose();
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [onClose]);

  const selectable = (i: number) => {
    const it = items[i];
    return it !== "sep" && !it.disabled;
  };

  const activate = (i: number) => {
    const it = items[i];
    if (it === "sep" || it.disabled || busy) return;
    if (it.sub) {
      setOpenSub(i);
      return;
    }
    onClose();
    void it.run?.();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (openSub !== null) setOpenSub(null);
      else onClose();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      let i = active;
      for (let n = 0; n < items.length; n++) {
        i = (i + step + items.length) % items.length;
        if (selectable(i)) break;
      }
      setActive(i);
      setOpenSub(null);
    } else if (e.key === "Enter" || e.key === "ArrowRight") {
      e.preventDefault();
      if (active >= 0) activate(active);
    }
  };

  return (
    <div
      className="ctx-overlay"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div
        ref={ref}
        className="ctx-menu"
        role="menu"
        tabIndex={-1}
        style={pos}
        onKeyDown={onKeyDown}
      >
        {items.map((it, i) =>
          it === "sep" ? (
            <div key={i} className="ctx-sep" role="separator" />
          ) : (
            <div
              key={i}
              className="ctx-item-wrap"
              onMouseEnter={() => {
                setActive(i);
                setOpenSub(it.sub ? i : null);
              }}
            >
              <button
                role="menuitem"
                className={`ctx-item${it.danger ? " danger" : ""}${active === i ? " active" : ""}`}
                disabled={it.disabled || busy}
                aria-haspopup={it.sub ? "menu" : undefined}
                onClick={() => activate(i)}
              >
                <span className="ellipsis">{it.label}</span>
                {it.hint && <span className="ctx-hint">{it.hint}</span>}
                {it.sub && <span className="ctx-arrow">›</span>}
              </button>
              {it.sub && openSub === i && (
                <div className="ctx-menu ctx-sub" role="menu">
                  {it.sub.map((s, k) =>
                    s === "sep" ? (
                      <div key={k} className="ctx-sep" role="separator" />
                    ) : (
                      <button
                        key={k}
                        role="menuitem"
                        className={`ctx-item${s.danger ? " danger" : ""}`}
                        disabled={s.disabled || busy}
                        onClick={() => {
                          onClose();
                          void s.run?.();
                        }}
                      >
                        <span>{s.label}</span>
                        {s.hint && <span className="ctx-hint">{s.hint}</span>}
                      </button>
                    ),
                  )}
                </div>
              )}
            </div>
          ),
        )}
      </div>
    </div>
  );
}
