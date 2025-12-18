/**
 * Side Panel Script
 * 处理侧边栏的交互逻辑
 */

// 全局变量
let currentTab = null;
let inputHistory = [];
let historyIndex = -1;
let tempInput = '';
let isAutoScrolling = false;
let isVoiceRecording = false;

let screenshotEnabledCache = null;
let screenshotEnabledCacheTs = 0;

async function isScreenshotEnabled() {
  const now = Date.now();
  if (screenshotEnabledCache !== null && now - screenshotEnabledCacheTs < 1500) {
    return screenshotEnabledCache;
  }
  try {
    const res = await chrome.storage.local.get(['enableScreenshot']);
    const enabled = res.enableScreenshot;
    screenshotEnabledCache = enabled === undefined ? true : !!enabled;
    screenshotEnabledCacheTs = now;
    return screenshotEnabledCache;
  } catch (e) {
    screenshotEnabledCache = true;
    screenshotEnabledCacheTs = now;
    return true;
  }
}

function setVoiceIndicatorVisible(visible) {
  if (!elements.voiceIndicator) return;
  elements.voiceIndicator.classList.toggle('is-visible', !!visible);
  elements.voiceIndicator.setAttribute('aria-hidden', visible ? 'false' : 'true');

  if (elements.inputContainer) {
    elements.inputContainer.classList.toggle('is-voice', !!visible);
  }
}

// 朗读/解读状态
let ttsState = 'idle'; // idle | loading | playing | paused
let currentExplainMessageDiv = null;

// 边看边讲模式（滚动 + 画线 + 讲解）
let lectureActive = false;
let lectureSteps = [];
let lectureIndex = 0;
let lectureRunToken = 0;

// 当前正在等待结束的 TTS promise（用于 cancel 时解阻塞）
let ttsAwaitResolve = null;

// DOM 元素
let elements = {};

// 输入态（输入中 => 显示发送按钮）
let isComposing = false;
let isInputFocused = false;

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
    
    // 头部按钮

// (注意) sidepanel 的关闭通知将在页面卸载时发送（在 DOMContentLoaded 后绑定）
    newConvBtn: document.getElementById('sp-new-conv-btn'),
    
    // 消息
    messages: document.getElementById('sp-messages'),
    input: document.getElementById('sp-input'),
    inputContainer: document.getElementById('sp-input-container'),
    playBtn: document.getElementById('sp-play-btn'),
    playIconUse: document.getElementById('sp-play-icon-use'),
    
    // 操作按钮
    // explainBtn & scrollBtn removed from UI
    inputVoiceBtn: document.getElementById('sp-input-voice-btn'),
    rightActionIconUse: document.getElementById('sp-right-action-icon-use'),
    
    // 语音指示器
    voiceIndicator: document.getElementById('sp-voice-indicator'),
    voiceCancelBtn: document.getElementById('sp-voice-cancel-btn'),
    voiceDoneBtn: document.getElementById('sp-voice-done-btn'),
    voiceIndicatorText: document.getElementById('sp-voice-indicator-text'),
  };

  // 确保初始隐藏
  setVoiceIndicatorVisible(false);

  // 绑定事件
  bindEvents();

  // 初始化输入态 UI
  updateComposeUI();

  // 初始化播放按钮 UI
  setPlayButtonUI(ttsState);

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
    setVoiceIndicatorVisible(false);
    if (elements.inputVoiceBtn) elements.inputVoiceBtn.classList.remove('sp-recording');
    isVoiceRecording = false;

    // 恢复输入态 UI
    updateComposeUI();
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
  // 新建对话
  elements.newConvBtn.addEventListener('click', () => newConversation());
  
  // 右侧圆形按钮：解读网页并播报（播放/暂停/继续）
  if (elements.playBtn) elements.playBtn.addEventListener('click', () => toggleExplainSpeak());

  // 发送消息（键盘 Enter）
  elements.input.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendMessage();
  });

  // 输入态切换（点击输入框开始输入时 => 发送态）
  elements.input.addEventListener('input', updateComposeUI);
  elements.input.addEventListener('focus', () => {
    isInputFocused = true;
    updateComposeUI();
  });
  elements.input.addEventListener('blur', () => {
    isInputFocused = false;
    // 离开输入框且没有内容时恢复默认态
    if (!elements.input.value.trim()) {
      isComposing = false;
      applyComposeUI();
    } else {
      updateComposeUI();
    }
  });
  
  // 输入历史
  elements.input.addEventListener('keydown', handleInputHistory);
  
  // 操作按钮
  // explain & scroll removed from UI
  if (elements.inputVoiceBtn) {
    elements.inputVoiceBtn.addEventListener('click', async () => {
      if (isComposing) {
        await sendMessage();
      } else {
        await toggleVoiceInput();
      }
    });
  }

  // 顶部“正在听取”提示：取消/完成
  if (elements.voiceCancelBtn) {
    elements.voiceCancelBtn.addEventListener('click', async () => {
      if (isVoiceRecording) await toggleVoiceInput();
    });
  }
  if (elements.voiceDoneBtn) {
    elements.voiceDoneBtn.addEventListener('click', async () => {
      if (isVoiceRecording) await toggleVoiceInput();
    });
  }
}

