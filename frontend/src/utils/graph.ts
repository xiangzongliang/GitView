// Commit DAG lane layout — assigns each commit a horizontal lane and computes
// the connecting line segments/curves, similar to SourceTree's history graph.
//
// Algorithm: keep an array of "expected hashes" (one slot per lane). Commits
// arrive newest-first. A commit takes the lane that expects its hash (or a new
// lane when none matches — e.g. pagination boundaries / filtered logs). Its
// first parent continues the same lane; extra parents (merges) either join an
// existing lane that already expects them or spawn a new one. Lanes are freed
// when a root commit is reached and slots are reused to keep the graph narrow.

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
	 * same commit converges into it on this row (criss-cross merges).
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
	let lanes: string[] = []; // expected hash per lane; '' = free
	let laneCount = 0;

	const findLane = (h: string, except = -1): number => {
		for (let i = 0; i < lanes.length; i++) {
			if (i !== except && lanes[i] === h) return i;
		}
		return -1;
	};
	const allocLane = (): number => {
		const free = lanes.indexOf("");
		if (free >= 0) return free;
		lanes.push("");
		return lanes.length - 1;
	};
	const activeCount = (): number => {
		let n = 0;
		for (let i = 0; i < lanes.length; i++) if (lanes[i] !== "") n = i + 1;
		return n;
	};

	for (const c of commits) {
		const prevActive: boolean[] = lanes.map((h) => h !== "");

		let lane = findLane(c.hash);
		const isNew = lane < 0;
		if (isNew) lane = allocLane();

		const curves: GraphCurve[] = [];

		// Other lanes may expect this same commit (e.g. two branches sharing a
		// parent, or criss-cross merges). They converge into `lane` here and are
		// released; without this they would dangle forever as stray verticals.
		for (let i = 0; i < lanes.length; i++) {
			if (i !== lane && lanes[i] === c.hash) {
				lanes[i] = "";
				curves.push({ from: i, to: lane, kind: "in" });
			}
		}

		const parents = c.parents || [];
		let bottom = false;

		if (parents.length === 0) {
			// Root commit: the lane ends here.
			lanes[lane] = "";
		} else {
			const p0 = parents[0];
			const m = findLane(p0, lane);
			if (m >= 0) {
				// First parent is already expected on another lane: collapse this lane
				// into it (keeps parallel lines from merging into duplicated lanes).
				lanes[lane] = "";
				curves.push({ from: lane, to: m });
			} else {
				lanes[lane] = p0;
				bottom = true;
			}
			// Merge parents: join an existing lane or spawn a new one.
			const seen = new Set<string>([p0]);
			for (let i = 1; i < parents.length; i++) {
				const p = parents[i];
				if (seen.has(p)) continue;
				seen.add(p);
				let t = findLane(p);
				if (t < 0) {
					t = allocLane();
					lanes[t] = p;
				}
				curves.push({ from: lane, to: t });
			}
		}

		const nextActive: boolean[] = lanes.map((h) => h !== "");
		// Lanes with an 'in' curve end at the dot this row; never draw them as
		// straight verticals (they may even be re-allocated for a merge parent).
		const inLanes = new Set<number>();
		for (const cv of curves) {
			if (cv.kind === "in") inLanes.add(cv.from);
		}
		const through: number[] = [];
		const max = Math.max(prevActive.length, nextActive.length);
		for (let i = 0; i < max; i++) {
			if (i === lane || inLanes.has(i)) continue;
			if (prevActive[i] && nextActive[i]) through.push(i);
		}

		laneCount = Math.max(laneCount, activeCount(), lane + 1);
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
