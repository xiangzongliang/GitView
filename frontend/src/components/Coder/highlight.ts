/**
 * highlight.js 按需注册与语言推断。
 *
 * 从 core 入口仅注册常用语言以控制打包体积；未知/未注册语言
 * 一律回退为纯文本转义渲染。Vue SFC 语法为项目内自建（见 vue-grammar.ts）。
 */
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import plaintext from "highlight.js/lib/languages/plaintext";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import vue from "./vue-grammar";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

const LANGUAGES = {
    bash,
    c,
    cpp,
    csharp,
    css,
    diff,
    dockerfile,
    go,
    ini,
    java,
    javascript,
    json,
    markdown,
    php,
    plaintext,
    python,
    ruby,
    rust,
    scss,
    shell,
    sql,
    typescript,
    vue,
    xml,
    yaml,
};

export type LanguageId = keyof typeof LANGUAGES;

for (const [id, define] of Object.entries(LANGUAGES)) {
    hljs.registerLanguage(id, define);
}

/** 语言在状态栏中的展示名 */
export const LANGUAGE_LABELS: Record<LanguageId, string> = {
    bash: "Shell",
    c: "C",
    cpp: "C++",
    csharp: "C#",
    css: "CSS",
    diff: "Diff",
    dockerfile: "Dockerfile",
    go: "Go",
    ini: "INI",
    java: "Java",
    javascript: "JavaScript",
    json: "JSON",
    markdown: "Markdown",
    php: "PHP",
    plaintext: "纯文本",
    python: "Python",
    ruby: "Ruby",
    rust: "Rust",
    scss: "SCSS",
    shell: "Shell",
    sql: "SQL",
    typescript: "TypeScript",
    vue: "Vue (SFC)",
    xml: "XML / HTML",
    yaml: "YAML",
};

const EXTENSION_MAP: Record<string, LanguageId> = {
    js: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    jsx: "javascript",
    ts: "typescript",
    tsx: "typescript",
    mts: "typescript",
    cts: "typescript",
    json: "json",
    jsonc: "json",
    json5: "json",
    html: "xml",
    htm: "xml",
    xml: "xml",
    svg: "xml",
    vue: "vue",
    css: "css",
    scss: "scss",
    py: "python",
    pyw: "python",
    rb: "ruby",
    rs: "rust",
    go: "go",
    java: "java",
    c: "c",
    h: "c",
    cc: "cpp",
    cpp: "cpp",
    cxx: "cpp",
    hpp: "cpp",
    hh: "cpp",
    cs: "csharp",
    php: "php",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    sql: "sql",
    yml: "yaml",
    yaml: "yaml",
    md: "markdown",
    markdown: "markdown",
    ini: "ini",
    cfg: "ini",
    conf: "ini",
    env: "ini",
    properties: "ini",
    toml: "ini",
    diff: "diff",
    patch: "diff",
    txt: "plaintext",
    log: "plaintext",
};

/** 按文件名 / 扩展名推断语言 */
export function languageFromFilename(filename: string): LanguageId | null {
    const base = (filename.split(/[\\/]/).pop() ?? "").toLowerCase();
    if (!base) return null;
    if (base === "dockerfile" || base.endsWith(".dockerfile"))
        return "dockerfile";
    if (base === "makefile" || base === "gnumakefile") return "bash";
    const dot = base.lastIndexOf(".");
    const ext = dot === -1 ? base : base.slice(dot + 1);
    return EXTENSION_MAP[ext] ?? null;
}

/** 判断语言 id 是否已注册 */
export function isRegisteredLanguage(lang: string): lang is LanguageId {
    return Object.prototype.hasOwnProperty.call(LANGUAGES, lang);
}

