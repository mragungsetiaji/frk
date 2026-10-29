import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { RefChange, RefInfo, Row, WIP } from "../api";
import { autoGraphWidth, drawGraph, isMergeDot, laneX, NODE_R, ROW_H } from "../graph/draw";
import { RowCache } from "../graph/rowCache";
import { useStore } from "../store";
import { branchKey, laneColor, palette, timeAgo } from "../util";
import { TagIcon } from "./Icons";

const MIN_LABEL_W = 90;
const MIN_GRAPH_W = 60;

interface Tip {
  text: string;
  x: number;
  y: number;
}

export function GraphView() {
  const meta = useStore((s) => s.meta);
  const version = useStore((s) => s.graphVersion);
  const selected = useStore((s) => s.selected);
  const selectedIndex = useStore((s) => s.selectedIndex);
  const scrollTarget = useStore((s) => s.scrollTarget);
  const columns = useStore((s) => s.columns);
  const headSha = useStore((s) => s.repo?.head.sha ?? null);
  // Lane colours come from the theme; changing it re-renders and repaints.
  const theme = useStore((s) => s.resolvedTheme);
  const select = useStore((s) => s.select);
  const openMenu = useStore((s) => s.openMenu);

  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frame = useRef(0);
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const [tip, setTip] = useState<Tip | null>(null);
  const [labelHover, setLabelHover] = useState<string | null>(null);

  const cache = useMemo(() => new RowCache(bump), [version]);
  useEffect(() => () => cache.dispose(), [cache]);

  const count = meta?.rows ?? 0;
  const labelW = columns.label;
  const graphW = columns.graph ?? autoGraphWidth(meta?.maxLanes ?? 1);
  const template = `${labelW}px ${graphW}px minmax(0, 1fr)`;

  const virt = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 12,
  });
  const items = virt.getVirtualItems();
  const firstIndex = items[0]?.index ?? 0;
  const lastIndex = items[items.length - 1]?.index ?? 0;

  useEffect(() => {
    // One past the last row, so the time marker on the last visible row can
    // compare against its successor.
    if (count > 0) cache.ensure(firstIndex, Math.min(count, lastIndex + 2));
  }, [cache, count, firstIndex, lastIndex]);

  // The canvas is never part of React's render: scrolling only schedules a
  // repaint of the rows that are on screen.
  const paint = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const el = scrollRef.current;
      const cv = canvasRef.current;
      if (!el || !cv) return;
      const h = el.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      if (cv.width !== Math.round(graphW * dpr) || cv.height !== Math.round(h * dpr)) {
        cv.width = Math.round(graphW * dpr);
        cv.height = Math.round(h * dpr);
        cv.style.width = `${graphW}px`;
        cv.style.height = `${h}px`;
        cv.style.marginBottom = `-${h}px`;
      }
      const ctx = cv.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawGraph(ctx, cache, {
        scrollTop: el.scrollTop,
        height: h,
        width: graphW,
        count,
        selected,
        head: headSha,
        labelHover,
      });
    });
    // `theme` is read through palette() inside drawGraph.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cache, graphW, count, selected, headSha, labelHover, theme]);

  useLayoutEffect(paint);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(paint);
    ro.observe(el);
    const onScroll = () => {
      setTip(null);
      paint();
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", onScroll);
    };
  }, [paint]);

  useEffect(() => {
    if (scrollTarget) virt.scrollToIndex(scrollTarget.index, { align: "center" });
  }, [scrollTarget, virt]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const next = Math.min(count - 1, Math.max(0, (selectedIndex ?? -1) + (e.key === "ArrowDown" ? 1 : -1)));
    const row = cache.get(next);
    if (!row) return;
    select(row.sha, next);
    virt.scrollToIndex(next, { align: "auto" });
  };

  return (
    <section className="graph">
      <Header template={template} labelW={labelW} graphW={graphW} />
      <div ref={scrollRef} className="graph-scroll" tabIndex={0} onKeyDown={onKeyDown}>
        <canvas ref={canvasRef} className="graph-canvas" style={{ marginLeft: labelW }} />
        <div style={{ height: virt.getTotalSize(), position: "relative" }}>
          {items.map((item) => {
            const row = cache.get(item.index);
            const next = cache.get(item.index + 1);
            return (
              <div
                key={item.key}
                className={`graph-row${row && row.sha === selected ? " selected" : ""}${
                  row && !row.onHead ? " off-head" : ""
                }${row && row.sha === headSha ? " is-head" : ""}`}
                style={{ transform: `translateY(${item.start}px)`, gridTemplateColumns: template }}
                onClick={() => row && select(row.sha, item.index)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (!row) return;
                  select(row.sha, item.index);
                  const st = useStore.getState();
                  const labels = groupLabels(row, st.refIndex, st.changeIndex, st.repo?.head.branch);
                  openMenu({ x: e.clientX, y: e.clientY, sha: row.sha, refs: labels[0]?.refNames ?? [] });
                }}
              >
                {row ? (
                  <RowCells
                    row={row}
                    next={next}
                    isLast={item.index === count - 1}
                    graphW={graphW}
                    onTip={setTip}
                    onLabelHover={setLabelHover}
                  />
                ) : (
                  <span className="row-loading" />
                )}
              </div>
            );
          })}
        </div>
      </div>
      {tip && (
        <div className="tooltip" style={{ left: tip.x, top: tip.y }} role="tooltip">
          {tip.text}
        </div>
      )}
      {count === 0 && meta && <div className="empty">No commits match the current filters.</div>}
    </section>
  );
}

