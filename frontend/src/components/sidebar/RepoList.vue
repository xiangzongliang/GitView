<script setup lang="ts">
import { computed, ref } from "vue";
import { useRepos } from "../../stores/repos";
import { useUI } from "../../stores/ui";
import { pickDirectory } from "../../api";
import type { RepoEntry } from "../../api";
import Icon from "../ui/Icon.vue";

const repos = useRepos();
const ui = useUI();

// ---------- 分组视图 ----------

interface GroupView {
	name: string;
	entries: RepoEntry[];
	hasHeader: boolean;
}

const groupsView = computed<GroupView[]>(() => {
	const gs = repos.groups;
	const hasNamed = gs.some((g) => g.name !== "");
	return gs.map((g) => ({ ...g, hasHeader: g.name !== "" || hasNamed }));
});

function groupOf(e: RepoEntry | undefined): string {
	return e?.group || "";
}

// 复用 PromptDialog（DialogHost 的 'prompt' kind，带 resolve 回调）
function promptText(opts: {
	title: string;
	label: string;
	value?: string;
	placeholder?: string;
}): Promise<string> {
	return new Promise((resolve) => {
		ui.openDialog("prompt", { ...opts, resolve });
	});
}

function openAddMenu(e: MouseEvent) {
	ui.openMenu(e.clientX, e.clientY, [
		{
			label: "打开本地仓库…",
			icon: "folder",
			action: () => repos.pickAndOpen(),
		},
		{
			label: "克隆远程仓库…",
			icon: "cloud",
			action: () => ui.openDialog("clone"),
		},
		{ label: "初始化新仓库…", icon: "plus", action: initRepo },
		{ label: "新建分组…", icon: "folder", action: newGroup },
	]);
}

async function newGroup() {
	const name = (
		await promptText({
			title: "新建分组",
			label: "分组名称",
			placeholder: "输入分组名称",
		})
	).trim();
	if (name) repos.createGroup(name);
}

async function renameGroup(name: string) {
	const newName = (
		await promptText({
			title: "重命名分组",
			label: "分组名称",
			value: name,
		})
	).trim();
	if (newName) await repos.renameGroup(name, newName);
}

async function initRepo() {
	const dir = await pickDirectory("选择用于初始化 Git 仓库的目录");
	if (dir) await repos.initRepo(dir);
}

function repoMenu(e: MouseEvent, path: string) {
	e.preventDefault();
	const entry = repos.entries.find((r) => r.path === path);
	ui.openMenu(e.clientX, e.clientY, [
		{
			label: "在 Finder 中显示",
			icon: "external",
			disabled: entry?.missing,
			action: () => repos.reveal(path),
		},
		{
			label: "从列表移除",
			icon: "trash",
			danger: true,
			action: async () => {
				const ok = await ui.confirm({
					title: "移除仓库",
					message:
						"仅从 Git View 列表中移除，不会删除磁盘上的任何文件。\n\n" +
						(entry?.name || path),
					confirmLabel: "移除",
				});
				if (ok) await repos.remove(path);
			},
		},
	]);
}

function groupMenu(e: MouseEvent, name: string) {
	e.preventDefault();
	ui.openMenu(e.clientX, e.clientY, [
		{ label: "重命名分组…", icon: "edit", action: () => renameGroup(name) },
		{
			label: "解散分组",
			icon: "x",
			danger: true,
			action: async () => {
				const ok = await ui.confirm({
					title: "解散分组",
					message: `分组 “${name}” 将被移除，组内仓库变为未分组。\n\n仓库本身不会被删除。`,
					confirmLabel: "解散",
				});
				if (ok) await repos.dissolveGroup(name);
			},
		},
	]);
}

// ---------- 拖拽 ----------

type DropTarget =
	| { type: "repo"; path: string; pos: "before" | "after" }
	| { type: "group"; name: string; pos?: "before" | "after" };

const dragData = ref<
	{ type: "repo"; path: string } | { type: "group"; name: string } | null
>(null);
const dropTarget = ref<DropTarget | null>(null);

function setTarget(t: DropTarget | null) {
	const cur = dropTarget.value;
	if (
		cur === t ||
		(cur &&
			t &&
			cur.type === t.type &&
			(cur as any).path === (t as any).path &&
			(cur as any).name === (t as any).name &&
			(cur as any).pos === (t as any).pos)
	) {
		return;
	}
	dropTarget.value = t;
}

function clearDrag() {
	dragData.value = null;
	dropTarget.value = null;
}

function onRepoDragStart(e: DragEvent, path: string) {
	dragData.value = { type: "repo", path };
	e.dataTransfer?.setData("text/plain", path);
	if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
}

function onGroupDragStart(e: DragEvent, name: string) {
	// 未分组头不可拖；空分组没有可移动的块，也不拖
	if (!name || !repos.groups.find((g) => g.name === name)?.entries.length) {
		e.preventDefault();
		return;
	}
	dragData.value = { type: "group", name };
	e.dataTransfer?.setData("text/plain", name);
	if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
}

