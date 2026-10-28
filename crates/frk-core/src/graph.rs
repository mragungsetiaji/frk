//! Commit walk and lane layout for the all-branches graph.
//!
//! Layout runs once per filter change, in Rust, over the whole walk. The UI then
//! asks for rows by index range and draws only what is on screen, so the
//! frontend never holds more than a few pages of rows no matter how large the
//! history is.

use std::collections::HashMap;

use serde::Serialize;

use crate::git::{FS, RS, Repo, Result};

#[derive(Debug, Clone)]
pub struct Commit {
    pub sha: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    pub time: i64,
    pub subject: String,
}

/// One line segment inside a row. `from` and `to` are lane indices.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Edge {
    pub from: u16,
    pub to: u16,
    pub color: u16,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub sha: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    pub time: i64,
    pub subject: String,
    /// Lane the commit's node sits in.
    pub lane: u16,
    pub color: u16,
    /// Segments in the upper half of the row, from the top edge at lane `from`
    /// to the vertical centre at lane `to`. A lane passing straight through has
    /// `from == to`; a lane ending in this commit has `to == lane`.
    pub top: Vec<Edge>,
    /// Segments in the lower half, from the centre at `from` to the bottom edge
    /// at `to`. The node's edges to its parents start at `from == lane`.
    pub bottom: Vec<Edge>,
    /// Full names of the refs whose tip is this commit.
    pub refs: Vec<String>,
}

#[derive(Debug, Default)]
pub struct Graph {
    pub rows: Vec<Row>,
    pub max_lanes: usize,
    index: HashMap<String, usize>,
}

impl Graph {
    pub fn row_of(&self, sha: &str) -> Option<usize> {
        self.index.get(sha).copied()
    }

    pub fn slice(&self, start: usize, end: usize) -> &[Row] {
        let end = end.min(self.rows.len());
        &self.rows[start.min(end)..end]
    }

    /// Attaches ref names to the rows of the commits they point at.
    pub fn label<'a>(&mut self, refs: impl IntoIterator<Item = (&'a str, &'a str)>) {
        for (name, sha) in refs {
            if let Some(&i) = self.index.get(sha) {
                self.rows[i].refs.push(name.to_string());
            }
        }
    }
}

/// Walks history from `tips` in date order (children always before parents),
/// newest first, stopping after `max_commits`.
pub fn load_commits(repo: &Repo, tips: &[String], max_commits: usize) -> Result<Vec<Commit>> {
    if tips.is_empty() {
        return Ok(Vec::new());
    }
    let format = format!("--format=%H{FS}%P{FS}%an{FS}%ae{FS}%ct{FS}%s{RS}");
    let out = repo.run_with_stdin(
        [
            "log",
            "--date-order",
            &format,
            &format!("--max-count={max_commits}"),
            "--stdin",
            "--",
        ],
        &(tips.join("\n") + "\n"),
    )?;
    Ok(out
        .split(RS)
        .filter_map(|rec| {
            let rec = rec.trim_start_matches('\n');
            let f: Vec<&str> = rec.split(FS).collect();
            (f.len() >= 6).then(|| Commit {
                sha: f[0].to_string(),
                parents: f[1].split_whitespace().map(str::to_string).collect(),
                author: f[2].to_string(),
                email: f[3].to_string(),
                time: f[4].parse().unwrap_or(0),
                subject: f[5].to_string(),
            })
        })
        .collect())
}

struct Lane {
    /// The commit this lane is drawing a line down towards.
    expect: String,
    color: u16,
}

/// Assigns every commit a lane and records the line segments around it.
///
/// Each lane is a line heading down to one expected commit. A commit takes the
/// first lane expecting it (or a free one, if nothing does: a branch tip) and
/// every other lane expecting it converges into it and ends. Its first parent
/// continues straight down in the same lane, so a branch reads as one vertical
/// line; further parents of a merge reuse a lane already heading to that parent
/// or open a new one.
///
/// Two branches that fork from the same commit therefore run as parallel lines
/// until they meet at that commit. That is deliberate: it is what makes every
/// in-flight branch visible as its own line instead of being folded into its
/// neighbour. Lanes are never shifted sideways to close gaps; a freed slot is
/// reused by the next branch that needs one, which keeps unrelated lines still.
pub fn layout(commits: Vec<Commit>) -> Graph {
    let mut lanes: Vec<Option<Lane>> = Vec::new();
    let mut next_color: u16 = 0;
    let mut graph = Graph {
        rows: Vec::with_capacity(commits.len()),
        ..Graph::default()
    };

    fn alloc(lanes: &mut Vec<Option<Lane>>) -> usize {
        match lanes.iter().position(Option::is_none) {
            Some(i) => i,
            None => {
                lanes.push(None);
                lanes.len() - 1
            }
        }
    }
    let mut new_color = || {
        let c = next_color;
        next_color = next_color.wrapping_add(1);
        c
    };

    for c in commits {
        let matching: Vec<usize> = lanes
            .iter()
            .enumerate()
            .filter_map(|(i, l)| l.as_ref().filter(|l| l.expect == c.sha).map(|_| i))
            .collect();

        let (col, color) = match matching.first() {
            Some(&i) => (i, lanes[i].as_ref().unwrap().color),
            None => (alloc(&mut lanes), new_color()),
        };

        let mut top = Vec::new();
        for (i, lane) in lanes.iter().enumerate() {
            if let Some(lane) = lane {
                let to = if lane.expect == c.sha { col } else { i };
                top.push(Edge {
                    from: i as u16,
                    to: to as u16,
                    color: lane.color,
                });
            }
        }
        for &i in &matching {
            lanes[i] = None;
        }

        // Lanes that were already running before this commit, and so pass
        // through the lower half untouched.
        let through: Vec<usize> = lanes
            .iter()
            .enumerate()
            .filter_map(|(i, l)| (l.is_some() && i != col).then_some(i))
            .collect();

        let mut bottom = Vec::new();
        for (k, p) in c.parents.iter().enumerate() {
            if k == 0 {
                lanes[col] = Some(Lane {
                    expect: p.clone(),
                    color,
                });
                bottom.push(Edge {
                    from: col as u16,
                    to: col as u16,
                    color,
                });
                continue;
            }
            let existing = lanes
                .iter()
                .position(|l| l.as_ref().is_some_and(|l| &l.expect == p));
            let (to, to_color) = match existing {
                Some(i) => (i, lanes[i].as_ref().unwrap().color),
                None => {
                    let i = alloc(&mut lanes);
                    let pc = new_color();
                    lanes[i] = Some(Lane {
                        expect: p.clone(),
                        color: pc,
                    });
                    (i, pc)
                }
            };
            bottom.push(Edge {
                from: col as u16,
                to: to as u16,
                color: to_color,
            });
        }
        for i in through {
            let color = lanes[i].as_ref().unwrap().color;
            bottom.push(Edge {
                from: i as u16,
                to: i as u16,
                color,
            });
        }

        while matches!(lanes.last(), Some(None)) {
            lanes.pop();
        }
        graph.max_lanes = graph.max_lanes.max(lanes.len()).max(col + 1);
        graph.index.insert(c.sha.clone(), graph.rows.len());
        graph.rows.push(Row {
            sha: c.sha,
            parents: c.parents,
            author: c.author,
            email: c.email,
            time: c.time,
            subject: c.subject,
            lane: col as u16,
            color,
            top,
            bottom,
            refs: Vec::new(),
        });
    }
    graph
}