function setRightActionIcon(href) {
  const useEl = elements.rightActionIconUse;
  if (!useEl) return;
  useEl.setAttribute('href', href);
  try {
    useEl.setAttributeNS('http://www.w3.org/1999/xlink', 'href', href);
  } catch (e) {}
}

function applyComposeUI() {
  if (!elements.inputContainer) return;
  elements.inputContainer.classList.toggle('is-composing', isComposing);

  if (!elements.inputVoiceBtn) return;
  if (isComposing) {
    setRightActionIcon('#hi-paper-airplane');
    elements.inputVoiceBtn.title = '发送';
    elements.inputVoiceBtn.setAttribute('aria-label', '发送');
  } else {
    setRightActionIcon('#hi-microphone');
    elements.inputVoiceBtn.title = '语音输入';
    elements.inputVoiceBtn.setAttribute('aria-label', '语音输入');
  }
}

function updateComposeUI() {
  const hasText = !!elements.input?.value?.trim();
  const next = isInputFocused || hasText;
  if (next === isComposing) {
    // 仍需要保证初始 render 正确
    applyComposeUI();
    return;
  }
  isComposing = next;
  applyComposeUI();
}

function setPlayButtonUI(state) {
  if (!elements.playBtn) return;

  const setUseHref = (useEl, href) => {
    if (!useEl) return;
    useEl.setAttribute('href', href);
    try {
      useEl.setAttributeNS('http://www.w3.org/1999/xlink', 'href', href);
    } catch (e) {}
  };

  if (state === 'playing' || state === 'loading') {
    setUseHref(elements.playIconUse, '#hi-pause');
    elements.playBtn.title = '暂停';
    elements.playBtn.setAttribute('aria-label', '暂停');
    elements.playBtn.setAttribute('aria-pressed', 'true');
  } else {
    setUseHref(elements.playIconUse, '#hi-play');
    elements.playBtn.title = '播放';
    elements.playBtn.setAttribute('aria-label', '播放');
    elements.playBtn.setAttribute('aria-pressed', 'false');
  }

  if (state === 'loading') {
    elements.playBtn.setAttribute('aria-busy', 'true');
  } else {
    elements.playBtn.removeAttribute('aria-busy');
  }
}

function stopExplainSpeak() {
  if (ttsAvailable()) {
    try {
      window.speechSynthesis.cancel();
    } catch (e) {}
  }

  // 如果外部正在 await 播放结束，cancel 后主动解阻塞
  try {
    if (typeof ttsAwaitResolve === 'function') ttsAwaitResolve();
  } catch (e) {}
  ttsAwaitResolve = null;

  // 同时停止边看边讲模式
  lectureRunToken++;
  lectureActive = false;
  lectureSteps = [];
  lectureIndex = 0;
  try {
    sendToContentScript('LECTURE_CLEAR');
  } catch (e) {}

  ttsState = 'idle';
  setPlayButtonUI(ttsState);
}

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

