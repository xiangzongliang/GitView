/**
 * 代码编辑器（Coder）组件入口。
 *
 * 用法（契约与 Database 组件一致）：
 *   <CoderView
 *       :data="doc.content"
 *       :filename="doc.title"
 *       @change="(text) => store.updateDocumentContent(id, text)"
 *       @save="onForceSave"
 *   />
 *
 * - data：纯文本内容快照；外部变更（切换文档等）会整体重载编辑器；
 * - change：编辑后防抖 400ms 抛出最新纯文本，由外层负责持久化；
 *   组件卸载时会立即补发一次未落盘的变更；
 * - save：Ctrl/Cmd+S 时触发（组件内已 stopPropagation，页面级
 *   window 快捷键监听不会重复响应，请在 @save 中处理保存）；
 * - indentChange：状态栏「空格: x」菜单选择（2/4/8）后上抛，
 *   外层需通过 :indent-size 回写才能生效（变化时全文按新缩进重排）；
 * - fontSizeChange：状态栏「字号: x」菜单选择（9/10/11/12/13/14/16/18）
 *   后上抛，外层需通过 :font-size 回写才能生效；字号仅作用于编辑器
 *   内部排版（行高/光标/补全面板随之缩放），不影响应用全局字号；
 *   默认字号与应用标准字号一致（13px）；
 * - languageChange：状态栏「语言」菜单选择后上抛（空字符串 = 恢复
 *   自动检测）；多窗格共享语言时由外层回写到各窗格的 :language；
 * - props：language（highlight.js 语言 id，优先级最高）、
 *   filename（按扩展名推断语言）、readonly、indentSize（默认 2）、
 *   fontSize（默认 CODER_DEFAULT_FONT_SIZE）、themeVars（--hl-* 等变量表）、
 *   markedLines（0 起源行号数组，冲突区域等外部标注行高亮）、
 *   preserveScroll（data 重载时保留滚动位置，供同步滚动场景）、
 *   statusControls（默认 true；为 false 时隐藏状态栏的字号/缩进/语言
 *   菜单，仅保留 Ln/Col、选中与只读徽章，供多窗格副窗格使用）、
 *   lensLines（0 起源行号数组；在这些行的顶部渲染独占一行的不透明
 *   透镜条带，内容来自 #lens 作用域插槽；条带随内容垂直滚动、水平
 *   固定，背景色可用 themeVars 的 --ed-lens-bg 定制）；
 *   状态栏「语言」可点击手动选择（优先于以上推断与自动检测，
 *   外部整体重载内容后复位为自动）；
 * - scroll：滚动位置变化 [top, left]（外部调用 setScroll 不触发，
 *   避免多编辑器同步滚动形成回环）；
 * - status-prefix 插槽：状态栏「字号: x」之前的扩展区
 *   （如文档页的「最后编辑」时间）；
 * - lens 作用域插槽：透镜条带内容，插槽 props 为 { line, index }
 *   （line = 锚定的源行号，index = lensLines 数组下标）；条带本身
 *   pointer-events: none（点击穿透到编辑器），插槽内的交互元素需
 *   自行设置 pointer-events: auto；
 * - defineExpose：focus / flush（立即上抛 debounce 中的变更）/
 *   setScroll（返回 clamp 后的实际位置）/ lineAtScrollTop /
 *   scrollTopForLine / lineHeightPx() / fontSizePx()；
 * - 查找：输入查询词后所有匹配以黄色底纹标出，当前跳转到的匹配
 *   以橙色高亮区分；匹配矩形按视觉列宽计算（CJK 等全角字符按
 *   2 列计），中文内容的高亮宽度与字形一致；
 * - 组件必须被限定高度的容器包裹（内部自适应填满）。
 */
export { default as CoderView } from "./Coder.vue";
export type { LanguageId } from "./highlight";
export {
	CODER_DEFAULT_FONT_SIZE,
	CODER_FONT_OPTIONS,
	CODER_MAX_FONT_SIZE,
	CODER_MIN_FONT_SIZE,
	clampFontSize,
	coderLineHeight,
	snapFontOption,
} from "./editor-utils";
