/**
 * 自动补全候选：常用语言保留字词典 + 缓冲区文档词（变量 / 方法名 / import 名），
 * 前缀匹配；另支持 `xxx.` 后的成员补全（同对象已用成员 + 语言内置对象成员）。
 *
 * 关键字部分为静态词典，轻量零依赖；文档词索引由 Coder.vue 防抖重建后传入。
 */
import type { LanguageId } from "./highlight";

const JS = [
    "abstract",
    "async",
    "await",
    "break",
    "case",
    "catch",
    "class",
    "const",
    "continue",
    "debugger",
    "default",
    "delete",
    "do",
    "else",
    "enum",
    "export",
    "extends",
    "false",
    "finally",
    "for",
    "function",
    "if",
    "implements",
    "import",
    "in",
    "instanceof",
    "interface",
    "let",
    "new",
    "null",
    "of",
    "return",
    "static",
    "super",
    "switch",
    "this",
    "throw",
    "true",
    "try",
    "typeof",
    "undefined",
    "var",
    "void",
    "while",
    "yield",
];

const TS_EXTRA = [
    "any",
    "as",
    "asserts",
    "boolean",
    "declare",
    "infer",
    "is",
    "keyof",
    "module",
    "namespace",
    "never",
    "number",
    "override",
    "readonly",
    "satisfies",
    "string",
    "symbol",
    "type",
    "unknown",
];

const PYTHON = [
    "and",
    "as",
    "assert",
    "async",
    "await",
    "break",
    "class",
    "continue",
    "def",
    "del",
    "elif",
    "else",
    "except",
    "False",
    "finally",
    "for",
    "from",
    "global",
    "if",
    "import",
    "in",
    "is",
    "lambda",
    "None",
    "nonlocal",
    "not",
    "or",
    "pass",
    "raise",
    "return",
    "True",
    "try",
    "while",
    "with",
    "yield",
];

const JAVA = [
    "abstract",
    "assert",
    "boolean",
    "break",
    "byte",
    "case",
    "catch",
    "char",
    "class",
    "continue",
    "default",
    "do",
    "double",
    "else",
    "enum",
    "extends",
    "false",
    "final",
    "finally",
    "float",
    "for",
    "if",
    "implements",
    "import",
    "instanceof",
    "int",
    "interface",
    "long",
    "native",
    "new",
    "null",
    "package",
    "private",
    "protected",
    "public",
    "record",
    "return",
    "sealed",
    "short",
    "static",
    "super",
    "switch",
    "synchronized",
    "this",
    "throw",
    "throws",
    "transient",
    "true",
    "try",
    "var",
    "void",
    "volatile",
    "while",
    "yield",
];

const C = [
    "auto",
    "bool",
    "break",
    "case",
    "char",
    "const",
    "continue",
    "default",
    "do",
    "double",
    "else",
    "enum",
    "extern",
    "false",
    "float",
    "for",
    "goto",
    "if",
    "inline",
    "int",
    "long",
    "NULL",
    "register",
    "restrict",
    "return",
    "short",
    "signed",
    "sizeof",
    "static",
    "struct",
    "switch",
    "typedef",
    "union",
    "unsigned",
    "void",
    "volatile",
    "while",
];

const CPP_EXTRA = [
    "auto",
    "catch",
    "class",
    "co_await",
    "co_return",
    "co_yield",
    "concept",
    "const_cast",
    "constexpr",
    "consteval",
    "constinit",
    "decltype",
    "delete",
    "dynamic_cast",
    "explicit",
    "export",
    "friend",
    "mutable",
    "namespace",
    "new",
    "noexcept",
    "nullptr",
    "operator",
    "override",
    "private",
    "protected",
    "public",
    "reinterpret_cast",
    "requires",
    "static_cast",
    "template",
    "this",
    "throw",
    "try",
    "typename",
    "using",
    "virtual",
];

