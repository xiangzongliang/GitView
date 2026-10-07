<script setup lang="ts">
// 「当前分支合并到…」向导：把当前分支 A 合并进选定的本地分支 B。
// 流程：checkout B → fetch → pull → merge A（-m AI 归纳的合并信息）→ push → checkout A。
// 每一步都通过 GitService.RunGitStep 执行，并在对话框内展示命令与输出；
// 合并（或 pull）产生冲突时暂停，用户手动解决后点「已解决冲突，继续」。
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useRepo } from "../../stores/repo";
import { useUI } from "../../stores/ui";
import { useAi } from "../../stores/ai";
import { GitService, errMsg } from "../../api";
import type { Commit, GitStepResult } from "../../api";
import {
	availableAiModels,
	decodeModelValue,
	encodeModelValue,
} from "../../ai/models";
import {
	MERGE_SUMMARY_SYSTEM_PROMPT,
	buildMergeSummaryUserPrompt,
} from "../../ai/prompts";
import { startChat, type ChatSession } from "../../ai/chat";
import ModalDialog from "../ui/ModalDialog.vue";
import Icon from "../ui/Icon.vue";
import Checkbox from "../ui/Checkbox.vue";
import Spinner from "../ui/Spinner.vue";
import SelectMenu from "../ui/SelectMenu.vue";
import type { SelectEntry } from "../ui/types";
import AiModelSelect from "../ai/AiModelSelect.vue";

const props = defineProps<{ payload?: { ref?: string } }>();
const emit = defineEmits<{ (e: "close"): void }>();

const repo = useRepo();
const ui = useUI();
const ai = useAi();

// ------------------------------------------------------------- 表单（setup）

type Phase = "setup" | "running" | "conflict" | "success" | "failed";
const phase = ref<Phase>("setup");

/** 源分支 A：打开对话框时的当前检出分支（流程结束后仍以此为准切回）。 */
const source = ref(repo.status?.branch || "");
const detached = computed(() => !!repo.status?.detached);

/** 目标分支 B。 */
const preselect = props.payload?.ref || "";
const target = ref(preselect !== source.value ? preselect : "");
const noFF = ref(false);
const doPush = ref(true);
const message = ref("");
/** 用户是否手动改过合并信息（改过就不再随目标分支覆盖默认值）。 */
const msgEdited = ref(false);

const targetOptions = computed<SelectEntry[]>(() =>
	(repo.refs?.branches || [])
		.filter((b) => !b.isRemote && b.name !== source.value)
		.map((b) => ({ label: b.name, value: b.name, icon: "branch" })),
);

/** 开始前的前置条件错误（空串 = 可以开始）。 */
const readyError = computed(() => {
	if (phase.value !== "setup") return "";
	if (detached.value) return "当前处于 detached HEAD 状态，无法使用此功能";
	if (!source.value) return "无法确定当前分支";
	if (repo.opInProgress)
		return "仓库有进行中的 merge/rebase 等操作，请先完成或中止";
	if (repo.dirtyCount > 0)
		return `当前分支有 ${repo.dirtyCount} 个未提交的更改，请先提交或 stash 后再使用此功能`;
	return "";
});

const canStart = computed(
	() => phase.value === "setup" && !readyError.value && !!target.value,
);

const defaultMsg = computed(
	() => `Merge branch '${source.value}' into ${target.value}`,
);
watch(target, (B) => {
	if (!msgEdited.value) message.value = B ? defaultMsg.value : "";
	// 先同步目标分支到最新，再刷新待合并提交与合并差异
	void syncAndRefresh(B);
});

// ------------------------------------------------- 待合并提交（B..A）与 AI 归纳

const mergeCommits = ref<Commit[] | null>(null); // null = 未加载
const commitsLoading = ref(false);
const commitsError = ref("");
/** 丢弃过期的并发请求（快速切换目标分支时） */
let commitsGen = 0;

async function refreshMergeCommits() {
	const gen = ++commitsGen;
	const A = source.value;
	const B = target.value;
	mergeCommits.value = null;
	commitsError.value = "";
	if (!A || !B || phase.value !== "setup") return;
	commitsLoading.value = true;
	try {
		const list = await GitService.Log(repo.path, {
			ref: `${B}..${A}`,
			skip: 0,
			limit: 200,
			search: "",
			file: "",
		});
		if (gen !== commitsGen) return;
		mergeCommits.value = list || [];
	} catch (e) {
		if (gen !== commitsGen) return;
		commitsError.value = errMsg(e);
	} finally {
		if (gen === commitsGen) commitsLoading.value = false;
	}
}

const commitCount = computed(() => mergeCommits.value?.length ?? -1);
const nothingToMerge = computed(() => commitCount.value === 0);

