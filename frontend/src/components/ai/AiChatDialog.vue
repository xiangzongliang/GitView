<script setup lang="ts">
// 通用流式 AI 对话弹窗：负责发起请求，并按时间顺序展示
// 「模型思考 → 工具调用 → 模型输出」的完整过程。
// 与具体任务解耦——调用方通过 props 传入提示词，用 apply 事件处理结果，
// 因此可以复用到其它需要流式对话的场景。
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { errMsg } from "../../api";
import { startChat, type ChatSession } from "../../ai/chat";
import ModalDialog from "../ui/ModalDialog.vue";
import Icon from "../ui/Icon.vue";
import Spinner from "../ui/Spinner.vue";

const props = withDefaults(
	defineProps<{
		title: string;
		/** 系统提示词 */
		system: string;
		/** 首条用户消息 */
		user: string;
		providerId: string;
		model: string;
		/** 非空时启用仓库工具（read_file） */
		repoPath?: string;
		/** 底部「应用」按钮文案；为空则不显示该按钮 */
		applyLabel?: string;
		/**
		 * 最终输出的格式化钩子（如统一添加提交前缀）。
		 * 展示与应用共用，保证「所见即所得」。应在对话期间保持稳定。
		 */
		formatOutput?: (text: string) => string;
		width?: number;
	}>(),
	{
		repoPath: "",
		applyLabel: "",
		formatOutput: (text: string) => text,
		width: 640,
	},
);

const emit = defineEmits<{
	(e: "close"): void;
	(e: "apply", content: string): void;
}>();

/**
 * 时间线上的一个步骤。用单一定义（而非联合类型）是为了让模板里
 * 直接取字段，避免在模板中做类型收窄。
 */
interface ChatStep {
	id: number;
	/** thinking=模型思考，tool=工具调用，output=模型输出 */
	kind: "thinking" | "tool" | "output";
	/** thinking / output 的文本 */
	text: string;
	/** tool 专用：工具名与原始参数 */
	name: string;
	args: string;
	result?: string;
	done: boolean;
	/** thinking / tool 是否展开（思考结束会自动折叠） */
	open: boolean;
}

const steps = ref<ChatStep[]>([]);
const error = ref("");
const running = ref(false);
const scroller = ref<HTMLElement | null>(null);
/** 用户是否停留在底部：只有贴底时才自动滚动，避免打断向上翻阅 */
const stick = ref(true);

let seq = 0;
let session: ChatSession | null = null;
// 组件卸载后仍可能有回调到达（取消是异步的），用它避免改动已销毁的状态。
let disposed = false;

function lastStep(): ChatStep | undefined {
	return steps.value[steps.value.length - 1];
}

function pushStep(kind: ChatStep["kind"]): ChatStep {
	const s: ChatStep = {
		id: ++seq,
		kind,
		text: "",
		name: "",
		args: "",
		done: false,
		open: true,
	};
	steps.value.push(s);
	return s;
}

/** 把仍在进行中的步骤标记为完成；刚结束的思考步骤自动折叠。 */
function finishOpenSteps() {
	for (const s of steps.value) {
		if (s.done) continue;
		s.done = true;
		if (s.kind === "thinking") s.open = false;
	}
}

function onScroll() {
	const el = scroller.value;
	if (!el) return;
	stick.value = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
}

/** 滚到底部（仅在跟随状态下）。 */
function scrollToEnd() {
	const el = scroller.value;
	if (!el || !stick.value) return;
	el.scrollTop = el.scrollHeight;
}

// 思考 / 工具块的内容也限高（超高才滚），因此它自己也需要贴底。
// 用 element.dataset 记住用户是否翻过该块：翻过就不再把它强行拉回。
function onBodyScroll(e: Event) {
	const el = e.target as HTMLElement | null;
	if (!el) return;
	el.dataset.stick =
		el.scrollHeight - el.scrollTop - el.clientHeight < 24 ? "1" : "0";
}

