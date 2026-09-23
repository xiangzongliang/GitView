<script setup lang="ts">
// 分组外观就地弹层：图标（来自 @lucide/vue）+ 图标颜色 + 分组文字颜色。
// 所见即所得：每次点击立即写入 store（侧边栏即时生效），写盘去抖、无保存按钮。
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { useRepos } from "../../stores/repos";
import GroupIcon from "../ui/GroupIcon.vue";
import Icon from "../ui/Icon.vue";
import { GROUP_COLORS, GROUP_ICONS } from "../../utils/groupIcons";

const props = defineProps<{
	/** 分组名 */
	name: string;
	/** 弹层左边缘的期望位置（视口坐标） */
	x: number;
	/** 弹层上边缘的期望位置（视口坐标） */
	y: number;
	/** 触发弹层的锚点元素：点击它不算「点击外部」（便于再次点击收起） */
	anchor?: HTMLElement | null;
}>();
const emit = defineEmits<{ (e: "close"): void }>();

const repos = useRepos();

const group = computed(() => repos.groups.find((g) => g.name === props.name));
const icon = computed(() => group.value?.icon || "");
const iconColor = computed(() => group.value?.iconColor || "");
const textColor = computed(() => group.value?.textColor || "");

/** 局部更新（未传的字段保持不变） */
function patch(p: { icon?: string; iconColor?: string; textColor?: string }) {
	repos.setGroupStyle(props.name, {
		icon: p.icon ?? icon.value,
		iconColor: p.iconColor ?? iconColor.value,
		textColor: p.textColor ?? textColor.value,
	});
}

// ------------------------------------------------------------------ 定位
const WIDTH = 320;
const el = ref<HTMLElement | null>(null);
const pos = ref<{ left: number; top: number }>({ left: props.x, top: props.y });
const style = computed(() => ({
	left: pos.value.left + "px",
	top: pos.value.top + "px",
	width: WIDTH + "px",
}));

function place() {
	const h = el.value?.offsetHeight || 380;
	const maxLeft = window.innerWidth - WIDTH - 8;
	const maxTop = window.innerHeight - h - 8;
	pos.value = {
		left: Math.max(8, Math.min(props.x, maxLeft)),
		top: Math.max(8, Math.min(props.y, maxTop)),
	};
}

// ------------------------------------------------------------------ 关闭
function onDocDown(e: MouseEvent) {
	const t = e.target as Node;
	if (el.value?.contains(t)) return;
	if (props.anchor?.contains(t)) return;
	emit("close");
}
function onKey(e: KeyboardEvent) {
	if (e.key === "Escape") {
		e.stopPropagation();
		emit("close");
	}
}
function onResize() {
	emit("close");
}

onMounted(async () => {
	place();
	await nextTick();
	place(); // 元素已挂载，按真实高度再夹一次
	document.addEventListener("mousedown", onDocDown, true);
	document.addEventListener("keydown", onKey, true);
	window.addEventListener("resize", onResize);
});
onBeforeUnmount(() => {
	document.removeEventListener("mousedown", onDocDown, true);
	document.removeEventListener("keydown", onKey, true);
	window.removeEventListener("resize", onResize);
	// 关闭时把去抖中的改动立即落盘，避免快速关闭丢失
	repos.flushLayoutSave();
});
</script>