#[cfg(test)]
mod tests {
    use super::*;

    fn commit(sha: &str, parents: &[&str]) -> Commit {
        Commit {
            sha: sha.into(),
            parents: parents.iter().map(|p| p.to_string()).collect(),
            author: String::new(),
            email: String::new(),
            time: 0,
            subject: String::new(),
        }
    }

    fn e(from: u16, to: u16) -> (u16, u16) {
        (from, to)
    }

    fn edges(v: &[Edge]) -> Vec<(u16, u16)> {
        v.iter().map(|x| (x.from, x.to)).collect()
    }

    #[test]
    fn linear_history_stays_in_one_lane() {
        let g = layout(vec![
            commit("c", &["b"]),
            commit("b", &["a"]),
            commit("a", &[]),
        ]);
        assert!(g.rows.iter().all(|r| r.lane == 0));
        assert_eq!(g.max_lanes, 1);
        assert_eq!(edges(&g.rows[0].top), vec![]);
        assert_eq!(edges(&g.rows[1].top), vec![e(0, 0)]);
        assert_eq!(edges(&g.rows[2].bottom), vec![]);
    }

    #[test]
    fn two_branches_from_one_fork_run_parallel_then_join() {
        // main: m -> base ; feature: f -> base
        let g = layout(vec![
            commit("m", &["base"]),
            commit("f", &["base"]),
            commit("base", &[]),
        ]);
        assert_eq!((g.rows[0].lane, g.rows[1].lane, g.rows[2].lane), (0, 1, 0));
        // At f, lane 0 passes straight through on both halves.
        assert_eq!(edges(&g.rows[1].top), vec![e(0, 0)]);
        assert_eq!(edges(&g.rows[1].bottom), vec![e(1, 1), e(0, 0)]);
        // At base, both lanes converge into lane 0.
        assert_eq!(edges(&g.rows[2].top), vec![e(0, 0), e(1, 0)]);
        assert_ne!(g.rows[0].color, g.rows[1].color);
    }

    #[test]
    fn merge_opens_a_lane_for_its_second_parent() {
        // M merges x into a; x branches off a's parent o.
        let g = layout(vec![
            commit("M", &["a", "x"]),
            commit("x", &["o"]),
            commit("a", &["o"]),
            commit("o", &[]),
        ]);
        assert_eq!(edges(&g.rows[0].bottom), vec![e(0, 0), e(0, 1)]);
        assert_eq!(g.rows[1].lane, 1);
        assert_eq!(g.rows[2].lane, 0);
        assert_eq!(edges(&g.rows[3].top), vec![e(0, 0), e(1, 0)]);
        assert_eq!(g.max_lanes, 2);
    }

    #[test]
    fn freed_lane_is_reused_without_shifting_others() {
        let g = layout(vec![
            commit("a", &["z"]),
            commit("b", &["y"]),
            commit("y", &[]),
            commit("c", &["z"]),
            commit("z", &[]),
        ]);
        assert_eq!(g.rows[1].lane, 1);
        // y ends lane 1; c is a new tip and takes the freed slot.
        assert_eq!(g.rows[3].lane, 1);
        assert_eq!(g.max_lanes, 2);
    }

    #[test]
    fn row_lookup_and_labels() {
        let mut g = layout(vec![commit("b", &["a"]), commit("a", &[])]);
        g.label([
            ("refs/heads/main", "b"),
            ("refs/tags/v1", "a"),
            ("refs/heads/gone", "zz"),
        ]);
        assert_eq!(g.row_of("a"), Some(1));
        assert_eq!(g.rows[0].refs, vec!["refs/heads/main"]);
        assert_eq!(g.rows[1].refs, vec!["refs/tags/v1"]);
        assert_eq!(g.slice(1, 99).len(), 1);
    }
}
