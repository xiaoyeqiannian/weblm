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
    model: 'doubao-1.5-thinking-vision-pro',
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
        console.error('[LLMProvider] API 错误:', errorText);
        throw new Error(`API 请求失败 (${response.status}): ${errorText}`);
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
        content: [
          {
            type: 'image_url',
            image_url: { url: screenshot }
          },
          {
            type: 'text',
            text: `页面文本内容：\n${pageText}\n\n用户问题：${question || '请帮我讲解这个页面的主要内容'}`
          }
        ]
      }
    ];

    return this.chat(messages);
  }

  async locateElements(screenshot, pageText, description) {
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

  switch (type) {
    case 'CAPTURE_VIEWPORT':
      return captureViewport(sender.tab?.id);
    
    case 'GET_LLM_CONFIG':
      console.log('[Background] 获取配置');
      return {
        success: true,
        config: llmProvider.getConfig()
      };
    
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
        return { success: true, response };
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
        return { success: true, response };
      } catch (error) {
        console.error('[Background] 分析页面失败:', error);
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
