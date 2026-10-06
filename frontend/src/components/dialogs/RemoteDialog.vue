<script setup lang="ts">
// 添加远程仓库弹窗：填写名称与地址后调用 git remote add。
// 仓库可以配置多个远程（如 origin / upstream），名称需唯一。
import { computed, ref } from "vue";
import { useRepo } from "../../stores/repo";
import { useUI } from "../../stores/ui";
import ModalDialog from "../ui/ModalDialog.vue";
import Icon from "../ui/Icon.vue";

const props = defineProps<{ payload?: { name?: string; url?: string } }>();
const emit = defineEmits<{ (e: "close"): void }>();

const repo = useRepo();
const ui = useUI();

const name = ref(props.payload?.name || "");
const url = ref(props.payload?.url || "");

const valid = computed(() => !!name.value.trim() && !!url.value.trim());

async function submit() {
	if (!valid.value || ui.opRunning) return;
	emit("close");
	await repo.addRemote(name.value.trim(), url.value.trim());
}
</script>

<template>
	<ModalDialog title="添加远程" :width="480" @close="emit('close')">
		<label class="field">
			<span class="label">名称 *</span>
			<input
				v-model="name"
				type="text"
				spellcheck="false"
				placeholder="origin"
				@keydown.enter.prevent="submit"
			/>
		</label>
		<label class="field">
			<span class="label">地址 *</span>
			<input
				v-model="url"
				type="text"
				spellcheck="false"
				placeholder="https://github.com/user/repo.git"
				@keydown.enter.prevent="submit"
			/>
		</label>
		<p class="hint">
			名称用于在命令与界面中引用该远程（如 origin、upstream），需唯一。
		</p>
		<template #footer>
			<button class="btn" @click="emit('close')">取消</button>
			<button
				class="btn btn-primary"
				:disabled="!valid || !!ui.opRunning"
				@click="submit"
			>
				<Icon name="plus" :size="13" /> 添加
			</button>
		</template>
	</ModalDialog>
</template>

<style scoped>
.field {
	display: flex;
	flex-direction: column;
	gap: 5px;
}
.label {
	font-size: 11.5px;
	color: var(--text-dim);
}
input[type="text"] {
	width: 100%;
}
.hint {
	font-size: 11px;
	color: var(--text-faint);
	line-height: 1.5;
}
</style>
