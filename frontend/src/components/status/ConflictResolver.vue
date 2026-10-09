<script setup lang="ts">
// 冲突解决器（选中冲突文件时的默认视图）。
//
// 两种视图：
// - 冲突透视（默认）：三窗格布局 —— 上方 B（当前分支完整内容，只读）与
//   C（传入分支完整内容，只读）左右对照，下方 D（合并结果，可编辑）。
//   三个窗格都显示全量文件内容，冲突区域按面板着色高亮（B 绿 / C 蓝 / D 黄）；
//   窗格之间的分割条可拖拽调整宽/高；三窗格按行对齐映射同步滚动；
//   每个冲突块顶部以 Coder 透镜行（#lens 插槽）展示「保留 xxx」芯片：
//   B/C 面板各自提供单侧取舍，D 面板提供「保留 B / 保留 C / 保留两者」；
//   工具条冲突徽章可点击跳回首个冲突；支持全屏展示（与 Stash 详情最大化同款）。
// - 源码编辑：直接编辑带冲突标记的原始文件（= D 的全屏化，与 D 共享同一份
//   内容与透镜行芯片）。
//
// 字号/语言在 D（或源码编辑）的状态栏统一调整，同步应用到 B/C 三个编辑器；
// 字号本地持久化。冲突块解析始终以 D 的当前内容为准（扫描 <<<<<<< /
// ======= / >>>>>>> 标记），因此手动编辑 D 之后快捷按钮依然定位准确。
import {
	computed,
	nextTick,
	onBeforeUnmount,
	onMounted,
	ref,
	watch,
} from "vue";
import { useRepo } from "../../stores/repo";
import { useUI } from "../../stores/ui";
import { errMsg, GitService } from "../../api";
import type { Commit, CommitFile, ConflictDetail } from "../../api";
import Icon from "../ui/Icon.vue";
import Spinner from "../ui/Spinner.vue";
import DiffViewer from "../common/DiffViewer.vue";
import {
	CODER_DEFAULT_FONT_SIZE,
	CoderView,
	snapFontOption,
	coderLineHeight,
} from "../Coder";
import {
	buildMergeAlign,
	parseHunks,
	type Hunk,
	type PaneId,
} from "../../utils/mergeAlign";
import { statusColor } from "../../utils/format";

const props = defineProps<{ path: string }>();

const repo = useRepo();
const ui = useUI();

