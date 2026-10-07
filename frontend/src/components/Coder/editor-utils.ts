/**
 * 代码编辑器的纯函数工具：括号配对、注释风格、行级操作、文本查找。
 *
 * 全部为无副作用函数，便于测试与编辑器主组件复用。
 */

/** 括号配对：开符号 → 闭符号 */
export const PAIRS: Record<string, string> = {
	"(": ")",
	"[": "]",
	"{": "}",
};

/** 闭符号集合（光标后已是同符号时输入则跳过而非重复插入） */
export const CLOSERS = new Set([")", "]", "}"]);

/** 参与自动闭合的引号 */
export const QUOTES = ['"', "'", "`"];

/**
 * 光标后字符是否允许自动闭合。
 * 后面紧邻单词字符（标识符）时不闭合，避免把 `foo(` 与 `foo()…` 中的标识符拆散。
 */
export function canAutoClose(nextChar: string | undefined): boolean {
	return nextChar === undefined || !/[\w$]/.test(nextChar);
}

export interface CommentStyle {
	/** 行注释前缀（`//`、`#`、`--` 等） */
	line?: string;
	/** 块注释 [开始, 结束] */
	block?: [string, string];
}

/** 按语言返回注释风格；无注释语法（json / diff / plaintext 等）返回 null */
export function commentStyleFor(
	lang: string | null | undefined,
): CommentStyle | null {
	switch (lang) {
		case "javascript":
		case "typescript":
		case "java":
		case "c":
		case "cpp":
		case "csharp":
		case "go":
		case "rust":
		case "php":
			return { line: "//", block: ["/*", "*/"] };
		case "python":
		case "bash":
		case "shell":
		case "ruby":
		case "yaml":
		case "dockerfile":
		case "ini":
			return { line: "#" };
		case "sql":
			return { line: "--", block: ["/*", "*/"] };
		case "scss":
			return { line: "//", block: ["/*", "*/"] };
		case "css":
			return { block: ["/*", "*/"] };
		case "xml":
		case "markdown":
			return { block: ["<!--", "-->"] };
		default:
			return null;
	}
}

/** 行起点（该行首个字符的下标） */
export function lineStartIndex(text: string, index: number): number {
	if (index <= 0) return 0;
	const nl = text.lastIndexOf("\n", index - 1);
	return nl + 1;
}

/** 行内容终点（换行符下标；最后一行为 text.length） */
export function lineEndIndex(text: string, index: number): number {
	const nl = text.indexOf("\n", index);
	return nl === -1 ? text.length : nl;
}

/** 覆盖 [from, to] 两端所在行的完整区间 [行首, 末行换行符之后) */
export function fullLineRange(
	text: string,
	from: number,
	to: number = from,
): [number, number] {
	const start = lineStartIndex(text, from);
	const end = lineEndIndex(text, Math.max(from, to));
	return [start, end === text.length ? text.length : end + 1];
}

export interface LineInfo {
	start: number;
	end: number;
	text: string;
}

/** 光标所在行的信息 */
export function getLineOf(text: string, index: number): LineInfo {
	const start = lineStartIndex(text, index);
	const end = lineEndIndex(text, index);
	return { start, end, text: text.slice(start, end) };
}

/** 行首缩进空白 */
export function leadingWhitespace(line: string): string {
	const m = /^[ \t]*/.exec(line);
	return m ? m[0] : "";
}

/** 行首空白在 tab-size = 4 下的视觉列数（Tab 计为 4 列宽） */
export function indentColumns(ws: string): number {
	let col = 0;
	for (const ch of ws) col += ch === "\t" ? 4 - (col % 4) : 1;
	return col;
}

/**
 * 将全文缩进从每级 from 空格重排为每级 to 空格。
 *
 * 仅规范化行首空白：按原缩进列数折算层级（四舍五入）后重建行首空白，
 * 行内容保持不变；原有 Tab 按 4 列宽折算。
 * 注意：对 Python / YAML 等缩进即语法的语言，重排会改变语义，
 * 调用方需自行确认。
 */
export function reindentText(text: string, from: number, to: number): string {
	if (from <= 0 || to <= 0 || from === to) return text;
	return text
		.split("\n")
		.map((line) => {
			const ws = leadingWhitespace(line);
			if (!ws) return line;
			const level = Math.max(0, Math.round(indentColumns(ws) / from));
			return " ".repeat(level * to) + line.slice(ws.length);
		})
		.join("\n");
}

export interface LinesEditResult {
	/** 替换后的文本（用于整体替换 [start, end)） */
	text: string;
	/** 操作后建议的选区 */
	selStart: number;
	selEnd: number;
}