async function getTtsOptions() {
  try {
    const res = await chrome.storage.local.get(['voiceRate', 'selectedVoice']);
    const rate = Number(res.voiceRate);
    return {
      rate: Number.isFinite(rate) && rate > 0 ? rate : 1.0,
      selectedVoice: typeof res.selectedVoice === 'string' ? res.selectedVoice : ''
    };
  } catch (e) {
    return { rate: 1.0, selectedVoice: '' };
  }
}

function chunkTextForTts(text, maxLen = 180) {
  const normalized = String(text || '').trim();
  if (!normalized) return [];

  const parts = [];
  const sentences = normalized
    .replace(/\s+/g, ' ')
    .split(/(?<=[。！？；.!?])\s*/g)
    .filter(Boolean);

  let buffer = '';
  for (const s of sentences) {
    if ((buffer + s).length <= maxLen) {
      buffer += s;
      continue;
    }

    if (buffer) parts.push(buffer);
    if (s.length <= maxLen) {
      buffer = s;
    } else {
      // 超长句子硬切
      for (let i = 0; i < s.length; i += maxLen) {
        parts.push(s.slice(i, i + maxLen));
      }
      buffer = '';
    }
  }
  if (buffer) parts.push(buffer);
  return parts;
}

async function speakText(text, { keepPaused = false } = {}) {
  if (!ttsAvailable()) {
    throw new Error('当前环境不支持语音播报');
  }

  const synthesis = window.speechSynthesis;
  const options = await getTtsOptions();
  const voices = await getVoicesSafe();
  const selected = options.selectedVoice
    ? voices.find(v => v.name === options.selectedVoice)
    : null;

  const chunks = chunkTextForTts(text);
  if (!chunks.length) return;

  // 清空队列，避免与历史播放残留重叠
  try {
    synthesis.cancel();
  } catch (e) {}

  // 严格顺序逐段播放：每段等到 onend 才进入下一段
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk) continue;

    await new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(chunk);
      u.lang = 'zh-CN';
      u.rate = options.rate;
      if (selected) u.voice = selected;

      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (ttsAwaitResolve === resolve) ttsAwaitResolve = null;
        resolve();
      };

      u.onend = finish;
      u.onerror = finish;
      u.onstart = () => {
        if (keepPaused) {
          // 避免在 onstart 前调用 pause 无效
          setTimeout(() => {
            try {
              synthesis.pause();
            } catch (e) {}
          }, 0);
        }
      };

      ttsAwaitResolve = finish;
      try {
        synthesis.speak(u);
      } catch (e) {
        finish();
      }
    });
  }
}

function pauseTts() {
  if (!ttsAvailable()) return;
  try {
    window.speechSynthesis.pause();
  } catch (e) {}
}

function resumeTts() {
  if (!ttsAvailable()) return;
  try {
    window.speechSynthesis.resume();
  } catch (e) {}
}

function parseJsonFromModelText(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  // 可能被 ```json 包裹
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw;

  try {
    return JSON.parse(candidate);
  } catch (e) {
    // 尝试截取首尾 JSON 数组
    const start = candidate.indexOf('[');
    const end = candidate.lastIndexOf(']');
    if (start !== -1 && end !== -1 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }
  }
  return null;
}

async function analyzePageForLectureSteps() {
  let screenshot = '';
  if (await isScreenshotEnabled()) {
    const screenshotResponse = await chrome.runtime.sendMessage({ type: 'CAPTURE_VIEWPORT' });
    if (!screenshotResponse.success) throw new Error('截图失败');
    screenshot = screenshotResponse.screenshot;
  }

  const textResponse = await sendToContentScript('GET_PAGE_TEXT');
  const pageText = textResponse || '';

  const question =
    '你是一个懂网页内容的讲解伙伴，语气自然，像在和朋友分享交流。\n' +
    '目标是边看边讲：讲到哪就引导滚动到哪，并用画线指一下对应内容。\n' +
    '请输出严格 JSON 数组，不要输出任何额外文字。\n' +
    '数组元素格式：{ "description": "页面中可见的一小段原文(8-30字，尽量逐字引用，用于定位)", "scrollPercent": 0-100之间的数字(该段内容在整页大致位置，用于滚动兜底), "say": "对应讲解(<=120字)" }。\n' +
    '请给出 8-12 步，按页面从上到下顺序排列。';

  const response = await chrome.runtime.sendMessage({
    type: 'ANALYZE_PAGE',
    data: {
      screenshot,
      pageText,
      question
    }
  });

  return response;
}

