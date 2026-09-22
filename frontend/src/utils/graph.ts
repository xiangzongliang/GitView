// Commit DAG lane layout — assigns each commit a horizontal lane and computes
// the connecting line segments/curves, similar to classic Git GUI history graphs.
//
// Algorithm: keep an array of "expected hashes" (one slot per lane, '' = free).
// Commits arrive newest-first. A commit takes the lane that expects its hash
// (or a fresh lane when none matches — e.g. pagination boundaries). Its first
// parent continues the same lane; extra parents (merges) either join an
// existing lane that already expects them or spawn a new one. Lanes are freed
// when consumed or at root commits, and free slots are reused to keep the
// graph narrow.
//
// 修复点（泳道错乱 / 悬空竖线）：
// `git log` 默认按提交日期排序（非 topo 序），配合 `--all`、rebase 或时钟偏斜，
// 父提交可能先于其部分子提交被绘制。旧算法仍会让子提交为其「已被消费」的父
// hash 注册期望，该 lane 永远等不到消费 → 永久死 lane：图被僵尸竖线越撑越宽，
// 后续所有泳道整体右移错位，曲线跨越死线。现在用 `seated` 集合记录已绘制过的
// hash，凡是已 seated 的父提交一律不再注册期望，线直接终止在子提交的 dot 上。
// 对拓扑有序的日志（父提交总在子提交之后出现）该改动零影响。

import type { Commit } from "../api";

export const ROW_H = 30;
export const LANE_W = 12;
export const GRAPH_PAD = 10;

export interface GraphCurve {
	/** lane of the commit dot */
	from: number;
	/** lane the curve lands on at the bottom edge of the row */
	to: number;
	/**
	 * 'down' (default): dot at `from` → bottom edge at `to` (merges, collapses).
	 * 'in': top edge at `from` → dot at `to` — another lane that expected the
	 * same commit converges into it on this row (criss-cross merges / dedup).
	 */
	kind?: "down" | "in";
}

export interface GraphRow {
	commit: Commit;
	lane: number;
	/** lanes drawn as a full-height vertical line through this row */
	through: number[];
	/** draw a vertical from row top to the dot (line continues from above) */
	top: boolean;
	/** draw a vertical from the dot to row bottom (first parent continues in lane) */
	bottom: boolean;
	/** bezier curves from the dot down to another lane (merges / lane collapses) */
	curves: GraphCurve[];
	/** the commit's lane was freshly spawned on this row */
	isNew: boolean;
}

export interface GraphLayout {
	rows: GraphRow[];
	laneCount: number;
}

export interface LayoutOptions {
	/**
	 * Filtered log (e.g. --grep search): parent/child links are broken so lane
	 * layout is meaningless and dangles. Draw a simple single-lane line instead.
	 */
	sparse?: boolean;
}

export function laneX(lane: number): number {
	return GRAPH_PAD + lane * LANE_W + LANE_W / 2;
}

export function graphWidth(laneCount: number): number {
	return GRAPH_PAD * 2 + Math.max(1, laneCount) * LANE_W;
}

