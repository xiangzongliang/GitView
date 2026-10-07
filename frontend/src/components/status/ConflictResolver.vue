<script setup lang="ts">
// 冲突解决器（选中冲突文件时的默认视图）。
//
// 三种视图：
// - 三方合并（默认）：三窗格布局 —— 上方 B（当前分支完整内容，只读）与
//   C（传入分支完整内容，只读）左右对照，下方 D（合并结果，可编辑）。
//   三个窗格都显示全量文件内容，冲突区域按面板着色高亮（B 绿 / C 蓝 / D 黄）；
//   窗格之间的分割条可拖拽调整宽/高；三窗格按行对齐映射同步滚动；
//   每个冲突块位置内联悬浮「保留 xxx」芯片：B/C 面板各自提供单侧取舍，
//   D 面板提供「保留 B / 保留 C / 保留两者」；工具条冲突徽章可点击跳回首个冲突。
// - 冲突对比：保留原有的 diff 对比显示。
// - 源码编辑：直接编辑带冲突标记的原始文件（与 D 共享同一份内容）。
//
// 冲突块解析始终以 D 的当前内容为准（扫描 <<<<<<< / ======= / >>>>>>> 标记），
// 因此手动编辑 D 之后快捷按钮依然定位准确。
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";
import { useRepo } from "../../stores/repo";
import { useUI } from "../../stores/ui";
import { errMsg, GitService } from "../../api";
import type { ConflictDetail } from "../../api";
import DiffViewer from "../common/DiffViewer.vue";
import Icon from "../ui/Icon.vue";
import Spinner from "../ui/Spinner.vue";
import {
	CODER_DEFAULT_FONT_SIZE,
	CoderView,
	clampFontSize,
	coderLineHeight,
} from "../Coder";
import {
	buildMergeAlign,
	parseHunks,
	type Hunk,
	type PaneId,
} from "../../utils/mergeAlign";

const props = defineProps<{ path: string }>();

const repo = useRepo();
const ui = useUI();

type Mode = "merge3" | "diff" | "source";
const MODE_KEY = "gv.conflictMode";
const mode = ref<Mode>(loadMode());
/** 三方合并是默认的冲突解决形式（用户上次显式选择的视图仍会记住） */
function loadMode(): Mode {
	const saved = localStorage.getItem(MODE_KEY);
	return saved === "diff" || saved === "source" ? saved : "merge3";
}
function setMode(m: Mode) {
	mode.value = m;
	try {
		localStorage.setItem(MODE_KEY, m);
	} catch {
		/* ignore */
	}
}

const loading = ref(false);
const saving = ref(false);
const detail = ref<ConflictDetail | null>(null);
const loadError = ref("");

/** D：合并结果（= 工作区文件当前内容），唯一数据源 */
const text = ref("");
/** 已保存到磁盘的内容快照，用于「未保存」提示 */
const savedText = ref("");

const dirty = computed(() => text.value !== savedText.value);

const oursLabel = computed(() => detail.value?.ours.label || "当前分支");
const theirsLabel = computed(() => detail.value?.theirs.label || "传入分支");

// ------------------------------------------------------------- 冲突块解析 / 行对齐

const hunks = computed(() => parseHunks(text.value));
const resolvedAll = computed(
	() =>
		!loading.value &&
		!loadError.value &&
		!binaryConflict.value &&
		hunks.value.length === 0,
);

/** B/C/D 三面板的行号映射与冲突区域高亮行（随 text / detail 实时重算） */
const align = computed(() =>
	buildMergeAlign(
		text.value,
		detail.value?.ours.content ?? "",
		detail.value?.theirs.content ?? "",
		hunks.value,
	),
);

function lines(): string[] {
	return text.value.split("\n");
}
function commit(ls: string[]) {
	text.value = ls.join("\n");
}
/** 空字符串对应「该侧没有内容」，替换时不应留下一行空行 */
function toLines(s: string): string[] {
	return s === "" ? [] : s.split("\n");
}

/** 某个冲突块某一侧的文本 */
function sideText(h: Hunk, which: "ours" | "theirs"): string {
	const ls = lines();
	const from = which === "ours" ? h.start + 1 : h.mid + 1;
	const to = which === "ours" ? h.mid : h.end;
	return ls.slice(from, to).join("\n");
}

// ------------------------------------------------------------- 块级操作

/** 用一侧内容替换整个冲突块（保留 ours / 保留 theirs） */
function takeSide(h: Hunk, which: "ours" | "theirs") {
	const ls = lines();
	ls.splice(h.start, h.size, ...toLines(sideText(h, which)));
	commit(ls);
}
/** 保留两侧：ours 在前、theirs 在后 */
function takeBoth(h: Hunk) {
	const ls = lines();
	const repl = toLines(sideText(h, "ours")).concat(
		toLines(sideText(h, "theirs")),
	);
	ls.splice(h.start, h.size, ...repl);
	commit(ls);
}

/** 全文件快捷：全部保留某一侧（从后往前替换，避免行号漂移） */
function takeAll(which: "ours" | "theirs") {
	flushEditors();
	const hs = hunks.value;
	for (let i = hs.length - 1; i >= 0; i--) takeSide(hs[i]!, which);
}

/** 解决第 i 个冲突块（内联芯片）：随后定位到同一索引的冲突（即「下一个」） */
function resolveHunkAt(i: number, which: "ours" | "theirs" | "both") {
	// Coder 的 change 有 400ms debounce：先把待上抛的编辑落回 text
	flushEditors();
	const h = hunks.value[i];
	if (!h) return;
	if (which === "both") takeBoth(h);
	else takeSide(h, which);
	// text 已同步更新，hunks 立即重算：原位置的冲突块已消失，
	// 同一索引即「下一个冲突」
	const hs = hunks.value;
	active.value = hs.length === 0 ? 0 : Math.min(i, hs.length - 1);
	if (hs.length > 0) scheduleScrollToHunk(active.value);
}

