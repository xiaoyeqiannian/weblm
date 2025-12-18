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
let isSidePanelOpen = false;
let bodyObserver = null; // 用于监听 DOM 变化
let buttonCheckInterval = null; // 定期检查按钮存在性

// 讲解模式（边看边讲）：由 sidepanel 驱动 TTS，这里负责滚动与画线
let lectureModeActive = false;
let lectureLastAnchorDocY = 0;

function hasExplicitFloatingLeftTop(btn) {
  if (!btn) return false;
  const hasLeft = btn.style.left && btn.style.left !== 'auto';
  const hasTop = btn.style.top && btn.style.top !== 'auto';
  return Boolean(hasLeft && hasTop);
}

function saveFloatingButtonPosition(btn) {
  if (!btn) return;
  if (!hasExplicitFloatingLeftTop(btn)) return;
  try {
    const left = parseInt(btn.style.left || btn.getBoundingClientRect().left, 10);
    const top = parseInt(btn.style.top || btn.getBoundingClientRect().top, 10);
    chrome.storage.local.set({ floatingButtonPosition: { left, top } });
  } catch (e) {}
}

function resetFloatingButtonToDefaultPosition(btn, { clearSaved } = { clearSaved: true }) {
  if (!btn) return;
  // 清空内联定位，回到 CSS 默认 right/bottom
  btn.style.left = '';
  btn.style.top = '';
  btn.style.right = '';
  btn.style.bottom = '';
  if (clearSaved) {
    try {
      chrome.storage.local.remove(['floatingButtonPosition']);
    } catch (e) {}
  }
}

function isFloatingButtonPositionOutOfViewport(btn) {
  if (!btn) return false;
  if (!hasExplicitFloatingLeftTop(btn)) return false;

  const rect = btn.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // 只要任何边界越界（哪怕部分越界）就视为“超出可视范围”
  return rect.left < 0 || rect.top < 0 || rect.right > vw || rect.bottom > vh;
}

function restoreFloatingButtonPositionOrReset(btn) {
  if (!btn) return;
  try {
    chrome.storage.local.get(['floatingButtonPosition'], (res) => {
      const pos = res?.floatingButtonPosition;
      if (pos && pos.left !== undefined && pos.top !== undefined) {
        btn.style.left = pos.left + 'px';
        btn.style.top = pos.top + 'px';
        btn.style.right = 'auto';
        btn.style.bottom = 'auto';

        // 如果恢复后越界，按初始化位置重置
        if (isFloatingButtonPositionOutOfViewport(btn)) {
          resetFloatingButtonToDefaultPosition(btn, { clearSaved: true });
        }
      } else {
        // 没有保存位置：如果当前（可能是旧内联）越界，也重置
        if (isFloatingButtonPositionOutOfViewport(btn)) {
          resetFloatingButtonToDefaultPosition(btn, { clearSaved: false });
        }
      }
    });
  } catch (e) {
    if (isFloatingButtonPositionOutOfViewport(btn)) {
      resetFloatingButtonToDefaultPosition(btn, { clearSaved: false });
    }
  }
}

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

  // 确保 body 存在
  if (!document.body) {
    console.warn('[Content] document.body 不存在，延迟创建悬浮按钮');
    setTimeout(createFloatingButton, 100);
    return;
  }

  const floating = document.createElement('button');
  floating.id = 'pe-floating-btn';
  floating.setAttribute('aria-label', '打开 WebLM Side Panel');
  // 添加标记属性，方便识别是插件注入的元素
  floating.setAttribute('data-pe-extension', 'true');
  
  // 使用扩展内图标（避免 innerHTML 直接塞 emoji）
  try {
    const img = document.createElement('img');
    img.src = chrome.runtime.getURL('icons/icon.svg');
    img.alt = '';
    img.setAttribute('aria-hidden', 'true');
    img.draggable = false;
    floating.replaceChildren(img);
  } catch (e) {
    floating.textContent = 'WebLM';
  }
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

  // SSR 兼容：启动按钮监听（防止按钮被移除）
  startButtonObserver();
}

