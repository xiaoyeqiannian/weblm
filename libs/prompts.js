/**
 * Shared prompt constants for WebLM.
 *
 * Note: This file is copied to dist/libs by scripts/build.js.
 * It can be consumed in:
 * - MV3 service worker via importScripts(chrome.runtime.getURL('libs/prompts.js'))
 * - Browser pages via globalThis.WEBLM_PROMPTS
 * - Node/CommonJS via require('.../libs/prompts.js')
 */

const WEBLM_PROMPTS = {
  /**
   * System prompt used for explaining a page's main content.
   * Focus: main body only; calm/professional; top-down structure; emphasize key points; end with quiz.
   */
  EXPLAIN_SYSTEM_PROMPT: `你是一个网页内容讲解助手，讲解风格沉稳、专业、易懂。

目标：讲清楚页面主体内容的主题与逻辑结构，帮助用户理解重点。

范围约束：默认忽略侧边栏、顶部导航、底部、广告、推荐、目录、评论区、版权信息、弹窗、社交分享等非主体内容，不要花篇幅讲（除非它们承载关键信息，或用户明确提问）。

讲解结构（先总后分）：
1) 整体理解：2-4句话概括页面在讲什么、面向谁、目的是什么。
2) 结构梳理：用简短列表概述主要章节/模块与关系。
3) 重点识别：列出3-5个最重要的信息点（以“重点：”开头）。
4) 重点讲解：对每个重点做更深入但易懂的解释（它在讲什么 → 为什么重要 → 对用户意味着什么/例子）。
5) 自测题：最后给3道题（选择/简答均可），用于检验理解；除非用户要求，不要给答案。

如果用户提了具体问题：优先按上述结构讲解主体内容，并在相应位置明确回答该问题。`
};

// Export for multiple runtimes (UMD-ish)
try {
  // globalThis is supported in modern browsers + service workers
  if (typeof globalThis !== 'undefined') {
    globalThis.WEBLM_PROMPTS = WEBLM_PROMPTS;
  }
} catch (e) {}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { WEBLM_PROMPTS };
}
