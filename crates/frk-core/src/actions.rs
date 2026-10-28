//! Write operations behind the graph's context menu.
//!
//! Each one is a typed action rather than a pass-through of git arguments, so
//! the UI can only ask for what is listed here. Every user-supplied name is
//! checked with `git check-ref-format` and every commit-ish is resolved to a
//! full sha before it reaches a command line, which also rules out anything
//! that git would read as an option.
//!
//! Actions touch only the refs they name. Pull fetches the one upstream branch
//! it needs rather than the whole remote, so the caller can treat every ref
//! that moved during an action as the user's own doing and mark it seen.

use serde::Deserialize;

use crate::git::{Error, Repo, Result};

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ResetMode {
    Soft,
    Mixed,
    Hard,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Action {
    /// Switch to an existing local branch.
    Checkout {
        branch: String,
    },
    /// Switch to a remote branch: its local counterpart if there is one,
    /// otherwise a new local branch tracking it.
    CheckoutRemote {
        remote_branch: String,
    },
    CheckoutDetached {
        sha: String,
    },
    CreateBranch {
        name: String,
        at: String,
        checkout: bool,
    },
    /// Moves the current branch.
    Reset {
        mode: ResetMode,
        to: String,
    },
    Revert {
        sha: String,
    },
    /// Rewords the HEAD commit, leaving its tree alone.
    Reword {
        message: String,
    },
    /// Fast-forwards a local branch to its upstream, fetching only that branch.
    Pull {
        branch: String,
    },
    /// Pushes a local branch to its upstream, or to `origin` (setting the
    /// upstream) when it has none.
    Push {
        branch: String,
    },
    SetUpstream {
        branch: String,
        upstream: String,
    },
    Rename {
        from: String,
        to: String,
    },
    DeleteLocal {
        branch: String,
        force: bool,
        /// When set, refuse unless the branch still points here. Undoing
        /// "create branch" uses it so a branch that gained commits since is
        /// never force-deleted.
        #[serde(default)]
        expect: Option<String>,
    },
    DeleteRemote {
        remote_branch: String,
    },
    Tag {
        name: String,
        at: String,
        message: Option<String>,
    },
    DeleteTag {
        name: String,
    },
    /// Stashes tracked and untracked changes.
    Stash {
        message: Option<String>,
    },
    /// Applies the newest stash and drops it.
    StashPop,
    /// Writes `git format-patch` output for one commit to `path`.
    CreatePatch {
        sha: String,
        path: String,
    },
}

/// Runs `action` and returns a one-line description of what happened.
pub fn run(repo: &Repo, action: &Action) -> Result<String> {
    match action {
        Action::Checkout { branch } => {
            local_branch(repo, branch)?;
            repo.run(["switch", "--end-of-options", branch])?;
            Ok(format!("Switched to {branch}"))
        }
        Action::CheckoutRemote { remote_branch } => {
            let (_, name) = split_remote(repo, remote_branch)?;
            if repo
                .try_run([
                    "show-ref",
                    "--verify",
                    "--quiet",
                    &format!("refs/heads/{name}"),
                ])?
                .is_some()
            {
                repo.run(["switch", "--end-of-options", &name])?;
                Ok(format!("Switched to {name}"))
            } else {
                repo.run(["switch", "-c", &name, "--track", remote_branch])?;
                Ok(format!("Created {name} tracking {remote_branch}"))
            }
        }
        Action::CheckoutDetached { sha } => {
            let sha = commit(repo, sha)?;
            repo.run(["switch", "--detach", &sha])?;
            Ok(format!("HEAD detached at {}", &sha[..7]))
        }
        Action::CreateBranch { name, at, checkout } => {
            branch_name(repo, name)?;
            let at = commit(repo, at)?;
            if *checkout {
                repo.run(["switch", "-c", name, &at])?;
            } else {
                repo.run(["branch", name, &at])?;
            }
            Ok(format!("Created {name} at {}", &at[..7]))
        }
        Action::Reset { mode, to } => {
            let to = commit(repo, to)?;
            let flag = match mode {
                ResetMode::Soft => "--soft",
                ResetMode::Mixed => "--mixed",
                ResetMode::Hard => "--hard",
            };
            repo.run(["reset", flag, &to])?;
            Ok(format!("Reset ({}) to {}", &flag[2..], &to[..7]))
        }
        Action::Revert { sha } => {
            let sha = commit(repo, sha)?;
            let parents = repo.run(["rev-list", "--parents", "-n", "1", &sha])?;
            let is_merge = parents.split_whitespace().count() > 2;
            if is_merge {
                // Revert what the merge brought in, relative to the branch it
                // was merged into.
                repo.run(["revert", "--no-edit", "-m", "1", &sha])?;
            } else {
                repo.run(["revert", "--no-edit", &sha])?;
            }
            Ok(format!("Reverted {}", &sha[..7]))
        }
        Action::Reword { message } => {
            if message.trim().is_empty() {
                return Err(invalid("the commit message is empty"));
            }
            // --only with no paths amends the message and nothing else, even
            // when there are staged changes; --allow-empty keeps rewording a
            // commit that is legitimately empty from being refused.
            repo.run_with_stdin(
                ["commit", "--amend", "--only", "--allow-empty", "--file=-"],
                message,
            )?;
            Ok("Commit message updated".into())
        }
        Action::Pull { branch } => {
            local_branch(repo, branch)?;
            let (remote, merge) = upstream_of(repo, branch)?
                .ok_or_else(|| invalid(&format!("{branch} has no upstream")))?;
            let remote_name = merge.trim_start_matches("refs/heads/");
            let tracking = format!("refs/remotes/{remote}/{remote_name}");
            repo.run(["fetch", "--quiet", &remote, &format!("{merge}:{tracking}")])?;
            if current_branch(repo)?.as_deref() == Some(branch.as_str()) {
                repo.run(["merge", "--ff-only", &tracking])?;
            } else {
                // Not checked out: update the ref directly; fetching from the
                // repository itself refuses anything but a fast-forward.
                repo.run([
                    "fetch",
                    "--quiet",
                    ".",
                    &format!("{tracking}:refs/heads/{branch}"),
                ])?;
            }
            Ok(format!(
                "{branch} is up to date with {remote}/{remote_name}"
            ))
        }
        Action::Push { branch } => {
            local_branch(repo, branch)?;
            match upstream_of(repo, branch)? {
                Some((remote, merge)) => {
                    repo.run([
                        "push",
                        "--quiet",
                        &remote,
                        &format!("refs/heads/{branch}:{merge}"),
                    ])?;
                    Ok(format!("Pushed {branch} to {remote}"))
                }
                None => {
                    let remote = default_remote(repo)?;
                    repo.run([
                        "push",
                        "--quiet",
                        "--set-upstream",
                        &remote,
                        &format!("refs/heads/{branch}"),
                    ])?;
                    Ok(format!(
                        "Pushed {branch} to {remote} and set it as upstream"
                    ))
                }
            }
        }
        Action::SetUpstream { branch, upstream } => {
            local_branch(repo, branch)?;
            split_remote(repo, upstream)?;
            repo.run(["branch", &format!("--set-upstream-to={upstream}"), branch])?;
            Ok(format!("{branch} now tracks {upstream}"))
        }
        Action::Rename { from, to } => {
            local_branch(repo, from)?;
            branch_name(repo, to)?;
            repo.run(["branch", "-m", from, to])?;
            Ok(format!("Renamed {from} to {to}"))
        }
        Action::DeleteLocal {
            branch,
            force,
            expect,
        } => {
            local_branch(repo, branch)?;
            if let Some(expect) = expect {
                let now = commit(repo, &format!("refs/heads/{branch}"))?;
                if &now != expect {
                    return Err(invalid(&format!(
                        "{branch} has moved since it was created; not deleting it"
                    )));
                }
            }
            repo.run(["branch", if *force { "-D" } else { "-d" }, branch])?;
            Ok(format!("Deleted {branch}"))
        }
        Action::DeleteRemote { remote_branch } => {
            let (remote, name) = split_remote(repo, remote_branch)?;
            repo.run([
                "push",
                "--quiet",
                &remote,
                "--delete",
                &format!("refs/heads/{name}"),
            ])?;
            Ok(format!("Deleted {remote_branch}"))
        }
        Action::Tag { name, at, message } => {
            tag_name(repo, name)?;
            let at = commit(repo, at)?;
            match message {
                Some(m) if !m.trim().is_empty() => {
                    repo.run_with_stdin(["tag", "-a", "--file=-", name, &at], m)?;
                }
                _ => {
                    repo.run(["tag", name, &at])?;
                }
            }
            Ok(format!("Tagged {} as {name}", &at[..7]))
        }
        Action::DeleteTag { name } => {
            tag_name(repo, name)?;
            repo.run(["tag", "-d", name])?;
            Ok(format!("Deleted tag {name}"))
        }
        Action::Stash { message } => {
            let mut args = vec!["stash", "push", "--include-untracked"];
            if let Some(m) = message.as_deref().filter(|m| !m.trim().is_empty()) {
                args.extend(["-m", m]);
            }
            let out = repo.run(args)?;
            if out.contains("No local changes to save") {
                return Err(invalid("there are no local changes to stash"));
            }
            Ok("Stashed local changes".into())
        }
        Action::StashPop => {
            repo.run(["stash", "pop"])?;
            Ok("Applied and dropped the latest stash".into())
        }
        Action::CreatePatch { sha, path } => {
            let sha = commit(repo, sha)?;
            let patch = repo.run(["format-patch", "-1", "--stdout", &sha])?;
            std::fs::write(path, patch)?;
            Ok(format!("Saved patch for {}", &sha[..7]))
        }
    }
}

fn invalid(msg: &str) -> Error {
    Error::Git {
        args: "(frk)".into(),
        stderr: msg.to_string(),
    }
}

fn not_an_option(s: &str) -> Result<()> {
    if s.is_empty() || s.starts_with('-') {
        return Err(invalid(&format!("invalid name: {s:?}")));
    }
    Ok(())
}

/// Resolves a commit-ish to a full sha.
fn commit(repo: &Repo, rev: &str) -> Result<String> {
    not_an_option(rev)?;
    repo.try_run([
        "rev-parse",
        "--verify",
        "--quiet",
        &format!("{rev}^{{commit}}"),
    ])?
    .map(|s| s.trim().to_string())
    .ok_or_else(|| invalid(&format!("no such commit: {rev}")))
}

fn branch_name(repo: &Repo, name: &str) -> Result<()> {
    not_an_option(name)?;
    repo.try_run(["check-ref-format", "--branch", name])?
        .map(|_| ())
        .ok_or_else(|| invalid(&format!("not a valid branch name: {name:?}")))
}

fn tag_name(repo: &Repo, name: &str) -> Result<()> {
    not_an_option(name)?;
    repo.try_run(["check-ref-format", &format!("refs/tags/{name}")])?
        .map(|_| ())
        .ok_or_else(|| invalid(&format!("not a valid tag name: {name:?}")))
}

fn local_branch(repo: &Repo, name: &str) -> Result<()> {
    not_an_option(name)?;
    repo.try_run([
        "show-ref",
        "--verify",
        "--quiet",
        &format!("refs/heads/{name}"),
    ])?
    .map(|_| ())
    .ok_or_else(|| invalid(&format!("no local branch {name}")))
}

fn current_branch(repo: &Repo) -> Result<Option<String>> {
    Ok(repo
        .try_run(["symbolic-ref", "-q", "--short", "HEAD"])?
        .map(|s| s.trim().to_string()))
}

/// `(remote, merge ref)` from the branch's config, e.g. `("origin", "refs/heads/main")`.
fn upstream_of(repo: &Repo, branch: &str) -> Result<Option<(String, String)>> {
    let get = |key: &str| -> Result<Option<String>> {
        Ok(repo
            .try_run(["config", "--get", &format!("branch.{branch}.{key}")])?
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()))
    };
    match (get("remote")?, get("merge")?) {
        // A remote of "." means the upstream is another local branch.
        (Some(r), Some(m)) if r != "." => Ok(Some((r, m))),
        _ => Ok(None),
    }
}