function followBodies() {
	const root = scroller.value;
	if (!root) return;
	const list = root.querySelectorAll<HTMLElement>(".step-body");
	const el = list[list.length - 1];
	if (!el || el.dataset.stick === "0") return;
	el.scrollTop = el.scrollHeight;
}

// 思考 / 工具 / 输出的每一次增量都会让内容变高，需要重新贴底。
// flush: 'post' 保证在 DOM 更新之后才读 scrollHeight（否则会差一帧、滚不到位）；
// rAF 把同一帧内的多次增量合并成一次，避免每来一个字就强制一次布局。
let followQueued = false;
function scheduleFollow() {
	if (followQueued) return;
	followQueued = true;
	requestAnimationFrame(() => {
		followQueued = false;
		scrollToEnd();
		followBodies();
	});
}
watch(steps, scheduleFollow, { deep: true, flush: "post" });

/** 「回到底部」：恢复跟随并滚到末尾（含各内容块内部的跟随）。 */
function jumpToEnd() {
	stick.value = true;
	const el = scroller.value;
	if (!el) return;
	for (const body of Array.from(
		el.querySelectorAll<HTMLElement>(".step-body"),
	)) {
		body.dataset.stick = "1";
		body.scrollTop = body.scrollHeight;
	}
	el.scrollTop = el.scrollHeight;
}

async function generate() {
	if (running.value) return;
	steps.value = [];
	error.value = "";
	running.value = true;
	stick.value = true;
	session?.stop();
	session = null;
	try {
		session = await startChat(
			{
				providerId: props.providerId,
				model: props.model,
				system: props.system,
				user: props.user,
				repoPath: props.repoPath,
			},
			{
				onReasoning(t) {
					const last = lastStep();
					const step =
						last && last.kind === "thinking" && !last.done
							? last
							: pushStep("thinking");
					step.text += t;
				},
				onChunk(t) {
					const last = lastStep();
					const step =
						last && last.kind === "output" && !last.done
							? last
							: pushStep("output");
					step.text += t;
				},
				onTool(a) {
					if (!a.done) {
						const step = pushStep("tool");
						step.name = a.name;
						step.args = a.args;
						step.open = false;
						return;
					}
					// 结束事件只带结果，回填到最后一条进行中的工具调用上。
					const last = lastStep();
					if (last && last.kind === "tool") {
						last.done = true;
						last.result = a.result;
					}
				},
				onRound() {
					// 一轮思考结束：折叠本轮的思考过程。
					finishOpenSteps();
				},
				onDone(content) {
					session = null;
					running.value = false;
					const last = lastStep();
					if (content.trim()) {
						if (last && last.kind === "output") {
							last.text = content;
						} else {
							pushStep("output").text = content;
						}
					}
					finishOpenSteps();
				},
				onError(message) {
					session = null;
					running.value = false;
					finishOpenSteps();
					// 用户主动停止不算错误提示，直接保留已有过程。
					if (message !== "已取消") error.value = message;
				},
			},
		);
	} catch (e) {
		running.value = false;
		error.value = errMsg(e);
	}
	if (disposed) {
		// 加载过程中弹窗已关闭：立刻收尾。
		session?.stop();
		session = null;
	}
}

function stop() {
	session?.stop();
	session = null;
	running.value = false;
	finishOpenSteps();
}

/** 折叠时展示的一行摘要。 */
function preview(text: string): string {
	const t = text.replace(/\s+/g, " ").trim();
	return t.length > 80 ? `${t.slice(0, 80)}…` : t;
}

/** 工具名 → 中文动作描述，让过程更好读。 */
function toolLabel(s: ChatStep): string {
	if (s.name === "read_file") {
		try {
			const args = JSON.parse(s.args || "{}") as {
				path?: string;
				startLine?: number;
				endLine?: number;
			};
			const range =
				args.startLine && args.endLine
					? ` 第 ${args.startLine}-${args.endLine} 行`
					: "";
			return `读取文件 ${args.path || ""}${range}`;
		} catch {
			/* 参数不是合法 JSON 时退回通用文案 */
		}
	}
	return `调用工具 ${s.name || "…"}`;
}

