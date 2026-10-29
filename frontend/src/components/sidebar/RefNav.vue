<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { useRepo } from "../../stores/repo";
import { useUI } from "../../stores/ui";
import type { MenuItem } from "../../stores/ui";
import type { BranchInfo, RemoteInfo, TagInfo, StashEntry } from "../../api";
import { copyText } from "../../api";
import { relTime } from "../../utils/format";
import Icon from "../ui/Icon.vue";

const repo = useRepo();
const ui = useUI();

const collapsed = reactive<Record<string, boolean>>({});
const remoteOpen = reactive<Record<string, boolean>>({});
// branch folder tree: default collapsed
const branchFolderOpen = reactive<Record<string, boolean>>({});
// per-remote floating search — reactive Map survives re-renders
const remoteSearchOpen = reactive(new Map<string, boolean>());
const remoteSearch = reactive(new Map<string, string>());
function toggleRemoteSearch(rName: string) {
	const wasOpen = remoteSearchOpen.get(rName);
	if (wasOpen) {
		// close and clear text
		remoteSearch.set(rName, "");
		remoteSearchOpen.set(rName, false);
	} else {
		remoteSearchOpen.set(rName, true);
		remoteOpen[rName] = true;
	}
}
function clearAllRemoteSearch() {
	for (const rName of remoteSearchOpen.keys()) {
		remoteSearchOpen.set(rName, false);
	}
	for (const rName of remoteSearch.keys()) {
		remoteSearch.set(rName, "");
	}
}
// auto-close search popup when git operations run (checkout/pull/etc)
watch(
	() => ui.op,
	(op) => {
		if (op) clearAllRemoteSearch();
	},
);
// auto-close when view switches between history/status
watch(
	() => repo.view,
	() => {
		clearAllRemoteSearch();
	},
);
// auto-close when any dialog opens
watch(
	() => ui.dialog,
	(d) => {
		if (d) clearAllRemoteSearch();
	},
);
// auto-close when settings/terminal/debug panels open
watch(
	() => ui.settingsOpen,
	(v) => {
		if (v) clearAllRemoteSearch();
	},
);
watch(
	() => ui.terminalOpen,
	(v) => {
		if (v) clearAllRemoteSearch();
	},
);
watch(
	() => ui.debugOpen,
	(v) => {
		if (v) clearAllRemoteSearch();
	},
);
// auto-close when remote section collapses
watch(
	() => collapsed.remotes,
	(v) => {
		if (v) clearAllRemoteSearch();
	},
);
function toggleRemoteRow(rName: string) {
	remoteOpen[rName] = !remoteOpen[rName];
	if (!remoteOpen[rName]) {
		// collapsed: clear and close search too
		remoteSearch.set(rName, "");
		remoteSearchOpen.set(rName, false);
	}
}
function toggle(key: string) {
	collapsed[key] = !collapsed[key];
}
function isBranchFolderOpen(rName: string, folder: string): boolean {
	// auto-expand all folders while searching
	if ((remoteSearch.get(rName) || "").trim()) return true;
	return branchFolderOpen[rName + "/" + folder] === true;
}
function toggleBranchFolder(rName: string, folder: string) {
	const key = rName + "/" + folder;
	branchFolderOpen[key] = !isBranchFolderOpen(rName, folder);
}

/** Promise-based single-line input dialog. */
function prompt(opts: {
	title: string;
	label?: string;
	value?: string;
	placeholder?: string;
}): Promise<string> {
	return new Promise<string>((resolve) => {
		ui.openDialog("prompt", { ...opts, resolve });
	});
}

function menu(e: MouseEvent, items: MenuItem[]) {
	e.preventDefault();
	e.stopPropagation();
	ui.openMenu(e.clientX, e.clientY, items);
}

