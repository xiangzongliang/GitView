<script setup lang="ts">
// 图片文件的前后对比预览：字节由 wails 资源服务器上的复合处理器直接经 URL
// 返回（见 GitView/repoimage.go 的 /gitview-file），前端不做 base64/二进制转换。
// SVG 额外支持「图片效果 / 源码差异」切换，源码模式复用 DiffViewer。
import { computed, ref, watch } from "vue";
import DiffViewer from "./DiffViewer.vue";
import Icon from "../ui/Icon.vue";
import { basename, isSvgFile } from "../../utils/format";

const props = withDefaults(
	defineProps<{
		/** 仓库绝对路径 */
		repoPath: string;
		/** 文件在仓库内的相对路径 */
		path: string;
		/** 暂存视图：前=HEAD、后=index；未暂存：前=index、后=worktree */
		staged: boolean;
		/** porcelain 状态字符（M A D R C T U ?），用于判断前/后版本是否存在 */
		status: string;
		/** SVG 源码模式的差异文本（即状态视图已加载的 fileDiff） */
		raw?: string;
		loading?: boolean;
	}>(),
	{ raw: "", loading: false },
);

// ref 语义与 WorktreeDiff（gitservice.go）保持一致：
//   staged   → git diff --staged → 前=HEAD、后=index
//   unstaged → git diff          → 前=index、后=worktree
//   untracked(?) → 新文件，只有 worktree 版本
const isAdded = computed(() => props.status === "?" || props.status === "A");
const isDeleted = computed(() => props.status === "D");

const beforeRef = computed<string | null>(() => {
	if (isAdded.value) return null;
	return props.staged ? "head" : "index";
});
const afterRef = computed<string | null>(() => {
	if (isDeleted.value) return null;
	if (props.status === "?") return "worktree";
	return props.staged ? "index" : "worktree";
});

function imageUrl(refName: string): string {
	const q = new URLSearchParams();
	q.set("repo", props.repoPath);
	q.set("path", props.path);
	q.set("ref", refName);
	return "/gitview-file?" + q.toString();
}

const beforeUrl = computed(() =>
	beforeRef.value ? imageUrl(beforeRef.value) : "",
);
const afterUrl = computed(() => (afterRef.value ? imageUrl(afterRef.value) : ""));

// 加载失败（该版本不存在、无法解码等）→ 原位显示提示
const beforeFailed = ref(false);
const afterFailed = ref(false);
watch(
	() => [props.repoPath, props.path, props.staged, props.status],
	() => {
		beforeFailed.value = false;
		afterFailed.value = false;
	},
);

// SVG：图片效果 / 源码差异切换（默认图片效果）；其余图片始终为图片预览
const isSvg = computed(() => isSvgFile(props.path));
const showCode = ref(false);
watch(
	() => props.path,
	() => {
		showCode.value = false;
	},
);

// 缩放：适应窗口 / 实际大小（超出容器时滚动查看）
const fit = ref(true);

const title = computed(() => basename(props.path));
const showImages = computed(() => !isSvg.value || !showCode.value);
</script>

<template>
	<div class="image-diff">
		<div class="head">
			<Icon name="file" :size="12" />
			<span class="fname mono" :title="path">{{ title }}</span>
			<div class="spacer" />
			<label
				v-if="isSvg"
				class="mode-toggle"
				title="切换 SVG 浏览方式：关 = 图片效果，开 = 源码差异"
			>
				<input v-model="showCode" type="checkbox" class="toggle-input" />
				<span class="toggle-track"><span class="toggle-thumb" /></span>
				<span class="toggle-label">源码</span>
			</label>
			<button
				v-if="showImages"
				class="btn zoom-btn"
				:title="fit ? '按实际大小显示' : '适应窗口大小'"
				@click="fit = !fit"
			>
				<Icon :name="fit ? 'maximize-2' : 'minimize-2'" :size="12" />
				{{ fit ? "适应" : "实际大小" }}
			</button>
		</div>

		<DiffViewer
			v-if="isSvg && showCode"
			:raw="raw"
			:loading="loading"
			:filename="path"
			empty-text="没有差异"
		/>
		<div v-else class="panes" :class="{ actual: !fit }">
			<div class="pane">
				<div class="pane-head">修改前</div>
				<div class="pane-body checker">
					<img
						v-if="beforeUrl && !beforeFailed"
						:src="beforeUrl"
						alt="修改前"
						@error="beforeFailed = true"
					/>
					<div v-else class="pane-hint">
						{{
							beforeUrl
								? "无法预览"
								: isAdded
									? "新增文件，无修改前版本"
									: "无修改前版本"
						}}
					</div>
				</div>
			</div>
			<div class="pane">
				<div class="pane-head">修改后</div>
				<div class="pane-body checker">
					<img
						v-if="afterUrl && !afterFailed"
						:src="afterUrl"
						alt="修改后"
						@error="afterFailed = true"
					/>
					<div v-else class="pane-hint">
						{{
							afterUrl
								? "无法预览"
								: isDeleted
									? "文件已删除，无修改后版本"
									: "无修改后版本"
						}}
					</div>
				</div>
			</div>
		</div>
	</div>
