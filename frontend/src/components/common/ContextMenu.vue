<script setup lang="ts">
import {
	computed,
	ref,
	watch,
	nextTick,
	onMounted,
	onBeforeUnmount,
} from "vue";
import { useUI } from "../../stores/ui";
import Icon from "../ui/Icon.vue";

const ui = useUI();
const el = ref<HTMLElement | null>(null);
const pos = ref({ x: 0, y: 0 });

const style = computed(() => ({
	left: pos.value.x + "px",
	top: pos.value.y + "px",
}));

watch(
	() => ui.menu,
	async (m) => {
		if (!m) return;
		pos.value = { x: m.x, y: m.y };
		await nextTick();
		// keep inside viewport
		const rect = el.value?.getBoundingClientRect();
		if (!rect) return;
		let { x, y } = pos.value;
		if (x + rect.width > window.innerWidth - 8)
			x = window.innerWidth - rect.width - 8;
		if (y + rect.height > window.innerHeight - 8)
			y = window.innerHeight - rect.height - 8;
		pos.value = { x: Math.max(4, x), y: Math.max(4, y) };
	},
);

function onDocDown(e: MouseEvent) {
	if (ui.menu && el.value && !el.value.contains(e.target as Node))
		ui.closeMenu();
}
function onKey(e: KeyboardEvent) {
	if (e.key === "Escape") ui.closeMenu();
}
onMounted(() => {
	document.addEventListener("mousedown", onDocDown, true);
	document.addEventListener("keydown", onKey);
});
onBeforeUnmount(() => {
	document.removeEventListener("mousedown", onDocDown, true);
	document.removeEventListener("keydown", onKey);
});

function click(action?: () => void) {
	ui.closeMenu();
	if (action) action();
}
</script>

<template>
	<Teleport to="body">
		<div v-if="ui.menu" ref="el" class="ctx-menu" :style="style">
			<template v-for="(item, i) in ui.menu.items" :key="i">
				<div v-if="item.separator" class="ctx-sep" />
				<button
					v-else
					class="ctx-item"
					:class="{ danger: item.danger }"
					:disabled="item.disabled"
					@click="click(item.action)"
				>
					<Icon
						v-if="item.icon"
						:name="item.icon"
						:size="13"
						class="ctx-icon"
					/>
					<span class="ctx-label">{{ item.label }}</span>
					<Icon
						v-if="item.checked"
						name="check"
						:size="12"
						class="ctx-check"
					/>
				</button>
			</template>
		</div>
	</Teleport>
</template>

<style scoped>
.ctx-menu {
	position: fixed;
	z-index: 1100;
	min-width: 230px;
	max-width: min(420px, calc(100vw - 16px));
	background: var(--menu-bg);
	border: 1px solid var(--border-strong);
	border-radius: 8px;
	padding: 4px;
	box-shadow: 0 10px 34px rgba(0, 0, 0, 0.55);
	transform-origin: top left;
	animation: ctx-in 0.13s ease-out;
}
@keyframes ctx-in {
	from {
		opacity: 0;
		transform: scale(0.96) translateY(-4px);
	}
}
.ctx-item {
	display: flex;
	align-items: center;
	gap: 8px;
	width: 100%;
	padding: 6px 9px;
	border-radius: 5px;
	color: var(--text);
	text-align: left;
	font-size: 12.5px;
}
.ctx-item:hover:not(:disabled) {
	background: var(--accent);
	color: #fff;
}
.ctx-item:disabled {
	opacity: 0.4;
}
.ctx-item.danger:hover:not(:disabled) {
	background: var(--red);
}
.ctx-icon {
	flex: none;
	opacity: 0.85;
}
.ctx-label {
	flex: 1;
	white-space: normal;
	word-break: break-word;
	line-height: 1.45;
}
.ctx-check {
	flex: none;
}
.ctx-sep {
	height: 1px;
	background: var(--border);
	margin: 4px 6px;
}
</style>
