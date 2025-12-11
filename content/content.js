/**
 * Content Script
 * 注入到网页中，处理页面交互
 */

// 全局实例
let annotationService = null;
let autoScrollService = null;
let voiceService = null;
let panelUI = null;
let isInitialized = false;
// 输入历史（最近10条）
let inputHistory = [];
let historyIndex = -1; // -1 表示未浏览
let tempInput = '';

// 初始化
function init() {
  if (isInitialized) return;

  // 初始化服务
  annotationService = new AnnotationService();
  annotationService.init();

  autoScrollService = new AutoScrollService();
  voiceService = new VoiceService();

  // 创建浮动面板
  createPanel();

  // 监听来自 background 的消息
  chrome.runtime.onMessage.addListener(handleMessage);

  // 监听标注事件
  window.addEventListener('page-explainer-annotation', handleAnnotationEvent);

  isInitialized = true;
  console.log('Page Explainer Content Script 已初始化');
}

// 创建浮动面板
function createPanel() {
  // 创建面板容器
  const panel = document.createElement('div');
  panel.id = 'page-explainer-panel';
  panel.innerHTML = `
    <div class="pe-panel-header">
      <span class="pe-panel-title">🤖 WebLM</span>
      <div class="pe-panel-controls">
        <button class="pe-btn pe-btn-icon pe-minimize-btn" title="最小化">−</button>
        <button class="pe-btn pe-btn-icon pe-close-btn" title="关闭">×</button>
      </div>
    </div>
    <div class="pe-panel-body">
      <div class="pe-chat-container">
        <div class="pe-messages" id="pe-messages">
          <div class="pe-message pe-message-assistant">
            <div class="pe-message-content">
              你好！我是 WebLM。我可以帮你理解当前页面的内容，回答你的问题，还能用语音和你交流。点击下方按钮开始吧！
            </div>
          </div>
        </div>
      </div>
      <div class="pe-action-buttons">
        <button class="pe-btn pe-btn-primary" id="pe-explain-btn">📖 讲解页面</button>
        <button class="pe-btn" id="pe-scroll-btn">📜 自动翻页</button>
        <button class="pe-btn" id="pe-voice-btn">🎤 语音输入</button>
        <button class="pe-btn" id="pe-new-conv-btn" title="新建对话">🆕 新建对话</button>
      </div>
      <div class="pe-input-container">
        <input type="text" class="pe-input" id="pe-input" placeholder="输入你的问题..." />
        <button class="pe-btn pe-btn-primary pe-send-btn" id="pe-send-btn">发送</button>
      </div>
      <div class="pe-voice-indicator" id="pe-voice-indicator" style="display: none;">
        <div class="pe-voice-waves">
          <span></span><span></span><span></span><span></span><span></span>
        </div>
        <span>正在听...</span>
      </div>
    </div>
  `;

  document.body.appendChild(panel);
  panelUI = panel;

  // 绑定事件
  bindPanelEvents();

  // 使面板可拖动
  makeDraggable(panel);
}

