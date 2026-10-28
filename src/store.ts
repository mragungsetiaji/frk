import { create } from "zustand";
import { api, GraphFilter, GraphMeta, RefChange, RefInfo, RepoView } from "./api";

const LAST_REPO = "frk.lastRepo";
const RECENT = "frk.recentRepos";
const PREFS = "frk.prefs";

interface Prefs {
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
}

function errorText(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e);
}

export const useStore = create<State>((set, get) => {
  const prefs = readJSON(PREFS, defaultPrefs);

  const savePrefs = () => {
    const { filter, autoFetchMin, columns } = get();
    write(PREFS, {
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

    async open(path) {
      set({ loading: true, error: null });
      try {
        const repo = await api.openRepo(path);
        const recent = [repo.root, ...get().recent.filter((r) => r !== repo.root)].slice(0, 8);
        write(LAST_REPO, repo.root);
        write(RECENT, recent);
        set((s) => ({
          recent,
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
      set({ selected: sha, selectedIndex });
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
      set({ selected: sha, selectedIndex: index, scrollTarget: { index, nonce: Date.now() } });
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
  };
});
