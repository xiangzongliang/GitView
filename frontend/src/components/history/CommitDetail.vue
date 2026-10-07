<script setup lang="ts">
import { computed, ref } from "vue";
import { useRepo } from "../../stores/repo";
import { copyText } from "../../api";
import {
	fmtDateTime,
	relTime,
	statusColor,
	basename,
	dirname,
	isImageFile,
} from "../../utils/format";
import Icon from "../ui/Icon.vue";
import RefChips from "../common/RefChips.vue";
import DiffViewer from "../common/DiffViewer.vue";
import ImageDiffViewer from "../common/ImageDiffViewer.vue";

const repo = useRepo();

const c = computed(() => repo.selectedCommit);

// 当前选中的提交文件与图片预览（与状态视图一致，SVG 可切换源码/预览）
const selectedCommitFile = computed(
	() => repo.commitFiles.find((f) => f.path === repo.commitFile) || null,
);
const imageSelected = computed(() => {
	const f = selectedCommitFile.value;
	return !!f && isImageFile(f.path);
});
// 根提交无父提交，传 "" 表示无修改前版本
const parentHash = computed(() => c.value?.parents?.[0] || "");

// 文件列表宽度可拖拽调整（与右侧差异区之间的分割线），带最小/最大限制并持久化
const FILES_W_KEY = "gv.commitFilesW";
const filesW = ref(Number(localStorage.getItem(FILES_W_KEY)) || 280);
function startFilesDrag(e: MouseEvent) {
	e.preventDefault();
	const startX = e.clientX;
	const startW = filesW.value;
	const maxW = () => Math.max(180, Math.round(window.innerWidth * 0.5));
	const move = (ev: MouseEvent) => {
		filesW.value = Math.min(
			Math.max(180, startW + (ev.clientX - startX)),
			maxW(),
		);
	};
	const up = () => {
		document.removeEventListener("mousemove", move);
		document.removeEventListener("mouseup", up);
		document.body.style.cursor = "";
		document.body.style.userSelect = "";
		try {
			localStorage.setItem(FILES_W_KEY, String(filesW.value));
		} catch {
			/* ignore */
		}
	};
	document.addEventListener("mousemove", move);
	document.addEventListener("mouseup", up);
	document.body.style.cursor = "col-resize";
	document.body.style.userSelect = "none";
}

function statusTitle(ch: string): string {
	const map: Record<string, string> = {
		A: "新增",
		M: "修改",
		D: "删除",
		R: "重命名",
		C: "复制",
		T: "类型变更",
	};
	return map[ch] || ch;
}
</script>

<template>
	<div class="commit-detail">
		<div v-if="repo.detailLoading && !c" class="empty-hint">
			<span class="spinner" />
			<span>加载提交详情…</span>
		</div>
		<div v-else-if="!c" class="empty-hint">
			<Icon name="commit" :size="22" />
			<span>选择一个提交查看详情</span>
		</div>
		<template v-else>
			<div class="meta">
				<div class="meta-top">
					<span class="subject">{{ c.subject }}</span>
					<RefChips :refs="c.refs" />
				</div>
				<div v-if="c.body" class="body">{{ c.body }}</div>
				<div class="meta-grid">
					<div class="meta-item">
						<span class="k">作者</span>
						<span class="v"
							>{{ c.author }}
							<span class="faint"
								>&lt;{{ c.authorEmail }}&gt;</span
							></span
						>
					</div>
					<div class="meta-item">
						<span class="k">日期</span>
						<span class="v"
							>{{ fmtDateTime(c.timestamp) }}（{{
								relTime(c.timestamp)
							}}）</span
						>
					</div>
					<div class="meta-item">
						<span class="k">提交</span>
						<span
							class="v hash"
							:title="c.hash"
							@click="copyText(c.hash)"
						>
							<span class="hash-text mono">{{ c.hash }}</span>
							<Icon name="copy" :size="11" class="copy-ic" />
						</span>
					</div>
					<div v-if="c.parents && c.parents.length" class="meta-item">
						<span class="k">父提交</span>
						<span class="v parents">
							<button
								v-for="p in c.parents"
								:key="p"
								class="parent mono"
								@click="repo.selectCommit(p)"
							>
								{{ p.slice(0, 8) }}
							</button>
						</span>
					</div>
				</div>
			</div>

			<div class="detail-main">
				<div class="files" :style="{ width: filesW + 'px' }">
					<div class="files-head">
						更改文件
						<span class="sec-count">{{
							repo.commitFiles.length
						}}</span>
					</div>
					<div class="files-list">
						<div
							v-for="f in repo.commitFiles"
							:key="f.path"
							class="file-row"
							:class="{ selected: f.path === repo.commitFile }"
							:title="
								f.oldPath ? f.oldPath + ' → ' + f.path : f.path
							"
							@click="repo.selectCommitFile(f.path)"
						>
							<span
								class="st"
								:style="{ color: statusColor(f.status) }"
								>{{ f.binary ? "B" : f.status }}</span
							>
							<span class="fp">
								<span class="bn">{{ basename(f.path) }}</span>
								<span v-if="dirname(f.path)" class="dn">{{
									dirname(f.path)
								}}</span>
							</span>
							<span class="counts mono">
								<span v-if="f.binary" class="faint">bin</span>
								<template v-else>
									<span class="green"
										>+{{ f.additions }}</span
									>
									<span class="red">−{{ f.deletions }}</span>
								</template>
							</span>
						</div>
						<div
							v-if="repo.commitFiles.length === 0"
							class="files-empty"
						>
							没有文件更改
						</div>
					</div>
				</div>
				<div
					class="files-resizer"
					title="拖动调整文件列表宽度"
					@mousedown="startFilesDrag"
				/>
				<ImageDiffViewer
					v-if="imageSelected"
					:repo-path="repo.path"
					:path="repo.commitFile"
					:staged="false"
					:status="selectedCommitFile!.status"
					:hash="repo.selectedHash"
					:parent-hash="parentHash"
					:old-path="selectedCommitFile!.oldPath || ''"
					:raw="repo.commitDiff"
					:loading="repo.detailLoading"
				/>
				<DiffViewer
					v-else
					:raw="repo.commitDiff"
					:loading="repo.detailLoading"
					:filename="repo.commitFile"
					empty-text="选择左侧文件查看差异"
				/>
			</div>
		</template>
	</div>
