use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use frk_core::Repo;
use frk_core::actions::{self, Action};
use frk_core::detail::{self, CommitDetail};
use frk_core::file::{self, Blame, FileVersions, HistoryEntry};
use frk_core::graph::{self, Graph, Row};
use frk_core::refs::{self, Head, RefInfo, RefKind, Remote, WorkStatus};
use frk_core::snapshot::{self, RefChange, Snapshot};
use frk_core::worktree::{self, WIP, WipFile, WorkTree};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

/// Everything known about the open repository. Refs and the graph are rebuilt
/// on refresh; the snapshot is only written when the user marks something seen.
struct Session {
    repo: Repo,
    refs: Vec<RefInfo>,
    head: Head,
    target: Option<String>,
    merged: HashSet<String>,
    remotes: Vec<Remote>,
    work: WorkStatus,
    snapshot: Snapshot,
    snapshot_path: PathBuf,
    changes: Vec<RefChange>,
    graph: Graph,
}

#[derive(Default)]
struct AppState(Mutex<Option<Session>>);

type CmdResult<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RepoView {
    root: String,
    head: Head,
    target: Option<String>,
    refs: Vec<RefView>,
    remotes: Vec<Remote>,
    work: WorkStatus,
    changes: Vec<RefChange>,
    /// True when no snapshot existed: everything was just recorded as seen.
    baseline: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RefView {
    #[serde(flatten)]
    info: RefInfo,
    merged: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GraphFilter {
    /// Only branches whose tip moved in the last `days` days; 0 means all.
    days: u32,
    hide_merged: bool,
    tags: bool,
    hidden: Vec<String>,
    /// When non-empty, show only these refs (plus the target and HEAD).
    solo: Vec<String>,
    /// Shown regardless of the other filters: a branch the user clicked on in
    /// the sidebar even though it is old or merged.
    include: Vec<String>,
    max_commits: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GraphMeta {
    rows: usize,
    max_lanes: usize,
    visible: Vec<String>,
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn snapshot_dir(app: &AppHandle) -> CmdResult<PathBuf> {
    Ok(app.path().app_data_dir().map_err(err)?.join("snapshots"))
}

fn load(app: &AppHandle, path: &str) -> CmdResult<(Session, bool)> {
    let repo = Repo::open(path).map_err(err)?;
    let snapshot_path = snapshot_dir(app)?.join(snapshot::file_name_for(repo.root()));
    let refs = refs::list_refs(&repo).map_err(err)?;
    let (snapshot, baseline) = match Snapshot::load(&snapshot_path) {
        Some(s) => (s, false),
        None => {
            let s = Snapshot::of(&refs);
            s.save(&snapshot_path).map_err(err)?;
            (s, true)
        }
    };
    let mut session = Session {
        head: refs::head(&repo).map_err(err)?,
        target: refs::default_target(&repo, &refs).map_err(err)?,
        merged: HashSet::new(),
        remotes: refs::remotes(&repo).map_err(err)?,
        work: refs::work_status(&repo).map_err(err)?,
        changes: Vec::new(),
        graph: Graph::default(),
        repo,
        refs,
        snapshot,
        snapshot_path,
    };
    if let Some(t) = &session.target {
        session.merged = refs::merged_into(&session.repo, t).map_err(err)?;
    }
    recompute_changes(&mut session)?;
    Ok((session, baseline))
}

fn recompute_changes(s: &mut Session) -> CmdResult<()> {
    let mut changes = snapshot::diff(&s.snapshot, &s.refs);
    snapshot::enrich(&s.repo, &mut changes, s.target.as_deref()).map_err(err)?;
    s.changes = changes;
    Ok(())
}

fn view(s: &Session, baseline: bool) -> RepoView {
    RepoView {
        root: s.repo.root().display().to_string(),
        head: s.head.clone(),
        target: s.target.clone(),
        refs: s
            .refs
            .iter()
            .map(|r| RefView {
                merged: s.merged.contains(&r.name),
                info: r.clone(),
            })
            .collect(),
        remotes: s.remotes.clone(),
        work: s.work,
        changes: s.changes.clone(),
        baseline,
    }
}

/// Git work is blocking and can take a while (a fetch especially), so every
/// command runs it off the main thread.
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> CmdResult<T> + Send + 'static,
) -> CmdResult<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(err)?
}

#[tauri::command]
async fn open_repo(app: AppHandle, path: String) -> CmdResult<RepoView> {
    let handle = app.clone();
    let (session, baseline) = blocking(move || load(&handle, &path)).await?;
    let v = view(&session, baseline);
    *app.state::<AppState>().0.lock().unwrap() = Some(session);
    Ok(v)
}

/// Re-reads refs (after a fetch, or when the window regains focus) without
/// touching the snapshot.
#[tauri::command]
async fn refresh(app: AppHandle) -> CmdResult<RepoView> {
    let root = {
        let st = app.state::<AppState>();
        let guard = st.0.lock().unwrap();
        guard
            .as_ref()
            .ok_or("no repository open")?
            .repo
            .root()
            .display()
            .to_string()
    };
    open_repo(app, root).await
}

#[tauri::command]
async fn fetch_all(app: AppHandle) -> CmdResult<()> {
    let repo = {
        let st = app.state::<AppState>();
        let guard = st.0.lock().unwrap();
        guard.as_ref().ok_or("no repository open")?.repo.clone()
    };
    blocking(move || {
        repo.run(["fetch", "--all", "--prune", "--quiet"])
            .map_err(err)?;
        Ok(())
    })
    .await
}

#[tauri::command]
async fn build_graph(app: AppHandle, filter: GraphFilter) -> CmdResult<GraphMeta> {
    let (repo, visible, head, dirty) = {
        let st = app.state::<AppState>();
        let guard = st.0.lock().unwrap();
        let s = guard.as_ref().ok_or("no repository open")?;
        (
            s.repo.clone(),
            visible_refs(s, &filter),
            s.head.sha.clone(),
            s.work.dirty > 0,
        )
    };
    let tips: Vec<String> = visible.iter().map(|(_, sha)| sha.clone()).collect();
    let max = filter.max_commits.max(1);
    let mut g = blocking(move || {
        let mut commits = graph::load_commits(&repo, &tips, max).map_err(err)?;
        // Uncommitted work is drawn as a child of HEAD at the very top, and
        // counts as HEAD's history so it is lit like the rest of the branch.
        let wip = match (&head, dirty) {
            (Some(h), true) => {
                commits.insert(
                    0,
                    graph::Commit {
                        sha: WIP.into(),
                        parents: vec![h.clone()],
                        author: String::new(),
                        email: String::new(),
                        time: now(),
                        subject: "// WIP".into(),
                    },
                );
                Some(WIP)
            }
            _ => None,
        };
        Ok(graph::layout(commits, wip.or(head.as_deref())))
    })
    .await?;
    g.label(visible.iter().map(|(n, sha)| (n.as_str(), sha.as_str())));

    let meta = GraphMeta {
        rows: g.rows.len(),
        max_lanes: g.max_lanes,
        visible: visible.into_iter().map(|(n, _)| n).collect(),
    };
    let st = app.state::<AppState>();
    if let Some(s) = st.0.lock().unwrap().as_mut() {
        s.graph = g;
    }
    Ok(meta)
}

fn visible_refs(s: &Session, f: &GraphFilter) -> Vec<(String, String)> {
    let cutoff = now() - i64::from(f.days) * 86_400;
    let head_ref = s.head.branch.as_ref().map(|b| format!("refs/heads/{b}"));
    let pinned =
        |r: &RefInfo| Some(&r.name) == s.target.as_ref() || Some(&r.name) == head_ref.as_ref();
    let mut out: Vec<(String, String)> = s
        .refs
        .iter()
        .filter(|r| {
            if pinned(r) || f.include.contains(&r.name) {
                return true;
            }
            if !f.solo.is_empty() {
                return f.solo.contains(&r.name);
            }
            if f.hidden.contains(&r.name) || (r.kind == RefKind::Tag && !f.tags) {
                return false;
            }
            let active = f.days == 0 || r.time >= cutoff;
            let merged = f.hide_merged && s.merged.contains(&r.name);
            // A branch flagged as new or moved is always shown: that is the
            // whole point of the flag, even when it is old or already merged.
            let changed = s.changes.iter().any(|c| c.name() == r.name);
            changed || (active && !merged)
        })
        .map(|r| (r.name.clone(), r.sha.clone()))
        .collect();
    // A detached HEAD has no ref of its own; still draw it.
    if s.head.branch.is_none()
        && let Some(sha) = &s.head.sha
    {
        out.push(("HEAD".into(), sha.clone()));
    }
    out
}

#[tauri::command]
fn graph_rows(state: State<AppState>, start: usize, end: usize) -> CmdResult<Vec<Row>> {
    let guard = state.0.lock().unwrap();
    let s = guard.as_ref().ok_or("no repository open")?;
    Ok(s.graph.slice(start, end).to_vec())
}

#[tauri::command]
fn find_row(state: State<AppState>, sha: String) -> CmdResult<Option<usize>> {
    let guard = state.0.lock().unwrap();
    let s = guard.as_ref().ok_or("no repository open")?;
    Ok(s.graph.row_of(&sha))
}

#[tauri::command]
async fn commit_detail(app: AppHandle, sha: String) -> CmdResult<CommitDetail> {
    let repo = current_repo(&app)?;
    blocking(move || detail::commit_detail(&repo, &sha).map_err(err)).await
}

#[tauri::command]
async fn file_diff(
    app: AppHandle,
    sha: String,
    path: String,
    old_path: Option<String>,
    ignore_whitespace: bool,
) -> CmdResult<String> {
    let repo = current_repo(&app)?;
    blocking(move || {
        detail::file_diff(&repo, &sha, &path, old_path.as_deref(), ignore_whitespace).map_err(err)
    })
    .await
}

#[tauri::command]
async fn file_versions(
    app: AppHandle,
    sha: String,
    path: String,
    old_path: Option<String>,
) -> CmdResult<FileVersions> {
    let repo = current_repo(&app)?;
    blocking(move || file::file_versions(&repo, &sha, &path, old_path.as_deref()).map_err(err))
        .await
}

#[tauri::command]
async fn blame(app: AppHandle, sha: String, path: String) -> CmdResult<Blame> {
    let repo = current_repo(&app)?;
    blocking(move || file::blame(&repo, &sha, &path).map_err(err)).await
}

#[tauri::command]
async fn file_history(app: AppHandle, sha: String, path: String) -> CmdResult<Vec<HistoryEntry>> {
    let repo = current_repo(&app)?;
    blocking(move || file::history(&repo, &sha, &path, 500).map_err(err)).await
}

#[tauri::command]
async fn tree_files(app: AppHandle, sha: String) -> CmdResult<Vec<String>> {
    let repo = current_repo(&app)?;
    blocking(move || file::tree_files(&repo, &sha).map_err(err)).await
}

/// Acknowledges changes. `names: None` marks every change seen.
#[tauri::command]
fn mark_seen(state: State<AppState>, names: Option<Vec<String>>) -> CmdResult<Vec<RefChange>> {
    let mut guard = state.0.lock().unwrap();
    let s = guard.as_mut().ok_or("no repository open")?;
    let names = names.unwrap_or_else(|| s.changes.iter().map(|c| c.name().to_string()).collect());
    s.snapshot.acknowledge(&s.refs, &names);
    s.snapshot.save(&s.snapshot_path).map_err(err)?;
    s.changes.retain(|c| !names.iter().any(|n| n == c.name()));
    Ok(s.changes.clone())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ActionResult {
    message: String,
    repo: RepoView,
}

/// Runs a context-menu action, then re-reads the repository. Any ref that
/// moved during the action moved because the user asked it to, so it is
/// marked seen rather than reported back as news.
#[tauri::command]
async fn run_action(app: AppHandle, action: Action) -> CmdResult<ActionResult> {
    let (repo, before) = {
        let st = app.state::<AppState>();
        let guard = st.0.lock().unwrap();
        let s = guard.as_ref().ok_or("no repository open")?;
        let before: Vec<(String, String)> = s
            .refs
            .iter()
            .map(|r| (r.name.clone(), r.sha.clone()))
            .collect();
        (s.repo.clone(), before)
    };
    let root = repo.root().display().to_string();
    let handle = app.clone();
    let (message, session) = blocking(move || {
        let message = actions::run(&repo, &action).map_err(err)?;
        let (mut session, _) = load(&handle, &root)?;
        let mut moved: Vec<String> = session
            .refs
            .iter()
            .filter(|r| !before.iter().any(|(n, sha)| n == &r.name && sha == &r.sha))
            .map(|r| r.name.clone())
            .collect();
        moved.extend(
            before
                .iter()
                .filter(|(n, _)| !session.refs.iter().any(|r| &r.name == n))
                .map(|(n, _)| n.clone()),
        );
        if !moved.is_empty() {
            session.snapshot.acknowledge(&session.refs, &moved);
            session.snapshot.save(&session.snapshot_path).map_err(err)?;
            recompute_changes(&mut session)?;
        }
        Ok((message, session))
    })
    .await?;
    let repo = view(&session, false);
    *app.state::<AppState>().0.lock().unwrap() = Some(session);
    Ok(ActionResult { message, repo })
}

/// Re-reads the working tree and keeps the session's dirty count in step, so
/// the next graph build shows or drops the WIP row.
fn worktree_after(app: &AppHandle, repo: &Repo) -> CmdResult<WorkTree> {
    let wt = worktree::status(repo).map_err(err)?;
    let st = app.state::<AppState>();
    if let Some(s) = st.0.lock().unwrap().as_mut() {
        s.work.dirty = (wt.unstaged.len() + wt.staged.len() + wt.conflicted.len()) as u32;
    }
    Ok(wt)
}

#[tauri::command]
async fn wip_status(app: AppHandle) -> CmdResult<WorkTree> {
    let repo = current_repo(&app)?;
    let handle = app.clone();
    blocking(move || worktree_after(&handle, &repo)).await
}

#[tauri::command]
async fn wip_stage(app: AppHandle, paths: Option<Vec<String>>) -> CmdResult<WorkTree> {
    let repo = current_repo(&app)?;
    let handle = app.clone();
    blocking(move || {
        match paths {
            Some(p) => worktree::stage(&repo, &p),
            None => worktree::stage_all(&repo),
        }
        .map_err(err)?;
        worktree_after(&handle, &repo)
    })
    .await
}

#[tauri::command]
async fn wip_unstage(app: AppHandle, paths: Option<Vec<String>>) -> CmdResult<WorkTree> {
    let repo = current_repo(&app)?;
    let handle = app.clone();
    blocking(move || {
        match paths {
            Some(p) => worktree::unstage(&repo, &p),
            None => worktree::unstage_all(&repo),
        }
        .map_err(err)?;
        worktree_after(&handle, &repo)
    })
    .await
}

/// `files: None` discards everything, staged or not.
#[tauri::command]
async fn wip_discard(app: AppHandle, files: Option<Vec<WipFile>>) -> CmdResult<WorkTree> {
    let repo = current_repo(&app)?;
    let handle = app.clone();
    blocking(move || {
        match files {
            Some(f) => worktree::discard(&repo, &f),
            None => worktree::discard_all(&repo),
        }
        .map_err(err)?;
        worktree_after(&handle, &repo)
    })
    .await
}

#[tauri::command]
async fn wip_file_diff(
    app: AppHandle,
    file: WipFile,
    staged: bool,
    ignore_whitespace: bool,
) -> CmdResult<String> {
    let repo = current_repo(&app)?;
    blocking(move || worktree::file_diff(&repo, &file, staged, ignore_whitespace).map_err(err))
        .await
}

#[tauri::command]
async fn wip_file_versions(app: AppHandle, file: WipFile, staged: bool) -> CmdResult<FileVersions> {
    let repo = current_repo(&app)?;
    blocking(move || worktree::file_versions(&repo, &file, staged).map_err(err)).await
}

/// Opens a terminal in the repository. `app` is the user's choice from
/// settings: an application name on macOS (`open -a`), a program on Windows
/// and Linux. Without one, the platform's usual terminal.
#[tauri::command]
fn open_terminal(state: State<AppState>, app: Option<String>) -> CmdResult<()> {
    let root = {
        let guard = state.0.lock().unwrap();
        guard
            .as_ref()
            .ok_or("no repository open")?
            .repo
            .root()
            .to_path_buf()
    };
    let app = app.map(|a| a.trim().to_string()).filter(|a| !a.is_empty());
    if app.as_deref().is_some_and(|a| a.starts_with('-')) {
        return Err("invalid terminal application".into());
    }
    spawn_terminal(&root, app.as_deref()).map_err(|e| format!("could not open a terminal: {e}"))
}

#[cfg(target_os = "macos")]
fn spawn_terminal(root: &std::path::Path, app: Option<&str>) -> std::io::Result<()> {
    std::process::Command::new("open")
        .args(["-a", app.unwrap_or("Terminal")])
        .arg(root)
        .spawn()
        .map(drop)
}

#[cfg(windows)]
fn spawn_terminal(root: &std::path::Path, app: Option<&str>) -> std::io::Result<()> {
    use std::process::Command;
    if let Some(app) = app {
        return Command::new(app).current_dir(root).spawn().map(drop);
    }
    // Windows Terminal when it is installed, the classic console otherwise.
    Command::new("wt")
        .arg("-d")
        .arg(root)
        .spawn()
        .or_else(|_| {
            Command::new("cmd")
                .args(["/c", "start", "cmd", "/k", "cd", "/d"])
                .arg(root)
                .spawn()
        })
        .map(drop)
}

#[cfg(all(unix, not(target_os = "macos")))]
fn spawn_terminal(root: &std::path::Path, app: Option<&str>) -> std::io::Result<()> {
    std::process::Command::new(app.unwrap_or("x-terminal-emulator"))
        .current_dir(root)
        .spawn()
        .map(drop)
}

/// A repository path given on the command line (`frk ~/code/repo`), if any.
#[tauri::command]
fn launch_path() -> Option<String> {
    std::env::args()
        .skip(1)
        .find(|a| !a.starts_with('-') && std::path::Path::new(a).is_dir())
}

fn current_repo(app: &AppHandle) -> CmdResult<Repo> {
    let st = app.state::<AppState>();
    let guard = st.0.lock().unwrap();
    Ok(guard.as_ref().ok_or("no repository open")?.repo.clone())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            open_repo,
            refresh,
            fetch_all,
            build_graph,
            graph_rows,
            find_row,
            commit_detail,
            file_diff,
            mark_seen,
            launch_path,
            run_action,
            file_versions,
            blame,
            file_history,
            tree_files,
            open_terminal,
            wip_status,
            wip_stage,
            wip_unstage,
            wip_discard,
            wip_file_diff,
            wip_file_versions
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
