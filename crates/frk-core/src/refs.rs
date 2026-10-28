use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::git::{FS, Repo, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RefKind {
    Local,
    Remote,
    Tag,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefInfo {
    /// Full name, e.g. `refs/remotes/origin/main`. The identity used everywhere.
    pub name: String,
    /// Display name, e.g. `origin/main`.
    pub short: String,
    pub kind: RefKind,
    /// The commit the ref points at; annotated tags are peeled.
    pub sha: String,
    /// Committer time of the tip, unix seconds. This is what "active" means.
    pub time: i64,
    pub author: String,
    pub email: String,
    pub subject: String,
    pub upstream: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Head {
    /// Short branch name, or `None` when HEAD is detached.
    pub branch: Option<String>,
    /// `None` on an unborn branch.
    pub sha: Option<String>,
}

const REF_FORMAT: &str = "%(refname)%1f%(refname:short)%1f%(objectname)%1f%(*objectname)%1f\
%(committerdate:unix)%1f%(*committerdate:unix)%1f%(authorname)%1f%(*authorname)%1f\
%(authoremail:trim)%1f%(*authoremail:trim)%1f%(subject)%1f%(*subject)%1f%(symref)%1f%(upstream:short)";

/// Lists local branches, remote-tracking branches and tags, newest tip first.
/// Symbolic refs such as `refs/remotes/origin/HEAD` are skipped: they only
/// duplicate the branch they point at.
pub fn list_refs(repo: &Repo) -> Result<Vec<RefInfo>> {
    let out = repo.run([
        "for-each-ref",
        "--sort=-committerdate",
        &format!("--format={REF_FORMAT}"),
        "refs/heads",
        "refs/remotes",
        "refs/tags",
    ])?;
    Ok(out.lines().filter_map(parse_ref_line).collect())
}

fn parse_ref_line(line: &str) -> Option<RefInfo> {
    let f: Vec<&str> = line.split(FS).collect();
    if f.len() < 14 || !f[12].is_empty() {
        return None;
    }
    let name = f[0].to_string();
    let kind = if name.starts_with("refs/heads/") {
        RefKind::Local
    } else if name.starts_with("refs/remotes/") {
        RefKind::Remote
    } else {
        RefKind::Tag
    };
    // For an annotated tag the plain fields describe the tag object and the `*`
    // fields describe the commit it points at; for everything else only the
    // plain fields are set. Prefer the commit.
    let pick =
        |peeled: &str, plain: &str| if peeled.is_empty() { plain } else { peeled }.to_string();
    Some(RefInfo {
        short: f[1].to_string(),
        kind,
        sha: pick(f[3], f[2]),
        time: pick(f[5], f[4]).parse().unwrap_or(0),
        author: pick(f[7], f[6]),
        email: pick(f[9], f[8]),
        subject: pick(f[11], f[10]),
        upstream: (!f[13].is_empty()).then(|| f[13].to_string()),
        name,
    })
}

pub fn head(repo: &Repo) -> Result<Head> {
    let branch = repo
        .try_run(["symbolic-ref", "-q", "--short", "HEAD"])?
        .map(|s| s.trim().to_string());
    let sha = repo
        .try_run(["rev-parse", "-q", "--verify", "HEAD"])?
        .map(|s| s.trim().to_string());
    Ok(Head { branch, sha })
}

/// The branch everyone integrates into, as a full ref name: whatever
/// `origin/HEAD` points at, else the usual suspects, else the first remote's
/// `main`/`master`, else the local ones.
pub fn default_target(repo: &Repo, refs: &[RefInfo]) -> Result<Option<String>> {
    if let Some(s) = repo.try_run(["symbolic-ref", "-q", "refs/remotes/origin/HEAD"])? {
        let s = s.trim();
        if refs.iter().any(|r| r.name == s) {
            return Ok(Some(s.to_string()));
        }
    }
    let exists = |n: &str| refs.iter().any(|r| r.name == n);
    let remote_default = refs
        .iter()
        .filter(|r| r.kind == RefKind::Remote)
        .find(|r| r.short.ends_with("/main") || r.short.ends_with("/master"))
        .map(|r| r.name.clone());
    Ok(["refs/remotes/origin/main", "refs/remotes/origin/master"]
        .into_iter()
        .find(|n| exists(n))
        .map(str::to_string)
        .or(remote_default)
        .or_else(|| {
            ["refs/heads/main", "refs/heads/master"]
                .into_iter()
                .find(|n| exists(n))
                .map(str::to_string)
        }))
}

/// Branch refs whose tip is already reachable from `target`, i.e. work that has
/// landed. These are the bulk of a long-lived repository's branch list and
/// almost never what you want to see as a lane.
pub fn merged_into(repo: &Repo, target: &str) -> Result<HashSet<String>> {
    let out = repo.run([
        "for-each-ref",
        &format!("--merged={target}"),
        "--format=%(refname)",
        "refs/heads",
        "refs/remotes",
    ])?;
    Ok(out.lines().map(str::to_string).collect())
}

/// Uncommitted changes and stashes, for enabling Stash and Pop.
#[derive(Debug, Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkStatus {
    /// Changed, staged or untracked paths.
    pub dirty: u32,
    pub stashes: u32,
}

pub fn work_status(repo: &Repo) -> Result<WorkStatus> {
    let dirty = repo
        .run(["status", "--porcelain", "--untracked-files=normal"])?
        .lines()
        .count() as u32;
    let stashes = repo
        .try_run(["stash", "list"])?
        .map_or(0, |s| s.lines().count() as u32);
    Ok(WorkStatus { dirty, stashes })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Remote {
    pub name: String,
    pub url: String,
    /// Browser URL of the repository, e.g. `https://github.com/o/r`, when the
    /// URL is one we know how to translate.
    pub web: Option<String>,
    /// `github`, `gitlab`, `bitbucket` or `other`: decides how links to a
    /// branch, a commit or a new pull request are built.
    pub host: &'static str,
}

pub fn remotes(repo: &Repo) -> Result<Vec<Remote>> {
    let out = repo.run(["remote", "-v"])?;
    let mut seen = HashSet::new();
    Ok(out
        .lines()
        .filter(|l| l.ends_with("(fetch)"))
        .filter_map(|l| {
            let mut parts = l.split_whitespace();
            let (name, url) = (parts.next()?, parts.next()?);
            seen.insert(name.to_string()).then(|| {
                let web = web_url(url, ssh_hostname);
                let host = match web.as_deref() {
                    Some(w) if w.contains("github") => "github",
                    Some(w) if w.contains("gitlab") => "gitlab",
                    Some(w) if w.contains("bitbucket") => "bitbucket",
                    _ => "other",
                };
                Remote {
                    name: name.to_string(),
                    url: url.to_string(),
                    web,
                    host,
                }
            })
        })
        .collect())
}

/// `git@github.com:o/r.git`, `ssh://git@github.com/o/r`, `https://github.com/o/r.git`
/// all become `https://github.com/o/r`. An SSH host goes through `resolve`
/// first, so a `~/.ssh/config` alias such as `github-work` becomes the
/// `github.com` it stands for.
fn web_url(url: &str, resolve: impl Fn(&str) -> Option<String>) -> Option<String> {
    let (rest, ssh) = if let Some(r) = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
    {
        (r.to_string(), false)
    } else if let Some(r) = url.strip_prefix("ssh://") {
        (r.to_string(), true)
    } else if let Some((user_host, path)) = url.split_once(':') {
        if user_host.contains('/') || path.starts_with("//") {
            return None;
        }
        (format!("{user_host}/{path}"), true)
    } else {
        return None;
    };
    // Drop credentials or the ssh user, and an ssh port.
    let rest = rest.rsplit_once('@').map_or(rest.as_str(), |(_, r)| r);
    let (host, path) = rest.split_once('/')?;
    let host = host.split(':').next()?;
    let resolved = if ssh { resolve(host) } else { None };
    let host = resolved.as_deref().unwrap_or(host);
    let path = path.trim_end_matches('/').trim_end_matches(".git");
    (!host.is_empty() && !path.is_empty()).then(|| format!("https://{host}/{path}"))
}

/// The real host behind an SSH alias, as `ssh -G` computes it from the user's
/// config. Reads local config only; nothing is contacted.
fn ssh_hostname(alias: &str) -> Option<String> {
    if alias.starts_with('-') {
        return None;
    }
    let mut cmd = std::process::Command::new("ssh");
    cmd.args(["-G", alias]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .find_map(|l| l.strip_prefix("hostname "))
        .map(|h| h.trim().to_string())
        .filter(|h| !h.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(fields: [&str; 14]) -> String {
        fields.join(&FS.to_string())
    }

    #[test]
    fn annotated_tag_is_peeled_to_its_commit() {
        let l = line([
            "refs/tags/v1",
            "v1",
            "tagobj",
            "commit1",
            "",
            "1700000000",
            "",
            "Erick",
            "",
            "e@x",
            "tag msg",
            "commit msg",
            "",
            "",
        ]);
        let r = parse_ref_line(&l).unwrap();
        assert_eq!(r.kind, RefKind::Tag);
        assert_eq!(r.sha, "commit1");
        assert_eq!(r.time, 1_700_000_000);
        assert_eq!(r.subject, "commit msg");
    }

    #[test]
    fn remote_urls_become_web_urls() {
        for url in [
            "git@github.com:cekataiofficial/cekat-data-platform.git",
            "ssh://git@github.com/cekataiofficial/cekat-data-platform",
            "https://github.com/cekataiofficial/cekat-data-platform.git",
            "https://user:token@github.com/cekataiofficial/cekat-data-platform/",
            "ssh://git@github.com:22/cekataiofficial/cekat-data-platform.git",
        ] {
            assert_eq!(
                web_url(url, |_| None).as_deref(),
                Some("https://github.com/cekataiofficial/cekat-data-platform"),
                "{url}"
            );
        }
        assert_eq!(web_url("/srv/git/repo.git", |_| None), None);
        assert_eq!(web_url("file:///srv/git/repo", |_| None), None);
        // An SSH alias resolves; an https host is never looked up.
        let alias = |h: &str| (h == "github-work").then(|| "github.com".to_string());
        assert_eq!(
            web_url("git@github-work:o/r.git", alias).as_deref(),
            Some("https://github.com/o/r")
        );
        assert_eq!(
            web_url("https://github-work/o/r", alias).as_deref(),
            Some("https://github-work/o/r")
        );
    }

    #[test]
    fn symref_is_skipped() {
        let l = line([
            "refs/remotes/origin/HEAD",
            "origin",
            "abc",
            "",
            "1",
            "",
            "a",
            "",
            "e",
            "",
            "s",
            "",
            "refs/remotes/origin/main",
            "",
        ]);
        assert!(parse_ref_line(&l).is_none());
    }
}