const CSHARP = [
    "abstract",
    "as",
    "async",
    "await",
    "base",
    "bool",
    "break",
    "byte",
    "case",
    "catch",
    "char",
    "checked",
    "class",
    "const",
    "continue",
    "decimal",
    "default",
    "delegate",
    "do",
    "double",
    "dynamic",
    "else",
    "enum",
    "event",
    "explicit",
    "extern",
    "false",
    "finally",
    "fixed",
    "float",
    "for",
    "foreach",
    "get",
    "global",
    "goto",
    "if",
    "implicit",
    "in",
    "init",
    "int",
    "interface",
    "internal",
    "is",
    "lock",
    "long",
    "namespace",
    "new",
    "null",
    "object",
    "operator",
    "out",
    "override",
    "params",
    "private",
    "protected",
    "public",
    "readonly",
    "record",
    "ref",
    "required",
    "return",
    "sbyte",
    "sealed",
    "set",
    "short",
    "sizeof",
    "stackalloc",
    "static",
    "string",
    "struct",
    "switch",
    "this",
    "throw",
    "true",
    "try",
    "typeof",
    "uint",
    "ulong",
    "unchecked",
    "unsafe",
    "ushort",
    "using",
    "value",
    "var",
    "virtual",
    "void",
    "volatile",
    "when",
    "where",
    "while",
    "yield",
];

const GO = [
    "append",
    "bool",
    "break",
    "byte",
    "cap",
    "case",
    "chan",
    "close",
    "complex",
    "const",
    "continue",
    "copy",
    "default",
    "defer",
    "delete",
    "else",
    "error",
    "fallthrough",
    "false",
    "float32",
    "float64",
    "for",
    "func",
    "go",
    "goto",
    "if",
    "imag",
    "import",
    "int",
    "int8",
    "int16",
    "int32",
    "int64",
    "interface",
    "iota",
    "len",
    "make",
    "map",
    "new",
    "nil",
    "package",
    "panic",
    "print",
    "println",
    "range",
    "real",
    "recover",
    "return",
    "rune",
    "select",
    "string",
    "struct",
    "switch",
    "true",
    "type",
    "uint",
    "uint8",
    "uint16",
    "uint32",
    "uint64",
    "uintptr",
    "var",
];

const RUST = [
    "as",
    "async",
    "await",
    "break",
    "const",
    "continue",
    "crate",
    "dyn",
    "else",
    "enum",
    "extern",
    "false",
    "fn",
    "for",
    "if",
    "impl",
    "in",
    "let",
    "loop",
    "match",
    "mod",
    "move",
    "mut",
    "pub",
    "ref",
    "return",
    "Self",
    "self",
    "static",
    "struct",
    "super",
    "trait",
    "true",
    "type",
    "union",
    "unsafe",
    "use",
    "where",
    "while",
];

const PHP = [
    "abstract",
    "and",
    "array",
    "as",
    "break",
    "callable",
    "case",
    "catch",
    "class",
    "clone",
    "const",
    "continue",
    "declare",
    "default",
    "do",
    "echo",
    "else",
    "elseif",
    "empty",
    "enddeclare",
    "endfor",
    "endforeach",
    "endif",
    "endswitch",
    "endwhile",
    "enum",
    "extends",
    "false",
    "final",
    "finally",
    "fn",
    "for",
    "foreach",
    "function",
    "global",
    "goto",
    "if",
    "implements",
    "include",
    "include_once",
    "instanceof",
    "insteadof",
    "interface",
    "isset",
    "list",
    "match",
    "namespace",
    "new",
    "null",
    "or",
    "parent",
    "print",
    "private",
    "protected",
    "public",
    "readonly",
    "require",
    "require_once",
    "return",
    "self",
    "static",
    "switch",
    "throw",
    "trait",
    "true",
    "try",
    "unset",
    "use",
    "var",
    "while",
    "xor",
    "yield",
];

const RUBY = [
    "alias",
    "and",
    "attr_accessor",
    "attr_reader",
    "attr_writer",
    "begin",
    "break",
    "case",
    "class",
    "def",
    "defined?",
    "do",
    "else",
    "elsif",
    "end",
    "ensure",
    "extend",
    "false",
    "for",
    "if",
    "in",
    "include",
    "lambda",
    "module",
    "new",
    "next",
    "nil",
    "not",
    "or",
    "proc",
    "raise",
    "redo",
    "require",
    "require_relative",
    "rescue",
    "retry",
    "return",
    "self",
    "super",
    "then",
    "true",
    "undef",
    "unless",
    "until",
    "when",
    "while",
    "yield",
];