// ------------------------------------------- 目标分支同步（不切分支快进 B）

/** setup 阶段展示的同步命令日志（复用 StepEntry 与 step-log 样式）。 */
const syncSteps = ref<StepEntry[]>([]);
const syncLogEl = ref<HTMLElement | null>(null);
const syncing = ref(false);
const syncFailed = ref(false);
let syncSeq = 0;
/** 丢弃过期的并发同步（快速切换目标分支时） */
let syncGen = 0;

function scrollSyncLog() {
	nextTick(() => {
		const el = syncLogEl.value;
		if (el) el.scrollTop = el.scrollHeight;
	});
}

/** 与 runStep 相同，但日志写入 setup 阶段的同步日志区。 */
async function runSyncStep(
	title: string,
	args: string[],
	network: boolean,
): Promise<GitStepResult | null> {
	syncSteps.value.push({
		id: syncSeq++,
		title,
		kind: "cmd",
		state: "running",
	});
	// 取回数组内的响应式代理再改，直接改 push 进去的原始对象不会触发更新
	const entry = syncSteps.value[syncSteps.value.length - 1];
	scrollSyncLog();
	try {
		const res = await GitService.RunGitStep(repo.path, args, network);
		if (!res) throw new Error("后端未返回执行结果");
		entry.command = res.command;
		entry.output = res.output;
		entry.error = res.ok ? "" : res.error;
		entry.state = res.ok ? "ok" : "fail";
		scrollSyncLog();
		return res;
	} catch (e) {
		entry.command = "git " + args.join(" ");
		entry.error = errMsg(e);
		entry.state = "fail";
		scrollSyncLog();
		return null;
	}
}

/**
 * 同步目标分支 B：不切分支，把本地 B 快进到其上游
 * （git fetch <remote> <B>:<B>），保证后续 B..A 的提交列表
 * 与合并差异基于最新代码。失败（如本地与远程分叉）不阻塞，仅提示；
 * 真正合并时的 checkout + pull 会再次校验。
 */
async function syncTargetBranch(B: string) {
	const gen = ++syncGen;
	syncSteps.value = [];
	syncFailed.value = false;
	if (!B || phase.value !== "setup") return;
	const info = (repo.refs?.branches || []).find(
		(b) => !b.isRemote && b.name === B,
	);
	const remotes = repo.refs?.remotes || [];
	const remote = info?.tracking
		? info.tracking.split("/")[0]
		: remotes[0]?.name || "";
	const hasUpstream = !!info?.tracking && !info.gone;
	if (!remote || !hasUpstream) {
		syncSteps.value.push({
			id: syncSeq++,
			title: "跳过同步",
			kind: "note",
			state: "info",
			output: !remote
				? "仓库没有配置远程"
				: `${B} 没有配置上游分支，无法从远程更新`,
		});
		return;
	}
	syncing.value = true;
	try {
		const r = await runSyncStep(
			`同步目标分支 ${B}（从 ${remote} 快进本地引用，不切分支）`,
			["fetch", remote, `${B}:${B}`],
			true,
		);
		if (gen !== syncGen) return;
		if (!r || !r.ok) syncFailed.value = true;
	} finally {
		if (gen === syncGen) syncing.value = false;
	}
}

// ------------------------------------------------ 合并差异预览（B...A）

const diffStat = ref("");
const diffLoading = ref(false);
const diffError = ref("");
/** 丢弃过期的并发请求（快速切换目标分支时） */
let diffGen = 0;

async function refreshDiff() {
	const gen = ++diffGen;
	const A = source.value;
	const B = target.value;
	diffStat.value = "";
	diffError.value = "";
	if (!A || !B || phase.value !== "setup") return;
	diffLoading.value = true;
	try {
		const res = await GitService.RunGitStep(
			repo.path,
			["diff", "--stat", `${B}...${A}`],
			false,
		);
		if (gen !== diffGen) return;
		if (!res) throw new Error("后端未返回执行结果");
		if (!res.ok) {
			diffError.value = res.error || "读取差异失败";
			return;
		}
		diffStat.value = (res.output || "").trim();
	} catch (e) {
		if (gen === diffGen) diffError.value = errMsg(e);
	} finally {
		if (gen === diffGen) diffLoading.value = false;
	}
}

/** 选中目标分支后：先把 B 同步到最新，再刷新待合并提交与合并差异。 */
async function syncAndRefresh(B: string) {
	await syncTargetBranch(B);
	await Promise.all([refreshMergeCommits(), refreshDiff()]);
}
void syncAndRefresh(target.value);

