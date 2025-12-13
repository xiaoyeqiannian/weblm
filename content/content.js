/**
 * Content Script
 * 注入到网页中，处理页面交互
 */

// 全局实例
let annotationService = null;
let autoScrollService = null;
let voiceService = null;
let isInitialized = false;
let floatingButton = null;

// 初始化
function init() {
  if (isInitialized) return;

  // 初始化服务
  annotationService = new AnnotationService();
  annotationService.init();

  autoScrollService = new AutoScrollService();
  voiceService = new VoiceService();

  // 仅创建悬浮按钮（UI 统一使用 Side Panel）
  createFloatingButton();

  // 监听来自 background 的消息
  chrome.runtime.onMessage.addListener(handleMessage);

  // 监听标注事件
  window.addEventListener('page-explainer-annotation', handleAnnotationEvent);

  // 监听 Side Panel 状态变化
  monitorSidePanelState();

  isInitialized = true;
  console.log('Page Explainer Content Script 已初始化');
}

// 创建悬浮按钮（打开 Side Panel）
function createFloatingButton() {
  // 避免重复创建
  const existing = document.getElementById('pe-floating-btn');
  if (existing) {
    floatingButton = existing;
    return;
  }

  const floating = document.createElement('button');
  floating.id = 'pe-floating-btn';
  floating.setAttribute('aria-label', '打开 WebLM Side Panel');
  floating.innerHTML = '🤖';
  document.body.appendChild(floating);
  floatingButton = floating;

  // 视口变化（例如打开/关闭 DevTools、窗口缩放）时，确保按钮仍在可视区域内
  attachFloatingButtonViewportGuards(floating);

  // 恢复悬浮按钮位置（如果已保存）
  try {
    chrome.storage.local.get(['floatingButtonPosition'], (res) => {
      const pos = res?.floatingButtonPosition;
      if (pos && pos.left !== undefined && pos.top !== undefined) {
        floating.style.left = pos.left + 'px';
        floating.style.top = pos.top + 'px';
        floating.style.right = 'auto';
        floating.style.bottom = 'auto';

        // 还原后立刻回弹一次（避免位置超出视口）
        clampFloatingButtonToViewport(floating, { save: false });
      }
    });
  } catch (e) {}

  // 使悬浮按钮可拖动
  makeFloatingDraggable(floating);
}

function attachFloatingButtonViewportGuards(btn) {
  if (!btn || btn.__peViewportGuardAttached) return;
  btn.__peViewportGuardAttached = true;

  const onViewportChange = () => {
    // 只对“手动拖拽过（使用 left/top）”的按钮回弹；默认 right/bottom 不干预
    clampFloatingButtonToViewport(btn, { save: true });
  };

  window.addEventListener('resize', onViewportChange);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', onViewportChange);
    window.visualViewport.addEventListener('scroll', onViewportChange);
  }
}

function clampFloatingButtonToViewport(btn, { save } = { save: false }) {
  if (!btn) return;

  // 未设置 left/top 的情况使用 right/bottom 固定定位即可（无需处理）
  const hasExplicitLeft = btn.style.left && btn.style.left !== 'auto';
  const hasExplicitTop = btn.style.top && btn.style.top !== 'auto';
  if (!hasExplicitLeft || !hasExplicitTop) return;

  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const rect = btn.getBoundingClientRect();
  const btnW = btn.offsetWidth || rect.width;
  const btnH = btn.offsetHeight || rect.height;

  let left = parseFloat(btn.style.left);
  let top = parseFloat(btn.style.top);
  if (Number.isNaN(left)) left = rect.left;
  if (Number.isNaN(top)) top = rect.top;

  const clampedLeft = Math.max(0, Math.min(vw - btnW, left));
  const clampedTop = Math.max(0, Math.min(vh - btnH, top));

  if (Math.abs(clampedLeft - left) < 0.5 && Math.abs(clampedTop - top) < 0.5) return;

  btn.style.left = clampedLeft + 'px';
  btn.style.top = clampedTop + 'px';
  btn.style.right = 'auto';
  btn.style.bottom = 'auto';

  if (save) {
    try {
      chrome.storage.local.set({ floatingButtonPosition: { left: Math.round(clampedLeft), top: Math.round(clampedTop) } });
    } catch (e) {}
  }
}

// 悬浮按钮拖动实现（使用 pointer events）
function makeFloatingDraggable(btn) {
  if (!btn) return;
  let isDragging = false;
  let startX = 0;
  let startY = 0;
  let origLeft = 0;
  let origTop = 0;
  let pointerId = null;

  btn.addEventListener('pointerdown', (e) => {
    // 只响应主键
    if (e.button !== 0) return;
    e.preventDefault();
    pointerId = e.pointerId;
    btn.setPointerCapture(pointerId);
    startX = e.clientX;
    startY = e.clientY;
    const rect = btn.getBoundingClientRect();
    origLeft = rect.left;
    origTop = rect.top;
    isDragging = false;
    btn.classList.add('pe-dragging');
  });

  btn.addEventListener('pointermove', (e) => {
    if (pointerId !== e.pointerId) return;
    e.preventDefault();
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!isDragging && Math.hypot(dx, dy) < 5) return; // 阈值
    isDragging = true;
    const newLeft = Math.max(0, Math.min(window.innerWidth - btn.offsetWidth, origLeft + dx));
    const newTop = Math.max(0, Math.min(window.innerHeight - btn.offsetHeight, origTop + dy));
    btn.style.left = newLeft + 'px';
    btn.style.top = newTop + 'px';
    btn.style.right = 'auto';
    btn.style.bottom = 'auto';
  });

  btn.addEventListener('pointerup', async (e) => {
    if (pointerId !== e.pointerId) return;
    try { btn.releasePointerCapture(pointerId); } catch (err) {}
    btn.classList.remove('pe-dragging');
    if (isDragging) {
      // 保存位置
      try {
        const left = parseInt(btn.style.left || btn.getBoundingClientRect().left, 10);
        const top = parseInt(btn.style.top || btn.getBoundingClientRect().top, 10);
        chrome.storage.local.set({ floatingButtonPosition: { left, top } });
      } catch (err) {}

      // 拖拽结束后回弹一次，避免贴边后在视口变化时跑出屏幕
      clampFloatingButtonToViewport(btn, { save: true });
    } else {
      // 不是拖动，视为点击（触发打开侧边栏）
      try {
        const response = await chrome.runtime.sendMessage({ type: 'OPEN_SIDE_PANEL', source: 'content_script' });
        // 仅在确认 Side Panel 打开成功后隐藏
        if (response?.success) {
          btn.style.display = 'none';
        }
      } catch (err) {
        // 忽略
      }
    }
    pointerId = null;
  });

  // 如果用户在拖动时取消（pointercancel/leave）也结束拖动
  btn.addEventListener('pointercancel', (e) => {
    try { btn.releasePointerCapture(e.pointerId); } catch (err) {}
    btn.classList.remove('pe-dragging');
    pointerId = null;
  });
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

