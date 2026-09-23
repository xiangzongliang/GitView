<script setup lang="ts">
import { computed } from "vue";
import { useRepo } from "../../stores/repo";
import { useUI } from "../../stores/ui";
import type { MenuItem } from "../../stores/ui";
import { copyText } from "../../api";
import { laneColor, relTime, shortHash } from "../../utils/format";
import { ROW_H, laneX } from "../../utils/graph";
import type { GraphCurve, GraphRow } from "../../utils/graph";
import RefChips from "../common/RefChips.vue";

const props = defineProps<{
	row: GraphRow;
	/** 图形列宽度，由父级统一计算后下发（表头与各行共用同一值） */
	graphW: number;
	selected: boolean;
	refsW: number;
}>();

const repo = useRepo();
const ui = useUI();

// 关键：几何量必须是响应式的。列表以 commit hash 作为 v-for key，切换分支时
// 同一提交的行组件实例会被 Vue 复用（setup 不会重跑），若在 setup 里用普通常量
// 缓存泳道坐标 / 画布宽度，复用后仍沿用上一分支的旧值 —— 圆点、竖线落在旧的 x，
// 曲线却按新泳道绘制，于是图形“错乱”，且与表头「分支 / 标签」列错位。
const w = computed(() => props.graphW);
const mid = ROW_H / 2;
const dotX = computed(() => laneX(props.row.lane));

function curvePath(c: GraphCurve): string {
	const x1 = laneX(c.from);
	const x2 = laneX(c.to);
	const k = mid / 2;
	if (c.kind === "in") {
		// another lane converging from the top edge into this row's dot
		return `M ${x1} 0 C ${x1} ${k}, ${x2} ${mid - k}, ${x2} ${mid}`;
	}
	return `M ${x1} ${mid} C ${x1} ${mid + k}, ${x2} ${ROW_H - k}, ${x2} ${ROW_H}`;
}

function menu(e: MouseEvent) {
	e.preventDefault();
	const c = props.row.commit;
	const hash = c.hash;
	const items: MenuItem[] = [
		{
			label: "检出此提交（分离头指针）…",
			icon: "check",
			action: async () => {
				const ok = await ui.confirm({
					title: "检出提交",
					message:
						"检出 " +
						shortHash(hash) +
						" 将进入分离头指针状态，新提交不会属于任何分支。",
					confirmLabel: "检出",
				});
				if (ok) await repo.checkout(hash);
			},
		},
		{
			label: "从此提交新建分支…",
			icon: "plus",
			action: () => ui.openDialog("branch", { start: hash }),
		},
		{
			label: "在此提交新建标签…",
			icon: "tag",
			action: () => ui.openDialog("tag", { target: hash }),
		},
		{ separator: true },
		{
			label: "Cherry-pick 到当前分支",
			icon: "cherry",
			action: () => repo.cherryPick(hash),
		},
		{
			label: "Revert（生成反向提交）",
			icon: "revert",
			action: () => repo.revertCommit(hash),
		},
		{
			label: "Reset 当前分支到此处…",
			icon: "reset",
			danger: true,
			action: () => ui.openDialog("reset", { target: hash }),
		},
		{ separator: true },
		{ label: "复制提交哈希", icon: "copy", action: () => copyText(hash) },
	];
	ui.openMenu(e.clientX, e.clientY, items);
}

async function dblClick() {
	const c = props.row.commit;
	const ok = await ui.confirm({
		title: "检出提交",
		message:
			"检出 " +
			shortHash(c.hash) +
			"（" +
			c.subject +
			"）？将进入分离头指针状态。",
		confirmLabel: "检出",
	});
	if (ok) await repo.checkout(c.hash);
}
</script>

<template>
	<div
		class="commit-row"
		:class="{ selected }"
		@click="repo.selectCommit(row.commit.hash)"
		@dblclick="dblClick"
		@contextmenu="menu"
	>
		<svg class="graph" :width="w" :height="ROW_H">
			<!-- lanes passing through this row -->
			<line
				v-for="l in row.through"
				:key="'t' + l"
				:x1="laneX(l)"
				:y1="0"
				:x2="laneX(l)"
				:y2="ROW_H"
				:stroke="laneColor(l)"
				stroke-width="1.6"
			/>
			<!-- line from top edge into the dot -->
			<line
				v-if="row.top"
				:x1="dotX"
				:y1="0"
				:x2="dotX"
				:y2="mid"
				:stroke="laneColor(row.lane)"
				stroke-width="1.6"
			/>
			<!-- first parent continues straight down -->
			<line
				v-if="row.bottom"
				:x1="dotX"
				:y1="mid"
				:x2="dotX"
				:y2="ROW_H"
				:stroke="laneColor(row.lane)"
				stroke-width="1.6"
			/>
			<!-- merges / lane collapses / converging lanes -->
			<path
				v-for="(c, i) in row.curves"
				:key="'c' + i"
				:d="curvePath(c)"
				fill="none"
				:stroke="laneColor(c.from)"
				stroke-width="1.6"
			/>
			<circle
				:cx="dotX"
				:cy="mid"
				r="4"
				:fill="laneColor(row.lane)"
				class="dot-ring"
				stroke-width="1.2"
			/>
		</svg>

		<!-- refs get a dedicated column so branch chips never overlap the subject -->
		<div class="refs-col" :style="{ width: refsW + 'px' }">
			<RefChips :refs="row.commit.refs" :max="2" />
		</div>
		<span class="subject" :title="row.commit.subject">{{
			row.commit.subject
		}}</span>

		<span
			class="author"
			:title="row.commit.author + ' <' + row.commit.authorEmail + '>'"
		>
			{{ row.commit.author }}
		</span>
		<span
			class="time"
			:title="new Date(row.commit.timestamp * 1000).toLocaleString()"
		>
			{{ relTime(row.commit.timestamp) }}
		</span>
		<span class="hash mono">{{ shortHash(row.commit.hash) }}</span>
	</div>
</template>

<style scoped>
.commit-row {
	display: flex;
	align-items: center;
	height: 30px; /* = ROW_H */
	gap: 8px;
	padding-right: 10px;
	cursor: pointer;
	border-bottom: 1px solid var(--row-border);
}
.commit-row:hover {
	background: var(--bg-hover);
}
.commit-row.selected {
	background: var(--bg-selected);
}
.commit-row.selected .subject {
	color: var(--text-strong);
	font-weight: 500;
}
.graph {
	flex: none;
	display: block;
}
.dot-ring {
	stroke: var(--bg-app);
}
.refs-col {
	flex: none;
	width: 140px; /* default; user-resizable via the list header */
	display: flex;
	align-items: center;
	gap: 4px;
	overflow: hidden;
}
.subject {
	flex: 1;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	font-size: 12.5px;
	color: var(--text);
}
.author {
	flex: none;
	width: 130px;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	font-size: 11.5px;
	color: var(--text-dim);
}
.time {
	flex: none;
	width: 86px;
	font-size: 11px;
	color: var(--text-faint);
	white-space: nowrap;
}
.hash {
	flex: none;
	width: 66px;
	text-align: right;
	font-size: 11px;
	color: var(--text-faint);
}
</style>
