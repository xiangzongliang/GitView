<script setup lang="ts">
// 右下角调试窗口：显示后端执行过的所有 git / 终端命令日志。
// 数据来自 AppService.GitLog(since)（后端环形缓冲区，只拉取新增条目），
// 仅在窗口展开时轮询，避免无谓开销。
import {
	computed,
	nextTick,
	onBeforeUnmount,
	onMounted,
	ref,
	watch,
} from "vue";
import { AppService, GitService, copyText } from "../../api";
import type { GitLogEntry, WatchStatus } from "../../api";
import { useRepo } from "../../stores/repo";
import { useUI } from "../../stores/ui";
import Icon from "../ui/Icon.vue";

const ui = useUI();
const repo = useRepo();

/** 与后端 debugLogLimit 保持一致 */
const MAX_ENTRIES = 500;

const entries = ref<GitLogEntry[]>([]);
const cursor = ref(0);
/** 是否跟随最新输出（用户向上滚动时自动暂停） */
const follow = ref(true);
const expanded = ref<Set<number>>(new Set());
const body = ref<HTMLElement | null>(null);
/** 后端仓库监听状态（fsnotify）：用于确认事件推送是否生效 */
const watchInfo = ref<WatchStatus | null>(null);
let timer: number | undefined;
let tick = 0;

// ------------------------------------------------------- 拖拽顶部调整高度
// 面板锚定右下角、宽度固定：向上拖（clientY 变小）→ 变高。
const HEIGHT_KEY = "gv.debugH";
const MIN_H = 160;
const PANEL_BOTTOM = 34; // 与 .dbg 的 bottom 保持一致
const TOP_RESERVE = 96; // 顶部为标题栏 / 工具栏留出空间
function maxHeight(): number {
	return Math.max(MIN_H, window.innerHeight - PANEL_BOTTOM - TOP_RESERVE);
}
const height = ref(
	Math.min(
		Math.max(MIN_H, Number(localStorage.getItem(HEIGHT_KEY)) || 320),
		maxHeight(),
	),
);

function startResize(e: MouseEvent) {
	// 点在按钮上时不触发拖拽，保留按钮自身的点击行为
	if ((e.target as HTMLElement).closest("button")) return;
	e.preventDefault();
	const startY = e.clientY;
	const startH = height.value;
	const move = (ev: MouseEvent) => {
		height.value = Math.min(
			Math.max(MIN_H, startH + (startY - ev.clientY)),
			maxHeight(),
		);
	};
	const up = () => {
		document.removeEventListener("mousemove", move);
		document.removeEventListener("mouseup", up);
		document.body.style.cursor = "";
		document.body.style.userSelect = "";
		try {
			localStorage.setItem(HEIGHT_KEY, String(height.value));
		} catch {
			/* ignore */
		}
	};
	document.addEventListener("mousemove", move);
	document.addEventListener("mouseup", up);
	document.body.style.cursor = "ns-resize";
	document.body.style.userSelect = "none";
}

async function loadWatchInfo() {
	try {
		watchInfo.value = await GitService.WatchStatus();
	} catch {
		watchInfo.value = null;
	}
}

const errCount = computed(() => entries.value.filter((e) => !e.ok).length);