/** 为 [start, end) 覆盖的每一行增加一级缩进（空行跳过，避免引入尾随空白） */
export function indentLines(
	text: string,
	start: number,
	end: number,
	unit: string,
): LinesEditResult {
	const block = text.slice(start, end);
	const trailingEmpty = block.endsWith("\n");
	const lines = block.split("\n");
	const body = trailingEmpty ? lines.slice(0, -1) : lines;
	const tail = trailingEmpty ? "\n" : "";
	let firstAdded = 0;
	const out = body.map((line, i) => {
		if (line.trim() === "") return line;
		if (i === 0) firstAdded = unit.length;
		return unit + line;
	});
	const replaced = out.join("\n") + tail;
	return {
		text: replaced,
		selStart: start + firstAdded,
		selEnd: replaced.endsWith("\n")
			? start + replaced.length - 1
			: start + replaced.length,
	};
}

/** 为 [start, end) 覆盖的每一行移除一级缩进（不足一个单位时移除全部行首空白） */
export function dedentLines(
	text: string,
	start: number,
	end: number,
	indentSize: number,
): LinesEditResult {
	const block = text.slice(start, end);
	const trailingEmpty = block.endsWith("\n");
	const lines = block.split("\n");
	const body = trailingEmpty ? lines.slice(0, -1) : lines;
	const tail = trailingEmpty ? "\n" : "";
	let firstRemoved = 0;
	const out = body.map((line, i) => {
		const m = /^[ \t]+/.exec(line);
		if (!m) return line;
		const cut = m[0].length >= indentSize ? indentSize : m[0].length;
		if (i === 0) firstRemoved = cut;
		return line.slice(cut);
	});
	const replaced = out.join("\n") + tail;
	return {
		text: replaced,
		selStart: start + firstRemoved,
		selEnd: replaced.endsWith("\n")
			? start + replaced.length - 1
			: start + replaced.length,
	};
}

export interface TextMatch {
	start: number;
	end: number;
}

// ---------- 字号度量 ----------

/** 编辑器默认字号（px）：与应用标准字号（body font-size: 13px）一致 */
export const CODER_DEFAULT_FONT_SIZE = 13;
/** 可调字号下限（px）：与状态栏字号菜单的最小档位一致 */
export const CODER_MIN_FONT_SIZE = 9;
/** 可调字号上限（px）：与状态栏字号菜单的最大档位一致 */
export const CODER_MAX_FONT_SIZE = 18;
/** 状态栏字号菜单档位（px） */
export const CODER_FONT_OPTIONS = [9, 10, 11, 12, 13, 14, 16, 18];

/** 把字号吸附到最近的菜单档位（持久化的历史值可能不在当前档位表中） */
export function snapFontOption(size: number): number {
	let best = CODER_FONT_OPTIONS[0]!;
	for (const o of CODER_FONT_OPTIONS) {
		if (Math.abs(o - size) < Math.abs(best - size)) best = o;
	}
	return best;
}

/** 把字号约束到可调区间（非法值回退为默认字号） */
export function clampFontSize(size: number | undefined | null): number {
	const n = Math.round(Number(size));
	if (!Number.isFinite(n) || n <= 0) return CODER_DEFAULT_FONT_SIZE;
	return Math.min(CODER_MAX_FONT_SIZE, Math.max(CODER_MIN_FONT_SIZE, n));
}

/** 字号 → 行高（px）：1.5 倍字号（13px → 20px，与历史固定排版一致）。
 *  JS 度量与 CSS 变量 --ed-line-height 必须使用同一来源，避免错位。 */
export function coderLineHeight(fontSize: number | undefined | null): number {
	return Math.round(clampFontSize(fontSize) * 1.5);
}

// ---------- 视觉列宽（宽字符按 2 列计） ----------

/**
 * 码点是否为「全角/宽字符」：在等宽字体中占 2 个半角列宽。
 * 覆盖 CJK 统一表意文字及扩展、假名、谚文、全角标点/拉丁、
 * CJK 兼容区等主要双宽区段（East Asian Wide/Fullwidth 的常用子集）。
 */
