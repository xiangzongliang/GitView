<script setup lang="ts">
// 设置 · Git 配置：当前用户的全局 git 配置查看与修改（对应 ~/.gitconfig）。
import { onMounted, ref } from "vue";
import { GitService, errMsg } from "../../api";
import { useUI } from "../../stores/ui";
import Icon from "../ui/Icon.vue";
import Spinner from "../ui/Spinner.vue";

const ui = useUI();

const CONFIG_FIELDS = [
	{ key: "user.name", label: "用户名", placeholder: "提交作者显示的姓名" },
	{ key: "user.email", label: "邮箱", placeholder: "提交作者显示的邮箱" },
	{
		key: "init.defaultBranch",
		label: "默认分支名",
		placeholder: "init 时的默认分支（如 main）",
	},
	{
		key: "core.editor",
		label: "编辑器",
		placeholder: "git 交互时使用的编辑器",
	},
] as const;

const cfgValues = ref<Record<string, string>>({});
const cfgLoading = ref(false);
const cfgSaving = ref(false);

async function loadConfig() {
	cfgLoading.value = true;
	try {
		const res = (await GitService.GlobalConfig()) || {};
		cfgValues.value = { ...(res as Record<string, string>) };
	} catch (e) {
		ui.error("读取 Git 配置失败", errMsg(e));
	} finally {
		cfgLoading.value = false;
	}
}

async function saveConfig() {
	if (cfgSaving.value) return;
	cfgSaving.value = true;
	try {
		for (const f of CONFIG_FIELDS) {
			const v = (cfgValues.value[f.key] || "").trim();
			await GitService.SetGlobalConfig(f.key, v);
		}
		ui.success("Git 配置已保存", "全局配置已更新");
		await loadConfig();
	} catch (e) {
		ui.error("保存 Git 配置失败", errMsg(e));
	} finally {
		cfgSaving.value = false;
	}
}

// 组件在「Git 配置」页被选中时才挂载，因此挂载即加载。
onMounted(loadConfig);
</script>

<template>
	<section class="group">
		<h3 class="group-title">全局 Git 配置</h3>
		<p class="group-desc">对应 ~/.gitconfig，影响所有仓库。</p>
		<div v-if="cfgLoading" class="cfg-loading">
			<Spinner :size="13" /> 读取配置…
		</div>
		<template v-else>
			<label v-for="f in CONFIG_FIELDS" :key="f.key" class="cfg-field">
				<span class="cfg-label">{{ f.label }}</span>
				<input
					v-model="cfgValues[f.key]"
					type="text"
					spellcheck="false"
					:placeholder="f.placeholder"
				/>
				<code class="cfg-key mono">{{ f.key }}</code>
			</label>
			<div class="cfg-actions">
				<button
					class="btn btn-primary"
					:disabled="cfgSaving"
					@click="saveConfig"
				>
					<Icon name="check" :size="13" />
					{{ cfgSaving ? "保存中…" : "保存" }}
				</button>
				<button
					class="btn"
					:disabled="cfgLoading || cfgSaving"
					@click="loadConfig"
				>
					<Icon name="refresh" :size="13" />
					重置
				</button>
			</div>
		</template>
	</section>
</template>

<style scoped>
/* 版式（无卡片 + 分割线）由 SettingsPanel 统一提供 */

.cfg-loading {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 12px 0;
	font-size: 12px;
	color: var(--text-faint);
}
.cfg-field {
	display: grid;
	grid-template-columns: 84px 1fr;
	gap: 4px 10px;
	align-items: center;
	margin-bottom: 12px;
}
.cfg-label {
	grid-column: 1;
	font-size: 12.5px;
	color: var(--text);
}
.cfg-field input {
	grid-column: 2;
	width: 100%;
}
.cfg-key {
	grid-column: 2;
	font-size: 10.5px;
	color: var(--text-faint);
}
.cfg-actions {
	display: flex;
	gap: 8px;
	margin-top: 14px;
}
</style>