/** Column headers with drag handles. Double-click a handle to reset. */
function Header({ template, labelW, graphW }: { template: string; labelW: number; graphW: number }) {
  const setColumns = useStore((s) => s.setColumns);

  const drag = (col: "label" | "graph", startW: number, min: number) => (e: React.PointerEvent) => {
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const move = (ev: PointerEvent) => {
      setColumns({ [col]: Math.max(min, Math.round(startW + ev.clientX - startX)) });
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing");
    };
    document.body.classList.add("resizing");
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  };

  return (
    <div className="graph-header" style={{ gridTemplateColumns: template }}>
      <span className="col">
        Refs
        <span
          className="col-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize branch column"
          onPointerDown={drag("label", labelW, MIN_LABEL_W)}
          onDoubleClick={() => setColumns({ label: 200 })}
        />
      </span>
      <span className="col">
        Graph
        <span
          className="col-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize graph column"
          onPointerDown={drag("graph", graphW, MIN_GRAPH_W)}
          onDoubleClick={() => setColumns({ graph: null })}
        />
      </span>
      <span className="col">Message</span>
    </div>
  );
}

function RowCells({
  row,
  next,
  isLast,
  graphW,
  onTip,
  onLabelHover,
}: {
  row: Row;
  next: Row | undefined;
  isLast: boolean;
  graphW: number;
  onTip: (t: Tip | null) => void;
  onLabelHover: (sha: string | null) => void;
}) {
  const refIndex = useStore((s) => s.refIndex);
  const changeIndex = useStore((s) => s.changeIndex);
  const headBranch = useStore((s) => s.repo?.head.branch);
  const color = laneColor(row.color);
  const nodeX = laneX(row.lane);
  const r = isMergeDot(row) ? 6 : NODE_R;

  // The relative time is shown where it changes, on the last row of each
  // bucket, rather than repeating a date on every row.
  const when = timeAgo(row.time);
  const showWhen = row.sha !== WIP && (isLast || (next !== undefined && timeAgo(next.time) !== when));

  if (row.sha === WIP) return <WipCells color={color} />;

  return (
    <>
      <span
        className="labels"
        onMouseEnter={() => row.refs.length > 0 && onLabelHover(row.sha)}
        onMouseLeave={() => onLabelHover(null)}
      >
        <RefLabels row={row} refIndex={refIndex} changeIndex={changeIndex} headBranch={headBranch} />
      </span>
      <span className="graph-cell">
        {nodeX + r <= graphW && (
          <span
            className="node-hit"
            style={{ left: nodeX - r, width: r * 2, height: r * 2 }}
            onMouseEnter={(e) => {
              const b = e.currentTarget.getBoundingClientRect();
              const host = e.currentTarget.closest(".graph")!.getBoundingClientRect();
              onTip({
                text: `${row.author} <${row.email}>`,
                x: b.left - host.left + b.width / 2,
                y: b.top - host.top - 6,
              });
            }}
            onMouseLeave={() => onTip(null)}
          />
        )}
      </span>
      <span className="message">
        <span className="lane-dot" style={{ background: color }} />
        <span className="subject">{row.subject}</span>
        {showWhen && (
          <span className="when" title={new Date(row.time * 1000).toLocaleString()}>
            {when}
          </span>
        )}
      </span>
    </>
  );
}

