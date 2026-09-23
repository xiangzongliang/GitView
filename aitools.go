package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// AI 工具模块：模型在对话中可以调用的函数（工具定义 + 执行）。
// 抽成独立文件是为了复用——后续的其它 AI 对话（代码问答等）可以按需组装工具集，
// 而不必改动对话/流式逻辑本身。

// AiTool 是一个可被模型调用的工具。
type AiTool struct {
	// Name 工具名，需与 OpenAI tools[].function.name 一致。
	Name string
	// Description 告诉模型这个工具做什么、何时用。
	Description string
	// Parameters 是 JSON Schema，对应 tools[].function.parameters。
	Parameters map[string]any
	// Run 执行工具：入参为模型给出的 JSON 参数，返回回灌给模型的文本。
	Run func(args json.RawMessage) (string, error)
}

// aiToolSchema 是工具在 OpenAI 请求体中的序列化形式。
type aiToolSchema struct {
	Type     string `json:"type"`
	Function struct {
		Name        string         `json:"name"`
		Description string         `json:"description"`
		Parameters  map[string]any `json:"parameters"`
	} `json:"function"`
}

// toolSchemas 把工具集转换为请求体里的 tools 数组。
func toolSchemas(tools []AiTool) []aiToolSchema {
	out := make([]aiToolSchema, 0, len(tools))
	for _, t := range tools {
		var s aiToolSchema
		s.Type = "function"
		s.Function.Name = t.Name
		s.Function.Description = t.Description
		s.Function.Parameters = t.Parameters
		out = append(out, s)
	}
	return out
}

// toolByName 按名字查找工具。
func toolByName(tools []AiTool, name string) (AiTool, bool) {
	for _, t := range tools {
		if t.Name == name {
			return t, true
		}
	}
	return AiTool{}, false
}

// RepoTools 返回针对某个仓库可用的工具集；repoPath 为空时返回空集。
// 新增仓库相关工具时在此登记即可，所有对话场景共享。
func RepoTools(repoPath string) []AiTool {
	if strings.TrimSpace(repoPath) == "" {
		return nil
	}
	return []AiTool{newReadFileTool(repoPath)}
}

// ---------------------------------------------------------------- read_file

// readFileArgs 是 read_file 工具的参数。
type readFileArgs struct {
	Path      string `json:"path"`
	StartLine int    `json:"startLine"`
	EndLine   int    `json:"endLine"`
}

const (
	// readFileMaxBytes 单次读取的字节上限，避免把超大文件整个塞进上下文。
	readFileMaxBytes = 256 << 10
	// readFileMaxLines 单次读取的行数上限。
	readFileMaxLines = 4000
)

// newReadFileTool 构造「读取仓库文件」工具：可读整文件或指定行区间。
func newReadFileTool(repoPath string) AiTool {
	return AiTool{
		Name: "read_file",
		Description: "读取当前仓库中某个文件的内容。path 为相对仓库根目录的路径；" +
			"可选 startLine/endLine（行号从 1 开始，含两端）只读取指定区间，" +
			"不传则读取整个文件（受行数 / 大小上限限制）。",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"path": map[string]any{
					"type":        "string",
					"description": "相对仓库根目录的文件路径，例如 src/main.go",
				},
				"startLine": map[string]any{
					"type":        "integer",
					"description": "起始行号（从 1 开始，含）",
				},
				"endLine": map[string]any{
					"type":        "integer",
					"description": "结束行号（含）",
				},
			},
			"required": []string{"path"},
		},
		Run: func(raw json.RawMessage) (string, error) {
			var a readFileArgs
			if len(raw) > 0 {
				if err := json.Unmarshal(raw, &a); err != nil {
					return "", fmt.Errorf("参数解析失败: %v", err)
				}
			}
			return ReadRepoFile(repoPath, a.Path, a.StartLine, a.EndLine)
		},
	}
}

// ReadRepoFile 读取仓库内文件并按行返回（带行号，便于模型继续按区间读取）。
// startLine / endLine 为 0 表示不限制；越界会自动收敛。返回内容受
// readFileMaxLines / readFileMaxBytes 限制。绝对路径与路径穿越会被拒绝。
func ReadRepoFile(repoPath, relPath string, startLine, endLine int) (string, error) {
	rel := strings.TrimSpace(relPath)
	if rel == "" {
		return "", fmt.Errorf("path 不能为空")
	}
	if filepath.IsAbs(rel) {
		return "", fmt.Errorf("path 必须是相对仓库根目录的路径")
	}
	root, err := filepath.Abs(repoPath)
	if err != nil {
		return "", err
	}
	full, err := filepath.Abs(filepath.Join(root, filepath.FromSlash(rel)))
	if err != nil {
		return "", err
	}
	// 防路径穿越：解析后的绝对路径必须仍在仓库根目录内。
	if full != root && !strings.HasPrefix(full, root+string(os.PathSeparator)) {
		return "", fmt.Errorf("path 超出仓库范围: %s", relPath)
	}
	info, err := os.Stat(full)
	if err != nil {
		return "", fmt.Errorf("无法读取文件: %v", err)
	}
	if info.IsDir() {
		return "", fmt.Errorf("%s 是目录，不是文件", relPath)
	}
	data, err := os.ReadFile(full)
	if err != nil {
		return "", fmt.Errorf("读取失败: %v", err)
	}
	if isBinaryData(data) {
		return fmt.Sprintf("（%s 是二进制文件，%d 字节，未显示内容）", relPath, info.Size()), nil
	}

	lines := strings.Split(string(data), "\n")
	// 末尾换行会多切出一个空行，去掉以免行号错乱。
	if n := len(lines); n > 0 && lines[n-1] == "" {
		lines = lines[:n-1]
	}
	total := len(lines)
	if total == 0 {
		return fmt.Sprintf("文件 %s 为空", relPath), nil
	}

	from, to := 1, total
	if startLine > 0 {
		from = startLine
	}
	if endLine >= from {
		to = endLine
	}
	if from > total {
		return fmt.Sprintf("起始行 %d 超出文件范围（共 %d 行）", from, total), nil
	}
	if to > total {
		to = total
	}
	if to-from+1 > readFileMaxLines {
		to = from + readFileMaxLines - 1
	}

	var b strings.Builder
	if from == 1 && to == total {
		fmt.Fprintf(&b, "文件 %s（共 %d 行）：\n", relPath, total)
	} else {
		fmt.Fprintf(&b, "文件 %s（共 %d 行，以下为第 %d-%d 行）：\n", relPath, total, from, to)
	}
	for i := from; i <= to; i++ {
		fmt.Fprintf(&b, "%d\t%s\n", i, lines[i-1])
		if b.Len() > readFileMaxBytes {
			b.WriteString("…（内容过长已截断）\n")
			break
		}
	}
	return b.String(), nil
}