function onRepoDragOver(e: DragEvent, path: string) {
	const d = dragData.value;
	if (!d || d.type !== "repo") return;
	e.preventDefault();
	if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
	if (d.path === path) {
		setTarget(null);
		return;
	}
	const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
	const before = e.clientY < rect.top + rect.height / 2;
	setTarget({ type: "repo", path, pos: before ? "before" : "after" });
}

function onGroupDragOver(e: DragEvent, name: string) {
	const d = dragData.value;
	if (!d) return;
	e.preventDefault();
	if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
	if (d.type === "repo") {
		if (groupOf(repos.entries.find((r) => r.path === d.path)) === name) {
			setTarget(null);
			return;
		}
		setTarget({ type: "group", name });
	} else {
		if (d.name === name) {
			setTarget(null);
			return;
		}
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		// 未分组固定在最后：只允许插到它前面
		const before = name === "" || e.clientY < rect.top + rect.height / 2;
		setTarget({ type: "group", name, pos: before ? "before" : "after" });
	}
}

function onRepoRowDrop(e: DragEvent, path: string) {
	e.preventDefault();
	const d = dragData.value;
	const t = dropTarget.value;
	if (
		d?.type === "repo" &&
		t?.type === "repo" &&
		t.path === path &&
		d.path !== path
	) {
		repos.applyLayout(
			moveRepoRelativeTo(repos.entries, d.path, path, t.pos === "before"),
		);
	}
	clearDrag();
}

function onGroupHeadDrop(e: DragEvent, name: string) {
	e.preventDefault();
	const d = dragData.value;
	const t = dropTarget.value;
	if (d && t && t.type === "group" && t.name === name) {
		if (d.type === "repo") {
			if (
				groupOf(repos.entries.find((r) => r.path === d.path)) !== name
			) {
				repos.applyLayout(moveRepoToGroup(repos.entries, d.path, name));
			}
		} else if (d.name !== name) {
			const pos = name === "" ? "before" : t.pos || "before";
			repos.applyLayout(
				moveGroup(repos.entries, d.name, name, pos === "before"),
			);
		}
	}
	clearDrag();
}

function onListDragLeave(e: DragEvent) {
	const related = e.relatedTarget as Node | null;
	if (!related || !(e.currentTarget as HTMLElement).contains(related)) {
		dropTarget.value = null;
	}
}

// ---------- 纯数组变换：基于扁平 entries 重建顺序 ----------

function moveRepoToGroup(
	entries: RepoEntry[],
	path: string,
	group: string,
): RepoEntry[] {
	const drag = entries.find((r) => r.path === path);
	if (!drag || groupOf(drag) === group) return entries;
	const rest = entries.filter((r) => r.path !== path);
	const moved = { ...drag, group };
	// 追加到目标分组块的末尾；分组不存在（空分组/新分组）则追加到末尾
	let insertAt = -1;
	for (let i = 0; i < rest.length; i++) {
		if (groupOf(rest[i]) === group) insertAt = i + 1;
	}
	if (insertAt === -1) insertAt = rest.length;
	rest.splice(insertAt, 0, moved);
	return rest;
}

function moveRepoRelativeTo(
	entries: RepoEntry[],
	path: string,
	targetPath: string,
	before: boolean,
): RepoEntry[] {
	if (path === targetPath) return entries;
	const drag = entries.find((r) => r.path === path);
	const target = entries.find((r) => r.path === targetPath);
	if (!drag || !target) return entries;
	const rest = entries.filter((r) => r.path !== path);
	const t = rest.findIndex((r) => r.path === targetPath);
	if (t === -1) return entries;
	// 同组内重排或跨组移动：都紧挨目标插入，并归入目标所在分组
	rest.splice(before ? t : t + 1, 0, { ...drag, group: groupOf(target) });
	return rest;
}

function moveGroup(
	entries: RepoEntry[],
	from: string,
	to: string,
	before: boolean,
): RepoEntry[] {
	if (from === to) return entries;
	const block = entries.filter((r) => groupOf(r) === from);
	if (!block.length) return entries;
	const rest = entries.filter((r) => groupOf(r) !== from);
	const t = rest.findIndex((r) => groupOf(r) === to);
	if (t === -1) return entries;
	let insertAt = before ? t : rest.length;
	if (!before) {
		for (let i = t; i < rest.length; i++) {
			if (groupOf(rest[i]) !== to) {
				insertAt = i;
				break;
			}
		}
	}
	return [...rest.slice(0, insertAt), ...block, ...rest.slice(insertAt)];
}
</script>

