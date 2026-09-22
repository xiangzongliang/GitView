<script setup lang="ts">
import { computed } from "vue";
import hljs from "highlight.js/lib/common";
import { parseDiff, langFromPath } from "../../utils/diff";
import type { DiffLine } from "../../utils/diff";
import Icon from "../ui/Icon.vue";

const props = withDefaults(
	defineProps<{
		raw: string;
		loading?: boolean;
		filename?: string;
		emptyText?: string;
	}>(),
	{ loading: false, filename: "", emptyText: "没有差异" },
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
			rf.hunks.push(rh);
			if (rf.truncated) break;
		}
		out.push(rf);
		if (budget <= 0) break;
	}
	return out;
});

const isEmpty = computed(
	() =>
		!props.loading && files.value.length === 0 && !(props.raw || "").trim(),
);
</script>

<template>
	<div class="diff-viewer">
		<div v-if="loading" class="empty-hint">
			<span class="spinner" />
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
				<div v-else class="diff-table">
					<template v-for="(h, hi) in f.hunks" :key="hi">
						<div class="diff-row hunk">
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
							<span class="ln">{{ l.oldNo || "" }}</span>
							<span class="ln">{{ l.newNo || "" }}</span>
							<span class="code">
								<span class="mark">{{
									l.kind === "add"
										? "+"
										: l.kind === "del"
											? "−"
											: " "
								}}</span>
								<span v-if="l.html" v-html="l.html" />
							</span>
						</div>
					</template>
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
.diff-row {
	display: grid;
	grid-template-columns: 46px 46px 1fr;
	min-height: 18px;
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
.spinner {
	width: 16px;
	height: 16px;
	border: 2px solid var(--border-strong);
	border-top-color: var(--accent);
	border-radius: 50%;
	animation: spin 0.8s linear infinite;
}
</style>