/** 延迟到宏任务再滚动：确保在 Coder 重载内容（其 loadContent 的 nextTick
 *  中重置/恢复滚动位置）之后执行，否则定位会被内部滚动复位覆盖 */
function scheduleScrollToHunk(i: number) {
	setTimeout(() => scrollToHunk(i), 0);
}

// ------------------------------------------------------------- 编辑器实例 / 同步滚动

/** CoderView 通过 defineExpose 暴露的滚动控制接口 */
interface CoderInst {
	focus(): void;
	flush(): void;
	setScroll(top: number, left?: number): { top: number; left: number };
	lineAtScrollTop(top: number): number;
	scrollTopForLine(line: number): number;
	lineHeightPx(): number;
	fontSizePx(): number;
}

const bCoder = ref<CoderInst | null>(null);
const cCoder = ref<CoderInst | null>(null);
const dCoder = ref<CoderInst | null>(null);
/** 源码编辑模式的编辑器（与 D 共享 text，二者同时只挂载一个） */
const srcCoder = ref<CoderInst | null>(null);

const PANES: PaneId[] = ["b", "c", "d"];
function coderOf(p: PaneId): CoderInst | null {
	return p === "b" ? bCoder.value : p === "c" ? cCoder.value : dCoder.value;
}

/** 把 Coder debounce 中尚未上抛的编辑立即写回 text（读写 text 前必须调用） */
function flushEditors() {
	dCoder.value?.flush();
	srcCoder.value?.flush();
}

// ------------------------------------------------------------- 编辑器字号（本地偏好）

const FONT_KEY = "gv.coder.fontSize";
/** 字号仅作用于 Coder 内部排版，不影响应用全局字号；默认与应用标准字号一致 */
const fontSize = ref(loadFontSize());

function loadFontSize(): number {
	try {
		const n = Number(localStorage.getItem(FONT_KEY));
		if (Number.isFinite(n) && n > 0) return clampFontSize(n);
	} catch {
		/* ignore */
	}
	return CODER_DEFAULT_FONT_SIZE;
}

function onFontSizeChange(size: number) {
	fontSize.value = size;
	try {
		localStorage.setItem(FONT_KEY, String(size));
	} catch {
		/* ignore */
	}
}

/** 当前 Coder 行高（px）：与 Coder 内部度量一致，供芯片定位与滚动留白估算 */
const linePx = computed(() => coderLineHeight(fontSize.value));

const active = ref(0);
const activeHunk = computed(() => hunks.value[active.value]);

watch(hunks, (hs) => {
	if (active.value >= hs.length) active.value = Math.max(0, hs.length - 1);
});

/** 依据 D 面板视口首行更新「当前冲突块」（滚动联动，不触发滚动） */
function updateActive(dLine: number) {
	const hs = hunks.value;
	if (hs.length === 0) return;
	let idx = hs.findIndex((h) => dLine <= h.end);
	if (idx < 0) idx = hs.length - 1;
	active.value = idx;
}

let syncing = false;

/** 各面板当前滚动偏移（px）：程序化滚动不会回传 scroll 事件，
 *  由 pushSync / scrollToHunk / onPaneScroll 主动记录，供内联芯片定位 */
const paneScroll = reactive<Record<PaneId, { top: number; left: number }>>({
	b: { top: 0, left: 0 },
	c: { top: 0, left: 0 },
	d: { top: 0, left: 0 },
});

/** 各面板主体视口高度（px）：芯片裁剪用（只渲染视口内的芯片） */
const paneH = reactive<Record<PaneId, number>>({ b: 0, c: 0, d: 0 });

const paneBodyElB = ref<HTMLElement | null>(null);
const paneBodyElC = ref<HTMLElement | null>(null);
const paneBodyElD = ref<HTMLElement | null>(null);

let paneROs: ResizeObserver[] = [];
watch(
	() =>
		[
			paneBodyElB.value,
			paneBodyElC.value,
			paneBodyElD.value,
		] as (HTMLElement | null)[],
	(els) => {
		for (const ro of paneROs) ro.disconnect();
		paneROs = [];
		els.forEach((el, i) => {
			const id = PANES[i]!;
			if (!el) {
				paneH[id] = 0;
				return;
			}
			paneH[id] = el.clientHeight;
			const ro = new ResizeObserver(() => {
				paneH[id] = el.clientHeight;
			});
			ro.observe(el);
			paneROs.push(ro);
		});
	},
	{ flush: "post" },
);
onBeforeUnmount(() => {
	for (const ro of paneROs) ro.disconnect();
	paneROs = [];
});

/** 把 src 面板的滚动位置按行映射推送到其余面板（程序化滚动不会再回传） */
function pushSync(src: PaneId, top: number, left?: number) {
	const s = coderOf(src);
	if (!s) return;
	const srcLine = s.lineAtScrollTop(top);
	const frac = top - s.scrollTopForLine(srcLine);
	const a = align.value;
	for (const dst of PANES) {
		if (dst === src) continue;
		const t = coderOf(dst);
		if (!t) continue;
		const actual = t.setScroll(
			t.scrollTopForLine(a.mapLine(src, dst, srcLine)) + frac,
			left,
		);
		// setScroll 不触发 scroll 事件：在此记录实际位置供芯片定位
		paneScroll[dst].top = actual.top;
		paneScroll[dst].left = actual.left;
	}
}

/** 任一面板滚动：记录自身偏移 + 更新当前冲突块 + 同步其余两个面板 */
function onPaneScroll(src: PaneId, top: number, left: number) {
	paneScroll[src].top = top;
	paneScroll[src].left = left;
	if (syncing) return;
	syncing = true;
	try {
		const s = coderOf(src);
		if (s) {
			const srcLine = s.lineAtScrollTop(top);
			const dLine =
				src === "d" ? srcLine : align.value.mapLine(src, "d", srcLine);
			updateActive(dLine);
		}
		pushSync(src, top, left);
	} finally {
		syncing = false;
	}
}

