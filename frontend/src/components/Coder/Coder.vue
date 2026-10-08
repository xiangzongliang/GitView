<script setup lang="ts">
/**
 * VSCode 风格代码编辑器（仅编辑器模块：无文件树 / 终端等）。
 *
 * 实现方式：透明 textarea 承载输入、光标与原生撤销/重做栈，
 * 下层由 highlight.js 渲染的高亮 <pre> 层 + 当前行高亮层叠展示，
 * 三者（行号 / 高亮层 / textarea）滚动偏移实时同步。
 */
import {
	computed,
	nextTick,
	onBeforeUnmount,
	onMounted,
	ref,
	watch,
} from "vue";
import {
	ChevronDown,
	ChevronRight,
	ChevronUp,
	Replace,
	ReplaceAll,
	Search,
	X,
} from "@lucide/vue";
import {
	CLOSERS,
	CODER_DEFAULT_FONT_SIZE,
	PAIRS,
	QUOTES,
	buildCodeView,
	canAutoClose,
	charCols,
	clampFontSize,
	coderLineHeight,
	commentStyleFor,
	dedentLines,
	detectIndentWidth,
	findMatches,
	fullLineRange,
	getLineOf,
	indentLines,
	leadingWhitespace,
	lineEndIndex,
	lineStartIndex,
	mapDisplayOffsetToSource,
	mapSourceOffsetToDisplay,
	reindentText,
	type CodeView,
	type FoldRange,
} from "./editor-utils";
import {
	LANGUAGE_LABELS,
	detectLanguage,
	highlightCode,
	isRegisteredLanguage,
	languageFromFilename,
	vueLineLanguages,
	type LanguageId,
} from "./highlight";
import {
	buildWordIndex,
	emptyWordIndex,
	keywordCompletions,
	memberCompletions,
	memberReceiverBefore,
	wordPrefixBefore,
	type WordIndex,
} from "./completion";
import Tooltip from "../ui/Tooltip.vue";

/** 字号与行高均可调（见 fontSizePx / lineHeightPx）：JS 度量与 CSS 变量
 *  --ed-font-size / --ed-line-height 由 rootStyle 动态注入，严格一致 */
/** 垂直内边距（px）：须与 <style> 中的 --ed-pad-y 严格一致；
 *  当前行高亮条与滚动定位的文本起始 y 都要加上它，否则与文字错位一个 padding */
const PAD_Y = 8;
/** 水平内边距（px）：须与 <style> 中的 --ed-pad-x 严格一致 */
const PAD_X = 12;

interface Props {
	/** 纯文本内容快照；外部更新会整体重载编辑器 */
	data?: string;
	/** 指定 highlight.js 语言 id（如 "typescript"），优先级最高 */
	language?: string;
	/** 文件名：按扩展名推断语言 */
	filename?: string;
	/** 只读模式：仅保留浏览与查找 */
	readonly?: boolean;
	/** 缩进空格数 */
	indentSize?: number;
	/** 编辑器字号（px）：仅影响编辑器内部排版，默认与应用标准字号一致（13）；
	 *  状态栏菜单选择后经 fontSizeChange 上抛，外层需回写此 prop 才生效 */
	fontSize?: number;
	/** 语法高亮色板（--hl-* 变量表）：由外部传入时覆盖组件默认明暗色板 */
	themeVars?: Record<string, string> | null;
	/** 挂载后自动聚焦，打开即可直接输入 */
	autofocus?: boolean;
	/** 空内容时的占位提示 */
	placeholder?: string;
	/** 需高亮标注的源行号（0 起）：如三方合并中的冲突区域 */
	markedLines?: number[];
	/** 第二组需高亮标注的源行号（0 起）：使用 --ed-mark-bg-2 / --ed-mark-bar-2 着色，
	 *  与 markedLines（使用 --ed-mark-bg / --ed-mark-bar）独立，互不覆盖 */
	markedLines2?: number[];
	/** data 重载时保留滚动位置（供同步滚动场景，避免程序化更新内容后跳回顶部） */
	preserveScroll?: boolean;
	/** 状态栏是否展示字号/缩进/语言菜单（多窗格场景只让主窗格展示，
	 *  其余窗格由外层统一回写 props）；关闭后仅保留 Ln/Col、选中、只读徽章 */
	statusControls?: boolean;
	/** 透镜行（lens row）对应的源行号（0 起）：在这些行的顶部渲染一条
	 *  不透明的覆盖条，内容由 #lens 作用域插槽提供（如冲突块的「保留 xxx」芯片）。
	 *  覆盖条随内容垂直滚动，但水平方向固定（不随横向滚动平移）。 */
	lensLines?: number[];
}

const props = withDefaults(defineProps<Props>(), {
	data: "",
	language: "",
	filename: "",
	readonly: false,
	indentSize: 2,
	fontSize: CODER_DEFAULT_FONT_SIZE,
	themeVars: null,
	autofocus: false,
	placeholder: "开始输入…",
	markedLines: () => [],
	preserveScroll: false,
	statusControls: true,
	lensLines: () => [],
	markedLines2: () => [],
});

const emit = defineEmits<{
	change: [text: string];
	save: [];
	indentChange: [size: number];
	/** 状态栏字号菜单选择后上抛（外层通过 :font-size 回写生效） */
	fontSizeChange: [size: number];
	/** 状态栏语言菜单选择后上抛（空字符串 = 恢复自动检测）；
	 *  多窗格共享语言时由外层回写到各窗格的 :language prop */
	languageChange: [langId: string];
	/** 折叠/展开导致可见行数变化（供外层按实际行数调整容器高度） */
	fold: [visibleLines: number];
	/** 滚动位置变化（用户滚动或组件内部滚动；外部调用 setScroll 不触发，避免同步回环） */
	scroll: [top: number, left: number];
}>();

// ---------- 字号度量（字号可调；行高/光标随字号缩放） ----------

/** 当前字号（px）：prop 约束到可调区间 */
const fontSizePx = computed(() => clampFontSize(props.fontSize));
/** 当前行高（px）：与 rootStyle 注入的 --ed-line-height 严格一致 */
const lineHeightPx = computed(() => coderLineHeight(props.fontSize));

// ---------- 基础状态 ----------

const taRef = ref<HTMLTextAreaElement | null>(null);
const findInputEl = ref<HTMLInputElement | null>(null);
const replaceInputEl = ref<HTMLInputElement | null>(null);
/** 光标 X 坐标镜像测量元素：与高亮层同排版，测出光标列的精确像素位置 */
const caretMirrorEl = ref<HTMLElement | null>(null);

/** 全文内容（折叠仅为视图态，编辑与上抛均以 source 为准） */
const source = ref(props.data);
/** 已折叠的块首行（0-based source 行号集合） */
const folded = ref<Set<number>>(new Set());
/** 折叠视图模型：可见行、隐藏区间、折叠区间 */
const view = computed<CodeView>(() =>
	buildCodeView(source.value, folded.value),
);
/** 当前展示内容（折叠后文本，与 textarea.value 同步，input 为唯一入口） */
const text = computed(() => view.value.displayText);
/** 最近一次向上抛出的内容：去重 + 外部变更比对 */
const lastEmitted = ref(props.data);

const scrollX = ref(0);
const scrollY = ref(0);

const cursorLine = ref(1);
const cursorCol = ref(1);
const selCount = ref(0);
const activeLineNo = ref(1);

/** 等宽字符宽度（挂载后实测），用于查找定位与行号宽度估算 */
const charWidth = ref(7.8);

// ---------- 语言与高亮 ----------

const detectedLang = ref<LanguageId | null>(null);
/** 状态栏手动选择的语言：优先于 props/扩展名推断与自动检测，外部整体重载内容后复位 */
const manualLang = ref<LanguageId | null>(null);

const propLang = computed(() =>
	props.language && isRegisteredLanguage(props.language)
		? (props.language as LanguageId)
		: null,
);
const fileLang = computed(() =>
	props.filename ? languageFromFilename(props.filename) : null,
);

const currentLang = computed<LanguageId | null>(
	() =>
		manualLang.value ??
		propLang.value ??
		fileLang.value ??
		detectedLang.value,
);

const langLabel = computed(() => {
	const lang = currentLang.value;
	if (!lang) return "纯文本";
	const label = LANGUAGE_LABELS[lang] ?? lang;
	return manualLang.value || propLang.value || fileLang.value
		? label
		: `${label}（自动）`;
});

// ---------- 状态栏选择菜单（缩进 / 语言） ----------

/** 语言菜单选项：按展示名去重（bash / shell 同为「Shell」只保留其一） */
const LANGUAGE_OPTIONS: { id: LanguageId; label: string }[] = (() => {
	const seen = new Set<string>();
	const out: { id: LanguageId; label: string }[] = [];
	for (const [id, label] of Object.entries(LANGUAGE_LABELS) as [
		LanguageId,
		string,
	][]) {
		if (seen.has(label)) continue;
		seen.add(label);
		out.push({ id, label });
	}
	return out;
})();

/** 缩进空格数可选项 */
const INDENT_OPTIONS = [2, 4];

/** 字号可选项（px）：默认 13 与应用标准字号一致 */
const FONT_OPTIONS = [9, 10, 11, 12, 13, 14, 16, 18];

const indentMenuOpen = ref(false);
const langMenuOpen = ref(false);
const fontMenuOpen = ref(false);
/** 菜单容器（含触发项与弹层）：全局指针按下时判断是否点在菜单外 */
const indentWrapEl = ref<HTMLElement | null>(null);
const langWrapEl = ref<HTMLElement | null>(null);
const fontWrapEl = ref<HTMLElement | null>(null);

function closeStatusMenus() {
	indentMenuOpen.value = false;
	langMenuOpen.value = false;
	fontMenuOpen.value = false;
}

function toggleIndentMenu() {
	indentMenuOpen.value = !indentMenuOpen.value;
	langMenuOpen.value = false;
	fontMenuOpen.value = false;
}

function toggleLangMenu() {
	langMenuOpen.value = !langMenuOpen.value;
	indentMenuOpen.value = false;
	fontMenuOpen.value = false;
}

function toggleFontMenu() {
	fontMenuOpen.value = !fontMenuOpen.value;
	indentMenuOpen.value = false;
	langMenuOpen.value = false;
}

/** 选择缩进：上抛由外层回写 indentSize prop（变化时全文重排，见下方 watch） */
function pickIndent(size: number) {
	indentMenuOpen.value = false;
	if (size !== props.indentSize) emit("indentChange", size);
}

/** 选择字号：上抛由外层回写 fontSize prop（仅编辑器内部字号，不影响应用全局） */
function pickFontSize(size: number) {
	fontMenuOpen.value = false;
	if (clampFontSize(size) !== fontSizePx.value) emit("fontSizeChange", size);
}

/** 选择语言：null = 恢复自动（props/扩展名推断 → 内容检测）；
 *  选择结果同时上抛，供多窗格场景下外层同步到其它编辑器 */
function pickLang(id: LanguageId | null) {
	manualLang.value = id;
	langMenuOpen.value = false;
	emit("languageChange", id ?? "");
	// 补全的关键字/成员候选依赖语言，切换后立即重建文档词索引
	rebuildDocWords();
}