// 绑定面板事件
function bindPanelEvents() {
  const panel = document.getElementById('page-explainer-panel');
  const messagesContainer = document.getElementById('pe-messages');
  const input = document.getElementById('pe-input');
  const sendBtn = document.getElementById('pe-send-btn');
  const explainBtn = document.getElementById('pe-explain-btn');
  const scrollBtn = document.getElementById('pe-scroll-btn');
  const voiceBtn = document.getElementById('pe-voice-btn');
  const minimizeBtn = panel.querySelector('.pe-minimize-btn');
  const closeBtn = panel.querySelector('.pe-close-btn');
  const voiceIndicator = document.getElementById('pe-voice-indicator');

  // 发送消息
  const sendMessage = async () => {
    const text = input.value.trim();
    if (!text) return;

    // 保存到历史（最新在前），避免重复连续相同
    if (!inputHistory.length || inputHistory[0] !== text) {
      inputHistory.unshift(text);
      if (inputHistory.length > 10) inputHistory.pop();
    }
    historyIndex = -1;
    tempInput = '';

    input.value = '';
    addMessage(text, 'user');
    
    await askQuestion(text);
  };

  sendBtn.addEventListener('click', sendMessage);
  input.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendMessage();
  });
  input.addEventListener('keydown', (e) => {
    // 只有当没有组合按键（如 Ctrl/Cmd）时才处理
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;

    if (e.key === 'ArrowUp') {
      if (inputHistory.length === 0) return;
      if (historyIndex === -1) tempInput = input.value;
      historyIndex = Math.min(inputHistory.length - 1, historyIndex + 1);
      input.value = inputHistory[historyIndex] || '';
      e.preventDefault();
    } else if (e.key === 'ArrowDown') {
      if (inputHistory.length === 0) return;
      if (historyIndex === -1) return;
      historyIndex = historyIndex - 1;
      if (historyIndex === -1) {
        input.value = tempInput;
      } else {
        input.value = inputHistory[historyIndex] || '';
      }
      e.preventDefault();
    }
  });

  // 讲解页面
  explainBtn.addEventListener('click', async () => {
    explainBtn.disabled = true;
    explainBtn.textContent = '🔄 分析中...';
    
    try {
      await explainPage();
    } finally {
      explainBtn.disabled = false;
      explainBtn.textContent = '📖 讲解页面';
    }
  });

  // 自动翻页
  let isAutoScrolling = false;
  scrollBtn.addEventListener('click', () => {
    if (isAutoScrolling) {
      autoScrollService.stopAutoScroll();
      scrollBtn.textContent = '📜 自动翻页';
      isAutoScrolling = false;
    } else {
      autoScrollService.startAutoScroll({
        speed: 'normal',
        onComplete: () => {
          scrollBtn.textContent = '📜 自动翻页';
          isAutoScrolling = false;
          addMessage('已滚动到页面底部', 'assistant');
        }
      });
      scrollBtn.textContent = '⏹️ 停止滚动';
      isAutoScrolling = true;
    }
  });

  // 新建对话
  const newConvBtn = document.getElementById('pe-new-conv-btn');
  newConvBtn.addEventListener('click', async () => {
    const confirmed = confirm('确定要新建对话吗？这将清空当前聊天记录并重置会话。');
    if (!confirmed) return;
    newConversation();
  });

  // 语音输入
  voiceService.onStart = () => {
    voiceBtn.classList.add('pe-active');
    voiceIndicator.style.display = 'flex';
  };

  voiceService.onEnd = () => {
    voiceBtn.classList.remove('pe-active');
    voiceIndicator.style.display = 'none';
  };

  voiceService.onResult = async (result) => {
    if (result.isFinal && result.final) {
      input.value = result.final;
      addMessage(result.final, 'user');
      await askQuestion(result.final);
    } else if (result.interim) {
      input.value = result.interim;
    }
  };

  voiceService.onError = (error) => {
    console.error('语音识别错误:', error);
    addMessage('语音识别失败: ' + error, 'system');
  };

  voiceBtn.addEventListener('click', () => {
    voiceService.toggleListening();
  });

  // 最小化
  minimizeBtn.addEventListener('click', () => {
    panel.classList.toggle('pe-minimized');
    minimizeBtn.textContent = panel.classList.contains('pe-minimized') ? '+' : '−';
  });

  // 关闭
  closeBtn.addEventListener('click', () => {
    panel.style.display = 'none';
    annotationService.clear();
  });
}

// 添加消息到聊天
function addMessage(content, type) {
  const messagesContainer = document.getElementById('pe-messages');
  const messageDiv = document.createElement('div');
  messageDiv.className = `pe-message pe-message-${type}`;
  messageDiv.innerHTML = `<div class="pe-message-content">${escapeHtml(content)}</div>`;
  messagesContainer.appendChild(messageDiv);
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
  return messageDiv;
}

// 更新消息内容
function updateMessage(messageDiv, content) {
  const contentDiv = messageDiv.querySelector('.pe-message-content');
  if (contentDiv) {
    contentDiv.innerHTML = formatMarkdown(content);
  }
}

