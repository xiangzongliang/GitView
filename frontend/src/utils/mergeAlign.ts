/**
 * 三方合并视图的行对齐工具。
 *
 * 三个面板：
 * - B = ours（当前分支完整文件内容）
 * - C = theirs（传入分支完整文件内容）
 * - D = worktree（含 <<<<<<< / ======= / >>>>>>> 冲突标记的合并结果）
 *
 * 对齐策略（无需 diff 库）：
 * 1. 解析 D 中的冲突块（hunk），每个 hunk 的 ours 段文本理论上逐行存在于 B、
 *    theirs 段逐行存在于 C —— 用「顺序精确搜索」在 B/C 中定位这些文本块
 *    （搜索游标单调递增，冲突块本身在文件中也是升序的）；
 * 2. 由定位结果生成一组三元锚点 {d, b, c}（hunk 边界 + 文件首尾）；
 * 3. 锚点之间用比例插值映射行号：hunk 内部 D 与 B/C 行数相等（1:1），
 *    hunk 之间的公共区域行数可能因单侧干净修改而漂移，插值可平滑处理；
 * 4. 锚点做单调性归一化，保证 mapLine 单调不减、越界自动 clamp。
 */

/** D 中的一个冲突块（行号均 0 起、指向 D） */
export interface Hunk {
	/** "<<<<<<<" 所在行号 */
	start: number;
	/** "=======" 所在行号 */
	mid: number;
	/** ">>>>>>>" 所在行号 */
	end: number;
	/** 行数（含三行标记） */
	size: number;
}

const OURS_RE = /^<{7}/;
const SEP_RE = /^={7}/;
const THEIRS_RE = /^>{7}/;

/** 扫描带冲突标记的文本，返回全部完整冲突块（残缺标记跳过） */
export function parseHunks(src: string): Hunk[] {
	const lines = src.split("\n");
	const out: Hunk[] = [];
	let i = 0;
	while (i < lines.length) {
		if (OURS_RE.test(lines[i]!)) {
			const start = i;
			let mid = -1;
			let end = -1;
			let j = i + 1;
			while (j < lines.length) {
				if (mid < 0 && SEP_RE.test(lines[j]!)) mid = j;
				else if (THEIRS_RE.test(lines[j]!)) {
					end = j;
					break;
				}
				j++;
			}
			if (mid > start && end > mid) {
				out.push({ start, mid, end, size: end - start + 1 });
				i = end + 1;
			} else {
				i++; // 残缺的标记（用户手改过），跳过继续
			}
		} else {
			i++;
		}
	}
	return out;
}

/** 面板标识：b=ours、c=theirs、d=worktree 合并结果 */
export type PaneId = "b" | "c" | "d";

/** 三元锚点：同一逻辑位置在三个面板中的行号 */
interface Anchor {
	b: number;
	c: number;
	d: number;
}

export interface MergeAlign {
	/** 把 src 面板的行号映射到 dst 面板（单调、自动 clamp） */
	mapLine(src: PaneId, dst: PaneId, line: number): number;
	/** B 面板中属于冲突区域（ours 段）的行号（0 起） */
	marksB: number[];
	/** C 面板中属于冲突区域（theirs 段）的行号 */
	marksC: number[];
	/** D 面板中属于冲突块（含三行标记）的行号 */
	marksD: number[];
	/** 每个冲突块在 B/C/D 三面板中的定位行（0 起）：
	 *  b/c = ours/theirs 段首行（在对应分支文件中的实际位置），
	 *  d = "<<<<<<<" 标记行；与传入的 hunks 一一对应 */
	hunkLines: { b: number; c: number; d: number }[];
}

function toLines(s: string): string[] {
	return s === "" ? [] : s.split("\n");
}

function clamp(v: number, len: number): number {
	return Math.max(0, Math.min(v, len));
}

/**
 * 在 lines 中从 from 起顺序查找与 block 逐行完全相等的位置。
 * 找不到时回退到游标位置（保持映射单调，不至于乱跳）。
 */
