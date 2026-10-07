<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRepo } from "../../stores/repo";
import { useUI } from "../../stores/ui";
import { useAi } from "../../stores/ai";
import { errMsg, RepoService } from "../../api";
import {
	availableAiModels,
	decodeModelValue,
	encodeModelValue,
} from "../../ai/models";
import { collectCommitContext } from "../../ai/commitContext";
import type { ContextPick } from "../../ai/commitContext";
import {
	COMMIT_PREFIX_PRESETS,
	CUSTOM_PREFIX_VALUE,
	isPresetPrefix,
} from "../../ai/commitPrefix";
import {
	buildCommitSystemPrompt,
	buildCommitUserPrompt,
} from "../../ai/prompts";
import FileList from "./FileList.vue";
import DiffViewer from "../common/DiffViewer.vue";
import ImageDiffViewer from "../common/ImageDiffViewer.vue";
import ConflictResolver from "./ConflictResolver.vue";
import { isImageFile } from "../../utils/format";
import Icon from "../ui/Icon.vue";
import Spinner from "../ui/Spinner.vue";
import Checkbox from "../ui/Checkbox.vue";
import SelectMenu from "../ui/SelectMenu.vue";
import type { SelectEntry } from "../ui/types";
import AiModelSelect from "../ai/AiModelSelect.vue";

const repo = useRepo();
const ui = useUI();
const ai = useAi();

// 左侧文件区宽度可拖拽调整（与右侧差异区之间），带最小/最大限制并持久化
const LEFT_W_KEY = "gv.statusLeftW";
const leftW = ref(Number(localStorage.getItem(LEFT_W_KEY)) || 340);
function startLeftDrag(e: MouseEvent) {
	e.preventDefault();
	const startX = e.clientX;
	const startW = leftW.value;
	const move = (ev: MouseEvent) => {
		leftW.value = Math.min(
			Math.max(240, startW + (ev.clientX - startX)),
			Math.max(240, Math.round(window.innerWidth * 0.5)),
		);
	};
	const up = () => {
		document.removeEventListener("mousemove", move);
		document.removeEventListener("mouseup", up);
		document.body.style.cursor = "";
		document.body.style.userSelect = "";
		try {
			localStorage.setItem(LEFT_W_KEY, String(leftW.value));
		} catch {
			/* ignore */
		}
	};
	document.addEventListener("mousemove", move);
	document.addEventListener("mouseup", up);
	document.body.style.cursor = "col-resize";
	document.body.style.userSelect = "none";
}

const ta = ref<HTMLTextAreaElement | null>(null);

const stagedCount = computed(() => repo.status?.staged?.length || 0);
const canCommit = computed(
	() =>
		!ui.opRunning &&
		(stagedCount.value > 0 || (repo.amend && !!repo.status?.head)),
);
const merging = computed(() => !!repo.status?.merging);

// 选中的文件仍是冲突状态时，用冲突解决器（三方合并）替代普通 diff 视图；
// 依据实时 status 判定，冲突解决并暂存后会自动切回 diff 视图
const conflictedSelected = computed(() => {
	const f = repo.selectedFile;
	if (!f) return false;
	return (repo.status?.conflicted || []).some((c) => c.path === f.path);
});

// 图片文件（含 SVG）右侧改用前后对比预览而非文本 diff；
// SVG 可在预览内切换回源码差异。冲突文件仍优先用冲突解决器。
const imageSelected = computed(() => {
	const f = repo.selectedFile;
	return !!f && isImageFile(f.path);
});
const selectedStatusChar = computed(() => {
	const f = repo.selectedFile;
	return f ? statusCharOf(f.path, f.group) : "M";
});

// 已提交但尚未推送的提交数（顶部 Push 按钮的角标同样取此值）
const ahead = computed(() => repo.status?.ahead || 0);
/**
 * 无待提交更改、但有未推送提交时，提交按钮变为 Push：
 * 这样提交完直接在这里推送，无需再点顶部工具栏的 Push。
 * 一旦还有未提交的文件（dirtyCount > 0）或勾选了 Amend，就回到正常提交按钮。
 */
const pushMode = computed(
	() =>
		!repo.opInProgress &&
		repo.dirtyCount === 0 &&
		ahead.value > 0 &&
		!repo.amend,
);
function countText(n: number): string {
	return n > 99 ? "99+" : String(n);
}

function onKeydown(e: KeyboardEvent) {
	if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
		e.preventDefault();
		if (canCommit.value) repo.doCommit();
	}
}

// ---------------------------------------------------------- AI 生成提交信息

// 选中的模型（`providerId::模型名`），跨会话记住上次的选择。
const AI_MODEL_KEY = "gv.aiCommitModel";
const aiModel = ref(localStorage.getItem(AI_MODEL_KEY) || "");
const aiBusy = ref(false);