async function runLectureMode(steps, token) {
  lectureActive = true;
  lectureSteps = steps;
  lectureIndex = 0;

  currentExplainMessageDiv = addMessage('我们开始边看边讲…', 'assistant');

  for (let i = 0; i < lectureSteps.length; i++) {
    if (token !== lectureRunToken) return;
    lectureIndex = i;

    const step = lectureSteps[i] || {};
    const say = String(step.say || '').trim();
    if (!say) continue;

    // 让内容脚本滚动并下划线
    try {
      await sendToContentScript('LECTURE_PREPARE_STEP', { step });
    } catch (e) {
      // 忽略，至少继续播报
    }

    // 更新 sidepanel 消息内容
    try {
      const prev = (currentExplainMessageDiv?.__lectureText || '').toString();
      const next = prev ? prev + '\n\n' + say : say;
      currentExplainMessageDiv.__lectureText = next;
      updateMessage(currentExplainMessageDiv, next);
    } catch (e) {}

    if (!ttsAvailable()) continue;

    // 如果用户在进行中点了暂停，等待恢复（speakText 内会保持 pause）
    const shouldKeepPaused = ttsState === 'paused';
    if (!shouldKeepPaused) {
      ttsState = 'playing';
      setPlayButtonUI(ttsState);
    }

    await speakText(say, { keepPaused: shouldKeepPaused });

    // 该段讲解完成后，清除页面画线（不重置定位锚点）
    try {
      await sendToContentScript('LECTURE_CLEAR_MARKS');
    } catch (e) {}

    if (token !== lectureRunToken) return;
    if (window.speechSynthesis && window.speechSynthesis.paused) {
      ttsState = 'paused';
      setPlayButtonUI(ttsState);
    }
  }

  // 结束
  lectureActive = false;
  lectureSteps = [];
  lectureIndex = 0;
  ttsState = 'idle';
  setPlayButtonUI(ttsState);
  try {
    await sendToContentScript('LECTURE_CLEAR');
  } catch (e) {}
}

async function toggleExplainSpeak() {
  // 若在播报中：点击=暂停
  if (ttsState === 'playing') {
    pauseTts();
    ttsState = 'paused';
    setPlayButtonUI(ttsState);
    return;
  }

  // 若已暂停：点击=继续
  if (ttsState === 'paused') {
    resumeTts();
    ttsState = 'playing';
    setPlayButtonUI(ttsState);
    return;
  }

  // 若正在加载：点击=进入暂停态（结果回来后不自动播，等恢复）
  if (ttsState === 'loading') {
    pauseTts();
    ttsState = 'paused';
    setPlayButtonUI(ttsState);
    return;
  }

  // idle：开始解读并播报
  ttsState = 'loading';
  setPlayButtonUI(ttsState);

  // 边看边讲模式：先让模型输出 steps（JSON），再逐步滚动+画线+播报
  const myToken = ++lectureRunToken;
  lectureActive = true;

  currentExplainMessageDiv = addMessage('正在生成讲解步骤...', 'assistant');
  try {
    const response = await analyzePageForLectureSteps();
    if (!response || !response.success) {
      updateMessage(currentExplainMessageDiv, '生成讲解步骤失败: ' + (response?.error || '未知错误'));
      lectureActive = false;
      ttsState = 'idle';
      setPlayButtonUI(ttsState);
      return;
    }

    const parsed = parseJsonFromModelText(response.response);
    const steps = Array.isArray(parsed) ? parsed : null;
    const cleaned = (steps || [])
      .map(s => ({
        description: String(s?.description || '').trim(),
        say: String(s?.say || '').trim(),
        scrollPercent: typeof s?.scrollPercent === 'number' ? s.scrollPercent : null
      }))
      .filter(s => s.say);

    if (!cleaned.length) {
      updateMessage(currentExplainMessageDiv, '生成讲解步骤失败：模型未返回可解析的 JSON steps');
      lectureActive = false;
      ttsState = 'idle';
      setPlayButtonUI(ttsState);
      return;
    }

    // 没有语音能力时不要自动执行 steps（否则会快速滚动导致“乱翻”）
    if (!ttsAvailable()) {
      updateMessage(currentExplainMessageDiv, '当前环境不支持语音播报，无法进入边看边讲模式（仅生成了讲解步骤）。');
      lectureActive = false;
      ttsState = 'idle';
      setPlayButtonUI(ttsState);
      try {
        await sendToContentScript('LECTURE_CLEAR');
      } catch (e) {}
      return;
    }

    // 用第一步开场覆盖占位消息
    updateMessage(currentExplainMessageDiv, '我们开始边看边讲…');
    if (response.statusText) setMessageStatus(currentExplainMessageDiv, response.statusText);

    // 若用户在 loading 期间点了暂停，保持 paused；否则进入 playing
    const shouldKeepPaused = ttsState === 'paused';
    if (!shouldKeepPaused) ttsState = 'playing';
    setPlayButtonUI(ttsState);

    await runLectureMode(cleaned, myToken);
  } catch (error) {
    console.error('边看边讲失败:', error);
    updateMessage(currentExplainMessageDiv, '边看边讲失败: ' + error.message);
    lectureActive = false;
    ttsState = 'idle';
    setPlayButtonUI(ttsState);
    try {
      await sendToContentScript('LECTURE_CLEAR');
    } catch (e) {}
  }
}

