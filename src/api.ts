import { invoke } from "@tauri-apps/api/core";

// Mirrors of the Rust types in crates/frk-core and src-tauri/src/lib.rs.

export type RefKind = "local" | "remote" | "tag";

export interface RefInfo {
  name: string;
  short: string;
  kind: RefKind;
  sha: string;
  time: number;
  author: string;
  email: string;
  subject: string;
  upstream: string | null;
  merged: boolean;
}

export interface Head {
  branch: string | null;
  sha: string | null;
}

export type RefChange =
  | { kind: "added"; name: string; sha: string; commits: number; authors: string[] }
  | {
      kind: "updated";
      name: string;
      from: string;
      to: string;
      commits: number;
      authors: string[];
      forced: boolean;
    }
  | { kind: "removed"; name: string; sha: string };

export interface Remote {
  name: string;
  url: string;
  web: string | null;
  host: "github" | "gitlab" | "bitbucket" | "other";
}

export interface RepoView {
  root: string;
  head: Head;
  target: string | null;
  refs: RefInfo[];
  remotes: Remote[];
  work: { dirty: number; stashes: number };
  changes: RefChange[];
  baseline: boolean;
}

export interface Edge {
  from: number;
  to: number;
  color: number;
  /** Part of HEAD's history; everything else is drawn dimmed. */
  head: boolean;
}

export interface Row {
  sha: string;
  parents: string[];
  author: string;
  email: string;
  time: number;
  subject: string;
  lane: number;
  color: number;
  onHead: boolean;
  top: Edge[];
  bottom: Edge[];
  refs: string[];
}

export interface GraphFilter {
  days: number;
  hideMerged: boolean;
  tags: boolean;
  hidden: string[];
  solo: string[];
  include: string[];
  maxCommits: number;
}

export interface GraphMeta {
  rows: number;
  maxLanes: number;
  visible: string[];
}

export interface FileChange {
  path: string;
  oldPath: string | null;
  status: string;
  additions: number | null;
  deletions: number | null;
}

export interface CommitDetail {
  sha: string;
  parents: string[];
  author: string;
  email: string;
  authorTime: number;
  committer: string;
  commitTime: number;
  subject: string;
  body: string;
  files: FileChange[];
}

export interface FileVersions {
  old: string | null;
  new: string | null;
  binary: boolean;
  tooLarge: boolean;
}

export interface BlameCommit {
  sha: string;
  author: string;
  email: string;
  time: number;
  summary: string;
}

export interface Blame {
  commits: BlameCommit[];
  /** Per line of the file, an index into `commits`. */
  lines: number[];
}

export interface HistoryEntry {
  sha: string;
  author: string;
  email: string;
  time: number;
  subject: string;
  path: string;
  oldPath: string | null;
  status: string;
}

/** Pseudo-sha of the working tree's row in the graph (`frk_core::worktree::WIP`). */
export const WIP = "WORKING";

export interface WipFile {
  path: string;
  oldPath: string | null;
  status: string;
  untracked: boolean;
}

export interface WorkTree {
  branch: string | null;
  unstaged: WipFile[];
  staged: WipFile[];
  conflicted: string[];
}

/** Mirrors `frk_core::actions::Action`. */
export type Action =
  | { kind: "checkout"; branch: string }
  | { kind: "checkoutRemote"; remoteBranch: string }
  | { kind: "checkoutDetached"; sha: string }
  | { kind: "createBranch"; name: string; at: string; checkout: boolean }
  | { kind: "reset"; mode: "soft" | "mixed" | "hard"; to: string }
  | { kind: "revert"; sha: string }
  | { kind: "reword"; message: string }
  | { kind: "pull"; branch: string }
  | { kind: "push"; branch: string }
  | { kind: "setUpstream"; branch: string; upstream: string }
  | { kind: "rename"; from: string; to: string }
  | { kind: "deleteLocal"; branch: string; force: boolean; expect?: string }
  | { kind: "deleteTag"; name: string }
  | { kind: "stash"; message: string | null }
  | { kind: "stashPop" }
  | { kind: "commit"; message: string; amend: boolean; noVerify: boolean; signOff: boolean }
  | { kind: "deleteRemote"; remoteBranch: string }
  | { kind: "tag"; name: string; at: string; message: string | null }
  | { kind: "createPatch"; sha: string; path: string };

export interface ActionResult {
  message: string;
  repo: RepoView;
}

export const api = {
  openRepo: (path: string) => invoke<RepoView>("open_repo", { path }),
  refresh: () => invoke<RepoView>("refresh"),
  fetchAll: () => invoke<void>("fetch_all"),
  buildGraph: (filter: GraphFilter) => invoke<GraphMeta>("build_graph", { filter }),
  graphRows: (start: number, end: number) => invoke<Row[]>("graph_rows", { start, end }),
  findRow: (sha: string) => invoke<number | null>("find_row", { sha }),
  commitDetail: (sha: string) => invoke<CommitDetail>("commit_detail", { sha }),
  fileDiff: (sha: string, path: string, oldPath: string | null, ignoreWhitespace = false) =>
    invoke<string>("file_diff", { sha, path, oldPath, ignoreWhitespace }),
  fileVersions: (sha: string, path: string, oldPath: string | null) =>
    invoke<FileVersions>("file_versions", { sha, path, oldPath }),
  blame: (sha: string, path: string) => invoke<Blame>("blame", { sha, path }),
  fileHistory: (sha: string, path: string) => invoke<HistoryEntry[]>("file_history", { sha, path }),
  treeFiles: (sha: string) => invoke<string[]>("tree_files", { sha }),
  runAction: (action: Action) => invoke<ActionResult>("run_action", { action }),
  wipStatus: () => invoke<WorkTree>("wip_status"),
  wipStage: (paths: string[] | null) => invoke<WorkTree>("wip_stage", { paths }),
  wipUnstage: (paths: string[] | null) => invoke<WorkTree>("wip_unstage", { paths }),
  wipDiscard: (files: WipFile[] | null) => invoke<WorkTree>("wip_discard", { files }),
  wipFileDiff: (file: WipFile, staged: boolean, ignoreWhitespace = false) =>
    invoke<string>("wip_file_diff", { file, staged, ignoreWhitespace }),
  wipFileVersions: (file: WipFile, staged: boolean) => invoke<FileVersions>("wip_file_versions", { file, staged }),
  openTerminal: (app: string | null) => invoke<void>("open_terminal", { app }),
  launchPath: () => invoke<string | null>("launch_path"),
  markSeen: (names?: string[]) => invoke<RefChange[]>("mark_seen", { names: names ?? null }),
};
