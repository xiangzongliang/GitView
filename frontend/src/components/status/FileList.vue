<script setup lang="ts">
// 文件状态列表：扁平展示所有变更文件（不按暂存/未暂存/未跟踪分组）。
// 每行最前面的勾选框决定该文件是否纳入本次提交（勾选 = 已暂存），
// 文件状态用不同图标标记（修改/新增/删除/重命名/冲突/未跟踪…）。
import { computed } from "vue";
import { useRepo } from "../../stores/repo";
import type { SelectedFile } from "../../stores/repo";
import { useUI } from "../../stores/ui";
import type { MenuItem } from "../../stores/ui";
import { copyText } from "../../api";
import {
	STATUS_LABELS,
	statusColor,
	basename,
	dirname,
} from "../../utils/format";
import Icon from "../ui/Icon.vue";

const repo = useRepo();
const ui = useUI();

interface Row {
	/** 唯一 key：每个文件路径只对应一行 */
	key: string;
	path: string;
	oldPath?: string;
	renamed: boolean;
	/** 用于展示的状态字符：M A D R C T U ? */
	st: string;
	/** 已完全纳入提交（index 与工作区一致） */
	staged: boolean;
	/** 部分暂存：index 有改动，工作区仍有未暂存改动 */
	partial: boolean;
	conflicted: boolean;
	/** 提交时使用的分组语义（决定查看哪个差异） */
	group: SelectedFile["group"];
}

const STATUS_ICONS: Record<string, string> = {
	M: "edit", // 修改
	A: "plus", // 新增（已暂存的新文件）
	D: "trash", // 删除
	R: "copy", // 重命名
	C: "copy", // 复制
	T: "edit", // 类型变更
	U: "alert", // 冲突
	"?": "file-plus", // 未跟踪 = 新增文件（与已暂存新增用不同图标区分）
};

// 列表排序优先级（越小越靠前）：冲突 > 编辑（修改/重命名/类型变更）> 删除 > 新增（含未跟踪）
const STATUS_RANK: Record<string, number> = {
	U: 0, // 冲突
	M: 1, // 修改
	T: 1, // 类型变更
	R: 1, // 重命名
	C: 1, // 复制
	D: 2, // 删除
	A: 3, // 新增
	"?": 3, // 未跟踪（等同新增）
};

// 合法的状态字符（防御性过滤：git 未修改的一侧是空格，不应产生行）
const VALID_CHARS = new Set(["M", "A", "D", "R", "C", "T", "U", "X"]);

const rows = computed<Row[]>(() => {
	const st = repo.status;
	if (!st) return [];

	// 同一文件可能同时出现在 index（staged）与工作区（unstaged）中，
	// 这里按路径合并为一行，避免重复；两处都有改动时标记为部分暂存。
	const map = new Map<string, Row>();
	const rowOf = (path: string): Row => {
		let r = map.get(path);
		if (!r) {
			r = {
				key: path,
				path,
				renamed: false,
				st: "M",
				staged: false,
				partial: false,
				conflicted: false,
				group: "unstaged",
			};
			map.set(path, r);
		}
		return r;
	};

	for (const f of st.conflicted || []) {
		const r = rowOf(f.path);
		r.conflicted = true;
		r.st = "U";
		r.staged = false;
		r.partial = false;
		r.renamed = !!f.renamed || r.renamed;
		r.oldPath = f.oldPath || r.oldPath;
		r.group = "conflicted";
	}

	for (const f of st.staged || []) {
		if (!VALID_CHARS.has(f.statusChar)) continue;
		const r = rowOf(f.path);
		r.staged = true;
		r.st = f.statusChar;
		r.renamed = !!f.renamed || r.renamed;
		r.oldPath = f.oldPath || r.oldPath;
		if (!r.conflicted) r.group = "staged";
	}

	for (const f of st.unstaged || []) {
		if (!VALID_CHARS.has(f.statusChar)) continue;
		const r = rowOf(f.path);
		if (r.staged) {
			// index 与工作区都有改动 → 部分暂存，勾选框显示半选
			r.partial = true;
		} else {
			r.st = f.statusChar;
			r.renamed = !!f.renamed || r.renamed;
			r.oldPath = f.oldPath || r.oldPath;
			if (!r.conflicted) r.group = "unstaged";
		}
	}

	for (const f of st.untracked || []) {
		if (map.has(f.path)) continue; // 已由 staged/unstaged 描述
		const r = rowOf(f.path);
		r.st = "?";
		r.group = "untracked";
	}

	const out = [...map.values()];
	// 排序：冲突 > 编辑 > 删除 > 新增，同级按路径
	out.sort((a, b) => {
		const ra = STATUS_RANK[a.st] ?? 4;
		const rb = STATUS_RANK[b.st] ?? 4;
		if (ra !== rb) return ra - rb;
		if (a.path !== b.path) return a.path < b.path ? -1 : 1;
		return 0;
	});
	return out;
});