/** 工具执行失败（后端把错误作为结果文本回灌）。 */
function toolFailed(s: ChatStep): boolean {
	return !!s.result && s.result.startsWith("错误");
}

function toolDetail(s: ChatStep): string {
	const parts = [`参数：${s.args || "（无）"}`];
	if (s.done) parts.push("", `结果：`, s.result || "（空）");
	else parts.push("", "执行中…");
	return parts.join("\n");
}

/** 「应用」按钮使用的内容：最后一段模型输出（经 formatOutput 装饰）。 */
const applyText = computed(() => {
	const last = lastStep();
	return last && last.kind === "output" ? props.formatOutput(last.text) : "";
});

onMounted(generate);
onBeforeUnmount(() => {
	disposed = true;
	session?.stop();
	session = null;
});
</script>

<template>
	<ModalDialog :title="title" :width="width" @close="emit('close')">
		<div class="chat-wrap">
			<div
				ref="scroller"
				class="chat"
				:class="{ 'chat-empty': !steps.length && !error }"
				@scroll="onScroll"
			>
				<template v-for="s in steps" :key="s.id">
					<!-- 模型思考：流出中展开，一轮结束后自动折叠 -->
					<div v-if="s.kind === 'thinking'" class="step thinking">
						<button class="step-head" @click="s.open = !s.open">
							<Icon
								:name="
									s.open ? 'chevron-down' : 'chevron-right'
								"
								:size="12"
								class="step-arrow"
							/>
							<Icon
								name="sparkles"
								:size="11"
								class="step-icon"
								:spin="!s.done"
							/>
							<span class="step-title">思考过程</span>
							<span v-if="!s.open" class="step-preview">{{
								preview(s.text)
							}}</span>
						</button>
						<pre
							v-if="s.open"
							class="step-body"
							@scroll="onBodyScroll"
							>{{ s.text }}</pre>
					</div>

					<!-- 工具调用 -->
					<div v-else-if="s.kind === 'tool'" class="step tool">
						<button class="step-head" @click="s.open = !s.open">
							<Icon
								:name="
									s.open ? 'chevron-down' : 'chevron-right'
								"
								:size="12"
								class="step-arrow"
							/>
							<Spinner v-if="!s.done" :size="11" />
							<Icon
								v-else
								:name="toolFailed(s) ? 'alert-circle' : 'check'"
								:size="11"
								class="step-icon"
								:class="{ failed: toolFailed(s) }"
							/>
							<span class="step-title">{{ toolLabel(s) }}</span>
						</button>
						<pre
							v-if="s.open"
							class="step-body"
							@scroll="onBodyScroll"
							>{{ toolDetail(s) }}</pre>
					</div>

					<!-- 模型输出 -->
					<pre v-else class="output">{{ formatOutput(s.text) }}</pre>
				</template>

				<div v-if="!steps.length && running" class="placeholder">
					<Spinner :size="13" /> 正在生成…
				</div>
				<div v-else-if="!steps.length && !error" class="placeholder">
					没有生成内容。
				</div>

				<div v-if="error" class="err">
					<Icon name="alert-circle" :size="13" />
					<span>{{ error }}</span>
				</div>
			</div>

			<!-- 用户向上翻阅时暂停跟随，给一个直接回到底部的入口 -->
			<button v-if="!stick" class="jump" @click="jumpToEnd">
				<Icon name="chevron-down" :size="12" />
				回到底部
			</button>
		</div>

		<template #footer>
			<button v-if="running" class="btn" @click="stop">
				<Icon name="x" :size="13" /> 停止
			</button>
			<button v-else class="btn" @click="generate">
				<Icon name="refresh" :size="13" /> 重新生成
			</button>
			<div class="spacer" />
			<button class="btn" @click="emit('close')">取消</button>
			<button
				v-if="applyLabel"
				class="btn btn-primary"
				:disabled="running || !applyText.trim()"
				@click="emit('apply', applyText)"
			>
				<Icon name="check" :size="13" /> {{ applyLabel }}
			</button>
		</template>
	</ModalDialog>
