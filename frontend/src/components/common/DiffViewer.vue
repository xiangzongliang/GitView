<script setup lang="ts">
import { computed } from "vue";
import hljs from "highlight.js/lib/common";
import { parseDiff, langFromPath } from "../../utils/diff";
import type { DiffLine } from "../../utils/diff";
import Icon from "../ui/Icon.vue";
import Spinner from "../ui/Spinner.vue";

const props = withDefaults(
	defineProps<{
		raw: string;
		loading?: boolean;
		filename?: string;
		emptyText?: string;
		/** 单侧源码模式：新增文件只显示新增行（add）、删除文件只显示删除行（del），
		 *  并隐藏 hunk 头/增删标记等差异装饰，直接呈现该侧源码 */
		plainSide?: "" | "add" | "del";
	}>(),
	{ loading: false, filename: "", emptyText: "没有差异", plainSide: "" },
);

const MAX_LINES = 3000;

interface RenderLine {
	kind: DiffLine["kind"] | "hunk";
	oldNo: number;
	newNo: number;
	html: string;
}
interface RenderHunk {
	header: string;
	lines: RenderLine[];
}
interface RenderFile {
	title: string;
	binary: boolean;
	additions: number;
	deletions: number;
	hunks: RenderHunk[];
	truncated: boolean;
}

function highlight(text: string, lang: string | undefined): string {
	if (!text) return "";
	if (lang) {
		try {
			return hljs.highlight(text, {
				language: lang,
				ignoreIllegals: true,
			}).value;
		} catch {
			/* fall through to plain */
		}
	}
	return escapeHtml(text);
}

function escapeHtml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const files = computed<RenderFile[]>(() => {
	const parsed = parseDiff(props.raw || "");
	const out: RenderFile[] = [];
	let budget = MAX_LINES;
	for (const f of parsed) {
		const lang = langFromPath(f.newPath || f.oldPath || props.filename);
		const rf: RenderFile = {
			title: f.newPath || f.oldPath || props.filename || "diff",
			binary: f.binary,
			additions: f.additions,
			deletions: f.deletions,
			hunks: [],
			truncated: false,
		};
		for (const h of f.hunks) {
			const rh: RenderHunk = { header: h.header, lines: [] };
			for (const l of h.lines) {
				// 单侧源码模式：只保留该侧的行（新增文件的 + 行 / 删除文件的 − 行）
				if (props.plainSide && l.kind !== props.plainSide) continue;
				if (budget <= 0) {
					rf.truncated = true;
					break;
				}
				budget--;
				rh.lines.push({
					kind: l.kind,
					oldNo: l.oldNo,
					newNo: l.newNo,
					html: highlight(l.text, lang),
				});
			}
			// 单侧模式下只保留有内容的 hunk，避免空壳导致空白渲染
			if (!props.plainSide || rh.lines.length > 0) rf.hunks.push(rh);
			if (rf.truncated) break;
		}
		out.push(rf);
		if (budget <= 0) break;
	}
	return out;
});

const isEmpty = computed(() => {
	if (props.loading) return false;
	if (!props.plainSide)
		return files.value.length === 0 && !(props.raw || "").trim();
	// 单侧源码模式：没有任何该侧行时视为空
	return files.value.every((f) => f.hunks.every((h) => h.lines.length === 0));
});
</script>

