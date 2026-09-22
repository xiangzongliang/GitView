<script setup lang="ts">
import { computed, ref } from "vue";
import { useRepo } from "../../stores/repo";
import { useUI } from "../../stores/ui";
import ModalDialog from "../ui/ModalDialog.vue";
import Icon from "../ui/Icon.vue";
import Checkbox from "../ui/Checkbox.vue";
import SelectMenu from "../ui/SelectMenu.vue";
import type { SelectEntry } from "../ui/types";

const props = defineProps<{ payload?: { ref?: string } }>();
const emit = defineEmits<{ (e: "close"): void }>();

const repo = useRepo();
const ui = useUI();

const target = ref(props.payload?.ref || "");
const noFF = ref(false);
const squash = ref(false);

const current = computed(() => repo.status?.branch || "");

const localBranches = computed(() =>
	(repo.refs?.branches || []).filter(
		(b) => !b.isRemote && b.name !== current.value,
	),
);
const remoteBranches = computed(() =>
	(repo.refs?.branches || []).filter((b) => b.isRemote),
);
const tags = computed(() => repo.refs?.tags || []);

const targetOptions = computed<SelectEntry[]>(() => {
	const opts: SelectEntry[] = [];
	const locals = localBranches.value.map((b) => ({
		label: b.name,
		value: b.name,
		icon: "branch",
	}));
	const remotes = remoteBranches.value.map((b) => ({
		label: b.name,
		value: b.name,
		icon: "cloud",
	}));
	const tagOpts = tags.value.map((t) => ({
		label: t.name,
		value: "refs/tags/" + t.name,
		icon: "tag",
	}));
	if (locals.length) opts.push({ group: "本地分支", options: locals });
	if (remotes.length) opts.push({ group: "远程分支", options: remotes });
	if (tagOpts.length) opts.push({ group: "标签", options: tagOpts });
	return opts;
});

const valid = computed(() => !!target.value);

async function submit() {
	if (!valid.value || ui.opRunning) return;
	emit("close");
	await repo.merge({
		ref: target.value,
		noFF: noFF.value,
		squash: squash.value,
	});
}
</script>

<template>
	<ModalDialog title="合并到当前分支" :width="480" @close="emit('close')">
		<p class="into">
			合并进：<span class="chip chip-current"
				><Icon name="branch" :size="10" /> {{ current || "HEAD" }}</span
			>
		</p>
		<label class="field">
			<span class="label">要合并的引用 *</span>
			<SelectMenu
				v-model="target"
				:options="targetOptions"
				placeholder="选择分支或标签…"
				full-width
				:max-height="300"
			/>
		</label>
		<label class="check">
			<Checkbox v-model="noFF" :disabled="squash" />
			总是生成合并提交（--no-ff）
		</label>
		<label class="check">
			<Checkbox v-model="squash" :disabled="noFF" />
			压缩为单个提交（--squash，不自动提交）
		</label>
		<template #footer>
			<button class="btn" @click="emit('close')">取消</button>
			<button
				class="btn btn-primary"
				:disabled="!valid || !!ui.opRunning"
				@click="submit"
			>
				<Icon name="merge" :size="13" /> 开始合并
			</button>
		</template>
	</ModalDialog>
</template>

<style scoped>
.into {
	display: flex;
	align-items: center;
	gap: 8px;
	font-size: 12.5px;
	color: var(--text-dim);
}
.field {
	display: flex;
	flex-direction: column;
	gap: 5px;
}
.label {
	font-size: 11.5px;
	color: var(--text-dim);
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
</style>