type Mode = "merge3" | "source";
const MODE_KEY = "gv.conflictMode";
const mode = ref<Mode>(loadMode());
/** 冲突透视是默认的冲突解决形式（用户上次显式选择的视图仍会记住） */
function loadMode(): Mode {
	return localStorage.getItem(MODE_KEY) === "source" ? "source" : "merge3";
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

// ------------------------------------------------------------- 行级 blame 标注与右键历史

/** 当前光标行的 blame 信息（仅在 D 面板 / 源码编辑模式下启用） */
const annotLine = ref<{ line: number; author: string; time: string } | null>(
	null,
);
const annotLoading = ref(false);
/** blast debounce timer：避免快速移动光标时频繁调用 git */
let annotTimer: ReturnType<typeof setTimeout> | null = null;

/** 右键自定义上下文菜单 */
const ctxMenuVisible = ref(false);
const ctxMenuX = ref(0);
const ctxMenuY = ref(0);
const ctxMenuLine = ref(1);

/** 防止拖拽抽屉宽度后末尾的 click 事件误关闭抽屉 */
let lastDragEnd = 0;

/** 历史记录抽屉（从右侧滑入，可拖拽调整宽度，存储为 vw 百分比） */
const DRAWER_KEY = "gv.conflict.drawerW";
const drawerVisible = ref(false);
function loadDrawerWidth(): number {
	const raw = Number(localStorage.getItem(DRAWER_KEY));
	if (!raw || isNaN(raw)) return 50;
	// 旧格式兼容：> 100 的值为旧像素值，转换为 vw
	if (raw > 100) {
		return Math.round(
			Math.max(10, Math.min(90, (raw / window.innerWidth) * 100)),
		);
	}
	return Math.max(10, Math.min(90, raw));
}
const drawerWidth = ref(loadDrawerWidth());
const drawerTitle = ref("");
const drawerCommits = ref<
	Array<{
		hash: string;
		fullHash: string;
		author: string;
		time: string;
		subject: string;
	}>
>([]);
const drawerLoading = ref(false);
/** 当前在提交列表中选中的提交（fullHash），用于高亮与右侧详情 */
const drawerActiveHash = ref("");
/** 选中提交的详情：元数据 + 变更文件列表 */
const drawerCommitInfo = ref<Commit | null>(null);
const drawerCommitFiles = ref<CommitFile[]>([]);
const drawerFilesLoading = ref(false);
/** 在文件列表中选中的文件 */
const drawerSelectedFile = ref("");
const drawerFileDiff = ref("");
const drawerFileDiffLoading = ref(false);

/** 行标注：当前光标行的 blame 信息，传给 Coder 在该行后面内联渲染 */
const lineAnnot = computed(() => {
	if (!annotLine.value) return null;
	return {
		line: annotLine.value.line,
		text: `${annotLine.value.author} · ${annotLine.value.time}`,
	};
});

/** 把 Unix 秒转为可读的「X 天前 / Y 小时前 / 日期」字符串 */
function relativeTime(ts: number): string {
	const now = Math.floor(Date.now() / 1000);
	const diff = now - ts;
	if (diff < 60) return "刚刚";
	if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
	if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
	if (diff < 2592000) return `${Math.floor(diff / 86400)} 天前`;
	return new Date(ts * 1000).toLocaleDateString("zh-CN");
}

/** 解析 git blame --porcelain 单行输出，返回 { author, time } */
function parseBlameLine(
	output: string,
): { author: string; time: string } | null {
	if (!output.trim()) return null;
	let author = "";
	let ts = 0;
	for (const line of output.split("\n")) {
		if (line.startsWith("author ")) author = line.slice(7);
		else if (line.startsWith("author-time ")) ts = Number(line.slice(12));
	}
	if (!author) return null;
	return { author, time: ts > 0 ? relativeTime(ts) : "" };
}

/** 解析 git log --oneline --format=... 的多行输出为历史记录列表 */
function parseLogLines(output: string): Array<{
	hash: string;
	fullHash: string;
	author: string;
	time: string;
	subject: string;
}> {
	const commits: Array<{
		hash: string;
		fullHash: string;
		author: string;
		time: string;
		subject: string;
	}> = [];
	for (const line of output.trim().split("\n")) {
		if (!line.trim()) continue;
		// 期望格式：HASH \x1f AUTHOR \x1f TIMESTAMP \x1f SUBJECT
		const parts = line.split("\x1f");
		if (parts.length < 4) continue;
		const fullHash = parts[0]!.trim();
		const author = parts[1]!.trim();
		const ts = Number(parts[2]);
		const subject = parts.slice(3).join("\x1f").trim();
		commits.push({
			hash: fullHash.length > 8 ? fullHash.slice(0, 8) : fullHash,
			fullHash,
			author,
			time: ts > 0 ? relativeTime(ts) : "",
			subject,
		});
	}
	return commits;
}

/** 当前哪个编辑器被操作：'d'（冲突透视 D 面板）| 'src'（源码编辑） */
type BlameTarget = "d" | "src";

/** 取对应目标的 Coder 实例 */
function coderForBlame(t: BlameTarget): CoderInst | null {
	return t === "d" ? dCoder.value : srcCoder.value;
}

/** 光标移动到新行：延迟获取该行的 blame 信息（只在 D / 源码编辑模式下启用） */
function onCoderCursorChange(line: number, target: BlameTarget) {
	if (annotTimer) clearTimeout(annotTimer);
	annotTimer = setTimeout(() => {
		annotTimer = null;
		void fetchBlame(line, target);
	}, 300);
}

/** 右键弹出：记录行号和位置，显示自定义菜单 */
function onCoderContextMenu(line: number, e: MouseEvent, target: BlameTarget) {
	ctxMenuLine.value = line;
	ctxMenuX.value = e.clientX;
	ctxMenuY.value = e.clientY;
	ctxMenuVisible.value = true;
	// 同时把光标行设置为该行，方便 blame 展示
	onCoderCursorChange(line, target);
}

function closeContextMenu() {
	ctxMenuVisible.value = false;
}

function closeDrawer() {
	drawerVisible.value = false;
	drawerActiveHash.value = "";
	drawerCommitInfo.value = null;
	drawerCommitFiles.value = [];
	drawerSelectedFile.value = "";
	drawerFileDiff.value = "";
}

/** 获取指定行的 blame 信息 */
async function fetchBlame(line: number, target: BlameTarget) {
	if (!props.path || !repo.path) return;
	// 只对 D（合并结果）或源码编辑启用：它们显示的是 worktree 内容，
	// blame 有明确含义（指向该行最后一次变更的提交）
	annotLoading.value = true;
	try {
		const res = await GitService.RunGitStep(
			repo.path,
			["blame", "--porcelain", "-L", `${line},${line}`, "--", props.path],
			false,
		);
		if (res?.ok) {
			const info = parseBlameLine(res.output);
			if (info) {
				annotLine.value = { line, ...info };
			} else {
				annotLine.value = null;
			}
		} else {
			annotLine.value = null;
		}
	} catch {
		annotLine.value = null;
	} finally {
		annotLoading.value = false;
	}
}

/** 查看当前行的历史：展示文件变更历史，并在列表中高亮 blame 定位到的最近一次提交 */
async function showLineHistory(line: number) {
	closeContextMenu();
	if (!props.path || !repo.path) return;
	drawerTitle.value = `${props.path} 的变更历史`;
	drawerCommits.value = [];
	drawerActiveHash.value = "";
	drawerCommitInfo.value = null;
	drawerCommitFiles.value = [];
	drawerSelectedFile.value = "";
	drawerFileDiff.value = "";
	drawerVisible.value = true;
	drawerLoading.value = true;
	try {
		// 使用 git log -- <file> 获取文件变更历史（比 -L 更稳定可靠）
		const res = await GitService.RunGitStep(
			repo.path,
			[
				"log",
				"--format=%H%x1f%an%x1f%at%x1f%s",
				"-n",
				"50",
				"--",
				props.path,
			],
			false,
		);
		if (res?.ok) {
			drawerCommits.value = parseLogLines(res.output);
			if (drawerCommits.value.length > 0) {
				// 如果已获取当前行的 blame，尝试定位到最近一次修改该行的提交
				if (annotLine.value && annotLine.value.line === line) {
					const blameAuthor = annotLine.value.author;
					const match = drawerCommits.value.find(
						(c) => c.author === blameAuthor,
					);
					if (match) {
						void selectDrawerCommit(match.fullHash);
						return;
					}
				}
				// 否则默认选中最近一次提交
				void selectDrawerCommit(drawerCommits.value[0]!.fullHash);
			}
		}
	} catch {
		/* ignore */
	} finally {
		drawerLoading.value = false;
	}
}

/** 查看当前文件的变更历史（git log -- <file>）：在右侧抽屉中展示 */
async function showFileHistory() {
	closeContextMenu();
	if (!props.path || !repo.path) return;
	drawerTitle.value = `${props.path} 的变更历史`;
	drawerCommits.value = [];
	drawerActiveHash.value = "";
	drawerCommitInfo.value = null;
	drawerCommitFiles.value = [];
	drawerSelectedFile.value = "";
	drawerFileDiff.value = "";
	drawerVisible.value = true;
	drawerLoading.value = true;
	try {
		const res = await GitService.RunGitStep(
			repo.path,
			[
				"log",
				"--format=%H%x1f%an%x1f%at%x1f%s",
				"-n",
				"50",
				"--",
				props.path,
			],
			false,
		);
		if (res?.ok) {
			drawerCommits.value = parseLogLines(res.output);
			// 默认选中最近一次提交
			if (drawerCommits.value.length > 0) {
				void selectDrawerCommit(drawerCommits.value[0]!.fullHash);
			}
		}
	} catch {
		/* ignore */
	} finally {
		drawerLoading.value = false;
	}
}

/** 在抽屉中选择一个提交：获取完整提交信息 + 变更文件列表，自动展开第一个文件的 diff */
async function selectDrawerCommit(fullHash: string) {
	if (!repo.path) return;
	drawerActiveHash.value = fullHash;
	drawerCommitInfo.value = null;
	drawerCommitFiles.value = [];
	drawerSelectedFile.value = "";
	drawerFileDiff.value = "";
	drawerFilesLoading.value = true;
	try {
		const [full, files] = await Promise.all([
			GitService.ShowCommit(repo.path, fullHash),
			GitService.CommitFiles(repo.path, fullHash),
		]);
		drawerCommitInfo.value = full;
		drawerCommitFiles.value = files || [];
		// 自动选中与当前文件匹配的第一个（或第一个文件）
		const target = props.path
			? ((files || []).find((f) => f.path === props.path) ??
				(files || [])[0])
			: (files || [])[0];
		if (target) {
			void selectDrawerFile(fullHash, target.path ?? "");
		}
	} catch (e) {
		/* ignore */
	} finally {
		drawerFilesLoading.value = false;
	}
}

/** 在抽屉中选择某个变更文件，获取其 diff */
async function selectDrawerFile(commitHash: string, filePath: string) {
	if (!repo.path) return;
	drawerSelectedFile.value = filePath;
	drawerFileDiff.value = "";
	drawerFileDiffLoading.value = true;
	try {
		const diff = await GitService.CommitDiff(
			repo.path,
			commitHash,
			filePath,
		);
		drawerFileDiff.value = diff || "";
	} catch (e) {
		drawerFileDiff.value = `获取差异失败：${errMsg(e)}`;
	} finally {
		drawerFileDiffLoading.value = false;
	}
}

/** 拖拽抽屉左缘调整宽度（基于视口宽度 vw） */
function startDrawerDrag(e: PointerEvent) {
	e.preventDefault();
	const startX = e.clientX;
	const startW = drawerWidth.value;
	const pxPerVw = window.innerWidth / 100;
	const move = (ev: PointerEvent) => {
		const deltaVw = (startX - ev.clientX) / pxPerVw;
		drawerWidth.value = Math.max(10, Math.min(90, startW + deltaVw));
	};
	const up = () => {
		window.removeEventListener("pointermove", move);
		window.removeEventListener("pointerup", up);
		document.body.style.cursor = "";
		document.body.style.userSelect = "";
		lastDragEnd = Date.now();
		try {
			localStorage.setItem(
				DRAWER_KEY,
				String(Math.round(drawerWidth.value)),
			);
		} catch {
			/* ignore */
		}
	};
	window.addEventListener("pointermove", move);
	window.addEventListener("pointerup", up);
	document.body.style.cursor = "col-resize";
	document.body.style.userSelect = "none";
}

/** 点击菜单外区域时关闭 */
function onCtxMenuDocClick(e: MouseEvent) {
	const target = e.target as HTMLElement | null;
	// 右键菜单：点击菜单外任意位置关闭
	if (ctxMenuVisible.value && target && !target.closest(".ctx-menu")) {
		closeContextMenu();
	}
	// 历史抽屉：点击抽屉外关闭，但忽略拖拽宽度后的末尾 click 事件
	if (
		drawerVisible.value &&
		target &&
		!target.closest(".blame-drawer") &&
		Date.now() - lastDragEnd > 300
	) {
		closeDrawer();
	}
}

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
	getCursorLine(): number;
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
const INDENT_KEY = "gv.coder.indentSize";
/** 字号仅作用于 Coder 内部排版，不影响应用全局字号；默认与应用标准字号一致 */
const fontSize = ref(loadFontSize());
/** 缩进空格数（本地持久化），默认 4 */
const indentSize = ref(loadIndentSize());

function loadFontSize(): number {
	try {
		const n = Number(localStorage.getItem(FONT_KEY));
		// 吸附到菜单档位（历史持久化值可能是旧档位如 15/20/24）
		if (Number.isFinite(n) && n > 0) return snapFontOption(n);
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
	// 行高随字号变化：各窗格原有的 px 滚动偏移不再对应相同行，
	// 等 Coder 重新度量后重新对齐到当前冲突块
	if (hunks.value.length > 0) scheduleScrollToHunk(active.value);
}

function loadIndentSize(): number {
	try {
		const n = Number(localStorage.getItem(INDENT_KEY));
		if (n === 2 || n === 4) return n;
	} catch {
		/* ignore */
	}
	return 4;
}
function onIndentChange(size: number) {
	indentSize.value = size;
	try {
		localStorage.setItem(INDENT_KEY, String(size));
	} catch {
		/* ignore */
	}
}

/** 当前 Coder 行高（px）：与 Coder 内部度量一致，供滚动留白估算 */
const linePx = computed(() => coderLineHeight(fontSize.value));

// ------------------------------------------------------------- 编辑器语言（三窗格共享）

/** 当前语言（highlight.js id；空字符串 = 自动推断）：在 D / 源码编辑的
 *  状态栏选择后回写到全部编辑器，B/C/D（及源码）三者始终同一语言 */
const editorLanguage = ref("");

function onLanguageChange(langId: string) {
	editorLanguage.value = langId;
}

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

/** 同步锁计数器：pushSync 中 setScroll 会触发目标面板的 scroll 事件，
 *  用计数器防止嵌套回环（>0 时 onPaneScroll 直接跳过） */
let syncing = 0;

/** 把 src 面板的滚动位置按行映射推送到其余面板（程序化滚动不会再回传）。
 *  用浮点行号映射（mapLineFloat）+ 行高归一化，消除整数舍入导致的跨行抖动。 */
function pushSync(src: PaneId, top: number, left?: number) {
	const s = coderOf(src);
	if (!s) return;
	const lh = s.lineHeightPx();
	// 转为浮点行号（含行内子像素偏移）：0.0 = 文件首行顶部
	const srcLineFloat = (top - s.scrollTopForLine(0)) / lh;
	const a = align.value;
	for (const dst of PANES) {
		if (dst === src) continue;
		const t = coderOf(dst);
		if (!t) continue;
		const tLh = t.lineHeightPx();
		const dstLineFloat = a.mapLineFloat(src, dst, srcLineFloat);
		t.setScroll(t.scrollTopForLine(0) + dstLineFloat * tLh, left);
	}
}

/** 任一面板滚动：更新当前冲突块 + 同步其余两个面板 */
function onPaneScroll(src: PaneId, top: number, left: number) {
	if (syncing > 0) return;
	syncing++;
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
		syncing--;
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
			t.setScroll(
				Math.max(
					0,
					t.scrollTopForLine(a.mapLine("d", id, h.start)) - pad,
				),
			);
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

/** 冲突高亮色：B 绿（ours）/ C 蓝（theirs）/ D 黄（冲突块）；
 *  --ed-lens-bg 为透镜条带的不透明底色（与面板身份色同色系，盖住被覆盖的代码行） */
const bTheme: Record<string, string> = {
	...coderBase,
	"--ed-mark-bg": "color-mix(in oklab, var(--green) 14%, transparent)",
	"--ed-mark-bar": "var(--green)",
	"--ed-lens-bg": "color-mix(in oklab, var(--green) 16%, var(--bg-app))",
};
const cTheme: Record<string, string> = {
	...coderBase,
	"--ed-mark-bg": "color-mix(in oklab, var(--accent) 14%, transparent)",
	"--ed-mark-bar": "var(--accent)",
	"--ed-lens-bg": "color-mix(in oklab, var(--accent) 16%, var(--bg-app))",
};
const dTheme: Record<string, string> = {
	...coderBase,
	"--ed-mark-bg": "color-mix(in oklab, var(--yellow) 13%, transparent)",
	"--ed-mark-bar": "var(--yellow)",
	"--ed-lens-bg": "color-mix(in oklab, var(--yellow) 15%, var(--bg-app))",
};

/** source 模式 / 冲突透视 D 面板共用主题：B 侧代码绿底、C 侧代码蓝底，
 *  透镜条带用绿色调与 B 侧协调（条带位于 <<<<<<< 行即 B 侧首行） */
const sourceSrcTheme: Record<string, string> = {
	...coderBase,
	"--ed-mark-bg": "color-mix(in oklab, var(--green) 14%, transparent)",
	"--ed-mark-bar": "var(--green)",
	"--ed-mark-bg-2": "color-mix(in oklab, var(--accent) 14%, transparent)",
	"--ed-mark-bar-2": "var(--accent)",
	"--ed-lens-bg": "color-mix(in oklab, var(--green) 16%, var(--bg-app))",
};

// ------------------------------------------------------------- 冲突块透镜行

/** 各面板透镜行（「保留 xxx」芯片条带）锚定的源行号，与 hunks 一一对应：
 *  B/C = 冲突块 ours/theirs 段的前一行（透镜覆盖非冲突代码，冲突内容完全可见），
 *  D/源码 = "<<<<<<<" 标记行（透镜覆盖冲突标记符，不影响实际代码）。
 *  插槽通过 index（lensLines 下标 = hunks 下标）定位冲突块，重复行号也不会歧义 */
const lensLinesB = computed(() =>
	align.value.hunkLines.map((l) => Math.max(0, l.b - 1)),
);
const lensLinesC = computed(() =>
	align.value.hunkLines.map((l) => Math.max(0, l.c - 1)),
);
const lensLinesD = computed(() => hunks.value.map((h) => h.start));

// ------------------------------------------------------------- 全屏（与 Stash 详情最大化同款：占满整个视口）

const fullscreen = ref(false);

function toggleFullscreen() {
	fullscreen.value = !fullscreen.value;
	// 布局切换后视口高度变化会把各窗格 scrollTop 钉到新的可滚动范围：
	// 等 DOM 更新完成后重新定位到当前冲突块，保持阅读位置连贯
	void nextTick(() => {
		setTimeout(() => {
			if (!loading.value && hunks.value.length > 0)
				scrollToHunk(active.value);
		}, 0);
	});
}

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
		// 切换文件：各窗格回到顶部（D 重载不保留滚动）
		dPreserve.value = false;
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
		// 切换文件时清除 blame 标注
		annotLine.value = null;
		closeContextMenu();
		closeDrawer();
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

// 点击菜单外区域关闭右键菜单
onMounted(() => {
	document.addEventListener("click", onCtxMenuDocClick, true);
});
onBeforeUnmount(() => {
	document.removeEventListener("click", onCtxMenuDocClick, true);
	if (annotTimer) clearTimeout(annotTimer);
});

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
			// 重新选中以刷新 diff 视图
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
	<div class="resolver" :class="{ 'is-full': fullscreen }">
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
					title="B / C 分支全文对照 + 合并结果编辑，多视角透视冲突（默认）"
					@click="setMode('merge3')"
				>
					冲突透视
				</button>
				<button
					class="mode-btn"
					:class="{ on: mode === 'source' }"
					title="直接编辑带冲突标记的原始文件（合并结果 D 的全屏化，功能与 D 相同）"
					@click="setMode('source')"
				>
					源码编辑
				</button>
			</div>

			<div class="actions">
				<template
					v-if="
						showSideEditors &&
						(mode === 'merge3' || mode === 'source')
					"
				>
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
					v-if="showSideEditors"
					class="btn btn-icon"
					:title="fullscreen ? '退出全屏' : '全屏显示'"
					@click="toggleFullscreen"
				>
					<Icon
						:name="fullscreen ? 'minimize-2' : 'maximize-2'"
						:size="13"
					/>
				</button>
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

		<!-- 源码编辑：直接编辑原始文件（= D 的全屏化，与 D 共享内容与透镜行芯片） -->
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
					:language="editorLanguage"
					:indent-size="indentSize"
					preserve-scroll
					:marked-lines="align.marksDOurSide"
					:marked-lines-2="align.marksDTheirsSide"
					:lens-lines="lensLinesD"
					:theme-vars="sourceSrcTheme"
					:font-size="fontSize"
					:line-annotation="lineAnnot"
					@change="text = $event"
					@save="save(false)"
					@font-size-change="onFontSizeChange"
					@indent-change="onIndentChange"
					@language-change="onLanguageChange"
					@cursor-change="(line) => onCoderCursorChange(line, 'src')"
					@contextmenu="
						(line, e) => onCoderContextMenu(line, e, 'src')
					"
				>
					<!-- 每个冲突块顶部的透镜行：保留 B / 保留 C / 保留两者 -->
					<template #lens="{ index }">
						<div class="lens-chips">
							<span class="chip-idx">冲突 {{ index + 1 }}</span>
							<button
								type="button"
								class="chip chip-ours"
								:title="'此冲突块保留 ' + oursLabel"
								@click="resolveHunkAt(index, 'ours')"
							>
								保留{{ oursLabel }}
							</button>
							<button
								type="button"
								class="chip chip-theirs"
								:title="'此冲突块保留 ' + theirsLabel"
								@click="resolveHunkAt(index, 'theirs')"
							>
								保留{{ theirsLabel }}
							</button>
							<button
								type="button"
								class="chip chip-both"
								title="两侧内容都保留（当前分支在前）"
								@click="resolveHunkAt(index, 'both')"
							>
								保留两者
							</button>
						</div>
					</template>
				</CoderView>
			</div>
		</div>

		<!-- 冲突透视（默认）：上 B | C，下 D，分割条可拖拽，三窗格同步滚动 -->
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
							<button
								class="btn take-ours pane-take"
								:disabled="hunks.length === 0"
								:title="
									'全部冲突块都保留 ' + oursLabel + ' 的内容'
								"
								@click="takeAll('ours')"
							>
								全部保留 {{ oursLabel }}
							</button>
						</div>
						<div class="pane-body">
							<CoderView
								ref="bCoder"
								class="pane-coder"
								:data="detail?.ours.content ?? ''"
								:filename="path"
								:language="editorLanguage"
								:indent-size="indentSize"
								readonly
								:marked-lines="align.marksB"
								:lens-lines="lensLinesB"
								:theme-vars="bTheme"
								:font-size="fontSize"
								:status-controls="false"
								@scroll="(t, l) => onPaneScroll('b', t, l)"
							>
								<!-- 每个冲突块顶部的透镜行：保留 B -->
								<template #lens="{ index }">
									<div class="lens-chips">
										<span class="chip-idx"
											>冲突 {{ index + 1 }}</span
										>
										<button
											type="button"
											class="chip chip-ours"
											:title="'此冲突块保留 ' + oursLabel"
											@click="
												resolveHunkAt(index, 'ours')
											"
										>
											保留{{ oursLabel }}
										</button>
									</div>
								</template>
							</CoderView>
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
							<button
								class="btn take-theirs pane-take"
								:disabled="hunks.length === 0"
								:title="
									'全部冲突块都保留 ' +
									theirsLabel +
									' 的内容'
								"
								@click="takeAll('theirs')"
							>
								全部保留 {{ theirsLabel }}
							</button>
						</div>
						<div class="pane-body">
							<CoderView
								ref="cCoder"
								class="pane-coder"
								:data="detail?.theirs.content ?? ''"
								:filename="path"
								:language="editorLanguage"
								:indent-size="indentSize"
								readonly
								:marked-lines="align.marksC"
								:lens-lines="lensLinesC"
								:theme-vars="cTheme"
								:font-size="fontSize"
								:status-controls="false"
								@scroll="(t, l) => onPaneScroll('c', t, l)"
							>
								<!-- 每个冲突块顶部的透镜行：保留 C -->
								<template #lens="{ index }">
									<div class="lens-chips">
										<span class="chip-idx"
											>冲突 {{ index + 1 }}</span
										>
										<button
											type="button"
											class="chip chip-theirs"
											:title="
												'此冲突块保留 ' + theirsLabel
											"
											@click="
												resolveHunkAt(index, 'theirs')
											"
										>
											保留{{ theirsLabel }}
										</button>
									</div>
								</template>
							</CoderView>
						</div>
					</div>
				</div>

				<div
					class="splitter splitter-h"
					title="拖拽调整合并结果高度"
					@pointerdown="startDragY"
				/>

				<!-- 下：合并结果 D（完整文件，可编辑；每个冲突块顶部透镜行取舍芯片） -->
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
					<div class="pane-body">
						<CoderView
							ref="dCoder"
							class="pane-coder"
							:data="text"
							:filename="path"
							:language="editorLanguage"
							:indent-size="indentSize"
							:preserve-scroll="dPreserve"
							:marked-lines="align.marksDOurSide"
							:marked-lines-2="align.marksDTheirsSide"
							:lens-lines="lensLinesD"
							:theme-vars="sourceSrcTheme"
							:font-size="fontSize"
							:line-annotation="lineAnnot"
							@change="text = $event"
							@save="save(false)"
							@scroll="(t, l) => onPaneScroll('d', t, l)"
							@font-size-change="onFontSizeChange"
							@indent-change="onIndentChange"
							@language-change="onLanguageChange"
							@cursor-change="
								(line) => onCoderCursorChange(line, 'd')
							"
							@contextmenu="
								(line, e) => onCoderContextMenu(line, e, 'd')
							"
						>
							<!-- 每个冲突块顶部的透镜行：保留 B / 保留 C / 保留两者 -->
							<template #lens="{ index }">
								<div class="lens-chips">
									<span class="chip-idx"
										>冲突 {{ index + 1 }}</span
									>
									<button
										type="button"
										class="chip chip-ours"
										:title="'此冲突块保留 ' + oursLabel"
										@click="resolveHunkAt(index, 'ours')"
									>
										保留{{ oursLabel }}
									</button>
									<button
										type="button"
										class="chip chip-theirs"
										:title="'此冲突块保留 ' + theirsLabel"
										@click="resolveHunkAt(index, 'theirs')"
									>
										保留{{ theirsLabel }}
									</button>
									<button
										type="button"
										class="chip chip-both"
										title="两侧内容都保留（当前分支在前）"
										@click="resolveHunkAt(index, 'both')"
									>
										保留两者
									</button>
								</div>
							</template>
						</CoderView>
					</div>
				</div>
			</div>
		</div>
	</div>

	<!-- 右键上下文菜单 -->
	<teleport to="body">
		<div
			v-if="ctxMenuVisible"
			class="ctx-menu"
			:style="{ left: ctxMenuX + 'px', top: ctxMenuY + 'px' }"
			@click.stop
		>
			<button
				type="button"
				class="ctx-item"
				@click="showLineHistory(ctxMenuLine)"
			>
				<Icon name="history" :size="13" />
				<span>查看本行历史</span>
			</button>
			<button type="button" class="ctx-item" @click="showFileHistory()">
				<Icon name="file-text" :size="13" />
				<span>查看文件历史</span>
			</button>
		</div>
	</teleport>

	<!-- 历史记录抽屉（从右侧滑入，可拖拽调整宽度） -->
	<teleport to="body">
		<div
			v-if="drawerVisible"
			class="blame-drawer"
			:style="{ width: drawerWidth + 'vw' }"
		>
			<div
				class="drawer-splitter"
				title="拖拽调整抽屉宽度"
				@pointerdown="startDrawerDrag"
			/>
			<div class="drawer-inner">
				<div class="drawer-head">
					<span class="drawer-title">{{ drawerTitle }}</span>
					<button
						type="button"
						class="btn btn-icon"
						title="关闭"
						@click="closeDrawer"
					>
						<Icon name="x" :size="14" />
					</button>
				</div>
				<div class="drawer-body">
					<div class="drawer-panels">
						<!-- ==== 左侧：提交列表（始终可见） ==== -->
						<div class="drawer-list">
							<Spinner v-if="drawerLoading" :size="16" />
							<div
								v-else-if="drawerCommits.length === 0"
								class="drawer-empty"
							>
								暂无历史记录
							</div>
							<div
								v-for="(c, i) in drawerCommits"
								:key="c.fullHash + i"
								class="drawer-commit"
								:class="{
									'is-active':
										drawerActiveHash === c.fullHash,
								}"
								@click="selectDrawerCommit(c.fullHash)"
							>
								<span class="dc-hash">
									{{ c.hash }}
								</span>
								<span class="dc-author">
									{{ c.author }}
								</span>
								<span class="dc-time">
									{{ c.time }}
								</span>
								<span class="dc-subject">
									{{ c.subject }}
								</span>
							</div>
						</div>
						<!-- ==== 右侧：选中提交的详情 ==== -->
						<div class="drawer-detail">
							<template v-if="!drawerActiveHash">
								<div class="drawer-detail-empty">
									点击左侧提交查看变更详情
								</div>
							</template>
							<template v-else>
								<Spinner v-if="drawerFilesLoading" :size="16" />
								<template v-else-if="drawerCommitInfo">
									<!-- 提交元数据 -->
									<div class="drawer-meta">
										<div class="dm-subject">
											{{ drawerCommitInfo.subject }}
										</div>
										<div class="dm-info">
											<span class="dm-author">
												{{ drawerCommitInfo.author }}
											</span>
											<span class="dm-time">
												{{
													relativeTime(
														drawerCommitInfo.timestamp,
													)
												}}
											</span>
											<span class="dm-hash">
												{{
													drawerCommitInfo.hash.slice(
														0,
														8,
													)
												}}
											</span>
										</div>
										<div
											v-if="drawerCommitInfo.body"
											class="dm-body"
										>
											{{ drawerCommitInfo.body }}
										</div>
									</div>
									<!-- 变更文件列表 -->
									<div
										v-if="drawerCommitFiles.length"
										class="drawer-files"
									>
										<div
											v-for="f in drawerCommitFiles"
											:key="f.path"
											class="df-item"
											:class="{
												'is-active':
													drawerSelectedFile ===
													f.path,
											}"
											@click="
												selectDrawerFile(
													drawerCommitInfo.hash,
													f.path,
												)
											"
										>
											<span
												class="df-status"
												:style="{
													color: statusColor(
														f.binary
															? 'B'
															: f.status,
													),
												}"
											>
												{{ f.binary ? "B" : f.status }}
											</span>
											<span class="df-path">
												{{ f.path }}
											</span>
											<span class="df-stats">
												<span
													v-if="f.additions"
													class="df-add"
												>
													+{{ f.additions }}
												</span>
												<span
													v-if="f.deletions"
													class="df-del"
												>
													-{{ f.deletions }}
												</span>
												<span
													v-if="f.binary"
													class="df-bin"
												>
													bin
												</span>
											</span>
										</div>
									</div>
									<!-- 选中文件的 diff -->
									<div
										v-if="drawerSelectedFile"
										class="drawer-diff"
									>
										<DiffViewer
											:raw="drawerFileDiff"
											:loading="drawerFileDiffLoading"
											:filename="drawerSelectedFile"
										/>
									</div>
								</template>
							</template>
						</div>
					</div>
				</div>
			</div>
		</div>
	</teleport>
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

