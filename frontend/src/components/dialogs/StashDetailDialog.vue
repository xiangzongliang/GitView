<script setup lang="ts">
// 「Stash 详情」弹窗：展示一个 stash 条目包含的文件列表与每个文件的差异内容，
// 并提供 应用（保留/含暂存区）/ 弹出 / 删除 等恢复操作。
// 未跟踪文件（stash -u 的第三个父提交）由后端 StashDiff 合成 new-file 差异。
import { computed, nextTick, onMounted, ref, watch } from "vue";

// skeleton 骨架屏：模拟 diff 行的不同宽度，避免随机数引起的重渲染闪烁
const SK_LINE_WIDTHS = [
	0.92, 0.65, 0.85, 0.5, 0.95, 0.7, 0.78, 0.55, 0.88, 0.6, 0.72, 0.45, 0.9,
	0.68, 0.82,
];
import { useRepo } from "../../stores/repo";
import { useUI } from "../../stores/ui";
import { GitService, errMsg } from "../../api";
import type { CommitFile } from "../../api";
import { relTime, statusColor, basename, dirname } from "../../utils/format";
import ModalDialog from "../ui/ModalDialog.vue";
import Icon from "../ui/Icon.vue";
import DiffViewer from "../common/DiffViewer.vue";

const props = defineProps<{
	payload?: {
		index: number;
		ref: string;
		branch: string;
		message: string;
		timestamp: number;
	};
}>();
const emit = defineEmits<{ (e: "close"): void }>();

const repo = useRepo();
const ui = useUI();

const entry = computed(() => props.payload);
const title = computed(() => entry.value?.ref || "Stash");

const files = ref<CommitFile[] | null>(null);
const loading = ref(false);
const error = ref("");

const sel = ref<CommitFile | null>(null);
const diff = ref("");
const diffLoading = ref(false);
let selGen = 0;

// 显示完整文件内容的开关
const showFullFile = ref(false);

async function load() {
	if (!entry.value) return;
	loading.value = true;
	error.value = "";
	files.value = null;
	sel.value = null;
	diff.value = "";
	try {
		const list = await GitService.StashFiles(repo.path, entry.value.index);
		const arr = list || [];
		files.value = arr;
		if (arr.length > 0) void selectFile(arr[0]);
	} catch (e) {
		error.value = errMsg(e);
	} finally {
		loading.value = false;
	}
}

async function selectFile(f: CommitFile, fullFile?: boolean) {
	if (!entry.value) return;
	const ff = fullFile ?? showFullFile.value;
	const gen = ++selGen;
	sel.value = f;
	diff.value = "";
	diffLoading.value = true;
	try {
		const d = await GitService.StashDiff(
			repo.path,
			entry.value.index,
			f.path,
			ff,
		);
		if (gen !== selGen) return;
		diff.value = d || "";
		// 完整文件模式：渲染后滚动到第一个修改位置
		if (ff) {
			void scrollToFirstChange();
		}
	} catch (e) {
		if (gen === selGen) ui.error("加载 diff 失败", errMsg(e));
	} finally {
		if (gen === selGen) diffLoading.value = false;
	}
}

/** 滚动到 diff 区域第一个增/删行 */
async function scrollToFirstChange() {
	await nextTick();
	// 等 DOM 渲染完毕（v-html 更新需要一帧）
	setTimeout(() => {
		const pane: HTMLElement | null = document.querySelector(".diff-pane");
		if (!pane) return;
		const target: HTMLElement | null = pane.querySelector(
			".diff-row.add, .diff-row.del",
		);
		if (target) {
			target.scrollIntoView({ behavior: "smooth", block: "center" });
		}
	}, 150);
}

// 切换「显示完整文件」时重新加载当前选中文件的 diff
watch(showFullFile, () => {
	if (sel.value && entry.value) {
		void selectFile(sel.value, showFullFile.value);
	}
});

/** runOp 对 void 操作成功也返回 null，这里以「stash 是否还在」判断结果。 */
async function stashGone(): Promise<boolean> {
	await repo.refreshStashes();
	return !repo.stashes.some((s) => s.ref === entry.value?.ref);
}

async function doPop() {
	if (!entry.value) return;
	await repo.stashPop(entry.value.index);
	if (await stashGone()) emit("close");
}