<template>
	<Teleport to="body">
		<div ref="el" class="gs-pop" :style="style">
			<div class="gs-head">
				<GroupIcon :name="icon" :size="14" :color="iconColor" />
				<span
					class="gs-title"
					:style="{ color: textColor || undefined }"
					>{{ name }}</span
				>
			</div>

			<div class="gs-section">
				<span class="gs-label">图标</span>
				<div class="gs-icons">
					<button
						v-for="ic in GROUP_ICONS"
						:key="ic.key"
						class="gs-icon"
						:class="{ active: icon === ic.key }"
						:title="ic.label"
						@click="patch({ icon: icon === ic.key ? '' : ic.key })"
					>
						<GroupIcon :name="ic.key" :size="15" />
					</button>
				</div>
			</div>

			<div class="gs-section">
				<span class="gs-label">图标颜色</span>
				<div class="gs-colors">
					<button
						v-for="c in GROUP_COLORS"
						:key="'i' + c.label"
						class="gs-color"
						:class="{ active: iconColor === c.color, plain: !c.color }"
						:style="{ '--c': c.color || 'var(--text-dim)' }"
						:title="c.label"
						@click="patch({ iconColor: c.color })"
					>
						<Icon
							v-if="iconColor === c.color"
							name="check"
							:size="10"
						/>
					</button>
				</div>
			</div>

			<div class="gs-section">
				<span class="gs-label">文字颜色</span>
				<div class="gs-colors">
					<button
						v-for="c in GROUP_COLORS"
						:key="'t' + c.label"
						class="gs-color"
						:class="{ active: textColor === c.color, plain: !c.color }"
						:style="{ '--c': c.color || 'var(--text-dim)' }"
						:title="c.label"
						@click="patch({ textColor: c.color })"
					>
						<Icon
							v-if="textColor === c.color"
							name="check"
							:size="10"
						/>
					</button>
				</div>
			</div>

			<div class="gs-foot">
				<button
					class="gs-reset"
					title="图标与颜色恢复默认"
					@click="patch({ icon: '', iconColor: '', textColor: '' })"
				>
					<Icon name="reset" :size="12" /> 恢复默认
				</button>
			</div>
		</div>
	</Teleport>
</template>

<style scoped>
.gs-pop {
	position: fixed;
	z-index: 1600;
	display: flex;
	flex-direction: column;
	gap: 10px;
	padding: 10px;
	background: var(--bg-panel-2);
	border: 1px solid var(--border-strong);
	border-radius: 10px;
	box-shadow: var(--shadow-popover);
	transform-origin: top left;
	animation: gs-in 0.13s ease-out;
}
@keyframes gs-in {
	from {
		opacity: 0;
		transform: scale(0.97) translateY(-3px);
	}
}

.gs-head {
	display: flex;
	align-items: center;
	gap: 7px;
	padding-bottom: 8px;
	border-bottom: 1px solid var(--border);
}
.gs-title {
	font-size: 12.5px;
	font-weight: 600;
	color: var(--text-strong);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.gs-section {
	display: flex;
	flex-direction: column;
	gap: 6px;
}
.gs-label {
	font-size: 11px;
	color: var(--text-faint);
}

.gs-icons {
	display: grid;
	grid-template-columns: repeat(auto-fill, 26px);
	gap: 4px;
	max-height: 152px;
	overflow-y: auto;
	padding: 5px;
	border: 1px solid var(--border);
	border-radius: 8px;
	background: var(--bg-input);
}
.gs-icon {
	display: flex;
	align-items: center;
	justify-content: center;
	width: 26px;
	height: 26px;
	border-radius: 6px;
	color: var(--text-dim);
	transition:
		background 0.1s ease,
		color 0.1s ease;
}
.gs-icon:hover {
	background: var(--bg-hover);
	color: var(--text-strong);
}
.gs-icon.active {
	background: var(--accent-wash);
	color: var(--accent);
	box-shadow: inset 0 0 0 1px var(--accent);
}

.gs-colors {
	display: flex;
	flex-wrap: wrap;
	gap: 5px;
}
.gs-color {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 20px;
	height: 20px;
	border-radius: 50%;
	background: var(--c);
	border: 1px solid var(--border-strong);
	color: #fff;
	transition:
		transform 0.1s ease,
		box-shadow 0.1s ease;
}
.gs-color:hover {
	transform: scale(1.12);
}
.gs-color.active {
	box-shadow:
		0 0 0 2px var(--bg-panel-2),
		0 0 0 4px var(--c);
}
.gs-color.plain {
	background: var(--bg-input);
	color: var(--text-faint);
}

.gs-foot {
	display: flex;
	justify-content: flex-end;
	padding-top: 8px;
	border-top: 1px solid var(--border);
}
.gs-reset {
	display: inline-flex;
	align-items: center;
	gap: 5px;
	height: 24px;
	padding: 0 8px;
	border-radius: 6px;
	font-size: 11.5px;
	color: var(--text-dim);
}
.gs-reset:hover {
	background: var(--bg-hover);
	color: var(--text-strong);
}
</style>