// AI 模型选择：与提交信息生成一致，记住上次选择、失效时回退到第一个可用模型。
const AI_MODEL_KEY = "gv.aiMergeModel";
const aiModel = ref(localStorage.getItem(AI_MODEL_KEY) || "");
watch(aiModel, (v) => {
	try {
		localStorage.setItem(AI_MODEL_KEY, v);
	} catch {
		/* ignore */
	}
});
watch(
	() => ai.providers,
	() => {
		const list = availableAiModels(ai.providers);
		if (list.length === 0) return;
		const cur = aiModel.value;
		const valid = list.some(
			(c) => encodeModelValue(c.providerId, c.model) === cur,
		);
		if (!valid)
			aiModel.value = encodeModelValue(list[0].providerId, list[0].model);
	},
	{ deep: true, immediate: true },
);
const hasAiModel = computed(() => availableAiModels(ai.providers).length > 0);

const aiBusy = ref(false);
const aiError = ref("");
let chat: ChatSession | null = null;

/** 去掉模型偶尔多输出的围栏/引号，并压成单行。 */
function cleanSummary(text: string): string {
	let t = text.trim();
	const m = t.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
	if (m) t = m[1].trim();
	if (
		(t.startsWith('"') && t.endsWith('"')) ||
		(t.startsWith("「") && t.endsWith("」"))
	)
		t = t.slice(1, -1).trim();
	return t.replace(/\s*\n+\s*/g, " ");
}

/** AI 归纳待合并提交，流式写入合并信息输入框（生成中再次点击 = 停止）。 */
async function aiGenerate() {
	if (aiBusy.value) {
		chat?.stop();
		return;
	}
	if (!target.value || !source.value) return;
	aiError.value = "";
	let commits = mergeCommits.value;
	try {
		if (!commits) {
			await refreshMergeCommits();
			commits = mergeCommits.value;
		}
		if (!commits || !commits.length) {
			aiError.value = `${target.value} 已包含 ${source.value} 的全部提交，没有可归纳的内容`;
			return;
		}
		const { providerId, model } = decodeModelValue(aiModel.value);
		if (!providerId || !model) {
			if (!hasAiModel.value) {
				aiError.value = "还没有可用的 AI 模型，请先在设置中配置";
				return;
			}
			aiError.value = "请先选择 AI 模型";
			return;
		}
		aiBusy.value = true;
		message.value = "";
		msgEdited.value = true;
		chat = await startChat(
			{
				providerId,
				model,
				system: MERGE_SUMMARY_SYSTEM_PROMPT,
				user: buildMergeSummaryUserPrompt({
					sourceBranch: source.value,
					targetBranch: target.value,
					commits: commits.slice(0, 100).map((c) => ({
						hash: c.hash,
						subject: c.subject,
						author: c.author,
					})),
				}),
			},
			{
				onChunk: (t) => {
					message.value += t;
				},
				onDone: (content) => {
					message.value = cleanSummary(content);
					aiBusy.value = false;
					chat = null;
				},
				onError: (m) => {
					aiError.value = m;
					aiBusy.value = false;
					chat = null;
					if (!message.value.trim()) message.value = defaultMsg.value;
				},
			},
		);
	} catch (e) {
		aiError.value = errMsg(e);
		aiBusy.value = false;
	}
}

onBeforeUnmount(() => {
	chat?.stop();
	stopPoll();
});

// ------------------------------------------------------------- 步骤日志展示

interface StepEntry {
	id: number;
	title: string;
	/** cmd=正常命令 rollback=回滚命令 note=说明性条目 */
	kind: "cmd" | "rollback" | "note";
	state: "running" | "ok" | "fail" | "info";
	command?: string;
	output?: string;
	error?: string;
}

const steps = ref<StepEntry[]>([]);
let stepSeq = 0;
const logEl = ref<HTMLElement | null>(null);

function scrollLog() {
	nextTick(() => {
		const el = logEl.value;
		if (el) el.scrollTop = el.scrollHeight;
	});
}

function addNote(title: string, note: string) {
	steps.value.push({
		id: stepSeq++,
		title,
		kind: "note",
		state: "info",
		output: note,
	});
	scrollLog();
}

/** 执行一步 git 命令并把命令/输出追加到日志。返回 null 表示调用本身就失败。 */
async function runStep(
	title: string,
	args: string[],
	network = false,
	kind: "cmd" | "rollback" = "cmd",
): Promise<GitStepResult | null> {
	steps.value.push({ id: stepSeq++, title, kind, state: "running" });
	// 取回数组内的响应式代理再改，直接改 push 进去的原始对象不会触发更新
	const entry = steps.value[steps.value.length - 1];
	scrollLog();
	try {
		const res = await GitService.RunGitStep(repo.path, args, network);
		if (!res) throw new Error("后端未返回执行结果");
		entry.command = res.command;
		entry.output = res.output;
		entry.error = res.ok ? "" : res.error;
		entry.state = res.ok ? "ok" : "fail";
		scrollLog();
		return res;
	} catch (e) {
		entry.command = "git " + args.join(" ");
		entry.error = errMsg(e);
		entry.state = "fail";
		scrollLog();
		return null;
	}
}

