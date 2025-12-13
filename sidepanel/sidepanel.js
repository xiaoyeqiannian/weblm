/**
 * Side Panel Script
 * 处理侧边栏的交互逻辑
 */

// 模型配置
const MODEL_CONFIGS = {
  openai: {
    name: 'OpenAI (GPT-4o)',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o'
  },
  claude: {
    name: 'Anthropic (Claude)',
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-3-5-sonnet-20241022'
  },
  qwen: {
    name: '阿里云 (千问VL)',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-vl-max-latest'
  },
  doubao: {
    name: '火山引擎 (豆包)',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: ''
  },
  gemini: {
    name: 'Google (Gemini)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    model: 'gemini-2.5-pro-preview-05-06'
  }
};

// 全局变量
let currentTab = null;
let inputHistory = [];
let historyIndex = -1;
let tempInput = '';
let isAutoScrolling = false;
let isVoiceRecording = false;

// DOM 元素
let elements = {};

// 初始化
document.addEventListener('DOMContentLoaded', async () => {
  // 获取当前标签页
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab;

  // 通知 background: Side Panel 已打开，并在关闭/隐藏时通知（与语音功能解耦）
  initSidePanelLifecycle();

  // 缓存 DOM 元素
  elements = {
    // 主视图
    mainView: document.getElementById('sp-main-view'),
    settingsView: document.getElementById('sp-settings-view'),
    
    // 头部按钮

// (注意) sidepanel 的关闭通知将在页面卸载时发送（在 DOMContentLoaded 后绑定）
    settingsBtn: document.getElementById('sp-settings-btn'),
    newConvBtn: document.getElementById('sp-new-conv-btn'),
    backBtn: document.getElementById('sp-back-btn'),
    
    // 消息
    messages: document.getElementById('sp-messages'),
    input: document.getElementById('sp-input'),
    sendBtn: document.getElementById('sp-send-btn'),
    
    // 操作按钮
    // explainBtn & scrollBtn removed from UI
    inputVoiceBtn: document.getElementById('sp-input-voice-btn'),
    
    // 语音指示器
    voiceIndicator: document.getElementById('sp-voice-indicator'),
    
    // 设置表单
    modelType: document.getElementById('sp-model-type'),
    apiKey: document.getElementById('sp-api-key'),
    baseUrl: document.getElementById('sp-base-url'),
    modelName: document.getElementById('sp-model-name'),
    baseUrlGroup: document.getElementById('sp-base-url-group'),
    modelNameGroup: document.getElementById('sp-model-name-group'),
    toggleApiKey: document.getElementById('sp-toggle-api-key'),
    saveSettings: document.getElementById('sp-save-settings'),
    saveStatus: document.getElementById('sp-save-status'),
    
    // 语音设置
    voiceSelect: document.getElementById('sp-voice-select'),
    voiceRate: document.getElementById('sp-voice-rate'),
    rateValue: document.getElementById('sp-rate-value'),
    autoSpeak: document.getElementById('sp-auto-speak')
  };

  // 绑定事件
  bindEvents();
  
  // 加载配置
  await loadConfig();
  
  // 加载语音列表
  await loadVoices();

  // 接收来自 content/background 的外部消息（例如右键菜单触发的提问）
  initExternalMessageHandlers();
  await consumePendingAsk();
});

function initExternalMessageHandlers() {
  chrome.runtime.onMessage.addListener((message) => {
    if (!message || !message.type) return;

    if (message.type === 'SIDE_PANEL_ASK') {
      const question = message.data?.question || message.data?.text || message.question || '';
      if (question) {
        handleIncomingAsk(question);
      }
    }

    if (message.type === 'VOICE_RESULT') {
      const text = message.text || message.data?.text || '';
      if (text) {
        handleVoiceResult(text);
      }
    }
  });
}