const SQL = [
    "ADD",
    "ALL",
    "ALTER",
    "AND",
    "AS",
    "ASC",
    "AVG",
    "BETWEEN",
    "BIGINT",
    "BOOLEAN",
    "BY",
    "CASE",
    "CAST",
    "CHAR",
    "CHECK",
    "COALESCE",
    "COMMIT",
    "CONSTRAINT",
    "COUNT",
    "CREATE",
    "CROSS",
    "CURRENT_DATE",
    "CURRENT_TIME",
    "CURRENT_TIMESTAMP",
    "DATABASE",
    "DATETIME",
    "DECIMAL",
    "DEFAULT",
    "DELETE",
    "DESC",
    "DISTINCT",
    "DROP",
    "ELSE",
    "END",
    "EXISTS",
    "EXPLAIN",
    "FLOAT",
    "FOREIGN",
    "FROM",
    "FULL",
    "GROUP",
    "HAVING",
    "IF",
    "IN",
    "INDEX",
    "INNER",
    "INSERT",
    "INT",
    "INTEGER",
    "INTO",
    "IS",
    "JOIN",
    "KEY",
    "LEFT",
    "LIKE",
    "LIMIT",
    "MAX",
    "MIN",
    "NOT",
    "NULL",
    "OFFSET",
    "ON",
    "OR",
    "ORDER",
    "OUTER",
    "PRIMARY",
    "REFERENCES",
    "RETURNING",
    "RIGHT",
    "ROLLBACK",
    "SELECT",
    "SET",
    "SUM",
    "TABLE",
    "TEXT",
    "THEN",
    "TIMESTAMP",
    "TRANSACTION",
    "TRIGGER",
    "TRUNCATE",
    "UNION",
    "UNIQUE",
    "UPDATE",
    "VALUES",
    "VARCHAR",
    "VIEW",
    "WHEN",
    "WHERE",
    "WITH",
];

const BASH = [
    "alias",
    "break",
    "case",
    "cd",
    "continue",
    "declare",
    "do",
    "done",
    "echo",
    "elif",
    "else",
    "esac",
    "eval",
    "exec",
    "exit",
    "export",
    "false",
    "fi",
    "for",
    "function",
    "if",
    "in",
    "local",
    "printf",
    "read",
    "readonly",
    "return",
    "select",
    "set",
    "shift",
    "source",
    "test",
    "then",
    "time",
    "trap",
    "true",
    "unset",
    "until",
    "wait",
    "while",
];

const CSS = [
    "@charset",
    "@container",
    "@font-face",
    "@import",
    "@keyframes",
    "@layer",
    "@media",
    "@page",
    "@property",
    "@scope",
    "@starting-style",
    "@supports",
    "absolute",
    "auto",
    "block",
    "bold",
    "bottom",
    "center",
    "currentcolor",
    "fixed",
    "flex",
    "grid",
    "hidden",
    "important",
    "inherit",
    "initial",
    "inline",
    "inline-block",
    "inline-flex",
    "italic",
    "left",
    "none",
    "normal",
    "nowrap",
    "pointer",
    "relative",
    "revert",
    "revert-layer",
    "right",
    "sticky",
    "top",
    "transparent",
    "unset",
    "visible",
    "wrap",
];

const DOCKERFILE = [
    "ADD",
    "ARG",
    "AS",
    "CMD",
    "COPY",
    "ENTRYPOINT",
    "ENV",
    "EXPOSE",
    "FROM",
    "HEALTHCHECK",
    "LABEL",
    "MAINTAINER",
    "ONBUILD",
    "RUN",
    "SHELL",
    "STOPSIGNAL",
    "USER",
    "VOLUME",
    "WORKDIR",
];

/**
 * Vue 2 / Vue 3 SFC：模板指令 + 选项式 API（Vue2）+ 组合式 API（Vue3）+
 * 实例成员（$ 前缀，isWordChar 含 $，可直接前缀匹配）。
 */
