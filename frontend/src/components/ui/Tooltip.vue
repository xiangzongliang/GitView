<script setup lang="ts">
// Reusable hover tooltip. Wraps any content (usually an icon-only button) and
// shows a small floating label after a short delay. The bubble is teleported
// to <body> so it is never clipped by overflow:hidden containers.
import { onBeforeUnmount, ref } from "vue";

const props = withDefaults(
	defineProps<{
		text: string;
		/** preferred side; falls back to the opposite when out of viewport */
		position?: "top" | "bottom";
		/** hover delay in ms */
		delay?: number;
	}>(),
	{ position: "bottom", delay: 350 },
);

const host = ref<HTMLElement | null>(null);
const bubble = ref<HTMLElement | null>(null);
const visible = ref(false);
const pos = ref<Record<string, string>>({});
let timer: ReturnType<typeof setTimeout> | null = null;

function clearTimer() {
	if (timer) {
		clearTimeout(timer);
		timer = null;
	}
}

function place() {
	const el = host.value;
	if (!el) return;
	const r = el.getBoundingClientRect();
	const bubbleH = bubble.value?.offsetHeight || 24;
	const wantTop = props.position === "top";
	// flip when there is not enough room on the preferred side
	const spaceBelow = window.innerHeight - r.bottom;
	const spaceAbove = r.top;
	const useTop = wantTop
		? spaceAbove > bubbleH + 8
		: spaceBelow < bubbleH + 8 && spaceAbove > bubbleH + 8;
	const top = useTop ? r.top - 6 : r.bottom + 6;
	// keep the bubble inside the viewport horizontally
	const bubbleW = bubble.value?.offsetWidth || 0;
	let left = r.left + r.width / 2;
	left = Math.max(
		bubbleW / 2 + 6,
		Math.min(left, window.innerWidth - bubbleW / 2 - 6),
	);
	pos.value = {
		left: left + "px",
		top: top + "px",
		transform: useTop ? "translate(-50%, -100%)" : "translate(-50%, 0)",
	};
}

function show() {
	clearTimer();
	timer = setTimeout(() => {
		visible.value = true;
		// measure after render, then position
		requestAnimationFrame(place);
	}, props.delay);
}

function hide() {
	clearTimer();
	visible.value = false;
}

onBeforeUnmount(() => {
	clearTimer();
	window.removeEventListener("scroll", hide, true);
});

function onEnter() {
	window.addEventListener("scroll", hide, true);
	show();
}
function onLeave() {
	window.removeEventListener("scroll", hide, true);
	hide();
}
</script>

<template>
	<span
		ref="host"
		class="tooltip-host"
		@mouseenter="onEnter"
		@mouseleave="onLeave"
		@mousedown="hide"
	>
		<slot />
		<Teleport to="body">
			<div
				v-if="visible"
				ref="bubble"
				class="tooltip-bubble"
				:style="pos"
				role="tooltip"
			>
				{{ text }}
			</div>
		</Teleport>
	</span>
</template>

<style scoped>
.tooltip-host {
	display: inline-flex;
}
.tooltip-bubble {
	position: fixed;
	z-index: 2000;
	max-width: 300px;
	padding: 4px 8px;
	border-radius: 6px;
	background: var(--tooltip-bg);
	border: 1px solid var(--border-strong);
	box-shadow: 0 6px 20px rgba(0, 0, 0, 0.55);
	color: var(--text-strong);
	font-size: 11.5px;
	line-height: 1.4;
	/* 短文本保持单行；过长内容（如分支全名）在 max-width 内自动换行 */
	white-space: pre-wrap;
	overflow-wrap: anywhere;
	pointer-events: none;
	/* 只做淡入：transform 被用于定位，不能用动画覆盖 */
	animation: tip-in 0.1s ease-out;
}
@keyframes tip-in {
	from {
		opacity: 0;
	}
}
</style>