function findBlock(
	lines: string[],
	block: string[],
	from: number,
): { pos: number; found: boolean } {
	const start = Math.max(0, Math.min(from, lines.length));
	if (block.length === 0) return { pos: start, found: true };
	outer: for (let i = start; i + block.length <= lines.length; i++) {
		for (let j = 0; j < block.length; j++) {
			if (lines[i + j] !== block[j]) continue outer;
		}
		return { pos: i, found: true };
	}
	return { pos: start, found: false };
}

/**
 * 由 D 的当前内容与 B/C 完整内容构建对齐模型。
 * hunks 必须是基于 dText 解析出的冲突块（parseHunks）。
 */
export function buildMergeAlign(
	dText: string,
	bText: string,
	cText: string,
	hunks: Hunk[],
): MergeAlign {
	const dl = dText.split("\n");
	const bl = toLines(bText);
	const cl = toLines(cText);
	const lens: Record<PaneId, number> = {
		b: bl.length,
		c: cl.length,
		d: dl.length,
	};

	const anchors: Anchor[] = [{ b: 0, c: 0, d: 0 }];
	const marksB: number[] = [];
	const marksC: number[] = [];
	const marksD: number[] = [];
	const hunkLines: { b: number; c: number; d: number }[] = [];

	// B/C 中的顺序搜索游标
	let cursorB = 0;
	let cursorC = 0;
	for (const h of hunks) {
		const ours = dl.slice(h.start + 1, h.mid);
		const theirs = dl.slice(h.mid + 1, h.end);
		const rb = findBlock(bl, ours, cursorB);
		const rc = findBlock(cl, theirs, cursorC);
		const bLine = rb.pos;
		const cLine = rc.pos;
		cursorB = bLine + ours.length;
		cursorC = cLine + theirs.length;
		hunkLines.push({ b: bLine, c: cLine, d: h.start });

		for (let i = 0; i < ours.length; i++) marksB.push(bLine + i);
		for (let i = 0; i < theirs.length; i++) marksC.push(cLine + i);
		for (let i = h.start; i <= h.end; i++) marksD.push(i);

		const bEnd = bLine + ours.length;
		const cEnd = cLine + theirs.length;
		// hunk 六个边界锚点：标记行与其后内容行分别对齐块的起止
		anchors.push(
			{ d: h.start, b: bLine, c: cLine },
			{ d: h.start + 1, b: bLine, c: cLine },
			{ d: h.mid, b: bEnd, c: cLine },
			{ d: h.mid + 1, b: bEnd, c: cLine },
			{ d: h.end, b: bEnd, c: cEnd },
			{ d: h.end + 1, b: bEnd, c: cEnd },
		);
	}
	anchors.push({ d: dl.length, b: bl.length, c: cl.length });

	// 单调性归一化：D 中找不到精确匹配时回退位置可能导致倒挂，
	// 逐维强制非降，保证 mapLine 单调、插值区间非负。
	for (let i = 1; i < anchors.length; i++) {
		const p = anchors[i - 1]!;
		const a = anchors[i]!;
		if (a.d < p.d) a.d = p.d;
		if (a.b < p.b) a.b = p.b;
		if (a.c < p.c) a.c = p.c;
	}

	function mapLine(src: PaneId, dst: PaneId, line: number): number {
		const x = clamp(line, lens[src]);
		if (src === dst) return x;
		// 找最后一个 anchors[i][src] <= x 的锚点段做比例插值
		let i = 0;
		const n = anchors.length;
		while (i + 1 < n && anchors[i + 1]![src] <= x) i++;
		const a1 = anchors[i]!;
		const a2 = anchors[i + 1];
		if (!a2) return clamp(a1[dst], lens[dst]);
		const span = a2[src] - a1[src];
		if (span <= 0) return clamp(a1[dst], lens[dst]);
		const ratio = (x - a1[src]) / span;
		return clamp(
			Math.round(a1[dst] + ratio * (a2[dst] - a1[dst])),
			lens[dst],
		);
	}

	return { mapLine, marksB, marksC, marksD, hunkLines };
}
