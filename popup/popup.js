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
    model: '' // 需要填写推理接入点 ID (ep-xxx)
  },
  gemini: {
    name: 'Google (Gemini)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    model: 'gemini-2.5-pro-preview-05-06'
  }
};

// DOM 元素
let elements = {};

let pendingSelectedVoice = '';

const VOICE_PREVIEW_TEXT = '你好呀，让我们一起快乐的学习吧！';

function ttsAvailable() {
  return !!window.speechSynthesis && typeof SpeechSynthesisUtterance !== 'undefined';
}

async function getVoicesSafe() {
  if (!ttsAvailable()) return [];
  const synthesis = window.speechSynthesis;
  let voices = synthesis.getVoices();
  if (voices && voices.length) return voices;

  voices = await new Promise((resolve) => {
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      try {
        resolve(synthesis.getVoices() || []);
      } catch (e) {
        resolve([]);
      }
    };
    synthesis.onvoiceschanged = finish;
    setTimeout(finish, 800);
  });

  return voices;
}

async function playVoicePreview(voiceName) {
  if (!ttsAvailable()) return;

  const synthesis = window.speechSynthesis;
  try {
    synthesis.cancel();
  } catch (e) {}

  const utterance = new SpeechSynthesisUtterance(VOICE_PREVIEW_TEXT);
  utterance.lang = 'zh-CN';
  utterance.rate = Number(elements.voiceRate?.value) || 1.0;

  const voices = await getVoicesSafe();
  const selected = voiceName ? voices.find(v => v.name === voiceName) : null;
  if (selected) utterance.voice = selected;

  try {
    synthesis.speak(utterance);
  } catch (e) {
    console.warn('[Popup] 试听播放失败:', e);
  }
}

function playVoicePreviewSync(voiceName) {
  if (!ttsAvailable()) return;

  const synthesis = window.speechSynthesis;
  try {
    synthesis.cancel();
  } catch (e) {}

  const utterance = new SpeechSynthesisUtterance(VOICE_PREVIEW_TEXT);
  utterance.lang = 'zh-CN';
  utterance.rate = Number(elements.voiceRate?.value) || 1.0;

  // 在用户手势回调内尽量同步选择 voice
  try {
    const voices = synthesis.getVoices() || [];
    const selected = voiceName ? voices.find(v => v.name === voiceName) : null;
    if (selected) utterance.voice = selected;
  } catch (e) {}

  try {
    synthesis.speak(utterance);
  } catch (e) {
    console.warn('[Popup] 试听播放失败:', e);
  }
}

// 初始化
document.addEventListener('DOMContentLoaded', async () => {
  // 缓存 DOM 元素
  elements = {
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
    autoSpeak: document.getElementById('auto-speak'),

    // 截图设置
    enableScreenshot: document.getElementById('enable-screenshot')
  };

  // 绑定事件
  bindEvents();
  
  // 加载配置
  await loadConfig();
  
  // 加载语音列表
  await loadVoices();
});

// 绑定事件
function bindEvents() {
  // 模型类型变化
  if (elements.modelType) elements.modelType.addEventListener('change', handleModelTypeChange);

  // 显示/隐藏 API Key
  if (elements.toggleApiKey) elements.toggleApiKey.addEventListener('click', () => {
    const input = elements.apiKey;
    input.type = input.type === 'password' ? 'text' : 'password';
    elements.toggleApiKey.textContent = input.type === 'password' ? '👁️' : '🙈';
  });

  // 保存设置
  if (elements.saveSettings) elements.saveSettings.addEventListener('click', saveConfig);

  // 语速滑块
  if (elements.voiceRate) elements.voiceRate.addEventListener('input', (e) => {
    elements.rateValue.textContent = e.target.value;
  });

  // 语音选择：保存并自动试听
  if (elements.voiceSelect) {
    elements.voiceSelect.addEventListener('change', () => {
      const voiceName = elements.voiceSelect.value || '';
      pendingSelectedVoice = voiceName;

      // 不要 await：确保在用户手势回调内同步触发 speak
      try {
        chrome.storage.local.set({ selectedVoice: voiceName });
      } catch (e) {}

      playVoicePreviewSync(voiceName);
    });
  }
}

// 处理模型类型变化
function handleModelTypeChange() {
  const modelType = elements.modelType.value;
  const isCustom = modelType === 'custom';
  const isDoubao = modelType === 'doubao';
  
  // 豆包和自定义都需要显示模型名称输入框
  const showModelInput = isCustom || isDoubao;
  
  elements.baseUrlGroup.style.display = isCustom ? 'block' : 'none';
  elements.modelNameGroup.style.display = showModelInput ? 'block' : 'none';
  
  // 显示提示信息
  const hintEl = document.getElementById('model-hint');
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
    elements.modelName.value = ''; // 需要用户填写
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
    }
    
    // 加载语音/截图设置
    const localSettings = await chrome.storage.local.get(['voiceRate', 'autoSpeak', 'selectedVoice', 'enableScreenshot']);
    if (localSettings.voiceRate) {
      elements.voiceRate.value = localSettings.voiceRate;
      elements.rateValue.textContent = localSettings.voiceRate;
    }
    if (localSettings.autoSpeak !== undefined) {
      elements.autoSpeak.checked = localSettings.autoSpeak;
    }
    if (typeof localSettings.selectedVoice === 'string') {
      pendingSelectedVoice = localSettings.selectedVoice;
      if (elements.voiceSelect) {
        elements.voiceSelect.value = pendingSelectedVoice;
      }
    }

    // 截图开关默认开启
    if (elements.enableScreenshot) {
      const enabled = localSettings.enableScreenshot;
      elements.enableScreenshot.checked = enabled === undefined ? true : !!enabled;
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
      
      // 保存语音/截图设置
      await chrome.storage.local.set({
        voiceRate: elements.voiceRate.value,
        autoSpeak: elements.autoSpeak.checked,
        selectedVoice: elements.voiceSelect.value,
        enableScreenshot: elements.enableScreenshot ? !!elements.enableScreenshot.checked : true
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

// 加载语音列表
async function loadVoices() {
  // 检查语音合成是否可用
  if (!window.speechSynthesis || !elements.voiceSelect) {
    return;
  }
  
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

    // 回填已选语音（仅设置 value，不触发试听）
    if (pendingSelectedVoice) {
      elements.voiceSelect.value = pendingSelectedVoice;
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