async function consumePendingAsk() {
  let pending = null;
  try {
    const res = await chrome.storage.session.get(['pendingSidePanelAsk']);
    pending = res?.pendingSidePanelAsk || null;
    if (pending) {
      await chrome.storage.session.remove(['pendingSidePanelAsk']);
    }
  } catch (e) {
    try {
      const res = await chrome.storage.local.get(['pendingSidePanelAsk']);
      pending = res?.pendingSidePanelAsk || null;
      if (pending) {
        await chrome.storage.local.remove(['pendingSidePanelAsk']);
      }
    } catch (err) {}
  }

  const question = pending?.question || '';
  if (question) {
    handleIncomingAsk(question);
  }
}

function handleIncomingAsk(question) {
  try {
    showMainView();
    elements.input.value = '';
    addMessage(question, 'user');
    askQuestion(question);
  } catch (e) {
    console.warn('处理外部提问失败:', e);
  }
}

function handleVoiceResult(text) {
  // 收到语音结果后，默认当作最终输入并发送
  try {
    elements.input.value = '';
    addMessage(text, 'user');
    askQuestion(text);

    // 结束录音态 UI
    elements.voiceIndicator.style.display = 'none';
    if (elements.inputVoiceBtn) elements.inputVoiceBtn.textContent = '🎤';
    isVoiceRecording = false;
  } catch (e) {
    console.warn('处理语音结果失败:', e);
  }
}

function initSidePanelLifecycle() {
  // 已打开通知：尽早发一次，确保 background 能广播状态、content 能隐藏悬浮按钮
  (async () => {
    try {
      const currentWindow = await chrome.windows.getCurrent();
      chrome.runtime.sendMessage({ type: 'SIDE_PANEL_OPENED', data: { windowId: currentWindow.id } });
    } catch (e) {
      try {
        chrome.runtime.sendMessage({ type: 'SIDE_PANEL_OPENED' });
      } catch (err) {}
    }
  })();

  const notifyClosed = async () => {
    try {
      const cw = await chrome.windows.getCurrent();
      chrome.runtime.sendMessage({ type: 'CLOSE_SIDE_PANEL', data: { windowId: cw.id } });
    } catch (e) {
      try {
        chrome.runtime.sendMessage({ type: 'CLOSE_SIDE_PANEL' });
      } catch (err) {}
    }
  };

  // 关闭/卸载：不要 await，尽量在生命周期末尾也能发出消息
  window.addEventListener('beforeunload', () => {
    notifyClosed();
  });

  // 当侧边栏变为不可见时（用户关闭或切换）也发送关闭通知
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      notifyClosed();
    }
  });

  // pagehide 备用事件
  window.addEventListener('pagehide', () => {
    notifyClosed();
  });
}

// 绑定事件
function bindEvents() {
  // 视图切换
  elements.settingsBtn.addEventListener('click', () => showSettings());
  elements.backBtn.addEventListener('click', () => showMainView());
  
  // 新建对话
  elements.newConvBtn.addEventListener('click', () => newConversation());
  
  // 发送消息
  elements.sendBtn.addEventListener('click', () => sendMessage());
  elements.input.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendMessage();
  });
  
  // 输入历史
  elements.input.addEventListener('keydown', handleInputHistory);
  
  // 操作按钮
  // explain & scroll removed from UI
  if (elements.inputVoiceBtn) elements.inputVoiceBtn.addEventListener('click', () => toggleVoiceInput());
  
  // 设置
  elements.modelType.addEventListener('change', handleModelTypeChange);
  elements.toggleApiKey.addEventListener('click', toggleApiKeyVisibility);
  elements.saveSettings.addEventListener('click', saveConfig);
  
  // 语速
  elements.voiceRate.addEventListener('input', (e) => {
    elements.rateValue.textContent = e.target.value;
  });
}

// 显示设置
function showSettings() {
  elements.mainView.style.display = 'none';
  elements.settingsView.style.display = 'block';
}

// 显示主视图
function showMainView() {
  elements.settingsView.style.display = 'none';
  elements.mainView.style.display = 'flex';
}

// 新建对话
async function newConversation() {
  // 清空消息
  elements.messages.innerHTML = `
    <div class="sp-message sp-message-assistant">
      <div class="sp-message-content">
        你好！我是 WebLM。我可以帮你理解当前页面的内容，回答你的问题，还能用语音和你交流。
      </div>
    </div>
  `;
  
  // 清空输入历史
  inputHistory = [];
  historyIndex = -1;
  tempInput = '';
  
  // 重置 Agent
  try {
    await chrome.runtime.sendMessage({ type: 'RESET_AGENT' });
  } catch (error) {
    console.error('重置对话失败:', error);
  }
}

