import { api, Row } from "../api";

const PAGE = 200;

/**
 * Rows of the current graph, fetched from Rust a page at a time as they scroll
 * into view. One cache lives for one graph build; a rebuild makes a new one, so
 * a page that lands after a rebuild is simply dropped with its cache.
 */
export class RowCache {
  private rows = new Map<number, Row>();
  private pending = new Set<number>();
  private dead = false;

  constructor(private onLoad: () => void) {}

  get(i: number): Row | undefined {
    return this.rows.get(i);
  }

  ensure(start: number, end: number) {
    for (let p = Math.floor(start / PAGE); p * PAGE < end; p++) {
      if (this.pending.has(p) || this.rows.has(p * PAGE)) continue;
      this.pending.add(p);
      api
        .graphRows(p * PAGE, (p + 1) * PAGE)
        .then((rows) => {
          if (this.dead) return;
          rows.forEach((r, k) => this.rows.set(p * PAGE + k, r));
          this.onLoad();
        })
        .finally(() => this.pending.delete(p));
    }
  }

  dispose() {
    this.dead = true;
  }
}
