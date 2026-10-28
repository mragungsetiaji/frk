//! One file at one commit: its contents on both sides of the commit, blame,
//! and the commits that touched it. Backs the full-page file view.

use serde::Serialize;

use crate::git::{FS, RS, Repo, Result, check_sha};

/// Files larger than this are not sent to the UI whole; it falls back to the
/// plain diff, without syntax highlighting or the full-file view.
const MAX_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileVersions {
    /// Contents in the commit's first parent; `None` when the file was added
    /// (or for a root commit).
    pub old: Option<String>,
    /// Contents in the commit; `None` when the file was deleted.
    pub new: Option<String>,
    pub binary: bool,
    pub too_large: bool,
}

/// Both sides of `path` in `sha`. Highlighting a whole file and then picking
/// the diff's lines out of it keeps multi-line constructs, such as block
/// comments and strings, coloured correctly, which highlighting the hunks on
/// their own would not.
pub fn file_versions(
    repo: &Repo,
    sha: &str,
    path: &str,
    old_path: Option<&str>,
) -> Result<FileVersions> {
    check_sha(sha)?;
    let parent = repo
        .run(["rev-list", "--parents", "-n", "1", sha])?
        .split_whitespace()
        .nth(1)
        .map(str::to_string);
    let mut out = FileVersions {
        old: None,
        new: None,
        binary: false,
        too_large: false,
    };
    for (rev, p, slot) in [
        (Some(sha.to_string()), path, 0),
        (parent, old_path.unwrap_or(path), 1),
    ] {
        let Some(rev) = rev else { continue };
        match blob(repo, &rev, p)? {
            Blob::Missing => {}
            Blob::TooLarge => out.too_large = true,
            Blob::Text(t) => {
                if t[..t.len().min(8000)].contains('\0') {
                    out.binary = true;
                } else if slot == 0 {
                    out.new = Some(t);
                } else {
                    out.old = Some(t);
                }
            }
        }
    }
    if out.binary || out.too_large {
        out.old = None;
        out.new = None;
    }
    Ok(out)
}

enum Blob {
    Missing,
    TooLarge,
    Text(String),
}