// 发送消息
async function sendMessage() {
  const text = elements.input.value.trim();
  if (!text) return;
  
  // 保存到历史
  if (!inputHistory.length || inputHistory[0] !== text) {
    inputHistory.unshift(text);
    if (inputHistory.length > 10) inputHistory.pop();
  }
  historyIndex = -1;
  tempInput = '';
  
  elements.input.value = '';
  addMessage(text, 'user');
  
  await askQuestion(text);
}

// 处理输入历史
function handleInputHistory(e) {
  if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
  
  if (e.key === 'ArrowUp') {
    if (inputHistory.length === 0) return;
    if (historyIndex === -1) tempInput = elements.input.value;
    historyIndex = Math.min(inputHistory.length - 1, historyIndex + 1);
    elements.input.value = inputHistory[historyIndex] || '';
    e.preventDefault();
  } else if (e.key === 'ArrowDown') {
    if (inputHistory.length === 0) return;
    if (historyIndex === -1) return;
    historyIndex = historyIndex - 1;
    if (historyIndex === -1) {
      elements.input.value = tempInput;
    } else {
      elements.input.value = inputHistory[historyIndex] || '';
    }
    e.preventDefault();
  }
}

// 添加消息
function addMessage(content, type) {
  const messageDiv = document.createElement('div');
  messageDiv.className = `sp-message sp-message-${type}`;
  messageDiv.innerHTML = `<div class="sp-message-content">${escapeHtml(content)}</div>`;
  elements.messages.appendChild(messageDiv);
  elements.messages.scrollTop = elements.messages.scrollHeight;
  return messageDiv;
}

// 更新消息
function updateMessage(messageDiv, content) {
  const contentDiv = messageDiv.querySelector('.sp-message-content');
  if (contentDiv) {
    contentDiv.innerHTML = formatMarkdown(content);
  }
}

// 讲解页面
async function explainPage() {
  elements.explainBtn.disabled = true;
  elements.explainBtn.innerHTML = '<span class="icon">🔄</span><span>分析中...</span>';
  
  const loadingMessage = addMessage('正在分析页面...', 'assistant');
  
  try {
    // 发送消息到 content script
    await sendToContentScript('EXPLAIN_PAGE');
    
    // 等待并获取响应
    const response = await getPageAnalysis();
    
    if (response && response.success) {
      updateMessage(loadingMessage, response.response);
    } else {
      updateMessage(loadingMessage, '分析失败: ' + (response?.error || '未知错误'));
    }
  } catch (error) {
    console.error('讲解页面失败:', error);
    updateMessage(loadingMessage, '讲解失败: ' + error.message);
  } finally {
    elements.explainBtn.disabled = false;
    elements.explainBtn.innerHTML = '<span class="icon">📖</span><span>讲解页面</span>';
  }
}

// 获取页面分析
async function getPageAnalysis() {
  try {
    // 获取截图
    const screenshotResponse = await chrome.runtime.sendMessage({ type: 'CAPTURE_VIEWPORT' });
    if (!screenshotResponse.success) {
      throw new Error('截图失败');
    }
    
    // 获取页面文本
    const textResponse = await sendToContentScript('GET_PAGE_TEXT');
    const pageText = textResponse || '';
    
    // 发送分析请求
    const response = await chrome.runtime.sendMessage({
      type: 'ANALYZE_PAGE',
      data: {
        screenshot: screenshotResponse.screenshot,
        pageText: pageText,
        question: '请讲解这个页面的主要内容'
      }
    });
    
    return response;
  } catch (error) {
    console.error('获取页面分析失败:', error);
    return { success: false, error: error.message };
  }
}