// -------------------------------------------------------------------- branches
const localBranches = computed<BranchInfo[]>(() => {
	const list = (repo.refs?.branches || []).filter((b) => !b.isRemote);
	return list.slice().sort((a, b) => {
		if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
		return a.name.localeCompare(b.name);
	});
});
const currentBranch = computed(() => repo.status?.branch || "");
const remotes = computed(() => repo.refs?.remotes || []);
const tags = computed<TagInfo[]>(() => repo.refs?.tags || []);
const stashes = computed<StashEntry[]>(() => repo.stashes || []);

function clickBranch(name: string) {
	repo.setView("history");
	repo.setLogRef(name);
}

async function checkoutBranch(b: BranchInfo) {
	if (b.isCurrent) return;
	await repo.checkout(b.name);
}

function branchMenu(e: MouseEvent, b: BranchInfo) {
	menu(e, [
		{
			label: "检出 " + b.name,
			icon: "check",
			disabled: b.isCurrent,
			action: () => checkoutBranch(b),
		},
		{
			label: "从此分支新建分支…",
			icon: "plus",
			action: () => ui.openDialog("branch", { start: b.name }),
		},
		{ separator: true },
		{
			label: "合并到当前分支…",
			icon: "merge",
			disabled: b.isCurrent,
			action: () => ui.openDialog("merge", { ref: b.name }),
		},
		{
			// 当前分支合并到…：把当前检出分支合并进选定的本地分支（向导式流程）
			label: b.isCurrent ? "当前分支合并到…" : "将当前分支合并到此分支…",
			icon: "merge",
			action: () => ui.openDialog("merge-into", { ref: b.name }),
		},
		{
			label: "将当前分支 rebase 到此分支",
			icon: "revert",
			disabled: b.isCurrent,
			action: () => repo.rebase(b.name),
		},
		{
			label: "拉取上游（不检出）",
			icon: "pull",
			disabled: !b.tracking || b.isCurrent,
			action: async () => {
				const idx = b.tracking.indexOf("/");
				if (idx === -1) return;
				const remote = b.tracking.substring(0, idx);
				const remoteBranch = b.tracking.substring(idx + 1);
				await repo.fetchBranch(remote, remoteBranch, b.name);
			},
		},
		{ separator: true },
		{
			label: "重命名…",
			icon: "edit",
			disabled: b.isCurrent,
			action: async () => {
				const name = await prompt({
					title: "重命名分支",
					label: "新名称",
					value: b.name,
				});
				if (name && name !== b.name)
					await repo.renameBranch(b.name, name);
			},
		},
		{ label: "复制分支名", icon: "copy", action: () => copyText(b.name) },
		{ separator: true },
		{
			label: "删除分支…",
			icon: "trash",
			danger: true,
			disabled: b.isCurrent,
			action: async () => {
				const ok = await ui.confirm({
					title: "删除分支",
					message:
						"确定删除本地分支 “" +
						b.name +
						"” 吗？\n未合并的更改将不会保留（安全模式）。",
					confirmLabel: "删除",
					danger: true,
				});
				if (ok) await repo.deleteBranch(b.name, false);
			},
		},
		{
			label: "强制删除分支…",
			icon: "trash",
			danger: true,
			disabled: b.isCurrent,
			action: async () => {
				const ok = await ui.confirm({
					title: "强制删除分支",
					message:
						"强制删除 “" +
						b.name +
						"”？即使包含未合并的提交也会被删除，且无法轻易恢复。",
					confirmLabel: "强制删除",
					danger: true,
				});
				if (ok) await repo.deleteBranch(b.name, true);
			},
		},
	]);
}

// --------------------------------------------------------------------- remotes
function shortName(full: string, remote: string): string {
	const prefix = remote + "/";
	return full.startsWith(prefix) ? full.slice(prefix.length) : full;
}

// ---- branch tree grouping
interface BranchTreeBranch {
	type: "branch";
	branch: BranchInfo;
}
interface BranchTreeFolder {
	type: "folder";
	name: string;
	branches: { branch: BranchInfo; short: string; leaf: string }[];
}
type BranchTreeItem = BranchTreeBranch | BranchTreeFolder;

