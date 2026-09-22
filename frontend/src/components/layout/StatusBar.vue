<script setup lang="ts">
import { computed } from "vue";
import { useRepo } from "../../stores/repo";
import { useUI } from "../../stores/ui";
import Icon from "../ui/Icon.vue";

const repo = useRepo();
const ui = useUI();

const st = computed(() => repo.status);
</script>

<template>
	<div class="statusbar">
		<span v-if="repo.path" class="sb-path mono" :title="repo.path">{{
			repo.path
		}}</span>
		<span v-else>未打开仓库</span>

		<div class="spacer" />

		<span v-if="ui.opRunning" class="sb-op">
			<span class="spinner" />
			{{ ui.opRunning }}
		</span>
		<span
			v-if="repo.statusError"
			class="sb-error"
			:title="repo.statusError"
		>
			<Icon name="alert" :size="11" />
			{{ repo.statusError }}
		</span>

		<template v-if="st">
			<span
				class="sb-item"
				:title="
					'当前分支：' +
					st.branch +
					(st.detached ? '（分离头指针）' : '')
				"
			>
				<Icon name="branch" :size="11" />
				{{ st.branch || "（无提交）" }}
			</span>
			<span v-if="st.upstream" class="sb-item" title="上游分支">
				<Icon name="cloud" :size="11" />
				{{ st.upstream }}
			</span>
			<span
				v-if="st.ahead > 0"
				class="sb-item green"
				title="领先上游的提交数"
				>↑ {{ st.ahead }}</span
			>
			<span
				v-if="st.behind > 0"
				class="sb-item yellow"
				title="落后上游的提交数"
				>↓ {{ st.behind }}</span
			>
			<span
				v-if="repo.stashes.length > 0"
				class="sb-item"
				title="Stash 数量"
			>
				<Icon name="stash" :size="11" />
				{{ repo.stashes.length }}
			</span>
			<span
				v-if="repo.dirtyCount > 0"
				class="sb-item"
				title="未提交的更改"
			>
				<Icon name="edit" :size="11" />
				{{ repo.dirtyCount }}
			</span>
		</template>

		<!-- 调试模式：点击后在右下角显示 git 命令日志窗口 -->
		<button
			class="sb-debug"
			:class="{ active: ui.debugOpen }"
			:title="
				ui.debugOpen
					? '关闭调试窗口'
					: '调试模式：查看 git 执行的命令与日志'
			"
			@click="ui.toggleDebug()"
		>
			<Icon name="bug" :size="11" />
			调试
		</button>
	</div>
</template>

<style scoped>
.sb-path {
	overflow: hidden;
	text-overflow: ellipsis;
	min-width: 0;
	max-width: 45%;
}
.spacer {
	flex: 1;
}
.sb-item {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	flex: none;
}
.sb-op {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	color: var(--accent);
	flex: none;
}
.sb-error {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	color: var(--red);
	max-width: 320px;
	overflow: hidden;
	text-overflow: ellipsis;
	flex: none;
}
.spinner {
	width: 10px;
	height: 10px;
	border: 2px solid var(--border-strong);
	border-top-color: var(--accent);
	border-radius: 50%;
	animation: spin 0.8s linear infinite;
}
.sb-debug {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	flex: none;
	height: 18px;
	padding: 0 7px;
	border-radius: 5px;
	font-size: 11px;
	color: var(--text-dim);
}
.sb-debug:hover {
	background: var(--bg-hover);
	color: var(--text-strong);
}
.sb-debug.active {
	background: var(--bg-selected);
	color: var(--accent);
}
</style>
