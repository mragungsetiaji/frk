import { create } from "zustand";
import { Action, api, GraphFilter, GraphMeta, RefChange, RefInfo, RepoView, WipFile, WorkTree } from "./api";

const LAST_REPO = "frk.lastRepo";
const TABS = "frk.tabs";
const RECENT = "frk.recentRepos";
const PREFS = "frk.prefs";

export type ThemePref = "system" | "light" | "dark";

interface Prefs {
  theme: ThemePref;
  /** Terminal application for the toolbar's Terminal button; empty for the default. */
  terminalApp: string;
  diffLayout: "unified" | "split";
  ignoreWhitespace: boolean;
  fileList: "path" | "tree";
  days: number;
  hideMerged: boolean;
  tags: boolean;
  autoFetchMin: number;
  columns: Columns;
}

/** Graph column widths in px. `graph: null` means "fit the lanes". */
export interface Columns {
  label: number;
  graph: number | null;
}

const defaultPrefs: Prefs = {
  theme: "system",
  terminalApp: "",
  diffLayout: "unified",
  ignoreWhitespace: false,
  fileList: "tree",
  days: 30,
  hideMerged: true,
  tags: false,
  autoFetchMin: 5,
  columns: { label: 200, graph: null },
};

function readJSON<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? { ...fallback, ...JSON.parse(v) } : fallback;
  } catch {
    return fallback;
  }
}

function readList(key: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value));
  } catch {
    // Storage is a convenience here; losing it only loses the remembered prefs.
  }
}

/**
 * An action that can be taken back. `undo` runs in order to reverse `redo`;
 * both are recorded before the action runs, from the state it started in.
 */
export interface UndoEntry {
  label: string;
  redo: Action[];
  undo: Action[];
}

/** A file opened in the full-page file view. */
export interface OpenFile {
  sha: string;
  path: string;
  oldPath: string | null;
  /** Its change in this commit, or null for a file the commit did not touch. */
  status: string | null;
  /** For an uncommitted file (`sha === WIP`): which side of the index it is on. */
  wip?: { file: WipFile; staged: boolean };
}

/** The commit message being written in the WIP panel. */
export interface CommitDraft {
  summary: string;
  description: string;
  amend: boolean;
  noVerify: boolean;
  signOff: boolean;
}

const emptyDraft: CommitDraft = { summary: "", description: "", amend: false, noVerify: false, signOff: false };

export type FileMode = "file" | "diff" | "blame" | "history";

export interface FilePrefs {
  diffLayout: "unified" | "split";
  ignoreWhitespace: boolean;
  fileList: "path" | "tree";
  viewAllFiles: boolean;
}

/** What a right-click landed on: a commit, and the refs labelled on it. */
export interface MenuTarget {
  x: number;
  y: number;
  sha: string;
  refs: string[];
}

export interface PromptSpec {
  title: string;
  label: string;
  initial?: string;
  confirm: string;
  multiline?: boolean;
  /** An optional checkbox under the field, e.g. "Check out after creating". */
  option?: { label: string; initial: boolean };
}

export interface ConfirmSpec {
  title: string;
  body: string;
  confirm: string;
  danger?: boolean;
}

export type Dialog =
  | ({ kind: "prompt"; resolve: (v: { value: string; option: boolean } | null) => void } & PromptSpec)
  | ({ kind: "confirm"; resolve: (ok: boolean) => void } & ConfirmSpec);

interface State {
  repo: RepoView | null;
  /** Full ref name to ref, rebuilt whenever `repo` changes. */
  refIndex: Map<string, RefInfo>;
  /** Full ref name to its pending change. */
  changeIndex: Map<string, RefChange>;
  filter: GraphFilter;
  autoFetchMin: number;
  columns: Columns;
  meta: GraphMeta | null;
  /** Bumped on every graph rebuild so row caches know to drop old rows. */
  graphVersion: number;
  selected: string | null;
  selectedIndex: number | null;
  /** Set to ask the graph to scroll a row into view. */
  scrollTarget: { index: number; nonce: number } | null;
  loading: boolean;
  fetching: boolean;
  lastFetch: number | null;
  error: string | null;
  recent: string[];
  menu: MenuTarget | null;
  dialog: Dialog | null;
  /** The working tree, loaded when the WIP row is selected and on focus. */
  wip: WorkTree | null;
  draft: CommitDraft;
  /** Open repositories, by root, in tab order. */
  tabs: string[];
  undoStack: UndoEntry[];
  redoStack: UndoEntry[];
  terminalApp: string;
  theme: ThemePref;
  /** The theme actually shown, with "system" resolved. */
  resolvedTheme: "light" | "dark";
  file: OpenFile | null;
  fileMode: FileMode;
  filePrefs: FilePrefs;
  notice: { text: string; nonce: number } | null;
  /** A write action is running; the menu is disabled meanwhile. */
  busy: boolean;

