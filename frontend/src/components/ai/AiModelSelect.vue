<script setup lang="ts">
// AI 模型下拉框：按配置（provider）分组，仅列出 Base URL / API Key / 模型名称
// 齐备的模型（见 ai/models.ts），避免选到无法发起请求的配置。
import { computed } from "vue";
import { useAi } from "../../stores/ai";
import SelectMenu from "../ui/SelectMenu.vue";
import type { SelectEntry, SelectOption } from "../ui/types";
import { availableAiModels, encodeModelValue } from "../../ai/models";

withDefaults(
	defineProps<{
		modelValue: string;
		placeholder?: string;
		disabled?: boolean;
		fullWidth?: boolean;
		/** 无边框样式（嵌入容器时由外部工具条的分割线界定） */
		flat?: boolean;
	}>(),
	{ placeholder: "选择模型", disabled: false, fullWidth: true, flat: false },
);
const emit = defineEmits<{ (e: "update:modelValue", v: string): void }>();

const ai = useAi();

const options = computed<SelectEntry[]>(() => {
	const groups: { group: string; options: SelectOption[] }[] = [];
	const index = new Map<string, number>();
	for (const c of availableAiModels(ai.providers)) {
		let at = index.get(c.providerId);
		if (at === undefined) {
			at = groups.length;
			index.set(c.providerId, at);
			groups.push({ group: c.providerTitle, options: [] });
		}
		groups[at].options.push({
			label: c.model,
			value: encodeModelValue(c.providerId, c.model),
			icon: "sparkles",
		});
	}
	return groups;
});
</script>

<template>
	<SelectMenu
		:model-value="modelValue"
		:options="options"
		:placeholder="placeholder"
		:disabled="disabled"
		:full-width="fullWidth"
		:flat="flat"
		:max-height="280"
		@update:model-value="emit('update:modelValue', $event)"
	/>
</template>
