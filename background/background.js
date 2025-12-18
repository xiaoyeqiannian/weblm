/**
 * Background Service Worker
 * 处理扩展的后台逻辑
 */

// ============== LLM Provider 内联代码 ==============

// 模型配置类型
const MODEL_TYPES = {
  OPENAI: 'openai',
  CLAUDE: 'claude',
  QWEN: 'qwen',
  DOUBAO: 'doubao',
  GEMINI: 'gemini',
  CUSTOM: 'custom'
};

// 默认模型配置
const DEFAULT_CONFIGS = {
  [MODEL_TYPES.OPENAI]: {
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    maxTokens: 4096
  },
  [MODEL_TYPES.CLAUDE]: {
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-3-5-sonnet-20241022',
    maxTokens: 4096
  },
  [MODEL_TYPES.QWEN]: {
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-vl-max-latest',
    maxTokens: 4096
  },
  [MODEL_TYPES.DOUBAO]: {
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: '', // 需要填写火山引擎的推理接入点 ID，格式如 ep-20241211xxxxx
    maxTokens: 4096
  },
  [MODEL_TYPES.GEMINI]: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    model: 'gemini-2.5-pro-preview-05-06',
    maxTokens: 4096
  }
};

class LLMProvider {
  constructor() {
    this.config = null;
    this.modelType = null;

    // Per-request UI meta (e.g., warning/status text). Consumed by message handlers.
    this._lastChatMeta = null;

    // Feature flags cache
    this._featureCache = { enableScreenshot: null, ts: 0 };
  }

  consumeLastChatMeta() {
    const meta = this._lastChatMeta;
    this._lastChatMeta = null;
    return meta;
  }

  async init() {
    try {
      const stored = await chrome.storage.local.get(['llmConfig', 'modelType']);
      this.modelType = stored.modelType || MODEL_TYPES.OPENAI;
      this.config = stored.llmConfig || DEFAULT_CONFIGS[this.modelType];
      console.log('[LLMProvider] 初始化完成:', { modelType: this.modelType, hasApiKey: !!this.config?.apiKey });
    } catch (error) {
      console.error('[LLMProvider] 初始化失败:', error);
      this.modelType = MODEL_TYPES.OPENAI;
      this.config = DEFAULT_CONFIGS[MODEL_TYPES.OPENAI];
    }
    return this;
  }

  async setConfig(modelType, config) {
    console.log('[LLMProvider] 设置配置:', { modelType, hasApiKey: !!config?.apiKey });
    this.modelType = modelType;
    this.config = { ...DEFAULT_CONFIGS[modelType], ...config };
    await chrome.storage.local.set({
      modelType: this.modelType,
      llmConfig: this.config
    });
    console.log('[LLMProvider] 配置已保存');
  }

  getConfig() {
    return {
      modelType: this.modelType,
      config: this.config
    };
  }

