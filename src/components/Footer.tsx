import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { RefreshIcon } from "./Icons";

const PRESETS = [0, 1, 2, 5, 10, 15, 30];

/** Status bar: graph stats on the left, fetch status and settings on the right. */
export function Footer() {
  const repo = useStore((s) => s.repo);
  const meta = useStore((s) => s.meta);
  const fetching = useStore((s) => s.fetching);
  const lastFetch = useStore((s) => s.lastFetch);
  const autoFetchMin = useStore((s) => s.autoFetchMin);
  const [open, setOpen] = useState(false);
  const [, tick] = useState(0);

  // Keep "fetched 2m ago" current without re-rendering anything else.
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  if (!repo) return null;

  return (
    <footer className="footer small">
      {meta && (
        <span className="muted">
          {meta.visible.length} of {repo.refs.length} refs · {meta.rows.toLocaleString()} commits · {meta.maxLanes} lanes
        </span>
      )}
      <span className="spacer" />
      <span className="footer-fetch muted" title={autoFetchMin > 0 ? `Fetching every ${autoFetchMin} min` : "Auto fetch is off"}>
        {fetching ? (
          <>
            <RefreshIcon spinning /> Fetching…
          </>
        ) : (
          <>
            {lastFetch ? `Fetched ${ago(lastFetch)}` : "Not fetched yet"}
            {autoFetchMin > 0 ? ` · every ${autoFetchMin}m` : " · auto fetch off"}
          </>
        )}
      </span>
      <button
        className={`icon-btn gear${open ? " on" : ""}`}
        title="Settings"
        aria-label="Settings"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <GearIcon />
      </button>
      {open && <SettingsPane onClose={() => setOpen(false)} />}
    </footer>
  );
}

function SettingsPane({ onClose }: { onClose: () => void }) {
  const autoFetchMin = useStore((s) => s.autoFetchMin);
  const setAutoFetch = useStore((s) => s.setAutoFetch);
  const fetch = useStore((s) => s.fetch);
  const fetching = useStore((s) => s.fetching);
  const lastFetch = useStore((s) => s.lastFetch);
  const terminalApp = useStore((s) => s.terminalApp);
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const setTerminalApp = useStore((s) => s.setTerminalApp);
  const ref = useRef<HTMLDivElement>(null);
  const [custom, setCustom] = useState(PRESETS.includes(autoFetchMin) ? "" : String(autoFetchMin));

  useEffect(() => {
    ref.current?.focus();
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || (t as Element).closest?.(".gear")) return;
      onClose();
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [onClose]);

  const applyCustom = (v: string) => {
    setCustom(v);
    const n = Math.round(Number(v));
    if (Number.isFinite(n) && n >= 1 && n <= 1440) setAutoFetch(n);
  };

  return (
    <div
      ref={ref}
      className="settings"
      role="dialog"
      aria-label="Settings"
      tabIndex={-1}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
    >
      <h4>Settings</h4>
      <div className="setting">
        <div className="setting-label">Appearance</div>
        <div className="segmented" role="radiogroup" aria-label="Theme">
          {(["system", "light", "dark"] as const).map((t) => (
            <button
              key={t}
              role="radio"
              aria-checked={theme === t}
              className={theme === t ? "on" : ""}
              onClick={() => setTheme(t)}
            >
              {t === "system" ? "System" : t === "light" ? "Light" : "Dark"}
            </button>
          ))}
        </div>
      </div>
      <div className="setting">
        <div className="setting-label">
          Auto fetch
          <span className="muted">
            Runs <code>git fetch --all --prune</code> in the background. New and moved branches show up under
            “Since last seen”.
          </span>
        </div>
        <div className="segmented wrap" role="radiogroup" aria-label="Auto fetch interval">
          {PRESETS.map((m) => (
            <button
              key={m}
              role="radio"
              aria-checked={autoFetchMin === m}
              className={autoFetchMin === m ? "on" : ""}
              onClick={() => {
                setCustom("");
                setAutoFetch(m);
              }}
            >
              {m === 0 ? "Off" : `${m}m`}
            </button>
          ))}
        </div>
        <label className="custom-interval">
          Custom
          <input
            type="number"
            min={1}
            max={1440}
            placeholder="min"
            value={custom}
            onChange={(e) => applyCustom(e.target.value)}
          />
          minutes
        </label>
      </div>
      <label className="setting">
        <span className="setting-label">
          Terminal
          <span className="muted">
            {navigator.userAgent.includes("Mac")
              ? "Application for the toolbar’s Terminal button, e.g. iTerm, Ghostty, Warp. Empty uses Terminal."
              : "Program for the toolbar’s Terminal button. Empty uses Windows Terminal, or the console."}
          </span>
        </span>
        <input
          className="search"
          placeholder={navigator.userAgent.includes("Mac") ? "Terminal" : "wt"}
          value={terminalApp}
          onChange={(e) => setTerminalApp(e.target.value)}
          spellCheck={false}
        />
      </label>
      <div className="setting row">
        <span className="muted">{lastFetch ? `Last fetched ${ago(lastFetch)}` : "Not fetched yet this session"}</span>
        <button className="btn primary" onClick={() => fetch()} disabled={fetching}>
          <RefreshIcon spinning={fetching} /> {fetching ? "Fetching" : "Fetch now"}
        </button>
      </div>
    </div>
  );
}

function ago(ms: number) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`;
}

const GearIcon = () => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
    <circle cx="8" cy="8" r="2.2" />
    <path d="M8 1.5v1.8M8 12.7v1.8M14.5 8h-1.8M3.3 8H1.5M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3M12.6 12.6l-1.3-1.3M4.7 4.7 3.4 3.4" />
    <circle cx="8" cy="8" r="4.6" />
  </svg>
);
