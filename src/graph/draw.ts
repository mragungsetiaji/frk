import { Row } from "../api";
import { initials, laneColor, personColor } from "../util";
import { RowCache } from "./rowCache";

export const ROW_H = 28;
export const LANE_W = 22;
export const GRAPH_PAD = 8;
/** Radius of a commit's author avatar. */
export const NODE_R = 10;
/** Radius of a plain merge commit, drawn as a dot rather than an avatar. */
const MERGE_R = 5;

export function laneX(lane: number): number {
  return GRAPH_PAD + lane * LANE_W + LANE_W / 2;
}

/** Width that fits every lane; the starting width until the user drags it. */
export function autoGraphWidth(maxLanes: number): number {
  return GRAPH_PAD * 2 + Math.max(maxLanes, 1) * LANE_W;
}

/** Merges with no ref of their own are drawn small, as in GitKraken. */
export function isMergeDot(row: Row): boolean {
  return row.parents.length > 1 && row.refs.length === 0;
}

/**
 * Lines turn with a rounded corner instead of curving diagonally, as in
 * GitKraken: a line leaving a node runs across at the node's row and then
 * down its lane; a line arriving runs down its lane and then across into the
 * node. Parallel lanes stay readable either way.
 */
function segment(ctx: CanvasRenderingContext2D, s: Seg) {
  const [x1, y1, x2, y2, leaving] = s;
  ctx.moveTo(x1, y1);
  if (x1 === x2) {
    ctx.lineTo(x2, y2);
    return;
  }
  const r = Math.min(8, Math.abs(x2 - x1), Math.abs(y2 - y1));
  const dir = x2 > x1 ? 1 : -1;
  if (leaving) {
    ctx.lineTo(x2 - dir * r, y1);
    ctx.quadraticCurveTo(x2, y1, x2, y1 + r);
    ctx.lineTo(x2, y2);
  } else {
    ctx.lineTo(x1, y2 - r);
    ctx.quadraticCurveTo(x1, y2, x1 + dir * r, y2);
    ctx.lineTo(x2, y2);
  }
}

type Seg = [x1: number, y1: number, x2: number, y2: number, leaving: boolean];

/**
 * Draws the rows currently in the viewport onto a canvas the size of the graph
 * column's viewport. Called on every scroll frame, so it only touches visible
 * rows and batches line strokes per colour.
 */
export function drawGraph(
  ctx: CanvasRenderingContext2D,
  cache: RowCache,
  opts: { scrollTop: number; height: number; width: number; count: number; selected: string | null },
) {
  const { scrollTop, height, width, count, selected } = opts;
  ctx.clearRect(0, 0, width, height);
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - 1);
  const last = Math.min(count - 1, Math.ceil((scrollTop + height) / ROW_H));

  const visible: [Row, number][] = [];
  for (let i = first; i <= last; i++) {
    const row = cache.get(i);
    if (row) visible.push([row, i * ROW_H - scrollTop]);
  }

  // Row bands: a tint from the node to the message column, and a faint line
  // tying a branch label to its node.
  for (const [row, y] of visible) {
    const x = laneX(row.lane);
    const color = laneColor(row.color);
    ctx.fillStyle = color + (row.sha === selected ? "40" : "1c");
    ctx.fillRect(x, y + 1, width - x, ROW_H - 2);
    if (row.refs.length > 0) {
      ctx.strokeStyle = color + "90";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, y + ROW_H / 2 + 0.5);
      ctx.lineTo(x - NODE_R, y + ROW_H / 2 + 0.5);
      ctx.stroke();
    }
  }

  const byColor = new Map<number, Seg[]>();
  const add = (c: number, seg: Seg) => {
    let list = byColor.get(c);
    if (!list) byColor.set(c, (list = []));
    list.push(seg);
  };
  for (const [row, y] of visible) {
    const mid = y + ROW_H / 2;
    for (const e of row.top) add(e.color, [laneX(e.from), y, laneX(e.to), mid, false]);
    for (const e of row.bottom) add(e.color, [laneX(e.from), mid, laneX(e.to), y + ROW_H, true]);
  }
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const [c, segs] of byColor) {
    ctx.strokeStyle = laneColor(c);
    ctx.beginPath();
    for (const seg of segs) segment(ctx, seg);
    ctx.stroke();
  }

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "700 8.5px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  for (const [row, y] of visible) {
    const x = laneX(row.lane);
    const cy = y + ROW_H / 2;
    const color = laneColor(row.color);
    if (isMergeDot(row)) {
      ctx.beginPath();
      ctx.arc(x, cy, MERGE_R, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.arc(x, cy, NODE_R, 0, Math.PI * 2);
      ctx.fillStyle = personColor(row.email || row.author);
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = color;
      ctx.stroke();
      ctx.fillStyle = "#fff";
      ctx.fillText(initials(row.author), x, cy + 0.5);
    }
    if (row.sha === selected) {
      ctx.beginPath();
      ctx.arc(x, cy, (isMergeDot(row) ? MERGE_R : NODE_R) + 3, 0, Math.PI * 2);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "#ffffff";
      ctx.stroke();
    }
  }
}
