//! "What changed since I last looked": a per-repository record of which commit
//! each branch pointed at when the user last acknowledged it, and the diff of
//! the current refs against that record.
//!
//! The snapshot only moves when the user marks something as seen. A fetch alone
//! never advances it, so a branch someone pushed while you were away stays
//! flagged until you have actually looked at it.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::git::{Repo, Result};
use crate::refs::{RefInfo, RefKind};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Snapshot {
    /// Full ref name to the sha it pointed at when last seen.
    pub seen: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RefChange {
    /// A branch that did not exist when you last looked.
    #[serde(rename_all = "camelCase")]
    Added {
        name: String,
        sha: String,
        /// Commits on the branch that are not on the integration target yet.
        commits: u32,
        authors: Vec<String>,
    },
    /// A branch that moved. `commits` counts what arrived since `from`; it is 0
    /// when the old tip is no longer reachable, i.e. after a force-push.
    #[serde(rename_all = "camelCase")]
    Updated {
        name: String,
        from: String,
        to: String,
        commits: u32,
        authors: Vec<String>,
        forced: bool,
    },
    #[serde(rename_all = "camelCase")]
    Removed { name: String, sha: String },
}

impl RefChange {
    pub fn name(&self) -> &str {
        match self {
            Self::Added { name, .. } | Self::Updated { name, .. } | Self::Removed { name, .. } => {
                name
            }
        }
    }
}

impl Snapshot {
    pub fn load(path: &Path) -> Option<Self> {
        let bytes = std::fs::read(path).ok()?;
        serde_json::from_slice(&bytes).ok()
    }

    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(self)?)?;
        std::fs::rename(tmp, path)
    }

    /// A snapshot of the branches as they are now. Tags are not tracked: they
    /// are releases, not work in progress.
    pub fn of(refs: &[RefInfo]) -> Self {
        Self {
            seen: tracked(refs)
                .map(|r| (r.name.clone(), r.sha.clone()))
                .collect(),
        }
    }

    /// Marks the given refs as seen at their current tip. A name that no longer
    /// exists is dropped, which is how a `Removed` change is acknowledged.
    pub fn acknowledge(&mut self, refs: &[RefInfo], names: &[String]) {
        for name in names {
            match tracked(refs).find(|r| &r.name == name) {
                Some(r) => {
                    self.seen.insert(r.name.clone(), r.sha.clone());
                }
                None => {
                    self.seen.remove(name);
                }
            }
        }
    }
}

fn tracked(refs: &[RefInfo]) -> impl Iterator<Item = &RefInfo> {
    refs.iter().filter(|r| r.kind != RefKind::Tag)
}

/// Compares the current refs against `snap`, without touching git. Counts and
/// authors are left empty; `enrich` fills them in.
pub fn diff(snap: &Snapshot, refs: &[RefInfo]) -> Vec<RefChange> {
    let mut out = Vec::new();
    let mut present = BTreeSet::new();
    for r in tracked(refs) {
        present.insert(r.name.as_str());
        match snap.seen.get(&r.name) {
            None => out.push(RefChange::Added {
                name: r.name.clone(),
                sha: r.sha.clone(),
                commits: 0,
                authors: Vec::new(),
            }),
            Some(old) if old != &r.sha => out.push(RefChange::Updated {
                name: r.name.clone(),
                from: old.clone(),
                to: r.sha.clone(),
                commits: 0,
                authors: Vec::new(),
                forced: false,
            }),
            Some(_) => {}
        }
    }
    for (name, sha) in &snap.seen {
        if !present.contains(name.as_str()) {
            out.push(RefChange::Removed {
                name: name.clone(),
                sha: sha.clone(),
            });
        }
    }
    out
}

