<script setup lang="ts">
// 提交信息生成弹窗：复用通用流式对话组件，把结果写入提交信息输入框。
// 提示词与变更上下文由调用方（StatusView）预先构建好后通过 payload 传入；
// 项目配置的提交前缀也随 payload 传入，在展示与应用时统一拼接。
import { useRepo } from "../../stores/repo";
import { useUI } from "../../stores/ui";
import { applyCommitPrefix } from "../../ai/commitPrefix";
import AiChatDialog from "./AiChatDialog.vue";

const props = defineProps<{
	payload?: {
		providerId?: string;
		model?: string;
		system?: string;
		user?: string;
		/** 项目配置的提交信息前缀（"" 表示不加） */
		prefix?: string;
	};
}>();
const emit = defineEmits<{ (e: "close"): void }>();

const repo = useRepo();
const ui = useUI();

/**
 * 统一加前缀：同时用于界面展示和最终应用，保证所见即所得。
 * 前缀在弹窗生命周期内不会变化，所以这个函数保持稳定。
 */
function formatOutput(text: string): string {
	return applyCommitPrefix(clean(text), props.payload?.prefix || "");
}

/** 去掉模型偶尔多输出的 Markdown 代码块围栏。 */
function clean(text: string): string {
	const t = text.trim();
	const m = t.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
	return (m ? m[1] : t).trim();
}

function onApply(content: string) {
	const msg = content.trim();
	if (!msg) return;
	repo.commitMessage = msg;
	ui.success("已填入提交信息");
	emit("close");
}
</script>

<template>
	<AiChatDialog
		title="AI 生成提交信息"
		:system="payload?.system || ''"
		:user="payload?.user || ''"
		:provider-id="payload?.providerId || ''"
		:model="payload?.model || ''"
		:repo-path="repo.path || ''"
		:format-output="formatOutput"
		apply-label="使用此信息"
		@apply="onApply"
		@close="emit('close')"
	/>
</template>