// 提交信息前缀：按项目保存在 config.json（见 RepoService.Get/SetAiCommitPrefix）。
// 项目从未配置过时使用下面的默认值；显式选「无前缀」会存为 ""，不会回退到默认。
const DEFAULT_COMMIT_PREFIX = "AI：";
const commitPrefix = ref(DEFAULT_COMMIT_PREFIX);

const prefixOptions = computed<SelectEntry[]>(() => {
	const opts: SelectEntry[] = COMMIT_PREFIX_PRESETS.map((p) => ({
		label: p.label,
		value: p.value,
	}));
	// 已保存的自定义前缀额外列一项，方便一眼看到当前值。
	const cur = commitPrefix.value;
	if (cur && !isPresetPrefix(cur)) {
		opts.push({ label: cur, value: cur });
	}
	opts.push({ label: "自定义…", value: CUSTOM_PREFIX_VALUE });
	return opts;
});

// 切换仓库时读取该项目的已保存前缀（后端返回 null 表示从未配置过）。
watch(
	() => repo.path,
	async (p) => {
		commitPrefix.value = DEFAULT_COMMIT_PREFIX;
		if (!p) return;
		try {
			const saved = await RepoService.GetAiCommitPrefix(p);
			commitPrefix.value = saved == null ? DEFAULT_COMMIT_PREFIX : saved;
		} catch (e) {
			console.error("读取提交前缀失败", errMsg(e));
		}
	},
	{ immediate: true },
);

async function saveCommitPrefix(v: string) {
	commitPrefix.value = v;
	if (!repo.path) return;
	try {
		await RepoService.SetAiCommitPrefix(repo.path, v);
	} catch (e) {
		ui.error("保存提交前缀失败", errMsg(e));
	}
}

/** 前缀下拉：选中「自定义…」时弹输入框，其余选项直接保存。 */
async function onPrefixChange(v: string) {
	if (v !== CUSTOM_PREFIX_VALUE) {
		await saveCommitPrefix(v);
		return;
	}
	const next = await new Promise<string>((resolve) => {
		ui.openDialog("prompt", {
			title: "自定义提交前缀",
			label: "前缀会拼在生成的提交信息最前面",
			value: commitPrefix.value,
			placeholder: "如 feat(ui): ",
			resolve,
		});
	});
	if (next) await saveCommitPrefix(next);
}

watch(aiModel, (v) => {
	try {
		localStorage.setItem(AI_MODEL_KEY, v);
	} catch {
		/* ignore */
	}
});

// 配置变化（首次加载 / 改设置）后校正选择：已失效则回退到第一个可用模型。
watch(
	() => ai.providers,
	() => {
		const list = availableAiModels(ai.providers);
		if (list.length === 0) return;
		const cur = aiModel.value;
		const valid = list.some(
			(c) => encodeModelValue(c.providerId, c.model) === cur,
		);
		if (!valid) {
			aiModel.value = encodeModelValue(list[0].providerId, list[0].model);
		}
	},
	{ deep: true, immediate: true },
);

const changeCount = computed(
	() =>
		(repo.status?.staged?.length || 0) +
		(repo.status?.unstaged?.length || 0) +
		(repo.status?.untracked?.length || 0),
);

const hasAiModel = computed(() => availableAiModels(ai.providers).length > 0);

const canAiComplete = computed(() => {
	if (aiBusy.value) return false;
	// 还没配置可用模型时按钮仍可点：点击会直接打开设置去配置（见 aiComplete）。
	if (!hasAiModel.value) return true;
	return changeCount.value > 0;
});

/** 按钮提示（无可用模型 / 无变更时给出指引）。 */
const aiButtonHint = computed(() => {
	if (!hasAiModel.value) return "还没有可用的 AI 模型，点击前往设置配置";
	if (changeCount.value === 0) return "当前没有可分析的变更";
	if (stagedCount.value > 0)
		return `根据勾选的 ${stagedCount.value} 个文件生成提交信息`;
	if (repo.selectedFile) return "根据当前选中的文件生成提交信息";
	return "根据全部变更生成提交信息";
});

/** 在状态里查文件的变更字符（找不到时退回按分组推断）。 */
function statusCharOf(path: string, group: string): string {
	const st = repo.status;
	const found = [
		...(st?.staged || []),
		...(st?.unstaged || []),
		...(st?.untracked || []),
		...(st?.conflicted || []),
	].find((f) => f.path === path);
	if (found?.statusChar) return found.statusChar;
	if (group === "untracked") return "?";
	if (group === "conflicted") return "U";
	return "M";
}

