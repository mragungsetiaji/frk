import { useStore } from "../store";

const LIMITS = {
  sidebar: { min: 200, max: 480, initial: 280 },
  detail: { min: 320, max: 900, initial: 440 },
};

/**
 * A drag handle on the edge of a side panel. `side` says which panel it
 * sizes: the sidebar grows as the handle moves right, the detail panel as it
 * moves left. Double-click restores the default width.
 */
export function Splitter({ side }: { side: "sidebar" | "detail" }) {
  const width = useStore((s) => s.panels[side]);
  const setPanels = useStore((s) => s.setPanels);
  const { min, max, initial } = LIMITS[side];

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = width;
    // Keep the graph usable however wide a panel is dragged.
    const ceiling = Math.min(max, window.innerWidth * 0.6);
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const next = side === "sidebar" ? startW + dx : startW - dx;
      setPanels({ [side]: Math.round(Math.min(ceiling, Math.max(min, next))) });
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
    <div
      className={`splitter ${side}`}
      style={side === "sidebar" ? { left: width - 3 } : { right: width - 3 }}
      role="separator"
      aria-orientation="vertical"
      aria-label={side === "sidebar" ? "Resize sidebar" : "Resize details panel"}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      onPointerDown={onPointerDown}
      onDoubleClick={() => setPanels({ [side]: initial })}
    />
  );
}