/** Group a remote's branches by the first path segment (before /). */
function getBranchTreeItems(remote: RemoteInfo): BranchTreeItem[] {
	const q = (remoteSearch.get(remote.name) || "").trim().toLowerCase();
	const folders = new Map<
		string,
		{ branch: BranchInfo; short: string; leaf: string }[]
	>();
	const flat: BranchTreeBranch[] = [];

	for (const b of remote.branches || []) {
		const short = shortName(b.name, remote.name);
		// fuzzy filter by query
		if (q && !short.toLowerCase().includes(q)) continue;

		const idx = short.indexOf("/");
		if (idx === -1) {
			flat.push({ type: "branch", branch: b });
		} else {
			const folder = short.substring(0, idx);
			const leaf = short.substring(idx + 1);
			if (!folders.has(folder)) folders.set(folder, []);
			folders.get(folder)!.push({ branch: b, short, leaf });
		}
	}

	// Sort folders alphabetically, branches within each folder by leaf name
	const result: BranchTreeItem[] = [...flat];
	const sortedFolders = [...folders.entries()].sort((a, b) =>
		a[0].localeCompare(b[0]),
	);
	for (const [name, branches] of sortedFolders) {
		branches.sort((a, b) => a.leaf.localeCompare(b.leaf));
		result.push({ type: "folder", name, branches });
	}
	return result;
}

async function checkoutRemoteBranch(full: string, remote: string) {
	const short = shortName(full, remote);
	const local = localBranches.value.find((b) => b.name === short);
	if (local) {
		await repo.checkout(short);
		return;
	}
	const ok = await ui.confirm({
		title: "检出远程分支",
		message:
			"将基于 “" + full + "” 创建本地跟踪分支 “" + short + "” 并检出。",
		confirmLabel: "检出",
	});
	if (ok) await repo.checkout(short);
}

function remoteBranchMenu(e: MouseEvent, b: BranchInfo) {
	const rName = b.remote;
	const short = shortName(b.name, rName);
	menu(e, [
		{
			label: "检出为本地分支 " + short,
			icon: "check",
			action: () => checkoutRemoteBranch(b.name, rName),
		},
		{
			label: "合并到当前分支…",
			icon: "merge",
			action: () => ui.openDialog("merge", { ref: b.name }),
		},
		{
			label: "从此分支新建分支…",
			icon: "plus",
			action: () => ui.openDialog("branch", { start: b.name }),
		},
		{
			label: "Pull 到当前分支",
			icon: "pull",
			action: () =>
				repo.pull({
					remote: rName,
					branch: short,
					rebase: false,
					autostash: false,
				}),
		},
		{ separator: true },
		{ label: "复制分支名", icon: "copy", action: () => copyText(short) },
		{
			label: "删除远程分支…",
			icon: "trash",
			danger: true,
			action: async () => {
				const ok = await ui.confirm({
					title: "删除远程分支",
					message:
						"确定删除 " +
						rName +
						" 上的分支 “" +
						short +
						"” 吗？此操作会影响所有协作者。",
					confirmLabel: "删除",
					danger: true,
				});
				if (ok) await repo.deleteRemoteBranch(rName, short);
			},
		},
	]);
}

