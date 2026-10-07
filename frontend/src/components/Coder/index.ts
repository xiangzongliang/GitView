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
 * - fontSizeChange：状态栏「字号: x」菜单选择后上抛，外层需通过
 *   :font-size 回写才能生效；字号仅作用于编辑器内部排版
 *   （行高/光标/补全面板随之缩放），不影响应用全局字号；
 *   默认字号与应用标准字号一致（13px）；
 * - props：language（highlight.js 语言 id，优先级最高）、
 *   filename（按扩展名推断语言）、readonly、indentSize（默认 2）、
 *   fontSize（默认 CODER_DEFAULT_FONT_SIZE）、themeVars（--hl-* 等变量表）、
 *   markedLines（0 起源行号数组，冲突区域等外部标注行高亮）、
 *   preserveScroll（data 重载时保留滚动位置，供同步滚动场景）；
 *   状态栏「语言」可点击手动选择（优先于以上推断与自动检测，
 *   外部整体重载内容后复位为自动）；
 * - scroll：滚动位置变化 [top, left]（外部调用 setScroll 不触发，
 *   避免多编辑器同步滚动形成回环）；
 * - status-prefix 插槽：状态栏「字号: x」之前的扩展区
 *   （如文档页的「最后编辑」时间）；
 * - defineExpose：focus / flush（立即上抛 debounce 中的变更）/
 *   setScroll（返回 clamp 后的实际位置）/ lineAtScrollTop /
 *   scrollTopForLine / lineHeightPx() / fontSizePx()；
 * - 查找：输入查询词后所有匹配以黄色底纹标出，当前跳转到的匹配
 *   以橙色高亮区分；
 * - 组件必须被限定高度的容器包裹（内部自适应填满）。
 */
export { default as CoderView } from "./Coder.vue";
export type { LanguageId } from "./highlight";
export {
	CODER_DEFAULT_FONT_SIZE,
	CODER_MAX_FONT_SIZE,
	CODER_MIN_FONT_SIZE,
	clampFontSize,
	coderLineHeight,
} from "./editor-utils";
