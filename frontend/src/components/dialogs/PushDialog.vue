<script setup lang="ts">
import { computed, ref } from "vue";
import { useRepo } from "../../stores/repo";
import { useUI } from "../../stores/ui";
import ModalDialog from "../ui/ModalDialog.vue";
import Icon from "../ui/Icon.vue";
import SelectMenu from "../ui/SelectMenu.vue";
import type { SelectEntry } from "../ui/types";

const emit = defineEmits<{ (e: "close"): void }>();

const repo = useRepo();
const ui = useUI();

const remotes = computed(() => repo.refs?.remotes || []);
const remoteOptions = computed<SelectEntry[]>(() =>
	remotes.value.map((r) => ({ label: r.name, value: r.name, icon: "cloud" })),
);
const remote = ref(
	remotes.value.some((r) => r.name === "origin")
		? "origin"
		: remotes.value[0]?.name || "",
);
const branch = ref(repo.status?.detached ? "" : repo.status?.branch || "");
const force = ref(false);
const setUpstream = ref(!repo.status?.upstream);
const pushTags = ref(false);

const valid = computed(() => !!remote.value && !!branch.value.trim());

async function submit() {
	if (!valid.value || ui.opRunning) return;
	emit("close");
	await repo.push({
		remote: remote.value,
		branch: branch.value.trim(),
		force: force.value,
		setUpstream: setUpstream.value,
		pushTags: pushTags.value,
	});
}
</script>

<template>
	<ModalDialog title="Push 推送" :width="480" @close="emit('close')">
		<div v-if="!remotes.length" class="warn">
			<Icon name="alert" :size="13" /> 此仓库没有配置远程，无法推送。
		</div>
		<template v-else>
			<div class="row2">
				<label class="field">
					<span class="label">远程 *</span>
					<SelectMenu
						v-model="remote"
						:options="remoteOptions"
						full-width
						:max-height="240"
					/>
				</label>
				<label class="field">
					<span class="label">分支 *</span>
					<input
						v-model="branch"
						type="text"
						spellcheck="false"
						placeholder="main"
					/>
				</label>
			</div>
			<label class="check">
				<input v-model="setUpstream" type="checkbox" />
				设置上游跟踪（-u）
			</label>
			<label class="check">
				<input v-model="pushTags" type="checkbox" />
				同时推送所有标签（--tags）
			</label>
			<label class="check danger-check">
				<input v-model="force" type="checkbox" />
				强制推送（--force，会覆盖远程历史！）
			</label>
		</template>
		<template #footer>
			<button class="btn" @click="emit('close')">取消</button>
			<button
				class="btn btn-primary"
				:disabled="!valid || !!ui.opRunning"
				@click="submit"
			>
				<Icon name="push" :size="13" /> Push
			</button>
		</template>
	</ModalDialog>
</template>

<style scoped>
.row2 {
	display: grid;
	grid-template-columns: 1fr 1fr;
	gap: 10px;
}
.field {
	display: flex;
	flex-direction: column;
	gap: 5px;
	min-width: 0;
}
.label {
	font-size: 11.5px;
	color: var(--text-dim);
}
input[type="text"] {
	width: 100%;
}
.check {
	display: flex;
	align-items: center;
	gap: 7px;
	font-size: 12.5px;
	color: var(--text);
	cursor: pointer;
	user-select: none;
}
.danger-check {
	color: var(--diff-del-text);
}
.check input {
	accent-color: var(--accent);
	cursor: pointer;
}
.warn {
	display: flex;
	align-items: center;
	gap: 7px;
	color: var(--yellow);
	font-size: 12.5px;
}
</style>
