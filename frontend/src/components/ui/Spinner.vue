<script setup lang="ts">
// 通用 loading 指示器：用于局部加载（按钮、列表行等），不使用全屏遮罩。
withDefaults(defineProps<{ size?: number }>(), { size: 14 });
</script>

<template>
	<span
		class="spinner"
		:style="{ width: size + 'px', height: size + 'px' }"
		aria-hidden="true"
	/>
</template>

<style scoped>
.spinner {
	display: inline-block;
	flex: none;
	border: 2px solid var(--border-strong);
	border-top-color: var(--accent);
	border-radius: 50%;
	animation: spin 0.8s linear infinite;
}
</style>
