<script setup lang="ts">
// 分组图标：按 key 渲染 @lucide/vue 图标（见 utils/groupIcons.ts）。
// color 为空时继承 currentColor，从而跟随主题 / 分组文字颜色。
import { computed } from "vue";
import { groupIconComponent } from "../../utils/groupIcons";

const props = withDefaults(
	defineProps<{ name?: string; size?: number; color?: string }>(),
	{ size: 13, color: "" },
);

const comp = computed(() => groupIconComponent(props.name));
</script>

<template>
	<component
		:is="comp"
		:size="size"
		:stroke-width="1.9"
		:color="color || undefined"
		aria-hidden="true"
	/>
</template>
