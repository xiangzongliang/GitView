<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRepo } from "../../stores/repo";
import { useUI } from "../../stores/ui";
import FileList from "./FileList.vue";
import DiffViewer from "../common/DiffViewer.vue";
import Icon from "../ui/Icon.vue";
import Spinner from "../ui/Spinner.vue";
import Checkbox from "../ui/Checkbox.vue";

const repo = useRepo();
const ui = useUI();

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
		<DiffViewer
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
.msg {
	width: 100%;
	min-height: 64px;
	max-height: 160px;
	font-size: 12.5px;
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
	color: #fff;
	font-size: 9.5px;
	font-weight: 700;
	line-height: 13px;
	text-align: center;
	pointer-events: none;
}
</style>
