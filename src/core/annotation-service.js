/**
 * 画线标注服务
 * 在页面上绘制标注线和高亮框
 */

class AnnotationService {
  constructor() {
    this.canvas = null;
    this.ctx = null;
    this.annotations = [];
    this.animationId = null;
    this.isInitialized = false;
  }

  /**
   * 初始化画布
   */
  init() {
    if (this.isInitialized) return;

    // 创建画布容器
    this.container = document.createElement('div');
    this.container.id = 'page-explainer-annotation-container';
    this.container.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 2147483646;
    `;

    // 创建 Canvas
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = `
      width: 100%;
      height: 100%;
    `;
    this.container.appendChild(this.canvas);

    // 创建 SVG 容器（用于复杂图形）
    this.svgContainer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svgContainer.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
    `;
    this.container.appendChild(this.svgContainer);

    document.body.appendChild(this.container);

    this.ctx = this.canvas.getContext('2d');
    this._resize();
    
    // 监听窗口大小变化
    window.addEventListener('resize', () => this._resize());
    
    this.isInitialized = true;
  }

  /**
   * 调整画布大小
   */
  _resize() {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = window.innerWidth * dpr;
    this.canvas.height = window.innerHeight * dpr;
    this.ctx.scale(dpr, dpr);
  }

  /**
   * 清除所有标注
   */
  clear() {
    if (this.ctx) {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
    if (this.svgContainer) {
      this.svgContainer.innerHTML = '';
    }
    this.annotations = [];
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
  }

  /**
   * 画线指向元素
   */
  drawLineToElement(element, options = {}) {
    const {
      color = '#FF6B6B',
      lineWidth = 3,
      startPoint = 'auto', // 'auto', 'top', 'bottom', 'left', 'right' 或 {x, y}
      label = '',
      animate = true
    } = options;

    const rect = element.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    // 确定起始点
    let startX, startY;
    if (typeof startPoint === 'object') {
      startX = startPoint.x;
      startY = startPoint.y;
    } else if (startPoint === 'auto') {
      // 自动选择最佳起始位置
      startX = window.innerWidth - 100;
      startY = 100;
    } else {
      // 根据指定方向选择起始点
      const margin = 50;
      switch (startPoint) {
        case 'top':
          startX = centerX;
          startY = margin;
          break;
        case 'bottom':
          startX = centerX;
          startY = window.innerHeight - margin;
          break;
        case 'left':
          startX = margin;
          startY = centerY;
          break;
        case 'right':
          startX = window.innerWidth - margin;
          startY = centerY;
          break;
      }
    }

    // 保存标注信息
    const annotation = {
      type: 'line',
      element,
      startX,
      startY,
      endX: centerX,
      endY: centerY,
      color,
      lineWidth,
      label,
      progress: animate ? 0 : 1
    };

    this.annotations.push(annotation);

    if (animate) {
      this._animateLine(annotation);
    } else {
      this._drawLine(annotation);
    }

    return annotation;
  }

  /**
   * 高亮元素
   */
  highlightElement(element, options = {}) {
    const {
      color = '#FF6B6B',
      backgroundColor = 'rgba(255, 107, 107, 0.2)',
      borderWidth = 3,
      borderRadius = 4,
      padding = 4,
      label = '',
      pulse = true
    } = options;

    const rect = element.getBoundingClientRect();

    // 创建高亮框
    const highlight = document.createElement('div');
    highlight.className = 'page-explainer-highlight';
    highlight.style.cssText = `
      position: fixed;
      left: ${rect.left - padding}px;
      top: ${rect.top - padding}px;
      width: ${rect.width + padding * 2}px;
      height: ${rect.height + padding * 2}px;
      border: ${borderWidth}px solid ${color};
      border-radius: ${borderRadius}px;
      background-color: ${backgroundColor};
      pointer-events: none;
      z-index: 2147483645;
      box-sizing: border-box;
      ${pulse ? 'animation: page-explainer-pulse 1.5s ease-in-out infinite;' : ''}
    `;

    // 添加标签
    if (label) {
      const labelEl = document.createElement('div');
      labelEl.className = 'page-explainer-label';
      labelEl.textContent = label;
      labelEl.style.cssText = `
        position: absolute;
        top: -28px;
        left: 0;
        background: ${color};
        color: white;
        padding: 4px 8px;
        border-radius: 4px;
        font-size: 12px;
        font-weight: bold;
        white-space: nowrap;
      `;
      highlight.appendChild(labelEl);
    }

    this.container.appendChild(highlight);

    const annotation = {
      type: 'highlight',
      element,
      highlightEl: highlight,
      options
    };

    this.annotations.push(annotation);

    return annotation;
  }

  /**
   * 根据百分比位置高亮区域
   */
  highlightByPosition(position, options = {}) {
    const {
      x_percent,
      y_percent,
      width_percent,
      height_percent
    } = position;

    const x = (x_percent / 100) * window.innerWidth;
    const y = (y_percent / 100) * window.innerHeight;
    const width = (width_percent / 100) * window.innerWidth;
    const height = (height_percent / 100) * window.innerHeight;

    const rect = {
      left: x - width / 2,
      top: y - height / 2,
      width,
      height
    };

    // 创建虚拟元素用于高亮
    const fakeElement = {
      getBoundingClientRect: () => rect
    };

    return this.highlightElement(fakeElement, options);
  }

  /**
   * 给元素画“下划线”（老师讲解模式使用）
   */
  underlineElement(element, options = {}) {
    if (!element || typeof element.getBoundingClientRect !== 'function') return null;
    const rect = element.getBoundingClientRect();
    return this.underlineByRect(rect, options);
  }

  /**
   * 按百分比位置画“下划线”（与 highlightByPosition 一致的输入）
   */
  underlineByPosition(position, options = {}) {
    const { x_percent, y_percent, width_percent, height_percent } = position || {};
    if ([x_percent, y_percent, width_percent, height_percent].some(v => typeof v !== 'number')) return null;

    const x = (x_percent / 100) * window.innerWidth;
    const y = (y_percent / 100) * window.innerHeight;
    const width = (width_percent / 100) * window.innerWidth;
    const height = (height_percent / 100) * window.innerHeight;

    const rect = {
      left: x - width / 2,
      top: y - height / 2,
      width,
      height
    };

    return this.underlineByRect(rect, options);
  }

  underlineByRect(rect, options = {}) {
    const {
      color = '#FF6B6B',
      lineWidth = 4,
      padding = 2,
      label = ''
    } = options;

    if (!this.svgContainer) return null;

    const x1 = Math.max(0, rect.left);
    const x2 = Math.min(window.innerWidth, rect.left + rect.width);
    const baseY = rect.top + rect.height + padding;
    const y = Math.max(0, Math.min(window.innerHeight - 1, baseY));

    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', String(x1));
    line.setAttribute('y1', String(y));
    line.setAttribute('x2', String(x2));
    line.setAttribute('y2', String(y));
    line.setAttribute('stroke', color);
    line.setAttribute('stroke-width', String(lineWidth));
    line.setAttribute('stroke-linecap', 'round');

    g.appendChild(line);

    if (label) {
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.textContent = label;
      text.setAttribute('x', String(x1));
      text.setAttribute('y', String(Math.max(12, y - 8)));
      text.setAttribute('fill', color);
      text.setAttribute('font-size', '12');
      text.setAttribute('font-weight', '700');
      g.appendChild(text);
    }

    this.svgContainer.appendChild(g);

    const annotation = {
      type: 'underline',
      rect,
      groupEl: g,
      options
    };
    this.annotations.push(annotation);
    return annotation;
  }

  /**
   * 画箭头
   */
  drawArrow(fromX, fromY, toX, toY, options = {}) {
    const {
      color = '#FF6B6B',
      lineWidth = 3,
      headLength = 15
    } = options;

    this.ctx.save();
    this.ctx.strokeStyle = color;
    this.ctx.fillStyle = color;
    this.ctx.lineWidth = lineWidth;
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';

    // 画线
    this.ctx.beginPath();
    this.ctx.moveTo(fromX, fromY);
    this.ctx.lineTo(toX, toY);
    this.ctx.stroke();

    // 画箭头
    const angle = Math.atan2(toY - fromY, toX - fromX);
    
    this.ctx.beginPath();
    this.ctx.moveTo(toX, toY);
    this.ctx.lineTo(
      toX - headLength * Math.cos(angle - Math.PI / 6),
      toY - headLength * Math.sin(angle - Math.PI / 6)
    );
    this.ctx.lineTo(
      toX - headLength * Math.cos(angle + Math.PI / 6),
      toY - headLength * Math.sin(angle + Math.PI / 6)
    );
    this.ctx.closePath();
    this.ctx.fill();

    this.ctx.restore();
  }

  /**
   * 画曲线箭头
   */
  drawCurvedArrow(fromX, fromY, toX, toY, options = {}) {
    const {
      color = '#FF6B6B',
      lineWidth = 3,
      curvature = 0.3,
      headLength = 15
    } = options;

    // 计算控制点
    const midX = (fromX + toX) / 2;
    const midY = (fromY + toY) / 2;
    const dx = toX - fromX;
    const dy = toY - fromY;
    const cpX = midX - dy * curvature;
    const cpY = midY + dx * curvature;

    this.ctx.save();
    this.ctx.strokeStyle = color;
    this.ctx.fillStyle = color;
    this.ctx.lineWidth = lineWidth;
    this.ctx.lineCap = 'round';

    // 画曲线
    this.ctx.beginPath();
    this.ctx.moveTo(fromX, fromY);
    this.ctx.quadraticCurveTo(cpX, cpY, toX, toY);
    this.ctx.stroke();

    // 计算箭头角度
    const angle = Math.atan2(toY - cpY, toX - cpX);
    
    // 画箭头
    this.ctx.beginPath();
    this.ctx.moveTo(toX, toY);
    this.ctx.lineTo(
      toX - headLength * Math.cos(angle - Math.PI / 6),
      toY - headLength * Math.sin(angle - Math.PI / 6)
    );
    this.ctx.lineTo(
      toX - headLength * Math.cos(angle + Math.PI / 6),
      toY - headLength * Math.sin(angle + Math.PI / 6)
    );
    this.ctx.closePath();
    this.ctx.fill();

    this.ctx.restore();
  }

  /**
   * 动画绘制线条
   */
  _animateLine(annotation) {
    const duration = 500;
    const startTime = performance.now();

    const animate = (currentTime) => {
      const elapsed = currentTime - startTime;
      annotation.progress = Math.min(elapsed / duration, 1);

      this._redraw();

      if (annotation.progress < 1) {
        this.animationId = requestAnimationFrame(animate);
      }
    };

    this.animationId = requestAnimationFrame(animate);
  }

  /**
   * 绘制单条线
   */
  _drawLine(annotation) {
    const { startX, startY, endX, endY, color, lineWidth, progress, label } = annotation;
    
    const currentEndX = startX + (endX - startX) * progress;
    const currentEndY = startY + (endY - startY) * progress;

    this.drawCurvedArrow(startX, startY, currentEndX, currentEndY, {
      color,
      lineWidth
    });

    // 绘制标签
    if (label && progress === 1) {
      this.ctx.save();
      this.ctx.fillStyle = color;
      this.ctx.font = 'bold 14px sans-serif';
      this.ctx.textAlign = 'center';
      this.ctx.fillText(label, startX, startY - 10);
      this.ctx.restore();
    }
  }

  /**
   * 重绘所有标注
   */
  _redraw() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    
    for (const annotation of this.annotations) {
      if (annotation.type === 'line') {
        this._drawLine(annotation);
      }
    }
  }

  /**
   * 移除指定标注
   */
  removeAnnotation(annotation) {
    const index = this.annotations.indexOf(annotation);
    if (index > -1) {
      this.annotations.splice(index, 1);
      
      if (annotation.type === 'highlight' && annotation.highlightEl) {
        annotation.highlightEl.remove();
      }
      
      this._redraw();
    }
  }

  /**
   * 查找元素并标注
   */
  async findAndAnnotate(selector, options = {}) {
    const element = document.querySelector(selector);
    if (!element) {
      console.warn('未找到元素:', selector);
      return null;
    }

    // 滚动到元素可见
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    
    // 等待滚动完成
    await new Promise(resolve => setTimeout(resolve, 500));

    return this.highlightElement(element, options);
  }

  /**
   * 销毁服务
   */
  destroy() {
    this.clear();
    if (this.container) {
      this.container.remove();
    }
    this.isInitialized = false;
  }
}

// 导出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { AnnotationService };
} else {
  window.AnnotationService = AnnotationService;
}
