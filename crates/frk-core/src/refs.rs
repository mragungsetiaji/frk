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