// 提问
async function askQuestion(question) {
  const loadingMessage = addMessage('正在思考...', 'assistant');
  
  try {
    // 获取截图
    const screenshotResponse = await chrome.runtime.sendMessage({ type: 'CAPTURE_VIEWPORT' });
    if (!screenshotResponse.success) {
      throw new Error('截图失败');
    }
    
    // 获取页面文本
    const textResponse = await sendToContentScript('GET_PAGE_TEXT');
    const pageText = textResponse || '';
    
    // 发送分析请求
    const response = await chrome.runtime.sendMessage({
      type: 'ANALYZE_PAGE',
      data: {
        screenshot: screenshotResponse.screenshot,
        pageText: pageText,
        question: question
      }
    });
    
    if (response && response.success) {
      updateMessage(loadingMessage, response.response);

      // 让 content script 解析并执行标注高亮
      try {
        await sendToContentScript('HANDLE_ANNOTATIONS', { text: response.response });
      } catch (e) {}
    } else {
      updateMessage(loadingMessage, '回答失败: ' + (response?.error || '未知错误'));
    }
  } catch (error) {
    console.error('提问失败:', error);
    updateMessage(loadingMessage, '提问失败: ' + error.message);
  }
}

// 切换自动翻页
async function toggleAutoScroll() {
  if (isAutoScrolling) {
    await sendToContentScript('STOP_AUTO_SCROLL');
    elements.scrollBtn.innerHTML = '<span class="icon">📜</span><span>自动翻页</span>';
    isAutoScrolling = false;
  } else {
    await sendToContentScript('START_AUTO_SCROLL');
    elements.scrollBtn.innerHTML = '<span class="icon">⏹️</span><span>停止滚动</span>';
    isAutoScrolling = true;
  }
}

// 切换语音输入
async function toggleVoiceInput() {
  if (isVoiceRecording) {
    await sendToContentScript('STOP_VOICE');
    elements.voiceIndicator.style.display = 'none';
    if (elements.inputVoiceBtn) elements.inputVoiceBtn.textContent = '🎤';
    isVoiceRecording = false;
  } else {
    await sendToContentScript('START_VOICE');
    elements.voiceIndicator.style.display = 'flex';
    if (elements.inputVoiceBtn) elements.inputVoiceBtn.textContent = '🔴';
    isVoiceRecording = true;
  }
}

// 发送消息到 content script
async function sendToContentScript(type, data = {}) {
  if (!currentTab || !currentTab.id) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTab = tab;
  }
  
  if (!currentTab) {
    throw new Error('无法获取当前标签页');
  }
  
  try {
    const response = await chrome.tabs.sendMessage(currentTab.id, { type, data });
    return response;
  } catch (error) {
    console.error('发送消息到 content script 失败:', error);
    throw error;
  }
}

// 处理模型类型变化
function handleModelTypeChange() {
  const modelType = elements.modelType.value;
  const isCustom = modelType === 'custom';
  const isDoubao = modelType === 'doubao';
  
  const showModelInput = isCustom || isDoubao;
  
  elements.baseUrlGroup.style.display = isCustom ? 'block' : 'none';
  elements.modelNameGroup.style.display = showModelInput ? 'block' : 'none';
  
  const hintEl = document.getElementById('sp-model-hint');
  if (hintEl) {
    if (isDoubao) {
      hintEl.textContent = '💡 请填写火山引擎的推理接入点 ID，格式如: ep-20241211xxxxx';
      hintEl.style.display = 'block';
      elements.modelName.placeholder = '推理接入点 ID (ep-xxx)';
    } else if (isCustom) {
      hintEl.textContent = '';
      hintEl.style.display = 'none';
      elements.modelName.placeholder = '例如: gpt-4o';
    } else {
      hintEl.style.display = 'none';
    }
  }
  
  if (!isCustom && !isDoubao && MODEL_CONFIGS[modelType]) {
    elements.baseUrl.value = MODEL_CONFIGS[modelType].baseUrl;
    elements.modelName.value = MODEL_CONFIGS[modelType].model;
  } else if (isDoubao) {
    elements.baseUrl.value = MODEL_CONFIGS[modelType].baseUrl;
    elements.modelName.value = '';
  }
}

// 切换 API Key 可见性
function toggleApiKeyVisibility() {
  const input = elements.apiKey;
  input.type = input.type === 'password' ? 'text' : 'password';
  elements.toggleApiKey.textContent = input.type === 'password' ? '👁️' : '🙈';
}