</template>

<style scoped>
/* 固定高度：弹出后尺寸不再随流式内容变化，避免弹窗忽大忽小、按钮跟着跳。
   内容超出由内部滚动（贴底时自动跟随）。 */
.chat-wrap {
	position: relative;
	/* 不要把固定高度的内容区压扁：让它保持高度，超出部分由弹窗自身处理 */
	flex: none;
}
.chat {
	display: flex;
	flex-direction: column;
	gap: 8px;
	height: 50vh;
	overflow-y: auto;
	/* 关掉浏览器滚动锚定：否则它会和程序化贴底互相抢位置 */
	overflow-anchor: none;
	/* 滚到边界时不把滚动传给外层 */
	overscroll-behavior: contain;
}
/* 步骤块不参与压缩：内容超出时由 .chat 滚动。
   列 flex 布局的子项默认 flex-shrink:1，会先把思考/工具块挤小（
   .step-body 是 overflow:auto，自动最小尺寸为 0，能被压到几乎看不见），
   所以必须显式关闭收缩。 */
.chat > * {
	flex: none;
}
/* 无内容时占位文案垂直居中 */
.chat-empty {
	justify-content: center;
	align-items: center;
}

/* 恢复跟随（用户向上翻阅后出现） */
.jump {
	position: absolute;
	right: 10px;
	bottom: 10px;
	display: inline-flex;
	align-items: center;
	gap: 4px;
	height: 24px;
	padding: 0 9px;
	border: 1px solid var(--border-strong);
	border-radius: 12px;
	background: var(--bg-panel-2);
	color: var(--text-dim);
	font-size: 11px;
	box-shadow: var(--shadow-select);
}
.jump:hover {
	color: var(--text-strong);
	border-color: var(--accent);
}

/* 可折叠步骤（思考 / 工具） */
.step {
	border: 1px solid var(--border);
	border-radius: 8px;
	background: var(--bg-panel-2);
	overflow: hidden;
}
.step-head {
	display: flex;
	align-items: center;
	gap: 7px;
	width: 100%;
	padding: 6px 9px;
	font-size: 11.5px;
	color: var(--text-dim);
	text-align: left;
}
.step-head:hover {
	background: var(--bg-hover);
	color: var(--text-strong);
}
.step-arrow {
	flex: none;
	color: var(--text-faint);
}
.step-icon {
	flex: none;
	color: var(--text-faint);
}
.step-icon.failed {
	color: var(--diff-del-text);
}
.step-title {
	flex: none;
	font-weight: 600;
}
/* 折叠后的一行摘要：占据剩余宽度并省略号截断 */
.step-preview {
	flex: 1;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	color: var(--text-faint);
	font-weight: 400;
}
.step-body {
	margin: 0;
	padding: 0 10px 9px;
	font-family: inherit;
	font-size: 11.5px;
	line-height: 1.6;
	color: var(--text-dim);
	white-space: pre-wrap;
	word-break: break-word;
	/* 限高：超过后在本块内滚动，避免一段超长思考把弹窗内容区撞满 */
	max-height: 200px;
	overflow-y: auto;
	/* 与内层滚动一致，关掉滚动锚定以免和贴底互抢 */
	overflow-anchor: none;
}

/* 模型输出（最终结果） */
.output {
	margin: 0;
	padding: 10px 12px;
	border: 1px solid var(--border);
	border-radius: 8px;
	background: var(--bg-input);
	color: var(--text-strong);
	font-family: inherit;
	font-size: 12.5px;
	line-height: 1.6;
	white-space: pre-wrap;
	word-break: break-word;
}

.placeholder {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 14px 4px;
	font-size: 12px;
	color: var(--text-faint);
}

.err {
	display: flex;
	align-items: flex-start;
	gap: 7px;
	font-size: 12px;
	color: var(--diff-del-text);
}
.spacer {
	flex: 1;
}
</style>
