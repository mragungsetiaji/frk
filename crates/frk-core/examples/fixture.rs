//! Dumps a real repository's refs, graph and a few commit details as JSON, for
//! previewing the UI in a plain browser (`pnpm dev`, see src/devMock.ts):
//! `cargo run -p frk-core --example fixture -- <repo> public/dev-fixture.json`.

use std::collections::BTreeMap;
use std::time::{SystemTime, UNIX_EPOCH};

use frk_core::{Repo, detail, graph, refs, snapshot};
use serde_json::json;

fn main() -> frk_core::Result<()> {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("repo path");
    let out = args
        .next()
        .unwrap_or_else(|| "public/dev-fixture.json".into());

    let repo = Repo::open(&path)?;
    let all = refs::list_refs(&repo)?;
    let head = refs::head(&repo)?;
    let target = refs::default_target(&repo, &all)?;
    let merged = match &target {
        Some(t) => refs::merged_into(&repo, t)?,
        None => Default::default(),
    };

    // Pretend the user last looked before the three newest branches appeared
    // and before the target's latest commit, so the "since last seen" panel
    // has something real in it.
    let mut snap = snapshot::Snapshot::of(&all);
    for r in all.iter().filter(|r| r.kind != refs::RefKind::Tag).take(3) {
        snap.seen.remove(&r.name);
    }
    if let Some(t) = &target
        && let Some(parent) = repo.try_run(["rev-parse", &format!("{t}~2")])?
    {
        snap.seen.insert(t.clone(), parent.trim().to_string());
    }
    let mut changes = snapshot::diff(&snap, &all);
    snapshot::enrich(&repo, &mut changes, target.as_deref())?;

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let cutoff = now - 30 * 86_400;
    let visible: Vec<&refs::RefInfo> = all
        .iter()
        .filter(|r| r.kind != refs::RefKind::Tag)
        .filter(|r| {
            Some(&r.name) == target.as_ref()
                || changes.iter().any(|c| c.name() == r.name)
                || (r.time >= cutoff && !merged.contains(&r.name))
        })
        .collect();
    let tips: Vec<String> = visible.iter().map(|r| r.sha.clone()).collect();
    let mut g = graph::layout(graph::load_commits(&repo, &tips, 5000)?);
    g.label(visible.iter().map(|r| (r.name.as_str(), r.sha.as_str())));

    let mut details = BTreeMap::new();
    let mut diffs = BTreeMap::new();
    for row in g.slice(0, 40) {
        let d = detail::commit_detail(&repo, &row.sha)?;
        for f in d.files.iter().take(3) {
            let text = detail::file_diff(&repo, &d.sha, &f.path, f.old_path.as_deref())?;
            diffs.insert(format!("{}:{}", d.sha, f.path), text);
        }
        details.insert(row.sha.clone(), d);
    }

    let refs_json: Vec<_> = all
        .iter()
        .map(|r| {
            let mut v = serde_json::to_value(r).unwrap();
            v["merged"] = json!(merged.contains(&r.name));
            v
        })
        .collect();
    let fixture = json!({
        "repo": {
            "root": repo.root().display().to_string(),
            "head": head,
            "target": target,
            "refs": refs_json,
            "changes": changes,
            "baseline": false,
        },
        "meta": {
            "rows": g.rows.len(),
            "maxLanes": g.max_lanes,
            "visible": visible.iter().map(|r| r.name.clone()).collect::<Vec<_>>(),
        },
        "rows": g.rows,
        "details": details,
        "diffs": diffs,
    });
    std::fs::write(&out, serde_json::to_vec(&fixture).unwrap())?;
    println!(
        "wrote {out}: {} rows, {} lanes, {} changes",
        g.rows.len(),
        g.max_lanes,
        changes.len()
    );
    Ok(())
}
