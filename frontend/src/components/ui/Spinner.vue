<script setup lang="ts">
// 通用 loading 指示器：旋转的 loading 图标（Icon 内部对 name="loading" 自动加旋转动画）。
import Icon from "./Icon.vue";

withDefaults(defineProps<{ size?: number }>(), { size: 14 });
</script>

<template>
	<Icon name="loading" :size="size" />
</template>
