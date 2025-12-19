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

// Mock 演示：编译期常量（由 scripts/build.js 注入到 dist/content/content.js）
// 开启方式：WEBLM_MOCK_DEMO=1 npm run build  或  npm run build -- --mock
const __WEBLM_MOCK_DEMO__ = (typeof WEBLM_MOCK_DEMO !== 'undefined') ? WEBLM_MOCK_DEMO : false;
let __weblmMockDemoRunning = false;

async function setMockModeStorage(enabled, extra = {}) {
  try {
    await chrome.storage.local.set({
      weblmMockMode: !!enabled,
      weblmMockModeUpdatedAt: Date.now(),
      ...extra
    });
  } catch (e) {}
}

function logMock(event, payload = {}) {
  try {
    const base = {
      t: new Date().toISOString(),
      event,
      url: location.href,
      y: Math.round(window.scrollY)
    };
    console.log('[MockDemo]', { ...base, ...payload });
  } catch (e) {
    console.log('[MockDemo]', event);
  }
}

async function notifySidePanelSystem(text, extra = {}) {
  try {
    await chrome.runtime.sendMessage({
      type: 'SIDE_PANEL_SYSTEM',
      data: { text: String(text || ''), ...extra }
    });
  } catch (e) {}
}

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

  // Mock 演示：避免调用大模型，快速验证 播报/画线标注/滚动
  if (__WEBLM_MOCK_DEMO__) {
    // 避免重复运行
    if (!globalThis.__WEBLM_MOCK_DEMO_STARTED__) {
      globalThis.__WEBLM_MOCK_DEMO_STARTED__ = true;
      setMockModeStorage(true, { weblmMockModeSource: 'build-flag' });
      logMock('init', { enabled: true });
      // 注意：不自动执行 demo。Mock 模式仅在用户交互（播放/发送/语音结果）触发。
    }
  }
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isWindowScroller(scroller) {
  const se = document.scrollingElement || document.documentElement;
  return !scroller || scroller === window || scroller === document.documentElement || scroller === document.body || scroller === se;
}

function getPrimaryScrollContainer() {
  const se = document.scrollingElement || document.documentElement;
  try {
    if (se && se.scrollHeight - se.clientHeight > 80) return se;
  } catch (e) {}

  // fallback: find a big scrollable container (common in docs apps)
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let best = null;
  let bestScrollable = 0;

  let nodes = [];
  try {
    nodes = Array.from(document.querySelectorAll('main, [role="main"], article, section, div'));
  } catch (e) {}

  const maxScan = 320;
  for (let i = 0; i < Math.min(nodes.length, maxScan); i++) {
    const el = nodes[i];
    if (!el || el === document.body) continue;
    if (isExtensionInjectedElement(el)) continue;
    let style;
    try {
      style = window.getComputedStyle(el);
    } catch (e) {
      continue;
    }
    const oy = style?.overflowY;
    if (oy !== 'auto' && oy !== 'scroll') continue;

    let rect;
    try {
      rect = el.getBoundingClientRect();
    } catch (e) {
      continue;
    }
    if (!rect || rect.width < vw * 0.6 || rect.height < vh * 0.55) continue;

    let scrollable = 0;
    try {
      scrollable = (el.scrollHeight || 0) - (el.clientHeight || 0);
    } catch (e) {
      scrollable = 0;
    }
    if (scrollable < 200) continue;

    if (scrollable > bestScrollable) {
      bestScrollable = scrollable;
      best = el;
    }
  }

  return best || se;
}

function getScrollMetrics(scroller) {
  const se = document.scrollingElement || document.documentElement;
  const isWin = isWindowScroller(scroller);
  const el = isWin ? se : scroller;
  const scrollTop = isWin ? window.scrollY : (el?.scrollTop || 0);
  const clientHeight = isWin ? window.innerHeight : (el?.clientHeight || window.innerHeight);
  const scrollHeight = isWin ? (se?.scrollHeight || 0) : (el?.scrollHeight || 0);
  const maxScroll = Math.max(0, scrollHeight - clientHeight);
  return { isWin, el, scrollTop, clientHeight, scrollHeight, maxScroll };
}