// ------------------------------------------------------------------ 主流程

/** 流程期间使用的远程信息（start 时确定，供冲突恢复后的收尾步骤复用）。 */
const flow = ref({ remote: "", hasUpstream: false });

async function start() {
	if (!canStart.value) return;
	// 前置条件再确认一次（取最新状态，避免打开对话框后仓库被改动）
	await repo.refreshStatus();
	if (repo.status?.detached || !source.value) {
		ui.error("无法开始合并", "当前不在任何分支上");
		return;
	}
	if ((repo.status?.branch || "") !== source.value) {
		ui.error(
			"无法开始合并",
			`当前分支已变为 ${repo.status?.branch}，请重新打开对话框`,
		);
		emit("close");
		return;
	}
	if (repo.dirtyCount > 0 || repo.opInProgress) {
		ui.error(
			"无法开始合并",
			repo.opInProgress
				? "仓库有进行中的 merge/rebase 等操作"
				: `当前分支有 ${repo.dirtyCount} 个未提交的更改`,
		);
		return;
	}

	const A = source.value;
	const B = target.value;
	const info = (repo.refs?.branches || []).find(
		(b) => !b.isRemote && b.name === B,
	);
	const remotes = repo.refs?.remotes || [];
	flow.value = {
		remote: info?.tracking
			? info.tracking.split("/")[0]
			: remotes[0]?.name || "",
		hasUpstream: !!info?.tracking && !info.gone,
	};

	phase.value = "running";
	steps.value = [];

	// 1. 检出目标分支 B
	let r = await runStep(`检出目标分支 ${B}`, ["checkout", B]);
	if (!r || !r.ok) {
		addNote("流程终止", `未能检出 ${B}，当前仍在 ${A}`);
		await repo.refreshAll();
		phase.value = "failed";
		return;
	}

	// 2. fetch 远程
	if (flow.value.remote) {
		r = await runStep(
			`抓取远程 ${flow.value.remote}`,
			["fetch", flow.value.remote],
			true,
		);
		if (!r || !r.ok) return await rollbackFail("fetch 失败，已回滚");
	} else {
		addNote("跳过 fetch", "仓库没有配置远程");
	}

	// 3. pull 更新 B（仅当 B 配置了上游）
	if (flow.value.hasUpstream) {
		r = await runStep(`更新目标分支 ${B}（pull）`, ["pull"], true);
		if (!r || !r.ok) {
			if (await enterConflictIfAny("pull 产生冲突")) return;
			return await rollbackFail("pull 失败，已回滚");
		}
	} else {
		addNote("跳过 pull", `${B} 没有配置上游分支`);
	}

	// 4. merge A -m "<AI 归纳的合并信息>"
	const mergeArgs = ["merge"];
	if (noFF.value) mergeArgs.push("--no-ff");
	mergeArgs.push("-m", message.value.trim() || defaultMsg.value, A);
	r = await runStep(`合并 ${A} 到 ${B}`, mergeArgs);
	if (!r || !r.ok) {
		if (await enterConflictIfAny("合并产生冲突")) return;
		return await rollbackFail("合并失败，已回滚");
	}

	await finishFlow();
}

/** 收尾：push B → 切回 A。冲突解决后继续时也走这里。 */
async function finishFlow() {
	const A = source.value;
	const B = target.value;

	if (doPush.value && flow.value.remote) {
		const pushArgs = flow.value.hasUpstream
			? ["push", flow.value.remote, B]
			: ["push", "-u", flow.value.remote, B];
		const r = await runStep(
			`推送 ${B} 到 ${flow.value.remote}`,
			pushArgs,
			true,
		);
		if (!r || !r.ok) {
			addNote(
				"推送失败",
				`合并结果已保留在本地分支 ${B}，可稍后手动推送`,
			);
			await runStep(`切回源分支 ${A}`, ["checkout", A]);
			await repo.refreshAll();
			phase.value = "failed";
			return;
		}
	} else {
		addNote(
			"跳过 push",
			doPush.value ? "仓库没有配置远程" : "已选择不推送",
		);
	}

	const r = await runStep(`切回源分支 ${A}`, ["checkout", A]);
	await repo.refreshAll();
	phase.value = r && r.ok ? "success" : "failed";
	if (phase.value === "success") ui.success("合并完成", `${A} 已合并到 ${B}`);
}