/** 上一个 / 下一个冲突（工具条导航） */
function goto(idx: number) {
	const hs = hunks.value;
	if (hs.length === 0) return;
	active.value = (idx + hs.length) % hs.length;
	scrollToHunk(active.value);
}

/** 三窗格同步滚动到第 i 个冲突块（顶部留 2 行余量） */
function scrollToHunk(i: number) {
	const h = hunks.value[i];
	if (!h) return;
	const d = dCoder.value;
	const a = align.value;
	const pad = 2 * linePx.value;
	if (d) {
		const top = Math.max(0, d.scrollTopForLine(h.start) - pad);
		const actual = d.setScroll(top);
		paneScroll.d.top = actual.top;
		paneScroll.d.left = actual.left;
		pushSync("d", actual.top);
	} else if (srcCoder.value) {
		srcCoder.value.setScroll(
			Math.max(0, srcCoder.value.scrollTopForLine(h.start) - pad),
		);
	} else {
		// merge3 尚未挂载 D（理论上不会发生）：仅同步 B/C
		for (const id of ["b", "c"] as const) {
			const t = coderOf(id);
			if (!t) continue;
			const actual = t.setScroll(
				Math.max(
					0,
					t.scrollTopForLine(a.mapLine("d", id, h.start)) - pad,
				),
			);
			paneScroll[id].top = actual.top;
			paneScroll[id].left = actual.left;
		}
	}
}

// ------------------------------------------------------------- 拖拽分割条

const SPLIT_KEY = "gv.merge3.split";
/** 面板最小宽度（px） */
const MIN_W = 140;
/** 面板最小高度（px） */
const MIN_H = 80;

/** B 面板宽度百分比（上方左右分割） */
const splitX = ref(50);
/** 上方 B/C 区域高度百分比（上下分割） */
const splitY = ref(50);
const dragging = ref<"" | "x" | "y">("");
const bodyEl = ref<HTMLElement | null>(null);
const topEl = ref<HTMLElement | null>(null);

(function loadSplit() {
	try {
		const raw = localStorage.getItem(SPLIT_KEY);
		if (!raw) return;
		const v = JSON.parse(raw) as { x?: number; y?: number };
		if (typeof v.x === "number" && v.x >= 5 && v.x <= 95)
			splitX.value = v.x;
		if (typeof v.y === "number" && v.y >= 5 && v.y <= 95)
			splitY.value = v.y;
	} catch {
		/* ignore */
	}
})();

function persistSplit() {
	try {
		localStorage.setItem(
			SPLIT_KEY,
			JSON.stringify({
				x: Math.round(splitX.value * 10) / 10,
				y: Math.round(splitY.value * 10) / 10,
			}),
		);
	} catch {
		/* ignore */
	}
}

/** 通用拖拽：把指针位置换算成百分比并按最小像素约束 clamp */
function startDrag(
	axis: "x" | "y",
	host: HTMLElement | null,
	minPx: number,
	target: { value: number },
	e: PointerEvent,
) {
	if (!host) return;
	e.preventDefault();
	dragging.value = axis;
	const rect = host.getBoundingClientRect();
	const total = axis === "x" ? rect.width : rect.height;
	if (total <= 0) {
		dragging.value = "";
		return;
	}
	const minPct = Math.min(45, (minPx / total) * 100);
	const onMove = (ev: PointerEvent) => {
		const pos =
			axis === "x" ? ev.clientX - rect.left : ev.clientY - rect.top;
		const pct = (pos / total) * 100;
		target.value = Math.max(minPct, Math.min(100 - minPct, pct));
	};
	const onUp = () => {
		dragging.value = "";
		window.removeEventListener("pointermove", onMove);
		window.removeEventListener("pointerup", onUp);
		persistSplit();
	};
	window.addEventListener("pointermove", onMove);
	window.addEventListener("pointerup", onUp);
}

function startDragX(e: PointerEvent) {
	startDrag("x", topEl.value, MIN_W, splitX, e);
}
function startDragY(e: PointerEvent) {
	startDrag("y", bodyEl.value, MIN_H, splitY, e);
}

const dragClass = computed(() =>
	dragging.value === "x" ? "drag-x" : dragging.value === "y" ? "drag-y" : "",
);

// ------------------------------------------------------------- Coder 主题（按面板的冲突高亮色）

/** Coder 基础色桥接：把 GitView 全局 token 映射为 Coder 期望的变量
 *  （组件内部光标 / 查找面板等处还有 --foreground 等裸引用，必须由外部传入） */
const coderBase: Record<string, string> = {
	"--background": "var(--bg-app)",
	"--foreground": "var(--text)",
	"--muted": "var(--bg-panel-2)",
	"--muted-foreground": "var(--text-dim)",
	"--primary": "var(--accent)",
};

/** 冲突高亮色：B 绿（ours）/ C 蓝（theirs）/ D 黄（冲突块） */
const bTheme: Record<string, string> = {
	...coderBase,
	"--ed-mark-bg": "color-mix(in oklab, var(--green) 14%, transparent)",
	"--ed-mark-bar": "var(--green)",
};
const cTheme: Record<string, string> = {
	...coderBase,
	"--ed-mark-bg": "color-mix(in oklab, var(--accent) 14%, transparent)",
	"--ed-mark-bar": "var(--accent)",
};
const dTheme: Record<string, string> = {
	...coderBase,
	"--ed-mark-bg": "color-mix(in oklab, var(--yellow) 13%, transparent)",
	"--ed-mark-bar": "var(--yellow)",
};

// ------------------------------------------------------------- 内联冲突芯片