async function doApply() {
	if (!entry.value) return;
	await repo.stashApply(entry.value.index);
}

async function doApplyIndex() {
	if (!entry.value) return;
	await repo.stashApplyIndex(entry.value.index);
}

async function doDrop() {
	if (!entry.value) return;
	const ok = await ui.confirm({
		title: "删除 Stash",
		message:
			"确定删除 " +
			entry.value.ref +
			"（" +
			(entry.value.message || "无描述") +
			"）吗？此操作不可恢复。",
		confirmLabel: "删除",
		danger: true,
	});
	if (!ok) return;
	await repo.stashDrop(entry.value.index);
	if (await stashGone()) emit("close");
}

onMounted(load);
</script>

<template>
	<ModalDialog
		:title="'Stash 详情 — ' + title"
		:width="1000"
		:height="650"
		draggable
		resizable
		@close="emit('close')"
	>
		<div v-if="entry" class="stash-meta">
			<Icon name="stash" :size="13" class="faint-ic" />
			<span class="meta-ref">{{ entry.ref }}</span>
			<span v-if="entry.branch" class="meta-chip">
				<Icon name="branch" :size="10" /> {{ entry.branch }}
			</span>
			<span class="meta-msg">{{ entry.message || "无描述" }}</span>
			<span class="meta-time">{{ relTime(entry.timestamp) }}</span>
			<label
				class="full-file-toggle"
				title="显示完整文件内容（包含未修改的上下文行）"
			>
				<input
					v-model="showFullFile"
					type="checkbox"
					class="toggle-input"
				/>
				<span class="toggle-track">
					<span class="toggle-thumb" />
				</span>
				<span class="toggle-label">完整文件</span>
			</label>
		</div>

		<div class="stash-body">
			<Transition name="stash-fade" mode="out-in">
				<div v-if="loading" key="loading" class="skeleton-main">
					<div class="sk-files">
						<div v-for="i in 8" :key="i" class="sk-file-row">
							<div
								class="sk-bar"
								:style="{
									width: 45 + ((i * 7) % 40) + '%',
								}"
							/>
						</div>
					</div>
					<div class="sk-diff">
						<div
							v-for="(w, i) in SK_LINE_WIDTHS"
							:key="i"
							class="sk-line"
						>
							<div
								class="sk-bar"
								:style="{
									width: (w * 100).toFixed(0) + '%',
								}"
							/>
						</div>
					</div>
				</div>
				<div v-else-if="error" key="error" class="center-hint err">
					<Icon name="alert" :size="13" /> 读取失败：{{ error }}
				</div>
				<div v-else-if="entry" key="content" class="stash-main">
					<div class="files">
						<div class="files-head">
							更改文件
							<span class="sec-count">{{
								files?.length ?? 0
							}}</span>
						</div>
						<div class="files-list">
							<div
								v-for="f in files"
								:key="f.path"
								class="file-row"
								:class="{ selected: sel?.path === f.path }"
								:title="
									f.oldPath
										? f.oldPath + ' → ' + f.path
										: f.path
								"
								@click="selectFile(f)"
							>
								<span
									class="st"
									:style="{ color: statusColor(f.status) }"
									>{{ f.binary ? "B" : f.status }}</span
								>
								<span class="fp">
									<span class="bn">{{
										basename(f.path)
									}}</span>
									<span v-if="dirname(f.path)" class="dn">{{
										dirname(f.path)
									}}</span>
								</span>
								<span v-if="f.untracked" class="mini faint"
									>未跟踪</span
								>
								<span v-else-if="!f.binary" class="counts mono">
									<span class="green"
										>+{{ f.additions }}</span
									>
									<span class="red">−{{ f.deletions }}</span>
								</span>
							</div>
							<div
								v-if="files && files.length === 0"
								class="files-empty"
							>
								这个 Stash 没有包含任何文件更改
							</div>
						</div>
					</div>
					<div class="diff-pane">
						<DiffViewer
							:raw="diff"
							:loading="diffLoading"
							:filename="sel?.path || ''"
							empty-text="选择左侧文件查看差异"
						/>
					</div>
				</div>
			</Transition>
		</div>

		<template #footer>
			<template v-if="entry && !loading && !error">
				<button
					class="btn btn-cmd"
					:disabled="ui.busy"
					@click="doApply"
				>
					<span class="btn-cmd-row">
						<Icon name="stash" :size="13" /> 应用（保留 Stash）
					</span>
					<span class="btn-cmd-hint">git stash apply</span>
				</button>
				<button
					class="btn btn-cmd"
					:disabled="ui.busy"
					title="同时恢复当时的暂存区状态"
					@click="doApplyIndex"
				>
					<span class="btn-cmd-row">
						<Icon name="check" :size="13" /> 应用（含暂存区）
					</span>
					<span class="btn-cmd-hint">git stash apply --index</span>
				</button>
				<button class="btn btn-cmd" :disabled="ui.busy" @click="doPop">
					<span class="btn-cmd-row">
						<Icon name="pull" :size="13" /> 弹出（应用并删除）
					</span>
					<span class="btn-cmd-hint">git stash pop</span>
				</button>
				<span class="footer-gap" />
				<button
					class="btn btn-danger btn-cmd"
					:disabled="ui.busy"
					@click="doDrop"
				>
					<span class="btn-cmd-row">
						<Icon name="trash" :size="13" /> 删除
					</span>
					<span class="btn-cmd-hint">git stash drop</span>
				</button>
			</template>
			<button class="btn" @click="emit('close')">关闭</button>
		</template>
	</ModalDialog>