export function isWideCodePoint(cp: number): boolean {
	return (
		(cp >= 0x1100 && cp <= 0x115f) || // 谚文字母 Jamo 初声
		(cp >= 0x2e80 && cp <= 0x303e) || // CJK 部首、符号标点（U+303F 半宽除外）
		(cp >= 0x3041 && cp <= 0x33ff) || // 假名、注音、CJK 兼容符号等
		(cp >= 0x3400 && cp <= 0x4dbf) || // CJK 扩展 A
		(cp >= 0x4e00 && cp <= 0x9fff) || // CJK 统一表意文字
		(cp >= 0xa000 && cp <= 0xa4cf) || // 彝文
		(cp >= 0xa960 && cp <= 0xa97f) || // 谚文字母 Jamo 扩展 A
		(cp >= 0xac00 && cp <= 0xd7a3) || // 谚文音节
		(cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容表意文字
		(cp >= 0xfe10 && cp <= 0xfe19) || // 竖排形式
		(cp >= 0xfe30 && cp <= 0xfe6f) || // CJK 兼容形式、小写变体
		(cp >= 0xff00 && cp <= 0xff60) || // 全角形式（ASCII/标点）
		(cp >= 0xffe0 && cp <= 0xffe6) || // 全角货币符号等
		(cp >= 0x16fe0 && cp <= 0x16fe4) || // 表意文字描述符等
		(cp >= 0x17000 && cp <= 0x18cd5) || // 西夏文、女书
		(cp >= 0x1b000 && cp <= 0x1b2fb) || // 假名变体、努鲁文
		(cp >= 0x20000 && cp <= 0x3fffd) // CJK 扩展 B 及以后、兼容补充
	);
}

/**
 * 单个字符（或码点）在等宽排版下占的视觉列数：宽字符 2 列，其余 1 列。
 * 传入代理对的一半（孤立代理）时按 1 列计——一对恰好合计 2 列，
 * 与扩展 B 区宽字符的实际宽度一致，因此按 UTF-16 单元逐位累加也正确。
 */
export function charCols(ch: string): number {
	const cp = ch.codePointAt(0);
	return cp !== undefined && isWideCodePoint(cp) ? 2 : 1;
}

/** 查找全部匹配（大小写可选） */
export function findMatches(
	text: string,
	query: string,
	caseSensitive: boolean,
): TextMatch[] {
	if (!query) return [];
	const haystack = caseSensitive ? text : text.toLowerCase();
	const needle = caseSensitive ? query : query.toLowerCase();
	const matches: TextMatch[] = [];
	let pos = haystack.indexOf(needle);
	while (pos !== -1) {
		matches.push({ start: pos, end: pos + needle.length });
		pos = haystack.indexOf(needle, pos + needle.length);
	}
	return matches;
}

// ---------- 缩进宽度探测 ----------

function gcd(a: number, b: number): number {
	while (b !== 0) {
		const t = a % b;
		a = b;
		b = t;
	}
	return a;
}

/**
 * 探测全文实际使用的缩进宽度：取各行行首空白视觉列数的最大公约数，
 * 再归一到常见单位（2 或 4）。
 *
 * 用于缩进单位切换：不能信任外部「设置值」，因为内容可能是粘贴/默认
 * 导入的 4 空格，而设置仍是 2，直接按设置值换算会导致缩进翻倍。
 */
export function detectIndentWidth(text: string): number {
	const cols: number[] = [];
	for (const line of text.split("\n")) {
		const ws = leadingWhitespace(line);
		if (!ws || line.trim() === "") continue;
		const c = indentColumns(ws);
		if (c > 0) cols.push(c);
	}
	let g = 0;
	for (const c of cols) g = g === 0 ? c : gcd(g, c);
	if (g >= 4 && g % 4 === 0) return 4;
	if (g >= 2 && g % 2 === 0) return 2;
	return 0;
}

// ---------- 代码折叠 ----------

export interface FoldRange {
	/** 折叠块首行（0-based，含块首行） */
	startLine: number;
	/** 折叠块末行（0-based，含块末行） */
	endLine: number;
}

/**
 * 计算可折叠区间：单遍扫描，跳过 `//` 行注释、块注释与
 * 单 / 双 / 反引号字符串，用栈匹配花括号、方括号、圆括号；
 * 仅当闭合行大于开启行时记录（同行的括号不折叠）。
 */
export function computeFoldRanges(text: string): FoldRange[] {
	const ranges: FoldRange[] = [];
	const stack: { char: string; line: number }[] = [];
	let line = 0;
	let inLineComment = false;
	let inBlockComment = false;
	let inString: "'" | '"' | "`" | null = null;

	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		const next = text[i + 1];

		if (ch === "\n") {
			line += 1;
			inLineComment = false;
			continue;
		}
		if (inLineComment) continue;
		if (inBlockComment) {
			if (ch === "*" && next === "/") {
				inBlockComment = false;
				i += 1;
			}
			continue;
		}
		if (inString) {
			if (ch === "\\") {
				i += 1;
				continue;
			}
			if (ch === inString) inString = null;
			continue;
		}

		if (ch === "/" && next === "/") {
			inLineComment = true;
			i += 1;
			continue;
		}
		if (ch === "/" && next === "*") {
			inBlockComment = true;
			i += 1;
			continue;
		}
		if (ch === "'" || ch === '"' || ch === "`") {
			inString = ch;
			continue;
		}

		if (ch === "(" || ch === "[" || ch === "{") {
			stack.push({ char: ch, line });
			continue;
		}
		if (ch === ")" || ch === "]" || ch === "}") {
			const top = stack[stack.length - 1];
			// top.char 是开括号，PAIRS[开] → 对应闭括号，需与当前闭括号一致
			if (top && PAIRS[top.char] === ch) {
				stack.pop();
				// 需至少一行内容（open 与 close 中间有空行），否则折叠无意义
				if (line > top.line + 1)
					ranges.push({ startLine: top.line, endLine: line });
			}
		}
	}

	// 同一首行去重，保留最远的末行
	const best = new Map<number, number>();
	for (const r of ranges) {
		const prev = best.get(r.startLine);
		if (prev === undefined || r.endLine > prev)
			best.set(r.startLine, r.endLine);
	}
	return [...best.entries()]
		.map(([startLine, endLine]) => ({ startLine, endLine }))
		.sort((a, b) => a.startLine - b.startLine);
}

