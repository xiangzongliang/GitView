package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// AiService 按 OpenAI 兼容规范调用模型的 /chat/completions（流式），
// 并把增量结果通过 Wails 事件推送给前端；同时负责执行工具调用循环。
//
// 为什么放在后端：webview 的 wails:// 源直接请求第三方接口会被 CORS 拦截，
// 且 API Key 不必下发到前端；流式结果通过事件回传，前端只做展示与交互。
type AiService struct {
	repos *RepoService

	mu      sync.Mutex
	cancels map[string]context.CancelFunc
}

// NewAiService 创建 AI 服务。需要 RepoService 以读取 config.json 中的模型配置。
func NewAiService(repos *RepoService) *AiService {
	return &AiService{repos: repos, cancels: map[string]context.CancelFunc{}}
}

// 事件名（前端用 Events.On 订阅）。所有事件负载都带 streamId 以便并发隔离。
const (
	aiChunkEvent     = "ai:chunk"     // 助手正式输出（回答正文）的增量文本
	aiReasoningEvent = "ai:reasoning" // 模型的思考过程（reasoning）增量文本
	aiToolEvent      = "ai:tool"      // 工具调用开始 / 结束
	aiRoundEvent     = "ai:round"     // 一轮「思考 → (工具调用)」结束
	aiDoneEvent      = "ai:done"      // 生成完成（带最终全文）
	aiErrorEvent     = "ai:error"     // 出错 / 已取消
)

const (
	aiDefaultMaxRounds = 6
	// aiStreamTimeout 单次对话的总时长上限（含工具循环）。
	aiStreamTimeout = 5 * time.Minute
)

// ChatMessage 一条对话消息（OpenAI 规范）。
type ChatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// ChatRequest 一次 AI 对话请求。
type ChatRequest struct {
	// StreamID 建议由前端生成：先订阅事件再发起请求，避免漏掉最早的分片。
	// 为空时由后端生成并返回。
	StreamID   string `json:"streamId"`
	ProviderID string `json:"providerId"`
	Model      string `json:"model"`
	// System 系统提示词（决定任务与输出格式）。
	System string `json:"system"`
	// Messages 对话消息（当前场景通常只有一条 user 消息）。
	Messages []ChatMessage `json:"messages"`
	// RepoPath 非空时启用仓库工具（read_file），模型可按需读取文件。
	RepoPath string `json:"repoPath"`
	// MaxRounds 工具调用循环的最大轮数；<=0 使用默认值。
	MaxRounds int `json:"maxRounds"`
}

// 事件负载 ---------------------------------------------------------------

// AiChunkEvent 助手增量文本。
type AiChunkEvent struct {
	StreamID string `json:"streamId"`
	Text     string `json:"text"`
}

// AiReasoningEvent 模型思考过程（reasoning）的增量文本。
// 部分模型（如 DeepSeek R1、面向 OpenRouter 的推理模型）会单独返回该字段。
type AiReasoningEvent struct {
	StreamID string `json:"streamId"`
	Text     string `json:"text"`
}

// AiRoundEvent 一轮结束：前端据此把本轮「思考过程」折叠起来。
type AiRoundEvent struct {
	StreamID string `json:"streamId"`
	Index    int    `json:"index"`
}

// AiToolEvent 工具调用状态：Done=false 表示开始，Done=true 表示已执行完并带上结果。
type AiToolEvent struct {
	StreamID string `json:"streamId"`
	Name     string `json:"name"`
	Args     string `json:"args"`
	Result   string `json:"result,omitempty"`
	Done     bool   `json:"done"`
}

// AiDoneEvent 生成完成，Content 为最终文本。
type AiDoneEvent struct {
	StreamID string `json:"streamId"`
	Content  string `json:"content"`
}

// AiErrorEvent 出错（含用户取消）。
type AiErrorEvent struct {
	StreamID string `json:"streamId"`
	Message  string `json:"message"`
}

// Chat 启动一次流式对话并立即返回（生成在后台 goroutine 中进行），
// 返回本次对话的 streamId（回显请求中传入的值）。
func (s *AiService) Chat(req ChatRequest) (string, error) {
	streamID := strings.TrimSpace(req.StreamID)
	if streamID == "" {
		streamID = fmt.Sprintf("ai_%d", time.Now().UnixNano())
	}

	providers, err := s.repos.ListAiProviders()
	if err != nil {
		return "", err
	}
	var provider *AiProvider
	for i := range providers {
		if providers[i].ID == req.ProviderID {
			provider = &providers[i]
			break
		}
	}
	if provider == nil {
		return "", errors.New("未找到该 AI 配置，请到「设置 · AI 模型」中检查")
	}
	if strings.TrimSpace(provider.BaseURL) == "" || strings.TrimSpace(provider.APIKey) == "" {
		return "", errors.New("该 AI 配置缺少 Base URL 或 API Key")
	}
	if strings.TrimSpace(req.Model) == "" {
		return "", errors.New("未指定模型")
	}

	ctx, cancel := context.WithTimeout(context.Background(), aiStreamTimeout)
	s.mu.Lock()
	// 同一 streamId 重复发起时，先取消上一次，避免事件串流。
	if prev, ok := s.cancels[streamID]; ok {
		prev()
	}
	s.cancels[streamID] = cancel
	s.mu.Unlock()

	cfg := *provider
	go func() {
		defer func() {
			cancel()
			s.mu.Lock()
			delete(s.cancels, streamID)
			s.mu.Unlock()
		}()
		s.run(ctx, streamID, cfg, req)
	}()
	return streamID, nil
}

