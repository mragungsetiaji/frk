import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import { useStore } from "./store";

async function start() {
  // Apply the theme before the first paint, and keep it applied.
  const applyTheme = (t: string) => (document.documentElement.dataset.theme = t);
  applyTheme(useStore.getState().resolvedTheme);
  useStore.subscribe((s, prev) => s.resolvedTheme !== prev.resolvedTheme && applyTheme(s.resolvedTheme));

  if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
    const { installDevMock } = await import("./devMock");
    await installDevMock();
  }
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

start();