// 讲解页面
async function explainPage() {
  const loadingMessage = addMessage('正在分析页面...', 'assistant');

  try {
    // 获取截图
    const screenshot = await captureScreenshot();
    
    // 获取页面文本
    const pageText = getPageText();
    
    // 获取页面信息
    const pageInfo = {
      url: window.location.href,
      title: document.title,
      text: pageText,
      screenshot: screenshot,
      ...autoScrollService.getPageInfo()
    };

    // 发送到后台处理
    const response = await chrome.runtime.sendMessage({
      type: 'ANALYZE_PAGE',
      data: {
        screenshot: screenshot,
        pageText: pageText,
        question: '请讲解这个页面的主要内容'
      }
    });

    if (response.success) {
      let text = response.response;
      // 当背景返回提示时（例如重试后移除图片），它会添加一个警告前缀
      const warningPrefix = '⚠️ 注意：';
      if (typeof text === 'string' && text.startsWith(warningPrefix)) {
        const [warningLine, ...rest] = text.split('\n');
        addMessage(warningLine, 'system');
        text = rest.join('\n').trim();
      }

      updateMessage(loadingMessage, text);
      
      // 语音播报
      if (voiceService.synthesis) {
        await voiceService.speak(text, { rate: 1.0 });
      }
    } else {
      updateMessage(loadingMessage, '分析失败: ' + response.error);
    }
  } catch (error) {
    console.error('讲解页面失败:', error);
    updateMessage(loadingMessage, '讲解失败: ' + error.message);
  }
}

// 提问
async function askQuestion(question) {
  const loadingMessage = addMessage('正在思考...', 'assistant');

  try {
    // 获取截图
    const screenshot = await captureScreenshot();
    
    // 获取页面文本
    const pageText = getPageText();

    // 发送到后台处理
    const response = await chrome.runtime.sendMessage({
      type: 'ANALYZE_PAGE',
      data: {
        screenshot: screenshot,
        pageText: pageText,
        question: question
      }
    });

    if (response.success) {
      let text = response.response;
      const warningPrefix = '⚠️ 注意：';
      if (typeof text === 'string' && text.startsWith(warningPrefix)) {
        const [warningLine, ...rest] = text.split('\n');
        addMessage(warningLine, 'system');
        text = rest.join('\n').trim();
      }

      updateMessage(loadingMessage, text);
      
      // 检查是否有标注指令
      await handleAnnotations(text);
      
      // 语音播报
      if (voiceService.synthesis) {
        await voiceService.speak(text, { rate: 1.0 });
      }
    } else {
      updateMessage(loadingMessage, '回答失败: ' + response.error);
    }
  } catch (error) {
    console.error('提问失败:', error);
    updateMessage(loadingMessage, '回答失败: ' + error.message);
  }
}

// 处理标注
async function handleAnnotations(text) {
  const regex = /\[标注[:：]([^\]]+)\]/g;
  let match;
  
  while ((match = regex.exec(text)) !== null) {
    const description = match[1].trim();
    
    try {
      // 尝试通过CSS选择器查找
      let element = findElementByDescription(description);
      
      if (element) {
        annotationService.highlightElement(element, {
          label: description,
          pulse: true
        });
      } else {
        // 使用AI定位
        const screenshot = await captureScreenshot();
        const pageText = getPageText();
        
        const response = await chrome.runtime.sendMessage({
          type: 'LOCATE_ELEMENTS',
          data: {
            screenshot: screenshot,
            pageText: pageText,
            description: description
          }
        });

        if (response.success && response.result.elements) {
          for (const el of response.result.elements) {
            annotationService.highlightByPosition(el.approximate_position, {
              label: el.description,
              pulse: true
            });
          }
        }
      }
    } catch (e) {
      console.error('标注失败:', e);
    }
  }
}

// 通过描述查找元素
function findElementByDescription(description) {
  const lowerDesc = description.toLowerCase();
  
  // 尝试常见的选择器
  const selectors = [
    `[aria-label*="${description}"]`,
    `[title*="${description}"]`,
    `button:contains("${description}")`,
    `a:contains("${description}")`,
    `h1:contains("${description}")`,
    `h2:contains("${description}")`,
    `h3:contains("${description}")`
  ];

  for (const selector of selectors) {
    try {
      const element = document.querySelector(selector);
      if (element) return element;
    } catch (e) {
      // 选择器可能无效
    }
  }

  // 遍历所有文本节点查找
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    null,
    false
  );

  while (walker.nextNode()) {
    if (walker.currentNode.textContent.toLowerCase().includes(lowerDesc)) {
      return walker.currentNode.parentElement;
    }
  }

  return null;
}

