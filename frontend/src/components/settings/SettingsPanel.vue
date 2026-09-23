<script setup lang="ts">
// 设置面板：从右侧滑入的独立抽屉（非弹窗）。左侧导航切换功能页，
// 每个功能页实现位于同目录下的独立组件中：
//   - AppearanceSettings.vue  外观（主题色 + 亮/暗/跟随系统）
//   - GitConfigSettings.vue   Git 配置（全局 git config）
//   - AiModelsSettings.vue    AI 模型（Base URL / API Key）
//   - AboutSettings.vue       关于（版本信息 + 软件更新）
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useUI } from "../../stores/ui";
import Icon from "../ui/Icon.vue";
import AppearanceSettings from "./AppearanceSettings.vue";
import GitConfigSettings from "./GitConfigSettings.vue";
import AiModelsSettings from "./AiModelsSettings.vue";
import AboutSettings from "./AboutSettings.vue";

const ui = useUI();

type Tab = "appearance" | "gitconfig" | "aimodels" | "about";
const tab = ref<Tab>("appearance");

const TABS: { key: Tab; label: string; icon: string }[] = [
	{ key: "appearance", label: "外观", icon: "refresh" },
	{ key: "gitconfig", label: "Git 配置", icon: "branch" },
	{ key: "aimodels", label: "AI 模型", icon: "sparkles" },
	{ key: "about", label: "关于", icon: "info" },
];

// ------------------------------------------------------- 抽屉宽度（拖拽调整）
const WIDTH_KEY = "gv.settingsW";
const MIN_W = 400; // 最小宽度
const MAX_RATIO = 0.8; // 最大宽度：视口的 80%

const viewportW = ref(window.innerWidth);
const rawW = ref(Number(localStorage.getItem(WIDTH_KEY)) || 620);

function maxW() {
	return Math.round(viewportW.value * MAX_RATIO);
}
/** 最小 400px，最大 80% 视口宽度；视口过窄时以视口为准。 */
function clampW(w: number) {
	return Math.min(Math.max(MIN_W, w), maxW());
}
const panelW = computed(() => clampW(rawW.value));

function onViewportResize() {
	viewportW.value = window.innerWidth;
}

function startResize(e: MouseEvent) {
	e.preventDefault();
	const startX = e.clientX;
	const startW = panelW.value;
	const move = (ev: MouseEvent) => {
		// 向左拖动（clientX 变小）时抽屉变宽
		rawW.value = clampW(startW + (startX - ev.clientX));
	};
	const up = () => {
		document.removeEventListener("mousemove", move);
		document.removeEventListener("mouseup", up);
		document.body.style.cursor = "";
		document.body.style.userSelect = "";
		try {
			localStorage.setItem(WIDTH_KEY, String(rawW.value));
		} catch {
			/* ignore */
		}
	};
	document.addEventListener("mousemove", move);
	document.addEventListener("mouseup", up);
	document.body.style.cursor = "col-resize";
	document.body.style.userSelect = "none";
}

function onKey(e: KeyboardEvent) {
	if (e.key === "Escape" && ui.settingsOpen) {
		e.stopPropagation();
		ui.closeSettings();
	}
}
onMounted(() => {
	window.addEventListener("resize", onViewportResize);
	document.addEventListener("keydown", onKey);
});
onBeforeUnmount(() => {
	window.removeEventListener("resize", onViewportResize);
	document.removeEventListener("keydown", onKey);
});
</script>

<template>
	<Teleport to="body">
		<Transition name="settings">
			<div v-if="ui.settingsOpen" class="settings-root">
				<div class="settings-scrim" @click="ui.closeSettings()" />
				<div class="settings-panel" :style="{ width: panelW + 'px' }">
					<div
						class="settings-resizer"
						title="拖动调整宽度（最大 80%）"
						@mousedown="startResize"
					/>
					<header class="settings-head">
						<span class="settings-title">
							<Icon name="settings" :size="14" />
							设置
						</span>
						<button
							class="btn-icon"
							title="关闭设置"
							@click="ui.closeSettings()"
						>
							<Icon name="x" :size="14" />
						</button>
					</header>

					<div class="settings-body">
						<nav class="settings-nav">
							<button
								v-for="t in TABS"
								:key="t.key"
								class="nav-item"
								:class="{ active: tab === t.key }"
								@click="tab = t.key"
							>
								<Icon :name="t.icon" :size="14" />
								{{ t.label }}
							</button>
						</nav>

						<section class="settings-content">
							<AppearanceSettings v-if="tab === 'appearance'" />
							<GitConfigSettings v-else-if="tab === 'gitconfig'" />
							<AiModelsSettings v-else-if="tab === 'aimodels'" />
							<AboutSettings v-else />
						</section>
					</div>
				</div>
			</div>
		</Transition>
	</Teleport>