async function scrollPrimaryTo(scroller, top, { duration = 650 } = {}) {
  const m = getScrollMetrics(scroller);
  const target = Math.max(0, Math.min(m.maxScroll, top));

  if (m.isWin) {
    try {
      await autoScrollService.scrollTo(target, { animate: true, duration });
      return { ok: true, target, used: 'window' };
    } catch (e) {
      window.scrollTo(0, target);
      return { ok: false, target, used: 'window' };
    }
  }

  const el = m.el;
  if (!el) {
    window.scrollTo(0, target);
    return { ok: false, target, used: 'fallback-window' };
  }

  const start = el.scrollTop || 0;
  const distance = target - start;
  const startTime = performance.now();

  return new Promise((resolve) => {
    const step = (now) => {
      const t = Math.min(1, (now - startTime) / Math.max(1, duration));
      const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      try {
        el.scrollTop = start + distance * ease;
      } catch (e) {}
      if (t < 1) {
        requestAnimationFrame(step);
      } else {
        const end = el.scrollTop || 0;
        const moved = Math.abs(end - start);
        if (moved < 2 && Math.abs(target - start) > 40) {
          try {
            window.scrollTo(0, target);
          } catch (e) {}
          resolve({ ok: false, target, used: 'element+fallback-window', scrollerTag: String(el.tagName || '').toLowerCase(), moved });
          return;
        }

        resolve({ ok: true, target, used: 'element', scrollerTag: String(el.tagName || '').toLowerCase(), moved });
      }
    };
    requestAnimationFrame(step);
  });
}

function normalizeText(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/\u00a0/g, ' ')
    .trim();
}

function getTextLineRectForElement(el, maxChars = 240) {
  try {
    if (!el) return null;

    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const t = normalizeText(node.textContent);
        if (!t || t.length < 20) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    let textNode = null;
    while (walker.nextNode()) {
      textNode = walker.currentNode;
      break;
    }
    if (!textNode) return null;

    const raw = String(textNode.textContent || '');
    const len = Math.min(raw.length, maxChars);
    if (len <= 0) return null;

    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, len);

    const rects = Array.from(range.getClientRects ? range.getClientRects() : []);
    if (!rects.length) return null;

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const inView = rects
      .filter(r => r && r.width > 20 && r.height > 10)
      .filter(r => r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw);

    const pickFrom = inView.length ? inView : rects;

    let best = pickFrom[0];
    for (const r of pickFrom) {
      const score = (r.width || 0) - (r.height || 0) * 0.2;
      const bestScore = (best.width || 0) - (best.height || 0) * 0.2;
      if (score > bestScore) best = r;
    }
    if (!best) return null;

    return {
      left: best.left,
      top: best.top,
      width: best.width,
      height: best.height
    };
  } catch (e) {
    return null;
  }
}

function pickSpeakSnippet(text, maxLen = 220) {
  const t = normalizeText(text);
  if (!t) return '';
  if (t.length <= maxLen) return t;

  const cut = t.slice(0, maxLen);
  const punct = Math.max(
    cut.lastIndexOf('。'),
    cut.lastIndexOf('！'),
    cut.lastIndexOf('？'),
    cut.lastIndexOf('.'),
    cut.lastIndexOf('!'),
    cut.lastIndexOf('?'),
    cut.lastIndexOf('；'),
    cut.lastIndexOf(';'),
    cut.lastIndexOf('，'),
    cut.lastIndexOf(',')
  );
  if (punct > 40) return cut.slice(0, punct + 1);
  return cut;
}

function pickFirstNonWhitespaceChars(text, n = 5) {
  const limit = Math.max(1, Math.min(80, Number(n) || 5));
  const t = String(text || '').replace(/\s+/g, '');
  if (!t) return '';
  return t.slice(0, limit);
}

function isExtensionInjectedElement(el) {
  if (!el) return false;
  try {
    if (el.id && String(el.id).startsWith('page-explainer-')) return true;
    if (el.id === 'pe-floating-btn') return true;
    if (el.closest && el.closest('[data-pe-extension="true"]')) return true;
    if (el.closest && el.closest('#page-explainer-annotation-container')) return true;
  } catch (e) {}
  return false;
}

