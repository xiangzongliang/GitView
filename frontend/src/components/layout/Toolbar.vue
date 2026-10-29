<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from "vue";
import { useRepo } from "../../stores/repo";
import { useRepos } from "../../stores/repos";
import { useUI } from "../../stores/ui";
import Icon from "../ui/Icon.vue";
import Tooltip from "../ui/Tooltip.vue";
import SelectMenu from "../ui/SelectMenu.vue";
import type { SelectEntry } from "../ui/types";

const repo = useRepo();
const repos = useRepos();
const ui = useUI();

const enabled = computed(() => !!repos.activePath);
const busy = computed(() => !!ui.opRunning);

// 与上游的差距：behind = 可拉取的提交数，ahead = 待推送的提交数
const behind = computed(() => repo.status?.behind || 0);
const ahead = computed(() => repo.status?.ahead || 0);
function countText(n: number): string {
	return n > 99 ? "99+" : String(n);
}

// ------------------------------------------------------------- search debounce
const search = ref(repo.logSearch);
let timer: ReturnType<typeof setTimeout> | null = null;
watch(search, (v) => {
	if (timer) clearTimeout(timer);
	timer = setTimeout(() => repo.setLogSearch(v), 400);
});
watch(
	() => repo.logSearch,
	(v) => {
		if (v !== search.value && !timer) search.value = v;
	},
);
onBeforeUnmount(() => {
	if (timer) clearTimeout(timer);
});

// ------------------------------------------------------------------ ref filter
const refMenuOptions = computed<SelectEntry[]>(() => {
	const opts: SelectEntry[] = [
		{ label: "所有分支", value: "all" },
		{ label: "当前分支 (HEAD)", value: "" },
	];
	const branches = (repo.refs?.branches || [])
		.filter((b) => !b.isRemote)
		.map((b) => ({ label: b.name, value: b.name, icon: "branch" }));
	const remotes = (repo.refs?.remotes || []).flatMap((r) =>
		(r.branches || []).map((b) => ({
			label: b.name,
			value: b.name,
			icon: "cloud",
		})),
	);
	const tags = (repo.refs?.tags || []).map((t) => ({
		label: t.name,
		value: "refs/tags/" + t.name,
		icon: "tag",
	}));
	if (branches.length) opts.push({ group: "本地分支", options: branches });
	if (remotes.length) opts.push({ group: "远程分支", options: remotes });
	if (tags.length) opts.push({ group: "标签", options: tags });
	return opts;
});

const refFilterIcon = computed(() => {
	const v = repo.logRef;
	if (v === "all") return "history";
	if (!v) return "commit";
	if (v.startsWith("refs/tags/")) return "tag";
	return "branch";
});
</script>