function fmtTime(ms: number): string {
	const d = new Date(ms);
	const p = (n: number, w = 2) => String(n).padStart(w, "0");
	return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function scrollBottom() {
	nextTick(() => {
		const el = body.value;
		if (el) el.scrollTop = el.scrollHeight;
	});
}

async function poll() {
	tick++;
	if (tick % 7 === 1) void loadWatchInfo();
	try {
		const list = (await AppService.GitLog(cursor.value)) || [];
		if (!list.length) return;
		entries.value = [...entries.value, ...list].slice(-MAX_ENTRIES);
		cursor.value = list[list.length - 1].seq;
		if (follow.value) scrollBottom();
	} catch {
		/* 调试面板失败不应影响主流程 */
	}
}

function start() {
	window.clearInterval(timer);
	void poll();
	timer = window.setInterval(() => void poll(), 700);
}

function stop() {
	window.clearInterval(timer);
	timer = undefined;
}

watch(
	() => ui.debugOpen,
	(open) => {
		if (open) {
			void loadWatchInfo();
			start();
		} else stop();
	},
);

// 切换仓库时刷新监听状态
watch(
	() => repo.path,
	() => {
		if (ui.debugOpen) void loadWatchInfo();
	},
);

onMounted(() => {
	if (ui.debugOpen) {
		void loadWatchInfo();
		start();
	}
});
onBeforeUnmount(stop);

function onScroll() {
	const el = body.value;
	if (!el) return;
	follow.value = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
}

function toggleFollow() {
	follow.value = !follow.value;
	if (follow.value) scrollBottom();
}

function toggle(seq: number) {
	const next = new Set(expanded.value);
	if (next.has(seq)) next.delete(seq);
	else next.add(seq);
	expanded.value = next;
}

async function clear() {
	try {
		await AppService.ClearGitLog();
	} catch {
		/* ignore */
	}
	entries.value = [];
	expanded.value = new Set();
	cursor.value = 0;
	follow.value = true;
}

/** 基础文件名（目录过长时缩短显示） */
function shortDir(dir: string): string {
	if (!dir) return "";
	const parts = dir.split("/").filter(Boolean);
	return parts.length > 2 ? "…/" + parts.slice(-2).join("/") : dir;
}

/**
 * 每类条目的标记：区分“执行的命令”和“响应的日志”。
 * git 命令 `$` / 终端 `❯` 是“执行”；监听事件 `◆` 是后端推送的“日志”。
 */
function kindMeta(e: GitLogEntry): { glyph: string; cls: string; label: string } {
	switch (e.kind) {
		case "shell":
			return { glyph: "❯", cls: "k-shell", label: "终端命令" };
		case "watch":
			return { glyph: "◆", cls: "k-watch", label: "监听事件" };
		default:
			return { glyph: "$", cls: "k-git", label: "git 命令" };
	}
}
</script>

<template>
	<div v-if="ui.debugOpen" class="dbg" :style="{ height: height + 'px' }">
		<header class="dbg-head" @mousedown="startResize">
			<span class="dbg-title">
				<Icon name="bug" :size="13" />
				调试 · 命令日志
			</span>
			<span class="dbg-count">{{ entries.length }}</span>
			<span v-if="errCount" class="dbg-count err"
				>{{ errCount }} 失败</span
			>
			<span
				v-if="watchInfo"
				class="dbg-watch"
				:class="{ off: !watchInfo.watching, err: !!watchInfo.error }"
				:title="
					watchInfo.error
						? '文件监听不可用：' + watchInfo.error
						: watchInfo.watching
							? `fsnotify 监听中（${watchInfo.paths} 个路径），仓库变化会立即推送`
							: '当前未监听（可手动刷新）'
				"
			>
				<Icon name="refresh" :size="10" />
				{{
					watchInfo.error
						? "监听失败"
						: watchInfo.watching
							? `监听中 · ${watchInfo.paths}`
							: "未监听"
				}}
			</span>
			<span class="dbg-spacer" />
			<button
				class="dbg-btn"
				:class="{ active: follow }"
				title="自动滚动到最新命令"
				@click="toggleFollow"
			>
				<Icon name="chevron-down" :size="12" />
				跟随
			</button>
			<button
				class="dbg-btn"
				title="清空日志"
				:disabled="!entries.length"
				@click="clear"
			>
				<Icon name="trash" :size="12" />
				清空
			</button>
			<button
				class="btn-icon"
				title="关闭调试窗口"
				@click="ui.toggleDebug()"
			>
				<Icon name="x" :size="13" />
			</button>
			<span class="dbg-grip" title="拖动调整高度" />
		</header>

		<div ref="body" class="dbg-body" @scroll="onScroll">
			<div v-if="!entries.length" class="dbg-empty">
				暂无命令记录。执行任意 git
				操作（或使用内置终端）后，这里会显示完整命令、耗时与输出。
			</div>
			<div
				v-for="e in entries"
				:key="e.seq"
				class="dbg-row"
				:class="{ err: !e.ok, open: expanded.has(e.seq) }"
			>
				<div class="dbg-line" @click="toggle(e.seq)">
					<span
						class="dbg-mark mono"
						:class="[kindMeta(e).cls, { err: !e.ok }]"
						:title="kindMeta(e).label"
						>{{ kindMeta(e).glyph }}</span
					>
					<span class="dbg-time mono">{{ fmtTime(e.time) }}</span>
					<span v-if="e.duration > 0" class="dbg-dur mono"
						>{{ e.duration }}ms</span
					>
					<code
						class="dbg-cmd mono"
						:class="{ clamp: !expanded.has(e.seq) }"
						:title="e.command"
						>{{ e.command }}</code
					>
					<button
						class="btn-icon dbg-copy"
						title="复制"
						@click.stop="copyText(e.command)"
					>
						<Icon name="copy" :size="11" />
					</button>
				</div>
				<div v-if="e.error" class="dbg-resp">
					<span class="dbg-resp-tag mono err">✕ 错误</span>
					<pre class="dbg-err mono">{{ e.error }}</pre>
				</div>
				<div v-if="expanded.has(e.seq)" class="dbg-meta mono">
					<span class="dbg-meta-tag">⌂</span>
					{{ shortDir(e.dir) || "（无工作目录）" }}
				</div>
				<div v-if="expanded.has(e.seq) && e.output" class="dbg-resp">
					<span class="dbg-resp-tag mono"
						>↳ {{ e.kind === "watch" ? "详情" : "输出" }}</span
					>
					<pre class="dbg-out mono">{{ e.output }}</pre>
				</div>
			</div>
		</div>
	</div>
</template>

<style scoped>
.dbg {
	position: fixed;
	right: 12px;
	bottom: 34px;
	z-index: 850;
	width: min(680px, calc(100vw - 24px));
	/* 高度由顶部拖拽调整（见 startResize），这里给出视口兜底上限 */
	max-height: calc(100vh - 130px);
	display: flex;
	flex-direction: column;
	background: var(--bg-panel);
	border: 1px solid var(--border-strong);
	border-radius: 10px;
	box-shadow: 0 16px 44px rgba(0, 0, 0, 0.45);
	overflow: hidden;
	animation: dbg-in 0.16s ease-out;
}
@keyframes dbg-in {
	from {
		opacity: 0;
		transform: translateY(8px);
	}
}
.dbg-head {
	flex: none;
	display: flex;
	align-items: center;
	gap: 8px;
	height: 30px;
	padding: 0 8px 0 12px;
	border-bottom: 1px solid var(--border);
	background: var(--bg-panel-2);
	position: relative;
	cursor: ns-resize; /* 拖拽顶部可调整面板高度 */
}
/* 顶部拖拽手柄：仅作视觉提示，实际拖拽由 .dbg-head 处理 */
.dbg-grip {
	position: absolute;
	top: 4px;
	left: 50%;
	transform: translateX(-50%);
	width: 36px;
	height: 3px;
	border-radius: 2px;
	background: var(--border-strong);
	pointer-events: none;
}
.dbg-head:hover .dbg-grip {
	background: var(--text-faint);
}
.dbg-title {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	font-size: 11px;
	font-weight: 600;
	color: var(--text-strong);
}
.dbg-count {
	font-size: 9.5px;
	line-height: 14px;
	padding: 0 5px;
	border-radius: 7px;
	background: var(--hover-soft);
	color: var(--text-dim);
}
.dbg-count.err {
	background: var(--red-wash);
	color: var(--red);
}
.dbg-watch {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	font-size: 9.5px;
	line-height: 14px;
	padding: 0 6px;
	border-radius: 7px;
	border: 1px solid var(--border-strong);
	color: var(--green);
}
.dbg-watch.off {
	color: var(--text-faint);
}
.dbg-watch.err {
	color: var(--red);
	border-color: var(--red);
}
.dbg-spacer {
	flex: 1;
}
.dbg-btn {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	height: 20px;
	padding: 0 7px;
	border-radius: 5px;
	font-size: 10.5px;
	color: var(--text-dim);
}
.dbg-btn:hover:not(:disabled) {
	background: var(--bg-hover);
	color: var(--text-strong);
}
.dbg-btn.active {
	color: var(--accent);
}
.dbg-body {
	flex: 1;
	min-height: 0;
	overflow-y: auto;
	padding: 4px 0;
	font-size: 11px;
}
.dbg-empty {
	padding: 18px 14px;
	color: var(--text-faint);
	line-height: 1.6;
}
.dbg-row {
	padding: 2px 8px 2px 10px;
	border-left: 2px solid transparent;
	user-select: text;
}
.dbg-row:hover {
	background: var(--bg-hover);
}
.dbg-row.err {
	border-left-color: var(--red);
}
.dbg-row.open {
	background: var(--row-border);
}
.dbg-line {
	display: flex;
	align-items: baseline;
	gap: 7px;
	cursor: pointer;
}
/* 标记：区分“执行的命令”（$ / ❯）与“后端推送的日志”（◆） */
.dbg-mark {
	flex: none;
	width: 12px;
	text-align: center;
	align-self: baseline;
	font-size: 10px;
	font-weight: 700;
	line-height: 1;
}
.dbg-mark.k-git {
	color: var(--accent);
}
.dbg-mark.k-shell {
	color: var(--green);
}
.dbg-mark.k-watch {
	color: var(--purple);
}
.dbg-mark.err {
	color: var(--red);
}
.dbg-time {
	flex: none;
	color: var(--text-faint);
	font-size: 10px;
}
.dbg-dur {
	flex: none;
	min-width: 40px;
	text-align: right;
	color: var(--text-faint);
	font-size: 10px;
}
.dbg-cmd {
	flex: 1;
	min-width: 0;
	color: var(--text-strong);
	white-space: pre-wrap;
	overflow-wrap: anywhere;
}
/* 折叠时单行省略：长命令不再把列表撑高，展开后再看全 */
.dbg-cmd.clamp {
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}
/* 展开时换行用悬挂缩进：续行缩进，和首行区分开 */
.dbg-cmd:not(.clamp) {
	padding-left: 12px;
	text-indent: -12px;
}
.dbg-row.err .dbg-cmd {
	color: var(--red);
}
.dbg-copy {
	flex: none;
	width: 18px;
	height: 18px;
	opacity: 0;
	align-self: center;
}
.dbg-line:hover .dbg-copy {
	opacity: 1;
}
/* 响应区：命令输出 / 错误 / 事件详情，统一用左侧竖线 + 小标签区分 */
.dbg-resp {
	margin: 3px 0 3px 18px;
	display: flex;
	flex-direction: column;
	gap: 3px;
	min-width: 0;
}
.dbg-resp-tag {
	font-size: 9.5px;
	color: var(--text-faint);
}
.dbg-resp-tag.err {
	color: var(--red);
}
.dbg-out {
	margin: 0;
	padding: 5px 8px 5px 20px;
	/* 悬挂缩进：首行靠左，续行缩进 12px，换行后的内容更易读 */
	text-indent: -12px;
	max-height: 180px;
	overflow: auto;
	border-radius: 5px;
	border-left: 2px solid var(--border-strong);
	background: var(--term-bg);
	color: var(--text);
	font-size: 10.5px;
	line-height: 1.55;
	white-space: pre-wrap;
	overflow-wrap: anywhere;
	tab-size: 4;
}
.dbg-err {
	margin: 0;
	padding: 5px 7px;
	border-radius: 5px;
	border-left: 2px solid var(--red);
	background: var(--red-wash);
	color: var(--red);
	font-size: 10.5px;
	line-height: 1.55;
	white-space: pre-wrap;
	overflow-wrap: anywhere;
}
.dbg-meta {
	margin: 2px 0 1px 18px;
	color: var(--text-faint);
	font-size: 10px;
	overflow-wrap: anywhere;
}
.dbg-meta-tag {
	margin-right: 4px;
}
</style>
