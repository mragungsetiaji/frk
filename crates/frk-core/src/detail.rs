use std::collections::HashMap;

use serde::Serialize;

use crate::git::{FS, Repo, Result};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetail {
    pub sha: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    pub author_time: i64,
    pub committer: String,
    pub commit_time: i64,
    pub subject: String,
    pub body: String,
    pub files: Vec<FileChange>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    /// Set for renames and copies.
    pub old_path: Option<String>,
    /// First letter of git's status: A, M, D, R, C or T.
    pub status: String,
    /// `None` for binary files, which git does not count.
    pub additions: Option<u32>,
    pub deletions: Option<u32>,
}

/// Commit metadata plus the files it changed. A merge is shown against its
/// first parent, i.e. "what this merge brought into the branch", which is what
/// a reviewer of a merged PR wants to see.
pub fn commit_detail(repo: &Repo, sha: &str) -> Result<CommitDetail> {
    let out = repo.run([
        "show",
        "-s",
        &format!("--format=%H{FS}%P{FS}%an{FS}%ae{FS}%at{FS}%cn{FS}%ct{FS}%s{FS}%b"),
        sha,
        "--",
    ])?;
    let f: Vec<&str> = out.splitn(9, FS).collect();
    let get = |i: usize| f.get(i).copied().unwrap_or_default();
    let parents: Vec<String> = get(1).split_whitespace().map(str::to_string).collect();

    let range = diff_range(sha, &parents);
    let status = repo.run(diff_args(&range, "--name-status"))?;
    let numstat = repo.run(diff_args(&range, "--numstat"))?;

    Ok(CommitDetail {
        sha: get(0).to_string(),
        author: get(2).to_string(),
        email: get(3).to_string(),
        author_time: get(4).parse().unwrap_or(0),
        committer: get(5).to_string(),
        commit_time: get(6).parse().unwrap_or(0),
        subject: get(7).to_string(),
        body: get(8).trim_end().to_string(),
        files: merge_file_stats(parse_name_status(&status), parse_numstat(&numstat)),
        parents,
    })
}

/// Unified diff of one file in a commit, against the same base as
/// `commit_detail`.
pub fn file_diff(repo: &Repo, sha: &str, path: &str, old_path: Option<&str>) -> Result<String> {
    let parents = repo.run(["rev-list", "--parents", "-n", "1", sha])?;
    let parents: Vec<String> = parents
        .split_whitespace()
        .skip(1)
        .map(str::to_string)
        .collect();
    let mut args = vec![
        "diff-tree".to_string(),
        "-p".into(),
        "-M".into(),
        "--no-commit-id".into(),
    ];
    args.extend(diff_range(sha, &parents));
    args.push("--".into());
    if let Some(old) = old_path {
        args.push(old.to_string());
    }
    args.push(path.to_string());
    repo.run(args)
}

fn diff_range(sha: &str, parents: &[String]) -> Vec<String> {
    match parents.first() {
        Some(p) => vec![p.clone(), sha.to_string()],
        None => vec!["--root".into(), sha.to_string()],
    }
}

fn diff_args(range: &[String], mode: &str) -> Vec<String> {
    let mut args: Vec<String> = ["diff-tree", "-r", "-M", "-z", "--no-commit-id", mode]
        .into_iter()
        .map(str::to_string)
        .collect();
    args.extend(range.iter().cloned());
    args
}

/// `-z --name-status`: `STATUS\0path\0` or, for renames and copies,
/// `R100\0old\0new\0`.
fn parse_name_status(out: &str) -> Vec<FileChange> {
    let mut tok = out.split('\0').filter(|t| !t.is_empty());
    let mut files = Vec::new();
    while let Some(status) = tok.next() {
        let letter = status.chars().next().unwrap_or('M').to_string();
        let (old_path, path) = if letter == "R" || letter == "C" {
            (tok.next().map(str::to_string), tok.next())
        } else {
            (None, tok.next())
        };
        let Some(path) = path else { break };
        files.push(FileChange {
            path: path.to_string(),
            old_path,
            status: letter,
            additions: None,
            deletions: None,
        });
    }
    files
}

/// `-z --numstat`: `add\tdel\tpath\0`, or `add\tdel\t\0old\0new\0` for a
/// rename. Binary files report `-` for both counts.
fn parse_numstat(out: &str) -> HashMap<String, (Option<u32>, Option<u32>)> {
    let mut tok = out.split('\0');
    let mut stats = HashMap::new();
    while let Some(head) = tok.next() {
        if head.is_empty() {
            continue;
        }
        let mut parts = head.splitn(3, '\t');
        let add = parts.next().and_then(|s| s.parse().ok());
        let del = parts.next().and_then(|s| s.parse().ok());
        let path = match parts.next() {
            Some(p) if !p.is_empty() => p.to_string(),
            _ => {
                tok.next();
                match tok.next() {
                    Some(p) => p.to_string(),
                    None => break,
                }
            }
        };
        stats.insert(path, (add, del));
    }
    stats
}

fn merge_file_stats(
    mut files: Vec<FileChange>,
    stats: HashMap<String, (Option<u32>, Option<u32>)>,
) -> Vec<FileChange> {
    for f in &mut files {
        if let Some(&(a, d)) = stats.get(&f.path) {
            f.additions = a;
            f.deletions = d;
        }
    }
    files
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_renames_and_binary_files() {
        let status = "M\0src/a.rs\0R087\0old/b.rs\0new/b.rs\0A\0img.png\0";
        let numstat =
            "3\t1\tsrc/a.rs\0".to_string() + "5\t2\t\0old/b.rs\0new/b.rs\0-\t-\timg.png\0";
        let files = merge_file_stats(parse_name_status(status), parse_numstat(&numstat));
        assert_eq!(files.len(), 3);
        assert_eq!(files[0].path, "src/a.rs");
        assert_eq!((files[0].additions, files[0].deletions), (Some(3), Some(1)));
        assert_eq!(files[1].status, "R");
        assert_eq!(files[1].old_path.as_deref(), Some("old/b.rs"));
        assert_eq!(files[1].path, "new/b.rs");
        assert_eq!(files[1].additions, Some(5));
        assert_eq!(files[2].additions, None);
    }
}
