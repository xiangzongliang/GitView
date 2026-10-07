<script setup lang="ts">
// 编辑远程仓库弹窗：名称与地址在同一弹窗中修改。
// 名称变化 → git remote rename；地址变化 → git remote set-url（先改名再改地址）。
import { computed, ref } from "vue";
import { useRepo } from "../../stores/repo";
import { useUI } from "../../stores/ui";
import ModalDialog from "../ui/ModalDialog.vue";
import Icon from "../ui/Icon.vue";

const props = defineProps<{ payload: { name: string; url?: string } }>();
const emit = defineEmits<{ (e: "close"): void }>();

const repo = useRepo();
const ui = useUI();

const name = ref(props.payload?.name || "");
const url = ref(props.payload?.url || "");

const nameChanged = computed(() => name.value.trim() !== props.payload?.name);
const urlChanged = computed(
	() => !!url.value.trim() && url.value.trim() !== props.payload?.url,
);
const valid = computed(
	() =>
		!!name.value.trim() &&
		!!url.value.trim() &&
		(nameChanged.value || urlChanged.value),
);

const desc = computed(() => {
	const cmds: string[] = [];
	if (nameChanged.value)
		cmds.push(
			"git remote rename " +
				props.payload?.name +
				" " +
				name.value.trim(),
		);
	if (urlChanged.value)
		cmds.push(
			"git remote set-url " +
				(nameChanged.value ? name.value.trim() : props.payload?.name) +
				" " +
				url.value.trim(),
		);
	return cmds.join("  ·  ");
});

async function submit() {
	if (!valid.value || ui.opRunning) return;
	emit("close");
	const oldName = props.payload?.name;
	const newName = name.value.trim();
	const newUrl = url.value.trim();
	if (newName !== oldName) {
		await repo.renameRemote(oldName, newName);
		// runOp 对 void 方法失败/成功都返回空值，用刷新后的远程列表判断是否改名成功。
		const list = repo.refs?.remotes || [];
		if (!list.some((r) => r.name === newName)) return;
	}
	if (newUrl !== props.payload?.url) await repo.setRemoteUrl(newName, newUrl);
}
</script>

<template>
	<ModalDialog title="编辑远程" :width="500" @close="emit('close')">
		<label class="field">
			<span class="label">名称（原：{{ payload?.name }}）</span>
			<input
				v-model="name"
				type="text"
				spellcheck="false"
				:placeholder="payload?.name"
				@keydown.enter.prevent="submit"
			/>
		</label>
		<label class="field">
			<span class="label">地址</span>
			<input
				v-model="url"
				type="text"
				spellcheck="false"
				placeholder="https://github.com/user/repo.git"
				@keydown.enter.prevent="submit"
			/>
		</label>
		<p v-if="desc" class="hint mono">{{ desc }}</p>
		<p v-else class="hint">名称与地址均未修改。</p>
		<template #footer>
			<button class="btn" @click="emit('close')">取消</button>
			<button
				class="btn btn-primary"
				:disabled="!valid || !!ui.opRunning"
				@click="submit"
			>
				<Icon name="edit" :size="13" /> 保存
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
	line-height: 1.6;
	overflow-wrap: anywhere;
}
.mono {
	font-family: var(--font-mono, ui-monospace, monospace);
}
</style>
