<script setup lang="ts">
// 「Stash 详情」弹窗：展示一个 stash 条目包含的文件列表与每个文件的差异内容，
// 并提供 应用（保留/含暂存区）/ 弹出 / 删除 等恢复操作。
// 未跟踪文件（stash -u 的第三个父提交）由后端 StashDiff 合成 new-file 差异。
import { computed, onMounted, ref } from "vue";
import { useRepo } from "../../stores/repo";
import { useUI } from "../../stores/ui";
import { GitService, errMsg } from "../../api";
import type { CommitFile } from "../../api";
import { relTime, statusColor, basename, dirname } from "../../utils/format";
import ModalDialog from "../ui/ModalDialog.vue";
import Icon from "../ui/Icon.vue";
import Spinner from "../ui/Spinner.vue";
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

async function selectFile(f: CommitFile) {
	if (!entry.value) return;
	const gen = ++selGen;
	sel.value = f;
	diff.value = "";
	diffLoading.value = true;
	try {
		const d = await GitService.StashDiff(
			repo.path,
			entry.value.index,
			f.path,
		);
		if (gen !== selGen) return;
		diff.value = d || "";
	} catch (e) {
		if (gen === selGen) ui.error("加载 diff 失败", errMsg(e));
	} finally {
		if (gen === selGen) diffLoading.value = false;
	}
}

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
		:width="860"
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
		</div>

		<div v-if="loading" class="center-hint">
			<Spinner :size="14" /> 正在读取 Stash 内容…
		</div>
		<div v-else-if="error" class="center-hint err">
			<Icon name="alert" :size="13" /> 读取失败：{{ error }}
		</div>
		<div v-else-if="entry" class="stash-main">
			<div class="files">
				<div class="files-head">
					更改文件
					<span class="sec-count">{{ files?.length ?? 0 }}</span>
				</div>
				<div class="files-list">
					<div
						v-for="f in files"
						:key="f.path"
						class="file-row"
						:class="{ selected: sel?.path === f.path }"
						:title="f.oldPath ? f.oldPath + ' → ' + f.path : f.path"
						@click="selectFile(f)"
					>
						<span
							class="st"
							:style="{ color: statusColor(f.status) }"
							>{{ f.binary ? "B" : f.status }}</span
						>
						<span class="fp">
							<span class="bn">{{ basename(f.path) }}</span>
							<span v-if="dirname(f.path)" class="dn">{{
								dirname(f.path)
							}}</span>
						</span>
						<span v-if="f.untracked" class="mini faint"
							>未跟踪</span
						>
						<span v-else-if="!f.binary" class="counts mono">
							<span class="green">+{{ f.additions }}</span>
							<span class="red">−{{ f.deletions }}</span>
						</span>
					</div>
					<div v-if="files && files.length === 0" class="files-empty">
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

		<template #footer>
			<template v-if="entry && !loading && !error">
				<button class="btn" :disabled="ui.busy" @click="doApply">
					<Icon name="stash" :size="13" /> 应用（保留 Stash）
				</button>
				<button
					class="btn"
					:disabled="ui.busy"
					title="git stash apply --index：同时恢复当时的暂存区状态"
					@click="doApplyIndex"
				>
					<Icon name="check" :size="13" /> 应用（含暂存区）
				</button>
				<button class="btn" :disabled="ui.busy" @click="doPop">
					<Icon name="pull" :size="13" /> 弹出（应用并删除）
				</button>
				<span class="footer-gap" />
				<button
					class="btn btn-danger"
					:disabled="ui.busy"
					@click="doDrop"
				>
					<Icon name="trash" :size="13" /> 删除
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
.stash-main {
	flex: 1;
	min-height: 420px;
	display: flex;
	border: 1px solid var(--border);
	border-radius: 8px;
	overflow: hidden;
}
.files {
	width: 260px;
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
</style>