interface Label {
  key: string;
  kind: "branch" | "tag" | "head";
  local: boolean;
  remotes: string[];
  isHead: boolean;
  change: RefChange | undefined;
  /** Short names, for the tooltip. */
  names: string[];
  /** Full ref names, for the context menu. */
  refNames: string[];
}

/**
 * One label per branch: `feat/x` and `origin/feat/x` at the same commit share
 * a chip. The checked-out branch comes first.
 */
export function groupLabels(
  row: Row,
  refIndex: Map<string, RefInfo>,
  changeIndex: Map<string, RefChange>,
  headBranch: string | null | undefined,
): Label[] {
  const labels = new Map<string, Label>();
  for (const name of row.refs) {
    const ref = refIndex.get(name);
    const kind = name === "HEAD" ? "head" : ref?.kind === "tag" ? "tag" : "branch";
    const key = ref ? `${kind}:${branchKey(ref.short, ref.kind)}` : name;
    let l = labels.get(key);
    if (!l) {
      l = {
        key: ref ? branchKey(ref.short, ref.kind) : "HEAD",
        kind,
        local: false,
        remotes: [],
        isHead: false,
        change: undefined,
        names: [],
        refNames: [],
      };
      labels.set(key, l);
    }
    l.names.push(ref?.short ?? name);
    l.refNames.push(name);
    if (ref?.kind === "local") {
      l.local = true;
      if (ref.short === headBranch) l.isHead = true;
    }
    if (ref?.kind === "remote") l.remotes.push(ref.short.split("/")[0]);
    l.change ??= changeIndex.get(name);
  }
  return [...labels.values()].sort((a, b) => Number(b.isHead) - Number(a.isHead));
}

/** One chip per branch: `feat/x` and `origin/feat/x` at the same commit merge. */
function RefLabels({
  row,
  refIndex,
  changeIndex,
  headBranch,
}: {
  row: Row;
  refIndex: Map<string, RefInfo>;
  changeIndex: Map<string, RefChange>;
  headBranch: string | null | undefined;
}) {
  if (row.refs.length === 0) return null;
  const all = groupLabels(row, refIndex, changeIndex, headBranch);
  const [first, ...rest] = all;
  const color = laneColor(row.color);

  return (
    <>
      <span
        className={`chip${first.isHead ? " head" : ""}${row.onHead ? "" : " off"}`}
        style={
          first.isHead
            ? { background: color, borderColor: color, boxShadow: `0 0 0 2px ${palette().surface}, 0 0 0 3.5px ${color}, 0 0 14px ${color}aa` }
            : { borderColor: `${color}${row.onHead ? "aa" : "55"}` }
        }
        title={all.flatMap((l) => l.names).join("\n")}
      >
        {first.isHead ? <span className="check">✓</span> : <span className="chip-dot" style={{ background: color }} />}
        {first.kind === "tag" && <TagIcon />}
        <span className="ellipsis">{first.key}</span>
        {/* Where the branch lives: remote names, or "local" when it exists only here. */}
        {first.kind !== "tag" && (
          <span className="chip-where">{first.remotes.length > 0 ? first.remotes.join(" ") : "local"}</span>
        )}
        {first.change && <ChangeDot change={first.change} />}
      </span>
      {rest.length > 0 && (
        <span className="chip more" style={{ borderColor: `${color}55` }} title={rest.flatMap((l) => l.names).join("\n")}>
          +{rest.length}
        </span>
      )}
    </>
  );
}

function WipCells({ color }: { color: string }) {
  const work = useStore((s) => s.repo?.work);
  const n = work?.dirty ?? 0;
  return (
    <>
      <span className="labels" />
      <span />
      <span className="message wip-message" style={{ color }}>
        <span className="subject">Uncommitted changes</span>
        <span className="wip-count small">
          {n} file{n === 1 ? "" : "s"}
        </span>
      </span>
    </>
  );
}

export function ChangeDot({ change }: { change: RefChange }) {
  const label =
    change.kind === "added" ? "new" : change.kind === "updated" ? (change.forced ? "forced" : "moved") : "gone";
  return <span className={`change-badge ${label}`}>{label}</span>;
}