// Cancel 取消指定对话（前端点「停止」时调用）。取消后会收到 ai:error 事件。
func (s *AiService) Cancel(streamID string) {
	s.mu.Lock()
	cancel := s.cancels[streamID]
	s.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// run 执行对话主循环：流式请求 → 若有工具调用则执行并回灌 → 直到产出最终文本。
func (s *AiService) run(ctx context.Context, streamID string, provider AiProvider, req ChatRequest) {
	messages := make([]oaMessage, 0, len(req.Messages)+2)
	if strings.TrimSpace(req.System) != "" {
		messages = append(messages, oaMessage{Role: "system", Content: req.System})
	}
	for _, m := range req.Messages {
		messages = append(messages, oaMessage{Role: m.Role, Content: m.Content})
	}

	maxRounds := req.MaxRounds
	if maxRounds <= 0 {
		maxRounds = aiDefaultMaxRounds
	}
	baseTools := RepoTools(req.RepoPath)

	var (
		final   string
		emitted bool
		lastErr error
	)
	// 先带工具跑一遍；若模型不支持工具调用（例如直接返回 400），
	// 且尚未向前端推送过任何文本，则去掉工具重试一次，
	// 避免因为「包了 tools 参数」导致整段对话不可用。
	for attempt := 0; attempt < 2; attempt++ {
		tools := baseTools
		if attempt == 1 {
			if lastErr == nil || emitted || len(baseTools) == 0 {
				break
			}
			tools = nil
		}
		final, emitted, lastErr = s.converse(ctx, streamID, provider, req.Model, messages, tools, maxRounds)
		if lastErr == nil {
			break
		}
	}

	if lastErr != nil {
		if ctx.Err() != nil {
			s.emit(aiErrorEvent, AiErrorEvent{StreamID: streamID, Message: "已取消"})
			return
		}
		s.emit(aiErrorEvent, AiErrorEvent{StreamID: streamID, Message: lastErr.Error()})
		return
	}
	s.emit(aiDoneEvent, AiDoneEvent{StreamID: streamID, Content: final})
}

// converse 跑完一个完整的工具调用循环，返回最终文本。
// emitted 表示是否已向前端推送过增量文本（决定能否安全地重试）。
func (s *AiService) converse(
	ctx context.Context,
	streamID string,
	provider AiProvider,
	model string,
	base []oaMessage,
	tools []AiTool,
	maxRounds int,
) (final string, emitted bool, err error) {
	// 拷贝一份再改，重试时不会被上一轮的助手/工具消息污染。
	messages := make([]oaMessage, len(base))
	copy(messages, base)

	for round := 0; round < maxRounds; round++ {
		content, calls, chunked, streamErr := s.streamOnce(ctx, streamID, provider, model, messages, tools)
		if chunked {
			emitted = true
		}
		if streamErr != nil {
			return "", emitted, streamErr
		}
		// 本轮思考（+ 可能的正文）已结束：通知前端折叠本轮的「思考过程」。
		s.emit(aiRoundEvent, AiRoundEvent{StreamID: streamID, Index: round})
		if len(calls) == 0 {
			final = content
			break
		}
		// 这一轮是工具调用：记录助手回复，逐个执行工具并把结果回灌。
		// 中间轮次的文字通常只是模型的旁白，仅在没有最终文本时兜底采用。
		if strings.TrimSpace(content) != "" {
			final = content
		}
		messages = append(messages, oaMessage{Role: "assistant", Content: content, ToolCalls: calls})
		for _, c := range calls {
			name := c.Function.Name
			args := c.Function.Arguments
			s.emit(aiToolEvent, AiToolEvent{StreamID: streamID, Name: name, Args: args})

			result := ""
			if tool, ok := toolByName(tools, name); ok {
				out, runErr := tool.Run(json.RawMessage(args))
				if runErr != nil {
					result = "错误：" + runErr.Error()
				} else {
					result = out
				}
			} else {
				result = "错误：未知工具 " + name
			}
			s.emit(aiToolEvent, AiToolEvent{StreamID: streamID, Name: name, Args: args, Result: result, Done: true})
			messages = append(messages, oaMessage{Role: "tool", ToolCallID: c.ID, Content: result})
		}
	}
	return final, emitted, nil
}

// streamOnce 发起一轮流式请求，边收边把增量文本推给前端，
// 返回本轮完整文本、拼接好的工具调用列表，以及是否推送过文本。
func (s *AiService) streamOnce(
	ctx context.Context,
	streamID string,
	provider AiProvider,
	model string,
	messages []oaMessage,
	tools []AiTool,
) (string, []oaToolCall, bool, error) {
	body := oaRequestBody{Model: model, Messages: messages, Stream: true}
	if len(tools) > 0 {
		body.Tools = toolSchemas(tools)
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return "", nil, false, err
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, chatCompletionsURL(provider.BaseURL), bytes.NewReader(payload))
	if err != nil {
		return "", nil, false, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "text/event-stream")
	httpReq.Header.Set("Authorization", "Bearer "+strings.TrimSpace(provider.APIKey))

	resp, err := aiHTTPClient.Do(httpReq)
	if err != nil {
		return "", nil, false, fmt.Errorf("请求模型失败: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return "", nil, false, fmt.Errorf("模型返回 %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}

	var content strings.Builder
	var calls []oaToolCall
	emitted := false
	scanner := bufio.NewScanner(resp.Body)
	// 单行可能很长（例如一次性返回的大段内容），放宽缓冲区上限。
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || !strings.HasPrefix(line, "data:") {
			continue // 空行、注释与其它 SSE 字段一律跳过
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "[DONE]" {
			break
		}
		var chunk oaStreamChunk
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			continue // 无法解析的行（心跳等）直接忽略
		}
		for _, ch := range chunk.Choices {
			// 思考过程：不同实现字段名不一致，两个常见字段都兼容一下。
			reasoning := ch.Delta.ReasoningContent
			if reasoning == "" {
				reasoning = ch.Delta.Reasoning
			}
			if reasoning != "" {
				emitted = true
				s.emit(aiReasoningEvent, AiReasoningEvent{StreamID: streamID, Text: reasoning})
			}
			if ch.Delta.Content != "" {
				content.WriteString(ch.Delta.Content)
				emitted = true
				s.emit(aiChunkEvent, AiChunkEvent{StreamID: streamID, Text: ch.Delta.Content})
			}
			for _, tc := range ch.Delta.ToolCalls {
				for len(calls) <= tc.Index {
					calls = append(calls, oaToolCall{})
				}
				cur := &calls[tc.Index]
				if tc.ID != "" {
					cur.ID = tc.ID
				}
				if tc.Type != "" {
					cur.Type = tc.Type
				}
				if tc.Function.Name != "" {
					cur.Function.Name = tc.Function.Name
				}
				// 参数是按分片流式给出的，需要按序拼接。
				cur.Function.Arguments += tc.Function.Arguments
			}
		}
	}
	if err := scanner.Err(); err != nil {
		if ctx.Err() != nil {
			return "", nil, emitted, ctx.Err()
		}
		return "", nil, emitted, fmt.Errorf("读取模型响应失败: %w", err)
	}

	// 丢弃没有名字的残片（部分实现会给出空占位）。
	named := make([]oaToolCall, 0, len(calls))
	for _, c := range calls {
		if c.Function.Name != "" {
			named = append(named, c)
		}
	}
	return content.String(), named, emitted, nil
}

// emit 向前端推送事件。应用未就绪时静默忽略。
func (s *AiService) emit(name string, payload any) {
	if app := application.Get(); app != nil && app.Event != nil {
		app.Event.Emit(name, payload)
	}
}

// chatCompletionsURL 拼出 /chat/completions 地址，
// 兼容 base 已带路径（如 https://host/v1）或已写全接口的情况。
func chatCompletionsURL(base string) string {
	b := strings.TrimRight(strings.TrimSpace(base), "/")
	if strings.HasSuffix(b, "/chat/completions") {
		return b
	}
	return b + "/chat/completions"
}

// aiHTTPClient 供流式请求使用：不做整体超时（由 context 控制），
// 但设置连接 / TLS 握手超时，避免网络异常时长时间挂起。
var aiHTTPClient = &http.Client{
	Transport: &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          10,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   15 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
	},
}

