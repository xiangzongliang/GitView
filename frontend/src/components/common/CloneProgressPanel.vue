<script setup lang="ts">
// 克隆进度面板：点击「开始克隆」后弹窗立即关闭、克隆在后台进行，
// 这里实时展示 git 的输出（进度 / 日志 / 错误）。日志区固定高度，超出后滚动。
import { nextTick, ref, watch } from "vue";
import { useRepos } from "../../stores/repos";
import Icon from "../ui/Icon.vue";
import Spinner from "../ui/Spinner.vue";

const repos = useRepos();
const scroller = ref<HTMLElement | null>(null);

// 新输出到达（含进度条对当前行的原地覆盖）时自动滚到底部
watch(
	() => [repos.cloneLog, repos.cloneError],
	() => {
		nextTick(() => {
			const el = scroller.value;
			if (el) el.scrollTop = el.scrollHeight;
		});
	},
	{ deep: true },
);
</script>

<template>
	<div v-if="repos.cloneVisible" class="clone-panel">
		<div class="cp-head">
			<Spinner v-if="repos.cloneRunning" :size="12" />
			<Icon
				v-else-if="repos.cloneError"
				name="alert-circle"
				:size="13"
				class="cp-icon error"
			/>
			<Icon v-else name="check-circle" :size="13" class="cp-icon ok" />
			<span class="cp-title">{{
				repos.cloneRunning
					? "正在克隆仓库…"
					: repos.cloneError
						? "克隆失败"
						: "克隆完成"
			}}</span>
			<span class="cp-target mono" :title="repos.cloneTarget">{{
				repos.cloneTarget
			}}</span>
			<div class="cp-actions">
				<button
					class="btn-icon"
					title="清空日志"
					:disabled="!repos.cloneLog.length"
					@click="repos.clearCloneLog()"
				>
					<Icon name="trash" :size="12" />
				</button>
				<button
					class="btn-icon"
					title="关闭"
					@click="repos.hideClonePanel()"
				>
					<Icon name="x" :size="12" />
				</button>
			</div>
		</div>
		<div ref="scroller" class="cp-body mono">
			<p v-for="(line, i) in repos.cloneLog" :key="i" class="cp-line">
				{{ line }}
			</p>
			<p v-if="repos.cloneError" class="cp-line cp-error">
				<Icon name="alert-circle" :size="12" />
				<span>克隆失败：{{ repos.cloneError }}</span>
			</p>
		</div>
	</div>
</template>

<style scoped>
.clone-panel {
	flex: none;
	display: flex;
	flex-direction: column;
	background: var(--term-bg);
	border-top: 1px solid var(--border-strong);
	min-height: 0;
}
.cp-head {
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
.cp-icon {
	flex: none;
}
.cp-icon.ok {
	color: var(--green);
}
.cp-icon.error {
	color: var(--red);
}
.cp-title {
	flex: none;
	font-size: 11px;
	font-weight: 600;
	color: var(--text-faint);
}
.cp-target {
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
.cp-actions {
	flex: none;
	display: flex;
	gap: 2px;
}
.cp-body {
	flex: none;
	height: 150px;
	overflow-y: auto;
	padding: 8px 12px;
	font-size: 11.5px;
	line-height: 1.6;
	color: var(--text-dim);
}
.cp-line {
	margin: 0;
	min-height: 1em;
	white-space: pre-wrap;
	word-break: break-all;
	user-select: text;
}
.cp-error {
	display: flex;
	align-items: flex-start;
	gap: 5px;
	color: var(--red);
}
.cp-error svg {
	flex: none;
	margin-top: 2px;
}
</style>
