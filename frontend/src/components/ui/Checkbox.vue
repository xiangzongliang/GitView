<script setup lang="ts">
// 通用勾选框：统一全应用 checkbox 的尺寸、圆角、勾选/半选/禁用与焦点样式。
// 两种用法：
//   1) v-model="x"                             —— 组件自身维护状态
//   2) :checked="x" :indeterminate="part" @toggle="fn" —— 外部完全受控（如文件列表行）
import { computed } from "vue";

const props = withDefaults(
	defineProps<{
		modelValue?: boolean;
		/** 外部受控的勾选状态；提供时忽略 modelValue */
		checked?: boolean;
		/** 半选（如：部分暂存） */
		indeterminate?: boolean;
		disabled?: boolean;
		/** 勾选框右侧文字；不传则只渲染勾选框（文字由外层 label 提供） */
		label?: string;
		title?: string;
		/** 勾选框边长（px） */
		size?: number;
	}>(),
	{ size: 14 },
);

const emit = defineEmits<{
	(e: "update:modelValue", v: boolean): void;
	(e: "toggle", v: boolean): void;
}>();

const controlled = computed(() => props.checked !== undefined);
const value = computed(() =>
	controlled.value ? !!props.checked : !!props.modelValue,
);

function onClick() {
	if (props.disabled) return;
	const next = !value.value;
	emit("toggle", next);
	if (!controlled.value) emit("update:modelValue", next);
}
</script>

<template>
	<!-- 根元素用 span：可安全嵌在外层 label 内（避免 label 嵌套）；
	     原生 label 的转发点击仍会落到 input 上，因此点击文字也能切换。 -->
	<span
		class="cb"
		:class="{ disabled }"
		:title="title"
		@click.prevent="onClick"
	>
		<input
			class="cb-input"
			type="checkbox"
			:style="{ width: size + 'px', height: size + 'px' }"
			:checked="value"
			:indeterminate.prop="!!indeterminate"
			:disabled="disabled"
			@click.stop.prevent="onClick"
			@dblclick.stop
		/>
		<span v-if="label || $slots.default" class="cb-text">
			<slot>{{ label }}</slot>
		</span>
	</span>
</template>

<style scoped>
.cb {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	min-width: 0;
	cursor: pointer;
	user-select: none;
	vertical-align: middle;
}
.cb.disabled {
	cursor: default;
	opacity: 0.5;
}
.cb-input {
	appearance: none;
	-webkit-appearance: none;
	flex: none;
	margin: 0;
	padding: 0;
	border: 1.5px solid var(--border-strong);
	border-radius: 4.5px;
	background: var(--bg-input);
	display: inline-grid;
	place-content: center;
	cursor: inherit;
	transition:
		background-color 0.13s ease,
		border-color 0.13s ease,
		box-shadow 0.13s ease;
}
/* 勾：用两侧边框旋转出的对勾（颜色随主色前景：浅色主色下自动转深） */
.cb-input::after {
	content: "";
	width: 4px;
	height: 7.5px;
	margin-top: -2px;
	border-right: 2px solid var(--accent-fg);
	border-bottom: 2px solid var(--accent-fg);
	transform: rotate(42deg) scale(0);
	transition: transform 0.13s cubic-bezier(0.3, 1.4, 0.5, 1);
}
.cb-input:hover:not(:disabled) {
	border-color: var(--accent);
}
.cb-input:checked,
.cb-input:indeterminate {
	background: var(--accent);
	border-color: var(--accent);
}
.cb-input:checked::after {
	transform: rotate(42deg) scale(1);
}
/* 半选：一条短横线（声明在 :checked 之后，两者同时成立时以横线为准） */
.cb-input:indeterminate::after {
	width: 8px;
	height: 2px;
	margin-top: 0;
	border: none;
	border-radius: 1px;
	background: var(--accent-fg);
	transform: none;
}
.cb-input:focus-visible {
	outline: none;
	box-shadow: 0 0 0 2px var(--accent-soft);
}
.cb-text {
	min-width: 0;
	line-height: 1.4;
	color: inherit;
}
</style>
