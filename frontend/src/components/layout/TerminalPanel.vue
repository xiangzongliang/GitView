<script setup lang="ts">
// Built-in terminal for the active repository. Commands run through
// GitService.RunCommand (/bin/sh in the repo directory); the working
// directory is tracked so `cd` persists between commands.
import { nextTick, onMounted, ref, watch } from "vue";
import { useRepo } from "../../stores/repo";
import { useUI } from "../../stores/ui";
import { GitService, errMsg } from "../../api";
import { parseAnsi, type AnsiSeg } from "../../utils/ansi";
import Icon from "../ui/Icon.vue";
import Spinner from "../ui/Spinner.vue";

interface TermLine {
	kind: "cmd" | "out" | "err" | "sys";
	text: string;
	/** parsed ANSI segments; only set for 'out' lines */
	segs?: AnsiSeg[];
}

const MAX_LINES = 5000;

const TERM_H_KEY = "gv.termH";
const DEFAULT_H = 240;
const MIN_H = 140;

function maxH(): number {
	return Math.max(Math.floor(window.innerHeight * 0.7), MIN_H);
}

function clampH(h: number): number {
	return Math.min(Math.max(h, MIN_H), maxH());
}

function persistH() {
	try {
		localStorage.setItem(TERM_H_KEY, String(termH.value));
	} catch {
		/* ignore */
	}
}

const repo = useRepo();
const ui = useUI();

const lines = ref<TermLine[]>([]);
const input = ref("");
const cwd = ref("");
const busy = ref(false);
const scroller = ref<HTMLElement | null>(null);
const inputEl = ref<HTMLInputElement | null>(null);
const termH = ref(DEFAULT_H);

const history: string[] = [];
let histIdx = 0;

// ------------------------------------------------------------- tab completion
const COMMANDS = [
	"git",
	"cd",
	"ls",
	"cat",
	"pwd",
	"echo",
	"mkdir",
	"touch",
	"rm",
	"mv",
	"cp",
	"open",
	"grep",
	"find",
	"head",
	"tail",
	"which",
	"curl",
	"diff",
	"chmod",
	"clear",
	"node",
	"npm",
	"npx",
	"bun",
	"yarn",
	"pnpm",
	"python3",
	"python",
	"go",
	"cargo",
	"make",
	"brew",
	"code",
];
const GIT_SUBCOMMANDS = [
	"status",
	"add",
	"commit",
	"push",
	"pull",
	"fetch",
	"branch",
	"checkout",
	"switch",
	"merge",
	"rebase",
	"stash",
	"log",
	"diff",
	"tag",
	"reset",
	"restore",
	"clone",
	"init",
	"remote",
	"show",
	"cherry-pick",
	"blame",
	"clean",
	"config",
	"rm",
	"mv",
	"revert",
	"worktree",
];

// 终端命令在 Windows 上跑在 PowerShell 里，引号转义与列表命令都和 POSIX 不同
const IS_WIN = navigator.userAgent.includes("Windows");