// 处理来自 background 的消息
function handleMessage(message, sender, sendResponse) {
  const { type, data } = message;

  switch (type) {
    case 'EXPLAIN_SELECTION':
      // 右键菜单触发：统一打开 Side Panel 并把问题交给 Side Panel 展示/执行
      (async () => {
        try {
          await chrome.runtime.sendMessage({ type: 'OPEN_SIDE_PANEL', source: 'content_script' });
        } catch (e) {}

        const selectionText = (data || message.text || '').toString();
        const question = `请解释这段内容: ${selectionText}`;
        try {
          await chrome.runtime.sendMessage({ type: 'SIDE_PANEL_ASK', data: { question } });
        } catch (e) {}
      })();
      break;
    
    case 'EXPLAIN_PAGE':
      (async () => {
        try {
          await chrome.runtime.sendMessage({ type: 'OPEN_SIDE_PANEL', source: 'content_script' });
        } catch (e) {}
        try {
          await chrome.runtime.sendMessage({ type: 'SIDE_PANEL_ASK', data: { question: '请讲解这个页面的主要内容' } });
        } catch (e) {}
      })();
      break;
    
    case 'GET_PAGE_TEXT':
      // 返回页面文本给 Side Panel
      sendResponse(getPageText());
      return true;

    case 'HANDLE_ANNOTATIONS':
      // Side Panel 收到回复后，可让 content script 负责解析并高亮标注
      (async () => {
        try {
          const text = data?.text || data || message.text || '';
          await handleAnnotations(text);
        } catch (e) {}
      })();
      break;
    
    case 'START_AUTO_SCROLL':
      autoScrollService.startAutoScroll({
        speed: 'normal',
        onComplete: () => {
          console.log('自动滚动完成');
        }
      });
      break;
    
    case 'STOP_AUTO_SCROLL':
      autoScrollService.stopAutoScroll();
      break;
    
    case 'START_VOICE':
      if (voiceService) {
        voiceService.startListening((text) => {
          // 将语音识别的文本发送给 Side Panel
          chrome.runtime.sendMessage({
            type: 'VOICE_RESULT',
            text: text
          });
        });
      }
      break;
    
    case 'STOP_VOICE':
      if (voiceService) {
        voiceService.stopListening();
      }
      break;
    
    case 'COMMAND':
      handleCommand(message.command);
      break;
  }
}

// 处理快捷键命令
function handleCommand(command) {
  switch (command) {
    case 'start-voice':
      voiceService.startListening();
      break;
    case 'explain-page':
      try {
        chrome.runtime.sendMessage({ type: 'OPEN_SIDE_PANEL', source: 'content_script' });
        chrome.runtime.sendMessage({ type: 'SIDE_PANEL_ASK', data: { question: '请讲解这个页面的主要内容' } });
      } catch (e) {}
      break;
  }
}

// 监听 Side Panel 状态
function monitorSidePanelState() {
  const floatingBtn = document.getElementById('pe-floating-btn');
  if (!floatingBtn) return;

  // 立即检查 Side Panel 的初始状态
  (async () => {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'CHECK_SIDE_PANEL_STATE' });
      console.log('[Content] CHECK_SIDE_PANEL_STATE =>', response);
      if (response && response.isOpen) {
        floatingBtn.style.display = 'none';
      } else {
        floatingBtn.style.display = 'flex';
      }
    } catch (error) {
      console.warn('[Content] CHECK_SIDE_PANEL_STATE 失败:', error);
      floatingBtn.style.display = 'flex';
    }
  })();

  // 定期检查 Side Panel 状态（作为后备机制）
  setInterval(async () => {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'CHECK_SIDE_PANEL_STATE' });
      if (response && response.isOpen) {
        floatingBtn.style.display = 'none';
      } else {
        floatingBtn.style.display = 'flex';
      }
    } catch (error) {
      // 如果消息发送失败，保持悬浮按钮可见
      floatingBtn.style.display = 'flex';
    }
  }, 2000);

  // 监听消息来立即更新状态并记录日志
  chrome.runtime.onMessage.addListener((message) => {
    console.log('[Content] 收到消息:', message.type, message);
    if (message.type === 'SIDE_PANEL_STATE_CHANGED') {
      if (message.isOpen) {
        floatingBtn.style.display = 'none';
      } else {
        floatingBtn.style.display = 'flex';
      }
    }
  });
}

// 启动
init();
