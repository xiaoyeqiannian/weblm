/**
 * 页面讲解 AI Agent
 * 核心功能模块：页面分析、内容讲解、元素定位
 */

class PageExplainerAgent {
  constructor(llmProvider) {
    this.llm = llmProvider;
    this.conversationHistory = [];
    this.currentPageContext = null;
  }

  static _getExplainSystemPrompt() {
    try {
      if (typeof globalThis !== 'undefined' && globalThis.WEBLM_PROMPTS?.EXPLAIN_SYSTEM_PROMPT) {
        return globalThis.WEBLM_PROMPTS.EXPLAIN_SYSTEM_PROMPT;
      }
    } catch (e) {}

    try {
      if (typeof require === 'function') {
        // eslint-disable-next-line global-require
        const { WEBLM_PROMPTS } = require('../../libs/prompts.js');
        if (WEBLM_PROMPTS?.EXPLAIN_SYSTEM_PROMPT) return WEBLM_PROMPTS.EXPLAIN_SYSTEM_PROMPT;
      }
    } catch (e) {}

    return null;
  }

  /**
   * 初始化页面上下文
   */
  async initPageContext(pageInfo) {
    const explainPrompt = PageExplainerAgent._getExplainSystemPrompt();
    if (!explainPrompt) {
      throw new Error('缺少讲解系统提示词：请确保 libs/prompts.js 可用');
    }
    this.currentPageContext = {
      url: pageInfo.url,
      title: pageInfo.title,
      text: pageInfo.text,
      screenshot: pageInfo.screenshot,
      scrollPosition: pageInfo.scrollPosition,
      totalHeight: pageInfo.totalHeight,
      viewportHeight: pageInfo.viewportHeight
    };
    
    // 添加系统消息到对话历史
    this.conversationHistory = [{
      role: 'system',
      content: `你是一个专业的网页内容讲解助手。当前页面信息：
- URL: ${pageInfo.url}
- 标题: ${pageInfo.title}

${explainPrompt}

元素标注：当且仅当有助于理解时，才用 [标注:描述] 指向页面主体内容中的关键位置；避免标注侧边栏等非主体区域。`
    }];
  }

  /**
   * 更新页面截图和滚动位置
   */
  updatePageState(screenshot, scrollPosition) {
    if (this.currentPageContext) {
      this.currentPageContext.screenshot = screenshot;
      this.currentPageContext.scrollPosition = scrollPosition;
    }
  }

  /**
   * 讲解页面内容
   */
  async explainPage(options = {}) {
    const { stream = true, onChunk = null, onComplete = null } = options;

    if (!this.currentPageContext) {
      throw new Error('请先初始化页面上下文');
    }

    const userMessage = {
      role: 'user',
      content: [
        {
          type: 'image_url',
          image_url: {
            url: this.currentPageContext.screenshot
          }
        },
        {
          type: 'text',
          text: `请讲解当前页面的主要内容。

页面文本内容摘要：
${this._truncateText(this.currentPageContext.text, 2000)}

当前滚动位置：${Math.round(this.currentPageContext.scrollPosition / this.currentPageContext.totalHeight * 100)}%`
        }
      ]
    };

    this.conversationHistory.push(userMessage);

    try {
      let fullResponse = '';
      
      if (stream && onChunk) {
        fullResponse = await this.llm.chat(this.conversationHistory, {
          stream: true,
          onChunk: (chunk, full) => {
            onChunk(chunk, full);
            // 检查是否有标注指令
            this._checkForAnnotations(full);
          }
        });
      } else {
        fullResponse = await this.llm.chat(this.conversationHistory);
      }

      // 添加助手回复到历史
      this.conversationHistory.push({
        role: 'assistant',
        content: fullResponse
      });

      if (onComplete) {
        onComplete(fullResponse);
      }

      return {
        response: fullResponse,
        annotations: this._extractAnnotations(fullResponse),
        suggestScroll: this._shouldSuggestScroll(fullResponse)
      };
    } catch (error) {
      console.error('讲解页面失败:', error);
      throw error;
    }
  }

