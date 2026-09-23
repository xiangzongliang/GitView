import {
	AiService,
	Events,
	AI_CHUNK_EVENT,
	AI_REASONING_EVENT,
	AI_TOOL_EVENT,
	AI_ROUND_EVENT,
	AI_DONE_EVENT,
	AI_ERROR_EVENT,
} from "../api";
import type {
	AiChunkPayload,
	AiReasoningPayload,
	AiToolPayload,
	AiRoundPayload,
	AiDonePayload,
	AiErrorPayload,
} from "../api";

// 通用流式对话客户端：封装「订阅事件 → 发起请求 → 增量回调」这套流程，
// 与具体场景（提交信息、代码问答…）无关，后续其它 AI 对话框可直接复用。
//
// 事件订阅先于发起请求，因此 streamId 由前端生成，避免漏掉最早的分片。

/** 一次对话中工具调用的状态。 */
export interface ChatToolActivity {
	name: string;
	/** 模型给出的原始 JSON 参数 */
	args: string;
	/** 执行结果（完成后才有） */
	result?: string;
	done: boolean;
}

/** 流式对话回调。 */
export interface ChatCallbacks {
	/** 收到一段助手正文增量 */
	onChunk(text: string): void;
	/** 收到一段思考过程（reasoning）增量，模型不返回思考时不会被调用 */
	onReasoning?(text: string): void;
	/** 工具调用状态变化（可选） */
	onTool?(activity: ChatToolActivity): void;
	/** 一轮「思考 → (工具调用)」结束（可选） */
	onRound?(index: number): void;
	/** 生成结束，content 为最终完整文本 */
	onDone(content: string): void;
	/** 出错或被取消 */
	onError(message: string): void;
}

export interface ChatOptions {
	providerId: string;
	model: string;
	/** 系统提示词 */
	system: string;
	/** 首条用户消息 */
	user: string;
	/** 非空时后端启用仓库工具（read_file） */
	repoPath?: string;
	/** 工具调用循环的最大轮数，0/省略用后端默认值 */
	maxRounds?: number;
}

export interface ChatSession {
	streamId: string;
	/** 取消本次对话（断开请求并停止推送事件） */
	stop(): void;
}

let streamSeq = 0;

function newStreamId(): string {
	streamSeq += 1;
	return `ai_${Date.now().toString(36)}_${streamSeq.toString(36)}`;
}

/**
 * 发起一次流式对话。回调在整段生成过程中被多次触发；
 * 返回的会话对象可调用 stop() 取消。
 */
export async function startChat(
	opts: ChatOptions,
	cb: ChatCallbacks,
): Promise<ChatSession> {
	const streamId = newStreamId();
	const offs: Array<() => void> = [];
	const cleanup = () => {
		for (const off of offs) off();
		offs.length = 0;
	};
	// 只处理属于本次对话的事件（后端会带 streamId 回传）。
	const belongs = (data: unknown) =>
		(data as { streamId?: string } | null)?.streamId === streamId;

	offs.push(
		Events.On(AI_CHUNK_EVENT, (ev: { data?: unknown }) => {
			if (!belongs(ev.data)) return;
			cb.onChunk((ev.data as AiChunkPayload).text || "");
		}),
	);
	offs.push(
		Events.On(AI_REASONING_EVENT, (ev: { data?: unknown }) => {
			if (!belongs(ev.data)) return;
			cb.onReasoning?.((ev.data as AiReasoningPayload).text || "");
		}),
	);
	offs.push(
		Events.On(AI_TOOL_EVENT, (ev: { data?: unknown }) => {
			if (!belongs(ev.data)) return;
			const d = ev.data as AiToolPayload;
			cb.onTool?.({
				name: d.name,
				args: d.args,
				result: d.result,
				done: d.done,
			});
		}),
	);
	offs.push(
		Events.On(AI_ROUND_EVENT, (ev: { data?: unknown }) => {
			if (!belongs(ev.data)) return;
			cb.onRound?.((ev.data as AiRoundPayload).index ?? 0);
		}),
	);
	offs.push(
		Events.On(AI_DONE_EVENT, (ev: { data?: unknown }) => {
			if (!belongs(ev.data)) return;
			cleanup();
			cb.onDone((ev.data as AiDonePayload).content || "");
		}),
	);
	offs.push(
		Events.On(AI_ERROR_EVENT, (ev: { data?: unknown }) => {
			if (!belongs(ev.data)) return;
			cleanup();
			cb.onError((ev.data as AiErrorPayload).message || "未知错误");
		}),
	);

	try {
		await AiService.Chat({
			streamId,
			providerId: opts.providerId,
			model: opts.model,
			system: opts.system,
			messages: [{ role: "user", content: opts.user }],
			repoPath: opts.repoPath || "",
			maxRounds: opts.maxRounds || 0,
		});
	} catch (e) {
		// 请求就没发出去（配置缺失等）：清掉订阅并抛给调用方处理。
		cleanup();
		throw e;
	}

	return {
		streamId,
		stop() {
			cleanup();
			void AiService.Cancel(streamId);
		},
	};
}
