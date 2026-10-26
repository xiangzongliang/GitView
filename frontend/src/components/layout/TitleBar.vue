<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { Window } from "@wailsio/runtime";
import { useRepos } from "../../stores/repos";
import { useRepo } from "../../stores/repo";
import { useUI } from "../../stores/ui";
import { useSettings } from "../../stores/settings";
import RefChips from "../common/RefChips.vue";
import Icon from "../ui/Icon.vue";
import Tooltip from "../ui/Tooltip.vue";
import type { RefDecoration } from "../../api";

const repos = useRepos();
const repo = useRepo();
const ui = useUI();
const settings = useSettings();

const name = computed(() => repos.active?.name || "");
const path = computed(() => repo.path || "");

// Windows 下为无边框窗口：标题块移入顶部导航（Toolbar），本栏右侧自绘
// 最小化/最大化/关闭按钮；macOS 保持红绿灯 + 居中标题样式。
const alignLeft = navigator.userAgent.includes("Windows");
const maximised = ref(false);
async function refreshMaximised() {
	if (!alignLeft) return;
	try {
		maximised.value = await Window.IsMaximised();
	} catch {
		/* runtime 未就绪时忽略 */
	}
}
function minimise() {
	Window.Minimise();
}
function toggleMaximise() {
	Window.ToggleMaximise();
}
function closeWindow() {
	Window.Close();
}
onMounted(() => {
	if (!alignLeft) return;
	void refreshMaximised();
	window.addEventListener("resize", refreshMaximised);
});
onBeforeUnmount(() => {
	if (!alignLeft) return;
	window.removeEventListener("resize", refreshMaximised);
});

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
	<!-- 整条标题栏都可拖动窗口：
	     顶部 24px 由 macOS 原生拖拽区接管（main.go 的 InvisibleTitleBarHeight），
	     其余部分由下面这个 Wails v3 标记驱动（runtime 读取该 CSS 自定义属性）。
	     该属性会继承，所以交互控件需用 no-drag 显式退出，见 <style> 部分。 -->
	<div class="titlebar" style="--wails-draggable: drag">
		<!-- 绝对定位垂直居中：基于整个标题栏块居中，不受左侧红绿灯 padding 影响 -->
		<!-- Windows：标题块靠左（顶部左侧显示项目名/路径）；macOS 居中避开红绿灯 -->
		<div class="title-center" :class="{ 'align-left': alignLeft }">
			<span class="title-name">{{ name || "Git View" }}</span>
			<span v-if="path" class="title-path" :title="path">{{ path }}</span>
			<span class="title-chips">
				<RefChips :refs="branchChips" />
			</span>
		</div>

		<!-- 标题行右侧操作区：与项目名/路径/分支同一行垂直居中对齐 -->
		<div class="title-actions">
			<Tooltip :text="dark ? '切换到亮色' : '切换到暗色'">
				<button
					class="btn-icon title-btn"
					@click="settings.toggleLightDark()"
				>
					<Icon :name="dark ? 'sun' : 'moon'" :size="15" />
				</button>
			</Tooltip>
			<Tooltip text="设置">
				<button class="btn-icon title-btn" @click="ui.openSettings()">
					<Icon name="settings" :size="15" />
				</button>
			</Tooltip>
			<!-- Windows 无边框窗口：窗口控制按钮（紧随主题/设置之后） -->
			<template v-if="alignLeft">
				<div class="sep" />
				<Tooltip text="最小化">
					<button class="btn-icon title-btn" @click="minimise()">
						<Icon name="minus" :size="15" />
					</button>
				</Tooltip>
				<Tooltip :text="maximised ? '还原' : '最大化'">
					<button class="btn-icon title-btn" @click="toggleMaximise()">
						<Icon name="maximize-2" :size="13" />
					</button>
				</Tooltip>
				<Tooltip text="关闭">
					<button
						class="btn-icon title-btn close-btn"
						@click="closeWindow()"
					>
						<Icon name="x" :size="15" />
					</button>
				</Tooltip>
			</template>
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
/* Windows 无边框窗口：窗口控制按钮与主题/设置之间的分隔线 */
.title-actions .sep {
	width: 1px;
	height: 16px;
	background: var(--border-strong);
	margin: 0 4px;
	flex: none;
}
.close-btn:hover {
	background: #e81123;
	color: #fff;
}
/* Windows：无红绿灯按钮，标题块靠左，右边距与右侧按钮区（right: 18px）对称 */
.title-center.align-left {
	left: 18px;
	transform: translateY(-50%);
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
/* 交互控件退出拖拽：--wails-draggable 会继承给子元素，
   chip 可点击复制分支名、右侧按钮可点击，都不能触发窗口拖动 */
.title-chips {
	display: inline-flex;
	gap: 5px;
	flex: none;
	--wails-draggable: no-drag;
}
.title-actions {
	--wails-draggable: no-drag;
	position: absolute;
	right: 18px;
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