/** 菜单打开期间：点击菜单外或按 Esc 关闭 */
function onStatusMenuDocPointerDown(e: PointerEvent) {
	const t = e.target as Node;
	if (
		indentWrapEl.value?.contains(t) ||
		langWrapEl.value?.contains(t) ||
		fontWrapEl.value?.contains(t)
	)
		return;
	closeStatusMenus();
}

function onStatusMenuDocKeydown(e: KeyboardEvent) {
	if (e.key === "Escape") closeStatusMenus();
}

watch(
	computed(
		() => indentMenuOpen.value || langMenuOpen.value || fontMenuOpen.value,
	),
	(open) => {
		if (open) {
			document.addEventListener(
				"pointerdown",
				onStatusMenuDocPointerDown,
				true,
			);
			document.addEventListener("keydown", onStatusMenuDocKeydown, true);
		} else {
			document.removeEventListener(
				"pointerdown",
				onStatusMenuDocPointerDown,
				true,
			);
			document.removeEventListener(
				"keydown",
				onStatusMenuDocKeydown,
				true,
			);
		}
	},
);

// ---------- 代码折叠 / 缩进彩虹 ----------

/** 缩进级别彩虹色板（16 色，深层嵌套下避免过快循环） */
const RAINBOW_COLORS = [
	"#e06c75",
	"#d19a66",
	"#e5c07b",
	"#98c379",
	"#56b6c2",
	"#61afef",
	"#c678dd",
	"#be5046",
	"#e8a090",
	"#d4b870",
	"#7ecb8a",
	"#48b8b0",
	"#6298d8",
	"#b888e8",
	"#d890b8",
	"#c09870",
];

function rainbowColor(level: number): string {
	return RAINBOW_COLORS[(level - 1) % RAINBOW_COLORS.length]!;
}

/** 行首空白按 indentSize 展开为等宽空格，保证缩进层级与视觉列一致 */
function expandTabs(ws: string, tabSize: number): string {
	let out = "";
	let col = 0;
	for (const ch of ws) {
		if (ch === "\t") {
			const n = tabSize - (col % tabSize);
			out += " ".repeat(n);
			col += n;
		} else {
			out += ch;
			col += 1;
		}
	}
	return out;
}

/** 将行首缩进空白拆为每级一段（每段 unit 空格），供缩进彩虹渲染。
 *  只对完整缩进级数生成色块，剩余不足一级的空白交给正文渲染（无底色）。 */
function buildIndentSegments(
	ws: string,
	unit: number,
): { segs: { level: number; spaces: string }[]; remainder: string } {
	const segs: { level: number; spaces: string }[] = [];
	let i = 0;
	let level = 0;
	while (i + unit <= ws.length) {
		level += 1;
		segs.push({ level, spaces: ws.slice(i, i + unit) });
		i += unit;
	}
	return { segs, remainder: ws.slice(i) };
}

