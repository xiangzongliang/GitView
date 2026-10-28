<script setup lang="ts">
import { computed, ref } from "vue";
import { useRepo } from "../../stores/repo";
import { useUI } from "../../stores/ui";
import ModalDialog from "../ui/ModalDialog.vue";
import Icon from "../ui/Icon.vue";
import Checkbox from "../ui/Checkbox.vue";
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

function defaultBranch(): string {
	const st = repo.status;
	if (!st) return "";
	if (st.upstream) {
		const prefix = remote.value + "/";
		if (st.upstream.startsWith(prefix))
			return st.upstream.slice(prefix.length);
		const i = st.upstream.indexOf("/");
		if (i >= 0) return st.upstream.slice(i + 1);
		return st.upstream;
	}
	return st.detached ? "" : st.branch || "";
}
const branch = ref(defaultBranch());

const rebase = ref(false);
const autostash = ref(false);

const valid = computed(() => !!remote.value);

async function submit() {
	if (!valid.value || ui.opRunning) return;
	emit("close");
	await repo.pull({
		remote: remote.value,
		branch: branch.value.trim(),
		rebase: rebase.value,
		autostash: autostash.value,
	});
}
</script>

<template>
	<ModalDialog title="Pull 拉取" :width="480" @close="emit('close')">
		<div v-if="!remotes.length" class="warn">
			<Icon name="alert" :size="13" /> 此仓库没有配置远程，无法拉取。
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
					<span class="label">分支（留空 = 当前分支的上游）</span>
					<input
						v-model="branch"
						type="text"
						spellcheck="false"
						placeholder="main"
					/>
				</label>
			</div>
			<div class="check">
				<Checkbox v-model="rebase"
					>使用 rebase 代替 merge（--rebase）</Checkbox
				>
			</div>
			<div class="check">
				<Checkbox v-model="autostash"
					>自动 Stash / 恢复本地更改（--autostash）</Checkbox
				>
			</div>
		</template>
		<template #footer>
			<button class="btn" @click="emit('close')">取消</button>
			<button
				class="btn btn-primary"
				:disabled="!valid || !!ui.opRunning"
				@click="submit"
			>
				<Icon name="pull" :size="13" /> Pull
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
	font-size: 12.5px;
	color: var(--text);
}
.warn {
	display: flex;
	align-items: center;
	gap: 7px;
	color: var(--yellow);
	font-size: 12.5px;
}
</style>