fn blob(repo: &Repo, rev: &str, path: &str) -> Result<Blob> {
    let spec = format!("{rev}:{path}");
    let Some(size) = repo.try_run(["cat-file", "-s", &spec])? else {
        return Ok(Blob::Missing);
    };
    if size.trim().parse::<u64>().unwrap_or(u64::MAX) > MAX_BYTES {
        return Ok(Blob::TooLarge);
    }
    Ok(Blob::Text(repo.run(["cat-file", "blob", &spec])?))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameCommit {
    pub sha: String,
    pub author: String,
    pub email: String,
    pub time: i64,
    pub summary: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Blame {
    pub commits: Vec<BlameCommit>,
    /// For each line of the file at `sha`, an index into `commits`.
    pub lines: Vec<u32>,
}

/// Who last touched each line of `path` as of `sha`.
pub fn blame(repo: &Repo, sha: &str, path: &str) -> Result<Blame> {
    check_sha(sha)?;
    let out = repo.run(["blame", "--porcelain", sha, "--", path])?;
    Ok(parse_blame(&out))
}

fn parse_blame(out: &str) -> Blame {
    let mut b = Blame::default();
    let mut index = std::collections::HashMap::<String, u32>::new();
    let mut current: Option<u32> = None;
    for line in out.lines() {
        if let Some(_content) = line.strip_prefix('\t') {
            if let Some(c) = current {
                b.lines.push(c);
            }
            continue;
        }
        let mut words = line.splitn(2, ' ');
        let first = words.next().unwrap_or_default();
        let rest = words.next().unwrap_or_default();
        if first.len() >= 40 && first.bytes().all(|c| c.is_ascii_hexdigit()) {
            let i = *index.entry(first.to_string()).or_insert_with(|| {
                b.commits.push(BlameCommit {
                    sha: first.to_string(),
                    author: String::new(),
                    email: String::new(),
                    time: 0,
                    summary: String::new(),
                });
                (b.commits.len() - 1) as u32
            });
            current = Some(i);
            continue;
        }
        let Some(c) = current.map(|i| &mut b.commits[i as usize]) else {
            continue;
        };
        match first {
            "author" => c.author = rest.to_string(),
            "author-mail" => c.email = rest.trim_matches(|ch| ch == '<' || ch == '>').to_string(),
            "author-time" => c.time = rest.parse().unwrap_or(0),
            "summary" => c.summary = rest.to_string(),
            _ => {}
        }
    }
    b
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub sha: String,
    pub author: String,
    pub email: String,
    pub time: i64,
    pub subject: String,
    /// The file's path in this commit; differs from the current one across a
    /// rename.
    pub path: String,
    pub old_path: Option<String>,
    pub status: String,
}

/// Commits that changed `path`, newest first, starting from `sha` and
/// following renames.
pub fn history(repo: &Repo, sha: &str, path: &str, limit: usize) -> Result<Vec<HistoryEntry>> {
    check_sha(sha)?;
    let out = repo.run([
        "log",
        "--follow",
        "-M",
        "--name-status",
        &format!("--max-count={limit}"),
        &format!("--format={RS}%H{FS}%an{FS}%ae{FS}%at{FS}%s"),
        sha,
        "--",
        path,
    ])?;
    Ok(parse_history(&out, path))
}

fn parse_history(out: &str, path: &str) -> Vec<HistoryEntry> {
    out.split(RS)
        .filter_map(|rec| {
            let mut lines = rec.lines();
            let header: Vec<&str> = lines.next()?.split(FS).collect();
            if header.len() < 5 {
                return None;
            }
            // The name-status line for this file: `M\tpath` or `R087\told\tnew`.
            let ns = lines.find(|l| !l.trim().is_empty());
            let (status, old_path, file) = match ns.map(|l| l.split('\t').collect::<Vec<_>>()) {
                Some(f) if f.len() >= 3 => (
                    f[0][..1].to_string(),
                    Some(f[1].to_string()),
                    f[2].to_string(),
                ),
                Some(f) if f.len() == 2 => (f[0][..1].to_string(), None, f[1].to_string()),
                _ => ("M".to_string(), None, path.to_string()),
            };
            Some(HistoryEntry {
                sha: header[0].to_string(),
                author: header[1].to_string(),
                email: header[2].to_string(),
                time: header[3].parse().unwrap_or(0),
                subject: header[4].to_string(),
                path: file,
                old_path,
                status,
            })
        })
        .collect()
}

/// Every file in the commit's tree, for "view all files".
pub fn tree_files(repo: &Repo, sha: &str) -> Result<Vec<String>> {
    check_sha(sha)?;
    let out = repo.run(["ls-tree", "-r", "-z", "--name-only", sha])?;
    Ok(out
        .split('\0')
        .filter(|p| !p.is_empty())
        .map(str::to_string)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blame_porcelain_maps_every_line_to_its_commit() {
        let a = "a".repeat(40);
        let b = "b".repeat(40);
        let out = format!(
            "{a} 1 1 2\nauthor Erick Low\nauthor-mail <e@x>\nauthor-time 100\nsummary first\nfilename f\n\tone\n\
             {a} 2 2\n\ttwo\n\
             {b} 3 3 1\nauthor Agung\nauthor-mail <a@x>\nauthor-time 200\nsummary second\nfilename f\n\tthree\n"
        );
        let bl = parse_blame(&out);
        assert_eq!(bl.lines, vec![0, 0, 1]);
        assert_eq!(bl.commits[0].author, "Erick Low");
        assert_eq!(bl.commits[0].email, "e@x");
        assert_eq!(bl.commits[1].time, 200);
        assert_eq!(bl.commits[1].summary, "second");
    }

    #[test]
    fn history_follows_renames() {
        let rec = |sha: &str, ns: &str| format!("{RS}{sha}{FS}A{FS}a@x{FS}1{FS}msg\n\n{ns}\n");
        let out =
            rec("s2", "M\tnew.go") + &rec("s1", "R100\told.go\tnew.go") + &rec("s0", "A\told.go");
        let h = parse_history(&out, "new.go");
        assert_eq!(h.len(), 3);
        assert_eq!((h[0].status.as_str(), h[0].path.as_str()), ("M", "new.go"));
        assert_eq!(h[1].old_path.as_deref(), Some("old.go"));
        assert_eq!((h[2].status.as_str(), h[2].path.as_str()), ("A", "old.go"));
    }
}