/// Fills in commit counts and authors for each change. `target` is the full
/// name of the integration branch, used to size a brand-new branch.
pub fn enrich(repo: &Repo, changes: &mut [RefChange], target: Option<&str>) -> Result<()> {
    for change in changes {
        match change {
            RefChange::Added {
                sha,
                commits,
                authors,
                ..
            } => {
                let range = match target {
                    Some(t) => format!("{t}..{sha}"),
                    None => sha.clone(),
                };
                (*commits, *authors) = range_authors(repo, &range)?;
            }
            RefChange::Updated {
                from,
                to,
                commits,
                authors,
                forced,
                ..
            } => {
                // `from` may be gone entirely after a force-push and a gc, or
                // simply no longer an ancestor of `to`.
                let is_ancestor = repo
                    .try_run(["merge-base", "--is-ancestor", from.as_str(), to.as_str()])?
                    .is_some();
                *forced = !is_ancestor;
                if is_ancestor {
                    (*commits, *authors) = range_authors(repo, &format!("{from}..{to}"))?;
                }
            }
            RefChange::Removed { .. } => {}
        }
    }
    Ok(())
}

/// Number of commits in `range` and their distinct authors, most active first.
/// Capped so a branch that forked from ancient history cannot stall a refresh.
fn range_authors(repo: &Repo, range: &str) -> Result<(u32, Vec<String>)> {
    let Some(out) = repo.try_run(["log", "--format=%an", "--max-count=1000", range, "--"])? else {
        return Ok((0, Vec::new()));
    };
    let mut counts: BTreeMap<&str, u32> = BTreeMap::new();
    let mut total = 0;
    for a in out.lines() {
        *counts.entry(a).or_default() += 1;
        total += 1;
    }
    let mut authors: Vec<(&str, u32)> = counts.into_iter().collect();
    authors.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
    Ok((
        total,
        authors.into_iter().map(|(a, _)| a.to_string()).collect(),
    ))
}

/// File name for a repository's snapshot, stable across runs and builds.
/// FNV-1a rather than `DefaultHasher`, whose output is not guaranteed stable
/// between Rust releases.
pub fn file_name_for(root: &Path) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in root.to_string_lossy().as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    let base = root
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    format!("{base}-{h:016x}.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(name: &str, sha: &str, kind: RefKind) -> RefInfo {
        RefInfo {
            name: name.into(),
            short: name.into(),
            kind,
            sha: sha.into(),
            time: 0,
            author: String::new(),
            email: String::new(),
            subject: String::new(),
            upstream: None,
        }
    }

    #[test]
    fn diff_reports_added_updated_removed_and_ignores_tags() {
        let snap = Snapshot {
            seen: [
                ("refs/heads/a", "1"),
                ("refs/heads/b", "2"),
                ("refs/heads/gone", "3"),
            ]
            .into_iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect(),
        };
        let refs = vec![
            r("refs/heads/a", "1", RefKind::Local),
            r("refs/heads/b", "9", RefKind::Local),
            r("refs/remotes/origin/new", "5", RefKind::Remote),
            r("refs/tags/v1", "6", RefKind::Tag),
        ];
        let kinds: Vec<(String, &str)> = diff(&snap, &refs)
            .iter()
            .map(|c| {
                let k = match c {
                    RefChange::Added { .. } => "added",
                    RefChange::Updated { .. } => "updated",
                    RefChange::Removed { .. } => "removed",
                };
                (c.name().to_string(), k)
            })
            .collect();
        assert_eq!(
            kinds,
            vec![
                ("refs/heads/b".to_string(), "updated"),
                ("refs/remotes/origin/new".to_string(), "added"),
                ("refs/heads/gone".to_string(), "removed"),
            ]
        );
    }

    #[test]
    fn acknowledge_moves_or_drops_entries() {
        let refs = vec![r("refs/heads/a", "2", RefKind::Local)];
        let mut snap = Snapshot::default();
        snap.seen.insert("refs/heads/a".into(), "1".into());
        snap.seen.insert("refs/heads/gone".into(), "3".into());
        snap.acknowledge(&refs, &["refs/heads/a".into(), "refs/heads/gone".into()]);
        assert_eq!(snap.seen.get("refs/heads/a").map(String::as_str), Some("2"));
        assert!(!snap.seen.contains_key("refs/heads/gone"));
        assert!(diff(&snap, &refs).is_empty());
    }

    #[test]
    fn file_name_is_stable() {
        let a = file_name_for(Path::new("/x/repo"));
        assert_eq!(a, file_name_for(Path::new("/x/repo")));
        assert!(a.starts_with("repo-"));
        assert_ne!(a, file_name_for(Path::new("/y/repo")));
    }
}