/** 缩进段底纹（彩虹色块） */
function segStyle(level: number) {
	const color = rainbowColor(level);
	return {
		backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)`,
	};
}

interface RenderLine {
	srcLine: number;
	number: number;
	/** 显示行索引（0-based，折叠后从 0 起），用于当前行高亮判定 */
	displayIndex: number;
	segs: { level: number; spaces: string }[];
	bodyHtml: string;
	isFoldStart: boolean;
	isFolded: boolean;
	/** 是否为外部标注行（如冲突区域高亮） */
	marked: boolean;
	/** 是否为第二组外部标注行（独立着色） */
	marked2: boolean;
}

/** 全文按行拆分（source 变化时重建，供各行模型与水平宽度估算复用） */
const sourceLines = computed(() => source.value.split("\n"));

/** Vue SFC 逐行语言划分（非 vue 时为 null；按行高亮无法命中多行块，需预解析） */
const vueLineLangs = computed<LanguageId[] | null>(() =>
	currentLang.value === "vue" ? vueLineLanguages(sourceLines.value) : null,
);

/** 折叠区间首行映射（srcLine → FoldRange），供可视行标记折叠起点 */
const foldByStart = computed(() => {
	const m = new Map<number, FoldRange>();
	for (const r of view.value.foldRanges) m.set(r.startLine, r);
	return m;
});

/** 外部标注行集合（0 起源行号） */
const markedSet = computed(() => new Set<number>(props.markedLines));

/** 第二组外部标注行集合（0 起源行号），使用独立的 CSS 变量着色 */
const markedSet2 = computed(() => new Set<number>(props.markedLines2));

/** 可视区高度（px）：textarea 客户区高度，滚动/缩放时更新 */
const viewportH = ref(600);

/** 上下各多渲染的行数（滚动时避免白屏） */
const OVERSCAN = 20;

/** 可视行区间（显示行索引，含缓冲），据此只渲染屏内行 */
const visibleRange = computed(() => {
	const total = view.value.visibleLines.length;
	const start = Math.min(
		total,
		Math.max(0, Math.floor(scrollY.value / lineHeightPx.value) - OVERSCAN),
	);
	const count =
		Math.ceil(viewportH.value / lineHeightPx.value) + OVERSCAN * 2;
	const end = Math.min(total, start + count);
	return { start, end, total };
});

// ---------- 透镜行（lens row） ----------

/** 透镜覆盖条高度（px）：比行高多 6px，保证芯片（16px + 边框）上下有余量不裁切；
 *  最低 22px 防止极小字号下内容溢出 */
const lensStripH = computed(() => Math.max(lineHeightPx.value + 6, 22));

/** 透镜行渲染模型：把 lensLines 中的源行号映射为显示行号（折叠隐藏的
 *  行跳过），换算成视口内坐标；只渲染可视区内的条带，内容来自 #lens 插槽。
 *  透镜以目标行为中心上下对称覆盖，多余高度均分到上下两行（各约 3px，肉眼不易察觉）。 */
const lensRows = computed(() => {
	const src = props.lensLines;
	if (!src || src.length === 0) return [];
	const vl = view.value.visibleLines;
	const lh = lineHeightPx.value;
	const h = lensStripH.value;
	const out: { idx: number; line: number; top: number }[] = [];
	src.forEach((line, idx) => {
		// visibleLines 升序：二分查找源行号对应的显示行索引
		let lo = 0;
		let hi = vl.length - 1;
		let di = -1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			const v = vl[mid]!;
			if (v === line) {
				di = mid;
				break;
			}
			if (v < line) lo = mid + 1;
			else hi = mid - 1;
		}
		if (di < 0) return; // 该行被折叠隐藏：不渲染
		// 透镜以目标行为中心：top 向上偏移 (h - lh) / 2，超出部分均分至上下两行
		const top = PAD_Y + di * lh - scrollY.value - (h - lh) / 2;
		if (top > viewportH.value || top + h < 0) return; // 视口外
		out.push({ idx, line, top });
	});
	return out;
});

/** 全文最长视觉列宽（tab 按 4 展开，CJK 等宽字符按 2 列），用于锁定代码层水平滚动宽度 */
const maxVisualColumns = computed(() => {
	let max = 0;
	for (const line of sourceLines.value) {
		let col = 0;
		for (const ch of line) {
			col += ch === "\t" ? 4 - (col % 4) : charCols(ch);
		}
		if (col > max) max = col;
	}
	return max;
});

/** 代码层内容区最小宽度（px），保证水平滚动与 textarea 内容宽度一致 */
const contentWidth = computed(() =>
	Math.ceil(maxVisualColumns.value * charWidth.value),
);

/** 逐行渲染模型（仅可视区间，含高亮）：行号栏与代码层共用 */
const visibleModels = computed<RenderLine[]>(() => {
	const unit = props.indentSize || 2;
	const { start, end } = visibleRange.value;
	const out: RenderLine[] = [];
	for (let i = start; i < end; i++) {
		const srcLine = view.value.visibleLines[i]!;
		const raw = sourceLines.value[srcLine] ?? "";
		const ws = leadingWhitespace(raw);
		const { segs, remainder } = buildIndentSegments(
			expandTabs(ws, unit),
			unit,
		);
		const lineLang = vueLineLangs.value?.[srcLine] ?? currentLang.value;
		const bodyHtml = highlightCode(
			remainder + raw.slice(ws.length),
			lineLang,
		);
		out.push({
			srcLine,
			number: srcLine + 1,
			displayIndex: i,
			segs,
			bodyHtml,
			isFoldStart: foldByStart.value.has(srcLine),
			isFolded: folded.value.has(srcLine),
			marked: markedSet.value.has(srcLine),
			marked2: markedSet2.value.has(srcLine),
		});
	}
	return out;
});

// ---------- 布局度量 ----------

const gutterWidth = computed(() => {
	const digits = String(Math.max(1, source.value.split("\n").length)).length;
	// 行号 + 8px 间距 + 14px 折叠箭头槽 + 6px 右内边距 + ~2px 缓冲
	return Math.round(Math.max(2, digits) * charWidth.value) + 30;
});

// ---------- 同步与光标 ----------

/** 最近一次程序化滚动的位置：scroll 事件与其一致时视为外部 setScroll 所致，
 *  不再向上 emit（避免多编辑器同步滚动时形成反馈回环） */
let lastProg = { top: -1, left: -1 };

function syncScroll() {
	const el = taRef.value;
	if (!el) return;
	scrollX.value = el.scrollLeft;
	scrollY.value = el.scrollTop;
	if (el.clientHeight > 0) viewportH.value = el.clientHeight;
	hideCompletion();
	if (el.scrollTop === lastProg.top && el.scrollLeft === lastProg.left) {
		return;
	}
	emit("scroll", el.scrollTop, el.scrollLeft);
}

/** 编程式滚动（供外层做多窗格同步滚动；不会触发 scroll 事件上抛）；
 *  返回 clamp 后的实际滚动位置，供外层记录窗格滚动状态（如冲突芯片定位） */
function setScroll(top: number, left?: number): { top: number; left: number } {
	const el = taRef.value;
	if (!el) return { top: 0, left: 0 };
	el.scrollTop = Math.max(0, top);
	if (left !== undefined) el.scrollLeft = Math.max(0, left);
	// 赋值可能被浏览器 clamp（超出可滚动范围），以实际值为准记录抑制位
	lastProg = { top: el.scrollTop, left: el.scrollLeft };
	scrollX.value = el.scrollLeft;
	scrollY.value = el.scrollTop;
	return { top: el.scrollTop, left: el.scrollLeft };
}

/** 滚动位置对应的首行（0 起显示行索引；与 CSS 的行高/上内边距严格一致） */
function lineAtScrollTop(top: number): number {
	return Math.max(0, Math.floor((top - PAD_Y) / lineHeightPx.value));
}

/** 某显示行滚到视口顶部时的 scrollTop */
function scrollTopForLine(line: number): number {
	return Math.max(0, PAD_Y + Math.max(0, line) * lineHeightPx.value);
}

// ---------- 自定义光标 ----------
// 原生 textarea 光标高度不可调，隐藏后自绘：高度约等于字号，
// 位于行内垂直居中。坐标按等宽字体推算（Tab 按 tab-size 4 展开）。

const caretHeightPx = computed(() =>
	Math.max(10, Math.round(fontSizePx.value * 1.15)),
);
const caretTopPx = computed(
	() => (lineHeightPx.value - caretHeightPx.value) / 2,
);

const focused = ref(false);
const caretX = ref(0);
const caretY = ref(0);

/** 镜像测量用的标记元素（复用，避免每次新建） */
let caretMarker: HTMLSpanElement | null = null;

/** 监听 textarea 尺寸变化，更新可视区高度（虚拟滚动用） */
let resizeObserver: ResizeObserver | null = null;

const showCaret = computed(
	() => focused.value && !props.readonly && selCount.value === 0,
);

function updateCursor() {
	const el = taRef.value;
	if (!el) return;
	const value = text.value;
	const start = el.selectionStart ?? 0;
	const end = el.selectionEnd ?? 0;
	cursorLine.value = value.slice(0, start).split("\n").length;
	const lineStart = lineStartIndex(value, start);
	cursorCol.value = start - lineStart + 1;
	selCount.value = end - start;
	activeLineNo.value = cursorLine.value;

	caretY.value = (cursorLine.value - 1) * lineHeightPx.value;
	// X 坐标用镜像元素精确测量：把当前行光标前的文本放进同排版
	// 的隐藏 pre，读标记 span 相对镜像的 left。用 getBoundingClientRect
	// 而非 offsetLeft：WebKit 中空文本节点后的内联 span 的 offsetLeft
	// 会退化为 0，导致 col 1 时光标偏左（其它列正常）。
	const mirror = caretMirrorEl.value;
	if (mirror) {
		caretMarker ??= document.createElement("span");
		mirror.replaceChildren(
			document.createTextNode(value.slice(lineStart, start)),
			caretMarker,
		);
		caretX.value =
			caretMarker.getBoundingClientRect().left -
			mirror.getBoundingClientRect().left;
	} else {
		// 兜底：等宽推算（含 pad-x，与高亮层文本起点一致；Tab 按 tab-size 4 展开，
		// CJK 等宽字符按 2 列计）
		let visualCol = 0;
		for (const ch of value.slice(lineStart, start)) {
			visualCol += ch === "\t" ? 4 - (visualCol % 4) : charCols(ch);
		}
		caretX.value = Math.round(PAD_X + visualCol * charWidth.value);
	}
	pruneCompletion();
}

function onFocus() {
	focused.value = true;
	updateCursor();
}

function onBlur() {
	focused.value = false;
	hideCompletion();
}

function caretTo(start: number, end = start) {
	taRef.value?.setSelectionRange(start, end);
	updateCursor();
}

// ---------- 关键字自动补全 ----------
// 输入时按当前语言的保留字前缀匹配；Tab 确认 / Esc 关闭 / ↑↓ 选择。
// 面板只在 input 事件中弹出；光标移动只会收起，不干扰导航。
// 注意：面板打开时折叠必已展开（输入字符前会 unfoldAll），
// display 下标与 source 下标一致，可直接用于编辑。

interface CompletionState {
	/** 候选替换区间的起始下标（display 坐标） */
	start: number;
	/** 触发补全的已输入前缀 */
	word: string;
	items: string[];
	index: number;
}

const completion = ref<CompletionState | null>(null);
/** 刚通过补全插入的词：避免「插入词是更长关键词前缀」时面板立即再次弹出 */
let justAccepted: string | null = null;

// ---------- 文档词索引（动态候选的性能关键） ----------
// 一次 O(n) 扫描同时产出三类候选源：全文标识符（含各语言
// import/require/use 引入的名字，排在最前保证可见）、
// receiver -> 成员映射（供 xxx. 成员补全）、全文成员名总表。
// 重建不在每次按键时做：输入时防抖 300ms，连续打字期间复用旧索引
// （关键字候选仍实时刷新）；仅在加载新内容时同步重建一次。
// 索引规模均有硬上限（DOC_WORDS_MAX / RECEIVERS_MAX），逐键匹配
// 只是对几百条小数组做 startsWith 过滤，开销可忽略。
const wordIndex = ref<WordIndex>(emptyWordIndex());
let docWordsTimer: ReturnType<typeof setTimeout> | null = null;

function rebuildDocWords() {
	wordIndex.value = buildWordIndex(source.value, currentLang.value);
}

function scheduleDocWords(immediate = false) {
	if (docWordsTimer) {
		clearTimeout(docWordsTimer);
		docWordsTimer = null;
	}
	if (immediate) {
		rebuildDocWords();
		return;
	}
	docWordsTimer = setTimeout(() => {
		docWordsTimer = null;
		rebuildDocWords();
	}, 300);
}

/** 补全面板定位（相对 code-pane；锚定光标下方，下方空间不足时翻到上方） */
const completionPos = computed(() => {
	const c = completion.value;
	if (!c) return { left: "0px", top: "0px" };
	const paneW = taRef.value?.clientWidth ?? 0;
	const left = Math.min(
		Math.max(0, caretX.value - scrollX.value),
		Math.max(0, paneW - 208),
	);
	const popH = c.items.length * lineHeightPx.value + 6;
	const anchorTop = caretY.value - scrollY.value;
	const below = anchorTop + PAD_Y + lineHeightPx.value + 4;
	const top =
		below + popH > viewportH.value && anchorTop > popH
			? Math.max(0, anchorTop - popH - 2)
			: below;
	return { left: `${Math.round(left)}px`, top: `${Math.round(top)}px` };
});

function hideCompletion() {
	completion.value = null;
}

/** 输入后依据光标前缀刷新补全（只在 input 路径调用，负责弹出） */
function refreshCompletion() {
	const el = taRef.value;
	if (!el || props.readonly || !focused.value) {
		completion.value = null;
		return;
	}
	const caret = el.selectionStart;
	if (el.selectionEnd !== caret) {
		completion.value = null;
		return;
	}
	const { word, start } = wordPrefixBefore(text.value, caret);
	if (justAccepted !== null) {
		if (word === justAccepted) {
			completion.value = null;
			return;
		}
		justAccepted = null;
	}
	const cur = completion.value;
	// 上下文未变（如导航后的 keyup）时保留候选与当前选中项
	if (cur && cur.start === start && cur.word === word) return;
	const idx = wordIndex.value;
	// 成员访问上下文（xxx. 后）：前缀可为空（刚敲完 `.` 即弹出），
	// 候选来自同 receiver 已用成员 / 语言内置对象成员 / 全文成员名
	const receiver = memberReceiverBefore(text.value, start);
	if (receiver !== null) {
		const items = memberCompletions(receiver, word, currentLang.value, idx);
		completion.value = items.length
			? { start, word, items, index: 0 }
			: null;
		return;
	}
	if (word.length < 2) {
		completion.value = null;
		return;
	}
	const items = keywordCompletions(word, currentLang.value, idx.words);
	completion.value = items.length ? { start, word, items, index: 0 } : null;
}

/** 光标移动（非输入）后：上下文已变化则收起面板（不重新弹出） */
function pruneCompletion() {
	const c = completion.value;
	if (!c) return;
	const el = taRef.value;
	if (!el) return;
	const caret = el.selectionStart;
	const { word, start } = wordPrefixBefore(text.value, caret);
	if (word !== c.word || start !== c.start) completion.value = null;
}

/** 确认补全：把 [start, caret) 替换为候选词（Tab 或点击候选） */
function acceptCompletion(index?: number) {
	const c = completion.value;
	const el = taRef.value;
	if (!c || !el) return;
	const insert = c.items[index ?? c.index] ?? c.items[0];
	if (!insert) return;
	justAccepted = insert;
	const caret = el.selectionStart;
	unfoldAll();
	applyEdit(c.start, caret, insert);
	completion.value = null;
}

// ---------- 代码折叠 ----------

/** 展开全部折叠（编辑前自动调用，保证后续编辑基于全文） */
function unfoldAll(): void {
	if (folded.value.size === 0) return;
	const el = taRef.value;
	const oldView = view.value;
	const srcStart = el
		? mapDisplayOffsetToSource(
				el.selectionStart ?? 0,
				source.value,
				oldView.hiddenRanges,
			)
		: 0;
	const srcEnd = el
		? mapDisplayOffsetToSource(
				el.selectionEnd ?? 0,
				source.value,
				oldView.hiddenRanges,
			)
		: srcStart;
	folded.value = new Set();
	if (el) {
		el.value = text.value;
		el.setSelectionRange(srcStart, srcEnd);
		updateCursor();
	}
}

/** 折叠 / 展开某个块首行，并把当前选区映射到新视图 */
function toggleFold(startLine: number): void {
	const el = taRef.value;
	if (!el) return;
	const oldView = view.value;
	const srcStart = mapDisplayOffsetToSource(
		el.selectionStart ?? 0,
		source.value,
		oldView.hiddenRanges,
	);
	const srcEnd = mapDisplayOffsetToSource(
		el.selectionEnd ?? 0,
		source.value,
		oldView.hiddenRanges,
	);

	const next = new Set(folded.value);
	if (next.has(startLine)) next.delete(startLine);
	else next.add(startLine);
	folded.value = next;

	const newView = view.value;
	el.value = newView.displayText;
	el.setSelectionRange(
		mapSourceOffsetToDisplay(srcStart, source.value, newView.hiddenRanges),
		mapSourceOffsetToDisplay(srcEnd, source.value, newView.hiddenRanges),
	);
	updateCursor();
}

/** 当前视图可见行数（折叠后），供外层按实际行数调整容器高度 */
const visibleLineCount = computed(() => view.value.visibleLines.length);

watch(visibleLineCount, (n) => emit("fold", n));

// ---------- 变更上抛 ----------

let emitTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleEmit() {
	if (emitTimer) clearTimeout(emitTimer);
	emitTimer = setTimeout(() => {
		emitTimer = null;
		flushEmit();
	}, 400);
}

function flushEmit() {
	if (emitTimer) {
		clearTimeout(emitTimer);
		emitTimer = null;
	}
	if (source.value !== lastEmitted.value) {
		lastEmitted.value = source.value;
		detectedLang.value = detectLanguage(source.value);
		emit("change", source.value);
	}
}

function onInput() {
	const el = taRef.value;
	if (!el) return;
	source.value = el.value;
	updateCursor();
	refreshCompletion();
	scheduleEmit();
	scheduleDocWords();
}

// ---------- 缩进切换（状态栏「空格: x」菜单选择） ----------
// 切换后全文立即按新缩进单位重排：仅重建行首空白，保持缩进级别
// 与非空白内容不变（详见 reindentText；Python/YAML 等缩进敏感
// 语言的重排语义由使用者自行确认）。

watch(
	() => props.indentSize,
	(to, from) => {
		if (from !== undefined && to !== from) reindentAll();
	},
);

function reindentAll(): void {
	const el = taRef.value;
	if (!el || props.readonly) return;
	// 展开全部折叠，保证重排与选区映射基于全文
	unfoldAll();
	const value = source.value;
	// 旧缩进单位以「实际内容」为准：探测全文真实缩进宽度。
	// 不能用外部设置值当 from——内容可能是粘贴/默认导入的 4 空格，
	// 设置仍为 2，按设置值换算会导致缩进翻倍。
	const from = detectIndentWidth(value) || props.indentSize;
	const to = props.indentSize;
	const next = reindentText(value, from, to);
	if (next === value) return;

	// 记录选区（行, 列），重排后把列映射回新坐标，保证光标/选区不跳
	const oldLines = value.split("\n");
	const newLines = next.split("\n");
	const locate = (index: number): [number, number] => {
		const line = value.slice(0, index).split("\n").length - 1;
		return [line, index - lineStartIndex(value, index)];
	};
	const mapCol = (line: number, col: number): number => {
		const oldLine = oldLines[line] ?? "";
		const newLine = newLines[line] ?? "";
		const oldWs = leadingWhitespace(oldLine).length;
		const newWs = leadingWhitespace(newLine).length;
		const c = Math.min(col, oldLine.length);
		if (c <= oldWs) {
			// 在缩进区内：按新旧缩进长度等比映射
			return oldWs > 0 ? Math.round((c / oldWs) * newWs) : 0;
		}
		return c - oldWs + newWs;
	};
	const indexAt = (line: number, col: number): number => {
		let idx = 0;
		for (let i = 0; i < line; i++) idx += (newLines[i] ?? "").length + 1;
		return idx + Math.min(col, (newLines[line] ?? "").length);
	};

	const [sLine, sCol] = locate(el.selectionStart ?? 0);
	const [eLine, eCol] = locate(el.selectionEnd ?? 0);

	// 整体替换 = 单步撤销；execCommand 失败时由 applyEdit 兜底并同步 input
	applyEdit(0, value.length, next);
	el.setSelectionRange(
		indexAt(sLine, mapCol(sLine, sCol)),
		indexAt(eLine, mapCol(eLine, eCol)),
	);
	updateCursor();
}

/** 外部快照整体重载（切换文档等） */
function loadContent(value: string) {
	// preserveScroll：先捕获当前滚动位置，重载后恢复而非归零
	//（同步滚动场景下程序化更新内容不应打断阅读位置）
	const el0 = taRef.value;
	const keep =
		props.preserveScroll && el0
			? { top: el0.scrollTop, left: el0.scrollLeft }
			: null;
	source.value = value;
	folded.value = new Set();
	lastEmitted.value = value;
	detectedLang.value = detectLanguage(value);
	// 手动语言选择属于单篇文档的临时视图态：整体重载（切换文档）后复位
	manualLang.value = null;
	closeStatusMenus();
	scrollX.value = keep ? keep.left : 0;
	scrollY.value = keep ? keep.top : 0;
	scheduleDocWords(true);
	nextTick(() => {
		const el = taRef.value;
		if (!el) return;
		el.setSelectionRange(0, 0);
		if (keep) {
			el.scrollTop = keep.top;
			el.scrollLeft = keep.left;
			// 恢复滚动会触发 scroll 事件：记为程序化滚动，不向上 emit
			lastProg = { top: el.scrollTop, left: el.scrollLeft };
		} else {
			el.scrollTop = 0;
			el.scrollLeft = 0;
		}
		updateCursor();
	});
}

watch(
	() => props.data,
	(val) => {
		if (val === source.value || val === lastEmitted.value) return;
		loadContent(val);
	},
);

// ---------- 编辑命令 ----------
//
// 统一通过 execCommand(insertText/delete) 应用变更：
// 1) 保留 textarea 原生撤销/重做栈；
// 2) 触发同步 input 事件，text 状态与高亮随之更新。
// execCommand 已被标记废弃，但在 WebView2 / WKWebView 中工作良好；
// 失败时退回 setRangeText + 手动派发 input。

function applyEdit(start: number, end: number, insert: string) {
	const el = taRef.value;
	if (!el || (start === end && insert === "")) return;
	el.focus();
	el.setSelectionRange(start, end);
	let ok = false;
	try {
		ok =
			insert === ""
				? document.execCommand("delete")
				: document.execCommand("insertText", false, insert);
	} catch {
		ok = false;
	}
	if (!ok) {
		el.setRangeText(insert, start, end, "end");
		el.dispatchEvent(new Event("input", { bubbles: true }));
	}
}

function handleEnter() {
	const el = taRef.value;
	if (!el) return;
	const value = text.value;
	const s = el.selectionStart;
	const e = el.selectionEnd;
	const line = getLineOf(value, s);
	const prev = value[s - 1] ?? "";
	const next = value[e] ?? "";
	const unit = " ".repeat(props.indentSize);
	// 新行默认继承当前行缩进；光标落在行首空白内时只继承到光标处，
	// 避免拆行后残余空白叠加出双份缩进
	const fullIndent = leadingWhitespace(line.text);
	const indent =
		s - line.start < fullIndent.length
			? fullIndent.slice(0, s - line.start)
			: fullIndent;

	// 空括号间回车：三行展开，光标居中
	if (s === e && PAIRS[prev] && next === PAIRS[prev]) {
		const inner = indent + unit;
		applyEdit(s, e, `\n${inner}\n${indent}`);
		caretTo(s + 1 + inner.length);
		return;
	}
	if (PAIRS[prev]) {
		// 开括号后回车：子级缩进
		applyEdit(s, e, `\n${indent}${unit}`);
		return;
	}
	// 普通回车：新行继承当前行的前导空白
	applyEdit(s, e, `\n${indent}`);
}

function handleTab(shift: boolean) {
	const el = taRef.value;
	if (!el) return;
	const value = text.value;
	const s = el.selectionStart;
	const e = el.selectionEnd;
	const unit = " ".repeat(props.indentSize);

	if (shift) {
		// 整块反缩进（含无选区时仅当前行）
		const [a, b] = fullLineRange(value, s, e > s ? e - 1 : s);
		const res = dedentLines(value, a, b, props.indentSize);
		applyEdit(a, b, res.text);
		caretTo(res.selStart, res.selEnd);
		return;
	}
	if (s !== e && value.slice(s, e).includes("\n")) {
		// 多行选区：整块缩进（单次替换 = 单步撤销）
		const [a, b] = fullLineRange(value, s, e - 1);
		const res = indentLines(value, a, b, unit);
		applyEdit(a, b, res.text);
		caretTo(res.selStart, res.selEnd);
		return;
	}
	if (s !== e) {
		applyEdit(s, e, unit);
		return;
	}
	// 无选区：插入空格对齐到下一个缩进单位
	const col = s - lineStartIndex(value, s);
	const count = props.indentSize - (col % props.indentSize);
	applyEdit(s, s, " ".repeat(count));
}

function handleBackspace(): boolean {
	const el = taRef.value;
	if (!el) return false;
	const value = text.value;
	const s = el.selectionStart;
	const e = el.selectionEnd;
	if (s !== e || s === 0) return false;
	const prev = value[s - 1];
	const next = value[s];

	// 空的括号/引号对：整体删除
	if (
		(PAIRS[prev] && next === PAIRS[prev]) ||
		(QUOTES.includes(prev) && next === prev)
	) {
		applyEdit(s - 1, s + 1, "");
		return true;
	}
	// 行首纯空白：按缩进单位退格
	const lineStart = lineStartIndex(value, s);
	const before = value.slice(lineStart, s);
	if (/^[ \t]+$/.test(before)) {
		const remove = ((before.length - 1) % props.indentSize) + 1;
		applyEdit(s - remove, s, "");
		return true;
	}
	return false;
}

function handlePair(key: string): boolean {
	const el = taRef.value;
	if (!el) return false;
	const value = text.value;
	const s = el.selectionStart;
	const e = el.selectionEnd;
	const next = value[e];

	// 光标后已是相同闭符/引号：跳过而不重复插入
	if (s === e && next === key && (CLOSERS.has(key) || QUOTES.includes(key))) {
		caretTo(e + 1);
		return true;
	}

	const isQuote = QUOTES.includes(key);
	if (s === e) {
		if (isQuote) {
			// 标识符旁不自动闭合引号（如 it's / a"b）
			if (/[\w$]/.test(value[s - 1] ?? "")) return false;
		}
		if (!canAutoClose(next)) return false;
	}

	const pair = PAIRS[key] ?? key;
	if (s !== e) {
		// 包裹选区
		const selected = value.slice(s, e);
		applyEdit(s, e, key + selected + pair);
		caretTo(s + 1, e + 1);
		return true;
	}
	applyEdit(s, e, key + pair);
	caretTo(s + 1);
	return true;
}

/** 当前选区覆盖的整行范围 [行首, 末行换行后) 与原选区 */
function selectionLines(value: string): [number, number, number, number] {
	const el = taRef.value!;
	const s = el.selectionStart;
	const e = el.selectionEnd;
	const a = lineStartIndex(value, s);
	const [, bIncl] = fullLineRange(value, e > s ? e - 1 : s);
	return [a, bIncl, s, e];
}

function moveLinesUp() {
	const el = taRef.value;
	if (!el) return;
	const value = text.value;
	const [a, bIncl, s, e] = selectionLines(value);
	if (a === 0) return;
	const prevStart = lineStartIndex(value, a - 1);
	const block = value.slice(a, bIncl);
	const replaced = value.slice(prevStart, a);
	applyEdit(prevStart, bIncl, block + replaced);
	caretTo(s - replaced.length, e - replaced.length);
}

function moveLinesDown() {
	const el = taRef.value;
	if (!el) return;
	const value = text.value;
	const [a, bIncl, s, e] = selectionLines(value);
	if (bIncl >= value.length) return;
	const nextEnd = lineEndIndex(value, bIncl);
	const nextEndIncl = nextEnd === value.length ? value.length : nextEnd + 1;
	const block = value.slice(a, bIncl);
	const nextLine = value.slice(bIncl, nextEndIncl);
	applyEdit(a, nextEndIncl, nextLine + block);
	caretTo(s + nextLine.length, e + nextLine.length);
}

function duplicateLines(down: boolean) {
	const el = taRef.value;
	if (!el) return;
	const value = text.value;
	const [a, bIncl, s, e] = selectionLines(value);
	const block = value.slice(a, bIncl);
	if (down) {
		if (block.endsWith("\n")) {
			applyEdit(bIncl, bIncl, block);
			caretTo(bIncl + (s - a), bIncl + (e - a));
		} else {
			// 最后一行（无换行符）：补一个换行后复制
			applyEdit(a, bIncl, `${block}\n${block}`);
			const dupStart = a + block.length + 1;
			caretTo(dupStart + (s - a), dupStart + (e - a));
		}
	} else {
		const insert = block.endsWith("\n") ? block : `${block}\n`;
		applyEdit(a, a, insert);
		caretTo(s + insert.length, e + insert.length);
	}
}

function deleteLines() {
	const el = taRef.value;
	if (!el) return;
	const value = text.value;
	const [a, bIncl] = selectionLines(value);
	let start = a;
	let end = bIncl;
	if (end >= value.length && start > 0) {
		// 最后一行：连同其前面的换行符一起删除
		start -= 1;
	}
	applyEdit(start, end, "");
	caretTo(Math.min(start, text.value.length));
}

/** 裸 Home：行首 ↔ 首个非空白字符切换（Shift 为选区扩展） */
function smartHome(extend: boolean) {
	const el = taRef.value;
	if (!el) return;
	const value = text.value;
	const s = el.selectionStart;
	const line = getLineOf(value, s);
	const firstNonWs = line.start + leadingWhitespace(line.text).length;
	const target = s === firstNonWs ? line.start : firstNonWs;
	if (extend) {
		const anchor =
			el.selectionDirection === "backward"
				? el.selectionEnd
				: el.selectionStart;
		const [start, end] =
			anchor <= target ? [anchor, target] : [target, anchor];
		el.setSelectionRange(start, end);
		el.selectionDirection = anchor <= target ? "forward" : "backward";
	} else {
		el.setSelectionRange(target, target);
	}
	updateCursor();
}

function toggleComment() {
	const el = taRef.value;
	if (!el) return;
	const style = commentStyleFor(currentLang.value);
	if (!style) return;
	const value = text.value;
	const s = el.selectionStart;
	const e = el.selectionEnd;
	const [a, b] = fullLineRange(value, s, e > s ? e - 1 : s);

	if (style.line) {
		const marker = style.line;
		const lines = value.slice(a, b).split("\n");
		const nonEmpty = lines.filter((line) => line.trim() !== "");
		if (nonEmpty.length === 0) return;
		const allCommented = nonEmpty.every((line) =>
			line.trimStart().startsWith(marker),
		);
		const updated = allCommented
			? lines.map((line) => {
					const idx = line.indexOf(marker);
					if (idx === -1) return line;
					let cut = idx + marker.length;
					if (line[cut] === " ") cut += 1;
					return line.slice(0, idx) + line.slice(cut);
				})
			: lines.map((line) =>
					line.trim() === ""
						? line
						: line.replace(/^[\t ]*/, (ws) => `${ws}${marker} `),
				);
		applyEdit(a, b, updated.join("\n"));
		caretTo(a);
		return;
	}

	if (style.block) {
		const [open, close] = style.block;
		const block = value.slice(a, b);
		const firstNonWs = block.search(/\S/);
		if (firstNonWs === -1) return;
		const lastNonWs = block.trimEnd().length;
		const start = a + firstNonWs;
		const end = a + lastNonWs;
		const inner = block.slice(firstNonWs, lastNonWs);
		const trimmed = inner.trimStart();
		if (trimmed.startsWith(open) && inner.trimEnd().endsWith(close)) {
			let stripped = trimmed.slice(open.length);
			if (stripped.startsWith(" ")) stripped = stripped.slice(1);
			const tail = stripped.trimEnd();
			if (tail.endsWith(close)) {
				stripped = tail.slice(0, tail.length - close.length);
			}
			if (stripped.endsWith(" ")) stripped = stripped.slice(0, -1);
			applyEdit(start, end, stripped);
		} else {
			applyEdit(start, end, `${open} ${inner} ${close}`);
		}
		caretTo(start);
	}
}

// ---------- 查找 / 替换 ----------

const findOpen = ref(false);
const findQuery = ref("");
const replaceQuery = ref("");
const matchCase = ref(false);
const matchIndex = ref(-1);

const matches = computed(() =>
	findMatches(text.value, findQuery.value, matchCase.value),
);

// ---------- 查找匹配高亮 ----------

/** text[lineStart..idx) 在 tab-size 4 下占的视觉列数（与光标/缩进度量一致；
 *  CJK 等宽字符按 2 列计，否则中文内容的查找高亮宽度会偏窄） */
function visualCols(value: string, lineStart: number, idx: number): number {
	let col = 0;
	for (let i = lineStart; i < idx; i++) {
		col += value[i] === "\t" ? 4 - (col % 4) : charCols(value[i]!);
	}
	return col;
}

interface SearchMarkRect {
	/** 匹配项序号（matches 下标；当前项高亮由模板比对 matchIndex） */
	mi: number;
	/** 显示行号（0 起，折叠后坐标） */
	line: number;
	x: number;
	y: number;
	w: number;
}

/** 全部匹配的矩形（display 坐标）：单次扫描文本；仅内容/查询/字体度量
 *  变化时重算（滚动只影响下方 visibleSearchMarks 的窗口过滤） */
const allSearchMarks = computed<SearchMarkRect[]>(() => {
	if (!findOpen.value || !findQuery.value) return [];
	const list = matches.value;
	if (list.length === 0) return [];
	const value = text.value;
	const lh = lineHeightPx.value;
	const cw = charWidth.value;
	const out: SearchMarkRect[] = [];
	let mi = 0;
	let pos = 0;
	for (let line = 0; pos <= value.length && mi < list.length; line++) {
		const nl = value.indexOf("\n", pos);
		const le = nl === -1 ? value.length : nl;
		while (mi < list.length && list[mi]!.start < pos) mi++;
		while (mi < list.length && list[mi]!.start <= le) {
			const m = list[mi]!;
			const sCol = visualCols(value, pos, Math.max(m.start, pos));
			const eCol = visualCols(
				value,
				pos,
				Math.min(Math.max(m.end, m.start), le),
			);
			if (eCol > sCol) {
				out.push({
					mi,
					line,
					x: Math.round(PAD_X + sCol * cw),
					y: PAD_Y + line * lh,
					w: Math.max(2, Math.round((eCol - sCol) * cw)),
				});
			}
			mi++;
		}
		if (nl === -1) break;
		pos = nl + 1;
	}
	return out;
});

/** 可视区内的匹配矩形：随虚拟滚动窗口渲染，避免全文档 DOM 节点 */
const visibleSearchMarks = computed(() => {
	const marks = allSearchMarks.value;
	if (marks.length === 0) return marks;
	const { start, end } = visibleRange.value;
	return marks.filter((m) => m.line >= start && m.line < end);
});

const matchLabel = computed(() => {
	if (!findQuery.value) return "";
	const total = matches.value.length;
	if (total === 0) return "无结果";
	const idx = Math.min(Math.max(matchIndex.value, 0), total - 1);
	return `${idx + 1}/${total}`;
});

async function openFind() {
	findOpen.value = true;
	// 预填当前选区（单行时）
	const el = taRef.value;
	if (el && el.selectionStart !== el.selectionEnd) {
		const selected = text.value.slice(el.selectionStart, el.selectionEnd);
		if (!selected.includes("\n")) findQuery.value = selected;
	}
	matchIndex.value = -1;
	await nextTick();
	findInputEl.value?.focus();
	findInputEl.value?.select();
}

function closeFind() {
	findOpen.value = false;
	matchIndex.value = -1;
	taRef.value?.focus();
}

/** 把内容坐标滚动到可视区（垂直居中优先，兼顾水平） */
function reveal(index: number) {
	const el = taRef.value;
	if (!el) return;
	const value = text.value;
	const line = value.slice(0, index).split("\n").length;
	const top = (line - 1) * lineHeightPx.value + PAD_Y;
	const viewH = el.clientHeight;
	if (
		top < el.scrollTop + lineHeightPx.value ||
		top + lineHeightPx.value > el.scrollTop + viewH - lineHeightPx.value
	) {
		el.scrollTop = Math.max(0, top - viewH / 2 + lineHeightPx.value / 2);
	}
	const x =
		PAD_X +
		visualCols(value, lineStartIndex(value, index), index) *
			charWidth.value;
	const viewW = el.clientWidth;
	if (x < el.scrollLeft + 32) {
		el.scrollLeft = Math.max(0, x - 60);
	} else if (x > el.scrollLeft + viewW - 32) {
		el.scrollLeft = Math.max(0, x - viewW + 80);
	}
	syncScroll();
}

function revealMatch(match: { start: number; end: number }) {
	const el = taRef.value;
	if (!el) return;
	el.setSelectionRange(match.start, match.end);
	reveal(match.start);
	updateCursor();
}

function findNext(direction: 1 | -1) {
	const list = matches.value;
	if (list.length === 0) return;
	let idx = matchIndex.value + direction;
	if (idx >= list.length) idx = 0;
	if (idx < 0) idx = list.length - 1;
	matchIndex.value = idx;
	revealMatch(list[idx]);
}

// 查询词或大小写开关变化：定位到光标之后的第一个匹配
watch([findQuery, matchCase], () => {
	if (!findOpen.value) return;
	const list = matches.value;
	if (list.length === 0) {
		matchIndex.value = -1;
		return;
	}
	const caret = taRef.value?.selectionStart ?? 0;
	const idx = list.findIndex((m) => m.start >= caret);
	matchIndex.value = idx === -1 ? 0 : idx;
	revealMatch(list[matchIndex.value]);
});

function replaceCurrent() {
	// 替换会改写内容：先展开全部折叠，保证匹配偏移基于全文
	unfoldAll();
	const list = matches.value;
	if (list.length === 0) return;
	const idx = Math.min(Math.max(matchIndex.value, 0), list.length - 1);
	const match = list[idx];
	applyEdit(match.start, match.end, replaceQuery.value);
	const caret = match.start + replaceQuery.value.length;
	caretTo(caret);
	// 定位替换点之后的下一个匹配（避免新文本被再次匹配导致死循环）
	const rest = matches.value;
	const nextIdx = rest.findIndex((m) => m.start >= caret);
	matchIndex.value = nextIdx === -1 ? (rest.length ? 0 : -1) : nextIdx;
	if (matchIndex.value >= 0) revealMatch(rest[matchIndex.value]);
	replaceInputEl.value?.focus();
}

function replaceAllMatches() {
	// 全部替换会改写内容：先展开全部折叠，保证匹配偏移基于全文
	unfoldAll();
	const list = matches.value;
	if (list.length === 0) return;
	const replacement = replaceQuery.value;
	let out = "";
	let pos = 0;
	for (const m of list) {
		out += text.value.slice(pos, m.start) + replacement;
		pos = m.end;
	}
	out += text.value.slice(pos);
	applyEdit(0, text.value.length, out);
	caretTo(0);
	matchIndex.value = 0;
	findInputEl.value?.focus();
}

// ---------- 键盘路由 ----------

/** 按键/组合是否会被本次处理改写内容（需在编辑前展开折叠） */
function isEditingKey(event: KeyboardEvent): boolean {
	const mod = event.metaKey || event.ctrlKey;
	const key = event.key;
	// 下方会拦截的编辑型命令
	if (mod && event.shiftKey && key.toLowerCase() === "k") return true;
	if (mod && key === "/") return true;
	if (event.altKey && (key === "ArrowUp" || key === "ArrowDown")) return true;
	if (
		key === "Tab" ||
		key === "Enter" ||
		key === "Backspace" ||
		key === "Delete"
	) {
		return true;
	}
	// 浏览器默认插入的可见字符（含 Shift 大写）；Home/方向键等仅移动，不展开
	if (!mod && !event.altKey && key.length === 1) return true;
	return false;
}

/** 原生光标移动键：默认行为改选区，事件不触发 select（折叠选区移动） */
const MOVE_KEYS = new Set([
	"ArrowUp",
	"ArrowDown",
	"ArrowLeft",
	"ArrowRight",
	"Home",
	"End",
	"PageUp",
	"PageDown",
]);

let caretSyncFrame = 0;

/** 在浏览器完成默认选区变更后同步自绘光标。keydown 默认行为里选区
 * 已更新，同帧的 rAF 回调能读到最新 selectionStart/End；长按触发按键
 * 重复时每次 keydown 都会重新调度，光标因此实时跟随（而非等 keyup）。 */
function scheduleCaretSync() {
	if (caretSyncFrame) return;
	caretSyncFrame = requestAnimationFrame(() => {
		caretSyncFrame = 0;
		updateCursor();
	});
}

function onEditorKeydown(event: KeyboardEvent) {
	if (event.isComposing) return;
	const mod = event.metaKey || event.ctrlKey;
	const key = event.key;

	if (MOVE_KEYS.has(key)) scheduleCaretSync();

	if (mod && !event.altKey && key.toLowerCase() === "f") {
		event.preventDefault();
		void openFind();
		return;
	}
	if (mod && !event.shiftKey && !event.altKey && key.toLowerCase() === "s") {
		event.preventDefault();
		flushEmit();
		emit("save");
		return;
	}
	if (key === "Escape" && findOpen.value) {
		event.preventDefault();
		closeFind();
		return;
	}
	if (props.readonly) return;

	// 补全面板打开时优先接管：↑↓ 选择 / Tab、Enter 确认 / Esc 关闭；
	// 其余按键（含 Backspace）照常走编辑流程，input 后自动刷新
	const comp = completion.value;
	if (comp) {
		if (key === "Escape") {
			event.preventDefault();
			hideCompletion();
			return;
		}
		if (!mod && !event.altKey && key === "ArrowUp") {
			event.preventDefault();
			comp.index =
				(comp.index - 1 + comp.items.length) % comp.items.length;
			return;
		}
		if (!mod && !event.altKey && key === "ArrowDown") {
			event.preventDefault();
			comp.index = (comp.index + 1) % comp.items.length;
			return;
		}
		if (key === "Tab" && !event.shiftKey) {
			event.preventDefault();
			acceptCompletion();
			return;
		}
		if (key === "Enter" && !mod && !event.altKey) {
			event.preventDefault();
			acceptCompletion();
			return;
		}
		if (
			key === "ArrowLeft" ||
			key === "ArrowRight" ||
			key === "Home" ||
			key === "End" ||
			key === "PageUp" ||
			key === "PageDown"
		) {
			// 收起但不拦截：继续执行默认光标移动
			hideCompletion();
		}
	}

	// 任何会改写内容的操作前先展开全部折叠：折叠仅是视图态，
	// 先展开才能保证后续编辑与选区都基于全文，避免折叠边界错乱。
	if (isEditingKey(event)) unfoldAll();

	if (mod && event.shiftKey && key.toLowerCase() === "k") {
		event.preventDefault();
		deleteLines();
		return;
	}
	if (mod && key === "/") {
		event.preventDefault();
		toggleComment();
		return;
	}
	if (event.altKey && (key === "ArrowUp" || key === "ArrowDown")) {
		event.preventDefault();
		const up = key === "ArrowUp";
		if (event.shiftKey) {
			// Shift+Alt+Down 复制到下方，Shift+Alt+Up 复制到上方
			duplicateLines(!up);
		} else {
			up ? moveLinesUp() : moveLinesDown();
		}
		return;
	}
	if (key === "Tab") {
		event.preventDefault();
		handleTab(event.shiftKey);
		return;
	}
	if (key === "Enter" && !mod) {
		event.preventDefault();
		handleEnter();
		return;
	}
	if (key === "Backspace" && !mod && !event.altKey) {
		if (handleBackspace()) event.preventDefault();
		return;
	}
	if (key === "Home" && !mod && !event.altKey) {
		event.preventDefault();
		smartHome(event.shiftKey);
		return;
	}
	if (
		!mod &&
		!event.altKey &&
		(PAIRS[key] || CLOSERS.has(key) || QUOTES.includes(key))
	) {
		if (handlePair(key)) event.preventDefault();
	}
}

function onRootKeydown(event: KeyboardEvent) {
	// 查找面板内只接管 Cmd/Ctrl+F，其余保持输入框默认行为
	const mod = event.metaKey || event.ctrlKey;
	if (mod && !event.altKey && event.key.toLowerCase() === "f") {
		event.preventDefault();
		void openFind();
	}
}

// ---------- 生命周期 ----------

/** 根节点内联样式：外部主题变量 + 动态字号/行高（JS 度量与 CSS 保持一致） */
const rootStyle = computed(() => ({
	...(props.themeVars ?? {}),
	"--ed-font-size": `${fontSizePx.value}px`,
	"--ed-line-height": `${lineHeightPx.value}px`,
}));

// 字号变化后 CSS 变量下一帧才生效：重测字符宽度并刷新光标/定位
watch(fontSizePx, () => {
	void nextTick(() => {
		measureCharWidth();
		updateCursor();
	});
});

function measureCharWidth() {
	const el = taRef.value;
	if (!el) return;
	const style = window.getComputedStyle(el);
	const canvas = document.createElement("canvas");
	const ctx = canvas.getContext("2d");
	if (!ctx) return;
	ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
	const width = ctx.measureText("0".repeat(100)).width / 100;
	if (width > 0) charWidth.value = width;
}

function focus() {
	taRef.value?.focus();
}

defineExpose({
	focus,
	/** 立即上抛 debounce 中尚未 emit 的变更（外层读写 data 前调用，防丢编辑） */
	flush: flushEmit,
	/** 编程式滚动（不触发 scroll 事件）；返回 clamp 后的实际位置 */
	setScroll,
	/** scrollTop → 首行号（0 起） */
	lineAtScrollTop,
	/** 行号（0 起）→ 置顶 scrollTop */
	scrollTopForLine,
	/** 当前行高（px）：供外层做行号↔像素换算（如冲突芯片定位） */
	lineHeightPx: () => lineHeightPx.value,
	/** 当前字号（px） */
	fontSizePx: () => fontSizePx.value,
});

onMounted(() => {
	loadContent(props.data);
	measureCharWidth();
	updateCursor();
	const el = taRef.value;
	if (el) {
		viewportH.value = el.clientHeight || viewportH.value;
		resizeObserver = new ResizeObserver(() => {
			const ta = taRef.value;
			if (ta && ta.clientHeight > 0) viewportH.value = ta.clientHeight;
		});
		resizeObserver.observe(el);
	}
	emit("fold", visibleLineCount.value);
	if (props.autofocus) focus();
});

onBeforeUnmount(() => {
	resizeObserver?.disconnect();
	resizeObserver = null;
	if (caretSyncFrame) {
		cancelAnimationFrame(caretSyncFrame);
		caretSyncFrame = 0;
	}
	if (docWordsTimer) {
		clearTimeout(docWordsTimer);
		docWordsTimer = null;
	}
	document.removeEventListener(
		"pointerdown",
		onStatusMenuDocPointerDown,
		true,
	);
	document.removeEventListener("keydown", onStatusMenuDocKeydown, true);
	flushEmit();
});
</script>

<template>
	<div class="coder-root" :style="rootStyle" @keydown="onRootKeydown">
		<div class="coder-body">
			<!-- 行号栏：仅随垂直滚动平移（含折叠箭头），只渲染屏内行 -->
			<div class="gutter">
				<div
					class="gutter-inner"
					:style="{
						width: `${gutterWidth}px`,
						transform: `translateY(${-scrollY}px)`,
					}"
				>
					<div
						:style="{
							height: `${visibleRange.start * lineHeightPx}px`,
						}"
					/>
					<div
						v-for="line in visibleModels"
						:key="line.srcLine"
						class="gutter-line"
						:class="{
							'is-active':
								line.displayIndex + 1 === activeLineNo &&
								selCount === 0,
							'is-foldable': line.isFoldStart,
							'is-marked': line.marked,
							'is-marked-2': line.marked2,
						}"
					>
						<span class="gutter-num">{{ line.number }}</span>
						<span class="fold-slot">
							<button
								v-if="line.isFoldStart"
								type="button"
								class="fold-toggle"
								:title="
									line.isFolded
										? '展开折叠区域'
										: '折叠代码块'
								"
								@mousedown.prevent
								@click="toggleFold(line.srcLine)"
							>
								<ChevronRight v-if="line.isFolded" :size="12" />
								<ChevronDown v-else :size="12" />
							</button>
						</span>
					</div>
					<div
						:style="{
							height: `${
								(visibleRange.total - visibleRange.end) *
								lineHeightPx
							}px`,
						}"
					/>
				</div>
			</div>

			<!-- 代码区：高亮层在下，透明 textarea 在上 -->
			<div class="code-pane">
				<div class="coder-layers" aria-hidden="true">
					<div
						class="layers-inner"
						:style="{
							transform: `translate(${-scrollX}px, ${-scrollY}px)`,
						}"
					>
						<div
							v-if="selCount === 0"
							class="active-line"
							:style="{
								top: `${(activeLineNo - 1) * lineHeightPx + PAD_Y}px`,
							}"
						/>
						<!-- 查找匹配高亮：黄色=全部匹配，橙色=当前跳转到的匹配 -->
						<div
							v-if="visibleSearchMarks.length"
							class="search-marks"
						>
							<div
								v-for="mk in visibleSearchMarks"
								:key="mk.mi"
								class="search-mark"
								:class="{ 'is-current': mk.mi === matchIndex }"
								:style="{
									left: `${mk.x}px`,
									top: `${mk.y}px`,
									width: `${mk.w}px`,
									height: `${lineHeightPx}px`,
								}"
							/>
						</div>
						<div
							class="code-lines"
							:style="{ minWidth: `${contentWidth}px` }"
						>
							<div
								:style="{
									height: `${
										visibleRange.start * lineHeightPx
									}px`,
								}"
							/>
							<div
								v-for="line in visibleModels"
								:key="line.srcLine"
								class="code-line"
								:class="{
									'is-marked': line.marked,
									'is-marked-2': line.marked2,
								}"
							>
								<span
									v-for="seg in line.segs"
									:key="seg.level"
									class="indent-seg"
									:style="segStyle(seg.level)"
									>{{ seg.spaces }}</span
								><!-- eslint-disable-next-line vue/no-v-html -->
								<span
									class="code-body"
									v-html="line.bodyHtml"
								/>
							</div>
							<div
								:style="{
									height: `${
										(visibleRange.total -
											visibleRange.end) *
										lineHeightPx
									}px`,
								}"
							/>
						</div>
						<div
							v-if="showCaret"
							class="coder-caret"
							:style="{
								height: `${caretHeightPx}px`,
								transform: `translate(${caretX}px, ${
									caretY + PAD_Y + caretTopPx
								}px)`,
							}"
						/>
					</div>
				</div>
				<!-- 光标 X 坐标镜像测量层（不可见，不参与布局） -->
				<pre
					ref="caretMirrorEl"
					class="caret-mirror"
					aria-hidden="true"
				/>
				<textarea
					ref="taRef"
					class="coder-input"
					:value="text"
					:readonly="readonly"
					wrap="off"
					spellcheck="false"
					autocomplete="off"
					autocapitalize="off"
					autocorrect="off"
					aria-label="代码编辑器"
					:placeholder="readonly ? '' : placeholder"
					@input="onInput"
					@paste="unfoldAll"
					@cut="unfoldAll"
					@drop.prevent
					@scroll="syncScroll"
					@keydown.stop="onEditorKeydown"
					@keyup="updateCursor"
					@mouseup="updateCursor"
					@click="updateCursor"
					@select="updateCursor"
					@focus="onFocus"
					@blur="onBlur"
					@compositionstart="hideCompletion"
					@compositionend="refreshCompletion"
				/>
				<!-- 透镜行：浮在 textarea 之上的不透明覆盖条（内容由外层 #lens 插槽提供）；
				     随内容垂直滚动，水平方向固定；除插槽内芯片外点击穿透到 textarea -->
				<div v-if="lensRows.length" class="lens-layer">
					<div
						v-for="row in lensRows"
						:key="row.idx"
						class="lens-row"
						:style="{
							top: `${row.top}px`,
							height: `${lensStripH}px`,
						}"
					>
						<slot name="lens" :line="row.line" :index="row.idx" />
					</div>
				</div>
				<!-- 关键字补全面板：锚定光标；Tab 确认 / Esc 关闭 / ↑↓ 选择 -->
				<div
					v-if="completion"
					class="completion-pop"
					:style="completionPos"
				>
					<button
						v-for="(item, i) in completion.items"
						:key="item"
						type="button"
						class="completion-item"
						:class="{ 'is-active': i === completion.index }"
						:title="item"
						@mousedown.prevent
						@click="acceptCompletion(i)"
					>
						{{ item }}
					</button>
				</div>
			</div>
		</div>

		<!-- 查找 / 替换浮层 -->
		<div v-if="findOpen" class="find-panel">
			<div class="find-row">
				<Search class="find-icon" />
				<input
					ref="findInputEl"
					v-model="findQuery"
					class="find-input"
					placeholder="查找"
					@keydown.enter.prevent="findNext($event.shiftKey ? -1 : 1)"
					@keydown.esc.prevent="closeFind"
				/>
				<button
					type="button"
					class="find-btn aa"
					:class="{ 'is-on': matchCase }"
					title="区分大小写"
					@click="matchCase = !matchCase"
				>
					Aa
				</button>
				<span class="find-count">{{ matchLabel }}</span>
				<button
					type="button"
					class="find-btn"
					title="上一个（Shift+Enter）"
					@click="findNext(-1)"
				>
					<ChevronUp />
				</button>
				<button
					type="button"
					class="find-btn"
					title="下一个（Enter）"
					@click="findNext(1)"
				>
					<ChevronDown />
				</button>
				<button
					type="button"
					class="find-btn"
					title="关闭（Esc）"
					@click="closeFind"
				>
					<X />
				</button>
			</div>
			<div v-if="!readonly" class="find-row">
				<Replace class="find-icon" />
				<input
					ref="replaceInputEl"
					v-model="replaceQuery"
					class="find-input"
					placeholder="替换"
					@keydown.enter.prevent="replaceCurrent"
					@keydown.esc.prevent="closeFind"
				/>
				<Tooltip text="替换" :delay="0">
					<button
						type="button"
						class="find-btn"
						aria-label="替换"
						@click="replaceCurrent"
					>
						<Replace />
					</button>
				</Tooltip>
				<Tooltip text="全部替换" :delay="0">
					<button
						type="button"
						class="find-btn"
						aria-label="全部替换"
						@click="replaceAllMatches"
					>
						<ReplaceAll />
					</button>
				</Tooltip>
			</div>
		</div>

		<!-- 状态栏：Ln/Col｜已选｜（status-prefix 插槽：最后编辑等）｜缩进选择｜语言选择｜只读 -->
		<div class="status-bar">
			<span class="status-item"
				>Ln {{ cursorLine }}, Col {{ cursorCol }}</span
			>
			<span v-if="selCount > 0" class="status-item">
				已选 {{ selCount }} 字符
			</span>
			<span class="status-spacer" />
			<!-- 前缀扩展插槽：渲染在「字号: x」之前（如文档页的「最后编辑」） -->
			<slot name="status-prefix" />
			<span
				v-if="statusControls"
				ref="fontWrapEl"
				class="status-menu-wrap"
			>
				<button
					type="button"
					class="status-item status-btn"
					title="调整编辑器字号（仅编辑器内部，不影响应用全局字号）"
					@click="toggleFontMenu"
				>
					字号: {{ fontSizePx }}
				</button>
				<div v-if="fontMenuOpen" class="status-menu">
					<button
						v-for="n in FONT_OPTIONS"
						:key="n"
						type="button"
						class="status-menu-item"
						:class="{ 'is-active': n === fontSizePx }"
						@click="pickFontSize(n)"
					>
						{{ n }} px
					</button>
				</div>
			</span>
			<span
				v-if="statusControls && !readonly"
				ref="indentWrapEl"
				class="status-menu-wrap"
			>
				<button
					type="button"
					class="status-item status-btn"
					title="点击选择缩进空格数"
					@click="toggleIndentMenu"
				>
					空格: {{ indentSize }}
				</button>
				<div v-if="indentMenuOpen" class="status-menu">
					<button
						v-for="n in INDENT_OPTIONS"
						:key="n"
						type="button"
						class="status-menu-item"
						:class="{ 'is-active': n === indentSize }"
						@click="pickIndent(n)"
					>
						{{ n }} 空格
					</button>
				</div>
			</span>
			<span v-else-if="statusControls" class="status-item"
				>空格: {{ indentSize }}</span
			>
			<span
				v-if="statusControls"
				ref="langWrapEl"
				class="status-menu-wrap"
			>
				<button
					type="button"
					class="status-item status-btn"
					title="点击选择语言"
					@click="toggleLangMenu"
				>
					{{ langLabel }}
				</button>
				<div v-if="langMenuOpen" class="status-menu status-menu-lang">
					<button
						type="button"
						class="status-menu-item"
						:class="{ 'is-active': manualLang === null }"
						@click="pickLang(null)"
					>
						自动检测
					</button>
					<button
						v-for="opt in LANGUAGE_OPTIONS"
						:key="opt.id"
						type="button"
						class="status-menu-item"
						:class="{ 'is-active': opt.id === currentLang }"
						@click="pickLang(opt.id)"
					>
						{{ opt.label }}
					</button>
				</div>
			</span>
			<span v-if="readonly" class="status-item status-readonly"
				>只读</span
			>
		</div>
	</div>
</template>

<style scoped>
.coder-root {
	/* 行高/字号/字体：三层（行号、高亮层、textarea）必须严格一致 */
	--ed-font-size: 13px;
	--ed-line-height: 20px;
	--ed-font-family:
		ui-monospace, sfmono-regular, "sf mono", menlo, consolas,
		"liberation mono", monospace;
	--ed-pad-y: 8px;
	--ed-pad-x: 12px;

	/* 基础色：优先用外部 themeVars 传入的 shadcn 风格变量，
	       未传时回退到 GitView 全局 token（--bg-app / --text / …） */
	--ed-border: color-mix(in oklab, var(--border, #31353e) 70%, transparent);
	--ed-muted: color-mix(
		in oklab,
		var(--muted-foreground, var(--text-dim, #8b909c)) 80%,
		transparent
	);
	--ed-gutter-bg: color-mix(
		in oklab,
		var(--muted, var(--bg-panel-2, #262a32)) 45%,
		var(--background, var(--bg-app, #1b1d23))
	);
	--ed-active-line: color-mix(
		in oklab,
		var(--foreground, var(--text, #d7dae0)) 5%,
		transparent
	);
	--ed-selection: color-mix(
		in oklab,
		var(--primary, var(--accent, #4c8dff)) 28%,
		transparent
	);
	--ed-scrollbar: color-mix(
		in oklab,
		var(--foreground, var(--text, #d7dae0)) 16%,
		transparent
	);
	--ed-scrollbar-hover: color-mix(
		in oklab,
		var(--foreground, var(--text, #d7dae0)) 30%,
		transparent
	);

	/* 外部标注行（如冲突区域）默认色：可由 themeVars 按面板覆盖 */
	--ed-mark-bg: color-mix(in oklab, var(--yellow, #e3b341) 14%, transparent);
	--ed-mark-bar: transparent;

	/* 第二组外部标注行默认色（如源码编辑中 C 侧代码行） */
	--ed-mark-bg-2: color-mix(
		in oklab,
		var(--accent, #4c8dff) 14%,
		transparent
	);
	--ed-mark-bar-2: transparent;

	/* 语法高亮（Auto 亮色：GitHub Light 风） */
	--hl-kw: #cf222e;
	--hl-str: #0a3069;
	--hl-num: #0550ae;
	--hl-com: #6e7781;
	--hl-fn: #8250df;
	--hl-type: #953800;
	--hl-var: #953800;
	--hl-attr: #116329;
	--hl-tag: #116329;
	--hl-sel: #6639ba;
	--hl-meta: #57606a;
	--hl-section: #0550ae;
	--hl-regexp: #116329;
	--hl-del: #82071e;
	--hl-link: #0a3069;

	position: relative;
	display: flex;
	flex-direction: column;
	height: 100%;
	min-height: 0;
	overflow: hidden;
	background: var(--background, var(--bg-app, #fff));
	color: var(--foreground, var(--text, #222));
}

.dark .coder-root,
:root[data-theme="dark"] .coder-root {
	/* 语法高亮（Auto 暗色：Tokyo Night 风） */
	--hl-kw: #bb9af7;
	--hl-str: #9ece6a;
	--hl-num: #ff9e64;
	--hl-com: #565f89;
	--hl-fn: #7aa2f7;
	--hl-type: #2ac3de;
	--hl-var: #c0caf5;
	--hl-attr: #73daca;
	--hl-tag: #f7768e;
	--hl-sel: #e0af68;
	--hl-meta: #7dcfff;
	--hl-section: #7aa2f7;
	--hl-regexp: #89ddff;
	--hl-del: #f7768e;
	--hl-link: #73daca;
	--ed-selection: rgba(38, 79, 120, 0.7);
}

/* ---------- 布局 ---------- */

.coder-body {
	display: flex;
	flex: 1;
	min-height: 0;
	min-width: 0;
}

.gutter {
	flex-shrink: 0;
	overflow: hidden;
	background: var(--ed-gutter-bg);
	border-right: 1px solid var(--ed-border);
	user-select: none;
}

.gutter-inner {
	padding: var(--ed-pad-y) 0;
	will-change: transform;
}

.gutter-line {
	display: flex;
	align-items: center;
	height: var(--ed-line-height);
	padding-right: 6px;
	font-family: var(--ed-font-family);
	font-size: var(--ed-font-size);
	line-height: var(--ed-line-height);
	color: var(--ed-muted);
}

.gutter-num {
	flex: 1;
	text-align: right;
	padding-right: 8px;
	font-variant-numeric: tabular-nums;
}

.fold-slot {
	width: 14px;
	flex-shrink: 0;
	display: inline-flex;
	align-items: center;
	justify-content: center;
}

.fold-toggle {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 14px;
	height: var(--ed-line-height);
	padding: 0;
	border: 0;
	background: transparent;
	color: var(--ed-muted);
	cursor: pointer;
	opacity: 0;
	visibility: hidden;
	transition: opacity 0.12s ease;
}

.fold-toggle:hover {
	color: var(--foreground);
}

.gutter-line.is-foldable:hover .fold-toggle {
	opacity: 1;
	visibility: visible;
}

.gutter-line.is-active {
	color: var(--foreground);
}

/* 外部标注行（冲突区域）：行号栏同步着色，保持视觉连续 */
.gutter-line.is-marked {
	background: var(--ed-mark-bg);
}

.gutter-line.is-marked-2 {
	background: var(--ed-mark-bg-2);
}

.code-pane {
	position: relative;
	flex: 1;
	min-width: 0;
}

.coder-layers {
	position: absolute;
	inset: 0;
	overflow: hidden;
	pointer-events: none;
}

.layers-inner {
	position: absolute;
	top: 0;
	left: 0;
	width: 100%;
	min-width: max-content;
	will-change: transform;
}

.active-line {
	position: absolute;
	left: 0;
	right: 0;
	height: var(--ed-line-height);
	background: var(--ed-active-line);
}

/* 查找匹配高亮：黄色半透底=全部匹配；橙色+描边=当前跳转到的匹配 */
.search-marks {
	position: absolute;
	top: 0;
	left: 0;
	pointer-events: none;
}

.search-mark {
	position: absolute;
	border-radius: 2px;
	background: color-mix(in oklab, var(--yellow, #e3b341) 35%, transparent);
}

.search-mark.is-current {
	background: color-mix(in oklab, #ff9e64 55%, transparent);
	box-shadow: 0 0 0 1px color-mix(in oklab, #ff9e64 90%, transparent);
}

/* 透镜行：浮在 textarea 之上的不透明覆盖条（z-index 低于补全/查找/状态栏菜单）。
   容器与条带本身不响应指针，插槽内容之外的点击穿透到 textarea（仍可定位光标）；
   插槽内的交互元素（如芯片按钮）需自行设置 pointer-events: auto。 */
.lens-layer {
	position: absolute;
	inset: 0;
	overflow: hidden;
	pointer-events: none;
	z-index: 5;
}

.lens-row {
	position: absolute;
	left: 0;
	right: 0;
	display: flex;
	align-items: center;
	gap: 4px;
	padding: 0 var(--ed-pad-x);
	background: var(--ed-lens-bg, var(--background, var(--bg-app, #1b1d23)));
	box-shadow: inset 0 -1px 0 var(--ed-border);
	pointer-events: none;
	white-space: nowrap;
	overflow: hidden;
}

.code-lines {
	margin: 0;
	padding: var(--ed-pad-y) var(--ed-pad-x);
	width: max-content;
	min-width: 100%;
	font-family: var(--ed-font-family);
	font-size: var(--ed-font-size);
	line-height: var(--ed-line-height);
	tab-size: 4;
	font-variant-ligatures: none;
	white-space: pre;
}

.code-line {
	height: var(--ed-line-height);
}

/* 外部标注行（如三方合并中的冲突区域）：底色 + 左侧色条 */
.code-line.is-marked {
	background: var(--ed-mark-bg);
	box-shadow: inset 2px 0 0 var(--ed-mark-bar);
}

/* 第二组标注行：独立着色 */
.code-line.is-marked-2 {
	background: var(--ed-mark-bg-2);
	box-shadow: inset 2px 0 0 var(--ed-mark-bar-2);
}

.indent-seg {
	/* 缩进段：底纹渲染彩虹色块。
       display:inline-block + height 与行高一致，保证行盒尺寸稳定。 */
	display: inline-block;
	height: var(--ed-line-height);
	white-space: pre;
}

.code-body {
	display: inline;
	white-space: pre;
}

.coder-input {
	position: absolute;
	inset: 0;
	width: 100%;
	height: 100%;
	margin: 0;
	padding: var(--ed-pad-y) var(--ed-pad-x);
	border: 0;
	outline: none;
	resize: none;
	background: transparent;
	color: transparent;
	/* 原生光标隐藏，由 .coder-caret 自绘（高度与文本匹配） */
	caret-color: transparent;
	font-family: var(--ed-font-family);
	font-size: var(--ed-font-size);
	line-height: var(--ed-line-height);
	tab-size: 4;
	font-variant-ligatures: none;
	white-space: pre;
	overflow: auto;
}

.coder-input::placeholder {
	color: var(--ed-muted);
}

.coder-input::selection {
	background: var(--ed-selection);
	color: transparent;
}

.coder-caret {
	position: absolute;
	top: 0;
	left: 0;
	width: 2px;
	height: 15px;
	border-radius: 1px;
	background: var(--foreground);
	pointer-events: none;
	animation: coder-caret-blink 1.1s steps(1) infinite;
}

/* 光标镜像测量层：排版必须与 .hl-pre 一致（仅去Y向 padding，
   offsetLeft 才等于高亮层内文本的真实 x） */
.caret-mirror {
	position: absolute;
	top: 0;
	left: 0;
	margin: 0;
	padding: 0 var(--ed-pad-x);
	overflow: hidden;
	visibility: hidden;
	white-space: pre;
	font-family: var(--ed-font-family);
	font-size: var(--ed-font-size);
	line-height: var(--ed-line-height);
	tab-size: 4;
	font-variant-ligatures: none;
	pointer-events: none;
}

@keyframes coder-caret-blink {
	50% {
		opacity: 0;
	}
}

.coder-input::-webkit-scrollbar {
	width: 14px;
	height: 14px;
}

.coder-input::-webkit-scrollbar-thumb {
	border: 4px solid transparent;
	border-radius: 8px;
	background: var(--ed-scrollbar);
	background-clip: padding-box;
}

.coder-input::-webkit-scrollbar-thumb:hover {
	background: var(--ed-scrollbar-hover);
	background-clip: padding-box;
}

.coder-input::-webkit-scrollbar-corner {
	background: transparent;
}

/* ---------- 查找 / 替换面板 ---------- */

.find-panel {
	position: absolute;
	top: 8px;
	right: 16px;
	z-index: 20;
	display: flex;
	flex-direction: column;
	gap: 6px;
	padding: 8px;
	border: 1px solid var(--ed-border);
	border-radius: 10px;
	background: var(--background);
	box-shadow: 0 8px 24px rgb(0 0 0 / 14%);
}

.find-row {
	display: flex;
	align-items: center;
	gap: 4px;
}

.find-icon {
	flex-shrink: 0;
	width: 14px;
	height: 14px;
	color: var(--ed-muted);
}

.find-input {
	width: 180px;
	height: 26px;
	padding: 0 6px;
	border: 1px solid var(--ed-border);
	border-radius: 6px;
	outline: none;
	background: transparent;
	color: inherit;
	font-size: 12px;
}

.find-input:focus {
	border-color: var(--ring);
}

.find-input::placeholder {
	color: var(--ed-muted);
}

.find-btn {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 24px;
	height: 24px;
	padding: 0;
	border: none;
	border-radius: 6px;
	background: transparent;
	color: var(--ed-muted);
	cursor: pointer;
}

.find-btn:hover {
	background: color-mix(in oklab, var(--foreground) 8%, transparent);
	color: var(--foreground);
}

.find-btn svg {
	width: 14px;
	height: 14px;
}

.find-btn.aa {
	width: auto;
	padding: 0 5px;
	font-size: 11px;
	font-weight: 600;
}

.find-btn.is-on {
	border: 1px solid color-mix(in oklab, var(--primary) 45%, transparent);
	background: color-mix(in oklab, var(--primary) 14%, transparent);
	color: var(--primary);
}

.find-count {
	min-width: 44px;
	text-align: center;
	font-size: 11px;
	color: var(--ed-muted);
	font-variant-numeric: tabular-nums;
}

/* ---------- 关键字补全面板 ---------- */
.completion-pop {
	position: absolute;
	z-index: 30;
	min-width: 208px;
	max-width: 280px;
	max-height: calc(9 * var(--ed-line-height) + 8px);
	overflow-y: auto;
	padding: 3px;
	border: 1px solid var(--ed-border);
	border-radius: 8px;
	background: var(--ed-gutter-bg);
	box-shadow: 0 8px 24px rgb(0 0 0 / 25%);
}

.completion-item {
	display: block;
	width: 100%;
	height: var(--ed-line-height);
	padding: 0 8px;
	border: 0;
	border-radius: 5px;
	background: transparent;
	color: var(--foreground);
	font-family: var(--ed-font-family);
	font-size: var(--ed-font-size);
	line-height: var(--ed-line-height);
	text-align: left;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
	cursor: pointer;
}

.completion-item:hover,
.completion-item.is-active {
	background: var(--ed-active-line);
}

/* ---------- 状态栏 ---------- */

.status-bar {
	display: flex;
	flex-shrink: 0;
	gap: 14px;
	align-items: center;
	height: 24px;
	padding: 0 12px;
	border-top: 1px solid var(--ed-border);
	background: var(--ed-gutter-bg);
	color: var(--ed-muted);
	font-size: 11px;
	font-variant-numeric: tabular-nums;
	user-select: none;
}

.status-spacer {
	flex: 1;
}

.status-btn {
	padding: 0;
	border: 0;
	background: transparent;
	font: inherit;
	color: inherit;
	cursor: pointer;
}

.status-btn:hover {
	color: var(--foreground);
}

/* 状态栏选择菜单（缩进/语言）：在触发项上方向上弹出 */
.status-menu-wrap {
	position: relative;
	display: inline-flex;
}

.status-menu {
	position: absolute;
	right: 0;
	bottom: calc(100% + 6px);
	z-index: 40;
	min-width: 96px;
	max-height: 240px;
	padding: 3px;
	overflow-y: auto;
	border: 1px solid var(--ed-border);
	border-radius: 8px;
	background: var(--ed-gutter-bg);
	box-shadow: 0 8px 24px rgb(0 0 0 / 25%);
}

.status-menu-lang {
	min-width: 132px;
}

.status-menu-item {
	display: block;
	width: 100%;
	padding: 0 8px;
	border: 0;
	border-radius: 5px;
	background: transparent;
	color: var(--foreground);
	font: inherit;
	line-height: 20px;
	text-align: left;
	white-space: nowrap;
	cursor: pointer;
}

.status-menu-item:hover {
	background: var(--ed-active-line);
}

.status-menu-item.is-active {
	color: var(--primary);
	background: var(--ed-active-line);
}

.status-readonly {
	color: var(--primary);
}

/* ---------- 语法高亮（v-html 内容无 scoped 属性，需 :deep） ---------- */

.coder-root :deep(.hljs-keyword),
.coder-root :deep(.hljs-selector-tag),
.coder-root :deep(.hljs-doctag),
.coder-root :deep(.hljs-literal) {
	color: var(--hl-kw);
}

.coder-root :deep(.hljs-string),
.coder-root :deep(.hljs-symbol),
.coder-root :deep(.hljs-bullet) {
	color: var(--hl-str);
}

.coder-root :deep(.hljs-regexp) {
	color: var(--hl-regexp);
}

.coder-root :deep(.hljs-number),
.coder-root :deep(.hljs-addition) {
	color: var(--hl-num);
}

.coder-root :deep(.hljs-deletion) {
	color: var(--hl-del);
}

.coder-root :deep(.hljs-comment),
.coder-root :deep(.hljs-quote) {
	color: var(--hl-com);
	font-style: italic;
}

.coder-root :deep(.hljs-title),
.coder-root :deep(.hljs-title.function_) {
	color: var(--hl-fn);
}

.coder-root :deep(.hljs-title.class_),
.coder-root :deep(.hljs-type),
.coder-root :deep(.hljs-built_in),
.coder-root :deep(.hljs-builtin-name) {
	color: var(--hl-type);
}

.coder-root :deep(.hljs-variable),
.coder-root :deep(.hljs-template-variable),
.coder-root :deep(.hljs-params) {
	color: var(--hl-var);
}

.coder-root :deep(.hljs-attr),
.coder-root :deep(.hljs-attribute),
.coder-root :deep(.hljs-property) {
	color: var(--hl-attr);
}

.coder-root :deep(.hljs-tag),
.coder-root :deep(.hljs-name) {
	color: var(--hl-tag);
}

.coder-root :deep(.hljs-selector-id),
.coder-root :deep(.hljs-selector-class),
.coder-root :deep(.hljs-selector-attr),
.coder-root :deep(.hljs-selector-pseudo) {
	color: var(--hl-sel);
}

.coder-root :deep(.hljs-meta) {
	color: var(--hl-meta);
}

.coder-root :deep(.hljs-section) {
	color: var(--hl-section);
}

.coder-root :deep(.hljs-section) {
	font-weight: 600;
}

.coder-root :deep(.hljs-link) {
	color: var(--hl-link);
	text-decoration: underline;
}

.coder-root :deep(.hljs-emphasis) {
	font-style: italic;
}

.coder-root :deep(.hljs-strong) {
	font-weight: 600;
}
</style>