<template>
	<div class="repo-list" @dragleave="onListDragLeave">
		<div class="sec-head">
			<span class="sec-title">仓库</span>
			<button class="btn-icon" title="添加仓库" @click="openAddMenu">
				<Icon name="plus" :size="13" />
			</button>
		</div>
		<template v-for="g in groupsView" :key="g.name || '__ungrouped__'">
			<div
				v-if="g.hasHeader"
				class="group-head"
				:class="{
					weak: g.name === '',
					dragging:
						dragData?.type === 'group' && dragData.name === g.name,
					'drop-into':
						dropTarget?.type === 'group' &&
						dropTarget.name === g.name &&
						!dropTarget.pos,
					'drop-before':
						dropTarget?.type === 'group' &&
						dropTarget.name === g.name &&
						dropTarget.pos === 'before',
					'drop-after':
						dropTarget?.type === 'group' &&
						dropTarget.name === g.name &&
						dropTarget.pos === 'after',
				}"
				:draggable="g.name !== ''"
				:title="g.name === '' ? '未分组仓库' : g.name"
				@click="g.name !== '' && repos.toggleGroup(g.name)"
				@dragstart="onGroupDragStart($event, g.name)"
				@dragover="onGroupDragOver($event, g.name)"
				@drop="onGroupHeadDrop($event, g.name)"
				@dragend="clearDrag"
				@contextmenu="g.name !== '' && groupMenu($event, g.name)"
			>
				<Icon
					v-if="g.name !== ''"
					:name="
						repos.collapsedGroups[g.name]
							? 'chevron-right'
							: 'chevron-down'
					"
					:size="12"
					class="chev"
				/>
				<Icon name="folder" :size="13" class="group-icon" />
				<span class="group-name">{{
					g.name === "" ? "未分组" : g.name
				}}</span>
				<span class="group-count">{{ g.entries.length }}</span>
			</div>
			<template v-if="g.name === '' || !repos.collapsedGroups[g.name]">
				<div
					v-for="r in g.entries"
					:key="r.path"
					class="repo-row"
					:class="{
						active: r.path === repos.activePath,
						missing: r.missing,
						'in-group': g.name !== '',
						dragging:
							dragData?.type === 'repo' &&
							dragData.path === r.path,
						'drop-before':
							dropTarget?.type === 'repo' &&
							dropTarget.path === r.path &&
							dropTarget.pos === 'before',
						'drop-after':
							dropTarget?.type === 'repo' &&
							dropTarget.path === r.path &&
							dropTarget.pos === 'after',
					}"
					:title="r.path"
					draggable="true"
					@click="!r.missing && repos.setActive(r.path)"
					@contextmenu="repoMenu($event, r.path)"
					@dragstart="onRepoDragStart($event, r.path)"
					@dragover="onRepoDragOver($event, r.path)"
					@drop="onRepoRowDrop($event, r.path)"
					@dragend="clearDrag"
				>
					<Icon
						:name="r.missing ? 'alert' : 'repo'"
						:size="13"
						class="repo-icon"
					/>
					<span class="repo-name">{{ r.name }}</span>
					<span v-if="r.missing" class="miss-badge">丢失</span>
				</div>
			</template>
		</template>
		<div
			v-if="repos.loaded && repos.entries.length === 0"
			class="repo-empty"
		>
			还没有仓库，点击 “+” 添加
		</div>
	</div>
</template>

<style scoped>
.sec-head {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 8px 8px 4px 12px;
	position: sticky;
	top: 0;
	background: var(--bg-sidebar);
	z-index: 1;
}
.sec-title {
	font-size: 11px;
	font-weight: 600;
	text-transform: uppercase;
	letter-spacing: 0.06em;
	color: var(--text-faint);
}
.group-head {
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 4px 8px;
	margin: 6px 6px 2px;
	border-radius: 6px;
	cursor: pointer;
	color: var(--text-dim);
	font-size: 11.5px;
	font-weight: 600;
	user-select: none;
}
.group-head:hover {
	background: var(--bg-hover);
}
.group-head.weak {
	cursor: default;
	font-weight: 500;
	color: var(--text-faint);
}
.group-head.dragging,
.repo-row.dragging {
	opacity: 0.45;
}
.group-head.drop-into {
	background: var(--bg-selected);
	color: var(--text-strong);
}
.chev,
.group-icon {
	flex: none;
	color: var(--text-faint);
}
.group-name {
	flex: 1;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.group-count {
	flex: none;
	font-size: 10.5px;
	font-weight: 400;
	color: var(--text-faint);
}
.repo-row {
	display: flex;
	align-items: center;
	gap: 7px;
	padding: 5px 10px;
	margin: 0 6px;
	border-radius: 6px;
	cursor: pointer;
	color: var(--text);
}
.repo-row.in-group {
	padding-left: 20px;
}
.repo-row:hover {
	background: var(--bg-hover);
}
.repo-row.active {
	background: var(--bg-selected);
	color: var(--text-strong);
}
.repo-row.missing {
	opacity: 0.55;
	cursor: default;
}
.repo-icon {
	flex: none;
	color: var(--text-dim);
}
.repo-row.active .repo-icon {
	color: var(--accent);
}
.repo-name {
	flex: 1;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	font-size: 12.5px;
}
.miss-badge {
	flex: none;
	font-size: 10px;
	color: var(--red);
	border: 1px solid var(--red);
	border-radius: 7px;
	padding: 0 5px;
}
.repo-empty {
	padding: 6px 14px 10px;
	font-size: 11.5px;
	color: var(--text-faint);
}
.drop-before {
	box-shadow: inset 0 2px 0 var(--accent);
}
.drop-after {
	box-shadow: inset 0 -2px 0 var(--accent);
}
</style>
