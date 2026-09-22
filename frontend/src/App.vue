<script setup lang="ts">
import { onBeforeUnmount, onMounted, watch } from "vue";
import { useRepos } from "./stores/repos";
import { useRepo } from "./stores/repo";
import { useUI } from "./stores/ui";
import { useSettings } from "./stores/settings";
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

const repos = useRepos();
const repo = useRepo();
const ui = useUI();
const settings = useSettings();

onMounted(() => {
	settings.init();
	repos.load();
});

// 轻量轮询：窗口可见且无操作进行时，定期刷新状态（外部变更可自动反映到 UI）
let pollTimer: number | undefined;
let pollTick = 0;
onMounted(() => {
	pollTimer = window.setInterval(() => {
		if (document.hidden || ui.opRunning || !repos.activePath || ui.dialog)
			return;
		pollTick++;
		repo.refreshStatus();
		if (pollTick % 3 === 0) {
			repo.refreshRefs();
			repo.refreshStashes();
		}
	}, 4000);
});
onBeforeUnmount(() => {
	if (pollTimer) window.clearInterval(pollTimer);
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
		else if (repo.path) repo.$reset();
	},
	{ immediate: true },
);
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
		<Toasts />
		<ContextMenu />
		<DialogHost />
		<div v-if="ui.opRunning" class="op-overlay">
			<div class="op-overlay-box">
				<span class="spinner" />
				<span>{{ ui.opRunning }}</span>
			</div>
		</div>
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
.op-overlay {
	position: fixed;
	inset: 0;
	background: var(--overlay-bg);
	display: flex;
	align-items: center;
	justify-content: center;
	z-index: 900;
}
.op-overlay-box {
	display: flex;
	align-items: center;
	gap: 10px;
	background: var(--bg-panel-2);
	border: 1px solid var(--border-strong);
	border-radius: 10px;
	padding: 14px 22px;
	color: var(--text-strong);
	box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
}
.spinner {
	width: 16px;
	height: 16px;
	border: 2px solid var(--border-strong);
	border-top-color: var(--accent);
	border-radius: 50%;
	animation: spin 0.8s linear infinite;
}
</style>