// ---------------------------------------------------------------- 协议结构体

// oaMessage 是 OpenAI 规范中的一条消息（含工具调用相关字段）。
type oaMessage struct {
	Role       string       `json:"role"`
	Content    string       `json:"content"`
	ToolCalls  []oaToolCall `json:"tool_calls,omitempty"`
	ToolCallID string       `json:"tool_call_id,omitempty"`
}

// oaToolCall 是助手消息里请求调用的工具。
type oaToolCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

type oaRequestBody struct {
	Model    string         `json:"model"`
	Messages []oaMessage    `json:"messages"`
	Stream   bool           `json:"stream"`
	Tools    []aiToolSchema `json:"tools,omitempty"`
}

// oaStreamChunk 是流式响应中的一条 data 分片。
type oaStreamChunk struct {
	Choices []struct {
		Delta struct {
			Content string `json:"content"`
			// ReasoningContent 是 DeepSeek 等实现返回思考过程的字段。
			ReasoningContent string `json:"reasoning_content"`
			// Reasoning 是 OpenRouter 等实现使用的字段名。
			Reasoning string `json:"reasoning"`
			ToolCalls []struct {
				Index    int    `json:"index"`
				ID       string `json:"id"`
				Type     string `json:"type"`
				Function struct {
					Name      string `json:"name"`
					Arguments string `json:"arguments"`
				} `json:"function"`
			} `json:"tool_calls"`
		} `json:"delta"`
	} `json:"choices"`
}
