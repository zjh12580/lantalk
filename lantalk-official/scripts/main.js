/* ============================================================================
   LanTalk 官方首页 · 交互层 (scripts/main.js)
   ----------------------------------------------------------------------------
   设计约束（Apple Fluid Interfaces / frontend-design）：
     · 只动画 transform 与 opacity，绝不触发布局
     · 按下即反馈（pointer-down），不等 click
     · 一次编排好的入场序列，而不是散落的微交互
     · 全部动效在 prefers-reduced-motion: reduce 下退化为短促交叉淡化
     · 无框架、无依赖，defer 加载，不阻塞首屏
   ============================================================================ */
(function () {
  'use strict';

  var root = document.documentElement;
  var reduceMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  var prefersReducedMotion = function () { return reduceMotionQuery.matches; };

  /* ==========================================================================
     1. 主题切换 —— 遵循"用户显式选择 > 系统外观"的优先级
     ========================================================================== */
  var THEME_KEY = 'lantalk-theme';
  var themeToggle = document.getElementById('themeToggle');

  function syncToggleState(theme) {
    if (!themeToggle) return;
    // aria-pressed 表达"当前是否处于浅色"，屏幕阅读器可朗读
    themeToggle.setAttribute('aria-pressed', theme === 'light' ? 'true' : 'false');
    themeToggle.setAttribute(
      'aria-label',
      theme === 'light' ? '当前为浅色外观，切换到深色' : '当前为深色外观，切换到浅色'
    );
  }

  syncToggleState(root.getAttribute('data-theme') || 'dark');

  if (themeToggle) {
    themeToggle.addEventListener('click', function () {
      var next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      root.setAttribute('data-theme', next);
      // 颜色过渡交给 CSS 令牌，这里只切换属性，避免手写一堆内联样式
      try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* 隐私模式忽略 */ }
      syncToggleState(next);
      showToast(next === 'light' ? '已切换到浅色主题' : '已切换到深色主题');
    });
  }

  // 用户没有显式选择过时，跟随系统外观的变化
  var sysLight = window.matchMedia('(prefers-color-scheme: light)');
  var onSystemThemeChange = function (e) {
    var saved = null;
    try { saved = localStorage.getItem(THEME_KEY); } catch (err) { /* 忽略 */ }
    if (saved) return; // 用户已选择，不覆盖
    var next = e.matches ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    syncToggleState(next);
  };
  if (sysLight.addEventListener) sysLight.addEventListener('change', onSystemThemeChange);
  else if (sysLight.addListener) sysLight.addListener(onSystemThemeChange);

  /* ==========================================================================
     2. 提示层（toast）—— 全局复用，role=status 供屏幕阅读器播报
     ========================================================================== */
  var stageToast = document.getElementById('stageToast');
  var stageToastText = document.getElementById('stageToastText');
  var toastTimer = null;

  function showToast(text) {
    if (!stageToast || !stageToastText) return;
    stageToastText.textContent = text;
    stageToast.classList.add('is-on');
    // 提示音波纹同步亮起：视觉与"声音"在同一帧发生（多模态反馈的和声原则）
    var wave = document.getElementById('stageWave');
    if (wave) {
      wave.classList.add('is-on');
      setTimeout(function () { wave.classList.remove('is-on'); }, 1600);
    }
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { stageToast.classList.remove('is-on'); }, 2600);
  }

  /* ==========================================================================
     3. 滚动入场 —— 一次编排好的序列
     用 IntersectionObserver 驱动，元素一旦入场即取消观察（不重复播放）
     ========================================================================== */
  var revealEls = Array.prototype.slice.call(document.querySelectorAll('.reveal'));

  if (!('IntersectionObserver' in window) || prefersReducedMotion()) {
    // 降级路径：能力缺失或用户要求减少动效 → 直接呈现最终状态
    revealEls.forEach(function (el) { el.classList.add('is-in'); });
  } else {
    var revealObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-in');
        revealObserver.unobserve(entry.target);
      });
    }, {
      // 元素露出 12% 就触发，避免用户已经看完才动
      threshold: 0.12,
      rootMargin: '0px 0px -8% 0px'
    });

    revealEls.forEach(function (el) { revealObserver.observe(el); });
  }

  /* ==========================================================================
     4. 首屏消息逐条到达 —— 让右侧界面像"正在工作"，而不是一张静态图
     严格按顺序、总时长控制在 1.6s 内，不拖住阅读
     ========================================================================== */
  function playThread() {
    var thread = document.getElementById('thread');
    if (!thread) return;

    var messages = Array.prototype.slice.call(thread.querySelectorAll('.msg'));
    if (!messages.length) return;

    // 减少动效时：直接给最终态，不做位移动画
    if (prefersReducedMotion()) {
      messages.forEach(function (m) { m.style.opacity = '1'; m.style.transform = 'none'; });
      return;
    }

    messages.forEach(function (m, i) {
      m.style.opacity = '0';
      m.style.transform = 'translateY(8px)';
      // 逐条 90ms 错峰，形成"消息连续到达"的节奏
      m.style.animationDelay = (140 + i * 90) + 'ms';
    });

    // 触发动画（is-in 上挂着 @keyframes msgIn）
    requestAnimationFrame(function () {
      messages.forEach(function (m) { m.classList.add('is-in'); });
    });

    // 最后一条"正在输入"始终保持在视口内：滚动到底部一次
    var timer = setTimeout(function () {
      thread.scrollTop = thread.scrollHeight;
    }, 140 + messages.length * 90 + 260);

    // 页面被隐藏时不必等这个定时器（省电）
    document.addEventListener('visibilitychange', function onHide() {
      if (document.hidden) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onHide);
    });
  }

  /* ==========================================================================
     5. 顶栏材质状态 —— 滚动后亮顶边与分隔线显形，材质"变厚"
     用 rAF 节流，避免滚动事件压住主线程
     ========================================================================== */
  var siteHeader = document.getElementById('siteHeader');
  var ticking = false;

  function syncHeader() {
    if (!siteHeader) return;
    var stuck = window.scrollY > 8;
    siteHeader.classList.toggle('is-stuck', stuck);
    ticking = false;
  }

  window.addEventListener('scroll', function () {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(syncHeader);
  }, { passive: true });

  syncHeader();

  /* ==========================================================================
     6. 移动端导航抽屉 —— 与桌面导航进出同路径
     宽容设计：点遮罩、按 Esc、点任意链接都能退出
     ========================================================================== */
  var navToggle = document.getElementById('navToggle');
  var drawer = document.getElementById('drawer');
  var scrim = document.getElementById('scrim');

  function setDrawer(open) {
    if (!drawer || !navToggle || !scrim) return;
    drawer.classList.toggle('is-open', open);
    drawer.setAttribute('aria-hidden', open ? 'false' : 'true');
    navToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    navToggle.setAttribute('aria-label', open ? '收起导航菜单' : '展开导航菜单');
    scrim.hidden = !open;
    scrim.classList.toggle('is-on', open);
    document.body.classList.toggle('is-locked', open);
  }

  if (navToggle && drawer && scrim) {
    navToggle.addEventListener('click', function () {
      setDrawer(!drawer.classList.contains('is-open'));
    });

    scrim.addEventListener('click', function () { setDrawer(false); });

    // 点抽屉内任意链接后收起，避免"点完还挡着内容"
    drawer.addEventListener('click', function (e) {
      if (e.target.closest('a')) setDrawer(false);
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && drawer.classList.contains('is-open')) {
        setDrawer(false);
        navToggle.focus(); // 焦点回到触发元素，键盘用户不会迷路
      }
    });

    // 拉宽到桌面断点时自动收起，避免残留一个不可见的打开态
    var wideQuery = window.matchMedia('(min-width: 861px)');
    var onWide = function (e) { if (e.matches) setDrawer(false); };
    if (wideQuery.addEventListener) wideQuery.addEventListener('change', onWide);
    else if (wideQuery.addListener) wideQuery.addListener(onWide);
  }

  /* ==========================================================================
     7. 命令复制 —— 反馈用文案 + 颜色双通道，不只靠颜色
     优先用 Clipboard API；不可用时退回选中文本，用户可直接 Ctrl+C
     ========================================================================== */
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    // 降级：临时 textarea + execCommand（老浏览器 / 非安全上下文）
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy') ? resolve() : reject(new Error('execCommand failed'));
      } catch (err) {
        reject(err);
      } finally {
        document.body.removeChild(ta);
      }
    });
  }

  Array.prototype.forEach.call(document.querySelectorAll('.term__copy'), function (btn) {
    var label = btn.querySelector('.term__copy-label');
    var original = label ? label.textContent : '复制';
    var resetTimer = null;

    btn.addEventListener('click', function () {
      var text = btn.getAttribute('data-copy') || '';

      copyText(text).then(function () {
        btn.classList.add('is-done');
        if (label) label.textContent = '已复制';
        showToast('命令已复制到剪贴板');
      }).catch(function () {
        if (label) label.textContent = '请手动复制';
        showToast('复制失败，请手动选中命令');
      }).then(function () {
        clearTimeout(resetTimer);
        resetTimer = setTimeout(function () {
          btn.classList.remove('is-done');
          if (label) label.textContent = original;
        }, 1800);
      });
    });
  });

  /* ==========================================================================
     8. 跑马灯 —— 复制一份内容实现无缝循环
     复制体加 aria-hidden，屏幕阅读器只读一遍
     ========================================================================== */
  var marqueeTrack = document.getElementById('marqueeTrack');
  if (marqueeTrack && !marqueeTrack.dataset.cloned) {
    var clone = marqueeTrack.cloneNode(true);
    clone.removeAttribute('id');
    clone.dataset.clone = 'true';
    clone.setAttribute('aria-hidden', 'true');
    Array.prototype.forEach.call(clone.children, function (child) {
      child.setAttribute('aria-hidden', 'true');
    });
    // 把复制体接在原内容后面：轨道位移 -50% 时正好接回起点
    while (clone.firstChild) marqueeTrack.appendChild(clone.firstChild);
    marqueeTrack.dataset.cloned = 'true';
  }

  /* ==========================================================================
     9. 运行指标计数 —— 只在进入视口时跑一次，且尊重减少动效
     ========================================================================== */
  var counters = Array.prototype.slice.call(document.querySelectorAll('[data-count]'));

  function renderCount(el, value) {
    var suffix = el.querySelector('sup');
    var text = String(value);
    el.textContent = text;
    if (suffix) el.appendChild(suffix); // sup 元素要在设置文本后重新挂回
  }

  function runCounter(el) {
    var target = parseInt(el.getAttribute('data-count'), 10);
    if (isNaN(target)) return;

    // 0 不需要过渡：直接显示，避免"看起来卡住了"的错觉
    if (target === 0 || prefersReducedMotion()) {
      renderCount(el, target);
      return;
    }

    var duration = 900;
    var start = null;

    function step(now) {
      if (start === null) start = now;
      var progress = Math.min((now - start) / duration, 1);
      // easeOutExpo：起步快、收尾稳，符合"进入即锁定"的数字感
      var eased = progress === 1 ? 1 : 1 - Math.pow(2, -10 * progress);
      renderCount(el, Math.round(eased * target));
      if (progress < 1) requestAnimationFrame(step);
      else renderCount(el, target);
    }

    requestAnimationFrame(step);
  }

  if (!('IntersectionObserver' in window)) {
    counters.forEach(function (el) { renderCount(el, parseInt(el.getAttribute('data-count'), 10) || 0); });
  } else {
    var countObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        runCounter(entry.target);
        countObserver.unobserve(entry.target);
      });
    }, { threshold: 0.5 });

    counters.forEach(function (el) { countObserver.observe(el); });
  }

  /* ==========================================================================
     10. 侧栏会话悬停 —— 指针移上时切换高亮，模拟真实客户端
     仅在有精确指针的设备上启用（触屏不产生 hover 歧义）
     ========================================================================== */
  if (window.matchMedia('(hover: hover)').matches) {
    var convs = Array.prototype.slice.call(document.querySelectorAll('.window__side .conv'));
    convs.forEach(function (conv) {
      conv.addEventListener('mouseenter', function () {
        convs.forEach(function (c) { c.style.background = ''; });
        conv.style.background = 'var(--surface-strong)';
      });
    });

    var side = document.querySelector('.window__side');
    if (side) {
      side.addEventListener('mouseleave', function () {
        convs.forEach(function (c) { c.style.background = ''; });
      });
    }
  }

  /* ==========================================================================
     11. 启动 —— 等首屏渲染完再播放序列，避免和样式加载抢帧
     ========================================================================== */
  if (document.readyState === 'complete') {
    playThread();
  } else {
    window.addEventListener('load', playThread, { once: true });
  }

  // 页面从 bfcache 恢复时，保证动效状态是干净的（不会卡在动画中途）
  window.addEventListener('pageshow', function (e) {
    if (e.persisted) syncHeader();
  });
})();