<template>
	<div class="diff-viewer">
		<div v-if="loading" class="empty-hint">
			<Spinner :size="16" />
			<span>加载差异…</span>
		</div>
		<div v-else-if="isEmpty" class="empty-hint">
			<Icon name="check" :size="20" />
			<span>{{ emptyText }}</span>
		</div>
		<template v-else>
			<div v-for="(f, fi) in files" :key="fi" class="diff-file">
				<div v-if="files.length > 1" class="diff-file-head">
					<Icon name="file" :size="12" />
					<span class="mono">{{ f.title }}</span>
					<span class="counts">
						<span class="green">+{{ f.additions }}</span>
						<span class="red">−{{ f.deletions }}</span>
					</span>
				</div>
				<div v-if="f.binary" class="diff-binary">
					二进制文件，无法显示差异
				</div>
				<div v-else class="diff-table" :class="{ plain: !!plainSide }">
					<div
						v-for="(h, hi) in f.hunks"
						:key="hi"
						class="diff-hunk-chunk"
					>
						<div v-if="!plainSide" class="diff-row hunk">
							<span class="ln" />
							<span class="ln" />
							<span class="code">{{ h.header }}</span>
						</div>
						<div
							v-for="(l, li) in h.lines"
							:key="li"
							class="diff-row"
							:class="l.kind"
						>
							<span
								v-if="!plainSide || plainSide === 'del'"
								class="ln"
								:data-no="l.oldNo || ''"
							/>
							<span
								v-if="!plainSide || plainSide === 'add'"
								class="ln"
								:data-no="l.newNo || ''"
							/>
							<span class="code">
								<span
									v-if="!plainSide"
									class="mark"
									:data-mark="
										l.kind === 'add'
											? '+'
											: l.kind === 'del'
												? '−'
												: ' '
									"
								/>
								<span v-if="l.html" v-html="l.html" />
							</span>
						</div>
					</div>
					<div v-if="f.truncated" class="diff-binary">
						内容过长，已截断显示（前 {{ MAX_LINES }} 行）
					</div>
				</div>
			</div>
		</template>
	</div>
</template>

<style scoped>
.diff-viewer {
	flex: 1;
	min-width: 0;
	min-height: 0;
	overflow: auto;
	background: var(--bg-app);
	display: flex;
	flex-direction: column;
}
.diff-file {
	display: flex;
	flex-direction: column;
}
.diff-file-head {
	position: sticky;
	top: 0;
	z-index: 2;
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 5px 10px;
	background: var(--bg-panel);
	border-bottom: 1px solid var(--border);
	font-size: 12px;
	color: var(--text-strong);
}
.counts {
	margin-left: auto;
	display: flex;
	gap: 8px;
	font-family: var(--font-mono);
	font-size: 11px;
}
.diff-binary {
	padding: 14px;
	color: var(--text-faint);
	font-size: 12px;
	text-align: center;
}
.diff-table {
	font-family: var(--font-mono);
	font-size: 11.5px;
	line-height: 1.55;
}
/* 每个 hunk 用 content-visibility: auto 包裹，浏览器自动跳过离屏内容渲染 */
.diff-hunk-chunk {
	content-visibility: auto;
	contain-intrinsic-size: auto 500px;
}
.diff-row {
	display: grid;
	grid-template-columns: 46px 46px 1fr;
	min-height: 18px;
}
/* 单侧源码模式：只保留一个行号列（新增显示新行号 / 删除显示旧行号） */
.diff-table.plain .diff-row {
	grid-template-columns: 46px 1fr;
}
.ln {
	text-align: right;
	padding: 0 8px 0 0;
	color: var(--text-faint);
	background: var(--hover-soft);
	border-right: 1px solid var(--border);
	user-select: none;
	white-space: nowrap;
}
/* 行号用 CSS 生成内容渲染：伪元素不参与选区，也不会被复制 */
.ln::before {
	content: attr(data-no);
}
.code {
	padding: 0 10px;
	white-space: pre-wrap;
	word-break: break-all;
	user-select: text;
	cursor: text;
}
.mark {
	display: inline-block;
	width: 12px;
	user-select: none;
}
/* +/− 标记同样用伪元素生成，复制时不带上前缀 */
.mark::before {
	content: attr(data-mark);
}
.diff-row.add {
	background: var(--diff-add-bg);
	color: var(--diff-add-text);
}
.diff-row.del {
	background: var(--diff-del-bg);
	color: var(--diff-del-text);
}
.diff-row.hunk {
	background: var(--diff-hunk-bg);
	color: var(--diff-hunk-text);
}
.diff-row.hunk .ln {
	background: transparent;
}
.diff-row.nonl {
	color: var(--text-faint);
	font-style: italic;
}
</style>