/** 失败回滚：中止可能存在的合并，切回源分支 A。 */
async function rollbackFail(note: string) {
	await repo.refreshStatus();
	if (repo.status?.merging)
		await runStep(
			"回滚：中止合并",
			["merge", "--abort"],
			false,
			"rollback",
		);
	await runStep(
		`回滚：切回源分支 ${source.value}`,
		["checkout", source.value],
		false,
		"rollback",
	);
	addNote(note, `已回到源分支 ${source.value}，目标分支未受影响`);
	await repo.refreshAll();
	phase.value = "failed";
}

// ------------------------------------------------------------ 冲突暂停/恢复

const conflictFiles = computed(() => repo.status?.conflicted || []);

/** 失败后检查是否其实处于冲突状态；是则暂停流程返回 true。 */
async function enterConflictIfAny(reason: string): Promise<boolean> {
	await repo.refreshStatus();
	const st = repo.status;
	if (st && (st.merging || (st.conflicted?.length || 0) > 0)) {
		addNote(
			reason,
			"流程已暂停：请手动解决冲突（编辑器或文件状态视图），完成后点「已解决冲突，继续」",
		);
		phase.value = "conflict";
		return true;
	}
	return false;
}

// 暂停期间轮询状态：用户在外部解决冲突时，对话框内的冲突文件列表实时更新
let pollTimer: number | undefined;
function startPoll() {
	stopPoll();
	pollTimer = window.setInterval(() => void repo.refreshStatus(), 2000);
}
function stopPoll() {
	if (pollTimer) window.clearInterval(pollTimer);
	pollTimer = undefined;
}
watch(phase, (p) => {
	if (p === "conflict") startPoll();
	else stopPoll();
});

/** 「已解决冲突，继续」：校验 → 暂存/提交合并 → 走收尾流程。 */
async function continueFlow() {
	if (phase.value !== "conflict") return;
	stopPoll();
	phase.value = "running";
	await repo.refreshStatus();
	const st = repo.status;

	if (st && (st.conflicted?.length || 0) > 0) {
		ui.error("还有未解决的冲突文件", "请全部解决后再继续");
		phase.value = "conflict";
		return;
	}
	if (st?.merging) {
		if ((st.unstaged?.length || 0) + (st.untracked?.length || 0) > 0) {
			const a = await runStep("暂存冲突解决结果", ["add", "-A"]);
			if (!a || !a.ok) {
				addNote("暂存失败", "请检查上方输出后重试");
				phase.value = "conflict";
				return;
			}
		}
		const c = await runStep("提交合并结果", ["commit", "--no-edit"]);
		if (!c || !c.ok) {
			addNote("提交合并失败", "可重试，或关闭对话框后手动处理");
			phase.value = "conflict";
			return;
		}
	} else {
		addNote("无需提交合并", "未检测到进行中的合并（可能已在外部提交）");
	}
	await finishFlow();
}

/** 「中止合并」：merge --abort 并切回 A。 */
async function abortFlow() {
	if (phase.value !== "conflict") return;
	stopPoll();
	phase.value = "running";
	await runStep("中止合并", ["merge", "--abort"], false, "rollback");
	await runStep(
		`切回源分支 ${source.value}`,
		["checkout", source.value],
		false,
		"rollback",
	);
	addNote("已中止本次合并", `已回到源分支 ${source.value}`);
	await repo.refreshAll();
	phase.value = "failed";
}

// ------------------------------------------------------------------ 关闭

const closeHint = ref("");

function attemptClose() {
	if (phase.value === "running") {
		closeHint.value = "流程执行中，暂不能关闭";
		setTimeout(() => (closeHint.value = ""), 2000);
		return;
	}
	if (phase.value === "conflict") {
		ui.info(
			"合并仍处于冲突状态",
			"可在文件状态视图中继续解决冲突，或中止合并",
		);
	}
	chat?.stop();
	stopPoll();
	emit("close");
}
</script>