  async chat(messages, options = {}) {
    if (!this.config || !this.config.apiKey) {
      throw new Error('请先配置 API Key');
    }

    console.log('[LLMProvider] 发送聊天请求:', { 
      modelType: this.modelType, 
      model: this.config.model,
      baseUrl: this.config.baseUrl,
      messageCount: messages.length 
    });

    const { stream = false, onChunk = null } = options;

    // reset per-request meta
    this._lastChatMeta = null;

    // Feature: enable/disable screenshot (image input)
    const _getEnableScreenshot = async () => {
      const now = Date.now();
      if (this._featureCache.enableScreenshot !== null && now - this._featureCache.ts < 1500) {
        return this._featureCache.enableScreenshot;
      }
      try {
        const res = await chrome.storage.local.get(['enableScreenshot']);
        const enabled = res.enableScreenshot;
        this._featureCache.enableScreenshot = enabled === undefined ? true : !!enabled;
        this._featureCache.ts = now;
        return this._featureCache.enableScreenshot;
      } catch (e) {
        this._featureCache.enableScreenshot = true;
        this._featureCache.ts = now;
        return true;
      }
    };

    // Helper: check multi-modal (image) content
    const _hasImageInMessages = (msgs) => {
      return msgs.some(msg => {
        if (!msg || !msg.content) return false;
        if (typeof msg.content !== 'string') {
          if (Array.isArray(msg.content)) {
            return msg.content.some(item => item && item.type === 'image_url');
          }
          if (msg.content.image_url) return true;
        }
        return false;
      });
    };

    const _extractErrorMessage = (text) => {
      const raw = String(text || '');
      try {
        const parsed = JSON.parse(raw);
        const msg = parsed?.error?.message || parsed?.message || parsed?.error || '';
        return String(msg || raw);
      } catch (e) {
        return raw;
      }
    };

    // Helper: remove image items from messages, join text parts
    const _stripImagesFromMessages = (msgs) => {
      return msgs.map(msg => {
        if (!msg || !msg.content) return msg;
        if (typeof msg.content === 'string') return msg;

        if (Array.isArray(msg.content)) {
          // keep text parts, remove images
          const textParts = msg.content.filter(item => item.type === 'text').map(item => item.text);
          const combined = textParts.join('\n');
          return { role: msg.role, content: combined };
        }

        if (msg.content.image_url) {
          // replace with a note
          return {
            role: msg.role,
            content: `（截图已省略） ${msg.content.text || ''}`
          };
        }
        return msg;
      });
    };

    // 若关闭截图输入，则在发请求前去掉所有图片（避免每次触发“多模态不支持”重试）
    const enableScreenshot = await _getEnableScreenshot();
    if (!enableScreenshot && _hasImageInMessages(messages)) {
      messages = _stripImagesFromMessages(messages);
      this._lastChatMeta = {
        statusText: 'ℹ️ 已关闭截图输入，本次仅使用页面文字进行分析。'
      };
    }

    // Claude 需要特殊处理
    if (this.modelType === MODEL_TYPES.CLAUDE) {
      return this._chatClaude(messages, options);
    }

    // OpenAI 兼容接口
    const requestBody = {
      model: this.config.model,
      messages: messages,
      max_tokens: this.config.maxTokens,
      stream: stream
    };

    console.log('[LLMProvider] 请求地址:', `${this.config.baseUrl}/chat/completions`);

    try {
      const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`
        },
        body: JSON.stringify(requestBody)
      });

      console.log('[LLMProvider] 响应状态:', response.status);

      if (!response.ok) {
        const errorText = await response.text();
        const hasImages = _hasImageInMessages(messages);
        const errMsg = _extractErrorMessage(errorText);

        // 有些 OpenAI 兼容服务会在 400/422/500 等状态下返回“收到多模态消息”之类错误
        // 只要检测到“图片/多模态不支持”，就自动去图重试一次
        const maybeImageUnsupported = /multi-?modal|multi modal|received\s+multi-?modal|does\s+not\s+support\s+image|not\s+support\s+image|unsupported\s+image|vision\s+is\s+not\s+enabled|image\s+input\s+not\s+supported/i.test(errMsg);

        if (hasImages && maybeImageUnsupported && response.status !== 401) {
          // 该错误可恢复：不要用 console.error（会被扩展错误页记录），用 warn 即可
          console.warn('[LLMProvider] 模型不支持图片输入，自动省略截图并重试:', errMsg);
          const strippedMsgs = _stripImagesFromMessages(messages);
          const strippedBody = { ...requestBody, messages: strippedMsgs };

          const retryResponse = await fetch(`${this.config.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${this.config.apiKey}`
            },
            body: JSON.stringify(strippedBody)
          });

          if (!retryResponse.ok) {
            const retryError = await retryResponse.text();
            const retryMsg = _extractErrorMessage(retryError);
            console.error('[LLMProvider] 重试（无图片）失败:', retryMsg);
            throw new Error(`API 请求失败 (${retryResponse.status}): ${retryMsg}`);
          }

          const retryData = await retryResponse.json();
          const content = retryData.choices[0].message.content;
          this._lastChatMeta = {
            statusText: '⚠️ 注意：当前模型不支持图片输入，已自动省略截图后返回结果。'
          };
          return content;
        }

        // 不可恢复错误：记录为 error 并抛出
        console.error('[LLMProvider] API 错误:', errMsg);
        throw new Error(`API 请求失败 (${response.status}): ${errMsg}`);
      }

      if (stream && onChunk) {
        return this._handleStream(response, onChunk);
      }

      const data = await response.json();
      console.log('[LLMProvider] 响应成功');
      return data.choices[0].message.content;
    } catch (error) {
      console.error('[LLMProvider] 请求失败:', error);
      throw error;
    }
  }

  async _chatClaude(messages, options = {}) {
    const { stream = false, onChunk = null } = options;

    const claudeMessages = messages.map(msg => {
      if (typeof msg.content === 'string') {
        return {
          role: msg.role === 'system' ? 'user' : msg.role,
          content: msg.content
        };
      }
      return {
        role: msg.role === 'system' ? 'user' : msg.role,
        content: msg.content.map(item => {
          if (item.type === 'text') return item;
          if (item.type === 'image_url') {
            return {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: item.image_url.url.replace(/^data:image\/\w+;base64,/, '')
              }
            };
          }
          return item;
        })
      };
    });

    const response = await fetch(`${this.config.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.config.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: this.config.model,
        max_tokens: this.config.maxTokens,
        messages: claudeMessages,
        stream: stream
      })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Claude API 请求失败: ${error}`);
    }

    if (stream && onChunk) {
      return this._handleClaudeStream(response, onChunk);
    }

    const data = await response.json();
    return data.content[0].text;
  }

  async _handleStream(response, onChunk) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullContent = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const lines = chunk.split('\n').filter(line => line.startsWith('data: '));

      for (const line of lines) {
        const data = line.slice(6);
        if (data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices[0]?.delta?.content || '';
          fullContent += content;
          onChunk(content, fullContent);
        } catch (e) {}
      }
    }
    return fullContent;
  }

  async _handleClaudeStream(response, onChunk) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullContent = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const lines = chunk.split('\n').filter(line => line.startsWith('data: '));

      for (const line of lines) {
        try {
          const data = JSON.parse(line.slice(6));
          if (data.type === 'content_block_delta') {
            const content = data.delta?.text || '';
            fullContent += content;
            onChunk(content, fullContent);
          }
        } catch (e) {}
      }
    }
    return fullContent;
  }

  async analyzePageContent(screenshot, pageText, question) {
    const hasScreenshot = typeof screenshot === 'string' && screenshot.trim().length > 0;
    const messages = [
      {
        role: 'system',
        content: `你是一个专业的网页内容讲解助手。你的任务是：
1. 分析用户当前浏览的网页内容
2. 用清晰、易懂的语言讲解页面的主要内容
3. 如果用户有具体问题，针对性地回答
4. 可以指出页面中的重要元素位置，使用描述性语言（如"页面顶部"、"左侧菜单"等）
5. 保持友好、专业的语气`
      },
      {
        role: 'user',
        content: hasScreenshot
          ? [
              { type: 'image_url', image_url: { url: screenshot } },
              { type: 'text', text: `页面文本内容：\n${pageText}\n\n用户问题：${question || '请帮我讲解这个页面的主要内容'}` }
            ]
          : [
              { type: 'text', text: `页面文本内容：\n${pageText}\n\n用户问题：${question || '请帮我讲解这个页面的主要内容'}` }
            ]
      }
    ];

    return this.chat(messages);
  }

  async locateElements(screenshot, pageText, description) {
    const hasScreenshot = typeof screenshot === 'string' && screenshot.trim().length > 0;
    if (!hasScreenshot) {
      throw new Error('截图输入已关闭，无法进行元素定位');
    }
    const messages = [
      {
        role: 'system',
        content: `你是一个精确的UI元素定位助手。根据用户的描述，在截图中找到对应的元素，并返回JSON格式的位置信息。
返回格式：
{
  "elements": [
    {
      "description": "元素描述",
      "selector": "CSS选择器（如果能推断）",
      "approximate_position": {
        "x_percent": 0-100,
        "y_percent": 0-100,
        "width_percent": 0-100,
        "height_percent": 0-100
      }
    }
  ]
}
只返回JSON，不要其他文字。`
      },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: screenshot } },
          { type: 'text', text: `页面文本：${pageText}\n\n请找到：${description}` }
        ]
      }
    ];

    const response = await this.chat(messages);
    try {
      return JSON.parse(response);
    } catch (e) {
      const match = response.match(/\{[\s\S]*\}/);
      if (match) return JSON.parse(match[0]);
      throw new Error('无法解析元素位置');
    }
  }
}

// ============== Background 主逻辑 ==============

let llmProvider = null;
// 追踪每个窗口的 Side Panel 打开状态
const sidePanelStateByWindow = {};

async function init() {
  console.log('[Background] 开始初始化...');
  llmProvider = new LLMProvider();
  await llmProvider.init();
  console.log('[Background] 初始化完成');
}

init();

// 监听消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[Background] 收到消息:', message.type);
  handleMessage(message, sender)
    .then(response => {
      console.log('[Background] 发送响应:', message.type, response.success);
      sendResponse(response);
    })
    .catch(error => {
      console.error('[Background] 处理消息错误:', error);
      sendResponse({ success: false, error: error.message });
    });
  return true;
});

async function handleMessage(message, sender) {
  const { type, data } = message;

  // 避免 background 自己转发消息时被自身再次处理
  if (message && message._relay === true) {
    return { success: true, relayed: true };
  }

  switch (type) {
    case 'CAPTURE_VIEWPORT':
      return captureViewport(sender.tab?.id);
    
    case 'GET_LLM_CONFIG':
      console.log('[Background] 获取配置');
      return {
        success: true,
        config: llmProvider.getConfig()
      };
    
    case 'RESET_AGENT':
      console.log('[Background] 重置 Agent/会话');
      try {
        await llmProvider.init();
        return { success: true };
      } catch (error) {
        console.error('[Background] 重置失败:', error);
        return { success: false, error: error.message };
      }
    
    case 'SET_LLM_CONFIG':
      console.log('[Background] 设置配置:', data.modelType);
      try {
        await llmProvider.setConfig(data.modelType, data.config);
        return { success: true };
      } catch (error) {
        console.error('[Background] 设置配置失败:', error);
        return { success: false, error: error.message };
      }
    
    case 'CHAT':
      try {
        const response = await llmProvider.chat(data.messages, { stream: false });
        const meta = llmProvider.consumeLastChatMeta();
        return { success: true, response, statusText: meta?.statusText || '' };
      } catch (error) {
        return { success: false, error: error.message };
      }
    
    case 'ANALYZE_PAGE':
      try {
        console.log('[Background] 开始分析页面');
        const response = await llmProvider.analyzePageContent(
          data.screenshot,
          data.pageText,
          data.question
        );
        const meta = llmProvider.consumeLastChatMeta();
        return { success: true, response, statusText: meta?.statusText || '' };
      } catch (error) {
        console.error('[Background] 分析页面失败:', error);
        return { success: false, error: error.message };
      }

    case 'SIDE_PANEL_ASK':
      try {
        const question = (data?.question || data?.text || message?.question || '').toString();
        const payload = { question, ts: Date.now() };

        // 尽量用 session storage（Side Panel 打开时可读取）
        try {
          await chrome.storage.session.set({ pendingSidePanelAsk: payload });
        } catch (e) {
          await chrome.storage.local.set({ pendingSidePanelAsk: payload });
        }

        // 如果 sidepanel 已打开，直接转发给 sidepanel（extension page）
        try {
          chrome.runtime.sendMessage({ type: 'SIDE_PANEL_ASK', data: payload, _relay: true });
        } catch (e) {}

        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    
    case 'LOCATE_ELEMENTS':
      try {
        const result = await llmProvider.locateElements(
          data.screenshot,
          data.pageText,
          data.description
        );
        return { success: true, result };
      } catch (error) {
        return { success: false, error: error.message };
      }
    
    case 'OPEN_SIDE_PANEL':
      try {
        // 从 sender 获取标签页信息或从 data 中读取 windowId
        const tabId = sender.tab?.id;
        const windowId = data?.windowId || sender.tab?.windowId;
        
        if (!windowId) {
          throw new Error('无法获取窗口信息');
        }
        
        // 使用 windowId 打开 Side Panel
        await chrome.sidePanel.open({ windowId: windowId });

        // 记录状态并通知该窗口内的所有标签页 Side Panel 已打开
        sidePanelStateByWindow[windowId] = true;
        try {
          const tabs = await chrome.tabs.query({ windowId: windowId });
          console.log('[Background] OPEN_SIDE_PANEL 通知 tabs in window:', windowId, tabs.map(t => t.id));
          // 先通过消息通知
          tabs.forEach(t => {
            chrome.tabs.sendMessage(t.id, { type: 'SIDE_PANEL_STATE_CHANGED', isOpen: true }).catch((err) => {
              console.warn('[Background] 通知标签页失败:', t.id, err?.message || err);
            });
          });
          // 后备方案：如果内容脚本未注册消息监听，直接注入并修改 DOM
          for (const t of tabs) {
            try {
              await chrome.scripting.executeScript({
                target: { tabId: t.id },
                func: (isOpen) => {
                  try {
                    const btn = document.getElementById('pe-floating-btn');
                    if (!btn) return;
                    btn.style.display = isOpen ? 'none' : 'flex';
                  } catch (e) {}
                },
                args: [true]
              });
            } catch (err) {
              // 忽略注入失败（例如 chrome:// 页面）
            }
          }
        } catch (e) {
          console.warn('[Background] 查询标签页或通知失败:', e);
        }
        
        return { success: true };
      } catch (error) {
        // 如果是由于缺少用户手势导致的错误，记录为警告并返回特定错误
        if (error && /may only be called in response to a user gesture/i.test(error.message)) {
          console.warn('[Background] sidePanel.open() 需要用户手势，无法在此上下文打开侧边栏');
          return { success: false, error: 'needs_user_gesture' };
        }
        console.error('[Background] 打开 Side Panel 失败:', error);
        return { success: false, error: error.message };
      }

    case 'SIDE_PANEL_OPENED':
      try {
        const windowId = data?.windowId || sender?.tab?.windowId;
        if (windowId) {
          sidePanelStateByWindow[windowId] = true;
          const tabs = await chrome.tabs.query({ windowId: windowId });
          tabs.forEach(t => {
            chrome.tabs.sendMessage(t.id, { type: 'SIDE_PANEL_STATE_CHANGED', isOpen: true }).catch(() => {});
          });
        }
        return { success: true };
      } catch (err) {
        console.warn('[Background] 处理 SIDE_PANEL_OPENED 失败:', err);
        return { success: false, error: err?.message };
      }
    
    case 'CHECK_SIDE_PANEL_STATE':
      try {
        // Chrome 没有直接 API 查询 Side Panel 状态
        // 我们返回由 background 维护的状态（如果存在）
        const windowId = sender?.tab?.windowId;
        const isOpen = windowId ? !!sidePanelStateByWindow[windowId] : false;
        return { success: true, isOpen };
      } catch (error) {
        return { success: false, isOpen: false };
      }

    case 'CLOSE_SIDE_PANEL':
      try {
        // windowId may be from sender.tab or message data
        const windowId = data?.windowId || sender?.tab?.windowId;
        if (windowId) {
          sidePanelStateByWindow[windowId] = false;
          const tabs = await chrome.tabs.query({ windowId: windowId });
          console.log('[Background] CLOSE_SIDE_PANEL 通知 tabs in window:', windowId, tabs.map(t => t.id));
          tabs.forEach(t => {
            chrome.tabs.sendMessage(t.id, { type: 'SIDE_PANEL_STATE_CHANGED', isOpen: false }).catch((err) => {
              console.warn('[Background] 通知标签页失败:', t.id, err?.message || err);
            });
          });
          // 后备方案：直接注入脚本显示按钮
          for (const t of tabs) {
            try {
              await chrome.scripting.executeScript({
                target: { tabId: t.id },
                func: (isOpen) => {
                  try {
                    const btn = document.getElementById('pe-floating-btn');
                    if (!btn) return;
                    btn.style.display = isOpen ? 'none' : 'flex';
                  } catch (e) {}
                },
                args: [false]
              });
            } catch (err) {
              // 忽略注入失败
            }
          }
        }
        return { success: true };
      } catch (error) {
        console.error('[Background] 关闭 Side Panel 处理失败:', error);
        return { success: false, error: error.message };
      }
    
    default:
      return { success: false, error: '未知的消息类型' };
  }
}

async function captureViewport(tabId) {
  try {
    const screenshot = await chrome.tabs.captureVisibleTab(null, {
      format: 'png',
      quality: 90
    });
    return { success: true, screenshot };
  } catch (error) {
    console.error('[Background] 截图失败:', error);
    return { success: false, error: error.message };
  }
}

// 监听扩展安装
chrome.runtime.onInstalled.addListener((details) => {
  console.log('[Background] 扩展已安装/更新:', details.reason);
  
  if (details.reason === 'install') {
    chrome.tabs.create({ url: 'popup/popup.html#settings' });
  }
  
  // 创建右键菜单（需要先检查 API 是否可用）
  if (chrome.contextMenus) {
    chrome.contextMenus.create({
      id: 'explain-selection',
      title: '讲解选中内容',
      contexts: ['selection']
    });

    chrome.contextMenus.create({
      id: 'explain-page',
      title: '讲解当前页面',
      contexts: ['page']
    });
  }
});

// 处理右键菜单（需要先检查 API 是否可用）
if (chrome.contextMenus) {
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === 'explain-selection') {
      chrome.tabs.sendMessage(tab.id, {
        type: 'EXPLAIN_SELECTION',
        text: info.selectionText
      });
    } else if (info.menuItemId === 'explain-page') {
      chrome.tabs.sendMessage(tab.id, { type: 'EXPLAIN_PAGE' });
    }
  });
}

console.log('[Background] Service Worker 已加载');