function remoteMenu(e: MouseEvent, name: string) {
	const cur = remotes.value.find((x) => x.name === name);
	menu(e, [
		{
			label: "Fetch " + name,
			icon: "fetch",
			action: () => repo.fetch(name, true),
		},
		{
			label: "复制 URL",
			icon: "copy",
			action: () => {
				if (cur?.url) copyText(cur.url);
			},
		},
		{ separator: true },
		{
			label: "编辑远程…",
			desc: "git remote rename / git remote set-url",
			icon: "edit",
			action: () => {
				ui.openDialog("remote-edit", { name, url: cur?.url || "" });
			},
		},
		{ separator: true },
		{
			label: "删除远程",
			desc: "git remote remove " + name,
			icon: "trash",
			danger: true,
			// 至少保留一个远程：只剩最后一个时禁用删除。
			disabled: remotes.value.length <= 1,
			action: async () => {
				const ok = await ui.confirm({
					title: "删除远程",
					message:
						"确定删除远程 “" +
						name +
						"” 吗？\n对应的远程跟踪分支也会一并删除。",
					confirmLabel: "删除",
					danger: true,
				});
				if (ok) await repo.removeRemote(name);
			},
		},
	]);
}

// ------------------------------------------------------------------------ tags
function tagMenu(e: MouseEvent, t: TagInfo) {
	menu(e, [
		{
			label: "检出 " + t.name + "（分离头指针）",
			icon: "check",
			action: async () => {
				const ok = await ui.confirm({
					title: "检出标签",
					message:
						"检出标签 “" +
						t.name +
						"” 将进入分离头指针状态，新提交不会属于任何分支。",
					confirmLabel: "检出",
				});
				if (ok) await repo.checkout("refs/tags/" + t.name);
			},
		},
		{
			label: "从此标签新建分支…",
			icon: "plus",
			action: () =>
				ui.openDialog("branch", { start: "refs/tags/" + t.name }),
		},
		{ label: "复制标签名", icon: "copy", action: () => copyText(t.name) },
		{ separator: true },
		{
			label: "删除标签…",
			icon: "trash",
			danger: true,
			action: async () => {
				const ok = await ui.confirm({
					title: "删除标签",
					message: "确定删除本地标签 “" + t.name + "” 吗？",
					confirmLabel: "删除",
					danger: true,
				});
				if (ok) await repo.deleteTag(t.name, "");
			},
		},
	]);
}

// ---------------------------------------------------------------------- stashes
function openStash(s: StashEntry) {
	ui.openDialog("stash-detail", {
		index: s.index,
		ref: s.ref,
		branch: s.branch,
		message: s.message,
		timestamp: s.timestamp,
	});
}

function stashMenu(e: MouseEvent, s: StashEntry) {
	menu(e, [
		{
			label: "查看详情（文件与差异）",
			icon: "eye",
			action: () => openStash(s),
		},
		{ separator: true },
		{
			label: "应用（保留 Stash）",
			desc: "git stash apply " + s.ref,
			icon: "stash",
			action: () => repo.stashApply(s.index),
		},
		{
			label: "应用（含暂存区 --index）",
			desc: "git stash apply --index " + s.ref,
			icon: "check",
			action: () => repo.stashApplyIndex(s.index),
		},
		{
			label: "弹出（应用并删除）",
			desc: "git stash pop " + s.ref,
			icon: "pull",
			action: () => repo.stashPop(s.index),
		},
		{
			label: "从该 Stash 新建分支…",
			icon: "branch",
			action: async () => {
				const name = await prompt({
					title: "从 Stash 新建分支",
					label: "新分支名（会切换到该分支并应用此 Stash）",
					value: "stash-fix-" + (s.branch || "branch"),
					placeholder: "例如 stash-fix-login",
				});
				if (name && name.trim())
					await repo.stashBranch(s.index, name.trim());
			},
		},
		{ separator: true },
		{
			label: "删除 Stash…",
			desc: "git stash drop " + s.ref,
			icon: "trash",
			danger: true,
			action: async () => {
				const ok = await ui.confirm({
					title: "删除 Stash",
					message:
						"确定删除 " +
						s.ref +
						"（" +
						(s.message || "无描述") +
						"）吗？此操作不可恢复。",
					confirmLabel: "删除",
					danger: true,
				});
				if (ok) await repo.stashDrop(s.index);
			},
		},
	]);
}