/**
 * 本次 AI 分析要用的文件：
 * - 勾选了（已暂存）文件时，只分析这些文件；
 * - 没有勾选但左侧选中了某个文件时，只分析该文件；
 * - 都没有时返回 null，交给 collectCommitContext 使用工作区全部变更。
 */
function aiScope(): ContextPick[] | null {
	const st = repo.status;
	if (!st) return null;
	const staged = st.staged || [];
	if (staged.length > 0) {
		return staged.map((f) => ({
			path: f.path,
			staged: true,
			status: f.statusChar,
		}));
	}
	const sel = repo.selectedFile;
	if (!sel) return null;
	return [
		{
			path: sel.path,
			staged: sel.staged,
			status: statusCharOf(sel.path, sel.group),
		},
	];
}

/** 收集变更上下文后打开流式对话弹窗，生成结果由用户确认后写入输入框。 */
async function aiComplete() {
	if (aiBusy.value) return;
	if (!hasAiModel.value) {
		ui.openSettings("aimodels");
		return;
	}
	if (changeCount.value === 0) return;
	const { providerId, model } = decodeModelValue(aiModel.value);
	aiBusy.value = true;
	try {
		const ctx = await collectCommitContext(
			repo.path,
			repo.status,
			aiScope(),
		);
		const prefix = commitPrefix.value;
		ui.openDialog("ai-commit", {
			providerId,
			model,
			prefix,
			system: buildCommitSystemPrompt(prefix),
			user: buildCommitUserPrompt(ctx),
		});
	} catch (e) {
		ui.error("收集变更失败", errMsg(e));
	} finally {
		aiBusy.value = false;
	}
}

// When switching to this view, focus the message box if empty.
watch(
	() => repo.view,
	(v) => {
		if (v === "status" && ta.value) ta.value.focus();
	},
);
</script>

<template>
	<div class="status-view">
		<div class="left" :style="{ width: leftW + 'px' }">
			<FileList />
			<div class="commit-form">
				<!-- 输入框 + 底部工具条：模型/前缀选择与 AI 补充集成在输入框内部 -->
				<div class="composer">
					<textarea
						ref="ta"
						v-model="repo.commitMessage"
						class="msg"
						rows="4"
						spellcheck="false"
						:placeholder="
							merging
								? '合并提交信息（Ctrl+Enter 提交合并）'
								: '提交信息，第一行为标题…（Ctrl+Enter 提交）'
						"
						@keydown="onKeydown"
					/>
					<div class="composer-bar">
						<div class="composer-left">
							<div class="model-cell">
								<AiModelSelect
									v-model="aiModel"
									:disabled="aiBusy"
									flat
									placeholder="选择 AI 模型"
								/>
							</div>
							<div
								v-if="hasAiModel"
								class="prefix-cell"
								title="提交信息前缀（按项目保存）"
							>
								<SelectMenu
									:model-value="commitPrefix"
									:options="prefixOptions"
									flat
									:max-height="220"
									:min-width="150"
									@update:model-value="onPrefixChange"
								/>
							</div>
						</div>
						<button
							class="btn ai-btn"
							:disabled="!canAiComplete"
							:title="aiButtonHint"
							@click="aiComplete"
						>
							<Spinner v-if="aiBusy" :size="12" />
							<Icon v-else name="sparkles" :size="12" />
							AI 补充
						</button>
					</div>
				</div>
				<div class="form-row">
					<label class="amend" title="修改最近一次提交（替换 HEAD）">
						<Checkbox
							v-model="repo.amend"
							:disabled="!repo.status?.head"
						/>
						Amend
					</label>
					<div class="spacer" />
					<button
						v-if="pushMode"
						class="btn btn-primary commit-btn"
						:disabled="!!ui.opRunning"
						title="没有待提交的更改，把本地提交推送到远程"
						@click="ui.openDialog('push')"
					>
						<Spinner v-if="ui.isOp('push')" :size="13" />
						<Icon v-else name="push" :size="13" />
						{{ ui.isOp("push") ? "推送中…" : "Push" }}
						<span
							v-if="ahead && !ui.isOp('push')"
							class="push-badge"
							>{{ countText(ahead) }}</span
						>
					</button>
					<button
						v-else
						class="btn btn-primary commit-btn"
						:disabled="!canCommit"
						@click="repo.doCommit()"
					>
						<Spinner v-if="ui.isOp('commit')" :size="13" />
						<Icon v-else name="commit" :size="13" />
						{{
							ui.isOp("commit")
								? "提交中…"
								: merging
									? "提交合并"
									: repo.amend
										? "Amend 提交"
										: "提交"
						}}
					</button>
				</div>
			</div>
		</div>
		<div
			class="left-resizer"
			title="拖动调整左侧宽度"
			@mousedown="startLeftDrag"
		/>
		<ConflictResolver
			v-if="conflictedSelected"
			:path="repo.selectedFile!.path"
		/>
		<ImageDiffViewer
			v-else-if="imageSelected"
			:repo-path="repo.path"
			:path="repo.selectedFile!.path"
			:staged="repo.selectedFile!.staged"
			:status="selectedStatusChar"
			:raw="repo.fileDiff"
			:loading="repo.fileDiffLoading"
		/>
		<DiffViewer
			v-else
			:raw="repo.fileDiff"
			:loading="repo.fileDiffLoading"
			:filename="repo.selectedFile?.path"
			empty-text="选择左侧文件查看差异"
		/>
	</div>