<template>
	<ModalDialog title="当前分支合并到…" :width="640" @close="attemptClose">
		<!-- 设置阶段 -->
		<template v-if="phase === 'setup'">
			<div class="flow-line">
				<span class="chip chip-current">
					<Icon name="branch" :size="10" /> {{ source || "HEAD" }}
				</span>
				<Icon name="chevron-right" :size="13" />
				<div class="target-pick">
					<SelectMenu
						v-model="target"
						:options="targetOptions"
						placeholder="选择要合并进去的本地分支…"
						full-width
						:max-height="280"
					/>
				</div>
			</div>

			<div v-if="readyError" class="warn-banner">
				<Icon name="alert" :size="13" /> {{ readyError }}
			</div>

			<!-- 同步目标分支：不切分支把本地 B 快进到上游，命令与输出在此展示 -->
			<div v-if="target && syncSteps.length" class="field">
				<span class="label">
					同步目标分支 {{ target }}
					<Spinner v-if="syncing" :size="10" />
					<template v-else-if="syncFailed">（同步失败）</template>
				</span>
				<div v-if="syncFailed" class="hint err">
					无法把本地
					{{ target }}
					快进到远程（可能与远程有分叉），下方提交列表基于本地
					{{ target }}；开始合并后的 pull 步骤会再次校验
				</div>
				<div ref="syncLogEl" class="step-log compact">
					<div
						v-for="s in syncSteps"
						:key="s.id"
						class="step"
						:class="[s.state, s.kind]"
					>
						<div class="step-head">
							<span class="step-icon">
								<Spinner
									v-if="s.state === 'running'"
									:size="12"
								/>
								<Icon
									v-else-if="s.state === 'ok'"
									name="check"
									:size="13"
								/>
								<Icon
									v-else-if="s.state === 'fail'"
									name="x"
									:size="13"
								/>
								<Icon v-else name="info" :size="13" />
							</span>
							<span class="step-title">{{ s.title }}</span>
						</div>
						<code v-if="s.command" class="step-cmd">{{
							s.command
						}}</code>
						<pre v-if="s.output" class="step-out">{{
							s.output
						}}</pre>
						<pre v-if="s.error" class="step-err">{{ s.error }}</pre>
					</div>
				</div>
			</div>

			<!-- 待合并提交概览 -->
			<div v-if="target" class="field">
				<span class="label">
					将合并的提交
					<Spinner v-if="commitsLoading" :size="10" />
					<template v-else-if="commitCount >= 0"
						>（{{ commitCount }} 个）</template
					>
				</span>
				<div v-if="commitsError" class="hint err">
					读取提交失败：{{ commitsError }}
				</div>
				<div v-else-if="nothingToMerge" class="hint">
					{{ target }} 已包含 {{ source }} 的全部提交，合并将为空操作
				</div>
				<div
					v-else-if="mergeCommits && mergeCommits.length"
					class="commit-list"
				>
					<div
						v-for="c in mergeCommits.slice(0, 6)"
						:key="c.hash"
						class="commit-row"
					>
						<span class="hash">{{ c.hash.slice(0, 7) }}</span>
						<span class="subj">{{ c.subject }}</span>
					</div>
					<div v-if="mergeCommits.length > 6" class="hint">
						…等共 {{ mergeCommits.length }} 个提交
					</div>
				</div>
			</div>

			<!-- 合并信息 -->
			<div class="field">
				<span class="label">合并提交信息（git merge -m）</span>
				<textarea
					v-model="message"
					class="msg-input"
					rows="3"
					placeholder="合并信息，可用 AI 根据待合并提交归纳…"
					:disabled="phase !== 'setup'"
					@input="msgEdited = true"
				/>
				<div class="ai-row">
					<div class="ai-model">
						<AiModelSelect v-model="aiModel" :disabled="aiBusy" />
					</div>
					<button
						class="btn"
						:disabled="!target || !!readyError"
						:title="
							hasAiModel
								? '用 AI 归纳待合并提交，生成合并信息'
								: '还没有可用的 AI 模型，点击前往设置配置'
						"
						@click="
							hasAiModel
								? aiGenerate()
								: ui.openSettings('aimodels')
						"
					>
						<Spinner v-if="aiBusy" :size="12" />
						<Icon v-else name="sparkles" :size="12" />
						{{ aiBusy ? "停止生成" : "AI 归纳生成" }}
					</button>
				</div>
				<div v-if="aiError" class="hint err">{{ aiError }}</div>
			</div>

			<!-- 合并差异预览（基于 merge-base，显示 A 将带入 B 的文件变更） -->
			<div v-if="target" class="field">
				<span class="label">
					合并差异（{{ source }} → {{ target }}）
					<Spinner v-if="diffLoading" :size="10" />
				</span>
				<code class="diff-cmd"
					>git diff --stat {{ target }}...{{ source }}</code
				>
				<div v-if="diffError" class="hint err">
					读取差异失败：{{ diffError }}
				</div>
				<div v-else-if="!diffLoading && !diffStat" class="hint">
					没有文件差异
				</div>
				<pre v-else class="diff-stat">{{ diffStat }}</pre>
			</div>

			<label class="check">
				<Checkbox v-model="noFF" />
				总是生成合并提交（--no-ff）
			</label>
			<label class="check">
				<Checkbox v-model="doPush" />
				合并后推送 {{ target || "目标分支" }} 到远程
			</label>

			<div class="hint steps-hint">
				打开对话框时已先把
				{{ target || "目标分支" }} 同步到最新；执行步骤：checkout
				{{ target || "B" }} → fetch → pull → merge {{ source || "A" }} →
				push → checkout
				{{
					source || "A"
				}}，每步的命令与输出都会显示出来；冲突时会暂停等你解决。
			</div>
		</template>

		<!-- 执行 / 冲突 / 结果阶段：步骤日志 -->
		<template v-else>
			<div class="phase-banner" :class="phase">
				<Spinner v-if="phase === 'running'" :size="13" />
				<Icon
					v-else-if="phase === 'conflict'"
					name="alert"
					:size="14"
				/>
				<Icon
					v-else-if="phase === 'success'"
					name="check-circle"
					:size="14"
				/>
				<Icon v-else name="x" :size="14" />
				<span v-if="phase === 'running'">正在执行合并流程…</span>
				<span v-else-if="phase === 'conflict'">
					合并冲突，流程已暂停 — 请解决冲突后继续
					<template v-if="conflictFiles.length">
						（{{ conflictFiles.length }} 个冲突文件）
					</template>
				</span>
				<span v-else-if="phase === 'success'">
					流程完成：{{ source }} 已合并到 {{ target }}
				</span>
				<span v-else>流程未完成，请查看下方日志</span>
			</div>

			<div
				v-if="phase === 'conflict' && conflictFiles.length"
				class="conflict-files"
			>
				<div
					v-for="f in conflictFiles"
					:key="f.path"
					class="conflict-file"
				>
					<Icon name="alert" :size="11" />
					<span class="path">{{ f.path }}</span>
				</div>
			</div>

			<div ref="logEl" class="step-log">
				<div
					v-for="s in steps"
					:key="s.id"
					class="step"
					:class="[s.state, s.kind]"
				>
					<div class="step-head">
						<span class="step-icon">
							<Spinner v-if="s.state === 'running'" :size="12" />
							<Icon
								v-else-if="s.state === 'ok'"
								name="check"
								:size="13"
							/>
							<Icon
								v-else-if="s.state === 'fail'"
								name="x"
								:size="13"
							/>
							<Icon v-else name="info" :size="13" />
						</span>
						<span class="step-title">{{ s.title }}</span>
					</div>
					<code v-if="s.command" class="step-cmd">{{
						s.command
					}}</code>
					<pre v-if="s.output" class="step-out">{{ s.output }}</pre>
					<pre v-if="s.error" class="step-err">{{ s.error }}</pre>
				</div>
			</div>
		</template>

		<template #footer>
			<span v-if="closeHint" class="hint err close-hint">{{
				closeHint
			}}</span>
			<template v-if="phase === 'setup'">
				<button class="btn" @click="attemptClose">取消</button>
				<button
					class="btn btn-primary"
					:disabled="!canStart"
					@click="start"
				>
					<Icon name="merge" :size="13" /> 开始合并
				</button>
			</template>
			<template v-else-if="phase === 'conflict'">
				<button class="btn btn-danger" @click="abortFlow">
					中止合并
				</button>
				<button class="btn btn-primary" @click="continueFlow">
					<Icon name="check" :size="13" /> 已解决冲突，继续
				</button>
			</template>
			<template v-else-if="phase === 'success' || phase === 'failed'">
				<button class="btn btn-primary" @click="attemptClose">
					关闭
				</button>
			</template>
			<template v-else>
				<button class="btn" disabled>
					<Spinner :size="12" /> 执行中…
				</button>
			</template>
		</template>
	</ModalDialog>