const selected = computed(
	() => (f: Row) => !!repo.selectedFile && repo.selectedFile.path === f.path,
);

function select(f: Row) {
	repo.selectStatusFile({ path: f.path, staged: f.staged, group: f.group });
}

async function toggleStage(f: Row) {
	// 已完全暂存 → 取消；未暂存或部分暂存 → 全部纳入提交
	const fullyStaged = f.staged && !f.partial;
	if (fullyStaged) await repo.unstagePaths([f.path]);
	else await repo.stagePaths([f.path]);
	// 暂存状态变化后，把选中项同步到新的分组语义上
	if (repo.selectedFile && repo.selectedFile.path === f.path) {
		repo.selectStatusFile({
			path: f.path,
			staged: !fullyStaged,
			group: !fullyStaged
				? "staged"
				: f.conflicted
					? "conflicted"
					: f.st === "?"
						? "untracked"
						: "unstaged",
		});
	}
}

// --------------------------------------------------------------- select all
/** 全部文件均已完全纳入提交 */
const allStaged = computed(
	() =>
		rows.value.length > 0 &&
		rows.value.every((r) => r.staged && !r.partial),
);
const someStaged = computed(() => rows.value.some((r) => r.staged));

function toggleAll() {
	if (ui.opRunning) return;
	if (allStaged.value) {
		// 取消全选：仅对已完全暂存的文件取消暂存
		const staged = rows.value.filter((r) => r.staged).map((r) => r.path);
		if (staged.length) repo.unstagePaths([...new Set(staged)]);
	} else {
		// 全选：所有文件都纳入提交（部分暂存的补齐剩余改动）
		const paths = [...new Set(rows.value.map((r) => r.path))];
		if (paths.length) repo.stagePaths(paths);
	}
}

function fileMenu(e: MouseEvent, f: Row) {
	e.preventDefault();
	e.stopPropagation();
	const items: MenuItem[] = [
		{
			label: f.staged ? "取消勾选（取消暂存）" : "勾选（纳入提交）",
			icon: f.staged ? "minus" : "check",
			action: () => toggleStage(f),
		},
		{ separator: true },
		{ label: "复制路径", icon: "copy", action: () => copyText(f.path) },
		{
			label: "丢弃更改…",
			icon: "trash",
			danger: true,
			action: async () => {
				const ok = await ui.confirm({
					title: "丢弃更改",
					message:
						"确定丢弃 “" +
						f.path +
						"” 的更改吗？\n" +
						(f.group === "untracked"
							? "未跟踪文件将被直接删除。"
							: "文件将恢复到 HEAD 状态。") +
						"\n此操作不可恢复。",
					confirmLabel: "丢弃",
					danger: true,
				});
				if (ok) await repo.discardPaths([f.path]);
			},
		},
	];
	ui.openMenu(e.clientX, e.clientY, items);
}
</script>