async function stashClearAll() {
	const ok = await ui.confirm({
		title: "清空所有 Stash",
		message: `确定清空全部 ${stashes.value.length} 个 Stash 吗？\n此操作不可恢复。`,
		confirmLabel: "全部删除",
		danger: true,
	});
	if (ok) await repo.stashClear();
}
</script>

<template>
	<div v-if="repo.path" class="ref-nav">
		<!-- branches -->
		<div class="sec">
			<div class="sec-head">
				<button class="sec-toggle" @click="toggle('branches')">
					<Icon
						:name="
							collapsed.branches
								? 'chevron-right'
								: 'chevron-down'
						"
						:size="12"
					/>
					<Icon name="branch" :size="12" />
					<span class="sec-title">分支</span>
					<span class="sec-count">{{ localBranches.length }}</span>
				</button>
				<button
					class="btn-icon sec-add"
					title="当前分支合并到…"
					@click="ui.openDialog('merge-into')"
				>
					<Icon name="merge" :size="12" />
				</button>
				<button
					class="btn-icon sec-add"
					title="新建分支…"
					@click="ui.openDialog('branch')"
				>
					<Icon name="plus" :size="12" />
				</button>
			</div>
			<template v-if="!collapsed.branches">
				<div
					v-for="b in localBranches"
					:key="b.name"
					class="nav-row"
					:class="{
						current: b.isCurrent,
						selected:
							repo.logRef === b.name && repo.view === 'history',
					}"
					:title="b.subject ? b.name + ' — ' + b.subject : b.name"
					@click="clickBranch(b.name)"
					@dblclick="checkoutBranch(b)"
					@contextmenu="branchMenu($event, b)"
				>
					<span class="dot" :class="{ on: b.isCurrent }" />
					<span class="nav-name">{{ b.name }}</span>
					<span v-if="b.ahead > 0" class="mini green"
						>↑{{ b.ahead }}</span
					>
					<span v-if="b.behind > 0" class="mini yellow"
						>↓{{ b.behind }}</span
					>
				</div>
				<div v-if="localBranches.length === 0" class="nav-empty">
					没有本地分支
				</div>
			</template>
		</div>

		<!-- remotes -->
		<div class="sec">
			<div class="sec-head">
				<button class="sec-toggle" @click="toggle('remotes')">
					<Icon
						:name="
							collapsed.remotes ? 'chevron-right' : 'chevron-down'
						"
						:size="12"
					/>
					<Icon name="cloud" :size="12" />
					<span class="sec-title">远程</span>
					<span class="sec-count">{{ remotes.length }}</span>
				</button>
				<button
					class="btn-icon sec-add"
					title="Fetch 所有远程"
					@click="repo.fetch('', true)"
				>
					<Icon name="fetch" :size="12" :spin="ui.isOp('fetch')" />
				</button>
				<button
					class="btn-icon sec-add"
					title="添加远程"
					@click="ui.openDialog('remote')"
				>
					<Icon name="plus" :size="12" />
				</button>
			</div>
			<template v-if="!collapsed.remotes">
				<template v-for="r in remotes" :key="r.name">
					<div class="remote-group">
						<div class="remote-row-wrap">
							<div
								class="nav-row remote-row"
								:title="r.url"
								@click="toggleRemoteRow(r.name)"
								@contextmenu="remoteMenu($event, r.name)"
							>
								<Icon
									:name="
										remoteOpen[r.name]
											? 'chevron-down'
											: 'chevron-right'
									"
									:size="12"
									class="faint"
								/>
								<Icon
									name="cloud"
									:size="12"
									class="purple-ic"
								/>
								<span class="nav-name">{{ r.name }}</span>
								<button
									class="branch-search-trigger"
									@click.stop="toggleRemoteSearch(r.name)"
									:title="
										remoteSearchOpen.get(r.name)
											? '关闭筛选'
											: '筛选分支'
									"
								>
									<Icon name="search" :size="10" />
								</button>
								<span class="sec-count">{{
									(r.branches || []).length
								}}</span>
							</div>
							<!-- floating search popup -->
							<div
								v-if="
									remoteSearchOpen.get(r.name) ||
									(remoteSearch.get(r.name) || '').trim()
								"
								class="branch-search-floating"
							>
								<div class="branch-search">
									<Icon
										name="search"
										:size="11"
										class="branch-search-icon"
									/>
									<input
										:value="remoteSearch.get(r.name) || ''"
										@input="
											remoteSearch.set(
												r.name,
												(
													$event.target as HTMLInputElement
												).value,
											)
										"
										type="text"
										placeholder="筛选分支…"
										spellcheck="false"
									/>
									<button
										v-if="remoteSearch.get(r.name)"
										class="btn-icon branch-search-clear"
										title="清除"
										@click="
											remoteSearch.set(r.name, '');
											remoteSearchOpen.set(r.name, false);
										"
									>
										<Icon name="x" :size="10" />
									</button>
								</div>
							</div>
						</div>
						<div v-if="remoteOpen[r.name]" class="child-body">
							<template
								v-for="item in getBranchTreeItems(r)"
								:key="
									item.type === 'branch'
										? item.branch.name
										: 'folder-' + item.name
								"
							>
								<!-- flat branch -->
								<div
									v-if="item.type === 'branch'"
									class="nav-row child"
									:class="{
										selected:
											repo.logRef === item.branch.name &&
											repo.view === 'history',
									}"
									:title="
										item.branch.subject
											? item.branch.name +
												' — ' +
												item.branch.subject
											: item.branch.name
									"
									@click="clickBranch(item.branch.name)"
									@dblclick="
										checkoutRemoteBranch(
											item.branch.name,
											r.name,
										)
									"
									@contextmenu="
										remoteBranchMenu($event, item.branch)
									"
								>
									<Icon
										name="branch"
										:size="11"
										class="faint"
									/>
									<span class="nav-name">{{
										shortName(item.branch.name, r.name)
									}}</span>
								</div>
								<!-- folder -->
								<template v-else>
									<div
										class="nav-row child folder-row"
										@click="
											toggleBranchFolder(
												r.name,
												item.name,
											)
										"
									>
										<Icon
											:name="
												isBranchFolderOpen(
													r.name,
													item.name,
												)
													? 'chevron-down'
													: 'chevron-right'
											"
											:size="12"
											class="faint"
										/>
										<Icon
											name="folder"
											:size="11"
											class="faint"
										/>
										<span class="nav-name">{{
											item.name
										}}</span>
										<span class="sec-count">{{
											item.branches.length
										}}</span>
									</div>
									<div
										v-if="
											isBranchFolderOpen(
												r.name,
												item.name,
											)
										"
										class="child-body"
									>
										<div
											v-for="sub in item.branches"
											:key="sub.branch.name"
											class="nav-row child child-deep"
											:class="{
												selected:
													repo.logRef ===
														sub.branch.name &&
													repo.view === 'history',
											}"
											:title="
												sub.branch.subject
													? sub.branch.name +
														' — ' +
														sub.branch.subject
													: sub.branch.name
											"
											@click="
												clickBranch(sub.branch.name)
											"
											@dblclick="
												checkoutRemoteBranch(
													sub.branch.name,
													r.name,
												)
											"
											@contextmenu="
												remoteBranchMenu(
													$event,
													sub.branch,
												)
											"
										>
											<Icon
												name="branch"
												:size="11"
												class="faint"
											/>
											<span class="nav-name">{{
												sub.leaf
											}}</span>
										</div>
									</div>
								</template>
							</template>
							<div
								v-if="(r.branches || []).length === 0"
								class="nav-empty child"
							>
								没有远程分支（试试 Fetch）
							</div>
							<div
								v-else-if="getBranchTreeItems(r).length === 0"
								class="nav-empty child"
							>
								没有匹配的分支
							</div>
						</div>
					</div>
				</template>
				<div v-if="remotes.length === 0" class="nav-empty">
					没有配置远程（点 + 添加）
				</div>
			</template>
		</div>

		<!-- tags -->
		<div class="sec">
			<div class="sec-head">
				<button class="sec-toggle" @click="toggle('tags')">
					<Icon
						:name="
							collapsed.tags ? 'chevron-right' : 'chevron-down'
						"
						:size="12"
					/>
					<Icon name="tag" :size="12" />
					<span class="sec-title">标签</span>
					<span class="sec-count">{{ tags.length }}</span>
				</button>
			</div>
			<template v-if="!collapsed.tags">
				<div
					v-for="t in tags"
					:key="t.name"
					class="nav-row"
					:class="{
						selected:
							repo.logRef === 'refs/tags/' + t.name &&
							repo.view === 'history',
					}"
					:title="t.subject ? t.name + ' — ' + t.subject : t.name"
					@click="clickBranch('refs/tags/' + t.name)"
					@contextmenu="tagMenu($event, t)"
				>
					<Icon name="tag" :size="11" class="yellow-ic" />
					<span class="nav-name">{{ t.name }}</span>
					<span class="mini faint">{{ relTime(t.timestamp) }}</span>
				</div>
				<div v-if="tags.length === 0" class="nav-empty">没有标签</div>
			</template>
		</div>

		<!-- stashes -->
		<div class="sec">
			<div class="sec-head">
				<button class="sec-toggle" @click="toggle('stashes')">
					<Icon
						:name="
							collapsed.stashes ? 'chevron-right' : 'chevron-down'
						"
						:size="12"
					/>
					<Icon name="stash" :size="12" />
					<span class="sec-title">Stash</span>
					<span class="sec-count">{{ stashes.length }}</span>
				</button>
				<button
					v-if="stashes.length > 0"
					class="btn-icon sec-add"
					title="清空所有 Stash…"
					@click="stashClearAll"
				>
					<Icon name="trash" :size="12" />
				</button>
				<button
					class="btn-icon sec-add"
					title="Stash 当前更改…"
					@click="ui.openDialog('stash')"
				>
					<Icon name="plus" :size="12" />
				</button>
			</div>
			<template v-if="!collapsed.stashes">
				<div
					v-for="s in stashes"
					:key="s.ref"
					class="nav-row"
					:title="
						s.message + (s.branch ? '（' + s.branch + '）' : '')
					"
					@click="openStash(s)"
					@contextmenu="stashMenu($event, s)"
				>
					<Icon name="stash" :size="11" class="faint" />
					<span class="nav-name">{{ s.message || s.ref }}</span>
					<span class="mini faint">{{ relTime(s.timestamp) }}</span>
				</div>
				<div v-if="stashes.length === 0" class="nav-empty">
					没有 Stash
				</div>
			</template>
		</div>
	</div>