</template>

<style scoped>
.stash-meta {
	display: flex;
	align-items: center;
	gap: 8px;
	flex-wrap: wrap;
	font-size: 12px;
	color: var(--text);
	user-select: text;
}
.faint-ic {
	color: var(--text-faint);
}
.meta-ref {
	font-family: var(--font-mono, monospace);
	color: var(--accent);
}
.meta-chip {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	font-size: 11px;
	color: var(--text-dim);
	background: var(--hover-soft);
	border-radius: 7px;
	padding: 1px 7px;
}
.meta-msg {
	flex: 1;
	color: var(--text-strong);
	font-weight: 600;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.meta-time {
	margin-left: auto;
	color: var(--text-faint);
	font-size: 11px;
	flex: none;
}

/* ---- 完整文件开关 ---- */
.full-file-toggle {
	display: inline-flex;
	align-items: center;
	gap: 5px;
	cursor: pointer;
	user-select: none;
	flex: none;
}
.toggle-input {
	position: absolute;
	opacity: 0;
	width: 0;
	height: 0;
}
.toggle-track {
	position: relative;
	width: 28px;
	height: 15px;
	border-radius: 999px;
	background: var(--border-strong);
	transition: background 0.2s;
}
.toggle-input:checked + .toggle-track {
	background: var(--accent);
}
.toggle-thumb {
	position: absolute;
	top: 2px;
	left: 2px;
	width: 11px;
	height: 11px;
	border-radius: 50%;
	background: var(--bg-panel);
	box-shadow: 0 1px 2px rgba(0, 0, 0, 0.18);
	transition: transform 0.2s;
}
.toggle-input:checked + .toggle-track .toggle-thumb {
	transform: translateX(13px);
}
.toggle-label {
	font-size: 10.5px;
	color: var(--text-dim);
	white-space: nowrap;
}
.stash-main {
	flex: 1;
	min-height: 0;
	display: flex;
	border: 1px solid var(--border);
	border-radius: 8px;
	overflow: hidden;
}
.files {
	width: clamp(220px, 30%, 400px);
	flex: none;
	display: flex;
	flex-direction: column;
	border-right: 1px solid var(--border);
	background: var(--bg-panel);
	min-height: 0;
}
.files-head {
	flex: none;
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 6px 10px;
	font-size: 11px;
	font-weight: 600;
	text-transform: uppercase;
	letter-spacing: 0.05em;
	color: var(--text-faint);
	border-bottom: 1px solid var(--border);
}
.sec-count {
	font-size: 10px;
	background: var(--hover-soft);
	border-radius: 7px;
	padding: 0 5px;
	line-height: 14px;
}
.files-list {
	flex: 1;
	overflow-y: auto;
	min-height: 0;
}
.file-row {
	display: flex;
	align-items: center;
	gap: 7px;
	padding: 4px 10px;
	cursor: pointer;
	font-size: 12px;
}
.file-row:hover {
	background: var(--bg-hover);
}
.file-row.selected {
	background: var(--bg-selected);
}
.st {
	flex: none;
	width: 14px;
	font-family: var(--font-mono);
	font-weight: 700;
	font-size: 11px;
	text-align: center;
}
.fp {
	flex: 1;
	min-width: 0;
	display: flex;
	align-items: baseline;
	gap: 5px;
	overflow: hidden;
}
.bn {
	color: var(--text-strong);
	white-space: nowrap;
}
.dn {
	color: var(--text-faint);
	font-size: 10.5px;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
	direction: rtl;
}
.counts {
	flex: none;
	display: flex;
	gap: 5px;
	font-size: 10.5px;
}
.mini {
	flex: none;
	font-size: 10px;
}
.green {
	color: var(--green);
}
.red {
	color: var(--red);
}
.files-empty {
	padding: 10px;
	color: var(--text-faint);
	font-size: 11.5px;
	text-align: center;
}
.diff-pane {
	flex: 1;
	min-width: 0;
	min-height: 0;
	display: flex;
	flex-direction: column;
}
.center-hint {
	display: flex;
	align-items: center;
	justify-content: center;
	gap: 8px;
	padding: 28px 0;
	color: var(--text-dim);
	font-size: 12.5px;
}
.center-hint.err {
	color: var(--red);
}
.footer-gap {
	flex: 1;
}

/* ---- 带 git 命令提示的底部按钮 ----
   .btn 是固定 26px 高的单行 flex，这里覆盖为纵向排列：
   上行图标+文案，下行小字显示实际执行的 git 命令。 */
.btn-cmd {
	height: auto;
	flex-direction: column;
	align-items: flex-start;
	gap: 2px;
	padding: 5px 10px 4px;
	line-height: 1.2;
}
.btn-cmd-row {
	display: inline-flex;
	align-items: center;
	gap: 5px;
}
.btn-cmd-hint {
	font-family: var(--font-mono);
	font-size: 9.5px;
	color: var(--text-faint);
	letter-spacing: -0.01em;
}
.btn-cmd:hover:not(:disabled) .btn-cmd-hint {
	color: var(--text-dim);
}
/* .btn-danger 是红底白字，提示文字需用半透明白才看得清 */
.btn-cmd.btn-danger .btn-cmd-hint {
	color: rgba(255, 255, 255, 0.72);
}
.btn-cmd.btn-danger:hover:not(:disabled) .btn-cmd-hint {
	color: rgba(255, 255, 255, 0.92);
}

/* ---- body 容器 + 打开动画 ---- */
.stash-body {
	flex: 1;
	min-height: 0;
	position: relative;
	display: flex;
	flex-direction: column;
}
.stash-fade-enter-active,
.stash-fade-leave-active {
	transition:
		opacity 0.3s ease,
		transform 0.3s ease;
}
.stash-fade-enter-from {
	opacity: 0;
	transform: translateY(8px);
}
.stash-fade-leave-to {
	opacity: 0;
	transform: translateY(-4px);
}

/* ---- skeleton 骨架屏 ---- */
@keyframes shimmer {
	0% {
		background-position: -200% 0;
	}
	100% {
		background-position: 200% 0;
	}
}
.sk-bar {
	height: 12px;
	border-radius: 3px;
	background: linear-gradient(
		90deg,
		var(--hover-soft) 25%,
		var(--bg-hover) 50%,
		var(--hover-soft) 75%
	);
	background-size: 200% 100%;
	animation: shimmer 1.6s ease-in-out infinite;
}
.skeleton-main {
	flex: 1;
	display: flex;
	border: 1px solid var(--border);
	border-radius: 8px;
	overflow: hidden;
}
.sk-files {
	width: clamp(220px, 30%, 400px);
	flex: none;
	border-right: 1px solid var(--border);
	background: var(--bg-panel);
	padding: 48px 10px 10px;
	display: flex;
	flex-direction: column;
	gap: 10px;
}
.sk-file-row {
	display: flex;
	align-items: center;
	padding: 3px 0;
}
.sk-diff {
	flex: 1;
	background: var(--bg-app);
	padding: 10px 16px;
	display: flex;
	flex-direction: column;
	gap: 8px;
}
.sk-line {
	display: flex;
	align-items: center;
	padding: 3px 0;
}
</style>