const VUE = [
    // 模板指令
    "v-if",
    "v-else",
    "v-else-if",
    "v-for",
    "v-model",
    "v-show",
    "v-html",
    "v-text",
    "v-on",
    "v-bind",
    "v-slot",
    "v-pre",
    "v-cloak",
    "v-once",
    "v-memo",
    // Vue3 组合式 API
    "setup",
    "ref",
    "reactive",
    "computed",
    "watch",
    "watchEffect",
    "watchPostEffect",
    "watchSyncEffect",
    "provide",
    "inject",
    "nextTick",
    "defineProps",
    "defineEmits",
    "defineExpose",
    "defineOptions",
    "defineSlots",
    "withDefaults",
    "toRef",
    "toRefs",
    "toRaw",
    "unref",
    "isRef",
    "isReactive",
    "isProxy",
    "isReadonly",
    "shallowRef",
    "shallowReactive",
    "readonly",
    "markRaw",
    "effectScope",
    "getCurrentInstance",
    "useAttrs",
    "useSlots",
    "useCssModule",
    "useRoute",
    "useRouter",
    "useStore",
    "onMounted",
    "onBeforeMount",
    "onBeforeUpdate",
    "onUpdated",
    "onBeforeUnmount",
    "onUnmounted",
    "onActivated",
    "onDeactivated",
    "onErrorCaptured",
    "onRenderTracked",
    "onRenderTriggered",
    "onServerPrefetch",
    "createApp",
    "createRouter",
    "createWebHistory",
    "createWebHashHistory",
    "createPinia",
    "createStore",
    "h",
    "mergeProps",
    // Vue2 选项式 API 与生命周期
    "props",
    "data",
    "methods",
    "components",
    "mixins",
    "filters",
    "directives",
    "extends",
    "el",
    "render",
    "beforeCreate",
    "created",
    "beforeMount",
    "mounted",
    "beforeUpdate",
    "updated",
    "activated",
    "deactivated",
    "beforeDestroy",
    "destroyed",
    "beforeUnmount",
    "unmounted",
    "errorCaptured",
    // 实例成员（Vue2 常用，含 Vue3 少量保留）
    "$refs",
    "$emit",
    "$el",
    "$nextTick",
    "$props",
    "$data",
    "$attrs",
    "$listeners",
    "$slots",
    "$scopedSlots",
    "$parent",
    "$children",
    "$root",
    "$options",
    "$set",
    "$delete",
    "$forceUpdate",
    "$destroy",
    "$on",
    "$off",
    "$once",
    "$router",
    "$route",
    "$store",
];

export const COMPLETION_KEYWORDS: Partial<
    Record<LanguageId, readonly string[]>
> = {
    javascript: JS,
    typescript: Array.from(new Set([...JS, ...TS_EXTRA])),
    vue: Array.from(new Set([...JS, ...TS_EXTRA, ...VUE])),
    python: PYTHON,
    java: JAVA,
    c: C,
    cpp: Array.from(new Set([...C, ...CPP_EXTRA])),
    csharp: CSHARP,
    go: GO,
    rust: RUST,
    php: PHP,
    ruby: RUBY,
    sql: SQL,
    bash: BASH,
    shell: BASH,
    css: CSS,
    scss: CSS,
    dockerfile: DOCKERFILE,
};

/** 补全面板最多展示条数 */
export const COMPLETION_MAX = 9;

/** 文档词（从缓冲区提取的标识符）候选上限，按出现频率降序保留 */
export const DOC_WORDS_MAX = 500;
/** 成员索引：最多记录的 receiver 个数（超过后不再新增，避免爆炸） */
const RECEIVERS_MAX = 200;
/** 成员索引：每个 receiver 最多记录的成员数 */
const MEMBERS_PER_RECEIVER_MAX = 30;

/**
 * 标识符扫描：字母/ _ / $ 开头，后续可含 -（兼容 CSS 属性名，
 * 与 wordPrefixBefore 的 isWordChar 规则保持一致）。
 */
const WORD_SCAN_RE = /[A-Za-z_$][A-Za-z0-9_$-]*/g;

