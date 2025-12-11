/**
 * 多模型LLM服务提供者
 * 支持 OpenAI, Claude, Qwen, Doubao 等模型
 */

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

  /**
   * 初始化模型配置
   */
  async init() {
    const stored = await chrome.storage.local.get(['llmConfig', 'modelType']);
    this.modelType = stored.modelType || MODEL_TYPES.OPENAI;
    this.config = stored.llmConfig || DEFAULT_CONFIGS[this.modelType];
    return this;
  }

  /**
   * 设置模型类型和配置
   */
  async setConfig(modelType, config) {
    this.modelType = modelType;
    this.config = { ...DEFAULT_CONFIGS[modelType], ...config };
    await chrome.storage.local.set({
      modelType: this.modelType,
      llmConfig: this.config
    });
  }

  /**
   * 获取当前配置
   */
  getConfig() {
    return {
      modelType: this.modelType,
      config: this.config
    };
  }

  /**
   * 发送聊天消息（支持图片）
   */
  async chat(messages, options = {}) {
    if (!this.config || !this.config.apiKey) {
      throw new Error('请先配置 API Key');
    }

    const { stream = false, onChunk = null } = options;

    // 构建请求体
    const requestBody = {
      model: this.config.model,
      messages: messages,
      max_tokens: this.config.maxTokens,
      stream: stream
    };

    // Claude 需要特殊处理
    if (this.modelType === MODEL_TYPES.CLAUDE) {
      return this._chatClaude(messages, options);
    }

    // OpenAI 兼容接口
    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API 请求失败: ${error}`);
    }

    if (stream && onChunk) {
      return this._handleStream(response, onChunk);
    }

    const data = await response.json();
    return data.choices[0].message.content;
  }

  /**
   * Claude API 特殊处理
   */
  async _chatClaude(messages, options = {}) {
    const { stream = false, onChunk = null } = options;

    // 转换消息格式
    const claudeMessages = messages.map(msg => {
      if (typeof msg.content === 'string') {
        return {
          role: msg.role === 'system' ? 'user' : msg.role,
          content: msg.content
        };
      }
      // 处理包含图片的消息
      return {
        role: msg.role === 'system' ? 'user' : msg.role,
        content: msg.content.map(item => {
          if (item.type === 'text') {
            return item;
          }
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

  /**
   * 处理 OpenAI 兼容的流式响应
   */
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
        } catch (e) {
          // 忽略解析错误
        }
      }
    }

    return fullContent;
  }

  /**
   * 处理 Claude 流式响应
   */
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
        } catch (e) {
          // 忽略解析错误
        }
      }
    }

    return fullContent;
  }

  /**
   * 分析页面内容（带截图）
   */
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
            image_url: {
              url: screenshot
            }
          },
          {
            type: 'text',
            text: `页面文本内容：
${pageText}

用户问题：${question || '请帮我讲解这个页面的主要内容'}`
          }
        ]
      }
    ];

    return this.chat(messages, { stream: true, onChunk: (chunk, full) => {
      // 流式回调可以在调用时传入
    }});
  }

  /**
   * 识别页面元素位置（用于画线标注）
   */
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
        "x_percent": 0-100,  // 元素中心X坐标占页面宽度的百分比
        "y_percent": 0-100,  // 元素中心Y坐标占页面高度的百分比
        "width_percent": 0-100,  // 元素宽度占页面宽度的百分比
        "height_percent": 0-100  // 元素高度占页面高度的百分比
      }
    }
  ]
}
只返回JSON，不要其他文字。`
      },
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: {
              url: screenshot
            }
          },
          {
            type: 'text',
            text: `页面文本：${pageText}\n\n请找到：${description}`
          }
        ]
      }
    ];

    const response = await this.chat(messages);
    try {
      return JSON.parse(response);
    } catch (e) {
      // 尝试提取JSON
      const match = response.match(/\{[\s\S]*\}/);
      if (match) {
        return JSON.parse(match[0]);
      }
      throw new Error('无法解析元素位置');
    }
  }
}

// 导出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { LLMProvider, MODEL_TYPES, DEFAULT_CONFIGS };
} else {
  window.LLMProvider = LLMProvider;
  window.MODEL_TYPES = MODEL_TYPES;
  window.DEFAULT_CONFIGS = DEFAULT_CONFIGS;
}
