/**
 * Vue SFC（Vue 2 / Vue 3 通用）语法。
 *
 * highlight.js v11 的按需语言目录不含 vue（v10 曾内置，v11 移除），
 * 因此参照官方 template 语法的既有模式自行实现：
 * 以 xml 子语言高亮全文，从中圈出 script / style 块分别交给
 * javascript / typescript / css / scss 子语言（按 lang 属性选择，
 * 这些子语言均已在本模块注册）。
 */
import type { LanguageFn } from "highlight.js";

const vueGrammar: LanguageFn = (hljs) => ({
    name: "Vue",
    subLanguage: "xml",
    contains: [
        hljs.COMMENT("<!--", "-->", { relevance: 10 }),
        {
            // <script lang="ts" ...> → TypeScript
            begin: /<script(?=[^>]*\blang=["']ts["'])[^>]*>/i,
            end: /<\/script>/i,
            excludeBegin: true,
            excludeEnd: true,
            subLanguage: "typescript",
        },
        {
            // 其余 <script> → JavaScript
            begin: /<script(?![^>]*\blang=["']ts["'])(\s[^>]*)?>/i,
            end: /<\/script>/i,
            excludeBegin: true,
            excludeEnd: true,
            subLanguage: "javascript",
        },
        {
            // <style lang="scss|sass" ...> → SCSS
            begin: /<style(?=[^>]*\blang=["'](?:scss|sass)["'])[^>]*>/i,
            end: /<\/style>/i,
            excludeBegin: true,
            excludeEnd: true,
            subLanguage: "scss",
        },
        {
            // 其余 <style> → CSS
            begin: /<style(?![^>]*\blang=["'](?:scss|sass)["'])(\s[^>]*)?>/i,
            end: /<\/style>/i,
            excludeBegin: true,
            excludeEnd: true,
            subLanguage: "css",
        },
    ],
});

export default vueGrammar;