function shellQuote(s: string): string {
	if (IS_WIN) {
		// PowerShell 单引号字符串内用连续两个单引号转义
		return "'" + s.replace(/'/g, "''") + "'";
	}
	return "'" + s.replace(/'/g, "'\\''") + "'";
}

function commonPrefix(items: string[]): string {
	if (!items.length) return "";
	let p = items[0];
	for (const it of items) {
		while (p && !it.startsWith(p)) p = p.slice(0, -1);
		if (!p) break;
	}
	return p;
}

/** 列出目录内容（目录名带 "/" 后缀），供路径补全用。 */
async function pathCandidates(token: string): Promise<string[]> {
	const slash = Math.max(token.lastIndexOf("/"), token.lastIndexOf("\\"));
	const dir = slash >= 0 ? token.slice(0, slash) || "/" : "";
	const base = slash >= 0 ? token.slice(slash + 1) : token;
	// PowerShell 的 ls 是 Get-ChildItem 别名，不支持 -1AF 参数
	const listCmd = IS_WIN
		? `Get-ChildItem -Force ${shellQuote(dir || ".")} | ForEach-Object { $_.Name + $(if ($_.PSIsContainer) { '/' } else { '' }) }`
		: "ls -1AF " + shellQuote(dir || ".");
	try {
		const res = await GitService.RunCommand(repo.path, cwd.value, listCmd);
		if (!res || res.exitCode !== 0) return [];
		return (res.output || "")
			.split("\n")
			.map((l) => l.replace(/\r$/, ""))
			.filter((l) => l && l !== "./" && l !== "../")
			.filter((l) => l.startsWith(base))
			.map((l) => (dir ? dir + "/" : "") + l.replace(/[*@=|]$/, ""));
	} catch {
		return [];
	}
}

async function tabComplete() {
	if (busy.value || !repo.path) return;
	const val = input.value;
	const m = val.match(/(?:^|\s)(\S*)$/);
	const token = m ? m[1] : "";
	const before = val.slice(0, val.length - token.length);
	const words = before.trim().split(/\s+/).filter(Boolean);

	let candidates: string[] = [];
	let isPath = false;
	if (words.length === 0) {
		candidates = COMMANDS.filter((c) => c.startsWith(token));
	} else if (
		words[0] === "git" &&
		words.length === 1 &&
		!token.includes("/") &&
		!token.includes("\\")
	) {
		candidates = GIT_SUBCOMMANDS.filter((c) => c.startsWith(token));
	} else {
		isPath = true;
		candidates = await pathCandidates(token);
	}
	if (!candidates.length) return;

	let insert: string;
	if (candidates.length === 1) {
		insert = candidates[0];
		if (!isPath) insert += " ";
		else if (/[\s'"$]/.test(insert)) insert = shellQuote(insert);
	} else {
		const cp = commonPrefix(candidates);
		if (cp.length <= token.length) {
			// 没有更长的公共前缀：把候选项打印出来供参考
			push("sys", candidates.join("  "));
			scrollBottom();
			return;
		}
		insert = /[\s'"$]/.test(cp) ? shellQuote(cp) : cp;
	}
	input.value = before + insert;
	focusInput();
}

function push(kind: TermLine["kind"], text: string) {
	if (kind === "out") {
		// parse ANSI once at push time, not on every render
		for (const segs of parseAnsi(text))
			lines.value.push({ kind, text: "", segs });
	} else {
		for (const ln of text.split("\n")) lines.value.push({ kind, text: ln });
	}
	if (lines.value.length > MAX_LINES) {
		lines.value.splice(0, lines.value.length - MAX_LINES);
	}
}

function prompt(): string {
	const p = cwd.value || repo.path;
	if (!p) return "";
	// Windows paths use backslashes; take the tail after either separator.
	const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
	return i >= 0 && i < p.length - 1 ? p.slice(i + 1) : p;
}

function resetSession() {
	cwd.value = repo.path;
	lines.value = [];
	if (repo.path) {
		push("sys", "终端会话 — " + repo.path);
		push(
			"sys",
			"回车执行命令；↑/↓ 浏览历史；Tab 补全命令与路径；Ctrl+L 清屏。命令在当前仓库目录下运行。",
		);
	}
}

watch(() => repo.path, resetSession);

// auto-focus the input whenever the panel becomes visible
watch(
	() => ui.terminalOpen,
	(open) => {
		if (open) focusInput();
	},
);

onMounted(() => {
	const raw = Number(localStorage.getItem(TERM_H_KEY));
	if (Number.isFinite(raw) && raw > 0) termH.value = clampH(raw);
	resetSession();
	focusInput();
});

function scrollBottom() {
	nextTick(() => {
		const el = scroller.value;
		if (el) el.scrollTop = el.scrollHeight;
	});
}

function focusInput() {
	nextTick(() => inputEl.value?.focus());
}

async function execute() {
	const cmd = input.value.trim();
	if (!cmd || busy.value || !repo.path) return;
	history.push(cmd);
	histIdx = history.length;
	input.value = "";

	if (cmd === "clear" || cmd === "cls") {
		lines.value = [];
		return;
	}

	push("cmd", prompt() + " ❯ " + cmd);
	scrollBottom();
	busy.value = true;
	const startPath = repo.path;
	try {
		const res = await GitService.RunCommand(startPath, cwd.value, cmd);
		if (startPath !== repo.path) return; // repo switched while running; discard
		if (res) {
			const out = (res.output || "").replace(/\n$/, "");
			if (out) push("out", out);
			if (res.newCwd) cwd.value = res.newCwd;
			if (res.timeout) push("err", "命令超时（5 分钟），已终止");
			else if (res.exitCode !== 0) push("err", "退出码 " + res.exitCode);
		}
	} catch (e) {
		push("err", errMsg(e));
	} finally {
		busy.value = false;
		scrollBottom();
		focusInput();
	}
}

function onKey(e: KeyboardEvent) {
	if (e.key === "Enter") {
		execute();
	} else if (e.key === "ArrowUp") {
		e.preventDefault();
		if (histIdx > 0) {
			histIdx--;
			input.value = history[histIdx];
		}
	} else if (e.key === "ArrowDown") {
		e.preventDefault();
		if (histIdx < history.length - 1) {
			histIdx++;
			input.value = history[histIdx];
		} else {
			histIdx = history.length;
			input.value = "";
		}
	} else if (e.key === "Tab") {
		e.preventDefault();
		tabComplete();
	} else if (e.key === "l" && e.ctrlKey) {
		// ctrl+L clears, like most shells
		e.preventDefault();
		lines.value = [];
	}
}

function lineClass(l: TermLine): string {
	return "term-line " + l.kind;
}

function segClass(s: AnsiSeg): string {
	let cls = "";
	if (s.fg) cls += " ansi-fg-" + s.fg;
	if (s.bg) cls += " ansi-bg-" + s.bg;
	if (s.bold) cls += " ansi-bold";
	if (s.dim) cls += " ansi-dim";
	if (s.italic) cls += " ansi-italic";
	if (s.underline) cls += " ansi-underline";
	return cls;
}

function startDrag(e: MouseEvent) {
	e.preventDefault();
	const startY = e.clientY;
	const startH = termH.value;
	const move = (ev: MouseEvent) => {
		termH.value = clampH(startH + (startY - ev.clientY));
	};
	const up = () => {
		document.removeEventListener("mousemove", move);
		document.removeEventListener("mouseup", up);
		document.body.style.cursor = "";
		persistH();
	};
	document.addEventListener("mousemove", move);
	document.addEventListener("mouseup", up);
	document.body.style.cursor = "row-resize";
}

function resetHeight() {
	termH.value = DEFAULT_H;
	persistH();
}
</script>

<template>
	<div
		v-if="ui.terminalOpen"
		class="terminal-panel"
		:style="{ height: termH + 'px' }"
	>
		<div
			class="term-splitter"
			title="拖动调整高度，双击恢复默认"
			@mousedown="startDrag"
			@dblclick="resetHeight"
		>
			<div class="term-splitter-grip" />
		</div>
		<div class="term-head">
			<Icon name="terminal" :size="12" />
			<span class="term-title">终端</span>
			<span class="term-cwd mono" :title="cwd">{{ cwd }}</span>
			<div class="term-actions">
				<button class="btn-icon" title="清屏" @click="lines = []">
					<Icon name="trash" :size="12" />
				</button>
				<button
					class="btn-icon"
					title="关闭终端"
					@click="ui.toggleTerminal()"
				>
					<Icon name="x" :size="12" />
				</button>
			</div>
		</div>

		<div ref="scroller" class="term-body mono" @click="focusInput">
			<div v-if="!repo.path" class="term-line sys">请先打开一个仓库</div>
			<div v-for="(l, i) in lines" :key="i" :class="lineClass(l)">
				<template v-if="l.segs">
					<span
						v-for="(s, j) in l.segs"
						:key="j"
						:class="segClass(s)"
						>{{ s.text }}</span
					>
					<span v-if="l.segs.length === 0"> </span>
				</template>
				<template v-else>{{ l.text || " " }}</template>
			</div>
		</div>

		<div class="term-input-row" @click="focusInput">
			<span class="term-prompt mono">{{ prompt() }} ❯</span>
			<input
				ref="inputEl"
				v-model="input"
				class="term-input mono"
				type="text"
				spellcheck="false"
				autocomplete="off"
				autocapitalize="off"
				placeholder="输入命令，回车执行…"
				:disabled="busy || !repo.path"
				@keydown="onKey"
			/>
			<Spinner v-if="busy" :size="12" />
		</div>
	</div>
</template>

<style scoped>
.terminal-panel {
	flex: none;
	display: flex;
	flex-direction: column;
	background: var(--term-bg);
	border-top: 1px solid var(--border-strong);
	min-height: 0;
}
.term-splitter {
	flex: none;
	height: 7px;
	margin-top: -3px;
	display: flex;
	align-items: center;
	justify-content: center;
	cursor: row-resize;
	z-index: 5;
	background: transparent;
}
.term-splitter-grip {
	width: 34px;
	height: 3px;
	border-radius: 2px;
	background: var(--border-strong);
}
.term-splitter:hover .term-splitter-grip {
	background: var(--accent);
}
.term-head {
	flex: none;
	display: flex;
	align-items: center;
	gap: 7px;
	height: 28px;
	padding: 0 8px 0 12px;
	background: var(--bg-panel);
	border-bottom: 1px solid var(--border);
	color: var(--text-dim);
}
.term-title {
	font-size: 11px;
	font-weight: 600;
	text-transform: uppercase;
	letter-spacing: 0.05em;
	color: var(--text-faint);
	flex: none;
}
.term-cwd {
	flex: 1;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	direction: rtl;
	text-align: left;
	font-size: 11px;
	color: var(--text-faint);
}
.term-actions {
	flex: none;
	display: flex;
	gap: 2px;
}
.term-body {
	flex: 1;
	min-height: 0;
	overflow-y: auto;
	padding: 8px 12px;
	font-size: 12px;
	line-height: 1.55;
	cursor: text;
}
.term-line {
	white-space: pre-wrap;
	word-break: break-all;
	user-select: text;
}
.term-line.cmd {
	color: var(--text-strong);
	margin-top: 4px;
}
.term-line.out {
	color: var(--text);
}
.ansi-fg-black {
	color: var(--text-faint);
}
.ansi-fg-red {
	color: var(--red);
}
.ansi-fg-green {
	color: var(--green);
}
.ansi-fg-yellow {
	color: var(--yellow);
}
.ansi-fg-blue {
	color: var(--accent);
}
.ansi-fg-magenta {
	color: var(--purple);
}
.ansi-fg-cyan {
	color: var(--teal);
}
.ansi-fg-white {
	color: var(--text);
}
.ansi-fg-bright-black {
	color: var(--text-dim);
}
.ansi-fg-bright-red {
	color: var(--red);
}
.ansi-fg-bright-green {
	color: var(--green);
}
.ansi-fg-bright-yellow {
	color: var(--yellow);
}
.ansi-fg-bright-blue {
	color: var(--accent);
}
.ansi-fg-bright-magenta {
	color: var(--purple);
}
.ansi-fg-bright-cyan {
	color: var(--teal);
}
.ansi-fg-bright-white {
	color: var(--text-strong);
}
.ansi-bg-black {
	background: var(--bg-panel-2);
}
.ansi-bg-red {
	background: var(--red);
}
.ansi-bg-green {
	background: var(--green);
}
.ansi-bg-yellow {
	background: var(--yellow);
}
.ansi-bg-blue {
	background: var(--accent);
}
.ansi-bg-magenta {
	background: var(--purple);
}
.ansi-bg-cyan {
	background: var(--teal);
}
.ansi-bg-white {
	background: var(--text);
}
.ansi-bg-bright-black {
	background: var(--text-faint);
}
.ansi-bg-bright-white {
	background: var(--text-strong);
}
.ansi-bold {
	font-weight: 600;
}
.ansi-dim {
	opacity: 0.6;
}
.ansi-italic {
	font-style: italic;
}
.ansi-underline {
	text-decoration: underline;
}
.term-line.err {
	color: var(--red);
}
.term-line.sys {
	color: var(--text-faint);
}
.term-input-row {
	flex: none;
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 6px 12px;
	border-top: 1px solid var(--border);
	cursor: text;
}
.term-prompt {
	flex: none;
	color: var(--green);
	font-size: 12px;
}
.term-input {
	flex: 1;
	min-width: 0;
	height: 22px;
	line-height: 22px;
	background: transparent;
	border: none;
	padding: 0;
	font-family: inherit;
	font-size: 12px;
	color: var(--text-strong);
	caret-color: var(--accent);
}
.term-input:focus {
	box-shadow: none;
	outline: none;
}
.term-input::placeholder {
	color: var(--text-faint);
}
</style>
