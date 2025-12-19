# WebLM（Chrome 扩展）— Copilot 编码指令

## 大局观（先读这些）
- 这是一个 MV3 Chrome 扩展：
  - 后台：`background/background.js`（service worker）负责 LLM 调用、截图、右键菜单、打开/关闭 Side Panel、转发消息。
  - 内容脚本：`content/content.js` 注入网页，负责取页面文本、滚动、画线标注、悬浮按钮、与 Side Panel 协作“边看边讲”。
  - 侧边栏：`sidepanel/sidepanel.js` 是主要交互 UI（聊天/讲解/TTS/语音输入 UI），通过 `chrome.runtime.sendMessage` 调后台。
  - 弹窗：`popup/popup.js` 主要做模型与语音/截图开关配置。

## 构建与运行（本项目最关键的约定）
- 本项目不使用 Webpack/Vite：构建脚本是“复制 + 拼接”。见 `scripts/build.js`。
- `npm run build`：生成 `dist/` 并把 `src/core/annotation-service.js`、`src/core/auto-scroll-service.js`、`src/core/voice-service.js` 直接拼进 `dist/content/content.js`（因此这些 core 文件必须是“无 import 的全局类定义”）。
- `npm run dev`：`node scripts/build.js --watch` 监听并重建 `dist/`。
- `npm run build:mock`：设置 `WEBLM_MOCK_DEMO=1`；会在构建时注入 `const WEBLM_MOCK_DEMO = true` 到 dist 的 content/background，用于 Mock 演示（见下）。

## Mock 演示模式（影响逻辑分支）
- Mock 开关是“编译期 flag + storage 同步”组合：
  - `scripts/build.js` 注入 `WEBLM_MOCK_DEMO`。
  - `background/background.js` 启动时会把 `chrome.storage.local.weblmMockMode` 对齐到 build flag，并在 Mock 模式下阻止大模型调用（`CHAT`/`ANALYZE_PAGE`/`LOCATE_ELEMENTS`）。
  - `sidepanel/sidepanel.js` 在 Mock 模式下用本地 steps 驱动“滚动+标注+播报”，不走 LLM。

## 组件通信（新增功能通常要同时改 2–3 处）
- 统一使用 message `type` 字符串（大写下划线）：后台入口在 `background/background.js` 的 `handleMessage()`。
- 常用消息：
  - Side Panel → Background：`ANALYZE_PAGE`、`CHAT`、`CAPTURE_VIEWPORT`、`RESET_AGENT`
  - Content ↔ Background：`OPEN_SIDE_PANEL`、`CHECK_SIDE_PANEL_STATE`、`LOCATE_ELEMENTS`
  - Background → Content：`EXPLAIN_PAGE`、`EXPLAIN_SELECTION`、`SIDE_PANEL_STATE_CHANGED`
  - Side Panel ↔ Content：通过 `chrome.tabs.sendMessage`（例如 `GET_PAGE_TEXT`、`LECTURE_PREPARE_STEP`、`LECTURE_CLEAR(_MARKS)`）

## 数据与配置（主要在 storage）
- `chrome.storage.local` 里常见键：`modelType` / `llmConfig`（模型配置）、`enableScreenshot`（是否允许图片输入）、`selectedVoice`、`autoSpeak`、`weblmMockMode`、`floatingButtonPosition`。
- 页面文本提取在 `content/content.js#getPageText()`，默认截断到 5000 字符；截图由 `background/background.js#captureViewport()` 提供。

## 代码风格/放置规则（避免构建后失效）
- 运行时脚本大多是“经典脚本”而非 ESModule：不要引入 `import` 语法；共享常量用 `libs/prompts.js` 并在 service worker 里 `importScripts()`。
- 若你要新增一个 core 服务给 content script 使用：需要把文件加进 `scripts/build.js` 的拼接段（否则 `dist/content/content.js` 不会包含它）。
- `src/core/agent.js` / `src/core/llm-provider.js` 更像旧版模块化实现；当前主链路以 `background/background.js` 内联的 `LLMProvider` 为准（改 LLM 行为优先改这里）。