// 加载配置
async function loadConfig() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_LLM_CONFIG' });
    
    if (response.success && response.config) {
      const { modelType, config } = response.config;
      
      if (modelType) {
        elements.modelType.value = modelType;
        handleModelTypeChange();
      }
      
      if (config) {
        if (config.apiKey) {
          elements.apiKey.value = config.apiKey;
        }
        if (config.baseUrl) {
          elements.baseUrl.value = config.baseUrl;
        }
        if (config.model) {
          elements.modelName.value = config.model;
        }
      }
    }
    
    // 加载语音设置
    const voiceSettings = await chrome.storage.local.get(['voiceRate', 'autoSpeak', 'selectedVoice']);
    if (voiceSettings.voiceRate) {
      elements.voiceRate.value = voiceSettings.voiceRate;
      elements.rateValue.textContent = voiceSettings.voiceRate;
    }
    if (voiceSettings.autoSpeak !== undefined) {
      elements.autoSpeak.checked = voiceSettings.autoSpeak;
    }
    if (voiceSettings.selectedVoice) {
      elements.voiceSelect.value = voiceSettings.selectedVoice;
    }
  } catch (error) {
    console.error('加载配置失败:', error);
  }
}

// 保存配置
async function saveConfig() {
  const modelType = elements.modelType.value;
  const apiKey = elements.apiKey.value.trim();
  
  if (!apiKey) {
    showSaveStatus('请输入 API Key', true);
    return;
  }
  
  const config = {
    apiKey: apiKey,
    baseUrl: elements.baseUrl.value.trim() || MODEL_CONFIGS[modelType]?.baseUrl,
    model: elements.modelName.value.trim() || MODEL_CONFIGS[modelType]?.model,
    maxTokens: 4096
  };
  
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'SET_LLM_CONFIG',
      data: { modelType, config }
    });
    
    if (response && response.success) {
      showSaveStatus('✅ 配置已保存');
      
      // 保存语音设置
      await chrome.storage.local.set({
        voiceRate: elements.voiceRate.value,
        autoSpeak: elements.autoSpeak.checked,
        selectedVoice: elements.voiceSelect.value
      });
    } else {
      showSaveStatus('保存失败: ' + (response?.error || '未知错误'), true);
    }
  } catch (error) {
    console.error('保存配置失败:', error);
    showSaveStatus('保存失败: ' + error.message, true);
  }
}

// 显示保存状态
function showSaveStatus(message, isError = false) {
  elements.saveStatus.textContent = message;
  elements.saveStatus.className = 'sp-save-status' + (isError ? ' error' : '');
  
  setTimeout(() => {
    elements.saveStatus.textContent = '';
  }, 3000);
}

// 加载语音列表
async function loadVoices() {
  if (!window.speechSynthesis) {
    return;
  }
  
  const loadVoiceList = () => {
    const voices = speechSynthesis.getVoices();
    const chineseVoices = voices.filter(v => v.lang.startsWith('zh'));
    
    elements.voiceSelect.innerHTML = '<option value="">默认语音</option>';
    
    const voicesToShow = chineseVoices.length > 0 ? chineseVoices : voices;
    voicesToShow.forEach(voice => {
      const option = document.createElement('option');
      option.value = voice.name;
      option.textContent = `${voice.name} (${voice.lang})`;
      elements.voiceSelect.appendChild(option);
    });
  };
  
  if (speechSynthesis.getVoices().length > 0) {
    loadVoiceList();
  } else {
    speechSynthesis.onvoiceschanged = loadVoiceList;
  }
}

// 工具函数：转义 HTML
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// 工具函数：格式化 Markdown（简单实现）
function formatMarkdown(text) {
  // 转义 HTML
  text = escapeHtml(text);
  
  // 代码块
  text = text.replace(/```(\w+)?\n([\s\S]+?)```/g, '<pre><code>$2</code></pre>');
  
  // 行内代码
  text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
  
  // 粗体
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  
  // 斜体
  text = text.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  
  // 换行
  text = text.replace(/\n/g, '<br>');
  
  return text;
}