// 显示主视图
function showMainView() {
  elements.mainView.style.display = 'flex';
}

// 新建对话
async function newConversation() {
  // 停止任何正在进行的播报
  stopExplainSpeak();

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
  isComposing = false;
  applyComposeUI();
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

function setMessageStatus(messageDiv, statusText) {
  if (!messageDiv) return;
  const text = String(statusText || '').trim();
  if (!text) return;

  let statusDiv = messageDiv.querySelector('.sp-message-status');
  if (!statusDiv) {
    statusDiv = document.createElement('div');
    statusDiv.className = 'sp-message-status';
    const contentDiv = messageDiv.querySelector('.sp-message-content');
    if (contentDiv && contentDiv.parentNode === messageDiv) {
      messageDiv.insertBefore(statusDiv, contentDiv);
    } else {
      messageDiv.appendChild(statusDiv);
    }
  }
  statusDiv.textContent = text;
}

// 更新消息
function updateMessage(messageDiv, content) {
  const contentDiv = messageDiv.querySelector('.sp-message-content');
  if (contentDiv) {
    contentDiv.innerHTML = formatMarkdown(content);
  }
}

// 提问
async function askQuestion(question) {
  const loadingMessage = addMessage('正在思考...', 'assistant');
  
  try {
    let screenshot = '';
    if (await isScreenshotEnabled()) {
      const screenshotResponse = await chrome.runtime.sendMessage({ type: 'CAPTURE_VIEWPORT' });
      if (!screenshotResponse.success) {
        throw new Error('截图失败');
      }
      screenshot = screenshotResponse.screenshot;
    }
    
    // 获取页面文本
    const textResponse = await sendToContentScript('GET_PAGE_TEXT');
    const pageText = textResponse || '';
    
    // 发送分析请求
    const response = await chrome.runtime.sendMessage({
      type: 'ANALYZE_PAGE',
      data: {
        screenshot,
        pageText: pageText,
        question: question
      }
    });
    
    if (response && response.success) {
      updateMessage(loadingMessage, response.response);
      if (response.statusText) setMessageStatus(loadingMessage, response.statusText);

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
    setVoiceIndicatorVisible(false);
    if (elements.inputVoiceBtn) elements.inputVoiceBtn.classList.remove('sp-recording');
    isVoiceRecording = false;

    // 恢复输入态 UI
    updateComposeUI();
  } else {
    // 进入录音态：退出输入态（确保不会显示发送态）
    try {
      if (elements.input) elements.input.blur();
    } catch (e) {}
    isInputFocused = false;
    isComposing = false;
    applyComposeUI();

    await sendToContentScript('START_VOICE');
    if (elements.voiceIndicatorText) elements.voiceIndicatorText.textContent = '正在听取';
    setVoiceIndicatorVisible(true);
    if (elements.inputVoiceBtn) elements.inputVoiceBtn.classList.add('sp-recording');
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
