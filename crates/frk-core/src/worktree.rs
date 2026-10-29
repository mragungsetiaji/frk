//! The working tree: what is staged and unstaged, staging and discarding, and
//! diffs of uncommitted changes. Backs the WIP row and the commit panel.
//!
//! Staging changes no ref, so none of this goes through `actions` and its full
//! reload; the commit itself does, because it moves HEAD.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::file::FileVersions;
use crate::git::{Error, Repo, Result};

/// Pseudo-sha of the WIP row in the graph: the working tree, drawn as a child
/// of HEAD. Never passed to git.
pub const WIP: &str = "WORKING";

const MAX_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WipFile {
    pub path: String,
    /// Set for a staged rename.
    pub old_path: Option<String>,
    /// A, M, D, R, T, or U for a conflict.
    pub status: String,
    /// Not known to git yet; only ever unstaged.
    pub untracked: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkTree {
    pub branch: Option<String>,
    pub unstaged: Vec<WipFile>,
    pub staged: Vec<WipFile>,
    pub conflicted: Vec<String>,
}

impl WorkTree {
    pub fn is_clean(&self) -> bool {
        self.unstaged.is_empty() && self.staged.is_empty() && self.conflicted.is_empty()
    }
}

pub fn status(repo: &Repo) -> Result<WorkTree> {
    let out = repo.run([
        "status",
        "--porcelain=v2",
        "-z",
        "--branch",
        "--untracked-files=all",
    ])?;
    Ok(parse_status(&out))
}

/// `--porcelain=v2 -z`: one record per NUL, except a rename (`2 ...`), whose
/// original path follows as the next record.
fn parse_status(out: &str) -> WorkTree {
    let mut wt = WorkTree::default();
    let mut records = out.split('\0').filter(|r| !r.is_empty());
    while let Some(rec) = records.next() {
        let kind = rec.as_bytes()[0];
        match kind {
            b'#' => {
                if let Some(b) = rec.strip_prefix("# branch.head ") {
                    wt.branch = (b != "(detached)").then(|| b.to_string());
                }
            }
            b'?' => wt.unstaged.push(WipFile {
                path: rec[2..].to_string(),
                old_path: None,
                status: "A".into(),
                untracked: true,
            }),
            b'1' | b'2' => {
                // "1 XY sub mH mI mW hH hI path" and
                // "2 XY sub mH mI mW hH hI Xscore path" + original path.
                let fields = if kind == b'1' { 8 } else { 9 };
                let parts: Vec<&str> = rec.splitn(fields + 1, ' ').collect();
                if parts.len() <= fields {
                    continue;
                }
                let xy = parts[1].as_bytes();
                let path = parts[fields].to_string();
                let old_path = if kind == b'2' {
                    records.next().map(str::to_string)
                } else {
                    None
                };
                if xy[0] != b'.' {
                    wt.staged.push(WipFile {
                        path: path.clone(),
                        old_path: old_path.clone(),
                        status: (xy[0] as char).to_string(),
                        untracked: false,
                    });
                }
                if xy[1] != b'.' {
                    wt.unstaged.push(WipFile {
                        path,
                        // The worktree side of a staged rename is just the new path.
                        old_path: None,
                        status: (xy[1] as char).to_string(),
                        untracked: false,
                    });
                }
            }
            b'u' => {
                // "u XY sub m1 m2 m3 mW h1 h2 h3 path"
                if let Some(path) = rec.splitn(11, ' ').nth(10) {
                    wt.conflicted.push(path.to_string());
                }
            }
            _ => {}
        }
    }
    wt
}

fn has_head(repo: &Repo) -> Result<bool> {
    Ok(repo
        .try_run(["rev-parse", "-q", "--verify", "HEAD"])?
        .is_some())
}

/// Paths go through stdin, NUL-separated, so neither the number of files nor
/// a name that looks like an option can affect the command line.
fn with_paths(repo: &Repo, args: &[&str], paths: &[String]) -> Result<()> {
    if paths.is_empty() {
        return Ok(());
    }
    let mut full: Vec<&str> = args.to_vec();
    full.extend(["--pathspec-from-file=-", "--pathspec-file-nul"]);
    repo.run_with_stdin(full, &(paths.join("\0") + "\0"))?;
    Ok(())
}

pub fn stage(repo: &Repo, paths: &[String]) -> Result<()> {
    with_paths(repo, &["add", "-A"], paths)
}

pub fn stage_all(repo: &Repo) -> Result<()> {
    repo.run(["add", "-A"])?;
    Ok(())
}

pub fn unstage(repo: &Repo, paths: &[String]) -> Result<()> {
    if has_head(repo)? {
        with_paths(repo, &["restore", "--staged"], paths)
    } else {
        // Before the first commit there is nothing to restore from.
        with_paths(repo, &["rm", "--cached", "-r", "-q"], paths)
    }
}

pub fn unstage_all(repo: &Repo) -> Result<()> {
    if has_head(repo)? {
        repo.run(["reset", "-q"])?;
    } else {
        repo.run(["rm", "--cached", "-r", "-q", "."])?;
    }
    Ok(())
}

/// Throws away unstaged changes to these files: tracked files go back to what
/// is staged, untracked files are deleted. Staged changes are kept.
pub fn discard(repo: &Repo, files: &[WipFile]) -> Result<()> {
    let tracked: Vec<String> = files
        .iter()
        .filter(|f| !f.untracked)
        .map(|f| f.path.clone())
        .collect();
    let untracked: Vec<String> = files
        .iter()
        .filter(|f| f.untracked)
        .map(|f| f.path.clone())
        .collect();
    with_paths(repo, &["restore", "--worktree"], &tracked)?;
    // `git clean` takes no pathspec file, and status lists untracked files
    // one by one anyway, so remove them directly.
    let root = repo.root().canonicalize()?;
    for path in untracked {
        let full = repo.root().join(&path);
        let inside = full
            .parent()
            .and_then(|p| p.canonicalize().ok())
            .is_some_and(|p| p.starts_with(&root));
        if inside && full.symlink_metadata().is_ok_and(|m| !m.is_dir()) {
            std::fs::remove_file(&full)?;
        }
    }
    Ok(())
}

/// Every uncommitted change, staged or not, and every untracked file. Ignored
/// files are left alone.
pub fn discard_all(repo: &Repo) -> Result<()> {
    if has_head(repo)? {
        repo.run(["reset", "--hard", "-q", "HEAD"])?;
    } else {
        repo.run(["rm", "--cached", "-r", "-q", "--ignore-unmatch", "."])?;
    }
    repo.run(["clean", "-f", "-d", "-q"])?;
    Ok(())
}

/// Unified diff of one uncommitted file: index against working tree when
/// unstaged, HEAD against index when staged.
pub fn file_diff(
    repo: &Repo,
    f: &WipFile,
    staged: bool,
    ignore_whitespace: bool,
) -> Result<String> {
    if f.untracked {
        // `--no-index` exits 1 when the files differ, which they always do here.
        let null = if cfg!(windows) { "NUL" } else { "/dev/null" };
        let mut args = vec!["diff", "--no-index", "--no-color"];
        if ignore_whitespace {
            args.push("-w");
        }
        args.extend(["--", null, f.path.as_str()]);
        return repo.run_allowing(args, &[0, 1]);
    }
    let mut args = vec!["diff", "-M", "--no-color"];
    if staged {
        args.push("--cached");
    }
    if ignore_whitespace {
        args.push("-w");
    }
    args.push("--");
    if let Some(old) = &f.old_path {
        args.push(old);
    }
    args.push(&f.path);
    repo.run(args)
}

/// Both sides of an uncommitted file, for highlighting.
pub fn file_versions(repo: &Repo, f: &WipFile, staged: bool) -> Result<FileVersions> {
    let old_path = f.old_path.as_deref().unwrap_or(&f.path);
    let mut v = FileVersions {
        old: None,
        new: None,
        binary: false,
        too_large: false,
    };
    let (old, new) = if staged {
        (
            blob(repo, &format!("HEAD:{old_path}"))?,
            blob(repo, &format!(":{}", f.path))?,
        )
    } else {
        let old = if f.untracked {
            Content::Missing
        } else {
            blob(repo, &format!(":{}", f.path))?
        };
        (old, worktree_file(repo.root(), &f.path)?)
    };
    for (content, slot) in [(old, &mut v.old), (new, &mut v.new)] {
        match content {
            Content::Missing => {}
            Content::TooLarge => v.too_large = true,
            Content::Text(t) if t[..t.len().min(8000)].contains('\0') => v.binary = true,
            Content::Text(t) => *slot = Some(t),
        }
    }
    if v.binary || v.too_large {
        v.old = None;
        v.new = None;
    }
    Ok(v)
}

enum Content {
    Missing,
    TooLarge,
    Text(String),
}

fn blob(repo: &Repo, spec: &str) -> Result<Content> {
    let Some(size) = repo.try_run(["cat-file", "-s", spec])? else {
        return Ok(Content::Missing);
    };
    if size.trim().parse::<u64>().unwrap_or(u64::MAX) > MAX_BYTES {
        return Ok(Content::TooLarge);
    }
    Ok(Content::Text(repo.run(["cat-file", "blob", spec])?))
}

fn worktree_file(root: &Path, path: &str) -> Result<Content> {
    let full = root.join(path);
    // Never read outside the repository, whatever the path says.
    let inside = full
        .canonicalize()
        .ok()
        .zip(root.canonicalize().ok())
        .is_some_and(|(f, r)| f.starts_with(r));
    if !inside {
        return Ok(Content::Missing);
    }
    let Ok(meta) = std::fs::metadata(&full) else {
        return Ok(Content::Missing);
    };
    if !meta.is_file() {
        return Ok(Content::Missing);
    }
    if meta.len() > MAX_BYTES {
        return Ok(Content::TooLarge);
    }
    let bytes = std::fs::read(&full).map_err(Error::Io)?;
    Ok(Content::Text(String::from_utf8_lossy(&bytes).into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn porcelain_v2_splits_staged_unstaged_untracked_and_renames() {
        let out = [
            "# branch.oid abc",
            "# branch.head main",
            "1 .M N... 100644 100644 100644 h1 h2 src/a.rs",
            "1 MM N... 100644 100644 100644 h1 h2 src/both.rs",
            "1 A. N... 000000 100644 100644 h0 h2 new file.txt",
            "2 R. N... 100644 100644 100644 h1 h2 R100 src/new.rs",
            "src/old.rs",
            "u UU N... 100644 100644 100644 100644 h1 h2 h3 conflict.rs",
            "? notes.md",
        ]
        .join("\0")
            + "\0";
        let wt = parse_status(&out);
        assert_eq!(wt.branch.as_deref(), Some("main"));
        let paths = |v: &[WipFile]| {
            v.iter()
                .map(|f| (f.status.clone(), f.path.clone()))
                .collect::<Vec<_>>()
        };
        assert_eq!(
            paths(&wt.unstaged),
            vec![
                ("M".into(), "src/a.rs".into()),
                ("M".into(), "src/both.rs".into()),
                ("A".into(), "notes.md".into()),
            ]
        );
        assert_eq!(
            paths(&wt.staged),
            vec![
                ("M".into(), "src/both.rs".into()),
                ("A".into(), "new file.txt".into()),
                ("R".into(), "src/new.rs".into()),
            ]
        );
        assert_eq!(wt.staged[2].old_path.as_deref(), Some("src/old.rs"));
        assert!(wt.unstaged[2].untracked);
        assert_eq!(wt.conflicted, vec!["conflict.rs"]);
    }

    #[test]
    fn detached_head_has_no_branch() {
        let wt = parse_status("# branch.head (detached)\0");
        assert_eq!(wt.branch, None);
        assert!(wt.is_clean());
    }
}