  open(path: string): Promise<void>;
  /** Opens the repository named on the command line, else the last one used. */
  reopenLast(): Promise<void>;
  refresh(): Promise<void>;
  fetch(): Promise<void>;
  setFilter(patch: Partial<GraphFilter>): Promise<void>;
  setAutoFetch(min: number): void;
  setColumns(patch: Partial<Columns>): void;
  rebuild(): Promise<void>;
  select(sha: string, index?: number | null): Promise<void>;
  jumpTo(sha: string, refName?: string): Promise<void>;
  markSeen(names?: string[]): Promise<void>;
  clearError(): void;
  openFile(f: OpenFile, mode?: FileMode): void;
  closeFile(): void;
  setFileMode(mode: FileMode): void;
  setFilePrefs(patch: Partial<FilePrefs>): void;
  openMenu(t: MenuTarget): void;
  closeMenu(): void;
  prompt(spec: PromptSpec): Promise<{ value: string; option: boolean } | null>;
  confirm(spec: ConfirmSpec): Promise<boolean>;
  notify(text: string): void;
  /**
   * Runs a write action; resolves false (with the error shown) on failure.
   * Reversible actions (checkout, create/rename/delete branch, reset, tag,
   * stash) go onto the undo history; anything else clears it, since the
   * recorded steps may no longer apply.
   */
  runAction(action: Action, undo?: { label: string; actions: Action[] }): Promise<boolean>;
  undo(): Promise<void>;
  redo(): Promise<void>;
  closeTab(root: string): Promise<void>;
  loadWip(): Promise<void>;
  stage(paths: string[] | null): Promise<void>;
  unstage(paths: string[] | null): Promise<void>;
  discard(files: WipFile[] | null): Promise<void>;
  setDraft(patch: Partial<CommitDraft>): void;
  commit(): Promise<void>;
  setTerminalApp(app: string): void;
  setTheme(theme: ThemePref): void;
}

const darkQuery = window.matchMedia?.("(prefers-color-scheme: dark)");

export function resolveTheme(theme: ThemePref): "light" | "dark" {
  if (theme !== "system") return theme;
  return darkQuery && !darkQuery.matches ? "light" : "dark";
}

/** Follows the OS when the preference is "system". */
darkQuery?.addEventListener("change", () => {
  const { theme } = useStore.getState();
  if (theme === "system") useStore.setState({ resolvedTheme: resolveTheme(theme) });
});

function errorText(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e);
}

