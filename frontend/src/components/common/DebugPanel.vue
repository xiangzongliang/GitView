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
</script>

<template>
	<div v-if="ui.debugOpen" class="dbg">
		<header class="dbg-head">
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
						? '文件监听不可用，已退回定时轮询：' + watchInfo.error
						: watchInfo.watching
							? `fsnotify 监听中（${watchInfo.paths} 个路径），仓库变化会立即推送`
							: '当前未监听（使用定时轮询）'
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
					<span class="dbg-dot" />
					<span class="dbg-time mono">{{ fmtTime(e.time) }}</span>
					<span v-if="e.duration > 0" class="dbg-dur mono"
						>{{ e.duration }}ms</span
					>
					<Icon
						:name="
							e.kind === 'shell'
								? 'terminal'
								: e.kind === 'watch'
									? 'refresh'
									: 'commit'
						"
						:size="10"
						class="dbg-kind"
					/>
					<code class="dbg-cmd mono">{{ e.command }}</code>
					<button
						class="btn-icon dbg-copy"
						title="复制命令"
						@click.stop="copyText(e.command)"
					>
						<Icon name="copy" :size="11" />
					</button>
				</div>
				<div v-if="e.error" class="dbg-err mono">{{ e.error }}</div>
				<div v-if="expanded.has(e.seq)" class="dbg-meta mono">
					{{ shortDir(e.dir) || "（无工作目录）" }}
				</div>
				<pre
					v-if="expanded.has(e.seq) && e.output"
					class="dbg-out mono"
					>{{ e.output }}</pre>
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
	height: 320px;
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
	height: 32px;
	padding: 0 8px 0 12px;
	border-bottom: 1px solid var(--border);
	background: var(--bg-panel-2);
}
.dbg-title {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	font-size: 11.5px;
	font-weight: 600;
	color: var(--text-strong);
}
.dbg-count {
	font-size: 10px;
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
	font-size: 10px;
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
	font-size: 11px;
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
	font-size: 11.5px;
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
.dbg-dot {
	flex: none;
	width: 6px;
	height: 6px;
	border-radius: 50%;
	background: var(--green);
	align-self: center;
}
.dbg-row.err .dbg-dot {
	background: var(--red);
}
.dbg-time {
	flex: none;
	color: var(--text-faint);
	font-size: 10.5px;
}
.dbg-dur {
	flex: none;
	min-width: 42px;
	text-align: right;
	color: var(--text-faint);
	font-size: 10.5px;
}
.dbg-kind {
	flex: none;
	color: var(--text-faint);
	align-self: center;
}
.dbg-cmd {
	flex: 1;
	min-width: 0;
	color: var(--text-strong);
	word-break: break-all;
	white-space: pre-wrap;
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
.dbg-err {
	margin: 2px 0 2px 13px;
	color: var(--red);
	font-size: 11px;
	white-space: pre-wrap;
	word-break: break-all;
}
.dbg-meta {
	margin: 2px 0 1px 13px;
	color: var(--text-faint);
	font-size: 10.5px;
	word-break: break-all;
}
.dbg-out {
	margin: 2px 0 4px 13px;
	padding: 6px 8px;
	max-height: 180px;
	overflow: auto;
	border-radius: 5px;
	background: var(--term-bg);
	color: var(--text);
	font-size: 11px;
	line-height: 1.5;
	white-space: pre-wrap;
	word-break: break-all;
}
</style>
