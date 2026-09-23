<script setup lang="ts">
import { useRepos } from "../stores/repos";
import { useUI } from "../stores/ui";
import { pickDirectory } from "../api";
import Icon from "./ui/Icon.vue";

const repos = useRepos();
const ui = useUI();

async function initRepo() {
	const dir = await pickDirectory("选择用于初始化 Git 仓库的目录");
	if (dir) await repos.initRepo(dir);
}
</script>

<template>
	<div class="welcome">
		<div class="logo">
			<Icon name="repo" :size="42" />
		</div>
		<h1 class="title">Git View</h1>
		<p class="subtitle">
			轻量级 Git 可视化客户端 — 打开一个本地仓库开始使用
		</p>
		<div class="actions">
			<button class="btn btn-primary big" @click="repos.pickAndOpen()">
				<Icon name="folder" :size="15" /> 打开本地仓库…
			</button>
			<button class="btn big" @click="ui.openDialog('clone')">
				<Icon name="cloud" :size="15" /> 克隆远程仓库…
			</button>
			<button class="btn big" @click="initRepo">
				<Icon name="plus" :size="15" /> 初始化新仓库…
			</button>
		</div>
		<p v-if="repos.entries.length" class="hint">
			或从左侧列表选择最近打开的仓库
		</p>
	</div>
</template>

<style scoped>
.welcome {
	flex: 1;
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	gap: 12px;
	padding: 40px;
	background: var(--bg-app);
}
.logo {
	width: 76px;
	height: 76px;
	border-radius: 20px;
	display: flex;
	align-items: center;
	justify-content: center;
	color: var(--accent);
	background: linear-gradient(
		160deg,
		var(--welcome-grad-a),
		var(--welcome-grad-b)
	);
	border: 1px solid var(--border-strong);
	box-shadow: var(--shadow-logo);
	margin-bottom: 6px;
}
.title {
	font-size: 24px;
	font-weight: 700;
	color: var(--text-strong);
	letter-spacing: 0.01em;
}
.subtitle {
	font-size: 13px;
	color: var(--text-dim);
	margin-bottom: 14px;
}
.actions {
	display: flex;
	flex-direction: column;
	gap: 10px;
	width: 280px;
}
.btn.big {
	height: 36px;
	font-size: 13px;
	justify-content: flex-start;
	padding: 0 14px;
}
.hint {
	margin-top: 18px;
	font-size: 11.5px;
	color: var(--text-faint);
}
</style>