export const useStore = create<State>((set, get) => {
  const prefs = readJSON(PREFS, defaultPrefs);

  const savePrefs = () => {
    const { filter, autoFetchMin, columns, filePrefs, terminalApp, theme } = get();
    write(PREFS, {
      theme,
      terminalApp,
      diffLayout: filePrefs.diffLayout,
      ignoreWhitespace: filePrefs.ignoreWhitespace,
      fileList: filePrefs.fileList,
      days: filter.days,
      hideMerged: filter.hideMerged,
      tags: filter.tags,
      autoFetchMin,
      columns,
    } satisfies Prefs);
  };

  const applyRepo = (repo: RepoView) =>
    set({
      repo,
      refIndex: new Map(repo.refs.map((r) => [r.name, r])),
      changeIndex: new Map(repo.changes.map((c) => [c.name, c])),
    });

  /**
   * How to take `action` back, worked out from the repository as it is before
   * the action runs. Undefined for actions that cannot be reversed locally
   * (push, pull, revert, remote deletes, ...).
   */
  const undoFor = (action: Action): { label: string; actions: Action[] } | undefined => {
    const repo = get().repo;
    if (!repo) return undefined;
    const { head } = repo;
    const back: Action | undefined = head.branch
      ? { kind: "checkout", branch: head.branch }
      : head.sha
        ? { kind: "checkoutDetached", sha: head.sha }
        : undefined;
    switch (action.kind) {
      case "checkout":
        return back && { label: `checkout ${action.branch}`, actions: [back] };
      case "checkoutRemote":
        return back && { label: `checkout ${action.remoteBranch}`, actions: [back] };
      case "checkoutDetached":
        return back && { label: `checkout ${action.sha.slice(0, 7)}`, actions: [back] };
      case "createBranch":
        return {
          label: `create branch ${action.name}`,
          actions: [
            ...(action.checkout && back ? [back] : []),
            { kind: "deleteLocal", branch: action.name, force: true, expect: action.at },
          ],
        };
      case "rename":
        return { label: `rename ${action.from}`, actions: [{ kind: "rename", from: action.to, to: action.from }] };
      case "deleteLocal": {
        const ref = get().refIndex.get(`refs/heads/${action.branch}`);
        return (
          ref && {
            label: `delete ${action.branch}`,
            actions: [{ kind: "createBranch", name: action.branch, at: ref.sha, checkout: false }],
          }
        );
      }
      case "reset":
        return head.sha
          ? { label: `reset to ${action.to.slice(0, 7)}`, actions: [{ kind: "reset", mode: action.mode, to: head.sha }] }
          : undefined;
      case "tag":
        return { label: `tag ${action.name}`, actions: [{ kind: "deleteTag", name: action.name }] };
      case "stash":
        return { label: "stash", actions: [{ kind: "stashPop" }] };
      case "commit":
        // Undoing a commit or an amend moves the branch back and keeps the
        // changes staged, the way they were before.
        return head.sha
          ? { label: action.amend ? "amend" : "commit", actions: [{ kind: "reset", mode: "soft", to: head.sha }] }
          : undefined;
      default:
        return undefined;
    }
  };

  /** Runs undo/redo steps without touching the history; stops at the first failure. */
  const runSteps = async (steps: Action[]) => {
    set({ busy: true, error: null });
    try {
      let res = null;
      for (const step of steps) res = await api.runAction(step);
      if (res) applyRepo(res.repo);
      await get().rebuild();
      return true;
    } catch (e) {
      set({ error: errorText(e) });
      // Some steps may have run; show the repository as it now is.
      await get().refresh();
      return false;
    } finally {
      set({ busy: false });
    }
  };

  return {
    repo: null,
    refIndex: new Map(),
    changeIndex: new Map(),
    filter: {
      days: prefs.days,
      hideMerged: prefs.hideMerged,
      tags: prefs.tags,
      hidden: [],
      solo: [],
      include: [],
      maxCommits: 5000,
    },
    autoFetchMin: prefs.autoFetchMin,
    columns: prefs.columns,
    meta: null,
    graphVersion: 0,
    selected: null,
    selectedIndex: null,
    scrollTarget: null,
    loading: false,
    fetching: false,
    lastFetch: null,
    error: null,
    recent: readList(RECENT),
    menu: null,
    dialog: null,
    wip: null,
    draft: emptyDraft,
    tabs: readList(TABS),
    undoStack: [],
    redoStack: [],
    terminalApp: prefs.terminalApp,
    theme: prefs.theme,
    resolvedTheme: resolveTheme(prefs.theme),
    file: null,
    fileMode: "diff",
    filePrefs: {
      diffLayout: prefs.diffLayout,
      ignoreWhitespace: prefs.ignoreWhitespace,
      fileList: prefs.fileList,
      viewAllFiles: false,
    },
    notice: null,
    busy: false,

    async open(path) {
      set({ loading: true, error: null });
      try {
        const repo = await api.openRepo(path);
        const recent = [repo.root, ...get().recent.filter((r) => r !== repo.root)].slice(0, 8);
        const tabs = get().tabs.includes(repo.root) ? get().tabs : [...get().tabs, repo.root];
        write(LAST_REPO, repo.root);
        write(RECENT, recent);
        write(TABS, tabs);
        set((s) => ({
          recent,
          tabs,
          wip: null,
          draft: emptyDraft,
          file: null,
          undoStack: [],
          redoStack: [],
          selected: null,
          selectedIndex: null,
          lastFetch: null,
          filter: { ...s.filter, hidden: [], solo: [], include: [] },
        }));
        applyRepo(repo);
        await get().rebuild();
      } catch (e) {
        set({ error: errorText(e) });
      } finally {
        set({ loading: false });
      }
    },

    async reopenLast() {
      const fromArgs = await api.launchPath().catch(() => null);
      const last = fromArgs ?? localStorage.getItem(LAST_REPO);
      if (last) await get().open(last);
    },

    async refresh() {
      if (!get().repo) return;
      try {
        applyRepo(await api.refresh());
        await get().rebuild();
      } catch (e) {
        set({ error: errorText(e) });
      }
    },

    async fetch() {
      if (!get().repo || get().fetching) return;
      set({ fetching: true });
      try {
        await api.fetchAll();
        set({ lastFetch: Date.now() });
        await get().refresh();
      } catch (e) {
        set({ error: `fetch failed: ${errorText(e)}` });
      } finally {
        set({ fetching: false });
      }
    },

    async setFilter(patch) {
      set((s) => ({ filter: { ...s.filter, ...patch } }));
      savePrefs();
      await get().rebuild();
    },

    setAutoFetch(min) {
      set({ autoFetchMin: min });
      savePrefs();
    },

    setColumns(patch) {
      set((s) => ({ columns: { ...s.columns, ...patch } }));
      savePrefs();
    },

    async rebuild() {
      if (!get().repo) return;
      try {
        const meta = await api.buildGraph(get().filter);
        const sel = get().selected;
        const selectedIndex = sel ? await api.findRow(sel) : null;
        set((s) => ({ meta, graphVersion: s.graphVersion + 1, selectedIndex }));
      } catch (e) {
        set({ error: errorText(e) });
      }
    },

    async select(sha, index) {
      const selectedIndex = index ?? (await api.findRow(sha));
      // The file view belongs to one commit; picking another closes it.
      set((s) => ({ selected: sha, selectedIndex, file: s.file?.sha === sha ? s.file : null }));
    },

    async jumpTo(sha, refName) {
      let index = await api.findRow(sha);
      // Not in the graph because the filters hide it: pull that one ref in.
      if (index == null && refName) {
        const f = get().filter;
        await get().setFilter({
          include: [...f.include.filter((n) => n !== refName), refName],
          hidden: f.hidden.filter((n) => n !== refName),
        });
        index = await api.findRow(sha);
      }
      if (index == null) {
        set({ error: "That commit is outside the loaded history." });
        return;
      }
      set((s) => ({
        selected: sha,
        selectedIndex: index,
        scrollTarget: { index, nonce: Date.now() },
        file: s.file?.sha === sha ? s.file : null,
      }));
    },

    async markSeen(names) {
      try {
        const changes = await api.markSeen(names);
        set((s) => ({
          repo: s.repo ? { ...s.repo, changes, baseline: false } : s.repo,
          changeIndex: new Map(changes.map((c) => [c.name, c])),
        }));
      } catch (e) {
        set({ error: errorText(e) });
      }
    },

    clearError() {
      set({ error: null });
    },

    openFile(file, mode) {
      // An untouched file has no diff to show; anything else keeps the mode
      // the user was in, except that a file cannot be blamed where it was deleted.
      const current = get().fileMode;
      const fileMode = mode ?? (file.status == null ? "file" : current === "blame" && file.status === "D" ? "diff" : current);
      set({ file, fileMode });
    },

    closeFile() {
      set({ file: null });
    },

    setFileMode(fileMode) {
      set({ fileMode });
    },

    setFilePrefs(patch) {
      set((s) => ({ filePrefs: { ...s.filePrefs, ...patch } }));
      savePrefs();
    },

    openMenu(menu) {
      set({ menu });
    },

    closeMenu() {
      set({ menu: null });
    },

    prompt(spec) {
      return new Promise((resolve) =>
        set({
          dialog: {
            kind: "prompt",
            ...spec,
            resolve: (v) => {
              set({ dialog: null });
              resolve(v);
            },
          },
        }),
      );
    },

    confirm(spec) {
      return new Promise((resolve) =>
        set({
          dialog: {
            kind: "confirm",
            ...spec,
            resolve: (ok) => {
              set({ dialog: null });
              resolve(ok);
            },
          },
        }),
      );
    },

    notify(text) {
      set({ notice: { text, nonce: Date.now() } });
    },

    async runAction(action, explicitUndo) {
      const undo = explicitUndo ?? undoFor(action);
      set({ busy: true, error: null });
      try {
        const res = await api.runAction(action);
        applyRepo(res.repo);
        set((s) =>
          undo
            ? { undoStack: [...s.undoStack, { label: undo.label, redo: [action], undo: undo.actions }], redoStack: [] }
            : { undoStack: [], redoStack: [] },
        );
        await get().rebuild();
        get().notify(res.message);
        return true;
      } catch (e) {
        set({ error: errorText(e) });
        return false;
      } finally {
        set({ busy: false });
      }
    },

    async undo() {
      const entry = get().undoStack[get().undoStack.length - 1];
      if (!entry) return;
      if (await runSteps(entry.undo)) {
        set((s) => ({ undoStack: s.undoStack.slice(0, -1), redoStack: [...s.redoStack, entry] }));
        get().notify(`Undid ${entry.label}`);
      } else {
        // A step failed part way: the recorded history no longer describes the repository.
        set({ undoStack: [], redoStack: [] });
      }
    },

    async redo() {
      const entry = get().redoStack[get().redoStack.length - 1];
      if (!entry) return;
      if (await runSteps(entry.redo)) {
        set((s) => ({ redoStack: s.redoStack.slice(0, -1), undoStack: [...s.undoStack, entry] }));
        get().notify(`Redid ${entry.label}`);
      } else {
        set({ undoStack: [], redoStack: [] });
      }
    },

    async closeTab(root) {
      const tabs = get().tabs.filter((t) => t !== root);
      write(TABS, tabs);
      set({ tabs });
      if (get().repo?.root !== root) return;
      const next = tabs[tabs.length - 1];
      if (next) {
        await get().open(next);
      } else {
        try {
          localStorage.removeItem(LAST_REPO);
        } catch {
          // Only the reopen-on-launch convenience is lost.
        }
        set({ repo: null, meta: null, selected: null, file: null, undoStack: [], redoStack: [] });
      }
    },

    async loadWip() {
      if (!get().repo) return;
      try {
        const wip = await api.wipStatus();
        set({ wip });
        // The WIP row appears or goes when the tree turns dirty or clean.
        const clean = wip.unstaged.length + wip.staged.length + wip.conflicted.length === 0;
        if (clean !== ((get().repo?.work.dirty ?? 0) === 0)) await get().refresh();
      } catch (e) {
        set({ error: errorText(e) });
      }
    },

    async stage(paths) {
      try {
        set({ wip: await api.wipStage(paths) });
      } catch (e) {
        set({ error: errorText(e) });
      }
    },

    async unstage(paths) {
      try {
        set({ wip: await api.wipUnstage(paths) });
      } catch (e) {
        set({ error: errorText(e) });
      }
    },

    async discard(files) {
      try {
        set({ wip: await api.wipDiscard(files), file: null });
        await get().loadWip();
      } catch (e) {
        set({ error: errorText(e) });
      }
    },

    setDraft(patch) {
      set((s) => ({ draft: { ...s.draft, ...patch } }));
    },

    async commit() {
      const { draft } = get();
      const message = draft.description.trim()
        ? `${draft.summary.trim()}\n\n${draft.description.trim()}\n`
        : `${draft.summary.trim()}\n`;
      const ok = await get().runAction({
        kind: "commit",
        message,
        amend: draft.amend,
        noVerify: draft.noVerify,
        signOff: draft.signOff,
      });
      if (!ok) return;
      set({ draft: emptyDraft, file: null });
      await get().loadWip();
      // Show the commit just made unless there is still work left to commit.
      const wip = get().wip;
      const head = get().repo?.head.sha;
      if (head && wip && wip.unstaged.length + wip.staged.length === 0) await get().jumpTo(head);
    },

    setTheme(theme) {
      set({ theme, resolvedTheme: resolveTheme(theme) });
      savePrefs();
    },

    setTerminalApp(terminalApp) {
      set({ terminalApp });
      savePrefs();
    },
  };
});
