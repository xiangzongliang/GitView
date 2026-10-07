<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, reactive } from "vue";
import Icon from "./Icon.vue";

const props = withDefaults(
	defineProps<{
		title: string;
		width?: number;
		height?: number;
		draggable?: boolean;
		resizable?: boolean;
	}>(),
	{ width: 460, height: 0, draggable: false, resizable: false },
);
const emit = defineEmits<{ (e: "close"): void }>();

// ---- keyboard ----
function onKey(e: KeyboardEvent) {
	if (e.key === "Escape") {
		e.stopPropagation();
		emit("close");
	}
}
onMounted(() => document.addEventListener("keydown", onKey, true));
onBeforeUnmount(() => document.removeEventListener("keydown", onKey, true));

// ---- drag & resize (only when draggable or resizable) ----
const interactive = computed(() => props.draggable || props.resizable);
const panelRef = ref<HTMLElement | null>(null);

// 面板定位：初始化时居中，拖拽 / 调整大小后使用 fixed 定位
const panelPos = reactive({ x: 0, y: 0 });
const panelW = ref(0);
const panelH = ref(0);

const MIN_W = 360;
const MIN_H = 220;

function initPos() {
	panelPos.x = Math.max(
		24,
		Math.round((window.innerWidth - props.width) / 2),
	);
	panelPos.y = Math.max(20, Math.round(window.innerHeight * 0.08));
	panelW.value = props.width;
	panelH.value = props.height || 0;
}
onMounted(initPos);

// ---- maximize / restore ----
const maximized = ref(false);
// 保存最大化前的位置和大小
const savedPos = reactive({ x: 0, y: 0, w: 0, h: 0 });

function toggleMaximize() {
	if (!props.resizable) return;
	if (maximized.value) {
		// 还原
		panelPos.x = savedPos.x;
		panelPos.y = savedPos.y;
		panelW.value = savedPos.w;
		panelH.value = savedPos.h;
		maximized.value = false;
	} else {
		// 保存当前状态后最大化
		savedPos.x = panelPos.x;
		savedPos.y = panelPos.y;
		savedPos.w = panelW.value;
		savedPos.h = panelH.value || panelRef.value?.offsetHeight || 400;
		panelPos.x = 0;
		panelPos.y = 0;
		panelW.value = window.innerWidth;
		panelH.value = window.innerHeight;
		maximized.value = true;
	}
}

// ---- drag ----
const dragging = ref(false);
const dragBase = reactive({ mx: 0, my: 0, px: 0, py: 0 });

function dragStart(e: MouseEvent) {
	if (!props.draggable || maximized.value) return;
	dragging.value = true;
	dragBase.mx = e.clientX;
	dragBase.my = e.clientY;
	dragBase.px = panelPos.x;
	dragBase.py = panelPos.y;
	e.preventDefault();
}

function dragMove(e: MouseEvent) {
	if (!dragging.value) return;
	// 允许面板拖到视口外，但至少保留 120px 宽度 / 40px 标题栏可抓取
	const w = panelW.value;
	panelPos.x = Math.max(
		-w + 120,
		Math.min(
			window.innerWidth - 120,
			dragBase.px + e.clientX - dragBase.mx,
		),
	);
	panelPos.y = Math.max(
		0,
		Math.min(
			window.innerHeight - 40,
			dragBase.py + e.clientY - dragBase.my,
		),
	);
}

function dragEnd() {
	dragging.value = false;
}

// ---- resize ----
const resizing = ref(false);
const resizeBase = reactive({ mx: 0, my: 0, w: 0, h: 0 });

function resizeStart(e: MouseEvent) {
	if (!props.resizable || maximized.value) return;
	const el = panelRef.value;
	if (!el) return;
	resizing.value = true;
	resizeBase.mx = e.clientX;
	resizeBase.my = e.clientY;
	resizeBase.w = el.offsetWidth;
	resizeBase.h = el.offsetHeight;
	panelW.value = resizeBase.w;
	panelH.value = resizeBase.h;
	e.preventDefault();
	e.stopPropagation();
}

function resizeMove(e: MouseEvent) {
	if (!resizing.value) return;
	const nw = Math.max(
		MIN_W,
		Math.min(
			window.innerWidth - panelPos.x - 20,
			resizeBase.w + e.clientX - resizeBase.mx,
		),
	);
	const nh = Math.max(
		MIN_H,
		Math.min(
			window.innerHeight - panelPos.y - 20,
			resizeBase.h + e.clientY - resizeBase.my,
		),
	);
	panelW.value = nw;
	panelH.value = nh;
}

function resizeEnd() {
	resizing.value = false;
}

// ---- global move / up ----
function onGlobalMouseMove(e: MouseEvent) {
	dragMove(e);
	resizeMove(e);
}
function onGlobalMouseUp() {
	if (dragging.value) dragEnd();
	if (resizing.value) resizeEnd();
}
onMounted(() => {
	document.addEventListener("mousemove", onGlobalMouseMove);
	document.addEventListener("mouseup", onGlobalMouseUp);
});
onBeforeUnmount(() => {
	document.removeEventListener("mousemove", onGlobalMouseMove);
	document.removeEventListener("mouseup", onGlobalMouseUp);
});

