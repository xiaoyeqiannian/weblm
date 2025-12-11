/**
 * 自动翻页服务
 * 处理页面滚动和翻页逻辑
 */

class AutoScrollService {
  constructor() {
    this.isAutoScrolling = false;
    this.scrollSpeed = 'normal'; // 'slow', 'normal', 'fast'
    this.onScrollComplete = null;
    this.onPageChange = null;
    this.currentScrollPosition = 0;
  }

  /**
   * 获取页面信息
   */
  getPageInfo() {
    return {
      scrollPosition: window.scrollY,
      totalHeight: document.documentElement.scrollHeight,
      viewportHeight: window.innerHeight,
      scrollPercent: (window.scrollY / (document.documentElement.scrollHeight - window.innerHeight)) * 100,
      hasMoreContent: window.scrollY + window.innerHeight < document.documentElement.scrollHeight - 10
    };
  }

  /**
   * 平滑滚动到指定位置
   */
  async scrollTo(position, options = {}) {
    const { animate = true, duration = 500 } = options;

    if (!animate) {
      window.scrollTo(0, position);
      return;
    }

    return new Promise((resolve) => {
      const start = window.scrollY;
      const distance = position - start;
      const startTime = performance.now();

      const step = (currentTime) => {
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);
        
        // 缓动函数
        const easeProgress = this._easeInOutCubic(progress);
        
        window.scrollTo(0, start + distance * easeProgress);

        if (progress < 1) {
          requestAnimationFrame(step);
        } else {
          resolve();
        }
      };

      requestAnimationFrame(step);
    });
  }

  /**
   * 滚动一页
   */
  async scrollPage(direction = 'down', options = {}) {
    const { overlap = 100 } = options;
    const viewportHeight = window.innerHeight;
    const scrollAmount = viewportHeight - overlap;

    const targetPosition = direction === 'down' 
      ? window.scrollY + scrollAmount 
      : window.scrollY - scrollAmount;

    // 限制滚动范围
    const maxScroll = document.documentElement.scrollHeight - viewportHeight;
    const clampedPosition = Math.max(0, Math.min(targetPosition, maxScroll));

    await this.scrollTo(clampedPosition);

    if (this.onPageChange) {
      this.onPageChange(this.getPageInfo());
    }

    return this.getPageInfo();
  }

  /**
   * 滚动到页面顶部
   */
  async scrollToTop() {
    await this.scrollTo(0);
    return this.getPageInfo();
  }

  /**
   * 滚动到页面底部
   */
  async scrollToBottom() {
    const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
    await this.scrollTo(maxScroll);
    return this.getPageInfo();
  }

  /**
   * 滚动到指定元素
   */
  async scrollToElement(element, options = {}) {
    const { offset = 100, block = 'center' } = options;

    if (!element) {
      console.warn('元素不存在');
      return;
    }

    const rect = element.getBoundingClientRect();
    let targetPosition;

    switch (block) {
      case 'start':
        targetPosition = window.scrollY + rect.top - offset;
        break;
      case 'center':
        targetPosition = window.scrollY + rect.top - (window.innerHeight / 2) + (rect.height / 2);
        break;
      case 'end':
        targetPosition = window.scrollY + rect.bottom - window.innerHeight + offset;
        break;
      default:
        targetPosition = window.scrollY + rect.top - offset;
    }

    await this.scrollTo(targetPosition);
    return this.getPageInfo();
  }

  /**
   * 开始自动滚动浏览
   */
  startAutoScroll(options = {}) {
    const {
      speed = 'normal',
      pauseOnHover = true,
      onProgress = null,
      onComplete = null
    } = options;

    if (this.isAutoScrolling) {
      return;
    }

    this.isAutoScrolling = true;
    this.scrollSpeed = speed;

    const speedMap = {
      slow: 1,
      normal: 2,
      fast: 4
    };

    const scrollStep = speedMap[speed] || 2;
    let isPaused = false;

    // 悬停暂停
    const handleMouseEnter = () => { isPaused = true; };
    const handleMouseLeave = () => { isPaused = false; };

    if (pauseOnHover) {
      document.addEventListener('mouseenter', handleMouseEnter);
      document.addEventListener('mouseleave', handleMouseLeave);
    }

    const scroll = () => {
      if (!this.isAutoScrolling) {
        return;
      }

      if (!isPaused) {
        const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
        const newPosition = Math.min(window.scrollY + scrollStep, maxScroll);
        
        window.scrollTo(0, newPosition);

        if (onProgress) {
          onProgress(this.getPageInfo());
        }

        if (newPosition >= maxScroll) {
          this.stopAutoScroll();
          if (onComplete) {
            onComplete();
          }
          return;
        }
      }

      requestAnimationFrame(scroll);
    };

    requestAnimationFrame(scroll);

    // 返回清理函数
    return () => {
      if (pauseOnHover) {
        document.removeEventListener('mouseenter', handleMouseEnter);
        document.removeEventListener('mouseleave', handleMouseLeave);
      }
    };
  }

  /**
   * 停止自动滚动
   */
  stopAutoScroll() {
    this.isAutoScrolling = false;
  }

  /**
   * 暂停/恢复自动滚动
   */
  toggleAutoScroll() {
    if (this.isAutoScrolling) {
      this.stopAutoScroll();
    } else {
      this.startAutoScroll({ speed: this.scrollSpeed });
    }
    return this.isAutoScrolling;
  }

  /**
   * 智能翻页 - 根据内容自动判断翻页时机
   */
  async smartScroll(options = {}) {
    const {
      readingTime = 5000, // 每页阅读时间
      onPageRead = null
    } = options;

    const pageInfo = this.getPageInfo();
    
    if (!pageInfo.hasMoreContent) {
      return { complete: true, pageInfo };
    }

    // 等待阅读时间
    await new Promise(resolve => setTimeout(resolve, readingTime));

    // 翻页
    await this.scrollPage('down');

    if (onPageRead) {
      onPageRead(this.getPageInfo());
    }

    return { complete: false, pageInfo: this.getPageInfo() };
  }

  /**
   * 自动阅读模式 - 配合AI讲解使用
   */
  async startReadingMode(options = {}) {
    const {
      pageTime = 5000,
      onPageChange = null,
      onComplete = null,
      shouldContinue = () => true
    } = options;

    while (true) {
      const pageInfo = this.getPageInfo();
      
      if (onPageChange) {
        await onPageChange(pageInfo);
      }

      if (!pageInfo.hasMoreContent) {
        if (onComplete) {
          onComplete();
        }
        break;
      }

      // 检查是否应该继续
      if (!shouldContinue()) {
        break;
      }

      // 等待并翻页
      await new Promise(resolve => setTimeout(resolve, pageTime));
      await this.scrollPage('down');
    }
  }

  /**
   * 缓动函数
   */
  _easeInOutCubic(t) {
    return t < 0.5
      ? 4 * t * t * t
      : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  /**
   * 截取当前视口截图
   */
  async captureViewport() {
    // 这个功能需要通过 background script 实现
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'CAPTURE_VIEWPORT' }, (response) => {
        if (response.success) {
          resolve(response.screenshot);
        } else {
          reject(new Error(response.error));
        }
      });
    });
  }
}

// 导出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { AutoScrollService };
} else {
  window.AutoScrollService = AutoScrollService;
}