// 截取屏幕
async function captureScreenshot() {
  const response = await chrome.runtime.sendMessage({ type: 'CAPTURE_VIEWPORT' });
  if (response.success) {
    return response.screenshot;
  }
  throw new Error(response.error);
}

// 获取页面文本
function getPageText() {
  // 获取可见文本
  const textContent = [];
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode: (node) => {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        
        const style = window.getComputedStyle(parent);
        if (style.display === 'none' || style.visibility === 'hidden') {
          return NodeFilter.FILTER_REJECT;
        }
        
        const text = node.textContent.trim();
        if (text.length > 0) {
          return NodeFilter.FILTER_ACCEPT;
        }
        return NodeFilter.FILTER_REJECT;
      }
    }
  );

  while (walker.nextNode()) {
    textContent.push(walker.currentNode.textContent.trim());
  }

  return textContent.join('\n').substring(0, 5000);
}

// 处理标注事件
function handleAnnotationEvent(event) {
  const { annotations } = event.detail;
  annotations.forEach(desc => {
    handleAnnotations(`[标注:${desc}]`);
  });
}

// 新建对话：清空UI聊天记录并重置历史
async function newConversation() {
  // 清空消息区，但保留系统欢迎语
  const messagesContainer = document.getElementById('pe-messages');
  messagesContainer.innerHTML = '';
  const intro = document.createElement('div');
  intro.className = 'pe-message pe-message-assistant';
  intro.innerHTML = `<div class="pe-message-content">你好！我是 WebLM。我可以帮你理解当前页面的内容，回答你的问题，还能用语音和你交流。点击下方按钮开始吧！</div>`;
  messagesContainer.appendChild(intro);

  // 重置本地历史
  inputHistory = [];
  historyIndex = -1;
  tempInput = '';

  // 通知 background 清理会话/缓存
  try {
    await chrome.runtime.sendMessage({ type: 'RESET_AGENT' });
  } catch (e) {
    console.warn('通知 background 重置会话失败:', e);
  }
}

// 处理来自 background 的消息
function handleMessage(message, sender, sendResponse) {
  const { type, data } = message;

  switch (type) {
    case 'EXPLAIN_SELECTION':
      // 处理选中文本讲解
      askQuestion(`请解释这段内容: ${data || message.text}`);
      break;
    
    case 'EXPLAIN_PAGE':
      explainPage();
      break;
    
    case 'COMMAND':
      handleCommand(message.command);
      break;
    
    case 'SHOW_PANEL':
      showPanel();
      break;
    
    case 'HIDE_PANEL':
      hidePanel();
      break;
  }
}

// 处理快捷键命令
function handleCommand(command) {
  switch (command) {
    case 'toggle-panel':
      togglePanel();
      break;
    case 'start-voice':
      voiceService.startListening();
      break;
    case 'explain-page':
      explainPage();
      break;
  }
}

// 显示面板
function showPanel() {
  const panel = document.getElementById('page-explainer-panel');
  if (panel) {
    panel.style.display = 'flex';
  }
}

// 隐藏面板
function hidePanel() {
  const panel = document.getElementById('page-explainer-panel');
  if (panel) {
    panel.style.display = 'none';
  }
}

// 切换面板
function togglePanel() {
  const panel = document.getElementById('page-explainer-panel');
  if (panel) {
    panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
  }
}

// 使元素可拖动
function makeDraggable(element) {
  const header = element.querySelector('.pe-panel-header');
  let isDragging = false;
  let startX, startY, startLeft, startTop;

  header.addEventListener('mousedown', (e) => {
    if (e.target.closest('button')) return;
    
    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;
    
    const rect = element.getBoundingClientRect();
    startLeft = rect.left;
    startTop = rect.top;
    
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });

  function onMouseMove(e) {
    if (!isDragging) return;
    
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    
    element.style.left = `${startLeft + dx}px`;
    element.style.top = `${startTop + dy}px`;
    element.style.right = 'auto';
    element.style.bottom = 'auto';
  }

  function onMouseUp() {
    isDragging = false;
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  }
}

// 转义 HTML
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// 简单的 Markdown 格式化
function formatMarkdown(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br>')
    .replace(/\[标注[:：]([^\]]+)\]/g, '<span class="pe-annotation-tag">📌 $1</span>');
}

// 启动
init();