</template>

<style scoped>
.ref-nav {
	padding-bottom: 12px;
	border-top: 1px solid var(--border);
	margin-top: 6px;
}
.sec-head {
	display: flex;
	align-items: center;
	padding: 6px 6px 4px 8px;
	position: sticky;
	top: 0;
	background: var(--bg-sidebar);
	z-index: 1;
}
.sec-toggle {
	flex: 1;
	min-width: 0;
	display: flex;
	align-items: center;
	gap: 5px;
	color: var(--text-faint);
	padding: 2px 4px;
	border-radius: 4px;
}
.sec-toggle:hover {
	color: var(--text-strong);
	background: var(--bg-hover);
}
.sec-title {
	font-size: 11px;
	font-weight: 600;
	text-transform: uppercase;
	letter-spacing: 0.06em;
}
.sec-count {
	font-size: 10px;
	color: var(--text-faint);
	background: var(--hover-soft);
	border-radius: 7px;
	padding: 0 5px;
	line-height: 14px;
}
.sec-add {
	width: 20px;
	height: 20px;
	flex: none;
}
.branch-search-trigger {
	width: 16px;
	height: 16px;
	flex: none;
	color: var(--text-faint);
	border-radius: 3px;
	display: flex;
	align-items: center;
	justify-content: center;
}
.branch-search-trigger:hover {
	color: var(--text-strong);
	background: var(--bg-hover);
}
.nav-row {
	display: flex;
	align-items: center;
	gap: 6px;
	/* 一级项：与各分区下的条目统一缩进（见 style.css 的 --sb-l1） */
	padding: 4px 10px 4px calc(var(--sb-l1) - var(--sb-gutter));
	margin: 0 6px;
	border-radius: 6px;
	cursor: pointer;
	color: var(--text);
	font-size: 12.5px;
}
.nav-row:hover {
	background: var(--bg-hover);
}
.nav-row.selected {
	background: var(--bg-selected);
	color: var(--text-strong);
}
.nav-row.current .nav-name {
	color: var(--green);
	font-weight: 600;
}
/* 二级项（远程分支等）：在引导线基础上再缩进一级 */
.nav-row.child {
	padding-left: calc(var(--sb-l2) - var(--sb-gutter));
}
/* 三级项（文件夹内的远程分支）：再缩进一级 */
.nav-row.child-deep {
	padding-left: calc(var(--sb-l2) + 18px);
}
/* 远程分支容器：树形层级引导线（与远程图标左缘对齐） */
.child-body {
	position: relative;
}
.child-body::before {
	content: "";
	position: absolute;
	left: var(--sb-guide);
	top: 1px;
	bottom: 1px;
	width: 1px;
	background: var(--tree-line);
	pointer-events: none;
}