<template>
	<div class="file-list">
		<div v-if="!repo.status" class="empty-hint">
			<span class="spinner" />
			<span>加载状态…</span>
		</div>
		<template v-else-if="rows.length > 0">
			<!-- 全选表头：点整行或左侧勾选框切换全部；半选状态自动显示 -->
			<div class="list-head" @click="toggleAll">
				<input
					type="checkbox"
					:checked="allStaged"
					:indeterminate.prop="someStaged && !allStaged"
					:disabled="!!ui.opRunning"
					title="全选 / 取消全选"
					@click.prevent.stop="toggleAll"
					@dblclick.stop
				/>
				<span class="head-label">更改文件</span>
				<span class="head-count">{{ rows.length }}</span>
			</div>
			<div
				v-for="f in rows"
				:key="f.key"
				class="file-row"
				:class="{ selected: selected(f) }"
				:title="f.path"
				@click="select(f)"
				@dblclick="toggleStage(f)"
				@contextmenu="fileMenu($event, f)"
			>
				<input
					class="row-check"
					type="checkbox"
					:checked="f.staged"
					:indeterminate.prop="f.partial"
					:disabled="!!ui.opRunning"
					:title="
						f.partial
							? '部分暂存，点击全部纳入提交'
							: '勾选纳入本次提交'
					"
					@click.prevent.stop="toggleStage(f)"
					@dblclick.stop
				/>
				<span
					class="st"
					:style="{ color: statusColor(f.st) }"
					:title="STATUS_LABELS[f.st] || f.st"
				>
					<Icon :name="STATUS_ICONS[f.st] || 'file'" :size="13" />
				</span>
				<span class="fp">
					<template v-if="f.renamed && f.oldPath">
						<span class="dn old">{{ f.oldPath }}</span>
						<span class="arrow">→</span>
					</template>
					<span class="bn">{{ basename(f.path) }}</span>
					<span v-if="dirname(f.path)" class="dn">{{
						dirname(f.path)
					}}</span>
				</span>
			</div>
		</template>
		<div v-else class="empty-hint">
			<Icon name="check" :size="20" />
			<span>工作区干净，没有待提交的更改</span>
		</div>
	</div>
</template>

<style scoped>
.file-list {
	flex: 1;
	min-height: 0;
	overflow-y: auto;
	display: flex;
	flex-direction: column;
}
.list-head {
	display: flex;
	align-items: center;
	gap: 7px;
	padding: 7px 10px 5px;
	font-size: 11px;
	font-weight: 600;
	text-transform: uppercase;
	letter-spacing: 0.05em;
	color: var(--text-faint);
	position: sticky;
	top: 0;
	background: var(--bg-panel);
	z-index: 1;
	border-bottom: 1px solid var(--border);
	cursor: pointer;
	user-select: none;
}
.head-label {
	flex: none;
}
.head-count {
	font-size: 10px;
	background: var(--hover-soft);
	border-radius: 7px;
	padding: 0 5px;
	line-height: 14px;
	color: var(--text-dim);
}
.list-head input,
.row-check {
	accent-color: var(--accent);
	cursor: pointer;
	flex: none;
	margin: 0;
}
.file-row {
	display: flex;
	align-items: center;
	gap: 7px;
	padding: 4px 10px 4px 10px;
	cursor: pointer;
	font-size: 12px;
}
.file-row:hover {
	background: var(--bg-hover);
}
.file-row.selected {
	background: var(--bg-selected);
}
.st {
	flex: none;
	width: 15px;
	display: inline-flex;
	align-items: center;
	justify-content: center;
}
.fp {
	flex: 1;
	min-width: 0;
	display: flex;
	align-items: baseline;
	gap: 5px;
	overflow: hidden;
	white-space: nowrap;
}
.bn {
	color: var(--text-strong);
	flex: none;
	max-width: 60%;
	overflow: hidden;
	text-overflow: ellipsis;
}
.dn {
	color: var(--text-faint);
	font-size: 10.5px;
	overflow: hidden;
	text-overflow: ellipsis;
	direction: rtl;
	min-width: 0;
}
.dn.old {
	flex: none;
	max-width: 35%;
}
.arrow {
	color: var(--text-faint);
	flex: none;
}
.empty-hint {
	padding: 36px 14px;
	text-align: center;
}
.spinner {
	width: 15px;
	height: 15px;
	border: 2px solid var(--border-strong);
	border-top-color: var(--accent);
	border-radius: 50%;
	animation: spin 0.8s linear infinite;
}
</style>