const panelStyle = computed(() => {
	if (!interactive.value) return { width: props.width + "px" };
	const s: Record<string, string> = {
		left: panelPos.x + "px",
		top: panelPos.y + "px",
		width: panelW.value + "px",
	};
	if (panelH.value > 0) s.height = panelH.value + "px";
	// 最大化时去掉圆角和阴影，看起来像贴边窗口
	if (maximized.value) {
		s.borderRadius = "0";
		s.boxShadow = "none";
	}
	return s;
});
</script>

<template>
	<Teleport to="body">
		<div class="modal-overlay" @mousedown.self="emit('close')">
			<div
				ref="panelRef"
				class="modal-panel"
				:class="{
					'modal-panel--fixed': interactive,
					'modal-panel--dragging': dragging,
					'modal-panel--resizing': resizing,
					'modal-panel--maximized': maximized,
				}"
				:style="panelStyle"
			>
				<div
					class="modal-head"
					:class="{
						grab: draggable && !maximized,
						grabbing: dragging,
					}"
					@mousedown="dragStart"
				>
					<span class="modal-title">{{ title }}</span>
					<div class="head-actions">
						<button
							v-if="resizable"
							class="btn-icon"
							:title="maximized ? '还原' : '最大化'"
							@click="toggleMaximize"
						>
							<Icon
								:name="maximized ? 'minimize-2' : 'maximize-2'"
								:size="14"
							/>
						</button>
						<button
							class="btn-icon"
							title="关闭"
							@click="emit('close')"
						>
							<Icon name="x" :size="14" />
						</button>
					</div>
				</div>
				<div class="modal-body">
					<slot />
				</div>
				<div class="modal-foot">
					<slot name="footer" />
				</div>
				<div
					v-if="resizable && !maximized"
					class="resize-handle"
					@mousedown="resizeStart"
				/>
			</div>
		</div>
	</Teleport>
</template>

<style scoped>
.modal-overlay {
	position: fixed;
	inset: 0;
	z-index: 1000;
	background: var(--overlay-bg);
	display: flex;
	align-items: flex-start;
	justify-content: center;
	padding-top: 14vh;
	animation: modal-overlay-in 0.16s ease-out;
}
.modal-panel {
	background: var(--bg-panel);
	border: 1px solid var(--border-strong);
	border-radius: 12px;
	box-shadow: var(--shadow-modal);
	max-width: calc(100vw - 48px);
	max-height: calc(100vh - 16vh - 40px);
	display: flex;
	flex-direction: column;
	overflow: hidden;
	animation: modal-panel-in 0.2s cubic-bezier(0.22, 1, 0.36, 1);
	transition:
		border-radius 0.2s,
		box-shadow 0.2s;
}
/* 可拖拽 / 可调整大小的面板：使用 fixed 手动定位 */
.modal-panel--fixed {
	position: fixed;
	max-width: none;
	max-height: none;
}
@keyframes modal-overlay-in {
	from {
		opacity: 0;
	}
}
@keyframes modal-panel-in {
	from {
		opacity: 0;
		transform: translateY(-10px) scale(0.97);
	}
}
.modal-panel--maximized .modal-head {
	display: grid;
	grid-template-columns: 1fr auto 1fr;
}
.modal-panel--maximized .modal-title {
	grid-column: 2;
	text-align: center;
}
.modal-panel--maximized .head-actions {
	grid-column: 3;
	justify-self: end;
}
.modal-head {
	flex: none;
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 10px;
	padding: 12px 14px 10px 16px;
	border-bottom: 1px solid var(--border);
	user-select: none;
}
.modal-title {
	font-size: 14px;
	font-weight: 600;
	color: var(--text-strong);
}
.head-actions {
	display: flex;
	align-items: center;
	gap: 2px;
	flex: none;
}
/* 拖拽光标 */
.grab {
	cursor: grab;
}
.grabbing {
	cursor: grabbing;
}
.modal-body {
	flex: 1;
	min-height: 0;
	padding: 14px 16px;
	overflow-y: auto;
	display: flex;
	flex-direction: column;
	gap: 12px;
}
.modal-foot {
	flex: none;
	display: flex;
	align-items: center;
	justify-content: flex-end;
	gap: 8px;
	padding: 10px 14px;
	border-top: 1px solid var(--border);
}
.modal-foot:empty {
	display: none;
}

/* ---- resize handle ---- */
.resize-handle {
	position: absolute;
	right: 0;
	bottom: 0;
	width: 16px;
	height: 16px;
	cursor: nwse-resize;
}
.resize-handle::after {
	content: "";
	position: absolute;
	right: 4px;
	bottom: 4px;
	width: 8px;
	height: 8px;
	border-right: 2px solid var(--border-strong);
	border-bottom: 2px solid var(--border-strong);
	opacity: 0;
	transition: opacity 0.15s;
}
.modal-panel:hover .resize-handle::after {
	opacity: 0.6;
}
</style>