function findSpeakableElementInViewport() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const sampleYs = [vh * 0.28, vh * 0.5, vh * 0.72].map((v) => Math.max(1, Math.min(vh - 2, v)));

  const isGood = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    if (isExtensionInjectedElement(el)) return false;
    let rect;
    try {
      rect = el.getBoundingClientRect();
    } catch (e) {
      return false;
    }
    if (!rect || rect.width < 120 || rect.height < 14) return false;
    if (rect.bottom < 40 || rect.top > vh - 40) return false;
    if (rect.height > vh * 0.9 && rect.width > vw * 0.9) return false; // avoid huge containers
    const tag = String(el.tagName || '').toLowerCase();
    if ((tag === 'div' || tag === 'span') && rect.height > vh * 0.7) return false;

    let style;
    try {
      style = window.getComputedStyle(el);
    } catch (e) {
      style = null;
    }
    if (style && (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0)) return false;

    const txt = normalizeText(el.textContent);
    if (txt.length < 60) return false;
    return true;
  };

  // 1) 从视口中心向上找
  for (const y of sampleYs) {
    let el = document.elementFromPoint(vw * 0.5, y);
    let depth = 0;
    while (el && depth++ < 10) {
      if (isExtensionInjectedElement(el)) break;
      if (el.matches && el.matches('p, li, blockquote, pre, code, h1, h2, h3, h4')) {
        if (isGood(el)) return el;
      }
      // 某些文档页用 div/span 承载文本
      if (el.matches && el.matches('div, span') && (el.children?.length || 0) <= 2) {
        if (isGood(el)) return el;
      }
      el = el.parentElement;
    }
  }

  // 2) 扫描常见文本元素
  try {
    const candidates = Array.from(document.querySelectorAll('article p, main p, p, article li, main li, li, blockquote, pre, code, h1, h2, h3, h4'));
    const inView = [];
    for (const el of candidates) {
      if (!el || isExtensionInjectedElement(el)) continue;
      if (!isGood(el)) continue;
      inView.push(el);
      if (inView.length >= 30) break;
    }
    if (inView.length) return inView[Math.floor(inView.length / 2)];
  } catch (e) {}

  // 3) 文档类：fallback 扫描 div/span（但避免选到超大容器）
  try {
    const candidates = Array.from(document.querySelectorAll('main div, main span, article div, article span, div, span'));
    const inView = [];
    for (const el of candidates) {
      if (!el || isExtensionInjectedElement(el)) continue;
      if ((el.children?.length || 0) > 2) continue;
      if (!isGood(el)) continue;
      inView.push(el);
      if (inView.length >= 24) break;
    }
    if (inView.length) return inView[Math.floor(inView.length / 2)];
  } catch (e) {}

  // 4) 最后兜底：扫描 text node
  try {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const t = normalizeText(node.textContent);
        if (!t || t.length < 60) return NodeFilter.FILTER_REJECT;
        const p = node.parentElement;
        if (!p || isExtensionInjectedElement(p)) return NodeFilter.FILTER_REJECT;
        if (p.closest && p.closest('script, style, noscript')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    const hits = [];
    let n = 0;
    while (walker.nextNode()) {
      n++;
      const p = walker.currentNode.parentElement;
      if (!p) continue;
      const el = p.closest ? (p.closest('p, li, blockquote, pre, code, h1, h2, h3, h4, div, span') || p) : p;
      if (!el || !isGood(el)) continue;
      hits.push(el);
      if (hits.length >= 20) break;
      if (n >= 800) break;
    }
    if (hits.length) return hits[Math.floor(hits.length / 2)];
  } catch (e) {}

  return null;
}