/** 自动检测语言（采样前 5000 字符；空内容返回 null） */
export function detectLanguage(code: string): LanguageId | null {
    const sample = code.slice(0, 5000);
    if (!sample.trim()) return null;
    try {
        const result = hljs.highlightAuto(sample, Object.keys(LANGUAGES));
        return (result.language as LanguageId | undefined) ?? null;
    } catch {
        return null;
    }
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

/** 高亮为 HTML 片段；语言未注册或解析失败时回退为纯转义 */
export function highlightCode(code: string, lang: LanguageId | null): string {
    if (lang && isRegisteredLanguage(lang)) {
        try {
            return hljs.highlight(code, {
                language: lang,
                ignoreIllegals: true,
            }).value;
        } catch {
            /* 解析失败时回退为纯转义 */
        }
    }
    return escapeHtml(code);
}

/** Vue SFC 块级开始标签（带词边界断言；分组 2 为同行已出现的属性） */
const VUE_BLOCK_OPEN_RE = /<(script|style)(?=[\s>/]|$)([^>]*)/i;

/** 由块标签与属性（lang）推断块内容的高亮语言 */
function vueBlockLang(tag: "script" | "style", attrs: string): LanguageId {
    const lang =
        /\blang\s*=\s*["']?([\w-]+)/i.exec(attrs)?.[1].toLowerCase() ?? "";
    if (tag === "script") {
        return lang === "ts" || lang === "tsx" || lang === "typescript"
            ? "typescript"
            : "javascript";
    }
    return lang === "scss" || lang === "sass" ? "scss" : "css";
}

/**
 * 逐行解析 Vue SFC 每行所属语言（供编辑器按行高亮使用）。
 *
 * vue 语法依赖多行 begin/end 块，按行高亮时 <script>/<style> 内部
 * 无法命中而整体退化为 xml（单色）。因此用轻量状态机预扫描全文，
 * 将每行映射为可独立高亮的语言：块开/闭标签行与 template 区域为
 * xml，script 块按 lang 取 typescript/javascript，style 块按 lang 取
 * scss/css。多行开始标签（如 <script\n setup\n lang="ts"\n>）累积
 * 属性直到出现闭合 `>` 再落定。
 */
export function vueLineLanguages(lines: string[]): LanguageId[] {
    const out: LanguageId[] = new Array(lines.length);
    /** 当前处于打开状态的块；null 表示 template / 外层区域 */
    let block: { tag: "script" | "style"; lang: LanguageId } | null = null;
    /** 跨行开始标签进行中的块类型 */
    let pendingTag: "script" | "style" | null = null;
    /** 跨行开始标签已累积的属性文本 */
    let pendingAttrs = "";

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";

        // 开始标签跨行：属性行归 xml，遇到 `>` 后落定块语言
        if (pendingTag) {
            out[i] = "xml";
            const gt = line.indexOf(">");
            if (gt !== -1) {
                pendingAttrs += " " + line.slice(0, gt);
                const rest = line.slice(gt + 1).toLowerCase();
                // 单行块（<script ...>...</script>）：不进入块状态
                if (!rest.includes(`</${pendingTag}`)) {
                    block = {
                        tag: pendingTag,
                        lang: vueBlockLang(pendingTag, pendingAttrs),
                    };
                }
                pendingTag = null;
                pendingAttrs = "";
            } else {
                pendingAttrs += " " + line;
            }
            continue;
        }

        // 块内部：遇对应闭合标签回到 template 区域，否则沿用块语言
        if (block) {
            if (line.toLowerCase().includes(`</${block.tag}`)) {
                out[i] = "xml";
                block = null;
            } else {
                out[i] = block.lang;
            }
            continue;
        }

        // template / 外层区域：识别 <script / <style 开始标签
        const m = VUE_BLOCK_OPEN_RE.exec(line);
        out[i] = "xml";
        if (!m) continue;
        const tag = m[1]!.toLowerCase() as "script" | "style";
        const afterAttrs = m.index + m[0].length;
        if (line[afterAttrs] === ">") {
            // 开始标签在本行闭合；若同行还有闭合标签则视为单行块
            const rest = line.slice(afterAttrs + 1).toLowerCase();
            if (!rest.includes(`</${tag}`)) {
                block = { tag, lang: vueBlockLang(tag, m[2] ?? "") };
            }
        } else {
            // 开始标签未闭合 → 进入跨行 pending 状态
            pendingTag = tag;
            pendingAttrs = m[2] ?? "";
        }
    }
    return out;
}
