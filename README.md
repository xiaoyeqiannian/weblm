# Page Explainer AI Agent - 网页讲解助手

一个 AI 驱动的 Chrome 浏览器扩展，用于网页内容讲解，支持画线标注、自动翻页和语音对话。

## ✨ 功能特性

### 🤖 AI 页面讲解
- 自动分析当前页面内容
- 智能回答关于页面的问题
- 支持多轮对话，保持上下文

### ✏️ 画线标注
- 在页面上高亮重要元素
- 绘制指引箭头
- AI 自动识别并标注关键内容

### 📜 自动翻页
- 自动滚动浏览长页面
- 支持调整滚动速度
- 智能阅读模式

### 🎤 语音交互
- 语音输入问题
- 语音播报 AI 回复
- 支持中文语音识别

### 🔌 多模型支持
- OpenAI (GPT-4o)
- Anthropic (Claude)
- 阿里云 (千问VL)
- 火山引擎 (豆包)
- Google (Gemini)
- 自定义模型

## 🚀 快速开始

### 安装

1. 克隆或下载项目
```bash
cd page-explainer-extension
npm install
```

2. 构建扩展
```bash
npm run build
```

3. 加载扩展
   - 打开 Chrome 浏览器
   - 访问 `chrome://extensions/`
   - 开启右上角的"开发者模式"
   - 点击"加载已解压的扩展程序"
   - 选择项目的 `dist` 目录

### 配置

1. 点击扩展图标打开设置面板
2. 选择你想使用的 AI 模型
3. 输入对应的 API Key
4. 保存配置

### 使用

1. **讲解页面**: 点击"讲解当前页面"按钮，AI 会分析并讲解页面内容
2. **提问**: 在输入框输入问题，或使用语音输入
3. **自动翻页**: 点击"自动翻页"按钮，自动浏览长页面
4. **画线标注**: AI 会在讲解时自动标注重要元素

## 📁 项目结构

```
page-explainer-extension/
├── manifest.json          # 扩展配置文件
├── package.json           # 项目依赖
├── README.md              # 说明文档
├── background/
│   └── background.js      # 后台服务脚本
├── content/
│   ├── content.js         # 内容脚本
│   └── content.css        # 内容脚本样式
├── popup/
│   ├── popup.html         # 弹出页面
│   ├── popup.css          # 弹出页面样式
│   └── popup.js           # 弹出页面脚本
├── src/
│   └── core/
│       ├── llm-provider.js       # LLM 服务提供者
│       ├── agent.js              # AI Agent 核心
│       ├── voice-service.js      # 语音服务
│       ├── annotation-service.js # 标注服务
│       └── auto-scroll-service.js # 自动滚动服务
├── icons/
│   └── icon.svg           # 扩展图标
└── scripts/
    └── build.js           # 构建脚本
```

## 🔧 开发

### 开发模式
```bash
npm run dev
```
这会启动监视模式，文件变化时自动重新构建。

### 打包
```bash
npm run pack
```
这会将扩展打包为 zip 文件，可以上传到 Chrome Web Store。

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

## 📄 许可证

MIT License

## 🙏 致谢

- 设计理念参考自 [Midscene.js](https://midscenejs.com/)
- 感谢所有开源项目的贡献者

## ⚠️ 注意事项

1. 使用前请确保已配置正确的 API Key
2. 语音功能需要浏览器支持 Web Speech API
3. 某些页面可能因为安全限制无法使用（如 chrome:// 页面）
4. API 调用会产生费用，请注意用量