</template>

<style scoped>
.settings-root {
	position: fixed;
	inset: 0;
	z-index: 1200;
	display: flex;
	justify-content: flex-end;
}
.settings-scrim {
	position: absolute;
	inset: 0;
	background: var(--overlay-bg);
}
.settings-panel {
	position: relative;
	height: 100%;
	display: flex;
	flex-direction: column;
	background: var(--bg-panel);
	border-left: 1px solid var(--border-strong);
	box-shadow: var(--shadow-panel);
}
/* 左边缘拖拽把手：调整抽屉宽度（宽度由 :style 内联控制） */
.settings-resizer {
	position: absolute;
	left: 0;
	top: 0;
	bottom: 0;
	width: 8px;
	cursor: col-resize;
	z-index: 2;
}
.settings-resizer::after {
	content: "";
	position: absolute;
	left: 0;
	top: 0;
	bottom: 0;
	width: 1px;
	background: transparent;
	transition:
		background 0.12s ease,
		width 0.12s ease;
}
.settings-resizer:hover::after,
.settings-resizer:active::after {
	background: var(--accent);
	width: 2px;
}

/* slide-in / out */
.settings-enter-active,
.settings-leave-active {
	transition: opacity 0.18s ease;
}
.settings-enter-active .settings-panel,
.settings-leave-active .settings-panel {
	transition: transform 0.22s cubic-bezier(0.2, 0.7, 0.3, 1);
}
.settings-enter-from,
.settings-leave-to {
	opacity: 0;
}
.settings-enter-from .settings-panel,
.settings-leave-to .settings-panel {
	transform: translateX(40px);
}

.settings-head {
	flex: none;
	display: flex;
	align-items: center;
	justify-content: space-between;
	height: 40px;
	padding: 0 8px 0 14px;
	border-bottom: 1px solid var(--border);
}
.settings-title {
	display: inline-flex;
	align-items: center;
	gap: 7px;
	font-size: 13px;
	font-weight: 600;
	color: var(--text-strong);
}

.settings-body {
	flex: 1;
	min-height: 0;
	display: flex;
}
.settings-nav {
	flex: none;
	width: 148px;
	padding: 12px 10px;
	border-right: 1px solid var(--border);
	display: flex;
	flex-direction: column;
	gap: 3px;
	background: var(--bg-sidebar);
}
.nav-item {
	display: flex;
	align-items: center;
	gap: 8px;
	height: 32px;
	padding: 0 10px;
	border-radius: 7px;
	font-size: 12.5px;
	color: var(--text-dim);
	text-align: left;
	transition:
		background 0.12s ease,
		color 0.12s ease;
}
.nav-item:hover {
	background: var(--bg-hover);
	color: var(--text-strong);
}
/* 选中项用背景色标记（不用左侧竖线） */
.nav-item.active {
	background: var(--bg-selected);
	color: var(--text-strong);
	font-weight: 600;
}

.settings-content {
	flex: 1;
	min-width: 0;
	overflow-y: auto;
	padding: 18px 22px 24px;
}

/* 设置页通用版式：无卡片，整页平铺，模块之间用分割线分割。
   各功能页（外观 / Git 配置 / AI 模型 / 关于）共用这组类名。 */
.settings-content :deep(.group) {
	padding-bottom: 18px;
}
.settings-content :deep(.group + .group) {
	padding-top: 18px;
	border-top: 1px solid var(--border);
}
.settings-content :deep(.group:last-child) {
	padding-bottom: 0;
}
.settings-content :deep(.group-title) {
	font-size: 13px;
	font-weight: 600;
	color: var(--text-strong);
	margin-bottom: 3px;
}
.settings-content :deep(.group-desc) {
	font-size: 11.5px;
	color: var(--text-faint);
	margin-bottom: 12px;
}
</style>