/* 全屏展示：与 Stash 详情最大化同款——占满整个视口（z-index 低于弹窗层
   的 1000，确认/提示弹窗仍能浮在其上） */
.resolver.is-full {
	position: fixed;
	left: 0;
	top: 0;
	width: 100vw;
	height: 100vh;
	z-index: 900;
}

/* 全屏工具条：改为三段式布局（文件路径｜模式切换｜操作区），
   宽屏下模式切换居中、操作区靠右，避免三组元素全挤在左侧；
   同时放宽文件路径宽度上限，让更完整的路径有展示空间。 */
.resolver.is-full .bar {
	display: grid;
	grid-template-columns: 1fr auto 1fr;
	align-items: center;
	gap: 12px;
	padding: 8px 14px;
}
.resolver.is-full .file {
	max-width: none;
}
.resolver.is-full .modes {
	justify-self: center;
}
.resolver.is-full .actions {
	justify-self: end;
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
/* 面板头右端的“全部保留”批量按钮：靠右对齐，尺寸压缩以贴合头部高度 */
.pane-take {
	margin-left: auto;
	flex: none;
	height: 20px;
	padding: 0 8px;
	font-size: 10.5px;
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

/* ------------------------------------------------------------------ 冲突块透镜行芯片 */
/* 芯片渲染在 Coder 的 #lens 插槽里（冲突块顶部的独占一行覆盖条）；
   条带本身 pointer-events: none，芯片容器重新打开响应 */
.lens-chips {
	display: flex;
	align-items: center;
	gap: 4px;
	min-width: 0;
	pointer-events: auto;
}
.chip-idx {
	flex: none;
	font-family: var(--font-mono);
	font-size: 10px;
	color: var(--text-faint);
	background: color-mix(in oklab, var(--bg-panel) 72%, transparent);
	border-radius: 8px;
	padding: 0 5px;
	line-height: 15px;
	white-space: nowrap;
}
.chip {
	flex: none;
	height: 16px;
	padding: 0 7px;
	font-size: 10px;
	line-height: 1;
	border-radius: 9px;
	border: 1px solid;
	background: var(--bg-panel);
	cursor: pointer;
	white-space: nowrap;
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

/* ------------------------------------------------------------------ 右键上下文菜单 */
.ctx-menu {
	position: fixed;
	z-index: 1100;
	min-width: 170px;
	background: var(--bg-panel);
	border: 1px solid var(--border);
	border-radius: 8px;
	box-shadow: 0 4px 16px rgba(0, 0, 0, 0.32);
	padding: 4px 0;
}
.ctx-item {
	display: flex;
	align-items: center;
	gap: 8px;
	width: 100%;
	padding: 7px 12px;
	font-size: 12px;
	color: var(--text);
	background: transparent;
	border: none;
	border-radius: 0;
	cursor: pointer;
	text-align: left;
	line-height: 1.1;
}
.ctx-item:hover {
	background: var(--bg-selected);
}
.ctx-item svg {
	flex: none;
	color: var(--text-dim);
}

/* ------------------------------------------------------------------ 历史记录抽屉（右侧滑入，可拖拽调整宽度） */
.blame-drawer {
	position: fixed;
	top: 0;
	right: 0;
	bottom: 0;
	z-index: 1050;
	background: var(--bg-panel);
	border-left: 1px solid var(--border);
	box-shadow: -4px 0 20px rgba(0, 0, 0, 0.25);
	display: flex;
	flex-direction: row;
}
/* 拖拽手柄：位于抽屉左缘，可交互区域扩展到抽屉外侧 */
.drawer-splitter {
	flex: none;
	width: 8px;
	cursor: col-resize;
	background: transparent;
	user-select: none;
	margin-left: -6px;
	z-index: 1;
	position: relative;
}
.drawer-splitter::after {
	content: "";
	position: absolute;
	left: 3px;
	top: 0;
	bottom: 0;
	width: 2px;
	background: var(--border);
	border-radius: 1px;
}
.drawer-splitter:hover::after {
	background: var(--accent);
}
.drawer-inner {
	flex: 1;
	min-width: 0;
	display: flex;
	flex-direction: column;
	overflow: hidden;
}
.drawer-head {
	flex: none;
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 10px 14px;
	border-bottom: 1px solid var(--border);
	background: var(--bg-app);
	gap: 8px;
}
.drawer-title {
	font-size: 12.5px;
	font-weight: 600;
	color: var(--text);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	min-width: 0;
}
.drawer-body {
	flex: 1;
	min-height: 0;
	overflow: hidden;
	display: flex;
	flex-direction: column;
}
/* 左右分栏：左侧提交列表 + 右侧变更详情 */
.drawer-panels {
	flex: 1;
	min-height: 0;
	display: flex;
}
/* 左侧：提交列表（可独立滚动） */
.drawer-list {
	flex: 0 0 38%;
	overflow-y: auto;
	border-right: 1px solid var(--border);
	display: flex;
	flex-direction: column;
	align-items: center;
}
.drawer-list > .spinner {
	margin-top: 24px;
}
.drawer-empty {
	font-size: 12.5px;
	color: var(--text-dim);
	padding: 20px;
	margin-top: 12px;
}
/* 右侧：变更详情（可独立滚动） */
.drawer-detail {
	flex: 1 1 0%;
	min-width: 0;
	overflow-y: auto;
	display: flex;
	flex-direction: column;
}
.drawer-detail > .spinner {
	margin-top: 24px;
	align-self: center;
}
.drawer-detail-empty {
	flex: 1;
	display: flex;
	align-items: center;
	justify-content: center;
	font-size: 12.5px;
	color: var(--text-dim);
	padding: 40px 20px;
}
/* 单条提交记录：可点击查看 diff */
.drawer-commit {
	display: grid;
	grid-template-columns: auto 1fr auto;
	grid-template-rows: auto auto;
	gap: 1px 8px;
	align-items: baseline;
	padding: 8px 14px;
	font-size: 12px;
	width: 100%;
	box-sizing: border-box;
	cursor: pointer;
}
.drawer-commit:hover {
	background: var(--bg-hover);
}
.drawer-commit.is-active {
	background: var(--bg-selected);
}
.dc-hash {
	font-family: var(--font-mono);
	font-size: 10.5px;
	color: var(--accent);
	grid-row: 1;
	grid-column: 1;
}
.dc-author {
	color: var(--text);
	font-size: 11px;
	grid-row: 1;
	grid-column: 2;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}
.dc-time {
	color: var(--text-dim);
	font-size: 10px;
	grid-row: 1;
	grid-column: 3;
	white-space: nowrap;
}
.dc-subject {
	color: var(--text-dim);
	font-size: 11px;
	grid-row: 2;
	grid-column: 1 / 4;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}
/* 选中提交的 diff 详情区域（嵌入 DiffViewer 组件） */
.drawer-diff {
	flex: 1;
	min-height: 0;
	border-top: 1px solid var(--border);
	overflow: hidden;
	display: flex;
	flex-direction: column;
}

/* ------------------------------------------------------------------ 提交详情：元数据 */
.drawer-meta {
	flex: none;
	padding: 12px 14px;
	border-bottom: 1px solid var(--border);
	background: var(--bg-app);
}
.dm-subject {
	font-size: 13px;
	font-weight: 600;
	color: var(--text);
	line-height: 1.4;
	margin-bottom: 6px;
}
.dm-info {
	display: flex;
	align-items: center;
	gap: 14px;
	flex-wrap: wrap;
}
.dm-author {
	font-size: 11.5px;
	color: var(--text);
}
.dm-time {
	font-size: 11px;
	color: var(--text-dim);
}
.dm-hash {
	font-family: var(--font-mono);
	font-size: 10.5px;
	color: var(--accent);
}
.dm-body {
	margin-top: 8px;
	font-size: 11.5px;
	color: var(--text-dim);
	line-height: 1.5;
	white-space: pre-wrap;
	max-height: 120px;
	overflow-y: auto;
}

/* ------------------------------------------------------------------ 变更文件列表 */
.drawer-files {
	flex: none;
	max-height: 200px;
	overflow-y: auto;
	border-bottom: 1px solid var(--border);
}
.df-item {
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 6px 14px;
	font-size: 11.5px;
	cursor: pointer;
	border-left: 3px solid transparent;
}
.df-item:hover {
	background: var(--bg-hover);
}
.df-item.is-active {
	background: var(--bg-selected);
	border-left-color: var(--accent);
}
.df-status {
	flex: none;
	font-family: var(--font-mono);
	font-size: 11px;
	font-weight: 600;
	width: 14px;
	text-align: center;
}
.df-path {
	flex: 1;
	min-width: 0;
	font-family: var(--font-mono);
	font-size: 11px;
	color: var(--text);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.df-stats {
	flex: none;
	display: flex;
	gap: 6px;
	font-family: var(--font-mono);
	font-size: 10.5px;
}
.df-add {
	color: var(--green);
}
.df-del {
	color: var(--red);
}
.df-bin {
	color: var(--text-dim);
	font-size: 10px;
}
</style>