</template>

<style scoped>
.image-diff {
	flex: 1;
	min-width: 0;
	min-height: 0;
	display: flex;
	flex-direction: column;
	background: var(--bg-app);
}
.head {
	flex: none;
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 5px 10px;
	background: var(--bg-panel);
	border-bottom: 1px solid var(--border);
	font-size: 12px;
	color: var(--text-strong);
}
.fname {
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.spacer {
	flex: 1;
}
.zoom-btn {
	flex: none;
	height: 22px;
	padding: 0 8px;
	font-size: 11px;
}
/* ---- SVG 源码/图片切换开关（样式同 StashDetailDialog 的完整文件开关） ---- */
.mode-toggle {
	display: inline-flex;
	align-items: center;
	gap: 5px;
	cursor: pointer;
	user-select: none;
	flex: none;
}
.toggle-input {
	position: absolute;
	opacity: 0;
	width: 0;
	height: 0;
}
.toggle-track {
	position: relative;
	width: 28px;
	height: 15px;
	border-radius: 999px;
	background: var(--border-strong);
	transition: background 0.2s;
}
.toggle-input:checked + .toggle-track {
	background: var(--accent);
}
.toggle-thumb {
	position: absolute;
	top: 2px;
	left: 2px;
	width: 11px;
	height: 11px;
	border-radius: 50%;
	background: var(--bg-panel);
	box-shadow: 0 1px 2px rgba(0, 0, 0, 0.18);
	transition: transform 0.2s;
}
.toggle-input:checked + .toggle-track .toggle-thumb {
	transform: translateX(13px);
}
.toggle-label {
	font-size: 10.5px;
	color: var(--text-dim);
	white-space: nowrap;
}
/* ---- 前/后两个预览窗格 ---- */
.panes {
	flex: 1;
	min-height: 0;
	display: flex;
}
.pane {
	flex: 1;
	min-width: 0;
	display: flex;
	flex-direction: column;
}
.pane + .pane {
	border-left: 1px solid var(--border);
}
.pane-head {
	flex: none;
	padding: 4px 10px;
	font-size: 11px;
	color: var(--text-dim);
	background: var(--bg-panel);
	border-bottom: 1px solid var(--border);
}
.pane-body {
	flex: 1;
	min-height: 0;
	overflow: auto;
	display: flex;
	align-items: center;
	justify-content: center;
	padding: 12px;
}
/* 棋盘格底纹：让图片的透明区域可见 */
.checker {
	background-color: var(--bg-app);
	background-image:
		linear-gradient(
			45deg,
			var(--bg-hover) 25%,
			transparent 25%,
			transparent 75%,
			var(--bg-hover) 75%
		),
		linear-gradient(
			45deg,
			var(--bg-hover) 25%,
			transparent 25%,
			transparent 75%,
			var(--bg-hover) 75%
		);
	background-size: 16px 16px;
	background-position:
		0 0,
		8px 8px;
}
.pane-body img {
	display: block;
	max-width: 100%;
	max-height: 100%;
	object-fit: contain;
}
/* 实际大小：取消约束并从左上角排布，超出容器时滚动查看 */
.panes.actual .pane-body {
	align-items: flex-start;
	justify-content: flex-start;
}
.panes.actual .pane-body img {
	max-width: none;
	max-height: none;
	object-fit: none;
}
.pane-hint {
	margin: auto;
	color: var(--text-faint);
	font-size: 12px;
	text-align: center;
}
</style>