  /**
   * 回答用户问题
   */
  async askQuestion(question, options = {}) {
    const { stream = true, onChunk = null, onComplete = null } = options;

    if (!this.currentPageContext) {
      throw new Error('请先初始化页面上下文');
    }

    const userMessage = {
      role: 'user',
      content: [
        {
          type: 'image_url',
          image_url: {
            url: this.currentPageContext.screenshot
          }
        },
        {
          type: 'text',
          text: question
        }
      ]
    };

    this.conversationHistory.push(userMessage);

    try {
      let fullResponse = '';
      
      if (stream && onChunk) {
        fullResponse = await this.llm.chat(this.conversationHistory, {
          stream: true,
          onChunk: (chunk, full) => {
            onChunk(chunk, full);
          }
        });
      } else {
        fullResponse = await this.llm.chat(this.conversationHistory);
      }

      // 添加助手回复到历史
      this.conversationHistory.push({
        role: 'assistant',
        content: fullResponse
      });

      if (onComplete) {
        onComplete(fullResponse);
      }

      return {
        response: fullResponse,
        annotations: this._extractAnnotations(fullResponse),
        suggestScroll: this._shouldSuggestScroll(fullResponse)
      };
    } catch (error) {
      console.error('回答问题失败:', error);
      throw error;
    }
  }

  /**
   * 定位页面元素（用于画线标注）
   */
  async locateElement(description) {
    if (!this.currentPageContext) {
      throw new Error('请先初始化页面上下文');
    }

    try {
      const result = await this.llm.locateElements(
        this.currentPageContext.screenshot,
        this._truncateText(this.currentPageContext.text, 1000),
        description
      );
      return result;
    } catch (error) {
      console.error('定位元素失败:', error);
      throw error;
    }
  }

  /**
   * 判断是否需要翻页
   */
  async shouldScrollForMore(context) {
    const { scrollPosition, totalHeight, viewportHeight } = this.currentPageContext;
    const scrollPercent = scrollPosition / totalHeight;
    const hasMoreContent = scrollPosition + viewportHeight < totalHeight;

    if (!hasMoreContent) {
      return { shouldScroll: false, reason: '已经到达页面底部' };
    }

    // 让AI判断是否需要继续翻页查看更多内容
    const messages = [
      {
        role: 'system',
        content: '你是一个判断助手，判断是否需要翻页查看更多内容。只返回JSON格式：{"shouldScroll": true/false, "reason": "原因"}'
      },
      {
        role: 'user',
        content: `当前页面已查看 ${Math.round(scrollPercent * 100)}%，用户询问：${context}。是否需要翻页查看更多内容？`
      }
    ];

    try {
      const response = await this.llm.chat(messages);
      return JSON.parse(response);
    } catch (e) {
      return { shouldScroll: hasMoreContent, reason: '还有更多内容可以查看' };
    }
  }

  /**
   * 清除对话历史
   */
  clearHistory() {
    this.conversationHistory = this.conversationHistory.slice(0, 1); // 保留系统消息
  }

  /**
   * 获取对话历史
   */
  getHistory() {
    return this.conversationHistory.slice(1); // 排除系统消息
  }

  // 私有方法

  _truncateText(text, maxLength) {
    if (!text) return '';
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength) + '...(内容已截断)';
  }

  _extractAnnotations(text) {
    const regex = /\[标注[:：]([^\]]+)\]/g;
    const annotations = [];
    let match;
    
    while ((match = regex.exec(text)) !== null) {
      annotations.push(match[1].trim());
    }
    
    return annotations;
  }

  _checkForAnnotations(text) {
    // 实时检查是否有新的标注指令
    const annotations = this._extractAnnotations(text);
    if (annotations.length > 0) {
      // 触发标注事件
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('page-explainer-annotation', {
          detail: { annotations }
        }));
      }
    }
  }

  _shouldSuggestScroll(response) {
    const scrollKeywords = ['翻页', '向下滚动', '继续查看', '更多内容', '下方', '后面'];
    return scrollKeywords.some(keyword => response.includes(keyword));
  }
}

// 导出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PageExplainerAgent };
} else {
  window.PageExplainerAgent = PageExplainerAgent;
}