function attachFloatingButtonViewportGuards(btn) {
  if (!btn || btn.__peViewportGuardAttached) return;
  btn.__peViewportGuardAttached = true;

  const onViewportChange = () => {
    // 只对“手动拖拽过（使用 left/top）”的按钮回弹；默认 right/bottom 不干预
    // 视口变化（包括 Side Panel 开合）只做回弹，不写入持久化位置
    clampFloatingButtonToViewport(btn, { save: false });
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
        // 记录“点击前”的位置（避免 Side Panel 打开导致坐标被挤压后写入）
        saveFloatingButtonPosition(btn);
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
        // 如果用户关闭了截图输入，则不走基于截图的 AI 定位
        try {
          const res = await chrome.storage.local.get(['enableScreenshot']);
          const enabled = res.enableScreenshot;
          const screenshotEnabled = enabled === undefined ? true : !!enabled;
          if (!screenshotEnabled) {
            continue;
          }
        } catch (e) {}

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

function isVisibleForLecture(el) {
  try {
    if (!el || el.nodeType !== 1) return false;
    const style = window.getComputedStyle(el);
    if (!style || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return false;
    return true;
  } catch (e) {
    return false;
  }
}

function findBestElementForLecture(description) {
  const needle = String(description || '').trim();
  if (!needle) return null;
  const lowerNeedle = needle.toLowerCase();

  // 收集一定数量候选，按“阅读顺序”选择：优先上次锚点之后最靠前的命中
  const candidates = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);

  while (walker.nextNode()) {
    const node = walker.currentNode;
    const text = (node.textContent || '').trim();
    if (!text) continue;
    if (!text.toLowerCase().includes(lowerNeedle)) continue;

    const parent = node.parentElement;
    if (!parent) continue;
    if (!isVisibleForLecture(parent)) continue;

    const rect = parent.getBoundingClientRect();
    const docY = window.scrollY + rect.top;
    candidates.push({ el: parent, docY, rect });

    if (candidates.length >= 60) break;
  }

  if (!candidates.length) return null;

  const threshold = lectureLastAnchorDocY ? lectureLastAnchorDocY + 8 : window.scrollY - 40;
  const after = candidates
    .filter(c => Number.isFinite(c.docY) && c.docY >= threshold)
    .sort((a, b) => a.docY - b.docY);

  if (after.length) return after[0].el;

  // 如果页面里只有更靠上的命中（比如重复标题），选离当前视口最近的一个，避免猛跳到顶部
  const centerDocY = window.scrollY + window.innerHeight / 2;
  candidates.sort((a, b) => Math.abs(a.docY - centerDocY) - Math.abs(b.docY - centerDocY));
  return candidates[0].el;
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

    case 'LECTURE_PREPARE_STEP':
      // 边看边讲模式：准备某一步（滚动到目标并下划线）
      (async () => {
        try {
          const step = data?.step || {};
          const result = await prepareLectureStep(step);
          sendResponse({ success: true, result });
        } catch (e) {
          sendResponse({ success: false, error: e?.message || String(e) });
        }
      })();
      return true;

    case 'LECTURE_CLEAR':
      try {
        lectureModeActive = false;
        lectureLastAnchorDocY = 0;
        if (annotationService) annotationService.clear();
      } catch (e) {}
      sendResponse({ success: true });
      return true;

    case 'LECTURE_CLEAR_MARKS':
      // 仅清理画线/高亮，不重置锚点（用于“讲完就消失”）
      try {
        if (annotationService) annotationService.clear();
      } catch (e) {}
      sendResponse({ success: true });
      return true;
    
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

async function prepareLectureStep(step) {
  lectureModeActive = true;

  const description = String(step?.description || step?.targetText || '').trim();
  const scrollPercentRaw = step?.scrollPercent;
  const scrollPercent = typeof scrollPercentRaw === 'number' && Number.isFinite(scrollPercentRaw)
    ? Math.max(0, Math.min(100, scrollPercentRaw))
    : null;

  // 默认每步先清一下，避免画面太乱
  try {
    if (annotationService) annotationService.clear();
  } catch (e) {}

  let found = false;
  let scrolled = false;

  if (description) {
    let element = findBestElementForLecture(description) || findElementByDescription(description);
    if (element) {
      try {
        // 优先用 scrollIntoView（对滚动容器/特殊页面更稳），失败再 fallback 到 window scroll
        if (typeof element.scrollIntoView === 'function') {
          element.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
          await new Promise(r => setTimeout(r, 450));
        } else {
          await autoScrollService.scrollToElement(element, { block: 'center', offset: 120 });
        }
        scrolled = true;
      } catch (e) {}

      // 滚动后 DOM/布局可能变化，重新找一次
      element = findBestElementForLecture(description) || findElementByDescription(description) || element;

      // 更新锚点，保证后续按顺序向下找
      try {
        const r = element.getBoundingClientRect();
        const docY = window.scrollY + r.top;
        if (Number.isFinite(docY)) lectureLastAnchorDocY = docY;
      } catch (e) {}

      try {
        annotationService.underlineElement(element, {
          label: '',
          lineWidth: 4
        });
      } catch (e) {}

      found = true;
    }
  }

  // 文本定位失败时，用 scrollPercent 兜底滚动到大致位置
  if (!found && scrollPercent !== null) {
    try {
      const doc = document.documentElement;
      const maxScroll = (doc.scrollHeight || 0) - window.innerHeight;
      const target = Math.max(0, Math.min(maxScroll, (maxScroll * scrollPercent) / 100));
      await autoScrollService.scrollTo(target, { animate: true, duration: 550 });
      scrolled = true;
      lectureLastAnchorDocY = target;
    } catch (e) {}

    // 滚动后再尝试一次定位并画线
    if (description) {
      try {
        const element = findBestElementForLecture(description) || findElementByDescription(description);
        if (element) {
          try {
            annotationService.underlineElement(element, { label: '', lineWidth: 4 });
          } catch (e) {}
          found = true;
          try {
            const r = element.getBoundingClientRect();
            const docY = window.scrollY + r.top;
            if (Number.isFinite(docY)) lectureLastAnchorDocY = docY;
          } catch (e) {}
        }
      } catch (e) {}
    }
  }

  return { found, scrolled, description };
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
        isSidePanelOpen = true;
        floatingBtn.style.display = 'none';
      } else {
        isSidePanelOpen = false;
        floatingBtn.style.display = 'flex';
        // 显示时：恢复点击前位置；若越界则重置为默认
        restoreFloatingButtonPositionOrReset(floatingBtn);
      }
    } catch (error) {
      console.warn('[Content] CHECK_SIDE_PANEL_STATE 失败:', error);
      isSidePanelOpen = false;
      floatingBtn.style.display = 'flex';
      restoreFloatingButtonPositionOrReset(floatingBtn);
    }
  })();

  // 定期检查 Side Panel 状态（作为后备机制）
  setInterval(async () => {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'CHECK_SIDE_PANEL_STATE' });
      if (response && response.isOpen) {
        isSidePanelOpen = true;
        floatingBtn.style.display = 'none';
      } else {
        isSidePanelOpen = false;
        floatingBtn.style.display = 'flex';
        restoreFloatingButtonPositionOrReset(floatingBtn);
      }
    } catch (error) {
      // 如果消息发送失败，保持悬浮按钮可见
      isSidePanelOpen = false;
      floatingBtn.style.display = 'flex';
      restoreFloatingButtonPositionOrReset(floatingBtn);
    }
  }, 2000);

  // 监听消息来立即更新状态并记录日志
  chrome.runtime.onMessage.addListener((message) => {
    console.log('[Content] 收到消息:', message.type, message);
    if (message.type === 'SIDE_PANEL_STATE_CHANGED') {
      if (message.isOpen) {
        isSidePanelOpen = true;
        floatingBtn.style.display = 'none';
      } else {
        isSidePanelOpen = false;
        floatingBtn.style.display = 'flex';
        restoreFloatingButtonPositionOrReset(floatingBtn);
      }
    }
  });
}