fn remotes(repo: &Repo) -> Result<Vec<String>> {
    Ok(repo.run(["remote"])?.lines().map(str::to_string).collect())
}

fn default_remote(repo: &Repo) -> Result<String> {
    let all = remotes(repo)?;
    all.iter()
        .find(|r| *r == "origin")
        .or(all.first())
        .cloned()
        .ok_or_else(|| invalid("this repository has no remote"))
}

/// Splits `origin/feat/x` into `("origin", "feat/x")`, matching the longest
/// configured remote name so a remote called `a/b` still works.
fn split_remote(repo: &Repo, remote_branch: &str) -> Result<(String, String)> {
    not_an_option(remote_branch)?;
    let mut all = remotes(repo)?;
    all.sort_by_key(|r| std::cmp::Reverse(r.len()));
    all.into_iter()
        .find_map(|r| {
            remote_branch
                .strip_prefix(&format!("{r}/"))
                .filter(|b| !b.is_empty())
                .map(|b| (r.clone(), b.to_string()))
        })
        .ok_or_else(|| invalid(&format!("not a remote branch: {remote_branch}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    /// A throwaway repository with one remote, for exercising real git.
    fn scratch() -> (tempdir::Dir, Repo) {
        let dir = tempdir::Dir::new();
        let git = |args: &[&str]| {
            let ok = Command::new("git")
                .arg("-C")
                .arg(dir.path())
                .args([
                    "-c",
                    "user.name=t",
                    "-c",
                    "user.email=t@t",
                    "-c",
                    "commit.gpgsign=false",
                ])
                .args(args)
                .output()
                .unwrap();
            assert!(
                ok.status.success(),
                "{args:?}: {}",
                String::from_utf8_lossy(&ok.stderr)
            );
        };
        git(&["init", "-q", "-b", "main"]);
        git(&["config", "user.name", "t"]);
        git(&["config", "user.email", "t@t"]);
        git(&["config", "commit.gpgsign", "false"]);
        git(&["config", "tag.gpgsign", "false"]);
        for msg in ["one", "two"] {
            std::fs::write(dir.path().join("f"), msg).unwrap();
            git(&["add", "f"]);
            git(&["commit", "-q", "-m", msg]);
        }
        git(&["remote", "add", "origin", "https://example.invalid/r.git"]);
        let repo = Repo::open(dir.path()).unwrap();
        (dir, repo)
    }

    mod tempdir {
        use std::path::{Path, PathBuf};
        use std::sync::atomic::{AtomicUsize, Ordering};

        pub struct Dir(PathBuf);

        impl Dir {
            pub fn new() -> Self {
                // Tests run in parallel within one process, so the pid alone
                // is not unique; a counter is.
                static NEXT: AtomicUsize = AtomicUsize::new(0);
                let p = std::env::temp_dir().join(format!(
                    "frk-test-{}-{}",
                    std::process::id(),
                    NEXT.fetch_add(1, Ordering::Relaxed)
                ));
                let _ = std::fs::remove_dir_all(&p);
                std::fs::create_dir_all(&p).unwrap();
                Self(p)
            }
            pub fn path(&self) -> &Path {
                &self.0
            }
        }

        impl Drop for Dir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }

    fn run_ok(repo: &Repo, a: Action) -> String {
        run(repo, &a).unwrap_or_else(|e| panic!("{a:?}: {e}"))
    }

    #[test]
    fn option_like_and_invalid_names_are_rejected() {
        let (_d, repo) = scratch();
        for name in ["-D", "--force", "a..b", "x y", ""] {
            let r = run(
                &repo,
                &Action::CreateBranch {
                    name: name.into(),
                    at: "HEAD".into(),
                    checkout: false,
                },
            );
            assert!(r.is_err(), "{name:?} should be rejected");
        }
        assert!(
            run(
                &repo,
                &Action::CheckoutDetached {
                    sha: "--orphan".into()
                }
            )
            .is_err()
        );
    }

    #[test]
    fn branch_lifecycle() {
        let (_d, repo) = scratch();
        run_ok(
            &repo,
            Action::CreateBranch {
                name: "feat/x".into(),
                at: "HEAD~1".into(),
                checkout: false,
            },
        );
        run_ok(
            &repo,
            Action::Rename {
                from: "feat/x".into(),
                to: "feat/y".into(),
            },
        );
        run_ok(
            &repo,
            Action::Checkout {
                branch: "feat/y".into(),
            },
        );
        assert_eq!(current_branch(&repo).unwrap().as_deref(), Some("feat/y"));
        run_ok(
            &repo,
            Action::Checkout {
                branch: "main".into(),
            },
        );
        run_ok(
            &repo,
            Action::DeleteLocal {
                branch: "feat/y".into(),
                force: false,
                expect: None,
            },
        );
        assert!(local_branch(&repo, "feat/y").is_err());
    }

    #[test]
    fn reword_reset_revert_and_tag() {
        let (_d, repo) = scratch();
        run_ok(
            &repo,
            Action::Reword {
                message: "two, reworded\n\nbody".into(),
            },
        );
        assert_eq!(
            repo.run(["log", "-1", "--format=%s"]).unwrap().trim(),
            "two, reworded"
        );
        run_ok(&repo, Action::Revert { sha: "HEAD".into() });
        assert!(
            repo.run(["log", "-1", "--format=%s"])
                .unwrap()
                .starts_with("Revert")
        );
        run_ok(
            &repo,
            Action::Reset {
                mode: ResetMode::Hard,
                to: "HEAD~1".into(),
            },
        );
        assert_eq!(
            repo.run(["log", "-1", "--format=%s"]).unwrap().trim(),
            "two, reworded"
        );
        run_ok(
            &repo,
            Action::Tag {
                name: "v1".into(),
                at: "HEAD".into(),
                message: Some("release".into()),
            },
        );
        assert_eq!(repo.run(["cat-file", "-t", "v1"]).unwrap().trim(), "tag");
    }

    #[test]
    fn stash_round_trip_and_guarded_delete() {
        let (d, repo) = scratch();
        assert!(run(&repo, &Action::Stash { message: None }).is_err());
        std::fs::write(d.path().join("f"), "dirty").unwrap();
        run_ok(
            &repo,
            Action::Stash {
                message: Some("wip".into()),
            },
        );
        assert_eq!(std::fs::read_to_string(d.path().join("f")).unwrap(), "two");
        run_ok(&repo, Action::StashPop);
        assert_eq!(
            std::fs::read_to_string(d.path().join("f")).unwrap(),
            "dirty"
        );

        let head = commit(&repo, "HEAD").unwrap();
        let older = commit(&repo, "HEAD~1").unwrap();
        run_ok(
            &repo,
            Action::CreateBranch {
                name: "x".into(),
                at: older.clone(),
                checkout: false,
            },
        );
        let guarded = Action::DeleteLocal {
            branch: "x".into(),
            force: true,
            expect: Some(head),
        };
        assert!(
            run(&repo, &guarded).is_err(),
            "moved branch must not be deleted"
        );
        run_ok(
            &repo,
            Action::DeleteLocal {
                branch: "x".into(),
                force: true,
                expect: Some(older),
            },
        );

        run_ok(
            &repo,
            Action::Tag {
                name: "t1".into(),
                at: "HEAD".into(),
                message: None,
            },
        );
        run_ok(&repo, Action::DeleteTag { name: "t1".into() });
    }

    #[test]
    fn split_remote_and_upstream() {
        let (_d, repo) = scratch();
        assert_eq!(
            split_remote(&repo, "origin/feat/x").unwrap(),
            ("origin".to_string(), "feat/x".to_string())
        );
        assert!(split_remote(&repo, "upstream/x").is_err());
        assert!(upstream_of(&repo, "main").unwrap().is_none());
        assert!(
            run(
                &repo,
                &Action::Pull {
                    branch: "main".into()
                }
            )
            .is_err()
        );
    }
}