async function startMockDemo() {
  if (__weblmMockDemoRunning) return;
  __weblmMockDemoRunning = true;

  try {
    const pageTextLen = (getPageText() || '').length;
    const chunks = clamp(Math.ceil(pageTextLen / 1500), 3, 12);

    const scroller = getPrimaryScrollContainer();
    const metrics0 = getScrollMetrics(scroller);
    const maxScroll = metrics0.maxScroll;
    const scrollerInfo = {
      used: metrics0.isWin ? 'window' : 'element',
      tag: metrics0.el ? String(metrics0.el.tagName || '').toLowerCase() : '',
      id: metrics0.el?.id || '',
      className: (metrics0.el?.className && typeof metrics0.el.className === 'string') ? metrics0.el.className : '',
      clientHeight: metrics0.clientHeight,
      scrollHeight: metrics0.scrollHeight
    };
    const positions = [];
    for (let i = 0; i < chunks; i++) {
      const p = chunks === 1 ? 0 : Math.round((maxScroll * i) / (chunks - 1));
      positions.push(p);
    }

    const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const runMeta = {
      runId,
      startedAt: Date.now(),
      url: location.href,
      title: document.title,
      pageTextLen,
      chunks,
      maxScroll,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      scroller: scrollerInfo
    };

    await setMockModeStorage(true, { weblmMockLastRun: runMeta });
    logMock('start', runMeta);
    notifySidePanelSystem(
      `【Mock】开始演示：分${chunks}块滚动到页底；每块会选一段文字播报并做手写标注。\n` +
        `pageTextLen=${pageTextLen}，maxScroll=${maxScroll}`,
      { runMeta }
    );

    const stepRecords = [];

    for (let i = 0; i < positions.length; i++) {
      const target = positions[i];
      const beforeY = Math.round(getScrollMetrics(scroller).scrollTop);
      try {
        if (annotationService) annotationService.clear();
      } catch (e) {}

      const scrollRes = await scrollPrimaryTo(scroller, target, { duration: 650 });
      const afterY = Math.round(getScrollMetrics(scroller).scrollTop);
      const percent = maxScroll > 0 ? Math.round((afterY / maxScroll) * 100) : 100;
      logMock('scroll', { step: i + 1, total: positions.length, target, beforeY, afterY, percent, scrollerUsed: scrollRes?.used || '' });

      // 给懒加载/布局一点时间
      await sleep(450);

      const el = findSpeakableElementInViewport();
      if (!el) {
        logMock('pick_element_failed', { step: i + 1, total: positions.length });
        await sleep(400);
        continue;
      }

      const text = pickSpeakSnippet(el.textContent, 240);
      if (!text) continue;

      const rect = (() => {
        try {
          const r = el.getBoundingClientRect();
          return {
            l: Math.round(r.left),
            t: Math.round(r.top),
            w: Math.round(r.width),
            h: Math.round(r.height)
          };
        } catch (e) {
          return null;
        }
      })();

      const elInfo = {
        tag: String(el.tagName || '').toLowerCase(),
        id: el.id || '',
        cls: (el.className && typeof el.className === 'string') ? el.className : '',
        rect,
        snippet: text,
        snippetLen: text.length
      };

      // 画“手写圈/下划线”来指示播报内容
      let markType = 'none';
      try {
        const r = el.getBoundingClientRect();
        const preferUnderline = r.width > 260 || r.height > 64;
        const textRect = getTextLineRectForElement(el);
        if (preferUnderline) {
          if (textRect && typeof annotationService.underlineByRect === 'function') {
            annotationService.underlineByRect(textRect, { color: '#FF6B6B', lineWidth: 5, padding: 3, label: '' });
          } else {
            annotationService.underlineElement(el, { color: '#FF6B6B', lineWidth: 5, padding: 3, label: '' });
          }
          markType = 'underline';
        } else {
          if (typeof annotationService.circleElement === 'function') {
            if (textRect && typeof annotationService.circleByRect === 'function') {
              annotationService.circleByRect(textRect, { color: '#FF6B6B', lineWidth: 5, padding: 8, label: '' });
            } else {
              annotationService.circleElement(el, { color: '#FF6B6B', lineWidth: 5, padding: 8, label: '' });
            }
            markType = 'circle';
          } else {
            annotationService.highlightElement(el, { label: '', borderWidth: 5, padding: 8 });
            markType = 'highlight';
          }
        }
      } catch (e) {}

      logMock('mark', { step: i + 1, total: positions.length, markType, ...elInfo, scroller: scrollerInfo });

      // 播报
      const speakStartedAt = Date.now();
      try {
        if (voiceService && typeof voiceService.speak === 'function') {
          await voiceService.speak(text, { rate: 1.02, pitch: 1.0, volume: 1.0, lang: 'zh-CN' });
        }
      } catch (e) {
        console.warn('[MockDemo] 播报失败:', e);
      }

      const speakMs = Date.now() - speakStartedAt;
      logMock('speak_done', { step: i + 1, total: positions.length, speakMs, markType, snippetLen: text.length });

      stepRecords.push({
        step: i + 1,
        target,
        beforeY,
        afterY,
        percent,
        markType,
        tag: elInfo.tag,
        rect: elInfo.rect,
        snippetLen: elInfo.snippetLen
      });

      try {
        await chrome.storage.local.set({
          weblmMockLastStep: stepRecords[stepRecords.length - 1],
          weblmMockLastRun: { ...runMeta, lastStep: i + 1, updatedAt: Date.now() }
        });
      } catch (e) {}

      // 每段之间留一点缓冲
      await sleep(250);
    }

    const finishedAt = Date.now();
    const durationMs = finishedAt - runMeta.startedAt;
    const summary = { ...runMeta, finishedAt, durationMs, steps: stepRecords.length };
    try {
      await chrome.storage.local.set({
        weblmMockLastRun: { ...summary, stepRecords }
      });
    } catch (e) {}

    logMock('done', summary);
    notifySidePanelSystem(`【Mock】演示完成：共${stepRecords.length}步，用时${Math.round(durationMs / 1000)}s。\n可在控制台筛选 [MockDemo] 查看每步滚动/选段/标注/播报日志。`, { summary });
  } finally {
    __weblmMockDemoRunning = false;
  }
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
        // Mock 模式下：禁止走任何基于大模型的定位能力
        if (__WEBLM_MOCK_DEMO__) {
          continue;
        }

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
  const needle = String(description || '').trim();
  if (!needle) return null;
  const lowerNeedle = needle.toLowerCase();

  const esc = (s) => {
    try {
      return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&');
    } catch (e) {
      return String(s).replace(/["\\]/g, '\\$&');
    }
  };

  // 1) 优先尝试 querySelector 支持的属性匹配
  const selectors = [
    `[aria-label*="${esc(needle)}"]`,
    `[title*="${esc(needle)}"]`
  ];

  for (const selector of selectors) {
    try {
      const element = document.querySelector(selector);
      if (element) return element;
    } catch (e) {}
  }

  // 2) 替代 :contains：对常见可交互/标题元素用 textContent 包含判断
  try {
    const candidates = document.querySelectorAll('button, a, h1, h2, h3, [role="button"]');
    for (const el of candidates) {
      const txt = (el.textContent || '').trim();
      if (txt && txt.toLowerCase().includes(lowerNeedle)) return el;
    }
  } catch (e) {}

  // 遍历所有文本节点查找
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    null,
    false
  );

  while (walker.nextNode()) {
    if ((walker.currentNode.textContent || '').toLowerCase().includes(lowerNeedle)) {
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

    case 'START_MOCK_DEMO':
      (async () => {
        try {
          await startMockDemo();
          sendResponse({ success: true });
        } catch (e) {
          sendResponse({ success: false, error: e?.message || String(e) });
        }
      })();
      return true;

    case 'MOCK_PREPARE_STEP':
      (async () => {
        try {
          const scroller = getPrimaryScrollContainer();
          const metrics0 = getScrollMetrics(scroller);
          const maxScroll = metrics0.maxScroll;
          const scrollerInfo = {
            used: metrics0.isWin ? 'window' : 'element',
            tag: metrics0.el ? String(metrics0.el.tagName || '').toLowerCase() : '',
            id: metrics0.el?.id || '',
            className: (metrics0.el?.className && typeof metrics0.el.className === 'string') ? metrics0.el.className : '',
            clientHeight: metrics0.clientHeight,
            scrollHeight: metrics0.scrollHeight
          };

          const scrollPercentRaw = data?.scrollPercent;
          const scrollPercent = typeof scrollPercentRaw === 'number' && Number.isFinite(scrollPercentRaw)
            ? Math.max(0, Math.min(100, scrollPercentRaw))
            : null;

          const fixedCharsRaw = data?.fixedChars;
          const fixedChars = (typeof fixedCharsRaw === 'number' && Number.isFinite(fixedCharsRaw))
            ? Math.max(1, Math.min(80, Math.floor(fixedCharsRaw)))
            : null;

          const durationMsRaw = data?.durationMs;
          const durationMs = (typeof durationMsRaw === 'number' && Number.isFinite(durationMsRaw))
            ? Math.max(0, Math.min(5000, Math.floor(durationMsRaw)))
            : 650;

          const settleMsRaw = data?.settleMs;
          const settleMs = (typeof settleMsRaw === 'number' && Number.isFinite(settleMsRaw))
            ? Math.max(0, Math.min(5000, Math.floor(settleMsRaw)))
            : 450;

          // 每步先清理画线
          try {
            if (annotationService) annotationService.clear();
          } catch (e) {}

          let target = null;
          if (scrollPercent !== null) {
            target = Math.max(0, Math.min(maxScroll, (maxScroll * scrollPercent) / 100));
            const before = Math.round(getScrollMetrics(scroller).scrollTop);
            const scrollRes = await scrollPrimaryTo(scroller, target, { duration: durationMs });
            const after = Math.round(getScrollMetrics(scroller).scrollTop);
            logMock('scroll', { kind: 'mock_prepare_step', scrollPercent, target, before, after, scrollerUsed: scrollRes?.used || '', scroller: scrollerInfo });
            await sleep(settleMs);
          }

          const el = findSpeakableElementInViewport();
          if (!el) {
            logMock('pick_element_failed', { scrollPercent, target });
            sendResponse({ success: true, result: { found: false, scrollPercent, target, scroller: scrollerInfo } });
            return;
          }

          const snippet = fixedChars !== null
            ? pickFirstNonWhitespaceChars(el.textContent, fixedChars)
            : pickSpeakSnippet(el.textContent, 240);
          const textRect = getTextLineRectForElement(el);
          const r = (() => {
            try {
              const rect = el.getBoundingClientRect();
              return { l: Math.round(rect.left), t: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) };
            } catch (e) { return null; }
          })();

          let markType = 'none';
          try {
            const rect = el.getBoundingClientRect();
            const preferUnderline = rect.width > 260 || rect.height > 64;
            if (preferUnderline) {
              if (textRect && typeof annotationService.underlineByRect === 'function') {
                annotationService.underlineByRect(textRect, { color: '#FF6B6B', lineWidth: 5, padding: 3, label: '' });
              } else {
                annotationService.underlineElement(el, { color: '#FF6B6B', lineWidth: 5, padding: 3, label: '' });
              }
              markType = 'underline';
            } else {
              if (typeof annotationService.circleElement === 'function') {
                if (textRect && typeof annotationService.circleByRect === 'function') {
                  annotationService.circleByRect(textRect, { color: '#FF6B6B', lineWidth: 5, padding: 8, label: '' });
                } else {
                  annotationService.circleElement(el, { color: '#FF6B6B', lineWidth: 5, padding: 8, label: '' });
                }
                markType = 'circle';
              } else {
                annotationService.highlightElement(el, { label: '', borderWidth: 5, padding: 8 });
                markType = 'highlight';
              }
            }
          } catch (e) {}

          const result = {
            found: true,
            scrollPercent,
            target,
            markType,
            snippet,
            snippetLen: (snippet || '').length,
            fixedChars,
            durationMs,
            settleMs,
            scroller: scrollerInfo,
            element: {
              tag: String(el.tagName || '').toLowerCase(),
              id: el.id || '',
              className: (el.className && typeof el.className === 'string') ? el.className : '',
              rect: r,
              textRect: textRect
            }
          };

          logMock('mock_prepare_step', { ...result, y: Math.round(window.scrollY) });
          try {
            await chrome.storage.local.set({ weblmMockLastStep: { ...result, y: Math.round(window.scrollY), ts: Date.now() } });
          } catch (e) {}

          sendResponse({ success: true, result });
        } catch (e) {
          sendResponse({ success: false, error: e?.message || String(e) });
        }
      })();
      return true;
    
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
