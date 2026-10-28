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

export interface RepoView {
  root: string;
  head: Head;
  target: string | null;
  refs: RefInfo[];
  changes: RefChange[];
  baseline: boolean;
}

export interface Edge {
  from: number;
  to: number;
  color: number;
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

export const api = {
  openRepo: (path: string) => invoke<RepoView>("open_repo", { path }),
  refresh: () => invoke<RepoView>("refresh"),
  fetchAll: () => invoke<void>("fetch_all"),
  buildGraph: (filter: GraphFilter) => invoke<GraphMeta>("build_graph", { filter }),
  graphRows: (start: number, end: number) => invoke<Row[]>("graph_rows", { start, end }),
  findRow: (sha: string) => invoke<number | null>("find_row", { sha }),
  commitDetail: (sha: string) => invoke<CommitDetail>("commit_detail", { sha }),
  fileDiff: (sha: string, path: string, oldPath: string | null) =>
    invoke<string>("file_diff", { sha, path, oldPath }),
  launchPath: () => invoke<string | null>("launch_path"),
  markSeen: (names?: string[]) => invoke<RefChange[]>("mark_seen", { names: names ?? null }),
};