/** 成员访问扫描：`receiver.member`（容忍空白，链式调用可跨行） */
const MEMBER_ACCESS_RE = /([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)/g;

/** 文档词索引：一次防抖重建后供逐键匹配复用 */
export interface WordIndex {
    /** 全文标识符（import 名优先），按频率降序 */
    words: string[];
    /** receiver -> 在全文中对其用过的成员名（按频率降序） */
    members: Map<string, string[]>;
    /** 全文出现过的所有成员名（按频率降序），未知 receiver 的回退候选 */
    memberNames: string[];
}

const EMPTY_INDEX: WordIndex = {
    words: [],
    members: new Map(),
    memberNames: [],
};

/** 空索引（未加载内容时复用同一实例，避免重复分配） */
export function emptyWordIndex(): WordIndex {
    return EMPTY_INDEX;
}

function lastSegment(s: string, sep: string): string {
    const i = s.lastIndexOf(sep);
    return i >= 0 ? s.slice(i + sep.length) : s;
}

/** 取 `a, b as c` 这类名字列表中的本地绑定名 */
function addBindingList(raw: string, out: Set<string>): void {
    for (const part of raw.split(",")) {
        const name = part
            .trim()
            .split(/\s+as\s+/i)
            .pop()
            ?.trim();
        if (name && /^[A-Za-z_$][\w$]*$/.test(name)) out.add(name);
    }
}

/**
 * 按语言提取 import / require / use 等引入的本地名字。
 * 纯正则启发式（无 AST），只覆盖常见写法；取不到名字（如 C 的 #include）返回空。
 */
export function extractImports(
    text: string,
    lang: LanguageId | null,
): string[] {
    if (!text) return [];
    const out = new Set<string>();
    switch (lang) {
        case "javascript":
        case "typescript":
        case "vue": {
            for (const m of text.matchAll(/\bimport\s*\{([^}]*)\}/g))
                addBindingList(m[1], out);
            for (const m of text.matchAll(
                /\bimport\s*\*\s*as\s+([A-Za-z_$][\w$]*)/g,
            ))
                out.add(m[1]);
            for (const m of text.matchAll(
                /\bimport\s+(?:type\s+)?([A-Za-z_$][\w$]*)\s*(?:,|\bfrom\b)/g,
            ))
                out.add(m[1]);
            for (const m of text.matchAll(
                /\b(?:const|let|var)\s+(?:\{([^}]*)\}|([A-Za-z_$][\w$]*))\s*=\s*require\s*\(/g,
            )) {
                if (m[1]) addBindingList(m[1], out);
                else if (m[2]) out.add(m[2]);
            }
            break;
        }
        case "python": {
            for (const m of text.matchAll(/^\s*import\s+(.+?)\s*(?:#.*)?$/gm))
                for (const part of m[1].split(",")) {
                    const mm = part
                        .trim()
                        .match(/^([\w.]+)(?:\s+as\s+(\w+))?$/);
                    if (mm) out.add(mm[2] ?? lastSegment(mm[1], "."));
                }
            for (const m of text.matchAll(
                /^\s*from\s+[\w.]+\s+import\s+([^#\n]+)/gm,
            ))
                addBindingList(m[1].replace(/[()\\]/g, " "), out);
            break;
        }
        case "go": {
            for (const m of text.matchAll(/^\s*import\s+"([^"]+)"/gm))
                out.add(lastSegment(m[1], "/"));
            for (const m of text.matchAll(/import\s*\(([\s\S]*?)\)/g))
                for (const q of m[1].matchAll(/"([^"]+)"/g))
                    out.add(lastSegment(q[1], "/"));
            break;
        }
        case "java": {
            for (const m of text.matchAll(
                /^\s*import\s+(?:static\s+)?([\w.]+)\s*;/gm,
            ))
                if (!m[1].endsWith("*")) out.add(lastSegment(m[1], "."));
            break;
        }
        case "csharp": {
            for (const m of text.matchAll(/^\s*using\s+([\w.]+)\s*;/gm))
                out.add(lastSegment(m[1], "."));
            break;
        }
        case "php": {
            for (const m of text.matchAll(
                /^\s*use\s+([\w\\]+)(?:\s+as\s+(\w+))?\s*;/gm,
            ))
                out.add(m[2] ?? lastSegment(m[1], "\\"));
            break;
        }
        case "rust": {
            for (const m of text.matchAll(/^\s*use\s+([\w:]+)\s*;/gm))
                out.add(lastSegment(m[1], "::"));
            break;
        }
        case "ruby": {
            for (const m of text.matchAll(
                /^\s*require(?:_relative)?\s+["']([^"']+)["']/gm,
            ))
                out.add(lastSegment(m[1], "/").replace(/\.rb$/, ""));
            break;
        }
        default:
            break;
    }
    return Array.from(out);
}

/**
 * 一次重建文档词索引（O(n)，由 Coder.vue 防抖调用）：
 * - words：全文标识符按频率降序，import 名排最前（保证可见）；
 * - members / memberNames：来自 `receiver.member` 扫描，供成员补全。
 */
export function buildWordIndex(
    text: string,
    lang: LanguageId | null,
): WordIndex {
    if (!text) return EMPTY_INDEX;
    const counts = new Map<string, number>();
    for (const m of text.matchAll(WORD_SCAN_RE)) {
        const w = m[0];
        if (w.length < 2) continue;
        counts.set(w, (counts.get(w) ?? 0) + 1);
    }
    const memberCounts = new Map<string, Map<string, number>>();
    const allMembers = new Map<string, number>();
    for (const m of text.matchAll(MEMBER_ACCESS_RE)) {
        const recv = m[1];
        const name = m[2];
        if (recv === name) continue;
        let inner = memberCounts.get(recv);
        if (!inner) {
            if (memberCounts.size >= RECEIVERS_MAX) continue;
            inner = new Map();
            memberCounts.set(recv, inner);
        }
        inner.set(name, (inner.get(name) ?? 0) + 1);
        allMembers.set(name, (allMembers.get(name) ?? 0) + 1);
    }
    const members = new Map<string, string[]>();
    for (const [recv, inner] of memberCounts) {
        const names = Array.from(inner.entries())
            .sort((a, b) => b[1] - a[1])
            .map((e) => e[0])
            .slice(0, MEMBERS_PER_RECEIVER_MAX);
        members.set(recv, names);
    }
    const memberNames = Array.from(allMembers.entries())
        .sort((a, b) => b[1] - a[1])
        .map((e) => e[0])
        .slice(0, DOC_WORDS_MAX);
    const words = Array.from(counts.entries())
        .sort((a, b) => b[1] - a[1])
        .map((e) => e[0]);
    const imports = extractImports(text, lang).filter((i) => !counts.has(i));
    return {
        words: [...imports, ...words].slice(0, DOC_WORDS_MAX),
        members,
        memberNames,
    };
}

/** 常见内置对象的成员提示（按语言），未知 receiver 的第二级回退 */
const JS_MEMBERS: Record<string, readonly string[]> = {
    console: [
        "log",
        "error",
        "warn",
        "info",
        "debug",
        "table",
        "time",
        "timeEnd",
        "group",
        "groupEnd",
        "dir",
        "count",
        "assert",
        "trace",
    ],
    Math: [
        "floor",
        "ceil",
        "round",
        "abs",
        "max",
        "min",
        "random",
        "sqrt",
        "pow",
        "trunc",
        "sign",
        "hypot",
        "log",
        "PI",
        "E",
    ],
    JSON: ["parse", "stringify"],
    Object: [
        "keys",
        "values",
        "entries",
        "assign",
        "freeze",
        "fromEntries",
        "defineProperty",
        "create",
    ],
    Array: ["isArray", "from", "of"],
    Promise: ["all", "allSettled", "race", "any", "resolve", "reject"],
    Number: [
        "isInteger",
        "isFinite",
        "isNaN",
        "parseFloat",
        "parseInt",
        "MAX_SAFE_INTEGER",
    ],
    String: ["fromCharCode", "raw"],
    Date: ["now", "parse", "UTC"],
    document: [
        "querySelector",
        "querySelectorAll",
        "getElementById",
        "createElement",
        "addEventListener",
        "removeEventListener",
        "body",
        "head",
        "title",
    ],
    window: [
        "addEventListener",
        "removeEventListener",
        "location",
        "localStorage",
        "sessionStorage",
        "requestAnimationFrame",
        "innerWidth",
        "innerHeight",
        "open",
        "close",
    ],
};

const PY_MEMBERS: Record<string, readonly string[]> = {
    os: [
        "path",
        "environ",
        "listdir",
        "makedirs",
        "remove",
        "rename",
        "getcwd",
        "sep",
        "system",
    ],
    path: [
        "join",
        "exists",
        "isfile",
        "isdir",
        "abspath",
        "dirname",
        "basename",
        "splitext",
    ],
    sys: [
        "argv",
        "exit",
        "path",
        "stdout",
        "stderr",
        "stdin",
        "version",
        "platform",
    ],
    json: ["loads", "dumps", "load", "dump"],
    re: [
        "match",
        "search",
        "findall",
        "sub",
        "compile",
        "split",
        "IGNORECASE",
        "MULTILINE",
    ],
    math: ["floor", "ceil", "sqrt", "pow", "pi", "inf", "isnan"],
    datetime: [
        "now",
        "today",
        "fromtimestamp",
        "strftime",
        "strptime",
        "date",
        "timedelta",
    ],
    self: [
        "append",
        "get",
        "set",
        "keys",
        "values",
        "items",
        "copy",
        "update",
        "strip",
        "split",
        "join",
    ],
};

const GO_MEMBERS: Record<string, readonly string[]> = {
    fmt: [
        "Println",
        "Printf",
        "Sprintf",
        "Fprintf",
        "Errorf",
        "Scanf",
        "Sprint",
        "Print",
    ],
    strings: [
        "Contains",
        "Join",
        "Split",
        "TrimSpace",
        "Replace",
        "HasPrefix",
        "HasSuffix",
        "ToUpper",
        "ToLower",
    ],
    time: [
        "Now",
        "Since",
        "Duration",
        "Sleep",
        "Parse",
        "Second",
        "Millisecond",
    ],
    os: [
        "Getenv",
        "Setenv",
        "Args",
        "Exit",
        "Open",
        "Create",
        "Stdout",
        "Stderr",
    ],
    errors: ["New", "Is", "As", "Join"],
    strconv: ["Atoi", "Itoa", "ParseInt", "FormatInt"],
    sync: ["Mutex", "WaitGroup", "Once", "RWMutex"],
    sort: ["Ints", "Strings", "Slice", "Float64s"],
};

const JAVA_MEMBERS: Record<string, readonly string[]> = {
    System: [
        "out",
        "err",
        "in",
        "currentTimeMillis",
        "nanoTime",
        "lineSeparator",
        "exit",
        "getProperty",
        "getenv",
    ],
    Math: [
        "abs",
        "max",
        "min",
        "floor",
        "ceil",
        "sqrt",
        "pow",
        "random",
        "round",
    ],
    Integer: [
        "parseInt",
        "valueOf",
        "toString",
        "compare",
        "MAX_VALUE",
        "MIN_VALUE",
    ],
    Long: ["parseLong", "valueOf", "MAX_VALUE", "MIN_VALUE"],
    Objects: ["requireNonNull", "equals", "hash", "toString", "isNull"],
    Optional: [
        "of",
        "ofNullable",
        "empty",
        "isPresent",
        "get",
        "orElse",
        "map",
    ],
    Arrays: [
        "asList",
        "sort",
        "toString",
        "stream",
        "copyOf",
        "fill",
        "equals",
    ],
    String: ["format", "join", "valueOf", "isEmpty", "length"],
};

const CS_MEMBERS: Record<string, readonly string[]> = {
    Console: ["WriteLine", "Write", "ReadLine", "ReadKey", "Error"],
    Math: [
        "Abs",
        "Max",
        "Min",
        "Floor",
        "Ceiling",
        "Sqrt",
        "Pow",
        "Round",
        "PI",
    ],
    String: [
        "IsNullOrEmpty",
        "IsNullOrWhiteSpace",
        "Join",
        "Format",
        "Concat",
        "Empty",
    ],
    DateTime: [
        "Now",
        "UtcNow",
        "Today",
        "Parse",
        "TryParse",
        "MinValue",
        "MaxValue",
    ],
    Task: ["Run", "Delay", "FromResult", "WhenAll", "CompletedTask"],
    Guid: ["NewGuid", "Parse", "Empty", "TryParse"],
    int: ["Parse", "TryParse", "MaxValue", "MinValue"],
};

const CPP_MEMBERS: Record<string, readonly string[]> = {
    std: [
        "cout",
        "cin",
        "cerr",
        "endl",
        "string",
        "vector",
        "map",
        "set",
        "pair",
        "sort",
        "find",
        "min",
        "max",
        "swap",
        "move",
        "forward",
        "make_shared",
        "make_unique",
        "size",
    ],
};

const VUE_MEMBERS: Record<string, readonly string[]> = {
    this: [
        "$refs",
        "$emit",
        "$el",
        "$nextTick",
        "$props",
        "$data",
        "$attrs",
        "$listeners",
        "$slots",
        "$scopedSlots",
        "$parent",
        "$root",
        "$options",
        "$router",
        "$route",
        "$store",
        "$set",
        "$forceUpdate",
    ],
    router: [
        "push",
        "replace",
        "go",
        "back",
        "forward",
        "currentRoute",
        "beforeEach",
        "afterEach",
        "resolve",
    ],
    route: [
        "path",
        "query",
        "params",
        "name",
        "fullPath",
        "hash",
        "meta",
        "matched",
    ],
    store: [
        "state",
        "getters",
        "commit",
        "dispatch",
        "subscribe",
        "registerModule",
    ],
};

export const MEMBER_HINTS: Partial<
    Record<LanguageId, Record<string, readonly string[]>>
> = {
    javascript: JS_MEMBERS,
    typescript: JS_MEMBERS,
    vue: VUE_MEMBERS,
    python: PY_MEMBERS,
    go: GO_MEMBERS,
    java: JAVA_MEMBERS,
    csharp: CS_MEMBERS,
    cpp: CPP_MEMBERS,
};

/** 去重并保持原有顺序 */
function dedupe(items: string[]): string[] {
    return Array.from(new Set(items));
}

/** 单词字符：标识符 / CSS 属性 / Dockerfile 指令通用（含 $、-） */
function isWordChar(ch: string): boolean {
    return /[A-Za-z0-9_$-]/.test(ch);
}

/** 取光标前的单词前缀及其起始下标（无前缀时 word 为空串） */
export function wordPrefixBefore(
    text: string,
    caret: number,
): { word: string; start: number } {
    let i = caret;
    while (i > 0 && isWordChar(text[i - 1] ?? "")) i -= 1;
    return { word: text.slice(i, caret), start: i };
}

/**
 * 计算补全候选：大小写敏感优先（无结果时回退大小写不敏感，
 * 便于 SQL / Dockerfile 等大小写不敏感语言）；
 * 候选 = 语言关键字词典 + 文档词（缓冲区中出现的标识符），
 * 关键字在前、文档词按频率排序在后，去重；
 * 与已输入单词完全相同的候选排除；最多返回 COMPLETION_MAX 条。
 */
export function keywordCompletions(
    word: string,
    lang: LanguageId | null,
    docWords: readonly string[] = [],
): string[] {
    if (!word) return [];
    const dict = lang ? COMPLETION_KEYWORDS[lang] : undefined;
    const matchesPrefix = (k: string) => k.startsWith(word) && k !== word;
    const exact = dedupe([
        ...(dict ? dict.filter(matchesPrefix) : []),
        ...docWords.filter(matchesPrefix),
    ]);
    if (exact.length > 0) return exact.slice(0, COMPLETION_MAX);
    const lower = word.toLowerCase();
    const looseMatches = (k: string) =>
        k.toLowerCase().startsWith(lower) && k !== word;
    const loose = dedupe([
        ...(dict ? dict.filter(looseMatches) : []),
        ...docWords.filter(looseMatches),
    ]);
    return loose.slice(0, COMPLETION_MAX);
}

/**
 * 判断光标前缀是否处于成员访问上下文（如 `console.lo` 的 `console`）。
 * wordStart 为前缀起始下标（wordPrefixBefore 的返回值）；
 * 支持可选链 `?.`；receiver 以数字开头（如 `3.14`）不算，避免误弹。
 */
export function memberReceiverBefore(
    text: string,
    wordStart: number,
): string | null {
    let end = wordStart - 1;
    if (end < 0 || text[end] !== ".") return null;
    end -= 1;
    if (end >= 0 && text[end] === "?") end -= 1; // 可选链 `?.` 归属于 receiver 边界
    while (end >= 0 && text[end] === " ") end -= 1;
    let start = end;
    while (start >= 0 && /[A-Za-z0-9_$]/.test(text[start] ?? "")) start -= 1;
    if (start === end) return null;
    const receiver = text.slice(start + 1, end + 1);
    return /^[A-Za-z_$]/.test(receiver) ? receiver : null;
}

/**
 * 成员补全候选：优先同 receiver 在全文中用过的成员，
 * 其次该语言内置对象的成员词典（MEMBER_HINTS），
 * 最后回退到全文出现过的所有成员名；word 可为空串（刚敲完 `.`）。
 */
export function memberCompletions(
    receiver: string,
    word: string,
    lang: LanguageId | null,
    index: WordIndex,
): string[] {
    const pool =
        index.members.get(receiver) ??
        (lang ? MEMBER_HINTS[lang]?.[receiver] : undefined) ??
        index.memberNames;
    if (!pool || pool.length === 0) return [];
    const matchesPrefix = (k: string) => k.startsWith(word) && k !== word;
    const exact = word ? pool.filter(matchesPrefix) : Array.from(pool);
    if (exact.length > 0) return dedupe(exact).slice(0, COMPLETION_MAX);
    if (!word) return [];
    const lower = word.toLowerCase();
    const loose = pool.filter(
        (k) => k !== word && k.toLowerCase().startsWith(lower),
    );
    return dedupe(loose).slice(0, COMPLETION_MAX);
}