/** Coder 内容区上内边距（px）：与 Coder 的 --ed-pad-y 一致 */
const CODE_PAD_Y = 8;

interface HunkChip {
	/** 冲突块序号（hunks 下标） */
	idx: number;
	/** 芯片中心 y（面板视口坐标，px） */
	top: number;
}

/** 三个面板中每个冲突块的内联「保留 xxx」芯片位置：
 *  锚在冲突区域垂直中心，视口外的不渲染（随滚动/字号/内容变化重算） */
const chipsAll = computed<Record<PaneId, HunkChip[]>>(() => {
	const out: Record<PaneId, HunkChip[]> = { b: [], c: [], d: [] };
	const hs = hunks.value;
	if (hs.length === 0) return out;
	const lh = linePx.value;
	const lines = align.value.hunkLines;
	hs.forEach((h, i) => {
		const l = lines[i];
		if (!l) return;
		// 各面板中该冲突块的定位行与占行数（B=ours 段 / C=theirs 段 / D=整块）
		const span: Record<PaneId, { line: number; rows: number }> = {
			b: { line: l.b, rows: Math.max(1, h.mid - h.start - 1) },
			c: { line: l.c, rows: Math.max(1, h.end - h.mid - 1) },
			d: { line: h.start, rows: h.size },
		};
		for (const p of PANES) {
			const s = span[p]!;
			const y = CODE_PAD_Y + s.line * lh - paneScroll[p].top;
			const top = y + (s.rows * lh) / 2;
			// 视口裁剪：中心点离屏太远的不渲染（留 24px 余量避免边缘闪现）
			if (paneH[p] > 0 && (top < -24 || top > paneH[p] + 24)) continue;
			out[p]!.push({ idx: i, top });
		}
	});
	return out;
});

// ------------------------------------------------------------- 加载 / 保存

/** D 面板重载时是否保留滚动：切换文件时临时关闭（回到顶部），其余保留 */
const dPreserve = ref(true);

async function load(keepText = false) {
	// 先把编辑器 debounce 中未上抛的编辑落回 text（脏检查 / keepText 依赖它）
	flushEditors();
	if (!props.path) return;
	loading.value = true;
	loadError.value = "";
	const prev = keepText ? text.value : "";
	if (!keepText) {
		dPreserve.value = false;
		// 切换文件：各窗格回到顶部，芯片定位基准同步归零
		for (const p of PANES) {
			paneScroll[p].top = 0;
			paneScroll[p].left = 0;
		}
	}
	try {
		const d = await GitService.ConflictDetail(repo.path, props.path);
		detail.value = d;
		text.value = d?.worktree ?? "";
		savedText.value = text.value;
		if (keepText && prev) text.value = prev;
		active.value = 0;
	} catch (e) {
		loadError.value = errMsg(e);
		ui.error("加载冲突详情失败", loadError.value);
	} finally {
		loading.value = false;
	}
	if (!keepText) {
		// 宏任务：确保在 Coder 完成内容重载与内部滚动复位之后，
		// 再恢复 preserve 开关并定位到第一个冲突块
		setTimeout(() => {
			dPreserve.value = true;
			if (!loadError.value && hunks.value.length > 0) scrollToHunk(0);
		}, 0);
	}
}

/** 切换文件时有未保存的冲突处理：确认后再放弃 */
watch(
	() => props.path,
	async (p, old) => {
		if (p === old) return;
		flushEditors();
		if (dirty.value && old) {
			const ok = await ui.confirm({
				title: "放弃未保存的冲突处理？",
				message: "当前文件的冲突处理尚未保存，切换后将丢失这些修改。",
				confirmLabel: "放弃修改",
				danger: true,
			});
			if (!ok) {
				void repo.selectStatusFile({
					path: old,
					staged: false,
					group: "conflicted",
				});
				return;
			}
		}
		void load();
	},
);
// 冲突状态被外部刷新掉（如已暂存标记解决）时重新加载详情
watch(
	() => repo.status?.conflicted?.map((f) => f.path).join("\x00"),
	(list, old) => {
		if (list === old) return;
		if (list?.includes(props.path)) void load(true);
	},
);

void load();

/** 保存到工作区；markResolved 时顺带暂存标记冲突已解决 */
async function save(markResolved = false) {
	if (!props.path || saving.value) return;
	flushEditors();
	if (markResolved && hunks.value.length > 0) {
		const ok = await ui.confirm({
			title: "仍有未解决的冲突块",
			message:
				"文件中还包含冲突标记，确定按当前内容直接标记为已解决并暂存吗？",
			confirmLabel: "仍然标记",
			danger: true,
		});
		if (!ok) return;
	}
	saving.value = true;
	try {
		await GitService.WriteWorktreeFile(repo.path, props.path, text.value);
		savedText.value = text.value;
		if (markResolved) {
			await repo.stagePaths([props.path]);
			ui.success("已标记为已解决");
		} else {
			await repo.refreshStatus();
			// 重新选中以刷新「冲突对比」视图的 diff
			void repo.selectStatusFile({
				path: props.path,
				staged: false,
				group: "conflicted",
			});
			ui.success("已保存");
		}
	} catch (e) {
		ui.error("保存失败", errMsg(e));
	} finally {
		saving.value = false;
	}
}

/** 整文件取某一侧（写入 + 暂存，一次完成） */
async function takeWhole(side: "ours" | "theirs") {
	if (!props.path) return;
	const ok = await repo.runOp(
		side === "ours"
			? "保留 " + oursLabel.value
			: "保留 " + theirsLabel.value,
		() => GitService.ResolveConflictTakeSide(repo.path, props.path, side),
		{ key: "conflict" },
	);
	if (ok !== null) void load();
}

const opSideBusy = computed(() => ui.isOp("conflict"));

