/** The app background, for canvas drawing that cannot read CSS variables. */
export const SURFACE = "#131418";

/** Lane colours, starting warm so the first (usually HEAD's) lane matches the accent. */
export const LANE_COLORS = [
  "#f2a93b",
  "#3ec7b0",
  "#ef6f6c",
  "#6aa9f4",
  "#a5d65a",
  "#b48cf5",
  "#f07fb0",
  "#d9c27a",
  "#5fd39a",
  "#8a93f0",
  "#f58a4b",
  "#4fc3dc",
];

export function laneColor(i: number): string {
  return LANE_COLORS[i % LANE_COLORS.length];
}

export function timeAgo(unixSeconds: number, now = Date.now()): string {
  const s = Math.max(0, Math.round(now / 1000 - unixSeconds));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}

export function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Stable colour for a person, so the same author always looks the same. */
export function personColor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 45% 42%)`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function splitPath(path: string): [string, string] {
  const i = path.lastIndexOf("/");
  return i < 0 ? ["", path] : [path.slice(0, i + 1), path.slice(i + 1)];
}

/** `origin/feat/x` and `feat/x` are the same branch for labelling purposes. */
export function branchKey(short: string, kind: string): string {
  if (kind !== "remote") return short;
  const i = short.indexOf("/");
  return i < 0 ? short : short.slice(i + 1);
}

/**
 * Commit bodies are hard-wrapped at ~72 columns. Joins the lines of each
 * paragraph back up so the text reflows to the panel, leaving lists, indented
 * blocks and trailers (`Co-Authored-By: ...`) on their own lines.
 */
export function reflow(body: string): string {
  const keep = /^(\s|[-*+] |\d+[.)] |>|[A-Za-z-]+: |\(cherry picked)/;
  return body
    .split(/\n{2,}/)
    .map((para) =>
      para
        .split("\n")
        .reduce((out, line, i) => (i === 0 ? line : out + (keep.test(line) ? "\n" : " ") + line), ""),
    )
    .join("\n\n");
}
