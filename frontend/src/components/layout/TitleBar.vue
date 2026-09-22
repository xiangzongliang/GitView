<script setup lang="ts">
import { computed } from "vue";
import { useRepos } from "../../stores/repos";
import { useRepo } from "../../stores/repo";
import { useUI } from "../../stores/ui";
import { useSettings } from "../../stores/settings";
import RefChips from "../common/RefChips.vue";
import Icon from "../ui/Icon.vue";
import type { RefDecoration } from "../../api";

const repos = useRepos();
const repo = useRepo();
const ui = useUI();
const settings = useSettings();

const name = computed(() => repos.active?.name || "");
const path = computed(() => repo.path || "");

const dark = computed(() => settings.resolvedDark);

const branchChips = computed<RefDecoration[] | null>(() => {
	const st = repo.status;
	if (!st || !st.branch) return null;
	return [
		{
			name: st.branch,
			type: "branch",
			current: !st.detached,
		} as RefDecoration,
	];
});
</script>

<template>
	<!-- 顶部 24px 为 macOS 原生拖拽区：按住可拖动窗口，纯点击仍会传递到按钮 -->
	<div class="titlebar">
		<!-- 绝对定位垂直居中：基于整个标题栏块居中，不受左侧红绿灯 padding 影响 -->
		<div class="title-center">
			<span class="title-name">{{ name || "Git View" }}</span>
			<span v-if="path" class="title-path" :title="path">{{ path }}</span>
			<span class="title-chips">
				<RefChips :refs="branchChips" />
			</span>
		</div>

		<!-- 标题行右侧操作区：与项目名/路径/分支同一行垂直居中对齐 -->
		<div class="title-actions">
			<button
				class="btn-icon title-btn"
				:title="dark ? '切换到亮色' : '切换到暗色'"
				@click="settings.toggleLightDark()"
			>
				<Icon :name="dark ? 'sun' : 'moon'" :size="15" />
			</button>
			<button
				class="btn-icon title-btn"
				title="设置"
				@click="ui.openSettings()"
			>
				<Icon name="settings" :size="15" />
			</button>
		</div>
	</div>
</template>

<style scoped>
.titlebar {
	position: relative;
}
.title-center {
	position: absolute;
	left: 50%;
	top: 50%;
	transform: translate(-50%, -50%);
	display: flex;
	align-items: center;
	gap: 8px;
	max-width: 64%;
	min-width: 0;
	white-space: nowrap;
}
.title-name {
	flex: none;
	font-size: 13.5px;
	font-weight: 600;
	color: var(--text-strong);
	white-space: nowrap;
}
.title-path {
	font-size: 11px;
	color: var(--text-faint);
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
	min-width: 0;
}
.title-chips {
	display: inline-flex;
	gap: 5px;
	flex: none;
}
.title-actions {
	position: absolute;
	right: 12px;
	/* 与 .title-center 同一水平中心线，保证和路径/分支等内容垂直居中对齐 */
	top: 50%;
	transform: translateY(-50%);
	display: flex;
	align-items: center;
	gap: 4px;
}
.title-btn {
	width: 24px;
	height: 24px;
	border-radius: 6px;
}
</style>