// 二进制 / 单侧缺失的冲突：没有可编辑文本，只能整文件取舍
const binaryConflict = computed(() => !!detail.value?.binary);
const showSideEditors = computed(() => !binaryConflict.value && !!detail.value);
/** 一侧没有该文件（新增/删除型冲突）：没有冲突标记可解析，只能整文件取舍 */
const sideMissing = computed(
	() =>
		!!detail.value &&
		hunks.value.length === 0 &&
		(!detail.value.ours.exists || !detail.value.theirs.exists),
);
const sideMissingText = computed(() => {
	const d = detail.value;
	if (!d) return "";
	return !d.ours.exists
		? oursLabel.value + " 分支中不存在此文件（或已删除）"
		: theirsLabel.value + " 分支中不存在此文件（或已删除）";
});
</script>

<template>
	<div class="resolver">
		<!-- 工具条 -->
		<div class="bar">
			<div class="file">
				<Icon name="alert" :size="13" class="warn" />
				<span class="mono ellip">{{ path }}</span>
				<span
					v-if="hunks.length > 0"
					class="badge warn-badge clickable"
					title="剩余未解决的冲突块（点击跳到第一个）"
					@click="goto(0)"
				>
					冲突 {{ hunks.length }}
				</span>
				<span v-else-if="resolvedAll" class="badge ok-badge">
					冲突已全部处理
				</span>
				<span
					v-if="dirty"
					class="badge dirty-badge"
					title="有未保存的修改"
				>
					未保存
				</span>
			</div>

			<div class="modes">
				<button
					class="mode-btn"
					:class="{ on: mode === 'merge3' }"
					title="B / C 分支全文对照 + 合并结果编辑（默认）"
					@click="setMode('merge3')"
				>
					三方合并
				</button>
				<button
					class="mode-btn"
					:class="{ on: mode === 'diff' }"
					title="以 diff 对比形式查看冲突"
					@click="setMode('diff')"
				>
					冲突对比
				</button>
				<button
					class="mode-btn"
					:class="{ on: mode === 'source' }"
					title="直接编辑带冲突标记的原始文件"
					@click="setMode('source')"
				>
					源码编辑
				</button>
			</div>

			<div class="actions">
				<template v-if="mode === 'merge3' && showSideEditors">
					<button
						class="btn take-ours"
						:disabled="hunks.length === 0"
						:title="'全部冲突块都保留 ' + oursLabel + ' 的内容'"
						@click="takeAll('ours')"
					>
						全部保留 {{ oursLabel }}
					</button>
					<button
						class="btn take-theirs"
						:disabled="hunks.length === 0"
						:title="'全部冲突块都保留 ' + theirsLabel + ' 的内容'"
						@click="takeAll('theirs')"
					>
						全部保留 {{ theirsLabel }}
					</button>
					<div class="nav">
						<button
							class="btn btn-icon"
							:disabled="hunks.length === 0"
							title="上一个冲突"
							@click="goto(active - 1)"
						>
							<Icon name="chevron-up" :size="13" />
						</button>
						<button
							class="btn btn-icon"
							:disabled="hunks.length === 0"
							title="下一个冲突"
							@click="goto(active + 1)"
						>
							<Icon name="chevron-down" :size="13" />
						</button>
					</div>
				</template>
				<button
					class="btn"
					:disabled="saving || !dirty"
					title="把当前内容写入工作区文件"
					@click="save(false)"
				>
					<Spinner v-if="saving" :size="12" />
					<Icon v-else name="check" :size="12" />
					保存
				</button>
				<button
					class="btn btn-primary"
					:disabled="saving"
					title="写入文件并暂存，标记冲突已解决"
					@click="save(true)"
				>
					<Icon name="check" :size="12" />
					已解决，暂存
				</button>
			</div>
		</div>

		<div v-if="loading" class="empty-hint">
			<span class="spinner" />
			<span>加载冲突详情…</span>
		</div>

		<div v-else-if="loadError" class="empty-hint">
			<Icon name="alert" :size="18" />
			<span>加载冲突详情失败：{{ loadError }}</span>
		</div>

		<!-- 二进制文件冲突：无法对照编辑，只能整文件取舍 -->
		<div v-else-if="binaryConflict" class="empty-hint binary">
			<Icon name="alert" :size="20" />
			<p>二进制文件存在冲突，无法对照编辑</p>
			<div class="bin-actions">
				<button
					class="btn take-ours"
					:disabled="opSideBusy"
					@click="takeWhole('ours')"
				>
					保留 {{ oursLabel }}
				</button>
				<button
					class="btn take-theirs"
					:disabled="opSideBusy"
					@click="takeWhole('theirs')"
				>
					保留 {{ theirsLabel }}
				</button>
			</div>
			<p class="hint">选择一侧后将写入文件并自动暂存（标记已解决）</p>
		</div>

		<!-- 冲突对比：保留原有 diff 视图 -->
		<DiffViewer
			v-else-if="mode === 'diff'"
			:raw="repo.fileDiff"
			:loading="repo.fileDiffLoading"
			:filename="path"
			empty-text="没有差异"
		/>

		<!-- 源码编辑：直接编辑原始文件（与 D 共享内容） -->
		<div v-else-if="mode === 'source'" class="source-wrap">
			<div class="pane-head">
				<span class="pane-title">
					<Icon name="edit" :size="12" />
					编辑冲突文件（含冲突标记）
				</span>
				<span class="legend">
					<span class="lg ours">B · {{ oursLabel }}</span>
					<span class="lg theirs">C · {{ theirsLabel }}</span>
					<span
						v-if="hunks.length"
						class="lg warn clickable"
						title="点击跳到第一个冲突"
						@click="goto(0)"
					>
						剩余冲突 {{ hunks.length }}
					</span>
				</span>
			</div>
			<div class="pane-body">
				<CoderView
					ref="srcCoder"
					class="pane-coder"
					:data="text"
					:filename="path"
					preserve-scroll
					:marked-lines="align.marksD"
					:theme-vars="dTheme"
					:font-size="fontSize"
					@change="text = $event"
					@save="save(false)"
					@font-size-change="onFontSizeChange"
				/>
			</div>
		</div>

		<!-- 三方合并（默认）：上 B | C，下 D，分割条可拖拽，三窗格同步滚动 -->
		<div v-else class="merge3" :class="dragClass">
			<!-- 一侧没有该文件（新增/删除型冲突）：只能整文件取舍 -->
			<div v-if="sideMissing" class="banner side-banner">
				<Icon name="alert" :size="14" />
				<span class="banner-text">{{ sideMissingText }}</span>
				<div class="bin-actions">
					<button
						class="btn take-ours"
						:disabled="opSideBusy"
						:title="
							detail?.ours.exists
								? '用 ' + oursLabel + ' 的版本覆盖并标记解决'
								: '此分支已删除该文件：删除文件并标记解决'
						"
						@click="takeWhole('ours')"
					>
						{{
							detail?.ours.exists
								? "保留" + oursLabel
								: "删除文件（" + oursLabel + "侧）"
						}}
					</button>
					<button
						class="btn take-theirs"
						:disabled="opSideBusy"
						:title="
							detail?.theirs.exists
								? '用 ' + theirsLabel + ' 的版本覆盖并标记解决'
								: '此分支已删除该文件：删除文件并标记解决'
						"
						@click="takeWhole('theirs')"
					>
						{{
							detail?.theirs.exists
								? "保留" + theirsLabel
								: "删除文件（" + theirsLabel + "侧）"
						}}
					</button>
				</div>
			</div>
			<div v-else-if="resolvedAll" class="banner ok-banner">
				<Icon name="check-circle" :size="14" />
				<span>所有冲突块均已处理{{ dirty ? "，记得保存" : "" }}</span>
			</div>

			<div ref="bodyEl" class="split-body">
				<!-- 上：B | C（完整内容，只读，冲突区域高亮） -->
				<div
					ref="topEl"
					class="panes-top"
					:style="{ height: splitY + '%' }"
				>
					<div class="pane pane-b" :style="{ width: splitX + '%' }">
						<div class="pane-head">
							<span class="dot dot-ours" />
							<span class="pane-title">B · {{ oursLabel }}</span>
							<span class="pane-sub">只读 · 绿色为冲突区域</span>
						</div>
						<div ref="paneBodyElB" class="pane-body">
							<CoderView
								ref="bCoder"
								class="pane-coder"
								:data="detail?.ours.content ?? ''"
								:filename="path"
								readonly
								:marked-lines="align.marksB"
								:theme-vars="bTheme"
								:font-size="fontSize"
								@scroll="(t, l) => onPaneScroll('b', t, l)"
								@font-size-change="onFontSizeChange"
							/>
							<!-- 每个冲突块位置的内联取舍芯片 -->
							<div v-if="chipsAll.b.length" class="hunk-chips">
								<div
									v-for="chip in chipsAll.b"
									:key="chip.idx"
									class="chip-row"
									:style="{ top: chip.top + 'px' }"
								>
									<span class="chip-idx"
										>冲突 {{ chip.idx + 1 }}</span
									>
									<button
										type="button"
										class="chip chip-ours"
										:title="'此冲突块保留 ' + oursLabel"
										@click="resolveHunkAt(chip.idx, 'ours')"
									>
										保留{{ oursLabel }}
									</button>
								</div>
							</div>
						</div>
					</div>
					<div
						class="splitter splitter-v"
						title="拖拽调整 B / C 宽度"
						@pointerdown="startDragX"
					/>
					<div class="pane pane-c">
						<div class="pane-head">
							<span class="dot dot-theirs" />
							<span class="pane-title"
								>C · {{ theirsLabel }}</span
							>
							<span class="pane-sub">只读 · 蓝色为冲突区域</span>
						</div>
						<div ref="paneBodyElC" class="pane-body">
							<CoderView
								ref="cCoder"
								class="pane-coder"
								:data="detail?.theirs.content ?? ''"
								:filename="path"
								readonly
								:marked-lines="align.marksC"
								:theme-vars="cTheme"
								:font-size="fontSize"
								@scroll="(t, l) => onPaneScroll('c', t, l)"
								@font-size-change="onFontSizeChange"
							/>
							<!-- 每个冲突块位置的内联取舍芯片 -->
							<div v-if="chipsAll.c.length" class="hunk-chips">
								<div
									v-for="chip in chipsAll.c"
									:key="chip.idx"
									class="chip-row"
									:style="{ top: chip.top + 'px' }"
								>
									<span class="chip-idx"
										>冲突 {{ chip.idx + 1 }}</span
									>
									<button
										type="button"
										class="chip chip-theirs"
										:title="'此冲突块保留 ' + theirsLabel"
										@click="
											resolveHunkAt(chip.idx, 'theirs')
										"
									>
										保留{{ theirsLabel }}
									</button>
								</div>
							</div>
						</div>
					</div>
				</div>

				<div
					class="splitter splitter-h"
					title="拖拽调整合并结果高度"
					@pointerdown="startDragY"
				/>

				<!-- 下：合并结果 D（完整文件，可编辑；每个冲突块位置内联取舍芯片） -->
				<div class="pane pane-d">
					<div class="pane-head">
						<span class="pane-title">
							<Icon name="merge" :size="12" />
							合并结果 D（可编辑）
						</span>
						<span v-if="hunks.length" class="hunk-pos mono">
							冲突 {{ active + 1 }}/{{ hunks.length }} · 第
							{{ (activeHunk?.start ?? 0) + 1 }} 行
						</span>
						<span class="legend">
							<span class="lg ours">B · {{ oursLabel }}</span>
							<span class="lg theirs">C · {{ theirsLabel }}</span>
							<span
								v-if="hunks.length"
								class="lg warn clickable"
								title="点击跳到第一个冲突"
								@click="goto(0)"
							>
								剩余冲突 {{ hunks.length }}
							</span>
						</span>
					</div>
					<div ref="paneBodyElD" class="pane-body">
						<CoderView
							ref="dCoder"
							class="pane-coder"
							:data="text"
							:filename="path"
							:preserve-scroll="dPreserve"
							:marked-lines="align.marksD"
							:theme-vars="dTheme"
							:font-size="fontSize"
							@change="text = $event"
							@save="save(false)"
							@scroll="(t, l) => onPaneScroll('d', t, l)"
							@font-size-change="onFontSizeChange"
						/>
						<!-- 每个冲突块位置的内联取舍芯片：保留 B / 保留 C / 保留两者 -->
						<div v-if="chipsAll.d.length" class="hunk-chips">
							<div
								v-for="chip in chipsAll.d"
								:key="chip.idx"
								class="chip-row"
								:style="{ top: chip.top + 'px' }"
							>
								<span class="chip-idx"
									>冲突 {{ chip.idx + 1 }}</span
								>
								<button
									type="button"
									class="chip chip-ours"
									:title="'此冲突块保留 ' + oursLabel"
									@click="resolveHunkAt(chip.idx, 'ours')"
								>
									保留{{ oursLabel }}
								</button>
								<button
									type="button"
									class="chip chip-theirs"
									:title="'此冲突块保留 ' + theirsLabel"
									@click="resolveHunkAt(chip.idx, 'theirs')"
								>
									保留{{ theirsLabel }}
								</button>
								<button
									type="button"
									class="chip chip-both"
									title="两侧内容都保留（当前分支在前）"
									@click="resolveHunkAt(chip.idx, 'both')"
								>
									保留两者
								</button>
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>
	</div>
