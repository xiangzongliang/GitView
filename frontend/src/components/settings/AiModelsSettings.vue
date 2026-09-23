<script setup lang="ts">
// 设置 · AI 模型：一个 Base URL / API Key 对应一组模型，可配置多组。
// 配置名称可自行修改，信息保存在应用配置文件（config.json）中。
import { onBeforeUnmount, ref, watch } from "vue";
import { useAi } from "../../stores/ai";
import type { AiProvider } from "../../api";
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

function removeProvider(p: AiProvider) {
	ai.removeProvider(p.id);
	ui.success("已删除配置", p.title || "未命名配置");
}

function addModel(p: AiProvider) {
	ai.addModel(p.id);
}

function removeModel(p: AiProvider, index: number) {
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
			<div v-for="p in ai.providers" :key="p.id" class="ai-provider">
				<div class="ai-provider-head">
					<input
						v-model="p.title"
						class="ai-name"
						type="text"
						spellcheck="false"
						placeholder="配置名称，如 OpenAI / DeepSeek"
					/>
					<button
						class="btn-icon"
						title="删除该配置"
						@click="removeProvider(p)"
					>
						<Icon name="trash" :size="13" />
					</button>
				</div>

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
							class="btn-icon ai-key-toggle"
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

/* 每组配置：标题行 + 字段，组间用分割线区分（不再使用卡片） */
.ai-provider + .ai-provider {
	margin-top: 18px;
	padding-top: 18px;
	border-top: 1px solid var(--border);
}

/* 配置名称：无框标题观感，hover / focus 时才显现输入框。
   margin-left 抵消输入框内边距，使名称与下方标签左对齐。 */
.ai-provider-head {
	display: flex;
	align-items: center;
	gap: 6px;
	margin-bottom: 8px;
}
.ai-name {
	flex: 1;
	min-width: 0;
	margin-left: -8px;
	padding: 4px 8px;
	background: transparent;
	border-color: transparent;
	font-size: 13px;
	font-weight: 600;
	color: var(--text-strong);
}
.ai-name:hover:not(:focus) {
	border-color: var(--border-strong);
}
.ai-name::placeholder {
	font-weight: 400;
}

/* 标签列宽度与 Git 配置页保持一致，保证各设置页标题左对齐 */
.ai-field {
	display: grid;
	grid-template-columns: 84px 1fr;
	gap: 8px 10px;
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
	padding-top: 6px;
}
.ai-field > input {
	grid-column: 2;
	width: 100%;
}
/* 组内最后一个字段不留底部外边距，使分割线上下间距对称 */
.ai-provider > .ai-field:last-child {
	margin-bottom: 0;
}

/* API Key / 模型：图标按钮内嵌在输入框右侧，保证各行输入框等宽、右边缘齐平 */
.ai-key {
	position: relative;
	grid-column: 2;
}
.ai-key input,
.ai-model-row input {
	width: 100%;
	padding-right: 30px;
}
.ai-key .btn-icon,
.ai-model-row .btn-icon {
	position: absolute;
	right: 2px;
	top: 50%;
	transform: translateY(-50%);
}

/* 模型列表 */
.ai-models {
	grid-column: 2;
	display: flex;
	flex-direction: column;
	gap: 6px;
}
.ai-model-row {
	position: relative;
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
	margin-top: 18px;
	padding-top: 18px;
	border-top: 1px solid var(--border);
}
</style>
