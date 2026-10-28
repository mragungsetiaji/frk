//! Runs the whole read path against a real repository and prints timings:
//! `cargo run --release -p frk-core --example inspect -- <repo> [days]`.

use std::time::{Instant, SystemTime, UNIX_EPOCH};

use frk_core::{Repo, detail, graph, refs, snapshot};

fn main() -> frk_core::Result<()> {
    let mut args = std::env::args().skip(1);
    let path = args.next().unwrap_or_else(|| ".".into());
    let days: i64 = args.next().and_then(|d| d.parse().ok()).unwrap_or(30);

    let t = Instant::now();
    let repo = Repo::open(&path)?;
    let all = refs::list_refs(&repo)?;
    let target = refs::default_target(&repo, &all)?;
    let merged = match &target {
        Some(t) => refs::merged_into(&repo, t)?,
        None => Default::default(),
    };
    println!(
        "refs: {} ({} merged into {:?}) in {:?}",
        all.len(),
        merged.len(),
        target,
        t.elapsed()
    );

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let cutoff = now - days * 86_400;
    let visible: Vec<&refs::RefInfo> = all
        .iter()
        .filter(|r| r.kind != refs::RefKind::Tag)
        .filter(|r| {
            Some(&r.name) == target.as_ref() || (r.time >= cutoff && !merged.contains(&r.name))
        })
        .collect();
    let tips: Vec<String> = visible.iter().map(|r| r.sha.clone()).collect();

    let t = Instant::now();
    let commits = graph::load_commits(&repo, &tips, 5000)?;
    let n = commits.len();
    let walk = t.elapsed();
    let t = Instant::now();
    let head = refs::head(&repo)?;
    let mut g = graph::layout(commits, head.sha.as_deref());
    g.label(visible.iter().map(|r| (r.name.as_str(), r.sha.as_str())));
    println!(
        "graph: {} visible refs, {n} commits, {} lanes; walk {walk:?}, layout {:?}",
        visible.len(),
        g.max_lanes,
        t.elapsed()
    );
    for row in g.slice(0, 8) {
        let pad = " ".repeat(row.lane as usize * 2);
        println!(
            "  {pad}* {} {} {:?}",
            &row.sha[..7],
            row.subject.chars().take(60).collect::<String>(),
            row.refs
        );
    }

    // Pretend we last looked a few commits ago on every branch.
    let mut snap = snapshot::Snapshot::of(&all);
    snap.seen.remove(&all[0].name);
    if let Some(tgt) = &target
        && let Some(r) = g
            .rows
            .iter()
            .find(|r| r.refs.is_empty() && r.parents.len() == 1)
    {
        snap.seen.insert(tgt.clone(), r.parents[0].clone());
    }
    let t = Instant::now();
    let mut changes = snapshot::diff(&snap, &all);
    snapshot::enrich(&repo, &mut changes, target.as_deref())?;
    println!("changes in {:?}:", t.elapsed());
    for c in &changes {
        println!("  {}", serde_json::to_string(c).unwrap());
    }

    if let Some(row) = g.rows.first() {
        let t = Instant::now();
        let d = detail::commit_detail(&repo, &row.sha)?;
        println!("detail {} files in {:?}", d.files.len(), t.elapsed());
        if let Some(f) = d.files.first() {
            let diff = detail::file_diff(&repo, &d.sha, &f.path, f.old_path.as_deref())?;
            println!(
                "  {} {:?} diff {} lines",
                f.status,
                f.path,
                diff.lines().count()
            );
        }
    }
    Ok(())
}
