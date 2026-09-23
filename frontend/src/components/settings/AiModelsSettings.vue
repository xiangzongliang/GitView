<script setup lang="ts">
// 设置 · AI 模型：一个 Base URL / API Key 对应一组模型，可配置多组。
// 配置信息保存在应用配置文件（config.json）中，模型名称为空的条目不会写入。
import { onBeforeUnmount, ref, watch } from "vue";
import { useAi } from "../../stores/ai";
import type { AiConfig } from "../../stores/ai";
import { useUI } from "../../stores/ui";
import Icon from "../ui/Icon.vue";

const ai = useAi();
const ui = useUI();

// 任一字段变化即写入 config.json（deep 监听，避免依赖 input 事件顺序）
watch(
	() => ai.providers,
	() => ai.persist(),
	{ deep: true },
);

// 离开页面（切换 Tab / 关闭设置）时立即写盘，避免去抖中的修改丢失
onBeforeUnmount(() => ai.flush());

// 每组配置独立控制 API Key 是否明文显示
const revealed = ref<Record<string, boolean>>({});

function toggleReveal(id: string) {
	revealed.value[id] = !revealed.value[id];
}

function addProvider() {
	ai.addProvider();
}

function removeProvider(p: AiConfig) {
	ai.removeProvider(p.id);
	ui.success("已删除配置", p.title || "未命名配置");
}

function addModel(p: AiConfig) {
	ai.addModel(p.id);
}

function removeModel(p: AiConfig, index: number) {
	ai.removeModel(p.id, index);
}
</script>

<template>
	<section class="group">
		<h3 class="group-title">AI 模型</h3>
		<p class="group-desc">
			一个 Base URL / API Key 下可配置多个模型，信息保存在应用配置文件中。
		</p>

		<div v-if="ai.providers.length === 0" class="ai-empty">
			还没有配置，点击下方按钮添加。
		</div>

		<div v-else class="ai-list">
			<div v-for="(p, pi) in ai.providers" :key="p.id" class="ai-provider">
				<div class="ai-provider-head">
					<span class="ai-provider-title">配置 {{ pi + 1 }}</span>
					<button
						class="btn-icon"
						title="删除该配置"
						@click="removeProvider(p)"
					>
						<Icon name="trash" :size="13" />
					</button>
				</div>

				<label class="ai-field">
					<span class="ai-label">名称</span>
					<input
						v-model="p.title"
						type="text"
						spellcheck="false"
						placeholder="如 OpenAI / DeepSeek"
					/>
				</label>

				<label class="ai-field">
					<span class="ai-label">Base URL</span>
					<input
						v-model="p.baseUrl"
						type="text"
						spellcheck="false"
						placeholder="https://api.openai.com/v1"
					/>
				</label>

				<div class="ai-field">
					<span class="ai-label">API Key</span>
					<div class="ai-key">
						<input
							v-model="p.apiKey"
							:type="revealed[p.id] ? 'text' : 'password'"
							spellcheck="false"
							autocomplete="off"
							placeholder="sk-..."
						/>
						<button
							class="btn-icon"
							:title="revealed[p.id] ? '隐藏' : '显示'"
							@click="toggleReveal(p.id)"
						>
							<Icon
								:name="revealed[p.id] ? 'eye-off' : 'eye'"
								:size="13"
							/>
						</button>
					</div>
				</div>

				<div class="ai-field ai-field-top">
					<span class="ai-label">模型</span>
					<div class="ai-models">
						<div
							v-for="(_, mi) in p.models"
							:key="mi"
							class="ai-model-row"
						>
							<input
								v-model="p.models[mi]"
								type="text"
								spellcheck="false"
								placeholder="模型名称，如 gpt-4o"
							/>
							<button
								class="btn-icon"
								title="删除该模型"
								@click="removeModel(p, mi)"
							>
								<Icon name="x" :size="13" />
							</button>
						</div>
						<button
							class="btn btn-ghost ai-add-model"
							@click="addModel(p)"
						>
							<Icon name="plus" :size="13" />
							添加模型
						</button>
					</div>
				</div>
			</div>
		</div>

		<div class="ai-actions">
			<button class="btn btn-primary" @click="addProvider">
				<Icon name="plus" :size="13" />
				添加配置
			</button>
		</div>
	</section>
</template>

<style scoped>
/* 版式（无卡片 + 分割线）由 SettingsPanel 统一提供 */

.ai-empty {
	padding: 16px;
	text-align: center;
	font-size: 12px;
	color: var(--text-faint);
	border: 1px dashed var(--border-strong);
	border-radius: 9px;
}

/* 每个配置块：小标题行 + 字段；块之间用分割线区分 */
.ai-provider + .ai-provider {
	margin-top: 16px;
	padding-top: 16px;
	border-top: 1px solid var(--border);
}
.ai-provider-head {
	display: flex;
	align-items: center;
	gap: 6px;
	margin-bottom: 8px;
}
.ai-provider-title {
	flex: 1;
	min-width: 0;
	font-size: 12px;
	font-weight: 600;
	letter-spacing: 0.02em;
	color: var(--text-dim);
}

/* 字段网格：标签 / 输入 / 操作按钮。
   操作列固定预留，保证各行输入框等宽、右边缘齐平（不因某个字段有按钮而错位）。 */
.ai-field {
	display: grid;
	grid-template-columns: 84px minmax(0, 1fr) 26px;
	column-gap: 8px;
	align-items: center;
	margin-bottom: 8px;
}
.ai-field-top {
	align-items: start;
}
.ai-label {
	grid-column: 1;
	font-size: 12.5px;
	color: var(--text);
}
.ai-field-top .ai-label {
	padding-top: 5px;
}
.ai-field > input {
	grid-column: 2;
	width: 100%;
	min-width: 0;
}
/* 组内最后一个字段不留底部外边距，使分割线上下间距对称 */
.ai-provider > .ai-field:last-child {
	margin-bottom: 0;
}

/* API Key：输入框 + 显示/隐藏按钮（跨到操作列，内部按同样列宽排布） */
.ai-key {
	grid-column: 2 / 4;
	display: grid;
	grid-template-columns: minmax(0, 1fr) 26px;
	column-gap: 8px;
	align-items: center;
}
.ai-key input {
	width: 100%;
	min-width: 0;
}

/* 模型列表：与输入列等宽（同样跨到操作列），每行 = 输入框 + 删除按钮 */
.ai-models {
	grid-column: 2 / 4;
	display: flex;
	flex-direction: column;
	gap: 6px;
}
.ai-model-row {
	display: grid;
	grid-template-columns: minmax(0, 1fr) 26px;
	column-gap: 8px;
	align-items: center;
}
.ai-model-row input {
	width: 100%;
	min-width: 0;
}
.ai-add-model {
	align-self: flex-start;
	height: 24px;
	padding: 0 8px;
	color: var(--text-dim);
}

.ai-actions {
	display: flex;
	gap: 8px;
	margin-top: 16px;
}
/* 已有配置时，配置列表与「添加配置」之间用分割线分开 */
.ai-list + .ai-actions {
	margin-top: 16px;
	padding-top: 16px;
	border-top: 1px solid var(--border);
}
</style>