</template>

<style scoped>
.flow-line {
	display: flex;
	align-items: center;
	gap: 8px;
}
.target-pick {
	flex: 1;
	min-width: 0;
}
.field {
	display: flex;
	flex-direction: column;
	gap: 5px;
}
.label {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	font-size: 11.5px;
	color: var(--text-dim);
}
.warn-banner {
	display: flex;
	align-items: center;
	gap: 7px;
	padding: 7px 10px;
	border-radius: 7px;
	background: var(--red-wash);
	border: 1px solid var(--red);
	color: var(--red);
	font-size: 12px;
}
.hint {
	font-size: 11px;
	color: var(--text-faint);
	line-height: 1.5;
}
.hint.err {
	color: var(--red);
}
.commit-list {
	display: flex;
	flex-direction: column;
	gap: 2px;
	max-height: 130px;
	overflow-y: auto;
	padding: 6px 8px;
	border: 1px solid var(--border);
	border-radius: 7px;
	background: var(--bg-input);
}
.commit-row {
	display: flex;
	gap: 8px;
	font-size: 11.5px;
	min-width: 0;
}
.commit-row .hash {
	flex: none;
	font-family: var(--font-mono, monospace);
	color: var(--accent);
}
.commit-row .subj {
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	color: var(--text);
}
.msg-input {
	width: 100%;
	resize: vertical;
	font-size: 12.5px;
	line-height: 1.5;
	padding: 7px 9px;
}
.ai-row {
	display: flex;
	align-items: center;
	gap: 8px;
}
.ai-model {
	flex: 1;
	min-width: 0;
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
.steps-hint {
	border-top: 1px solid var(--border);
	padding-top: 8px;
}

/* ------------------------------------------------------------- 执行阶段 */
.phase-banner {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 8px 11px;
	border-radius: 7px;
	font-size: 12.5px;
	border: 1px solid var(--border-strong);
}
.phase-banner.running {
	background: var(--hover-soft);
	color: var(--text-strong);
}
.phase-banner.conflict {
	background: var(--banner-merge-bg);
	border-color: var(--yellow);
	color: var(--yellow);
}
.phase-banner.success {
	background: var(--green-wash, rgba(60, 160, 80, 0.12));
	border-color: var(--green);
	color: var(--green);
}
.phase-banner.failed {
	background: var(--red-wash);
	border-color: var(--red);
	color: var(--red);
}
.conflict-files {
	display: flex;
	flex-direction: column;
	gap: 2px;
	max-height: 110px;
	overflow-y: auto;
	padding: 6px 8px;
	border: 1px solid var(--yellow);
	border-radius: 7px;
	background: var(--banner-merge-bg);
}
.conflict-file {
	display: flex;
	align-items: center;
	gap: 6px;
	font-size: 11.5px;
	color: var(--yellow);
	min-width: 0;
}
.conflict-file .path {
	font-family: var(--font-mono, monospace);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.step-log {
	display: flex;
	flex-direction: column;
	gap: 6px;
	max-height: 340px;
	min-height: 160px;
	overflow-y: auto;
	padding: 8px 10px;
	border: 1px solid var(--border);
	border-radius: 8px;
	background: var(--term-bg);
	user-select: text;
}
.step {
	display: flex;
	flex-direction: column;
	gap: 3px;
	min-width: 0;
}
.step-head {
	display: flex;
	align-items: center;
	gap: 7px;
	font-size: 12px;
	font-weight: 600;
	color: var(--text-strong);
}
.step.ok .step-icon {
	color: var(--green);
}
.step.fail .step-icon,
.step.fail .step-title {
	color: var(--red);
}
.step.info .step-icon,
.step.info .step-title {
	color: var(--text-dim);
	font-weight: 500;
}
.step.rollback .step-title {
	color: var(--yellow);
}
.step-icon {
	display: inline-flex;
	flex: none;
}
.step-cmd {
	margin-left: 20px;
	font-family: var(--font-mono, monospace);
	font-size: 11px;
	color: var(--accent);
	white-space: pre-wrap;
	overflow-wrap: anywhere;
}
.step-out {
	margin: 0 0 0 20px;
	padding: 5px 8px;
	border-left: 2px solid var(--border-strong);
	border-radius: 5px;
	background: var(--bg-panel);
	color: var(--text);
	font-family: var(--font-mono, monospace);
	font-size: 10.5px;
	line-height: 1.55;
	white-space: pre-wrap;
	overflow-wrap: anywhere;
	max-height: 160px;
	overflow-y: auto;
}
.step-err {
	margin: 0 0 0 20px;
	padding: 5px 8px;
	border-left: 2px solid var(--red);
	border-radius: 5px;
	background: var(--red-wash);
	color: var(--red);
	font-family: var(--font-mono, monospace);
	font-size: 10.5px;
	line-height: 1.55;
	white-space: pre-wrap;
	overflow-wrap: anywhere;
}
.step-log.compact {
	min-height: 0;
	max-height: 220px;
}
.diff-cmd {
	display: block;
	margin: 6px 0;
	font-family: var(--font-mono, monospace);
	font-size: 11px;
	color: var(--accent);
}
.diff-stat {
	margin: 0;
	padding: 6px 9px;
	border: 1px solid var(--border);
	border-radius: 7px;
	background: var(--term-bg);
	color: var(--text);
	font-family: var(--font-mono, monospace);
	font-size: 10.5px;
	line-height: 1.55;
	white-space: pre-wrap;
	overflow-wrap: anywhere;
	max-height: 220px;
	overflow-y: auto;
	user-select: text;
}
.close-hint {
	margin-right: auto;
}
</style>