</template>

<style scoped>
.status-view {
	flex: 1;
	min-height: 0;
	display: flex;
}
.left {
	width: 340px; /* default; user-resizable via the divider */
	flex: none;
	display: flex;
	flex-direction: column;
	min-height: 0;
	border-right: 1px solid var(--border);
	background: var(--bg-panel);
}
.left-resizer {
	flex: none;
	width: 5px;
	margin: 0 -2px;
	cursor: col-resize;
	z-index: 10;
	position: relative;
}
.left-resizer::after {
	content: "";
	position: absolute;
	left: 2px;
	top: 0;
	bottom: 0;
	width: 1px;
	background: var(--border);
}
.left-resizer:hover::after,
.left-resizer:active::after {
	background: var(--accent);
	width: 2px;
}
.commit-form {
	flex: none;
	border-top: 1px solid var(--border);
	padding: 8px;
	display: flex;
	flex-direction: column;
	gap: 7px;
	background: var(--bg-panel);
}
/* 输入框 + 底部工具条：外观上是一个整体输入框（工具条集成在框内） */
.composer {
	display: flex;
	flex-direction: column;
	border: 1px solid var(--border-strong);
	border-radius: var(--radius);
	background: var(--bg-input);
	overflow: hidden;
	transition: border-color 0.12s ease;
}
.composer:focus-within {
	border-color: var(--accent);
}
/* 去掉 textarea 自身的边框/背景/焦点圈，统一由外层 .composer 表现 */
.msg {
	width: 100%;
	min-height: 64px;
	max-height: 160px;
	padding: 7px 9px;
	font-size: 12.5px;
	border: none;
	border-radius: 0;
	background: transparent;
}
.msg:focus {
	border-color: transparent;
	box-shadow: none;
}
.composer-bar {
	display: flex;
	align-items: center;
	gap: 4px;
	padding: 3px 4px;
	border-top: 1px solid var(--border);
}
.composer-left {
	flex: 1;
	min-width: 0;
	display: flex;
	align-items: center;
}
/* 模型选择占满剩余宽度；前缀选择按内容宽度，空间不够时可收缩省略 */
.model-cell {
	flex: 1;
	min-width: 0;
	display: flex;
}
/* 前缀选择：与模型选择之间用竖分割线分隔（下拉自身不再画边框） */
.prefix-cell {
	position: relative;
	flex: 0 1 auto;
	min-width: 0;
	display: flex;
	padding-left: 5px;
}
.prefix-cell::before {
	content: "";
	position: absolute;
	left: 0;
	top: 4px;
	bottom: 4px;
	width: 1px;
	background: var(--border);
}
/* 工具条内的下拉用 SelectMenu 的 flat 变体（无边框，靠分割线界定）。
   AI 补充：同样去掉按钮外框，用主题色作为工具条内的主操作 */
.ai-btn {
	flex: none;
	height: 26px;
	padding: 0 9px;
	font-size: 11.5px;
	border-color: transparent;
	background: transparent;
	color: var(--accent);
}
.ai-btn:hover:not(:disabled) {
	background: var(--bg-hover);
	color: var(--accent-hover);
}
.form-row {
	display: flex;
	align-items: center;
	gap: 6px;
}
.amend {
	display: inline-flex;
	align-items: center;
	gap: 5px;
	font-size: 12px;
	color: var(--text-dim);
	cursor: pointer;
	user-select: none;
}
.spacer {
	flex: 1;
}
.commit-btn {
	min-width: 84px;
	position: relative;
}
/* 待推送提交数角标（按钮变为 Push 时显示） */
.push-badge {
	position: absolute;
	top: -6px;
	right: -6px;
	min-width: 16px;
	height: 16px;
	padding: 0 4px;
	border: 1.5px solid var(--bg-panel);
	border-radius: 8px;
	background: var(--accent);
	color: var(--accent-fg);
	font-size: 9.5px;
	font-weight: 700;
	line-height: 13px;
	text-align: center;
	pointer-events: none;
}
</style>