</template>

<style scoped>
.resolver {
	flex: 1;
	min-width: 0;
	min-height: 0;
	display: flex;
	flex-direction: column;
	background: var(--bg-app);
}

/* ------------------------------------------------------------------ 工具条 */
.bar {
	flex: none;
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 6px 10px;
	border-bottom: 1px solid var(--border);
	background: var(--bg-panel);
}
.file {
	display: flex;
	align-items: center;
	gap: 6px;
	min-width: 0;
	max-width: 34%;
}
.file .warn {
	color: var(--yellow);
	flex: none;
}
.file .mono {
	font-family: var(--font-mono);
	font-size: 11.5px;
	color: var(--text-strong);
	min-width: 0;
}
.ellip {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.badge {
	flex: none;
	font-size: 10px;
	padding: 1px 6px;
	border-radius: 8px;
	border: 1px solid transparent;
	white-space: nowrap;
}
.warn-badge {
	color: var(--yellow);
	background: var(--banner-merge-bg);
	border-color: var(--chip-branch-bd);
}
/* 可点击徽章/图例：跳转到首个冲突 */
.clickable {
	cursor: pointer;
}
.clickable:hover {
	filter: brightness(1.25);
}
.ok-badge {
	color: var(--green);
	background: var(--diff-add-bg);
}
.dirty-badge {
	color: var(--accent);
	background: var(--hover-soft);
}

.modes {
	flex: none;
	display: flex;
	border: 1px solid var(--border-strong);
	border-radius: var(--radius);
	overflow: hidden;
}
.mode-btn {
	height: 22px;
	padding: 0 10px;
	font-size: 11.5px;
	border: none;
	border-radius: 0;
	background: transparent;
	color: var(--text-dim);
	cursor: pointer;
}
.mode-btn + .mode-btn {
	border-left: 1px solid var(--border);
}
.mode-btn:hover {
	background: var(--bg-hover);
}
.mode-btn.on {
	background: var(--bg-selected);
	color: var(--text-strong);
	font-weight: 600;
}

.actions {
	flex: 1;
	display: flex;
	justify-content: flex-end;
	align-items: center;
	gap: 6px;
}
.actions .btn {
	height: 22px;
	font-size: 11.5px;
}
.nav {
	display: flex;
	gap: 4px;
}

/* 快捷取舍按钮配色：B（当前分支）绿、C（传入）蓝 */
.btn.take-ours {
	color: var(--green);
	border-color: var(--green);
}
.btn.take-ours:hover:not(:disabled) {
	background: var(--diff-add-bg);
}
.btn.take-theirs {
	color: var(--accent);
	border-color: var(--accent);
}
.btn.take-theirs:hover:not(:disabled) {
	background: var(--bg-selected);
}

/* ------------------------------------------------------------------ 空态 */
.empty-hint {
	flex: 1;
	display: flex;
	align-items: center;
	justify-content: center;
	gap: 8px;
	color: var(--text-faint);
	font-size: 12.5px;
}
.empty-hint.binary {
	flex-direction: column;
	gap: 10px;
}
.empty-hint.binary p {
	margin: 0;
	color: var(--text-dim);
}
.empty-hint.binary .hint {
	font-size: 11px;
	color: var(--text-faint);
}
.bin-actions {
	display: flex;
	gap: 8px;
}
.spinner {
	width: 15px;
	height: 15px;
	border: 2px solid var(--border-strong);
	border-top-color: var(--accent);
	border-radius: 50%;
	animation: spin 0.8s linear infinite;
}
@keyframes spin {
	to {
		transform: rotate(360deg);
	}
}

/* ------------------------------------------------------------------ 面板通用 */
.pane-head {
	flex: none;
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 4px 10px;
	border-bottom: 1px solid var(--border);
	background: var(--bg-panel);
	font-size: 11.5px;
	color: var(--text-dim);
	min-width: 0;
}
.pane-title {
	display: inline-flex;
	align-items: center;
	gap: 5px;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}
.pane-sub {
	color: var(--text-faint);
	font-size: 10.5px;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}
.pane-body {
	flex: 1;
	min-height: 0;
	position: relative;
	display: flex;
	flex-direction: column;
}
/* Coder 根节点：填满面板主体 */
.pane-coder {
	flex: 1;
	min-height: 0;
	min-width: 0;
}
.legend {
	margin-left: auto;
	display: flex;
	gap: 6px;
	flex: none;
}
.lg {
	font-size: 10.5px;
	padding: 1px 7px;
	border-radius: 8px;
	border: 1px solid var(--border);
	display: inline-flex;
	align-items: center;
	gap: 4px;
	white-space: nowrap;
}
.lg.ours {
	color: var(--green);
	border-color: var(--green);
}
.lg.theirs {
	color: var(--accent);
	border-color: var(--accent);
}
.lg.warn {
	color: var(--yellow);
	border-color: var(--yellow);
}
.dot {
	flex: none;
	width: 7px;
	height: 7px;
	border-radius: 50%;
}
.dot-ours {
	background: var(--green);
}
.dot-theirs {
	background: var(--accent);
}

/* ------------------------------------------------------------------ 源码编辑 */
.source-wrap {
	flex: 1;
	min-height: 0;
	display: flex;
	flex-direction: column;
}

/* ------------------------------------------------------------------ 三方合并 */
.merge3 {
	flex: 1;
	min-height: 0;
	display: flex;
	flex-direction: column;
	overflow: hidden;
}
/* 拖拽期间：禁用选中并按轴向锁定光标 */
.merge3.drag-x,
.merge3.drag-x * {
	cursor: col-resize !important;
	user-select: none !important;
}
.merge3.drag-y,
.merge3.drag-y * {
	cursor: row-resize !important;
	user-select: none !important;
}

.banner {
	flex: none;
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 6px 10px;
	border-bottom: 1px solid var(--border);
	font-size: 12px;
}
.banner .banner-text {
	color: var(--yellow);
}
.banner .bin-actions {
	margin-left: auto;
}
.banner.side-banner {
	background: var(--banner-merge-bg);
	color: var(--text-dim);
}
.banner.ok-banner {
	background: var(--diff-add-bg);
	color: var(--green);
}

.split-body {
	flex: 1;
	min-height: 0;
	display: flex;
	flex-direction: column;
}
.panes-top {
	flex: none;
	min-height: 0;
	display: flex;
	min-width: 0;
}
.pane {
	min-width: 0;
	min-height: 0;
	display: flex;
	flex-direction: column;
	overflow: hidden;
}
.pane-b {
	flex: none;
}
.pane-c {
	flex: 1;
}
.pane-d {
	flex: 1;
}

/* 分割条：可拖拽；命中区域向两侧各扩 3px */
.splitter {
	flex: none;
	position: relative;
	background: var(--border);
	z-index: 3;
	transition: background 0.12s ease;
}
.splitter::after {
	content: "";
	position: absolute;
	inset: -3px;
}
.splitter:hover,
.merge3.drag-x .splitter-v,
.merge3.drag-y .splitter-h {
	background: var(--accent);
}
.splitter-v {
	width: 5px;
	cursor: col-resize;
}
.splitter-h {
	height: 5px;
	cursor: row-resize;
}

/* D 面板头部的当前冲突信息 */
.hunk-pos {
	flex: none;
	color: var(--text-faint);
	font-size: 10.5px;
	font-family: var(--font-mono);
}

/* 面板身份色：B 绿 / C 蓝 / D 黄，头部色条 + 淡色底强化分支区分 */
.pane-b > .pane-head {
	border-top: 2px solid var(--green);
	background: color-mix(in oklab, var(--green) 7%, var(--bg-panel));
}
.pane-c > .pane-head {
	border-top: 2px solid var(--accent);
	background: color-mix(in oklab, var(--accent) 7%, var(--bg-panel));
}
.pane-d > .pane-head {
	border-top: 2px solid var(--yellow);
	background: color-mix(in oklab, var(--yellow) 6%, var(--bg-panel));
}
.pane-b > .pane-head .pane-title {
	color: var(--green);
}
.pane-c > .pane-head .pane-title {
	color: var(--accent);
}
.pane-d > .pane-head .pane-title {
	color: var(--yellow);
}

/* ------------------------------------------------------------------ 内联冲突芯片 */
/* 悬浮在面板主体上的绝对定位层：芯片跟随对应冲突块滚动 */
.hunk-chips {
	position: absolute;
	inset: 0;
	pointer-events: none;
	z-index: 6;
	overflow: hidden;
}
.chip-row {
	position: absolute;
	right: 20px;
	display: flex;
	align-items: center;
	gap: 4px;
	transform: translateY(-50%);
	pointer-events: auto;
}
.chip-idx {
	font-family: var(--font-mono);
	font-size: 10px;
	color: var(--text-faint);
	background: color-mix(in oklab, var(--bg-panel) 88%, transparent);
	border-radius: 8px;
	padding: 1px 5px;
	white-space: nowrap;
}
.chip {
	height: 19px;
	padding: 0 8px;
	font-size: 10.5px;
	line-height: 1;
	border-radius: 10px;
	border: 1px solid;
	background: var(--bg-panel);
	cursor: pointer;
	white-space: nowrap;
	box-shadow: 0 1px 4px rgb(0 0 0 / 30%);
}
/* 芯片颜色与分支身份色一致：保留 B 绿 / 保留 C 蓝 / 保留两者黄 */
.chip-ours {
	color: var(--green);
	border-color: var(--green);
}
.chip-ours:hover {
	background: var(--diff-add-bg);
}
.chip-theirs {
	color: var(--accent);
	border-color: var(--accent);
}
.chip-theirs:hover {
	background: var(--bg-selected);
}
.chip-both {
	color: var(--yellow);
	border-color: var(--yellow);
}
.chip-both:hover {
	background: var(--banner-merge-bg);
}
</style>
