import { open } from "@tauri-apps/plugin-dialog";
import { useEffect } from "react";
import { CommitPanel } from "./components/CommitPanel";
import { ContextMenu } from "./components/ContextMenu";
import { Dialogs } from "./components/Dialogs";
import { FileView } from "./components/FileView";
import { Footer } from "./components/Footer";
import { GraphView } from "./components/GraphView";
import { Sidebar } from "./components/Sidebar";
import { WipPanel } from "./components/WipPanel";
import { TopBar } from "./components/TopBar";
import { useStore } from "./store";
import { WIP } from "./api";

/** Refs are re-read on focus at most this often; it costs one `for-each-ref`. */
const FOCUS_REFRESH_MS = 30_000;

export default function App() {
  const repo = useStore((s) => s.repo);
  const loading = useStore((s) => s.loading);
  const error = useStore((s) => s.error);
  const autoFetchMin = useStore((s) => s.autoFetchMin);
  const clearError = useStore((s) => s.clearError);
  const wipSelected = useStore((s) => s.selected === WIP);

  useEffect(() => {
    useStore.getState().reopenLast();
  }, []);

  useEffect(() => {
    if (!repo || autoFetchMin <= 0) return;
    const t = setInterval(() => useStore.getState().fetch(), autoFetchMin * 60_000);
    return () => clearInterval(t);
  }, [repo?.root, autoFetchMin]);

  // Pick up local commits and branch switches made in a terminal or editor.
  useEffect(() => {
    let last = Date.now();
    const onFocus = () => {
      // The working tree is cheap to re-read and the most likely thing to
      // have changed while the window was in the background.
      useStore.getState().loadWip();
      if (Date.now() - last < FOCUS_REFRESH_MS) return;
      last = Date.now();
      useStore.getState().refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  return (
    <div className="app">
      <TopBar />
      {error && (
        <div className="error-bar" role="alert">
          <span>{error}</span>
          <button className="link" onClick={clearError}>
            Dismiss
          </button>
        </div>
      )}
      {repo ? (
        <main className="workspace">
          <Sidebar />
          {/* The graph stays mounted under an open file, so closing the file
              returns to the same scroll position. */}
          <div className="center">
            <GraphView />
            <FileView />
          </div>
          {wipSelected ? <WipPanel /> : <CommitPanel />}
        </main>
      ) : (
        <Welcome loading={loading} />
      )}
      <Footer />
      <ContextMenu />
      <Dialogs />
    </div>
  );
}

function Welcome({ loading }: { loading: boolean }) {
  const openRepo = useStore((s) => s.open);
  const pick = async () => {
    const dir = await open({ directory: true, multiple: false, title: "Open a git repository" });
    if (typeof dir === "string") await openRepo(dir);
  };
  return (
    <div className="welcome">
      <h1>frk</h1>
      <p className="muted">Every branch in one graph, and what changed since you last looked.</p>
      <button className="btn primary" onClick={pick} disabled={loading}>
        {loading ? "Opening…" : "Open repository"}
      </button>
    </div>
  );
}