// 监听按钮是否被移除（SSR 页面兼容）
function startButtonObserver() {
  // 清理旧的监听器
  if (bodyObserver) {
    bodyObserver.disconnect();
    bodyObserver = null;
  }
  if (buttonCheckInterval) {
    clearInterval(buttonCheckInterval);
    buttonCheckInterval = null;
  }

  // 方案1: MutationObserver 监听 body 的子节点变化
  if (document.body) {
    bodyObserver = new MutationObserver((mutations) => {
      // 检查悬浮按钮是否还在 DOM 中
      const btn = document.getElementById('pe-floating-btn');
      if (!btn || !document.body.contains(btn)) {
        console.log('[Content] 检测到悬浮按钮被移除，重新创建');
        floatingButton = null;
        createFloatingButton();
      }
    });

    bodyObserver.observe(document.body, {
      childList: true,
      subtree: false // 只监听 body 的直接子节点变化
    });
  }

  // 方案2: 定期检查（兜底机制，处理某些极端情况）
  buttonCheckInterval = setInterval(() => {
    // 如果 Side Panel 打开，按钮本应隐藏，不需要重新创建
    if (isSidePanelOpen) return;

    const btn = document.getElementById('pe-floating-btn');
    if (!btn || !document.body || !document.body.contains(btn)) {
      console.log('[Content] 定期检查：悬浮按钮不存在，重新创建');
      floatingButton = null;
      createFloatingButton();
    }
  }, 3000); // 每 3 秒检查一次
}

// 清理监听器
function stopButtonObserver() {
  if (bodyObserver) {
    bodyObserver.disconnect();
    bodyObserver = null;
  }
  if (buttonCheckInterval) {
    clearInterval(buttonCheckInterval);
    buttonCheckInterval = null;
  }
}

// SPA 路由变化监听（适用于 React Router、Vue Router 等）
let lastUrl = location.href;
function detectUrlChange() {
  const currentUrl = location.href;
  if (currentUrl !== lastUrl) {
    console.log('[Content] 检测到 URL 变化:', lastUrl, '->', currentUrl);
    lastUrl = currentUrl;
    // URL 变化后，确保按钮仍然存在
    setTimeout(() => {
      if (!isSidePanelOpen) {
        const btn = document.getElementById('pe-floating-btn');
        if (!btn || !document.body.contains(btn)) {
          console.log('[Content] URL 变化后按钮丢失，重新创建');
          floatingButton = null;
          createFloatingButton();
        }
      }
    }, 500); // 等待路由渲染完成
  }
}

// 监听 SPA 路由变化
setInterval(detectUrlChange, 1000);

// 监听 popstate 事件（浏览器前进/后退）
window.addEventListener('popstate', () => {
  setTimeout(detectUrlChange, 100);
});

// 监听 pushState 和 replaceState（拦截 SPA 路由）
const originalPushState = history.pushState;
const originalReplaceState = history.replaceState;

history.pushState = function(...args) {
  originalPushState.apply(this, args);
  setTimeout(detectUrlChange, 100);
};

history.replaceState = function(...args) {
  originalReplaceState.apply(this, args);
  setTimeout(detectUrlChange, 100);
};

// 页面卸载时清理
window.addEventListener('beforeunload', () => {
  stopButtonObserver();
});

// 启动
init();