export function layoutGraph(
	commits: Commit[],
	opts?: LayoutOptions,
): GraphLayout {
	if (opts?.sparse) {
		const rows: GraphRow[] = commits.map((c, i) => ({
			commit: c,
			lane: 0,
			through: [],
			top: i > 0,
			bottom: i < commits.length - 1,
			curves: [],
			isNew: false,
		}));
		return { rows, laneCount: 1 };
	}

	const rows: GraphRow[] = [];
	// Expected hash per lane; '' = free. Invariants:
	// 1. at most one lane expects any given hash;
	// 2. an expectation is only ever set for a hash that has not been drawn yet
	//    (see `seated`) — so every expectation is eventually consumed, and no
	//    lane can dangle forever once the full log is laid out.
	let lanes: string[] = [];
	// Hashes whose commit has already been drawn on some row above. git log
	// orders by commit date, so a parent can appear above an (as yet unpainted)
	// child; such a child must NOT re-register its parent, or the lane would
	// never be consumed and would dangle as a zombie vertical.
	const seated = new Set<string>();
	let laneCount = 0;

	const findLane = (h: string, except = -1): number => {
		for (let i = 0; i < lanes.length; i++) {
			if (i !== except && lanes[i] === h) return i;
		}
		return -1;
	};
	// Lowest free slot ('' = free). Reusing slots freed earlier in this same
	// row (e.g. by an 'in' convergence or a first-parent collapse) is safe: the
	// slot's incoming line terminates at this row's dot, and a merge curve from
	// the same dot re-issues it below, so the rendering stays edge-continuous.
	const allocLane = (): number => {
		const free = lanes.indexOf("");
		if (free >= 0) return free;
		lanes.push("");
		return lanes.length - 1;
	};

	for (const c of commits) {
		// Occupancy at this row's TOP edge — exactly what the previous row
		// delivered at its bottom edge. (Array length may grow within the row;
		// indexing beyond it yields undefined, treated as free.)
		const prevActive: boolean[] = lanes.map((h) => h !== "");

		let lane = findLane(c.hash);
		const isNew = lane < 0;
		if (isNew) lane = allocLane();

		const curves: GraphCurve[] = [];

		// Defensive dedup: if a data anomaly (e.g. the same commit listed twice
		// after a pagination race) ever left two lanes expecting the same hash,
		// converge the extra lanes into the dot here instead of letting them
		// dangle as stray verticals.
		for (let i = 0; i < lanes.length; i++) {
			if (i !== lane && lanes[i] === c.hash) {
				lanes[i] = "";
				curves.push({ from: i, to: lane, kind: "in" });
			}
		}

		// From here on this commit is on the graph: nothing below may register
		// a fresh expectation for its hash.
		seated.add(c.hash);

		const parents = c.parents || [];
		let bottom = false;

		if (parents.length === 0) {
			// Root commit: the lane ends here, freeing the slot for reuse.
			lanes[lane] = "";
		} else {
			const p0 = parents[0];
			if (seated.has(p0)) {
				// 修复点：first parent was already drawn ABOVE this row
				// (commit-date order skew). Registering an expectation for it
				// would never be consumed — a dangling vertical plus a
				// permanently dead lane that widens the whole graph. End the
				// line at the dot instead.
				lanes[lane] = "";
			} else {
				const m = findLane(p0, lane);
				if (m >= 0) {
					// First parent is already expected on another lane: collapse
					// this lane into it (keeps parallel child lines from
					// duplicating the parent's lane).
					lanes[lane] = "";
					curves.push({ from: lane, to: m });
				} else {
					// First parent continues straight down in this lane.
					lanes[lane] = p0;
					bottom = true;
				}
			}
			// Merge parents: join an existing lane, or spawn a new one.
			// Skipped: duplicates of p0, and parents already drawn above
			// (seated) — they must not receive a curve to nowhere.
			const seen = new Set<string>([p0]);
			for (let i = 1; i < parents.length; i++) {
				const p = parents[i];
				if (seen.has(p) || seated.has(p)) continue;
				seen.add(p);
				let t = findLane(p);
				if (t < 0) {
					t = allocLane();
					lanes[t] = p;
				}
				curves.push({ from: lane, to: t });
			}
		}

		// Occupancy at this row's BOTTOM edge — what this row hands to the row
		// below. Together with prevActive ("actual occupancy at the previous
		// row's bottom / this row's top") this decides through lines.
		const nextActive: boolean[] = lanes.map((h) => h !== "");
		// Lanes with an 'in' curve terminate at the dot on this row; never draw
		// them as straight verticals even if the slot is immediately re-issued
		// below (e.g. to a merge parent) — the curve pair through the dot
		// carries the connection, a through line would mislead the eye.
		const inLanes = new Set<number>();
		for (const cv of curves) {
			if (cv.kind === "in") inLanes.add(cv.from);
		}
		// A lane is a through line only when BOTH edges are occupied: delivered
		// from above (prevActive) AND handed down below (nextActive). The own
		// lane is rendered by top/bottom/curves instead.
		const through: number[] = [];
		const max = Math.max(prevActive.length, nextActive.length);
		for (let i = 0; i < max; i++) {
			if (i === lane || inLanes.has(i)) continue;
			if (prevActive[i] && nextActive[i]) through.push(i);
		}

		// Width: highest referenced lane + 1 (dot, through lines, curve
		// endpoints), kept monotonically so the SVG never shrinks mid-history.
		let widest = lane + 1;
		for (const i of through) widest = Math.max(widest, i + 1);
		for (const cv of curves)
			widest = Math.max(widest, cv.from + 1, cv.to + 1);
		laneCount = Math.max(laneCount, widest);

		rows.push({
			commit: c,
			lane,
			through,
			top: !isNew,
			bottom,
			curves,
			isNew,
		});
	}

	return { rows, laneCount };
}