/** 折叠视图模型：把全文折叠为展示文本，并保留映射所需信息 */
export interface CodeView {
	/** 折叠后的展示文本（textarea 的值） */
	displayText: string;
	/** 展示行对应的源行号（0-based） */
	visibleLines: number[];
	/** 被隐藏的源字符区间（有序、互不相交，[start, end)） */
	hiddenRanges: [number, number][];
	/** 全文可折叠区间 */
	foldRanges: FoldRange[];
}

/**
 * 由全文 + 折叠首行集合构建展示视图。
 * foldedStarts 中的行若没有对应折叠区间会被忽略；隐藏区间按相邻隐藏行
 * 合并为最小数量的不相交字符区间，供偏移映射使用。
 */
export function buildCodeView(
	source: string,
	foldedStarts: Iterable<number>,
): CodeView {
	const sourceLines = source.split("\n");
	const totalLines = sourceLines.length;
	const foldRanges = computeFoldRanges(source);

	const foldByStart = new Map<number, FoldRange>();
	for (const r of foldRanges) foldByStart.set(r.startLine, r);

	// 隐藏行 = 每个被折叠区间的内部行：startLine+1 .. endLine-1
	// （首行与末行的括号保留，只隐藏中间内容）
	const hidden = new Set<number>();
	for (const start of foldedStarts) {
		const range = foldByStart.get(start);
		if (!range) continue;
		for (let l = range.startLine + 1; l <= range.endLine - 1; l++)
			hidden.add(l);
	}

	const visibleLines: number[] = [];
	for (let l = 0; l < totalLines; l++) {
		if (!hidden.has(l)) visibleLines.push(l);
	}
	const displayText = visibleLines.map((l) => sourceLines[l]).join("\n");

	// 每行行首的源偏移，用于把隐藏行换算为字符区间
	const lineStarts: number[] = new Array(totalLines);
	let offset = 0;
	for (let l = 0; l < totalLines; l++) {
		lineStarts[l] = offset;
		offset += sourceLines[l].length + 1; // +1 换行符
	}

	const hiddenRanges: [number, number][] = [];
	const sortedHidden = [...hidden].sort((a, b) => a - b);
	let runStart = -1;
	let runEnd = -1;
	const flush = () => {
		if (runStart === -1) return;
		hiddenRanges.push([
			lineStarts[runStart],
			Math.min(
				source.length,
				lineStarts[runEnd] + sourceLines[runEnd].length + 1,
			),
		]);
	};
	for (const l of sortedHidden) {
		if (runStart === -1) {
			runStart = l;
			runEnd = l;
		} else if (l === runEnd + 1) {
			runEnd = l;
		} else {
			flush();
			runStart = l;
			runEnd = l;
		}
	}
	flush();

	return { displayText, visibleLines, hiddenRanges, foldRanges };
}

/** 展示偏移 → 源偏移（把折叠后的坐标还原到全文坐标） */
export function mapDisplayOffsetToSource(
	displayOffset: number,
	source: string,
	hiddenRanges: [number, number][],
): number {
	let src = 0;
	let d = displayOffset;
	for (const [s, e] of hiddenRanges) {
		const normal = s - src;
		if (d <= normal) return src + d;
		d -= normal;
		src = e;
	}
	return src + d;
}

/** 源偏移 → 展示偏移（折叠区内部点映射到区间左边界） */
export function mapSourceOffsetToDisplay(
	sourceOffset: number,
	source: string,
	hiddenRanges: [number, number][],
): number {
	let src = 0;
	let disp = 0;
	for (const [s, e] of hiddenRanges) {
		if (sourceOffset <= s) return disp + (sourceOffset - src);
		if (sourceOffset < e) return disp + (s - src);
		disp += s - src;
		src = e;
	}
	return disp + (sourceOffset - src);
}