/* 远程分支搜索框 */
.branch-search {
	position: relative;
	display: flex;
	align-items: center;
	margin: 2px 4px 4px 4px;
}
.branch-search input {
	width: 100%;
	height: 24px;
	padding: 0 24px 0 26px;
	font-size: 11.5px;
	border-radius: 5px;
	border: 1px solid var(--border);
	background: var(--bg-input);
	color: var(--text);
}
.branch-search input::placeholder {
	color: var(--text-faint);
}
.branch-search input:focus {
	border-color: var(--accent);
	outline: none;
}
.branch-search-icon {
	position: absolute;
	left: 7px;
	color: var(--text-faint);
	pointer-events: none;
}
.branch-search-clear {
	position: absolute;
	right: 2px;
	width: 18px;
	height: 18px;
	flex: none;
}

/* remote group: anchor for floating search popup */
.remote-row-wrap {
	position: relative;
}

/* floating search popup: absolutely positioned, no layout jitter */
.branch-search-floating {
	position: absolute;
	top: 100%;
	right: 52px;
	width: 150px;
	z-index: 5;
	background: var(--bg-panel);
	border: 1px solid var(--border-strong);
	border-radius: 6px;
	box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
	padding: 3px;
}
.branch-search-floating .branch-search {
	margin: 0;
}

.remote-row {
	color: var(--text);
}
.nav-name {
	flex: 1;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.mini {
	flex: none;
	font-size: 10px;
}
.dot {
	width: 7px;
	height: 7px;
	border-radius: 50%;
	flex: none;
	background: var(--border-strong);
}
.dot.on {
	background: var(--green);
	box-shadow: 0 0 5px var(--glow-green);
}
.purple-ic {
	color: var(--purple);
	flex: none;
}
.yellow-ic {
	color: var(--yellow);
	flex: none;
}
.nav-empty {
	padding: 3px 16px 5px var(--sb-l1);
	font-size: 11px;
	color: var(--text-faint);
}
.nav-empty.child {
	padding-left: var(--sb-l2);
}
</style>