</template>

<style scoped>
.commit-detail {
	flex: 1;
	min-height: 0;
	display: flex;
	flex-direction: column;
	background: var(--bg-app);
}
.meta {
	flex: none;
	padding: 10px 14px;
	border-bottom: 1px solid var(--border);
	background: var(--bg-panel);
	max-height: 45%;
	overflow-y: auto;
}
.meta-top {
	display: flex;
	align-items: center;
	gap: 8px;
	flex-wrap: wrap;
}
.subject {
	font-size: 14px;
	font-weight: 600;
	color: var(--text-strong);
}
.body {
	margin-top: 6px;
	font-size: 12px;
	color: var(--text-dim);
	white-space: pre-wrap;
	word-break: break-word;
	user-select: text;
	cursor: text;
}
.meta-grid {
	margin-top: 8px;
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
	gap: 4px 18px;
}
.meta-item {
	display: flex;
	align-items: center;
	gap: 8px;
	font-size: 11.5px;
	min-width: 0;
}
.k {
	flex: none;
	width: 40px;
	color: var(--text-faint);
	line-height: 20px;
}
.v {
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	line-height: 20px;
	color: var(--text);
	user-select: text;
	cursor: text;
}
.hash {
	cursor: pointer;
	display: flex;
	align-items: center;
	gap: 6px;
}
.hash:hover {
	color: var(--accent);
}
.hash-text {
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.copy-ic {
	flex: none;
	opacity: 0.6;
}
.parents {
	display: flex;
	align-items: center;
	gap: 10px;
}
.parent {
	font-size: 11.5px;
	color: var(--accent);
	padding: 0;
	line-height: 20px;
}
.parent:hover {
	text-decoration: underline;
}
.detail-main {
	flex: 1;
	min-height: 0;
	display: flex;
}
.files {
	width: 280px; /* default; user-resizable via the divider */
	flex: none;
	display: flex;
	flex-direction: column;
	border-right: 1px solid var(--border);
	background: var(--bg-panel);
	min-height: 0;
}
.files-resizer {
	flex: none;
	width: 5px;
	margin: 0 -2px;
	cursor: col-resize;
	z-index: 10;
	position: relative;
}
.files-resizer::after {
	content: "";
	position: absolute;
	left: 2px;
	top: 0;
	bottom: 0;
	width: 1px;
	background: var(--border);
}
.files-resizer:hover::after,
.files-resizer:active::after {
	background: var(--accent);
	width: 2px;
}
.files-head {
	flex: none;
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 6px 10px;
	font-size: 11px;
	font-weight: 600;
	text-transform: uppercase;
	letter-spacing: 0.05em;
	color: var(--text-faint);
	border-bottom: 1px solid var(--border);
}
.sec-count {
	font-size: 10px;
	background: var(--hover-soft);
	border-radius: 7px;
	padding: 0 5px;
	line-height: 14px;
}
.files-list {
	flex: 1;
	overflow-y: auto;
	min-height: 0;
}
.file-row {
	display: flex;
	align-items: center;
	gap: 7px;
	padding: 4px 10px;
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
	width: 14px;
	font-family: var(--font-mono);
	font-weight: 700;
	font-size: 11px;
	text-align: center;
}
.fp {
	flex: 1;
	min-width: 0;
	display: flex;
	align-items: baseline;
	gap: 5px;
	overflow: hidden;
}
.bn {
	color: var(--text-strong);
	white-space: nowrap;
}
.dn {
	color: var(--text-faint);
	font-size: 10.5px;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
	direction: rtl;
}
.counts {
	flex: none;
	display: flex;
	gap: 5px;
	font-size: 10.5px;
}
.files-empty {
	padding: 10px;
	color: var(--text-faint);
	font-size: 11.5px;
	text-align: center;
}
.spinner {
	width: 16px;
	height: 16px;
	border: 2px solid var(--border-strong);
	border-top-color: var(--accent);
	border-radius: 50%;
	animation: spin 0.8s linear infinite;
}
</style>
