<script setup lang="ts">
// 设置 · 外观：主题色（应用主色调）+ 亮色/暗色/跟随系统（应用颜色）。
import { useSettings, ACCENT_PRESETS } from "../../stores/settings";
import Icon from "../ui/Icon.vue";

const settings = useSettings();
</script>

<template>
	<div>
		<section class="group">
			<h3 class="group-title">主题色</h3>
			<p class="group-desc">应用的主色调，与亮色 / 暗色外观相互独立。</p>
			<div class="swatches">
				<button
					v-for="a in ACCENT_PRESETS"
					:key="a.key"
					class="swatch"
					:class="{ active: settings.accent === a.key }"
					:style="{ '--swatch': a.color }"
					:title="a.label"
					@click="settings.setAccent(a.key)"
				>
					<Icon v-if="settings.accent === a.key" name="check" :size="11" />
				</button>
			</div>
		</section>

		<section class="group">
			<h3 class="group-title">外观模式</h3>
			<p class="group-desc">应用的整体配色（界面背景、文字颜色）。</p>
			<div class="mode-group">
				<button
					class="mode-btn"
					:class="{ active: settings.appearance === 'light' }"
					@click="settings.setAppearance('light')"
				>
					亮色
				</button>
				<button
					class="mode-btn"
					:class="{ active: settings.appearance === 'dark' }"
					@click="settings.setAppearance('dark')"
				>
					暗色
				</button>
				<button
					class="mode-btn"
					:class="{ active: settings.appearance === 'system' }"
					@click="settings.setAppearance('system')"
				>
					跟随系统
				</button>
			</div>
		</section>
	</div>
</template>

<style scoped>
/* 版式（无卡片 + 分割线）由 SettingsPanel 统一提供 */

/* 主题色色板 */
.swatches {
	display: flex;
	flex-wrap: wrap;
	gap: 8px;
}
.swatch {
	width: 22px;
	height: 22px;
	border-radius: 50%;
	background: var(--swatch);
	border: 2px solid transparent;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	color: #fff;
	transition:
		transform 0.12s ease,
		box-shadow 0.12s ease;
}
.swatch:hover {
	transform: scale(1.1);
}
.swatch.active {
	box-shadow:
		0 0 0 2px var(--bg-panel),
		0 0 0 4px var(--swatch);
}

/* 外观模式：整体一个按钮组，中间用分隔线分割，选中项有独立样式 */
.mode-group {
	display: inline-flex;
	border: 1px solid var(--border-strong);
	border-radius: 8px;
	overflow: hidden;
	background: var(--bg-input);
}
.mode-btn {
	height: 30px;
	padding: 0 18px;
	background: transparent;
	color: var(--text-dim);
	font-size: 12.5px;
}
.mode-btn + .mode-btn {
	border-left: 1px solid var(--border);
}
.mode-btn:hover {
	color: var(--text-strong);
}
.mode-btn.active {
	background: var(--accent);
	color: #fff;
	font-weight: 600;
}
.mode-btn.active:hover {
	color: #fff;
}
</style>
