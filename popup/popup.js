/**
 * Popup 脚本
 * 处理扩展弹出页面的交互
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
    model: 'doubao-1.5-thinking-vision-pro'
  },
  gemini: {
    name: 'Google (Gemini)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    model: 'gemini-2.5-pro-preview-05-06'
  }
};

// DOM 元素
let elements = {};

// 初始化
document.addEventListener('DOMContentLoaded', async () => {
  // 缓存 DOM 元素
  elements = {
    // 标签页
    tabBtns: document.querySelectorAll('.tab-btn'),
    tabContents: document.querySelectorAll('.tab-content'),
    
    // 操作按钮
    btnExplain: document.getElementById('btn-explain'),
    btnVoice: document.getElementById('btn-voice'),
    btnAutoScroll: document.getElementById('btn-auto-scroll'),
    btnAnnotate: document.getElementById('btn-annotate'),
    
    // 状态显示
    currentModel: document.getElementById('current-model'),
    voiceStatus: document.getElementById('voice-status'),
    
    // 设置表单
    modelType: document.getElementById('model-type'),
    apiKey: document.getElementById('api-key'),
    baseUrl: document.getElementById('base-url'),
    modelName: document.getElementById('model-name'),
    baseUrlGroup: document.getElementById('base-url-group'),
    modelNameGroup: document.getElementById('model-name-group'),
    toggleApiKey: document.getElementById('toggle-api-key'),
    saveSettings: document.getElementById('save-settings'),
    saveStatus: document.getElementById('save-status'),
    
    // 语音设置
    voiceSelect: document.getElementById('voice-select'),
    voiceRate: document.getElementById('voice-rate'),
    rateValue: document.getElementById('rate-value'),
    autoSpeak: document.getElementById('auto-speak')
  };

  // 绑定事件
  bindEvents();
  
  // 加载配置
  await loadConfig();
  
  // 加载语音列表
  await loadVoices();
  
  // 检查 URL hash
  if (window.location.hash === '#settings') {
    switchTab('settings');
  }
});

// 绑定事件
function bindEvents() {
  // 标签页切换
  elements.tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      switchTab(btn.dataset.tab);
    });
  });

  // 操作按钮
  elements.btnExplain.addEventListener('click', () => sendToContent('EXPLAIN_PAGE'));
  elements.btnVoice.addEventListener('click', () => sendToContent('START_VOICE'));
  elements.btnAutoScroll.addEventListener('click', () => sendToContent('TOGGLE_AUTO_SCROLL'));
  elements.btnAnnotate.addEventListener('click', () => sendToContent('START_ANNOTATE'));

  // 模型类型变化
  elements.modelType.addEventListener('change', handleModelTypeChange);

  // 显示/隐藏 API Key
  elements.toggleApiKey.addEventListener('click', () => {
    const input = elements.apiKey;
    input.type = input.type === 'password' ? 'text' : 'password';
    elements.toggleApiKey.textContent = input.type === 'password' ? '👁️' : '🙈';
  });

  // 保存设置
  elements.saveSettings.addEventListener('click', saveConfig);

  // 语速滑块
  elements.voiceRate.addEventListener('input', (e) => {
    elements.rateValue.textContent = e.target.value;
  });
}

// 切换标签页
function switchTab(tabId) {
  elements.tabBtns.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabId);
  });
  
  elements.tabContents.forEach(content => {
    content.classList.toggle('active', content.id === `tab-${tabId}`);
  });
}

// 处理模型类型变化
function handleModelTypeChange() {
  const modelType = elements.modelType.value;
  const isCustom = modelType === 'custom';
  
  elements.baseUrlGroup.style.display = isCustom ? 'block' : 'none';
  elements.modelNameGroup.style.display = isCustom ? 'block' : 'none';
  
  if (!isCustom && MODEL_CONFIGS[modelType]) {
    elements.baseUrl.value = MODEL_CONFIGS[modelType].baseUrl;
    elements.modelName.value = MODEL_CONFIGS[modelType].model;
  }
}

// 加载配置
async function loadConfig() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_LLM_CONFIG' });
    
    if (response.success && response.config) {
      const { modelType, config } = response.config;
      
      // 设置模型类型
      if (modelType) {
        elements.modelType.value = modelType;
        handleModelTypeChange();
      }
      
      // 设置配置值
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
      
      // 更新状态显示
      updateStatusDisplay(modelType, config);
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
    
  } catch (error) {
    console.error('加载配置失败:', error);
  }
}

// 保存配置
async function saveConfig() {
  const modelType = elements.modelType.value;
  const apiKey = elements.apiKey.value.trim();
  
  console.log('[Popup] 保存配置:', { modelType, hasApiKey: !!apiKey });
  
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
  
  console.log('[Popup] 发送配置:', { modelType, baseUrl: config.baseUrl, model: config.model });
  
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'SET_LLM_CONFIG',
      data: { modelType, config }
    });
    
    console.log('[Popup] 收到响应:', response);
    
    if (response && response.success) {
      showSaveStatus('✅ 配置已保存');
      updateStatusDisplay(modelType, config);
      
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
    console.error('[Popup] 保存配置错误:', error);
    showSaveStatus('保存失败: ' + error.message, true);
  }
}

// 显示保存状态
function showSaveStatus(message, isError = false) {
  elements.saveStatus.textContent = message;
  elements.saveStatus.className = 'save-status' + (isError ? ' error' : '');
  
  setTimeout(() => {
    elements.saveStatus.textContent = '';
  }, 3000);
}

// 更新状态显示
function updateStatusDisplay(modelType, config) {
  if (modelType && MODEL_CONFIGS[modelType]) {
    elements.currentModel.textContent = MODEL_CONFIGS[modelType].name;
  } else if (modelType === 'custom' && config?.model) {
    elements.currentModel.textContent = config.model;
  } else {
    elements.currentModel.textContent = config?.apiKey ? '已配置' : '未配置';
  }
}

// 加载语音列表
async function loadVoices() {
  // 检查语音合成是否可用
  if (!window.speechSynthesis) {
    elements.voiceStatus.textContent = '不可用';
    return;
  }
  
  elements.voiceStatus.textContent = '可用';
  
  // 获取语音列表
  const loadVoiceList = () => {
    const voices = speechSynthesis.getVoices();
    const chineseVoices = voices.filter(v => v.lang.startsWith('zh'));
    
    // 清空并填充选择框
    elements.voiceSelect.innerHTML = '<option value="">默认语音</option>';
    
    chineseVoices.forEach(voice => {
      const option = document.createElement('option');
      option.value = voice.name;
      option.textContent = `${voice.name} (${voice.lang})`;
      elements.voiceSelect.appendChild(option);
    });
    
    // 如果没有中文语音，显示所有语音
    if (chineseVoices.length === 0) {
      voices.forEach(voice => {
        const option = document.createElement('option');
        option.value = voice.name;
        option.textContent = `${voice.name} (${voice.lang})`;
        elements.voiceSelect.appendChild(option);
      });
    }
  };
  
  // 某些浏览器需要等待 voiceschanged 事件
  if (speechSynthesis.getVoices().length > 0) {
    loadVoiceList();
  } else {
    speechSynthesis.onvoiceschanged = loadVoiceList;
  }
}

// 发送消息到 content script
async function sendToContent(type, data = {}) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (!tab) {
      alert('无法获取当前标签页');
      return;
    }
    
    // 检查是否是可以注入脚本的页面
    if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
      alert('无法在此页面使用');
      return;
    }
    
    await chrome.tabs.sendMessage(tab.id, { type, data });
    
    // 关闭 popup
    window.close();
  } catch (error) {
    console.error('发送消息失败:', error);
    alert('请刷新页面后重试');
  }
}
