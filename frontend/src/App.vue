<script setup lang="ts">
import { onBeforeUnmount, onMounted, watch } from "vue";
import { useRepos } from "./stores/repos";
import { useRepo } from "./stores/repo";
import { useUI } from "./stores/ui";
import { useSettings } from "./stores/settings";
import { REPO_CHANGED_EVENT } from "./api";
import type { RepoChange } from "./api";
import { Events } from "@wailsio/runtime";
import TitleBar from "./components/layout/TitleBar.vue";
import Toolbar from "./components/layout/Toolbar.vue";
import StatusBar from "./components/layout/StatusBar.vue";
import TerminalPanel from "./components/layout/TerminalPanel.vue";
import Sidebar from "./components/sidebar/Sidebar.vue";
import HistoryView from "./components/history/HistoryView.vue";
import StatusView from "./components/status/StatusView.vue";
import WelcomeView from "./components/WelcomeView.vue";
import Toasts from "./components/common/Toasts.vue";
import ContextMenu from "./components/common/ContextMenu.vue";
import DialogHost from "./components/dialogs/DialogHost.vue";
import OpBanner from "./components/common/OpBanner.vue";
import SettingsPanel from "./components/settings/SettingsPanel.vue";
import DebugPanel from "./components/common/DebugPanel.vue";

const repos = useRepos();
const repo = useRepo();
const ui = useUI();
const settings = useSettings();

onMounted(() => {
	settings.init();
	repos.load();
});

// 仓库变化全部由后端 fsnotify 推送的 repo:changed 事件驱动（见 watcher.go），
// 这里不再做后台轮询：git 命令只在用户操作、监听事件或窗口重新可见时执行。

// 后端监听到仓库变化 → 按变更类型刷新对应数据（kind: status / refs / all）
function applyRepoChange(kind: string) {
	// 窗口不可见、有操作在执行或弹窗打开时不处理：操作自身会刷新，
	// 回到前台时由 visibilitychange 统一补一次。
	if (document.hidden || ui.busy || ui.dialog) return;
	repo.refreshStatus();
	if (kind === "refs" || kind === "all") {
		repo.refreshRefs();
		repo.refreshStashes();
	}
}

let offRepoChanged: (() => void) | undefined;
function onRepoChanged(ev: { data?: unknown }) {
	const data = (ev.data || {}) as RepoChange;
	if (data.repoPath && data.repoPath !== repo.path) return;
	applyRepoChange(data.kind || "status");
}
function onVisibilityChange() {
	if (!document.hidden) applyRepoChange("all");
}
onMounted(() => {
	offRepoChanged = Events.On(REPO_CHANGED_EVENT, onRepoChanged);
	document.addEventListener("visibilitychange", onVisibilityChange);
});
onBeforeUnmount(() => {
	offRepoChanged?.();
	document.removeEventListener("visibilitychange", onVisibilityChange);
});

// 全局快捷键：⌃` 开关内置终端
function onGlobalKey(e: KeyboardEvent) {
	if (e.ctrlKey && e.key === "`") {
		e.preventDefault();
		ui.toggleTerminal();
	}
}
onMounted(() => window.addEventListener("keydown", onGlobalKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onGlobalKey));

function switchRepo(path: string) {
	if (path === repo.path) return;
	repo.attach(path);
}

// ------------------------------------------------- sidebar resize (drag divider)
function startSidebarDrag(e: MouseEvent) {
	e.preventDefault();
	const startX = e.clientX;
	const startW = ui.sidebarWidth;
	const move = (ev: MouseEvent) => {
		ui.setSidebarWidth(startW + (ev.clientX - startX));
	};
	const up = () => {
		document.removeEventListener("mousemove", move);
		document.removeEventListener("mouseup", up);
		document.body.style.cursor = "";
		document.body.style.userSelect = "";
	};
	document.addEventListener("mousemove", move);
	document.addEventListener("mouseup", up);
	document.body.style.cursor = "col-resize";
	document.body.style.userSelect = "none";
}

// repos store changes activePath; keep repo store attached
watch(
	() => repos.activePath,
	(p) => {
		if (p) switchRepo(p);
		else if (repo.path) {
			repo.unwatch();
			repo.$reset();
		}
	},
	{ immediate: true },
);

// 退出时停止后端监听
onBeforeUnmount(() => repo.unwatch());
</script>

<template>
	<div class="app">
		<TitleBar />
		<Toolbar />
		<OpBanner v-if="repo.opInProgress" />
		<div class="main" :style="{ '--sidebar-w': ui.sidebarWidth + 'px' }">
			<Sidebar />
			<div
				class="sidebar-resizer"
				title="拖动调整侧边栏宽度（200px ~ 40%）"
				@mousedown="startSidebarDrag"
			/>
			<div class="content">
				<WelcomeView v-if="!repos.activePath" />
				<template v-else>
					<HistoryView v-if="repo.view === 'history'" />
					<StatusView v-else />
				</template>
			</div>
		</div>
		<TerminalPanel v-if="repos.activePath" />
		<StatusBar />
		<SettingsPanel />
		<DebugPanel />
		<Toasts />
		<ContextMenu />
		<DialogHost />
	</div>
</template>

<style scoped>
.sidebar-resizer {
	flex: none;
	width: 5px;
	margin: 0 -2px;
	cursor: col-resize;
	z-index: 20;
	position: relative;
}
.sidebar-resizer::after {
	content: "";
	position: absolute;
	left: 2px;
	top: 0;
	bottom: 0;
	width: 1px;
	background: var(--border);
}
.sidebar-resizer:hover::after,
.sidebar-resizer:active::after {
	background: var(--accent);
	width: 2px;
}
</style>