<template>
	<div class="toolbar">
		<!-- view tabs -->
		<div class="tabs">
			<button
				class="tab"
				:class="{ active: repo.view === 'history' }"
				:disabled="!enabled"
				@click="repo.setView('history')"
			>
				<Icon name="history" :size="13" />
				历史
			</button>
			<button
				class="tab"
				:class="{ active: repo.view === 'status' }"
				:disabled="!enabled"
				@click="repo.setView('status')"
			>
				<Icon name="file" :size="13" />
				文件状态
				<span v-if="repo.dirtyCount > 0" class="badge">{{
					repo.dirtyCount
				}}</span>
			</button>
		</div>

		<div class="sep" />

		<!-- git actions: icon-only, tooltip on hover -->
		<Tooltip text="Fetch（所有远程，含 prune）">
			<button
				class="btn-icon tool-btn"
				:disabled="!enabled || busy"
				@click="repo.fetch('', true)"
			>
				<Icon name="fetch" :size="15" :spin="ui.isOp('fetch')" />
			</button>
		</Tooltip>
		<Tooltip :text="behind ? `Pull：落后上游 ${behind} 个提交` : 'Pull'">
			<button
				class="btn-icon tool-btn"
				:disabled="!enabled || busy"
				@click="ui.openDialog('pull')"
			>
				<Icon name="pull" :size="15" :spin="ui.isOp('pull')" />
				<span
					v-if="behind && !ui.isOp('pull')"
					class="tool-count pull"
					>{{ countText(behind) }}</span
				>
			</button>
		</Tooltip>
		<Tooltip :text="ahead ? `Push：待推送 ${ahead} 个提交` : 'Push'">
			<button
				class="btn-icon tool-btn"
				:disabled="!enabled || busy"
				@click="ui.openDialog('push')"
			>
				<Icon name="push" :size="15" :spin="ui.isOp('push')" />
				<span
					v-if="ahead && !ui.isOp('push')"
					class="tool-count push"
					>{{ countText(ahead) }}</span
				>
			</button>
		</Tooltip>

		<div class="sep" />

		<Tooltip text="新建分支">
			<button
				class="btn-icon tool-btn"
				:disabled="!enabled || busy"
				@click="ui.openDialog('branch')"
			>
				<Icon name="branch" :size="15" :spin="ui.isOp('branch')" />
			</button>
		</Tooltip>
		<Tooltip text="合并">
			<button
				class="btn-icon tool-btn"
				:disabled="!enabled || busy"
				@click="ui.openDialog('merge')"
			>
				<Icon
					name="merge"
					:size="15"
					:spin="ui.isOp('merge') || ui.isOp('rebase')"
				/>
			</button>
		</Tooltip>
		<Tooltip text="Stash 当前更改">
			<button
				class="btn-icon tool-btn"
				:disabled="!enabled || busy"
				@click="ui.openDialog('stash')"
			>
				<Icon name="stash" :size="15" :spin="ui.isOp('stash')" />
			</button>
		</Tooltip>

		<div class="spacer" />

		<!-- ref filter + search + terminal + refresh -->
		<SelectMenu
			class="ref-select"
			:model-value="repo.logRef"
			:options="refMenuOptions"
			:icon="refFilterIcon"
			:disabled="!enabled"
			:max-height="360"
			:min-width="220"
			@update:model-value="repo.setLogRef($event)"
		/>

		<div class="search-box">
			<Icon name="search" :size="12" class="search-icon" />
			<input
				v-model="search"
				type="text"
				placeholder="搜索提交信息…"
				:disabled="!enabled"
				spellcheck="false"
			/>
			<button
				v-if="search"
				class="btn-icon search-clear"
				title="清除"
				@click="search = ''"
			>
				<Icon name="x" :size="11" />
			</button>
		</div>

		<Tooltip text="终端（⌃`）">
			<button
				class="btn-icon tool-btn"
				:class="{ active: ui.terminalOpen }"
				:disabled="!enabled"
				@click="ui.toggleTerminal()"
			>
				<Icon name="terminal" :size="15" />
			</button>
		</Tooltip>

		<Tooltip text="刷新">
			<button
				class="btn-icon tool-btn"
				:disabled="!enabled || busy"
				@click="repo.refreshAll()"
			>
				<Icon name="refresh" :size="15" :spin="busy" />
			</button>
		</Tooltip>
	</div>
</template>

<style scoped>
.tabs {
	display: flex;
	gap: 2px;
	background: var(--bg-input);
	border: 1px solid var(--border);
	border-radius: 7px;
	padding: 2px;
}
.tab {
	display: inline-flex;
	align-items: center;
	gap: 5px;
	height: 24px;
	padding: 0 10px;
	border-radius: 5px;
	font-size: 12px;
	color: var(--text-dim);
	border: 1px solid transparent;
}
.tab:hover:not(:disabled) {
	color: var(--text-strong);
}
/* 选中态：扁平实底 + 细描边，无投影/发光效果 */
.tab.active {
	background: var(--bg-panel-2);
	color: var(--accent);
	font-weight: 600;
	border-color: var(--border-strong);
}
.tab.active:hover:not(:disabled) {
	color: var(--accent);
}
.badge {
	min-width: 16px;
	height: 15px;
	padding: 0 4px;
	border-radius: 8px;
	background: var(--accent);
	color: var(--accent-fg);
	font-size: 10px;
	line-height: 15px;
	text-align: center;
}
.sep {
	width: 1px;
	height: 20px;
	background: var(--border-strong);
	flex: none;
}
.spacer {
	flex: 1;
}
.tool-btn {
	position: relative;
	width: 28px;
	height: 26px;
	border-radius: 6px;
	flex: none;
}
/* 需拉取 / 待推送的提交数角标 */
.tool-count {
	position: absolute;
	top: -3px;
	right: -4px;
	min-width: 15px;
	height: 15px;
	padding: 0 4px;
	border: 1.5px solid var(--bg-panel);
	border-radius: 8px;
	background: var(--accent);
	color: var(--accent-fg);
	font-size: 9.5px;
	font-weight: 700;
	line-height: 12px;
	text-align: center;
	pointer-events: none;
}
.tool-count.pull {
	background: var(--green);
}
.tool-btn.active {
	color: var(--accent);
	background: var(--bg-selected);
}
.ref-select {
	max-width: 220px;
}
/* 分支选择器设置最小宽度：短分支名（如 main）也不会塌成一个小按钮 */
.ref-select :deep(.sm-trigger) {
	min-width: 170px;
}
.search-box {
	position: relative;
	display: flex;
	align-items: center;
	width: 190px;
}
.search-box input {
	width: 100%;
	height: 26px;
	padding: 0 26px 0 26px;
	font-size: 12px;
}
.search-icon {
	position: absolute;
	left: 8px;
	color: var(--text-faint);
	pointer-events: none;
}
.search-clear {
	position: absolute;
	right: 3px;
	width: 18px;
	height: 18px;
}
</style>
