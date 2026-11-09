// 我爱说人话 — content script
// 所有 AI 请求走 background（content script 直接 fetch 第三方 API 会被 CORS 拦死）。
(function () {
  "use strict";

  if (window.__XRH_BOOTED__) return;
  window.__XRH_BOOTED__ = true;

  var X = globalThis.XRH || {};
  var DEF = X.DEFAULTS || {};
  var LIMITS = X.LIMITS || { draftsTweets: 60, draftsPerTweet: 12, candidatesMax: 5, handlesMax: 5000, idsPerHandle: 500 };
  var CFG_KEY = X.CFG_KEY || "xrh_cfg";
  var DATA_KEY = X.DATA_KEY || "xrh_data";

  // ==================== 基础工具 ====================
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  // 包含 root 自身的查询（MutationObserver 回调里 root 可能就是目标节点）
  function matchAll(sel, root) {
    root = root || document.body;
    if (!root) return [];
    var out = $$(sel, root);
    if (root.nodeType === 1 && root.matches && root.matches(sel)) out.unshift(root);
    return out;
  }

  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

  // X 保留路径，防止把 /home /search 当成用户名
  var RESERVED = ("home explore search notifications messages i settings intent share hashtag login logout signup " +
    "compose bookmarks premium verified who_to_follow tos privacy about jobs trending profile me account s u " +
    "sessions lists topics moments live video events ads business developer").split(" ");
  var RESERVED_SET = {};
  RESERVED.forEach(function (k) { RESERVED_SET[k] = 1; });

  function pathOf(href) {
    if (!href) return "";
    try { return new URL(href, location.href).pathname; } catch (e) { return ""; }
  }

  // 关键修复：a.href 返回的是绝对 URL，原来用 /^\/(\w+)/ 去匹配永远失败。
  // 统一走 pathname。
  function handleFromPath(p) {
    var m = /^\/([A-Za-z0-9_]{1,15})(?:\/|$)/.exec(p || "");
    if (!m) return "";
    var h = m[1];
    if (RESERVED_SET[h.toLowerCase()]) return "";
    return h.toLowerCase();
  }
  function handleFromEl(a) { return a ? handleFromPath(pathOf(a.getAttribute("href") || a.href)) : ""; }

  function statusIdFromPath(p) {
    var m = /^\/[A-Za-z0-9_]{1,15}\/status\/(\d+)/.exec(p || "");
    return m ? m[1] : "";
  }

  function debounce(fn, ms) {
    var t = 0;
    return function () {
      var self = this, args = arguments;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }

  function timeAgo(ts) {
    var s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return "刚刚";
    if (s < 3600) return Math.floor(s / 60) + " 分钟前";
    if (s < 86400) return Math.floor(s / 3600) + " 小时前";
    if (s < 86400 * 30) return Math.floor(s / 86400) + " 天前";
    var d = new Date(ts);
    return (d.getMonth() + 1) + "/" + d.getDate();
  }

  // 只接受文本，杜绝 innerHTML 注入
  function el(tag, opt, kids) {
    var n = document.createElement(tag);
    opt = opt || {};
    if (opt.cls) n.className = opt.cls;
    if (opt.text != null) n.textContent = opt.text;
    if (opt.title != null) n.title = opt.title;
    if (opt.attrs) for (var k in opt.attrs) n.setAttribute(k, opt.attrs[k]);
    if (opt.on) for (var e in opt.on) n.addEventListener(e, opt.on[e]);
    if (opt.style) n.style.cssText = opt.style;
    if (kids) {
      // 递归展平：调用方常写 [节点, list.map(...), 节点]，中间那个是数组不是节点。
      // 原来直接把数组丢给 appendChild 会抛 TypeError，整个面板渲染中断。
      // 数字也当文本处理 —— 拼计数时很容易漏掉 String()。
      (function add(list) {
        (Array.isArray(list) ? list : [list]).forEach(function (c) {
          if (c == null || c === false) return;
          if (Array.isArray(c)) { add(c); return; }
          n.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
        });
      })(kids);
    }
    return n;
  }

  var idle = window.requestIdleCallback
    ? function (fn) { return window.requestIdleCallback(fn, { timeout: 600 }); }
    : function (fn) { return setTimeout(function () { fn({ didTimeout: false, timeRemaining: function () { return 0; } }); }, 120); };

  // ==================== 存储 ====================
  var CFG = Object.assign({}, DEF);
  // me 必须初始化成空串：undefined 会让 !DATA.me 之外的判断（如 === ""）失效
  // me / myId 必须初始化成空串：undefined 会让 === "" 之类的判断失效
  var DATA = { me: "", myId: "", ids: {}, byAccount: {}, follow: newFollowState() };

  // 关注追踪的数据形状。单独一个函数，loadAll 补缺字段和「清除数据」共用。
  function newFollowState() {
    return {
      events: [],      // 关注/取关事件流水（含失败与撞限）
      follows: {},     // 小写用户名 -> { ts, src, via, fb, fbAt, unfollowedAt }
      following: {},   // 页面数据里读到的、你正在关注的人 -> { name, fb, seenAt }
      keep: {},        // 未回关名单里的「保留」标记，这些人不催
      consent: null    // { v, at } 数据说明的同意记录，没有它一个响应都不读
    };
  }
  var dirty = false;

  function acct() {
    if (!DATA.me) return null;
    if (!DATA.byAccount) DATA.byAccount = {};
    var a = DATA.byAccount[DATA.me];
    if (!a) a = DATA.byAccount[DATA.me] = {};
    if (!a.handles) a.handles = {};
    if (!a.drafts) a.drafts = {};
    return a;
  }

  // 存储写入。失败绝不能静默吞掉 —— 配额满时数据会无声丢失，用户还以为在正常记录。
  var saveFails = 0;
  var lastSaveBytes = 0;

  function doSave() {
    var payload = {};
    payload[DATA_KEY] = DATA;
    var json;
    try { json = JSON.stringify(DATA); } catch (e) { return; }
    lastSaveBytes = json.length;

    var onError = function (msg) {
      saveFails++;
      if (/QUOTA_BYTES|quota|too large|maximum|exceeded/i.test(msg || "")) {
        // 配额满：先淘汰最久没互动的追踪对象，再重试一次
        var a = acct();
        var freed = a ? evictOldestHandles(a, Math.max(20, Math.ceil(Object.keys(a.handles).length * 0.2))) : 0;
        dirty = true;
        toast("本地存储已满，自动清理了 " + freed + " 个最久没互动的追踪对象后重试保存", "err", 7000);
        setTimeout(flushSave, 400);
        return;
      }
      // 只在第一次和之后每 20 次提示一次，避免刷屏
      if (saveFails === 1 || saveFails % 20 === 0) {
        toast("本地数据保存失败（已失败 " + saveFails + " 次）：" + msg, "err", 7000);
      }
    };

    try {
      chrome.storage.local.set(payload, function () {
        var le = chrome.runtime.lastError;
        if (le) { onError(le.message || "未知错误"); return; }
        if (saveFails) { saveFails = 0; toast("本地数据已恢复正常保存", "ok"); }
      });
    } catch (e) {
      // 扩展被重载导致上下文失效：没法弹提示，标记为脏等下次机会
      dirty = true;
    }
  }

  var flushSave = debounce(function () {
    if (!dirty) return;
    dirty = false;
    doSave();
  }, 700);

  function markDirty() { dirty = true; flushSave(); }

  function loadAll(cb) {
    try {
      // 先把 v1 平铺存的 apiKey/baseUrl/model 迁到 xrh_cfg，否则升级后 Key 会「凭空消失」
      var finish = function () {
        chrome.storage.local.get([CFG_KEY, DATA_KEY], function (r) {
          CFG = Object.assign({}, DEF, X.normalizeCfg((r && r[CFG_KEY]) || {}));
          if (r && r[DATA_KEY] && typeof r[DATA_KEY] === "object") {
            var nz = X.normalizeData ? X.normalizeData(r[DATA_KEY]) : { data: r[DATA_KEY], changed: false };
            DATA = nz.data;
            if (!DATA.byAccount) DATA.byAccount = {};
            // 老版本存的数据可能没有这些字段，补成空值，别让 undefined 漏进比较逻辑
            if (typeof DATA.me !== "string") { DATA.me = ""; nz.changed = true; }
            if (typeof DATA.myId !== "string") { DATA.myId = ""; nz.changed = true; }
            if (!DATA.ids || typeof DATA.ids !== "object") { DATA.ids = {}; nz.changed = true; }
            if (!Array.isArray(DATA.sends)) { DATA.sends = []; nz.changed = true; }
            // 关注追踪：老数据没这块，补上；已有但缺子字段的也补齐，别让 undefined 漏进计算
            if (!DATA.follow || typeof DATA.follow !== "object") { DATA.follow = newFollowState(); nz.changed = true; }
            else {
              var fs0 = newFollowState();
              Object.keys(fs0).forEach(function (k) {
                if (DATA.follow[k] === undefined || DATA.follow[k] === null) { DATA.follow[k] = fs0[k]; nz.changed = true; }
              });
              if (!Array.isArray(DATA.follow.events)) { DATA.follow.events = []; nz.changed = true; }
            }
            // 只有真的迁移过东西才回写。之前是无条件 dirty=true，
            // 等于每次打开页面都全量序列化写一遍，纯浪费。
            if (nz.changed) { dirty = true; flushSave(); }
          }
          cb && cb();
        });
      };
      if (X.migrateCfg) X.migrateCfg(chrome.storage, finish);
      else finish();
    } catch (e) { cb && cb(); }
  }

  // 旧版本把数据写在页面 localStorage，已废弃，顺手清掉
  try { localStorage.removeItem("x_rh_v2"); } catch (e) {}

  // popup 改了设置 -> 热生效
  try {
    chrome.storage.onChanged.addListener(function (ch, area) {
      if (area !== "local" || !ch[CFG_KEY]) return;
      CFG = Object.assign({}, DEF, X.normalizeCfg(ch[CFG_KEY].newValue || {}));
      applyCfg();
    });
  } catch (e) {}

  // ==================== 与 background 通信 ====================
  function send(msg) {
    return new Promise(function (resolve) {
      try {
        if (!chrome.runtime || !chrome.runtime.id) {
          resolve({ ok: false, code: "dead", error: "插件已更新或重载，请刷新本页面" });
          return;
        }
        chrome.runtime.sendMessage(msg, function (resp) {
          var le = chrome.runtime.lastError;
          if (le) resolve({ ok: false, code: "ipc", error: le.message || "后台通信失败" });
          else resolve(resp || { ok: false, code: "noresp", error: "后台无响应" });
        });
      } catch (e) {
        resolve({ ok: false, code: "throw", error: (e && e.message) || String(e) });
      }
    });
  }

  // 流式生成：用长连接端口接收增量，首条候选 ~170ms 就能显示（非流式要等 ~1000ms）。
  // 端口不可用或中途断开时，自动降级回一次性 sendMessage，功能不受影响。
  function streamSend(msg, onPartial) {
    return new Promise(function (resolve) {
      var settled = false;
      var port = null;
      var timer = 0;

      var fallback = function (why) {
        if (settled) return;
        try { if (port) port.disconnect(); } catch (e) {}
        send(msg).then(function (r) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (r && r.ok) r.degraded = why;
          resolve(r);
        });
      };
      var finish = function (r) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { if (port) port.disconnect(); } catch (e) {}
        resolve(r);
      };

      try {
        if (!chrome.runtime || !chrome.runtime.id) { resolve({ ok: false, code: "dead", error: "插件已更新或重载，请刷新本页面" }); return; }
        if (typeof chrome.runtime.connect !== "function") { fallback("no-connect-api"); return; }
        port = chrome.runtime.connect({ name: "xrh:stream" });
      } catch (e) { fallback("connect-throw"); return; }

      timer = setTimeout(function () { finish({ ok: false, code: "timeout", error: "生成超时（90s）" }); }, 90000);

      try {
        port.onDisconnect.addListener(function () { fallback("disconnected"); });
        port.onMessage.addListener(function (m) {
          if (!m || (msg.id != null && m.id !== msg.id)) return;
          if (m.partial) { if (onPartial) onPartial(m.items || []); return; }
          finish(m);
        });
        port.postMessage(msg);
      } catch (e) { fallback("port-throw"); }
    });
  }

  // Service Worker 空闲 30 秒会被回收，下一次调用要付冷启动开销（几百毫秒）。
  // 进入帖子详情页时先发一个空消息把它唤醒，等用户真点 AI 时就是热的。
  var warmedAt = 0;
  function warmServiceWorker() {
    var now = Date.now();
    if (now - warmedAt < 25000) return;
    warmedAt = now;
    try {
      if (!chrome.runtime || !chrome.runtime.id) return;
      chrome.runtime.sendMessage({ type: "xrh:warm" }, function () { void chrome.runtime.lastError; });
    } catch (e) {}
  }


  // ==================== 剪贴板 ====================
  function copyText(text) {
    return new Promise(function (resolve) {
      var done = function (ok) { resolve(ok); };
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(legacyCopy(text)); });
          return;
        }
      } catch (e) {}
      done(legacyCopy(text));
    });
  }

  function legacyCopy(text) {
    try {
      var ta = el("textarea", { style: "position:fixed;top:-2000px;left:0;opacity:0" });
      ta.value = text;
      ta.setAttribute("readonly", "");
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      var ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch (e) { return false; }
  }

  // ---------- 复制成功提示（屏幕中间偏上，水平居中） ----------
  // 三条硬约束。最早那版把提示压在回复框内、被怀疑挡住输入而整块删掉：
  //   1. pointer-events:none —— 永远不吃点击，物理上不可能挡住输入框
  //   2. 固定在屏幕中间偏上 —— 不盖正文、不盖发送按钮，也不和底部居中的 toast 重叠
  //   3. 用户一按键 / 粘贴 / 滚动 / 点击就立刻消失，不等定时器
  var copiedHintEl = null, copiedHintTimer = 0, copiedHintBound = false;

  function hideCopiedHint() {
    clearTimeout(copiedHintTimer);
    if (copiedHintEl && copiedHintEl.parentNode) copiedHintEl.parentNode.removeChild(copiedHintEl);
    copiedHintEl = null;
  }

  function bindCopiedHintDismiss() {
    if (copiedHintBound) return;
    copiedHintBound = true;
    // 捕获阶段：复制按钮自己的 click 要等事件派发完才在微任务里走到 showCopiedHint，
    // 所以这里的 hide 一定发生在 show 之前，不会自己刚弹出来就被自己关掉。
    ["keydown", "paste", "scroll", "click", "pointerdown"].forEach(function (ev) {
      window.addEventListener(ev, hideCopiedHint, true);
    });
  }

  function showCopiedHint() {
    try {
      bindCopiedHintDismiss();
      hideCopiedHint();

      // 位置全部交给 CSS（屏幕中间偏上、水平居中），这里不再找回复框。
      // 上一版要先 findEditor + 算 getBoundingClientRect，找不到回复框、
      // 或回复框在 <dialog> 顶层里，整条提示就静默不显示 —— 等于功能没生效。
      var isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || "");
      copiedHintEl = el("div", {
        cls: "xrh-copied-hint",
        text: "✓ 已复制，按 " + (isMac ? "⌘V" : "Ctrl+V") + " 粘贴到回复框"
      });
      document.body.appendChild(copiedHintEl);

      copiedHintTimer = setTimeout(function () {
        if (!copiedHintEl) return;
        copiedHintEl.classList.add("hide");
        copiedHintTimer = setTimeout(hideCopiedHint, 200);
      }, 2400);
    } catch (e) {}
  }

  // ==================== 输入框 ====================
  // 从严到宽分级：优先内联回复框，最后才退到任意 contenteditable。
  // 不再强制要求 data-text 属性 —— X 改版时这个属性是最容易变的。
  var EDITOR_SELS = [
    '[data-testid="tweetInlineReplyForm"] [contenteditable="true"]',
    '[data-testid="tweetBox"] [contenteditable="true"]',
    '[data-testid="composerAutosize"] [contenteditable="true"]',
    '[role="textbox"][contenteditable="true"][data-text="true"]',
    '[role="textbox"][contenteditable="true"][aria-label]',
    '[contenteditable="true"][data-text="true"]',
    '[role="textbox"][contenteditable="true"]'
  ];

  function editorVisible(n) {
    if (!n || !n.getClientRects) return false;
    if (!n.getClientRects().length) return false;
    var st = window.getComputedStyle(n);
    return st.visibility !== "hidden" && st.display !== "none";
  }

  function findEditor() {
    // 优先用当前聚焦的编辑器：用户可能点的是某条嵌套回复的「回复」框，
    // 这时候不该去填页面顶部那个。
    var ae = document.activeElement;
    if (ae && ae.matches && ae.matches('[contenteditable="true"], [role="textbox"]') && editorVisible(ae)) return ae;
    for (var i = 0; i < EDITOR_SELS.length; i++) {
      var list = $$(EDITOR_SELS[i]);
      for (var j = 0; j < list.length; j++) if (editorVisible(list[j])) return list[j];
    }
    return null;
  }

  // 填入失败时把页面上所有候选输入框的结构打出来，方便定位 X 的 DOM 改版
  function editorDiag() {
    var list = $$('[contenteditable="true"], [role="textbox"], textarea');
    if (!list.length) return "页面上没有找到任何 contenteditable / role=textbox / textarea 元素";
    return "共找到 " + list.length + " 个候选输入框：\n" + list.slice(0, 15).map(function (n, i) {
      var host = n.closest("[data-testid]");
      return (i + 1) + ") <" + n.tagName.toLowerCase() + ">" +
        " 自身testid=" + (n.getAttribute("data-testid") || "-") +
        " 最近祖先testid=" + ((host && host.getAttribute("data-testid")) || "-") +
        " role=" + (n.getAttribute("role") || "-") +
        " data-text=" + (n.getAttribute("data-text") || "-") +
        " aria-label=" + (n.getAttribute("aria-label") || "-") +
        " 可见=" + (editorVisible(n) ? "是" : "否") +
        " 现有字数=" + ((n.textContent || n.value || "").length);
    }).join("\n");
  }

  function normTxt(s) { return String(s == null ? "" : s).replace(/[\u200b-\u200f\u2060\ufeff\s]/g, ""); }

  function editorHas(ed, text) {
    var want = normTxt(text);
    return want.length > 0 && normTxt(ed.textContent || ed.value).indexOf(want) >= 0;
  }

  function caretToEnd(ed) {
    try {
      var sel = window.getSelection();
      var r = document.createRange();
      r.selectNodeContents(ed);
      r.collapse(false);
      sel.removeAllRanges();
      sel.addRange(r);
    } catch (e) {}
  }

  // 富文本编辑器基本都认真处理 paste 事件，比 execCommand 更容易被 React 状态接收
  function tryPaste(ed, text) {
    try {
      var dt = new DataTransfer();
      dt.setData("text/plain", text);
      var ev = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
      try { Object.defineProperty(ev, "clipboardData", { value: dt }); } catch (e) {}
      ed.dispatchEvent(ev);
      return true;
    } catch (e) { return false; }
  }

  function selectAllIn(ed) {    try {
      var sel = window.getSelection();
      var r = document.createRange();
      r.selectNodeContents(ed);
      sel.removeAllRanges();
      sel.addRange(r);
    } catch (e) {}
  }

  var lastFillDiag = "";

  function clearEditor(ed) {
    selectAllIn(ed);
    try { document.execCommand("delete", false, null); } catch (e) {}
    if (normTxt(ed.textContent).length) {
      // execCommand 删不掉就手动清空，并补发 input 让编辑器状态同步
      while (ed.firstChild) ed.removeChild(ed.firstChild);
      try {
        ed.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackspace" }));
      } catch (e) {}
    }
  }

  // 数一段文本里 target 出现了几次
  function countOccurrences(hay, needle) {
    if (!needle) return 0;
    return hay.split(needle).length - 1;
  }

  // X 只有在编辑器「模型」里真有内容时才会点亮发送按钮。
  // DOM 里有字、模型没收到时按钮仍是灰的 —— 这是识别「幽灵文本」的客观判据。
  // 幽灵文本的症状正是用户报的：看得见、退格删不掉、点发送是空的。
  function composerSendButton(ed) {
    var scope = ed.closest('[data-testid="tweetInlineReplyForm"], [data-testid="tweetBox"], [data-testid="composerAutosize"]');
    if (!scope) scope = ed.parentElement;
    while (scope && scope !== document.body) {
      var btn = scope.querySelector('[data-testid="tweetButtonInline"], [data-testid="tweetButton"]');
      if (btn) return btn;
      scope = scope.parentElement;
    }
    return null;
  }

  // true = 模型已接收 / false = 幽灵文本 / null = 找不到发送按钮，无法判定
  function composerAcceptsText(ed) {
    var btn = composerSendButton(ed);
    if (!btn) return null;
    return !(btn.disabled || btn.getAttribute("aria-disabled") === "true");
  }

  // 只走编辑器自己会接收的通道，绝不直接写 textContent。
  // 三条通道全不被接收就退化成复制，让用户自己 Ctrl+V —— 粘贴走真实通道，可编辑。
  function tryInputEvents(ed, text) {
    try {
      ed.dispatchEvent(new InputEvent("beforeinput", {
        bubbles: true, cancelable: true, inputType: "insertText", data: text
      }));
      ed.dispatchEvent(new InputEvent("input", {
        bubbles: true, inputType: "insertText", data: text
      }));
      return true;
    } catch (e) { return false; }
  }

  // X 的发送按钮由 React 异步渲染，插入后立刻查一定还是灰的 —— 同步判据会把正常填入
  // 误判成幽灵文本并清掉（就是「看不到字」的原因）。所以先照常填入让字立刻可见，
  // 再分两次延时复核；两次都灰、且内容仍是我们插入的原文，才认定是幽灵文本并清掉改复制。
  function scheduleComposerCheck(ed, text) {
    if (!ed) return;
    var check = function (isFinal) {
      try {
        if (!ed.isConnected) return;
        if (composerAcceptsText(ed) !== false) return;      // 已接收，或找不到按钮无法判定
        if (!isFinal) { setTimeout(function () { check(true); }, 1200); return; }
        if (normTxt(ed.textContent) !== normTxt(text)) return;   // 用户已经改过，绝不能动
        clearEditor(ed);
        caretToEnd(ed);
        copyText(text).then(function (ok) {
          toast(
            ok ? "自动填入没被 X 接收（发送键仍是灰的），已清掉并复制，请 Ctrl+V 粘贴"
              : "自动填入没被 X 接收，请手动复制草稿后粘贴",
            "err", 7000
          );
        });
      } catch (e) {}
    };
    setTimeout(function () { check(false); }, 500);
  }

  function fillCompose(text) {
    var ed = findEditor();
    if (!ed) return { ok: false, error: "没找到输入框", diag: editorDiag(), text: text };
    try { ed.focus(); } catch (e) {}

    var want = normTxt(text);
    // 已经就是目标内容了，直接收工。重复写入是「填了两遍」的头号来源。
    if (want && countOccurrences(normTxt(ed.textContent), want) === 1) {
      caretToEnd(ed);
      return { ok: true, how: "already" };
    }
    // 有任何残留就先清干净（包括旧版本留下的幽灵文本），绝不在已有内容后面追加
    clearEditor(ed);

    var how = [];

    // 1) execCommand insertText：走真实输入通道
    try { if (document.execCommand("insertText", false, text)) how.push("execCommand"); } catch (e) {}

    // 2) paste 事件：富文本编辑器最常认真处理的路径
    if (!editorHas(ed, text)) {
      clearEditor(ed);
      if (tryPaste(ed, text)) how.push("paste");
    }

    // 3) beforeinput/input 事件序列：让编辑器自己把字插进它的状态，不由我们改 DOM
    if (!editorHas(ed, text)) {
      clearEditor(ed);
      if (tryInputEvents(ed, text)) how.push("inputEvent");
    }

    // 事后防重：两条通道都生效时会插两遍
    var dup = want ? countOccurrences(normTxt(ed.textContent), want) : 0;
    if (dup > 1) {
      how.push("dedupe:" + dup);
      clearEditor(ed);
      try { document.execCommand("insertText", false, text); } catch (e) {}
    }

    caretToEnd(ed);

    if (editorHas(ed, text)) {
      scheduleComposerCheck(ed, text);
      return { ok: true, how: how.join("+") || "none" };
    }
    return {
      ok: false,
      error: "X 的编辑器没接收自动填入（尝试过：" + (how.join("+") || "无") + "）",
      diag: editorDiag(),
      text: text
    };
  }

  // 填入失败时退化成「已帮你复制」，至少不用手抄；同时把诊断打到控制台方便排查
  function fillOrCopy(text) {
    var r = fillCompose(text);
    if (r.ok) { toast("已填入回复框（" + r.how + "），检查后再发送", "ok"); return true; }
    try { console.warn("[我爱说人话] 填入失败：", r.error, "\n", r.diag); } catch (e) {}
    lastFillDiag = r.diag || "";
    copyText(text).then(function (ok) {
      toast(ok
        ? "填入失败，已改为复制到剪贴板；诊断已存到「诊断」页可复制给我"
        : (r.error || "填入失败"), ok ? "" : "err", 6000);
    });
    return false;
  }

  // ==================== 草稿箱 ====================
  function currentTweetId() { return statusIdFromPath(location.pathname); }

  function currentTweetCtx() {
    var id = currentTweetId();
    if (!id) return null;
    var art = mainArticle() || $('article[data-testid="tweet"]');
    var author = "", src = "", images = [];
    if (art) {
      author = authorOf(art);
      src = tweetTextOf(art);
      images = imagesOf(art);
    }
    return { id: id, author: author, src: src, images: images, url: location.href };
  }

  function getDrafts(id) {
    var a = acct();
    if (!a) return null;
    return a.drafts[id] || null;
  }

  function saveDrafts(id, meta, items, opts) {
    var a = acct();
    if (!a) return;
    var cur = a.drafts[id] || { id: id, ts: Date.now(), items: [] };
    cur.url = meta.url || cur.url || location.href;
    cur.author = meta.author || cur.author || "";
    cur.src = meta.src || cur.src || "";
    // 存下配图 URL，历史草稿离开原帖页后仍能重新看图重写
    if (meta.images && meta.images.length) cur.images = meta.images.slice(0, 4);
    cur.ts = Date.now();
    var now = Date.now();
    var meta2 = opts || {};
    items.forEach(function (t, i) {
      // 同文本不重复入栈：重新生成经常撞出完全一样的句子，堆在一起没意义还占地方。
      // 已有的那条提到最前面（等于"刷新"），并保留它原有的备注。
      for (var k = 0; k < cur.items.length; k++) {
        if (cur.items[k].text === t) {
          var old = cur.items.splice(k, 1)[0];
          old.ts = now + (items.length - i);
          if (meta2.refine) { old.refined = true; old.feedback = String(meta2.feedback || "").slice(0, 120); }
          if (meta2.comments) old.comments = meta2.comments;
          if (meta2.images) old.images = meta2.images;
          // 重排名次要跟着刷新，否则旧的「最佳」标记会挂在已经不是第一的卡片上
          if (meta2.ranked) old.rank = i + 1; else delete old.rank;
          delete old.superseded;
          cur.items.unshift(old);
          return;
        }
      }
      var it = { text: t, ts: now + (items.length - i), used: 0 };
      if (meta2.refine) {
        it.refined = true;
        it.feedback = String(meta2.feedback || "").slice(0, 120);
        it.prev = String(meta2.prev || "").slice(0, 200);
      }
      if (meta2.comments) it.comments = meta2.comments;
      if (meta2.images) it.images = meta2.images;
      // rank = 裁判给的质量名次（1 是最好）。只在开了重排时才有，
      // 用来在卡片上标出「最佳」，否则用户看不出为什么第一条是第一条。
      if (meta2.ranked) it.rank = i + 1;
      cur.items.unshift(it);
    });
    // 重新生成后，把被替换掉的旧版本标记为过期，避免新旧混在一起分不清
    if (meta2.refine && meta2.prev) {
      cur.items.forEach(function (it) {
        if (!it.refined && it.text === meta2.prev) it.superseded = true;
      });
    }
    if (cur.items.length > LIMITS.draftsPerTweet) cur.items.length = LIMITS.draftsPerTweet;
    a.drafts[id] = cur;
    pruneDrafts(a);
    markDirty();
  }

  function pruneDrafts(a) {
    var ids = Object.keys(a.drafts);
    if (ids.length <= LIMITS.draftsTweets) return;
    ids.sort(function (x, y) { return (a.drafts[y].ts || 0) - (a.drafts[x].ts || 0); });
    ids.slice(LIMITS.draftsTweets).forEach(function (k) { delete a.drafts[k]; });
  }

  function removeDraft(id, idx) {
    var a = acct();
    if (!a || !a.drafts[id]) return;
    a.drafts[id].items.splice(idx, 1);
    if (!a.drafts[id].items.length) delete a.drafts[id];
    markDirty();
  }

  function markUsed(id, idx) {
    var a = acct();
    if (!a || !a.drafts[id] || !a.drafts[id].items[idx]) return;
    a.drafts[id].items[idx].used = Date.now();
    markDirty();
  }

  // 备注纯本地保存，不调用模型 —— 攒着不花钱，下次生成时作为约束一起带进去
  function setNote(id, idx, text) {
    var a = acct();
    if (!a || !a.drafts[id] || !a.drafts[id].items[idx]) return false;
    var it = a.drafts[id].items[idx];
    if (text) { it.note = String(text).slice(0, 300); it.noteTs = Date.now(); }
    else { delete it.note; delete it.noteTs; }
    markDirty();
    return true;
  }

  // ==================== Toast ====================
  var shadow = null, toastBox = null;
  function toast(text, kind, ms) {
    if (!toastBox) return;
    var n = el("div", { cls: "xrh-toast" + (kind ? " " + kind : ""), text: text });
    toastBox.appendChild(n);
    requestAnimationFrame(function () { n.classList.add("show"); });
    setTimeout(function () {
      n.classList.remove("show");
      setTimeout(function () { n.remove(); }, 220);
    }, ms || (kind === "err" ? 4200 : 2000));
  }

  // ==================== 互动追踪 ====================
  var meHow = "";

  function hasEditProfileBtn() {
    if ($('[data-testid="editProfileBtn"]')) return true;
    var bs = $$('[role="button"], button');
    for (var i = 0; i < bs.length; i++) {
      if (/^(编辑资料|Edit profile|個人資料編輯)$/.test((bs[i].textContent || "").trim())) return true;
    }
    return false;
  }

  // 认到账号时明确告诉用户一次 —— 之前所有记账都是静默的，
  // 识别成功与否完全看不出来，只能靠猜。
  function setMe(h, how) {
    if (!h || h === DATA.me) { if (h) meHow = how; return; }
    var wasEmpty = !DATA.me;
    DATA.me = h;
    meHow = how;
    markDirty();
    if (wasEmpty) {
      toast("已认到账号 @" + h + "（" + how + "），开始记录互动", "ok", 3200);
      if (panelOpen) renderPanel();
    }
  }

  // 认不出「哪个账号是我」，所有互动计数都是 0 —— 这是数据不动的头号原因。
  // 所以：多路识别 + 允许手动锁死 + 把识别方式暴露在诊断里。
  function detectMe() {
    var manual = String(CFG.myHandle || "").replace(/^@/, "").trim().toLowerCase();
    if (manual) {
      if (/^[a-z0-9_]{1,15}$/.test(manual)) { setMe(manual, "设置里手动指定"); return; }
      meHow = "手动填的用户名不合法（应为 1-15 位字母数字下划线，不带 @）：" + manual;
      return;
    }

    var h = "", how = "";

    // 1) 左侧导航头像链接（桌面端最可靠）
    var link = $('[data-testid="AppTabBar_Profile_Link"]');
    if (link) { h = handleFromEl(link); if (h) how = "左侧导航头像链接"; }

    // 2) 账号切换器
    if (!h) {
      var sw = $('[data-testid="SideNav_AccountSwitcher_Button"]');
      if (sw) {
        h = handleFromEl(sw.querySelector('a[href^="/"]'));
        if (!h) {
          var m = /@([A-Za-z0-9_]{1,15})/.exec((sw.textContent || "") + " " + (sw.getAttribute("aria-label") || ""));
          if (m) h = m[1].toLowerCase();
        }
        if (h) how = "账号切换器";
      }
    }

    // 3) 自己的主页：URL 给 handle，但必须有「编辑资料」按钮才能确定是我本人
    if (!h) {
      var pp = handleFromPath(location.pathname);
      if (pp && hasEditProfileBtn()) { h = pp; how = "个人主页 + 编辑资料按钮"; }
    }

    // 4) ld+json
    if (!h) {
      try {
        var s = $('script[type="application/ld+json"]');
        if (s) {
          var j = JSON.parse(s.textContent);
          var idf = j && j.author && (j.author.identifier || j.author.url);
          if (idf) {
            var cand = handleFromPath(pathOf(String(idf).replace(/^@/, "/")));
            if (cand) { h = cand; how = "页面 ld+json"; }
          }
        }
      } catch (e) {}
    }

    if (!h) {
      meHow = "未识别到账号（左侧导航没有头像链接）。请在插件设置里手填「我的用户名」。";
      return;
    }
    setMe(h, how);   // 换号自动切数据分区，不串号
  }

  function pushId(arr, id) {
    if (!id || arr.indexOf(id) >= 0) return false;
    arr.push(id);
    if (arr.length > LIMITS.idsPerHandle) arr.shift();
    return true;
  }

  function slot(h) {
    var a = acct();
    if (!a) return null;
    if (!a.handles[h]) {
      // handlesMax 之前只是定义了从没用过 —— 追踪人数会无限涨，
      // 每人最多 idsPerHandle×2 个 ID，上千人就是几十 MB，必然撞存储配额然后静默丢数据。
      var cap = LIMITS.handlesMax || 5000;
      if (Object.keys(a.handles).length >= cap) evictOldestHandles(a, Math.ceil(cap * 0.1));
      a.handles[h] = { out: [], inn: [], ts: Date.now() };
    }
    if (!a.handles[h].out) a.handles[h].out = [];
    if (!a.handles[h].inn) a.handles[h].inn = [];
    // 这里不刷新 ts。ts 是 evictOldestHandles 唯一的排序依据，而那个函数声称按
    // 「最久没有新互动」淘汰 —— 被动扫描反复读到同一批数据也会走 slot()，
    // 若在此无条件刷新，语义就变成「最久没被扫到」，会把有价值但最近没刷到的人先淘汰掉。
    // 改由 recordOut/recordIn 在真的新增了 ID 时才刷新。
    return a.handles[h];
  }

  // 按「最久没有新互动」淘汰，保住活跃关系
  function evictOldestHandles(a, count) {
    var keys = Object.keys(a.handles);
    keys.sort(function (x, y) { return (a.handles[x].ts || 0) - (a.handles[y].ts || 0); });
    for (var i = 0; i < count && i < keys.length; i++) delete a.handles[keys[i]];
    return Math.min(count, keys.length);
  }

  // ---------- 手速 ----------
  // 只记录「我真的点了发送」的时刻。这个来源天然不会被历史数据污染 ——
  // 它只在用户真实点击时触发，所以既不需要推文的 created_at，也不需要事件流清理，
  // 更不用担心一次灌进上千条历史推文会造出一个假的速度尖峰。
  var SENDS_MAX = 80;

  function sends() {
    if (!Array.isArray(DATA.sends)) DATA.sends = [];
    return DATA.sends;
  }

  function noteSend() {
    var a = sends();
    a.push(Date.now());
    if (a.length > SENDS_MAX) a.splice(0, a.length - SENDS_MAX);
    markDirty();
  }

  // minutes 窗口内发了几条，并折算到每小时 / 每天
  function sendRate(minutes) {
    var arr = sends(), cut = Date.now() - minutes * 60000;
    var n = 0, newest = 0;
    for (var i = 0; i < arr.length; i++) {
      if (arr[i] >= cut) { n++; if (arr[i] > newest) newest = arr[i]; }
    }
    var f = 60 / minutes;
    return {
      minutes: minutes, n: n, newest: newest, total: arr.length,
      perHour: Math.round(n * f),
      perDay24: Math.round(n * f * 24),
      perDay8: Math.round(n * f * 8)
    };
  }

  // 原代码 mt = Math.max(mt, 1) 永远是 1，这里按推文 ID 去重累加
  function recordOut(h, tid) { var sl = slot(h); var added = !!(sl && pushId(sl.out, tid)); if (added) { sl.ts = Date.now(); markDirty(); } return added; }
  function recordIn(h, key) { var sl = slot(h); var added = !!(sl && pushId(sl.inn, key)); if (added) { sl.ts = Date.now(); markDirty(); } return added; }

  function firstStatusId(root) {
    var links = root.querySelectorAll('a[href*="/status/"]');
    for (var i = 0; i < links.length; i++) {
      var id = statusIdFromPath(pathOf(links[i].getAttribute("href")));
      if (id) return id;
    }
    return "";
  }

  // 「回复 @xxx」行里的对象提取。
  // 不再依赖 role="link" 或文本以 @ 开头（X 各版本这两个都不稳定），改用位置判定：
  // 正文之前出现的、指向非保留 /<handle> 的链接，就是「回复」行里的对象。
  // 同时必须排除嵌套的引用推文卡片（X 把 quote card 也渲染成 article[data-testid="tweet"]，
  // 不排除会把被引用的人误记成你回复的对象）。
  // ---------- 对话模块：X 省略「回复 @x」行时怎么找回回复对象 ----------
  // 实测（v2.7.0 诊断报告）：/with_replies 上 12 条 article、6 条是我的、嵌套 0，
  // 而我那 6 条里 5 个链接全指向自己、完全没有「回复」文案。
  // 说明 X 在这里用的是「对话模块」布局：[别人的原帖] 紧接着 [你的回复]，
  // 因为上文就在眼前，它把「回复 @xxx」那一行省掉了。
  // 所以：同一个 cell 里排在我前面那条的作者，就是我回复的人。
  var CONV_CELL_MAX = 6;   // 一个 cell 里超过这么多 article，说明它是整个列表容器而非对话模块

  function conversationCell(art) {
    var cell = art.closest ? art.closest('[data-testid="cellInnerDiv"]') : null;
    if (!cell) return null;
    var arts = $$('article[data-testid="tweet"]', cell);
    if (arts.length < 2 || arts.length > CONV_CELL_MAX) return null;
    return { cell: cell, arts: arts, idx: arts.indexOf(art) };
  }

  function conversationParent(art) {
    var c = conversationCell(art);
    if (!c || c.idx <= 0) return null;
    return c.arts[c.idx - 1];
  }

  function replyParentId(art) {
    var pa = conversationParent(art);
    return pa ? ownStatusId(pa, authorOf(pa)) : "";
  }

  function directLinks(art) {
    return $$("a[href]", art).filter(function (a) {
      return a.closest("article") === art;   // 只要本层的，不进嵌套卡片
    });
  }

  function replyTargets(art) {
    var body = art.querySelector('[data-testid="tweetText"]');
    var nameBox = art.querySelector('[data-testid="User-Name"]');
    var out = [];
    var push = function (h) {
      h = String(h || "").toLowerCase();
      if (!h || h === DATA.me || out.indexOf(h) >= 0) return;
      out.push(h);
    };

    directLinks(art).forEach(function (a) {
      if (nameBox && nameBox.contains(a)) return;      // 作者自己的名字链接
      var raw = a.getAttribute("href") || "";
      var pth = pathOf(raw);
      if (/\/status\//.test(pth)) return;              // 时间戳/永久链
      if (/^\/(i|hashtag|search|home|settings)\b/.test(pth)) return;
      var h = handleFromPath(pth);
      if (!h) return;
      var txt = (a.textContent || "").trim();
      var isAt = txt.charAt(0) === "@";
      // 位置约束：正文之前的链接（「回复 @x」行）无条件接受；
      // 正文之后的只接受明确的 @mention，避免把引用卡片/推荐关注算进来
      var beforeBody = body ? !!(a.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING) : true;
      if (!beforeBody && !isAt) return;
      push(h);
    });

    // 补充路径：有些版本「回复」行里没有链接、只有纯文本 @handle
    if (!out.length) {
      var best = null, bestLen = 1e9;
      $$("div, span", art).forEach(function (n) {
        if (n.closest("article") !== art) return;
        var t = (n.textContent || "").trim();
        if (!/^(回复|Replying to|回复给|Reply to)(\s|$|@)/.test(t)) return;
        if (t.length > 160 || t.length >= bestLen) return;
        best = n; bestLen = t.length;
      });
      if (best) {
        var ms = (best.textContent || "").match(/@([A-Za-z0-9_]{1,15})/g) || [];
        ms.forEach(function (m) { push(m.slice(1)); });
        if (!out.length) $$("a[href]", best).forEach(function (a) { push(handleFromEl(a)); });
      }
    }

    // 路径 3：X 用对话模块布局时会整个省掉「回复 @x」行（实测 /with_replies 就是这样）。
    // 这时同一个 cell 里排在我前面那条的作者，就是我回复的人。
    if (!out.length) {
      var pa = conversationParent(art);
      if (pa) {
        var ph = authorOf(pa);
        // 必须确认前一条不是我自己的（自己线程里连发不算回复别人），也不能是嵌套引用卡片
        if (ph && ph !== DATA.me && pa !== art) push(ph);
      }
    }
    return out;
  }

  // 抽样把一条推文的真实结构打出来。X 改版时靠这个直接定位，不用猜。
  function articleAnatomy(limit) {
    var lines = [];
    var arts = matchAll('article[data-testid="tweet"]', document.body).filter(function (a) {
      return authorOf(a) === DATA.me;
    });
    if (!arts.length) return "本页没有 author === @" + DATA.me + " 的 article（authorOf 可能也失效了）";
    arts.slice(0, limit || 2).forEach(function (art, i) {
      var body = art.querySelector('[data-testid="tweetText"]');
      var nameBox = art.querySelector('[data-testid="User-Name"]');
      lines.push("--- 我发的第 " + (i + 1) + " 条 ---");
      lines.push("  tweetText: " + (body ? "有（" + (body.textContent || "").trim().slice(0, 30) + "）" : "没有"));
      lines.push("  User-Name: " + (nameBox ? "有" : "没有") + "  authorOf=" + (authorOf(art) || "(空)"));
      lines.push("  ownStatusId=" + (ownStatusId(art, authorOf(art)) || "(空)"));
      var links = $$("a[href]", art);
      lines.push("  本层 <a> 共 " + links.filter(function (a) { return a.closest("article") === art; }).length +
        " 个（含嵌套共 " + links.length + " 个）:");
      links.filter(function (a) { return a.closest("article") === art; }).slice(0, 10).forEach(function (a) {
        var pos = body ? (a.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING ? "正文前" : "正文后") : "无正文";
        lines.push("    [" + pos + "] href=" + (a.getAttribute("href") || "") +
          " role=" + (a.getAttribute("role") || "-") +
          " text=\"" + (a.textContent || "").trim().slice(0, 24) + "\"" +
          (nameBox && nameBox.contains(a) ? " (在User-Name内)" : ""));
      });
      // 含「回复/Replying」字样的元素
      var hit = [];
      $$("div, span", art).forEach(function (n) {
        if (n.closest("article") !== art || n.children.length > 4) return;
        var t = (n.textContent || "").trim();
        if (/回复|Replying to|Reply to/.test(t) && t.length < 100 && hit.indexOf(t) < 0) hit.push(t);
      });
      lines.push("  含「回复/Replying」的元素文本: " + (hit.length ? JSON.stringify(hit.slice(0, 4)) : "（一个都没有）"));
      // 对话模块判定：X 省略「回复 @x」行时，靠同 cell 里前一条找回回复对象
      var cc = conversationCell(art);
      var pa = conversationParent(art);
      lines.push("  所在 cellInnerDiv: " + (cc ? ("有，含 " + cc.arts.length + " 条 article，我是第 " + (cc.idx + 1) + " 条") : "没找到（或该 cell 里 article 数 >" + CONV_CELL_MAX + "）"));
      lines.push("  对话模块前一条: " + (pa ? ("@" + (authorOf(pa) || "?") + " / status=" + (ownStatusId(pa, authorOf(pa)) || "?")) : "（无）"));
      lines.push("  replyParentId(): " + (replyParentId(art) || "(空)"));
      lines.push("  replyTargets() 结果: " + JSON.stringify(replyTargets(art)));
    });
    return lines.join("\n");
  }

  // 不再限定只在自己的 /with_replies 页扫 —— 首页、搜索、详情页、别人帖子里
  // 只要出现「我发的 + 带 Replying to」的推文就记账。这是数据能自动增长的关键。
  function scanMyReplies(root) {
    if (!CFG.trackInteractions || !DATA.me) return 0;
    var added = 0;
    matchAll('article[data-testid="tweet"]', root || document.body).forEach(function (art) {
      if (authorOf(art) !== DATA.me) return;
      var myId = ownStatusId(art, DATA.me);
      if (!myId) return;
      // 去重键必须和「发送时记账」用同一套命名空间，否则同一次回复会被记两次：
      //   p:<父帖ID>  —— 能定位到父帖时用这个，发送钩子也用这个，两边天然对齐
      //   r:<我的回复ID> —— 定位不到父帖时的回退（此时发送钩子会主动放弃记账）
      var parentId = replyParentId(art);
      replyTargets(art).forEach(function (h) {
        if (parentId) { if (recordOut(h, "p:" + parentId)) added++; return; }
        // 没有父帖 ID，但发送钩子在本次会话里已经为这个人记过账 —— 跳过，避免两套键重复计数
        if (sentThisSession[h]) return;
        if (recordOut(h, "r:" + myId)) added++;
      });
    });
    if (added) markDirty();
    return added;
  }

  function mainArticle() {
    var id = currentTweetId();
    if (!id) return null;
    var arts = matchAll('article[data-testid="tweet"]', document.body);
    for (var i = 0; i < arts.length; i++) {
      if (ownStatusId(arts[i], authorOf(arts[i])) === id) return arts[i];
    }
    return null;
  }

  // 诊断用：统计本页有多少个「对话模块」cell，好判断这条路径到底有没有料
  function convCellStats(root) {
    var cells = matchAll('[data-testid="cellInnerDiv"]', root || document.body);
    var mod = 0, arts = 0, noCell = 0;
    matchAll('article[data-testid="tweet"]', root || document.body).forEach(function (a) {
      var c = a.closest ? a.closest('[data-testid="cellInnerDiv"]') : null;
      if (!c) { noCell++; return; }
      var n = $$('article[data-testid="tweet"]', c).length;
      if (n >= 2 && n <= CONV_CELL_MAX) arts++;
    });
    cells.forEach(function (c) {
      var n = $$('article[data-testid="tweet"]', c).length;
      if (n >= 2 && n <= CONV_CELL_MAX) mod++;
    });
    return { cells: cells.length, modules: mod, artsInModule: arts, artsNoCell: noCell };
  }

  // ---------- 「TA回我」的统一去重键 ----------
  // 三个数据源（通知页 / 我的帖子详情页 / 任意页面的对话模块）都可能看到同一条回复。
  // 只要键一致，重复看到就自动去重；键不一致就会重复计数（v2.7 之前就是这么翻车的）。
  // 统一规则：优先用「对方那条回复自己的推文 ID」，拿不到才退回文本指纹。
  function inKey(replyId, who, fallbackText) {
    if (replyId) return "r:" + replyId;
    return "t:" + (who || "") + ":" + normTxt(fallbackText || "").slice(0, 40);
  }

  // 打开自己的某条帖子时，下面所有回复者都算「TA 回你」—— 被动累积，不用去翻通知
  function scanThreadReplies() {
    if (!CFG.trackInteractions || !DATA.me) return 0;
    var mainEl = mainArticle();
    if (!mainEl || authorOf(mainEl) !== DATA.me) return 0;
    var added = 0;
    matchAll('article[data-testid="tweet"]', document.body).forEach(function (a) {
      if (a === mainEl) return;
      if (!(mainEl.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING)) return;
      var au = authorOf(a);
      if (!au || au === DATA.me) return;
      if (recordIn(au, inKey(ownStatusId(a, au), au, tweetTextOf(a)))) added++;
    });
    return added;
  }

  // ---------- 对话模块：双向都要记 ----------
  // X 在 /with_replies 等处用「对话模块」布局：同一个 cellInnerDiv 里
  // [上一条] 紧接 [下一条]，并且省略「回复 @x」行。所以相邻两条就是一次回复关系：
  //   前一条是别人 + 后一条是我   ->  我回复了 TA（你回TA）
  //   前一条是我   + 后一条是别人 ->  TA 回复了我（TA回你）  ← 这就是之前漏掉的那一半
  // 只在同一个 cell 内配对，且 cell 里 article 数不超过 CONV_CELL_MAX，
  // 否则整个时间线会被当成一条长对话，把不相干的相邻推文错配成回复关系。
  function scanConversationModules(root) {
    if (!CFG.trackInteractions || !DATA.me) return { inn: 0, out: 0 };
    var seenCells = [];
    var res = { inn: 0, out: 0 };
    matchAll('article[data-testid="tweet"]', root || document.body).forEach(function (art) {
      var cell = art.closest ? art.closest('[data-testid="cellInnerDiv"]') : null;
      if (!cell || seenCells.indexOf(cell) >= 0) return;
      seenCells.push(cell);
      var arts = $$('article[data-testid="tweet"]', cell);
      if (arts.length < 2 || arts.length > CONV_CELL_MAX) return;
      for (var i = 1; i < arts.length; i++) {
        var prev = arts[i - 1], cur = arts[i];
        var pa = authorOf(prev), ca = authorOf(cur);
        if (!pa || !ca || pa === ca) continue;                 // 同一人的线程不算互相回复
        var prevId = ownStatusId(prev, pa), curId = ownStatusId(cur, ca);
        if (pa === DATA.me) {
          // 我在前、别人在后 => 别人回复了我
          if (recordIn(ca, inKey(curId, ca, tweetTextOf(cur)))) res.inn++;
        } else if (ca === DATA.me) {
          // 别人在前、我在后 => 我回复了别人（与 replyTargets 路径3 用同一个键）
          if (prevId && recordOut(pa, "p:" + prevId)) res.out++;
        }
      }
    });
    if (res.inn || res.out) markDirty();
    return res;
  }

  // ---------- 通知页 ----------
  // X 中文版的回复通知渲染成「回复 @handle」，不是「回复了你」。
  // 原来按 /回复了你|replied to you/ 过滤，一条都匹配不上 —— 这就是通知页数据恒为 0 的原因。
  // 注意「喜欢了你的回复」也含「回复」二字，所以必须要求「回复」后面紧跟 @ 或「了你」，
  // 否则点赞通知会被误记成回复。
  function isReplyNotification(txt) {
    return /回复\s*@|回复了你|回复给\s*@|Replying to\s*@|replied to (you|your)|Reply to\s*@|提到了你|mentioned you|引用了你|quoted your (post|tweet)/i.test(txt || "");
  }

  // 通知行里的 @handle 链接。按 X 的排版，第一个是动作发起者，后面的才是被回复对象：
  //   显示名 / @发起人 / · / 9分钟 / 回复 / @我 / 和 / @另一个被回复者 / 正文
  function atHandleLinks(cell) {
    return $$("a[href]", cell).filter(function (a) {
      if (a.closest("article") && cell.closest("article") && a.closest("article") !== cell.closest("article")) return false;
      return /^@[A-Za-z0-9_]{1,15}$/.test((a.textContent || "").trim());
    });
  }

  function handleOfLink(a) {
    return handleFromEl(a) || (a.textContent || "").trim().replace(/^@/, "").toLowerCase();
  }

  // 不依赖单一 testid：X 各版本通知容器标签不一致，按可靠性依次回退。
  var NOTIF_SELS = [
    'article[data-testid="notification"]',
    '[data-testid="notification"]',
    '[data-testid="cellInnerDiv"]',
    '[role="article"]'
  ];

  function looksLikeNotifCell(n) {
    var t = n.textContent || "";
    // 太短=空壳，太长=整个列表容器（会导致 links[0] 取错人）
    return t.length > 4 && t.length < 1200;
  }

  var notifSelUsed = "";
  function notifCells(root) {
    for (var i = 0; i < NOTIF_SELS.length; i++) {
      var c = matchAll(NOTIF_SELS[i], root).filter(looksLikeNotifCell);
      if (c.length) { notifSelUsed = NOTIF_SELS[i]; return c; }
    }
    notifSelUsed = "（所有选择器都没命中）";
    return [];
  }

  // ---------- 容器无关的通知扫描（主力兜底）----------
  // 不去猜 X 用什么 data-testid 包每条通知。只用文档顺序推断：
  //   [发起人显示名] [@发起人] · 9分钟  [回复] [@我] 和 [@别人]  [正文]
  // 「回复」是叶子文本节点，@handle 是链接，谁在前谁在后就是答案。
  var REPLY_LABEL_RE = /^(回复|回复给|Replying to|Reply to)$/i;

  function replyActionLabels(scope) {
    var out = [];
    $$("span, div, p", scope).forEach(function (n) {
      if (n.children.length) return;                 // 只要叶子，避免匹配到整行容器
      var t = (n.textContent || "").trim();
      if (t && t.length <= 14 && REPLY_LABEL_RE.test(t)) out.push(n);
    });
    return out;
  }

  function allHandleLinks(scope) {
    return $$("a[href]", scope).filter(function (a) {
      var t = (a.textContent || "").trim();
      if (!/^@[A-Za-z0-9_]{1,15}$/.test(t)) return false;
      var h = handleFromEl(a);
      return !h || h === handleOfLink(a);            // href 与文本不一致时以 href 为准，但仍收
    }).map(function (a) { return { el: a, h: handleOfLink(a) }; });
  }

  function firstStatusLinkBetween(from, to, scope) {
    var links = $$('a[href*="/status/"]', scope);
    for (var i = 0; i < links.length; i++) {
      var L = links[i];
      if (from && !(from.compareDocumentPosition(L) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
      if (to && !(L.compareDocumentPosition(to) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
      var id = statusIdFromPath(pathOf(L.getAttribute("href")));
      if (id) return id;
    }
    return "";
  }

  var flatScanInfo = { actions: 0, actors: [], skippedNoMe: 0 };

  function scanNotificationsFlat(scope) {
    scope = scope || document.body;
    var links = allHandleLinks(scope);
    var actions = replyActionLabels(scope);
    flatScanInfo = { actions: actions.length, actors: [], skippedNoMe: 0 };
    if (!links.length || !actions.length) return 0;

    var added = 0;
    for (var i = 0; i < actions.length; i++) {
      var act = actions[i];
      var next = actions[i + 1] || null;

      // 发起人 = act 之前最后一个 @handle 链接（links 已是文档顺序，遇到不满足就停）
      var actor = "";
      for (var j = 0; j < links.length; j++) {
        if (links[j].el.compareDocumentPosition(act) & Node.DOCUMENT_POSITION_FOLLOWING) actor = links[j].h;
        else break;
      }
      if (!actor || actor === DATA.me) continue;

      // 对象 = act 之后、next 之前的 @handle 链接
      var targets = [];
      for (var k = 0; k < links.length; k++) {
        var L = links[k].el;
        if (!(act.compareDocumentPosition(L) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
        if (next && !(L.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
        if (targets.indexOf(links[k].h) < 0) targets.push(links[k].h);
      }
      if (targets.indexOf(DATA.me) < 0) { flatScanInfo.skippedNoMe++; continue; }

      flatScanInfo.actors.push(actor);
      var key = firstStatusLinkBetween(act, next, scope) || ("n:" + actor + ":" + targets.join(","));
      if (recordIn(actor, key)) added++;
    }
    return added;
  }

  function scanNotifications(root) {
    if (!CFG.trackInteractions || !DATA.me) return 0;
    if (location.pathname.indexOf("/notifications") !== 0) return 0;
    var scope = root || document.body;

    // 路径 A：按通知容器扫（能拿到更精确的推文 ID 去重）
    var added = 0, sawReplyCell = 0;
    notifCells(scope).forEach(function (cell) {
      var txt = cell.textContent || "";
      if (!isReplyNotification(txt)) return;
      var links = atHandleLinks(cell);
      if (!links.length) return;
      sawReplyCell++;
      var actor = handleOfLink(links[0]);
      if (!actor || actor === DATA.me) return;
      var mine = "@" + DATA.me;
      var forMe = txt.indexOf(mine) >= 0 || /回复了你|replied to (you|your)|提到了你|mentioned you/i.test(txt);
      if (!forMe) return;
      // 键与「详情页」「对话模块」两条路统一，重复看到同一条回复会自动去重
      if (recordIn(actor, inKey(firstStatusId(cell), actor, txt))) added++;
    });

    // 路径 B：容器一条回复通知都没认出来时，改用文档顺序推断（不依赖任何 testid）
    if (!sawReplyCell) added += scanNotificationsFlat(scope);
    return added;
  }

  // 通知页诊断：把所有条目原文全列出来，逐条标判定。
  // 之前只印第 1 条 + 跳过的逻辑，等于什么信息都没给，没法区分
  // 「页面上确实没有回复通知」和「有但我认不出来」—— 这两种情况的修法完全相反。
  function notifAnatomy(limit) {
    if (location.pathname.indexOf("/notifications") !== 0) return "（当前不在 /notifications 页）";
    var tab = "";
    var tabEl = $('[role="tab"][aria-selected="true"]');
    if (tabEl) tab = (tabEl.textContent || "").trim();

    var cells = notifCells(document.body);
    var lines = [
      "当前标签页: " + (tab || "(没读到，X 可能改了 tab 结构)"),
      "容器选择器命中: " + notifSelUsed,
      "命中数量: " + cells.length
    ];
    if (!cells.length) {
      lines.push("页面上 article 总数=" + matchAll("article", document.body).length +
        "  role=article 数=" + matchAll('[role="article"]', document.body).length +
        "  cellInnerDiv 数=" + matchAll('[data-testid="cellInnerDiv"]', document.body).length);
      return lines.join("\n");
    }

    var replyCells = 0, withHandles = 0, withMe = 0;
    var n = Math.min(cells.length, limit || 25);
    for (var i = 0; i < n; i++) {
      var c = cells[i];
      var txt = (c.textContent || "").replace(/\s+/g, " ").trim();
      var isRep = isReplyNotification(txt);
      var links = atHandleLinks(c);
      var hasMe = txt.indexOf("@" + DATA.me) >= 0;
      if (isRep) replyCells++;
      if (links.length) withHandles++;
      if (hasMe) withMe++;
      lines.push(
        (i + 1) + ". " + (isRep ? "[回复✓]" : "[  --  ]") +
        " @链接" + links.length + (hasMe ? " 含@我" : "") +
        " | " + txt.slice(0, 72)
      );
      if (isRep && links.length) {
        lines.push("      发起者=" + handleOfLink(links[0]) +
          "  对象=" + links.slice(1).map(handleOfLink).join(",") +
          "  永久链=" + (firstStatusId(c) || "(无)"));
      }
    }
    if (cells.length > n) lines.push("（另有 " + (cells.length - n) + " 条未列出）");

    lines.push("");
    lines.push("汇总: " + cells.length + " 条里 判定为回复通知 " + replyCells + " 条 / 带 @handle 链接 " +
      withHandles + " 条 / 文本含 @" + DATA.me + " 的 " + withMe + " 条");

    // 容器无关那条路单独报数，好判断是容器问题还是识别问题
    var flatBefore = flatScanInfo.actions;
    scanNotificationsFlat(document.body);
    lines.push("容器无关扫描: 找到「回复」标签 " + flatScanInfo.actions + " 个, 认出发起人 " +
      flatScanInfo.actors.length + " 个" + (flatScanInfo.actors.length ? "（" + flatScanInfo.actors.slice(0, 8).map(function (a) { return "@" + a; }).join(" ") + "）" : "") +
      ", 因未提及 @" + DATA.me + " 跳过 " + flatScanInfo.skippedNoMe + " 个");

    if (!replyCells && !flatScanInfo.actions) {
      lines.push("");
      lines.push("判定：这一屏里确实没有回复类通知（两条独立路径都为 0）。");
      lines.push("  可能你停在「" + (tab || "优先") + "」标签，或回复通知还没加载出来。");
      lines.push("  请切到「全部」或「提及」标签、往下滚一屏，再点「重新扫描」。");
    } else if (replyCells && !withHandles) {
      lines.push("");
      lines.push("判定：认出了回复通知，但取不到 @handle 链接 —— X 改了 handle 的渲染方式。");
      lines.push("  请把上面某条 [回复✓] 的完整原文贴出来，我按真实结构改提取方式。");
    } else if (!replyCells && flatScanInfo.actions) {
      lines.push("");
      lines.push("判定：容器路径认不出，但容器无关路径认出了 —— 已在用后者记账，属正常。");
    }
    return lines.join("\n");
  }

  // 被动扫描 + 可见反馈。原来所有记账都是静默的，用户完全无从判断到底有没有在工作，
  // 只能反复打开面板看数字 —— 这是「感觉不好使」的一大来源。
  var lastScanToast = 0;
  function passiveScan(root) {
    if (!CFG.trackInteractions || !DATA.me) return;
    // 自动下滑扫描期间完全让路：autoScanStep 每轮已全量扫过，这里再扫是重复劳动；
    // 更要命的是 renderPanel() 会重建 panelBody，把进度条和「停止」按钮一起冲掉。
    if (autoScanState.running) return;
    var scope = root || document.body;
    var a = scanMyReplies(scope);
    var b = scanNotifications(scope);
    var c = scanThreadReplies();
    var m = scanConversationModules(scope);
    var total = a + b + c + m.inn + m.out;
    if (panelOpen && tabState !== "diag") renderPanel();
    if (!total) return;
    var now = Date.now();
    if (now - lastScanToast < 8000) return;      // 节流，别刷屏
    lastScanToast = now;
    var parts = [];
    if (a + m.out) parts.push("你回TA +" + (a + m.out));
    if (b + c + m.inn) parts.push("TA回你 +" + (b + c + m.inn));
    toast("互动数据已更新：" + parts.join("，"), "ok", 2800);
  }

  // ---------- 自动下滑扫描 ----------
  // X 用虚拟列表，滚过去的节点会被卸载，所以必须边走边记，不能滚到底再扫。
  var autoScanState = { running: false, stop: false, rounds: 0, out: 0, inn: 0, max: 0, reason: "", moved: 0, scroller: "" };
  var scanProgressEl = null, scanStopBtn = null, scanGoBtn = null;

  // 进度计数不能靠累加各扫描函数的返回值：MutationObserver 管线也在并发记账，
  // 它的增量进不到 autoScanState，数字会两头都不准（实测同一场景一次 22>18、一次 2<8）。
  // 唯一可靠的口径是「扫描前后存储总数的差值」，与谁记的账无关。
  function countAll() {
    var a = acct();
    var o = 0, i = 0, ppl = 0;
    if (a) {
      var hs = a.handles;
      Object.keys(hs).forEach(function (h) {
        o += (hs[h].out || []).length;
        i += (hs[h].inn || []).length;
        ppl++;
      });
    }
    return { out: o, inn: i, people: ppl };
  }

  // 不能假设滚动发生在 window 上。X 各版本/各布局可能是 window，也可能是内层容器。
  // 所以：先试 window，测出 scrollY 没动就去找真正能滚的祖先容器，并记住它。
  var cachedScroller = null;

  function findScroller() {
    if (cachedScroller && cachedScroller.isConnected &&
      cachedScroller.scrollHeight > cachedScroller.clientHeight + 8) return cachedScroller;
    var cands = [];
    ['[data-testid="primaryColumn"]', "main", '[role="main"]', '[data-testid="sidebarColumn"]']
      .forEach(function (s) { var n = $(s); if (n) cands.push(n); });
    // 再从 primaryColumn 往上找可滚祖先
    var pc = $('[data-testid="primaryColumn"]');
    for (var p = pc && pc.parentElement; p && p !== document.body; p = p.parentElement) cands.push(p);
    // 兜底：全页扫一遍，找最高的可滚容器
    if (!cands.length) cands = $$("div").slice(0, 400);
    var best = null;
    cands.forEach(function (n) {
      if (!n || n === document.body || n === document.documentElement) return;
      if (n.scrollHeight <= n.clientHeight + 8) return;
      var ov = window.getComputedStyle(n).overflowY;
      if (ov !== "auto" && ov !== "scroll") return;
      if (!best || n.scrollHeight > best.scrollHeight) best = n;
    });
    cachedScroller = best;
    return best;
  }

  function docHeight() {
    return Math.max(
      document.body ? document.body.scrollHeight : 0,
      document.documentElement ? document.documentElement.scrollHeight : 0
    );
  }

  // 返回是否真的滚动了。滚不动是关键诊断信息，不能默默当成「到底了」。
  function scrollDown(step) {
    var y0 = window.scrollY || window.pageYOffset || 0;
    try { window.scrollBy(0, step); } catch (e) {}
    var y1 = window.scrollY || window.pageYOffset || 0;
    if (y1 !== y0) { autoScanState.scroller = "window"; return true; }

    var sc = findScroller();
    if (sc) {
      var t0 = sc.scrollTop;
      try { sc.scrollTop = t0 + step; } catch (e) {}
      if (sc.scrollTop !== t0) {
        autoScanState.scroller = (sc.getAttribute("data-testid") || sc.tagName.toLowerCase()) + " (内层容器)";
        return true;
      }
      autoScanState.scroller = (sc.getAttribute("data-testid") || sc.tagName.toLowerCase()) + " (滚不动)";
      return false;
    }
    // 最后兜底：滚 documentElement
    var d0 = document.documentElement.scrollTop;
    try { document.documentElement.scrollTop = d0 + step; } catch (e) {}
    if (document.documentElement.scrollTop !== d0) { autoScanState.scroller = "documentElement"; return true; }
    autoScanState.scroller = "无（window / 内层容器 / documentElement 都滚不动）";
    return false;
  }

  function autoScanStep() {
    // 每一轮都全量扫一次当前 DOM：新加载的要记，尚未卸载的也要能补记
    scanMyReplies(document.body);
    scanConversationModules(document.body);
    scanNotifications(document.body);
    scanThreadReplies();
  }

  function paintScanProgress() {
    var st = autoScanState;
    if (scanProgressEl) {
      if (st.running) {
        scanProgressEl.textContent = "第 " + st.rounds + "/" + st.max + " 轮 · 已滚 " + st.moved + " 屏 · 新增 你回TA " +
          st.out + " / TA回你 " + st.inn + (st.scroller ? " · 滚动方式 " + st.scroller : "");
      } else if (st.rounds) {
        scanProgressEl.textContent = (st.reason ? "已停止（" + st.reason + "）· " : "") +
          "共 " + st.rounds + " 轮 / 滚了 " + st.moved + " 屏 · 新增 你回TA " + st.out + " / TA回你 " + st.inn;
      } else {
        scanProgressEl.textContent = "「立即扫描」只处理当前已加载的内容。补历史用「继续下滑扫描」：从当前位置往下滚，最多 " +
          clamp(parseInt(CFG.scanRoundsMax, 10) || 40, 3, 400) + " 轮 / 每轮 " +
          (clamp(parseInt(CFG.scanStepMs, 10) || 900, 250, 5000)) + "ms，可随时停止。扫完停在原地，再点一次接着往下，不回头重扫。";
      }
    }
    if (scanStopBtn) scanStopBtn.style.display = st.running ? "" : "none";
    if (scanGoBtn) {
      scanGoBtn.disabled = st.running;
      scanGoBtn.textContent = st.running ? "扫描中…" : "继续下滑扫描";
    }
  }

  function stopAutoScan(reason) {
    if (!autoScanState.running) return;
    autoScanState.stop = true;
    autoScanState.reason = reason || "手动停止";
  }

  function autoScan() {
    if (autoScanState.running) return Promise.resolve(autoScanState);
    if (!CFG.trackInteractions || !DATA.me) {
      toast(!DATA.me ? "还没认到你的账号，先解决这个再扫" : "互动追踪是关的", "err", 4000);
      return Promise.resolve(autoScanState);
    }
    var max = clamp(parseInt(CFG.scanRoundsMax, 10) || 40, 3, 400);
    var stepMs = clamp(parseInt(CFG.scanStepMs, 10) || 900, 250, 5000);
    var base = countAll();                       // 起点快照，进度按差值算
    var h0 = docHeight();
    autoScanState = { running: true, stop: false, rounds: 0, out: 0, inn: 0, max: max, reason: "", moved: 0, scroller: "", h0: h0, endY: 0 };
    var lastH = -1, stagnant = 0, noMove = 0;
    paintScanProgress();

    return new Promise(function (resolve) {
      var sync = function () {
        var now = countAll();
        autoScanState.out = Math.max(0, now.out - base.out);
        autoScanState.inn = Math.max(0, now.inn - base.inn);
      };
      var finish = function (reason) {
        var st = autoScanState;
        st.running = false;
        if (reason) st.reason = reason;
        sync();
        // 故意不滚回顶部：滚回去下次又得从头再扫一遍已经扫过的内容，
        // 而且 X 的虚拟列表会把滚过的节点卸载，来回滚纯属浪费。
        // 停在原地，下次点「继续下滑」直接接着往下走。
        st.endY = window.scrollY || 0;
        markDirty();
        paintScanProgress();
        toast("扫描结束（" + st.reason + "）：本次滚了 " + st.moved + " 屏，你回TA +" + st.out + "，TA回你 +" + st.inn +
          "。停在当前位置，可继续下滑。", (st.out + st.inn) ? "ok" : "", 5200);
        if (panelOpen && tabState === "stats") renderPanel();
        resolve(st);
      };
      var step = function () {
        var st = autoScanState;
        if (st.stop) { finish(st.reason || "手动停止"); return; }
        if (st.rounds >= max) { finish("达到轮数上限 " + max); return; }
        st.rounds++;
        autoScanStep();
        sync();
        paintScanProgress();

        var step0 = Math.round(window.innerHeight * 0.85);
        var moved = scrollDown(step0);
        if (moved) { st.moved++; noMove = 0; } else if (++noMove >= 2) {
          // 滚不动 ≠ 到底。这是最常见的失效原因，必须如实报出来而不是谎称到底了。
          finish("滚不动（" + st.scroller + "）——页面可能用的是内层滚动容器，或已经在最底部");
          return;
        }

        // 真的到底了：贴着底 + 高度连续几轮不再增长
        var h = docHeight();
        var pos = window.scrollY + window.innerHeight;
        var sc = findScroller();
        if (sc) pos = Math.max(pos, sc.scrollTop + sc.clientHeight);
        var nearBottom = pos >= h - 400;
        if (nearBottom && h === lastH) { if (++stagnant >= 3) { finish("已到页面底部，没有更多内容"); return; } }
        else stagnant = 0;
        lastH = h;

        setTimeout(step, stepMs);
      };
      step();
    });
  }

  // 手动触发 + 诊断用：跑一遍全部扫描，把过程数据回给面板显示
  function scanNow() {
    detectMe();
    var arts = matchAll('article[data-testid="tweet"]', document.body);
    var mine = 0, withTarget = 0, targets = [];
    arts.forEach(function (a) {
      if (authorOf(a) !== DATA.me) return;
      mine++;
      var t = replyTargets(a);
      if (t.length) { withTarget++; t.forEach(function (h) { if (targets.indexOf(h) < 0) targets.push(h); }); }
    });
    var onNotif = location.pathname.indexOf("/notifications") === 0;
    var addedNotif = scanNotifications(document.body);
    return {
      me: DATA.me || "",
      meHow: meHow || "（还没跑过识别）",
      page: location.pathname,
      articles: arts.length,
      nestedArticles: arts.filter(function (a) { return a.parentElement && a.parentElement.closest("article"); }).length,
      mineArticles: mine,
      withTarget: withTarget,
      targets: targets,
      onNotifications: onNotif,
      notifSel: onNotif ? notifSelUsed : "",
      notifCells: onNotif ? notifCells(document.body).length : 0,
      flatActions: flatScanInfo.actions || 0,
      flatActors: flatScanInfo.actors || [],
      flatSkipped: flatScanInfo.skippedNoMe || 0,
      addedOut: scanMyReplies(document.body),
      addedNotif: addedNotif,
      addedThread: scanThreadReplies(),
      addedConv: scanConversationModules(document.body),
      convCells: convCellStats(document.body),
      api: {
        msgs: apiStats.msgs, tweets: apiStats.tweets, out: apiStats.outAdded, inn: apiStats.inAdded,
        unknownUser: apiStats.unknownUser, unresolvedAuthor: apiStats.unresolvedAuthor,
        pending: apiStats.pending, lastAt: apiStats.lastAt, myId: DATA.myId || "",
        ids: Object.keys(idMap()).length, sample: apiStats.sample
      },
      editors: editorDiag(),
      articleAnatomy: articleAnatomy(2),
      notifAnatomy: onNotif ? notifAnatomy(3) : "（不在通知页）"
    };
  }

  // ==================== 来自 X 自身 GraphQL 响应的权威回复关系 ====================
  // DOM 挖不出回复对象（v2.10.1 实测：链接全指向自己、无「回复」文案、cellInnerDiv 每格只 1 条），
  // 但 X 自己的接口响应里每条推文都带 in_reply_to_status_id_str / in_reply_to_user_id_str。
  // intercept.js 在 MAIN world 被动观察页面自己发的请求，把关系 postMessage 过来。
  //
  // 安全：MAIN world 的内容可被页面脚本影响，所以这里把所有输入当不可信数据校验，
  // 只接受严格的 handle 字符集和长度，数量也设上限。
  var API_MARK = "__xrh_api__";
  var apiStats = {
    msgs: 0, tweets: 0, outAdded: 0, inAdded: 0, lastAt: 0,
    unknownUser: 0, unresolvedAuthor: 0, pending: 0, sample: null
  };

  function safeHandle(v) {
    var s = String(v == null ? "" : v).toLowerCase();
    return /^[a-z0-9_]{1,15}$/.test(s) ? s : "";
  }
  function safeId(v) {
    var s = String(v == null ? "" : v);
    return /^\d{1,25}$/.test(s) ? s : "";
  }

  function idMap() {
    if (!DATA.ids || typeof DATA.ids !== "object") DATA.ids = {};
    return DATA.ids;
  }

  var IDS_MAX = 8000;      // userId→用户名 映射总量上限（旧代码的 4000 是「单次调用新增数」，等于没有上限）

  function learnUsers(users) {
    if (!users || typeof users !== "object") return;
    var m = idMap(), added = 0;
    var keys = Object.keys(users);
    for (var i = 0; i < keys.length; i++) {
      if (Object.keys(m).length >= IDS_MAX) {
        // 满了就淘汰一半。这个映射只是缓存，丢了还能从后续响应里重新学，
        // 但放着不管会让 DATA 无限膨胀，每次保存都要全量序列化。
        var mk = Object.keys(m);
        for (var d = 0; d < Math.ceil(mk.length / 2); d++) delete m[mk[d]];
        markDirty();
      }
      var sid = safeId(keys[i]), sh = safeHandle(users[keys[i]]);
      if (!sid || !sh) continue;
      if (m[sid] !== sh) { m[sid] = sh; added++; }
    }
    if (added) markDirty();
  }

  function nameOf(userId) {
    var sid = safeId(userId);
    return sid ? (idMap()[sid] || "") : "";
  }

  // 认出「我的 userId」。三条路，任何一条成立即可：
  //   1) 接口直接上报的 data.user.result / viewer（个人页、with_replies 响应里有）
  //   2) userId→用户名 映射里反查等于我的 handle 的那一项（最通用）
  //   3) 某条推文的作者是我，取它的 authorId（旧办法，要求正好刷到自己发的回复）
  function learnMyId(tweets, meHints) {
    if (DATA.myId || !DATA.me) return;
    if (Array.isArray(meHints)) {
      for (var i = 0; i < meHints.length && i < 20; i++) {
        var m = meHints[i];
        if (!m || typeof m !== "object") continue;
        if (safeHandle(m.screenName) === DATA.me) {
          var hid = safeId(m.id);
          if (hid) { DATA.myId = hid; markDirty(); return; }
        }
      }
    }
    var m2 = idMap();
    for (var id in m2) {
      if (!Object.prototype.hasOwnProperty.call(m2, id)) continue;
      if (m2[id] === DATA.me) { DATA.myId = safeId(id) || id; markDirty(); return; }
    }
    if (Array.isArray(tweets)) {
      for (var j = 0; j < tweets.length && j < 400; j++) {
        var t = tweets[j];
        if (!t || typeof t !== "object") continue;
        if (safeHandle(t.author) === DATA.me) {
          var aid = safeId(t.authorId);
          if (aid) { DATA.myId = aid; markDirty(); return; }
        }
      }
    }
  }

  // 冷启动时 userId→用户名 映射还没建好，先记下待解析的关系，
  // 之后每来一批新数据就重试一次。否则最早那几百条会永久丢失。
  var pendingOut = [];      // {rtu, rts, tid}
  var PENDING_MAX = 600;

  function flushPending() {
    if (!pendingOut.length || !DATA.me) return 0;
    var still = [], added = 0;
    for (var i = 0; i < pendingOut.length; i++) {
      var p = pendingOut[i];
      var target = nameOf(p.rtu);
      if (!target) { if (still.length < PENDING_MAX) still.push(p); continue; }
      if (target === DATA.me) continue;
      if (recordOut(target, p.rts ? ("p:" + p.rts) : (p.tid ? ("r:" + p.tid) : ""))) added++;
    }
    pendingOut = still;
    return added;
  }

  function ingestApiTweets(users, tweets, meHints, sample) {
    if (!CFG.trackInteractions) return;
    learnUsers(users);
    if (sample && typeof sample === "object") apiStats.sample = sample;
    apiStats.msgs++;
    apiStats.lastAt = Date.now();

    // 先认出自己的 userId，再处理推文：否则「别人回复了我」这一向永远判不出来
    learnMyId(Array.isArray(tweets) ? tweets : null, meHints);

    var addedOut = 0, addedIn = 0;
    if (Array.isArray(tweets)) {
      var limit = Math.min(tweets.length, 400);
      for (var i = 0; i < limit; i++) {
        var t = tweets[i];
        if (!t || typeof t !== "object") continue;
        apiStats.tweets++;

        var tid = safeId(t.id);
        var rts = safeId(t.replyToStatus);
        var rtu = safeId(t.replyToUser);
        if (!rts && !rtu) continue;                        // 不是回复，跳过

        // 作者：优先用接口给的 screen_name，其次用 authorId 查映射
        var authorId = safeId(t.authorId);
        var author = safeHandle(t.author) || nameOf(authorId);

        // 方向一：我回复了别人 => 你回TA
        var isMine = (DATA.me && author === DATA.me) || (DATA.myId && authorId && authorId === DATA.myId);
        if (isMine) {
          if (!rtu || rtu === DATA.myId) continue;
          // v2.12 实测：legacy.in_reply_to_screen_name 直接给出回复对象的用户名，
          // 比依赖 userId→用户名 映射可靠得多（映射冷启动时是空的，会丢最早那批数据）。
          var target = safeHandle(t.replyToScreen) || nameOf(rtu);
          if (!target) {
            // 映射还没学到这个人，挂进待解析队列，后面的批次会补上
            apiStats.unknownUser++;
            if (pendingOut.length < PENDING_MAX) pendingOut.push({ rtu: rtu, rts: rts, tid: tid });
            continue;
          }
          if (target === DATA.me) continue;
          // 键与 DOM 路径、发送钩子完全一致，多路看到同一次互动只算一次
          if (recordOut(target, rts ? ("p:" + rts) : (tid ? ("r:" + tid) : ""))) addedOut++;
          continue;
        }

        // 方向二：别人回复了我 => TA回你
        if (DATA.myId && rtu === DATA.myId && author && author !== DATA.me) {
          if (recordIn(author, inKey(tid, author, ""))) addedIn++;
        } else if (!author && authorId) {
          apiStats.unresolvedAuthor++;
        }
      }
    }

    // 映射可能刚被这批数据补全，回头把积压的待解析项冲一遍
    addedOut += flushPending();

    apiStats.pending = pendingOut.length;
    if (addedOut || addedIn) {
      apiStats.outAdded += addedOut;
      apiStats.inAdded += addedIn;
      markDirty();
      var now = Date.now();
      if (now - lastScanToast > 8000) {
        lastScanToast = now;
        var parts = [];
        if (addedOut) parts.push("你回TA +" + addedOut);
        if (addedIn) parts.push("TA回你 +" + addedIn);
        toast("互动数据已更新（来自 X 接口）：" + parts.join("，"), "ok", 3000);
      }
      if (panelOpen && tabState !== "diag" && !autoScanState.running) renderPanel();
    }
  }

  function bindApiBridge() {
    window.addEventListener("message", function (e) {
      // 只接受本窗口、本源的、带我们标记的消息
      if (e.source !== window) return;
      if (e.origin && e.origin !== location.origin) return;
      var d = e.data;
      if (!d || typeof d !== "object" || d.__xrh !== API_MARK) return;
      try {
        if (d.type === "tweets") ingestApiTweets(d.users, d.tweets, d.me, d.sample);
        // 注入脚本刚装好，来问一声当前是否已同意 —— 它可能比 content.js 先就绪
        else if (d.type === "hello") pushFollowCtl();
        else if (d.type === "followEvt") recordFollowEvent(d.event);
        else if (d.type === "followRel") recordFollowRel(d.users);
      } catch (err) {}
    });
  }

  // ==================== 关注追踪 ====================
  // 算法移植自 mikuairai/follow-counter（MIT，Copyright (c) 2026 mikuairai）。
  // 只记录、不代操作：这里不会替你关注或取关任何人，读的全是页面自己已经发出的请求。
  var CTL_MARK = "__xrh_ctl__";
  var followFilter = "all";
  var followBadgeEl = null;
  var followBadgeTimer = null;

  function F() {
    if (!DATA.follow || typeof DATA.follow !== "object") DATA.follow = newFollowState();
    return DATA.follow;
  }

  // 双重门：总开关 + 数据说明的同意记录。任一不满足，注入层一个关注响应都不读。
  function followEnabled() {
    return !!CFG.followTrack && !!(X.FSTATS && X.FSTATS.hasConsent(F().consent));
  }

  function pushFollowCtl() {
    try { window.postMessage({ __xrhCtl: CTL_MARK, on: followEnabled() }, location.origin); } catch (e) {}
  }

  function followStats() {
    return X.FSTATS.compute(F().events, Date.now(), 0);
  }
  function followSettings() {
    return { roundSize: Number(CFG.followRoundSize) || 0 };
  }

  function keyOf(name) {
    var k = String(name || "").toLowerCase();
    return /^[a-z0-9_]{1,15}$/.test(k) ? k : "";
  }

  // ---------- 记账：关注 / 取关事件 ----------
  function recordFollowEvent(ev) {
    // 纵深防御：注入层已按同意门控过滤，这里再挡一道，伪造消息进不来
    if (!ev || !followEnabled()) return;
    var f = F();
    var now = ev.ts || Date.now();
    var key = keyOf(ev.user);
    var wasCooling = !!followStats().cooling;

    if (ev.type === "follow" && ev.ok && key) {
      var src = X.FSTATS.sourceOf(ev.path);
      var prev = f.follows[key];
      f.follows[key] = {
        ts: now, src: src.cat, via: src.via,
        // 之前已经知道回关状态的别丢，否则一次重新关注就把已知信息抹掉
        fb: prev ? prev.fb : null, fbAt: prev ? prev.fbAt : null,
        unfollowedAt: null
      };
      f.following[key] = { name: key, fb: prev ? prev.fb : null, seenAt: now };
    }

    if (ev.type === "unfollow" && ev.ok && key) {
      var rec = f.follows[key];
      // 持有了多久 = churn 判定的依据（X 禁止「关注后短期取关」涨粉）
      if (rec && rec.ts) ev.heldMs = now - rec.ts;
      if (rec) rec.unfollowedAt = now;
      if (f.following[key]) delete f.following[key];
    }

    f.events.push(ev);
    f.events = X.FSTATS.prune(f.events, now);
    f.follows = X.FSTATS.pruneFollows(f.follows, now);
    markDirty();

    // 撞限：这一下最该提醒，因为它意味着再点就是白点
    if (ev.limit) {
      var st = followStats();
      var w = st.lastLimitWindows || {};
      toast("撞到关注限制了。撞限前 15 分钟内成功关注了 " + (w.m15 != null ? w.m15 : "?") +
        " 个（1 小时 " + (w.h1 != null ? w.h1 : "?") + " 个）。先歇着，别再点了。" +
        (ev.message ? "\nX 的原话：" + String(ev.message).slice(0, 120) : ""), "err", 9000);
    } else if (ev.type === "follow" && ev.ok && wasCooling) {
      var best = followStats().bestKnownCooldown;
      if (best) toast("冷却结束，又能关注了。这次从最后一次成功关注算起等了 " + X.FSTATS.formatDuration(best), "ok", 6000);
    }

    // 快取关提醒
    if (ev.type === "unfollow" && ev.ok && ev.heldMs != null && ev.heldMs < X.FSTATS.CONST.QUICK_UNFOLLOW_MS) {
      var ch = X.FSTATS.churn(f.events, now);
      if (ch.level !== "ok") {
        toast("这次取关距关注只有 " + X.FSTATS.formatDuration(ev.heldMs) + "。X 明确禁止 follow churn" +
          "（大量关注后取关涨粉），24 小时内已有 " + ch.quick24h + " 次这种快取关" +
          (ch.level === "high" ? "，数量已经偏多，建议今天到此为止" : "") + "。", "err", 9000);
      }
    }

    updateFollowBadge();
    if (panelOpen && tabState === "follow") renderPanel();
  }

  // ---------- 记账：从页面自己的响应里读回关关系 ----------
  function recordFollowRel(users) {
    if (!Array.isArray(users) || !users.length || !followEnabled()) return;
    var f = F();
    var now = Date.now();
    var changed = false;
    var MAX_FOLLOWING = 5000;

    for (var i = 0; i < users.length; i++) {
      var u = users[i];
      var key = keyOf(u.name);
      if (!key || key === DATA.me) continue;

      // following：你正在关注的人。f 为 false 是明确的「没关注」，可以从名单里摘掉
      if (u.f === true) {
        var cur = f.following[key];
        if (!cur || cur.fb !== u.fb) { f.following[key] = { name: key, fb: u.fb === true, seenAt: now }; changed = true; }
        else if (now - (cur.seenAt || 0) > 60000) { cur.seenAt = now; }
      } else if (u.f === false && f.following[key]) {
        delete f.following[key];
        changed = true;
      }

      // 回关状态回填到自己记录过的关注上。
      // 这里不排除已取关的记录：fb 表示「对方关不关注你」，跟你有没有关注 TA 无关，
      // 是独立的事实。而且重新关注同一个人时 recordFollowEvent 会沿用 prev.fb ——
      // 若在此跳过，「关注→取关→再关注」就会把本来已知的回关状态抹成未知。
      var tr = f.follows[key];
      if (tr && tr.fb !== (u.fb === true)) {
        tr.fb = u.fb === true;
        if (tr.fb) tr.fbAt = now;
        changed = true;
      }
    }

    // 上限保护：按最近看到的时间留最新的
    var ks = Object.keys(f.following);
    if (ks.length > MAX_FOLLOWING) {
      ks.sort(function (a, b) { return (f.following[a].seenAt || 0) - (f.following[b].seenAt || 0); })
        .slice(0, ks.length - MAX_FOLLOWING)
        .forEach(function (k) { delete f.following[k]; });
      changed = true;
    }

    if (changed) {
      markDirty();
      updateFollowBadge();
      if (panelOpen && tabState === "follow") renderPanel();
    }
  }

  // ---------- 同意 ----------
  function grantFollowConsent() {
    F().consent = { v: X.FSTATS.CONSENT_VERSION, at: Date.now() };
    markDirty();
    pushFollowCtl();
    toast("已开始记录关注/取关。数据只存在这台电脑的浏览器里。", "ok", 5000);
    renderPanel();
  }

  function revokeFollowConsent() {
    F().consent = null;
    pushFollowCtl();     // 立刻让注入层停手，在途读取也会因 generation 变化作废
    markDirty();
    renderPanel();
  }

  function clearFollowData() {
    var c = F().consent;
    DATA.follow = newFollowState();
    DATA.follow.consent = c;   // 清数据不等于撤回同意，两件事分开
    markDirty();
    updateFollowBadge();
    renderPanel();
  }

  // ---------- 悬浮计数角标（默认关）----------
  function updateFollowBadge() {
    var want = !!CFG.followShowBadge && followEnabled();
    if (!want) { if (followBadgeEl) { followBadgeEl.remove(); followBadgeEl = null; } return; }
    var st = followStats();
    var b = X.FSTATS.iconBadge(st, followSettings());
    var ph = X.FSTATS.phase(st, followSettings());
    if (!host) return;
    if (!followBadgeEl) {
      followBadgeEl = el("div", { cls: "fbadge", attrs: { role: "status", "aria-live": "polite" } });
      followBadgeEl.addEventListener("click", function () { openPanel("follow"); });
      host.appendChild(followBadgeEl);
    }
    followBadgeEl.style.background = b.color;
    followBadgeEl.textContent = b.text || "0";
    followBadgeEl.title = phaseTitle(ph, st);
  }

  function phaseTitle(ph, st) {
    var FS = X.FSTATS;
    var head = "本轮已关注 " + ph.done + " / " + ph.size + "（额度来源：" + ph.from + "）";
    if (ph.name === "cooling") {
      return head + "\n撞限冷却中，已等 " + FS.formatDuration(st.cooling.elapsed) +
        (st.bestKnownCooldown ? "\n上次等 " + FS.formatDuration(st.bestKnownCooldown) + " 后恢复" : "\n还没有可参考的恢复时长") +
        "\n点击查看详情";
    }
    if (ph.name === "ready") return head + "\n等够了，可以再关注一批\n点击查看详情";
    if (ph.name === "full") return head + "\n本轮额度用完，歇一会儿再关注\n点击查看详情";
    if (ph.name === "near") return head + "\n快到额度了，注意节奏\n点击查看详情";
    if (st.rest && st.rest.elapsed > 0) return head + "\n距上次关注 " + FS.formatDuration(st.rest.elapsed) + "，满 " + FS.formatDuration(st.rest.reset) + " 开新一轮\n点击查看详情";
    return head + "\n点击查看详情";
  }

  function startFollowBadgeTimer() {
    if (followBadgeTimer) clearInterval(followBadgeTimer);
    // 冷却/休息是按时间推进的，不刷新角标就会停在旧数字上
    followBadgeTimer = setInterval(function () {
      if (!followEnabled()) { if (followBadgeEl) { followBadgeEl.remove(); followBadgeEl = null; } return; }
      if (CFG.followShowBadge) updateFollowBadge();
      else if (followBadgeEl) { followBadgeEl.remove(); followBadgeEl = null; }
      if (panelOpen && tabState === "follow") renderPanel();
    }, 30000);
  }

  // ==================== 徽章 ====================
  function stateOf(v) {
    var o = (v && v.out ? v.out.length : 0), i = (v && v.inn ? v.inn.length : 0);
    if (o > 0 && i > 0) return { s: "mutual", a: "⬌", o: o, i: i };
    if (o > 0) return { s: "out", a: "→", o: o, i: i };
    if (i > 0) return { s: "in", a: "←", o: o, i: i };
    return { s: "none", a: "·", o: 0, i: 0 };
  }

  // 互动徽章上的「今天还没互动过」小点。
  // 判据用 handles[h].ts —— 那是 recordOut/recordIn 在「真的新增了一条互动」时才刷新的时间戳，
  // 所以它等于「最后一次真互动」，不是「最后一次被扫到」。被动扫描反复读到同一批数据不会把它顶新。
  function dayKey(t) {
    var d = new Date(t);
    return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  }
  function isToday(ts) {
    return !!ts && dayKey(ts) === dayKey(Date.now());
  }
  function agoText(ts) {
    if (!ts) return "没有记录";
    var ms = Date.now() - ts;
    if (isToday(ts)) return "今天 " + new Date(ts).toTimeString().slice(0, 5);
    if (ms < 48 * 3600 * 1000) return "昨天";
    return Math.round(ms / 86400000) + " 天前";
  }

  // X 的虚拟列表会复用 DOM 节点。原代码「已有徽章就 return」会把上一个人的数据
  // 显示在当前人身上，这里改成按 handle 比对并原地更新。
  function badgeArticle(art) {
    if (!CFG.trackInteractions) return;
    var nr = art.querySelector('[data-testid="User-Name"]');
    if (!nr) return;
    var a = DATA.me && acct() ? acct().handles : {};
    var h = handleFromEl(nr.querySelector('a[role="link"][href^="/"]'));
    var badge = null;
    for (var i = 0; i < nr.children.length; i++) if (nr.children[i].classList.contains("xrh-badge")) badge = nr.children[i];

    if (!h || h === DATA.me) { if (badge) badge.remove(); return; }
    var st = stateOf(a[h]);
    if (st.s === "none") { if (badge) badge.remove(); return; }

    var v = a[h] || {};
    var stale = !isToday(v.ts);
    var label = st.a + st.o + "|" + st.i;
    var key = label + (stale ? "|s" : "");
    if (badge && badge.dataset.h === h && badge.dataset.k === key) return;
    if (!badge) { badge = el("span", { cls: "xrh-badge" }); nr.appendChild(badge); }
    badge.dataset.h = h;
    badge.dataset.k = key;
    badge.dataset.state = st.s;
    badge.textContent = "";
    badge.appendChild(document.createTextNode(label));
    if (stale) badge.appendChild(el("i", { cls: "xd" }));
    badge.title = "@" + h + "\n你回TA：" + st.o + " 次\nTA回你：" + st.i + " 次" +
      "\n上次互动：" + agoText(v.ts) +
      (stale ? "\n今天还没和 TA 互动过" : "\n今天已经互动过了");
  }


  function badgesIn(root) {
    if (!CFG.trackInteractions || !DATA.me) return;
    matchAll('article[data-testid="tweet"]', root).forEach(badgeArticle);
  }

  // ==================== 未回关高亮 ====================
  // 时间线里根本没有「正在关注」按钮，原来那套启发式恒为 false。
  // 改成只在 /following 和 /followers 列表页做，那里有可靠的「关注了你」标记。
  var FOLLOW_TEXT = /^(关注了你|Follows you|Follow you|フォローされています)$/;

  function cellHasFollowsYou(cell) {
    var nodes = cell.querySelectorAll("span, div");
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.children.length) continue;
      var t = (n.textContent || "").trim();
      if (FOLLOW_TEXT.test(t)) return true;
      var al = n.getAttribute("aria-label");
      if (al && FOLLOW_TEXT.test(al.trim())) return true;
    }
    return false;
  }

  function followPageKind() {
    var p = location.pathname;
    if (/^\/[A-Za-z0-9_]{1,15}\/following(\/|$)/.test(p)) return "following";
    if (/^\/[A-Za-z0-9_]{1,15}\/(followers|verified_followers|mutual_followers)(\/|$)/.test(p)) return "followers";
    return "";
  }

  function markFollowCells(root) {
    var kind = followPageKind();
    if (!kind) return;
    matchAll('[data-testid="UserCell"], [data-testid="UserProfileUserListItem"]', root).forEach(function (cell) {
      var nr = cell.querySelector('[data-testid="User-Name"]');
      if (!nr) return;
      var h = handleFromEl(nr.querySelector('a[role="link"][href^="/"]'));
      if (!h || h === DATA.me) return;

      var mutual = cellHasFollowsYou(cell);
      // /following：没有「关注了你」= 对方没回关你
      // /followers：没有「关注了你」不可能（都关注你），改看关注按钮文案判断你是否回关
      var show = false, tagKind = "nofollow", tip = "";
      if (kind === "following") {
        show = !mutual;
        tagKind = "nofollow";
        tip = "你关注了 @" + h + "，但 TA 没有回关你";
      } else {
        var btnTxt = "";
        $$('[role="button"]', cell).forEach(function (b) {
          var t = (b.textContent || "").trim();
          if (/^(关注|Following|正在关注|Follow|Follows you)$/.test(t) && !btnTxt) btnTxt = t;
        });
        show = /^(关注|Follow)$/.test(btnTxt);
        tagKind = "pending";
        tip = "@" + h + " 关注了你，你还没回关";
      }

      var tag = null;
      for (var i = 0; i < nr.children.length; i++) if (nr.children[i].classList.contains("xrh-tag")) tag = nr.children[i];

      if (!show) { if (tag) tag.remove(); return; }
      if (tag && tag.dataset.h === h && tag.dataset.kind === tagKind) return;
      if (!tag) { tag = el("span", { cls: "xrh-tag" }); nr.appendChild(tag); }
      tag.dataset.h = h;
      tag.dataset.kind = tagKind;
      tag.textContent = tagKind === "nofollow" ? "未回关" : "待回关";
      tag.title = tip;
    });
  }

  function countFollowPage() {
    var kind = followPageKind();
    if (!kind) return null;
    var total = 0, marked = 0;
    matchAll('[data-testid="UserCell"], [data-testid="UserProfileUserListItem"]', document.body).forEach(function (cell) {
      total++;
      if (cell.querySelector(".xrh-tag")) marked++;
    });
    return total ? { kind: kind, total: total, marked: marked } : null;
  }

  // ==================== 界面汉化 ====================
  // 原来改 aria-label：破坏可访问性、被 React 覆盖、还和「未回关」的文案判断打架。
  // 改成只替换整段命中词典的可见文本节点，天然自限（翻成中文后就不再命中）。
  var ZH = {
    "Posts": "帖子", "Post": "发帖", "Replies": "回复", "Reply": "回复", "Replying to": "回复",
    "Highlights": "精选", "Media": "媒体", "Articles": "文章", "Likes": "喜欢", "Affiliates": "联盟",
    "Following": "正在关注", "Followers": "粉丝", "Follows you": "关注了你", "Follow": "关注",
    "Mutuals": "互相关注", "Joined": "加入时间", "Repost": "转帖", "Reposts": "转帖",
    "Quote": "引用", "Quotes": "引用", "Bookmark": "书签", "Bookmarks": "书签",
    "View": "浏览", "Views": "浏览", "Impressions": "曝光", "Engagements": "互动",
    "Profile visits": "主页访问", "New followers": "新粉丝", "Notifications": "通知",
    "Messages": "私信", "For you": "推荐", "Trending": "趋势", "More": "更多",
    "Send": "发送", "Drafts": "草稿", "Edit": "编辑", "Delete": "删除", "Block": "屏蔽",
    "Mute": "静音", "Report": "举报", "Copy link": "复制链接", "Subscribe": "订阅",
    "Show more": "展开", "Show less": "收起", "Home": "主页", "Explore": "探索",
    "Search": "搜索", "Settings": "设置", "Premium": "高级版", "Communities": "社群",
    "Verified": "认证", "Who to follow": "推荐关注", "Show this thread": "显示此帖子",
    "Read more": "阅读更多", "Translate post": "翻译帖子", "Add a comment": "添加评论",
    "Post your reply": "发布你的回复", "Not now": "暂时不要",
    "Turn on notifications": "打开通知", "Analytics": "数据分析", "Creator Studio": "创作者工作室",
    "Monetization": "变现", "Jobs": "职位", "Lists": "清单", "Topics": "话题"
  };

  var translatedParents = new WeakSet();

  function translateIn(root) {
    if (!root || !root.getElementsByTagName) return;
    var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        var v = n.nodeValue;
        if (!v) return NodeFilter.FILTER_REJECT;
        var t = v.trim();
        if (!t || ZH[t] === undefined) return NodeFilter.FILTER_REJECT;
        var p = n.parentElement;
        if (!p || translatedParents.has(p)) return NodeFilter.FILTER_REJECT;
        if (p.closest('[contenteditable="true"], textarea, input, script, style, .xrh-badge, .xrh-tag')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var hits = [];
    while (w.nextNode()) hits.push(w.currentNode);
    for (var i = 0; i < hits.length; i++) {
      var n = hits[i], t = n.nodeValue.trim();
      var lead = /^\s/.test(n.nodeValue) ? " " : "";
      var tail = /\s$/.test(n.nodeValue) ? " " : "";
      n.nodeValue = lead + ZH[t] + tail;
      if (n.parentElement) translatedParents.add(n.parentElement);
    }
  }

  // ==================== AI ====================
  function tweetTextOf(art) {
    var t = art && art.querySelector('[data-testid="tweetText"]');
    return t ? (t.textContent || "").trim() : "";
  }

  function authorOf(art) {
    return art ? handleFromEl(art.querySelector('[data-testid="User-Name"] a[role="link"][href^="/"]')) : "";
  }

  // 取这条推文自己的永久链 ID。
  // 不能简单用第一个 /status/ 链接：正文里的引用推文卡片也带 /status/，
  // 而且在时间戳之前，会把 ID 认成被引用那条。所以优先匹配作者自己的 handle。
  function ownStatusId(art, author) {
    var links = art ? art.querySelectorAll('a[href*="/status/"]') : [];
    var fallback = "";
    for (var i = 0; i < links.length; i++) {
      var pth = pathOf(links[i].getAttribute("href"));
      var id = statusIdFromPath(pth);
      if (!id) continue;
      if (author && handleFromPath(pth) === author) return id;
      if (!fallback) fallback = id;
    }
    return fallback;
  }

  // 只取正文配图和视频封面，排除头像(/profile_images/)、emoji(/emoji/)、卡片图(/card_img/)。
  // 白名单与 background.js 的 IMG_OK 保持一致，否则会在后台被静默丢掉。
  var IMG_PATH_OK = /(media|ext_tw_video_thumb|amplify_video_thumb|tweet_video_thumb)\//;
  // 实测：small(≈600px) 401 tokens / medium(≈1200px) 1480 tokens / 360px 会看错细节。
  // 默认 small 是速度与识别力的甜点；要读截图小字可在设置里调成 medium。
  var IMG_SIZES = { tiny: "small", small: "small", medium: "medium", large: "large" };

  function imagesOf(art) {
    if (!art) return [];
    var out = [], seen = {};
    $$("img", art).forEach(function (im) {
      var s = im.currentSrc || im.getAttribute("src") || "";
      if (!/^https:\/\/pbs\.twimg\.com\//.test(s)) return;   // 必须 https，且限定官方图床
      // 这里不能用 pathOf：图片 URL 带 ?format=jpg&name=small，new URL 会报 Invalid URL
      var pth = (/^https:\/\/pbs\.twimg\.com(\/[^?#]*)/.exec(s) || [, ""])[1];
      if (!IMG_PATH_OK.test(pth)) return;
      if (seen[s]) return;
      seen[s] = 1;
      var want = IMG_SIZES[CFG.imageSize] || "small";
      // X 的图 URL 形如 ...jpg?format=jpg&name=small；没有 name 参数时补上
      out.push(/[?&]name=/.test(s) ? s.replace(/([?&]name=)[^&]*/, "$1" + want) : s + (s.indexOf("?") < 0 ? "?" : "&") + "name=" + want);
    });
    return out;
  }

  // 用户攒下的备注（纯本地保存，不调模型）。下次生成时作为约束带进去。
  function notesFor(id) {
    var d = getDrafts(id);
    if (!d) return [];
    return d.items.map(function (i) { return i.note; }).filter(Boolean);
  }

  function likeCountOf(art) {
    var n = art && art.querySelector('[data-testid="like"] [data-testid="app-text-transition-container"], [data-testid="unlike"] [data-testid="app-text-transition-container"]');
    if (!n) return 0;
    var t = (n.textContent || "").trim();
    var v = parseFloat(t.replace(/[^\d.]/g, ""));
    if (!isFinite(v)) return 0;
    if (/万|w/i.test(t)) v *= 1e4;
    else if (/[kK千]/.test(t)) v *= 1e3;
    else if (/[mM百]/.test(t) && /百万|[mM]/.test(t)) v *= 1e6;
    return Math.round(v);
  }

  // 采集当前详情页评论区，作为「参考素材」喂给模型（不是回复对象）。
  // 只取主帖 DOM 顺序之后的 article —— 主帖之前的是父级线程（这条帖子回复的对象），
  // 不是评论，混进去会让 AI 搞不清在回谁。
  function collectThread() {
    var mainId = currentTweetId();
    if (!mainId) return null;
    var arts = matchAll('article[data-testid="tweet"]', document.body);
    if (!arts.length) return null;

    var mainEl = mainArticle() || arts[0];

    var main = { author: authorOf(mainEl), text: tweetTextOf(mainEl), images: imagesOf(mainEl) };
    var out = { main: main, replies: [], total: 0 };
    if (!CFG.useComments) return out;

    var raw = [], seen = {};
    for (var j = 0; j < arts.length; j++) {
      var a = arts[j];
      if (a === mainEl) continue;
      if (!(mainEl.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
      var t = tweetTextOf(a);
      if (!t || t.length < 2) continue;              // 纯图片/表情评论没有参考价值
      var au = authorOf(a);
      var k = au + "|" + normTxt(t).slice(0, 60);
      if (seen[k]) continue;
      seen[k] = 1;
      raw.push({ author: au, text: t, likes: likeCountOf(a), order: j });
    }
    out.total = raw.length;

    var cap = clamp(parseInt(CFG.maxComments, 10) || 12, 1, LIMITS.commentsMax);
    var picked = raw;
    if (raw.length > cap) {
      // 超出上限时优先留高赞评论（更能代表话题走向），再按原顺序还原对话流
      picked = raw.slice().sort(function (x, y) { return (y.likes - x.likes) || (x.order - y.order); })
        .slice(0, cap).sort(function (x, y) { return x.order - y.order; });
    }
    out.replies = picked;
    return out;
  }

  // 自动下滑加载更多评论（默认关闭，会动用户的滚动位置）
  function loadMoreReplies(rounds) {
    return new Promise(function (resolve) {
      rounds = parseInt(rounds, 10) || 0;
      if (rounds <= 0) { resolve(); return; }
      var y0 = window.scrollY, i = 0;
      var step = function () {
        if (i++ >= rounds) { window.scrollTo(0, y0); setTimeout(resolve, 320); return; }
        window.scrollBy(0, Math.round(window.innerHeight * 0.85));
        setTimeout(step, 850);
      };
      step();
    });
  }

  function prepareReplies() {
    if (!CFG.useComments || !currentTweetId()) return Promise.resolve([]);
    var rounds = CFG.autoScrollComments
      ? clamp(Math.ceil((parseInt(CFG.maxComments, 10) || 12) / 4), 1, 6)
      : 0;
    return loadMoreReplies(rounds).then(function () {
      var t = collectThread();
      return t ? t.replies : [];
    });
  }

  var generating = {};
  // 流式生成过程中的实时候选（还没落盘，只用于边生成边显示，第一条一到就能复制）
  var liveGen = null;

  function generateFor(ctx, btn, onDone, opts) {
    opts = opts || {};
    if (!ctx) { onDone && onDone({ ok: false, error: "没有上下文" }); return; }
    if (generating[ctx.id + (opts.refine ? ":r" : "")]) { onDone && onDone({ ok: false, error: "这条正在生成中" }); return; }
    if (!CFG.apiKey) {
      if (!opts.silent) toast("先点插件图标填 API Key", "err");
      onDone && onDone({ ok: false, code: "no_key", error: "未配置 API Key" });
      return;
    }
    var hasText = ctx.src && ctx.src.length >= 3;
    var hasImg = !!(ctx.images && ctx.images.length && CFG.useVision !== false);
    // 纯图片帖以前直接放弃；现在能看图，或者至少能靠评论区推断
    if (!hasText && !hasImg) {
      if (!opts.silent) toast("没取到正文也没有配图，先让评论区加载出来再试", "err", 5000);
      onDone && onDone({ ok: false, code: "empty_input", error: "没有正文也没有配图" });
      return;
    }

    var lockKey = ctx.id + (opts.refine ? ":r" : "");
    generating[lockKey] = true;
    if (btn) { btn.dataset.busy = "1"; btn.textContent = "···"; btn.removeAttribute("data-err"); }
    if (opts.busyEl) opts.busyEl.disabled = true;

    // 只有正在看这条帖子时才能采到它的评论；历史草稿就用已存的信息重生成
    var prep = (opts.replies != null)
      ? Promise.resolve(opts.replies)
      : (currentTweetId() === ctx.id ? prepareReplies() : Promise.resolve([]));

    prep.then(function (replies) {
      replies = replies || [];
      // 正文空但有评论时，靠评论推断帖子在说什么
      if (!hasText && !replies.length) {
        delete generating[lockKey];
        if (btn) { btn.dataset.busy = "0"; btn.textContent = "AI"; }
        if (opts.busyEl) opts.busyEl.disabled = false;
        if (!opts.silent) toast("正文和评论区都是空的，AI 没有可参考的内容", "err", 5000);
        onDone && onDone({ ok: false, code: "empty_input", error: "正文和评论区都是空的" });
        return;
      }
      var msg = {
        type: opts.refine ? "xrh:refine" : "xrh:reply",
        cfg: CFG,
        tweetText: ctx.src || "",
        replies: replies,
        images: hasImg ? ctx.images : [],
        notes: notesFor(ctx.id),
        count: clamp(parseInt(CFG.candidates, 10) || 3, 1, LIMITS.candidatesMax)
      };
      if (opts.refine) { msg.prev = opts.prev; msg.feedback = opts.feedback; }
      msg.id = lockKey + ":" + Date.now();
      // 流式：每解析出一条新候选就立刻渲染，第一条 ~170ms 就能复制
      return streamSend(msg, function (items) {
        liveGen = { id: ctx.id, items: items, at: Date.now() };
        // 工具栏按钮上直接显示已到达条数，不用打开面板也知道进度
        if (btn) btn.textContent = String(items.length);
        if (panelOpen && tabState === "drafts") renderDrafts();
      });
    }).then(function (res) {
      if (!res) return;
      liveGen = null;
      delete generating[lockKey];
      if (btn) { btn.dataset.busy = "0"; btn.textContent = "AI"; }
      if (opts.busyEl) opts.busyEl.disabled = false;

      if (!res.ok) {
        if (!opts.silent) toast(res.error || "生成失败", "err", 6000);
        if (res.droppedDetail && res.droppedDetail.length) {
          try { console.info("[我爱说人话] 候选全部被硬过滤丢弃：\n" + res.droppedDetail.join("\n")); } catch (e) {}
        }
        if (btn) btn.dataset.err = "1";
        renderPanel();
        onDone && onDone(res);      // 失败也要回调，否则自动化流程会永久挂住
        return;
      }
      var saveOpts = {
        refine: !!opts.refine,
        prev: opts.prev,
        feedback: opts.feedback,
        comments: res.comments || 0,
        images: res.images || 0,
        ranked: !!res.ranked
      };
      saveDrafts(ctx.id, ctx, res.items, saveOpts);
      var basis = [];
      if (res.comments) basis.push("仿写样本 " + res.comments + " 条");
      if (res.images) basis.push("看图 " + res.images + " 张");
      if (saveOpts.notes) basis.push("备注 " + saveOpts.notes + " 条");
      var msg = (opts.refine ? "已按你的反馈重写 " : "已生成 ") + res.items.length + " 条草稿";
      if (res.dropped) msg += "，过滤掉 " + res.dropped + " 条踩雷的";
      // 重排真的改了顺序才说，没改就别制造噪音
      if (res.ranked && res.rankChanged) msg += "，已从 " + res.rankPool + " 条里排出质量序";
      else if (res.ranked) msg += "，" + res.rankPool + " 条里排过序（顺序没变）";
      if (basis.length) msg += "（参考：" + basis.join("、") + "）";
      if (res.allBad) {
        msg = "⚠ 这 " + res.items.length + " 条都踩雷了，已标在卡片上。原因：" +
          ((res.warnings || [])[0] || "未知") + "。可点「✎ 备注」让它重写";
      }
      if (res.droppedDetail && res.droppedDetail.length) {
        try { console.info("[我爱说人话] 已过滤的踩雷候选：\n" + res.droppedDetail.join("\n")); } catch (e) {}
      }
      var firstText = res.items.length ? res.items[0] : "";
      var autoCopy = CFG.autoCopyFirst !== false && !!firstText;
      var finish = function (copied) {
        if (autoCopy) msg += copied ? "，已自动复制第 1 条" : "，自动复制失败，请手动复制";
        if (res.allBad) {
          toast(msg, "err", 6000);
        } else {
          toast(msg, (autoCopy && !copied) ? "err" : (res.dropped ? "" : "ok"), res.dropped ? 4200 : 3200);
        }
        var filled = false;
        if (CFG.autoFill && !opts.refine) {
          filled = fillOrCopy(res.items[0]);
          if (filled) markUsed(ctx.id, 0);
        }
        // 已经填进回复框了就不再提示粘贴，否则「按 Ctrl+V」是误导
        if (autoCopy && copied && !filled) showCopiedHint();
        renderPanel();
        onDone && onDone(res);
      };
      if (autoCopy) copyText(firstText).then(finish);
      else finish(false);
    }).catch(function (e) {
      delete generating[lockKey];
      if (btn) { btn.dataset.busy = "0"; btn.textContent = "AI"; }
      if (opts.busyEl) opts.busyEl.disabled = false;
      if (!opts.silent) toast("出错了：" + ((e && e.message) || e), "err");
      onDone && onDone({ ok: false, code: "throw", error: (e && e.message) || String(e) });
    });
  }

  // 进入详情页时 X 还没渲染完，URL 一变就取值必然拿到空正文。
  // 原来这里直接把 autoFired 标记上，于是永远不会重试 —— 这就是「自动生成没反应」的根因。
  function tweetReady(ctx) {
    if (!ctx) return false;
    if (ctx.src && ctx.src.length >= 3) return true;
    return !!(ctx.images && ctx.images.length);   // 纯图片帖也算就绪
  }

  function waitForTweetText(id, tries, cb) {
    var ctx = currentTweetCtx();
    if (ctx && ctx.id === id && tweetReady(ctx)) { cb(ctx); return; }
    if (tries <= 0) { cb(null); return; }
    setTimeout(function () { waitForTweetText(id, tries - 1, cb); }, 350);
  }

  var autoFired = {};
  function maybeAutoGenerate() {
    if (!CFG.autoGenerate) return;
    var id = currentTweetId();
    if (!id || autoFired[id]) return;
    autoFired[id] = 1;                        // 只登记一次，避免重复起定时器
    if (!CFG.apiKey) return;
    if (getDrafts(id)) return;                // 已有草稿就不重复烧额度
    waitForTweetText(id, 25, function (ctx) { // 最多等 ~8.75s
      if (!ctx) return;                       // 静默放弃，不用错误弹窗打扰
      if (currentTweetId() !== id) return;    // 用户已经跳到别的帖子了
      generateFor(ctx, null, null, { silent: true });
    });
  }

  function injectAiButtons(root) {
    if (!CFG.showAiBtn) return;
    matchAll('[data-testid="toolBar"]', root).forEach(function (bar) {
      if (bar.querySelector(":scope > .xrh-ai-btn")) return;
      var b = el("div", {
        cls: "xrh-ai-btn",
        text: "AI",
        title: "生成多条回复草稿",
        attrs: { role: "button", tabindex: "0", "aria-label": "生成 AI 回复草稿" },
        on: {
          click: function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            var art = bar.closest("article");
            var link = art ? art.querySelector('a[href*="/status/"]') : null;
            var tid = link ? statusIdFromPath(pathOf(link.getAttribute("href"))) : "";
            var ctx = null;
            if (tid && art) {
              ctx = {
                id: tid,
                url: location.origin + pathOf(link.getAttribute("href")),
                author: handleFromEl(art.querySelector('[data-testid="User-Name"] a[role="link"][href^="/"]')),
                src: tweetTextOf(art)
              };
            } else {
              ctx = currentTweetCtx();
            }
            if (!ctx) { toast("没识别到这条推文", "err"); return; }
            generateFor(ctx, b, function () { openPanel("drafts"); });
          }
        }
      });
      bar.appendChild(b);
    });
  }

  // ==================== 回复后自动点赞 ====================
  var autoLikeLog = [];

  // React 组件常常只监听完整指针序列，单发 click 会被忽略
  function realClick(node) {
    if (!node) return false;
    try {
      ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach(function (t) {
        var Ev = t.indexOf("pointer") === 0 && typeof PointerEvent === "function" ? PointerEvent : MouseEvent;
        node.dispatchEvent(new Ev(t, { bubbles: true, cancelable: true, view: window }));
      });
      return true;
    } catch (e) {
      try { node.click(); return true; } catch (e2) { return false; }
    }
  }

  function likeState(art) {
    if (!art) return "noart";
    if (art.querySelector('[data-testid="unlike"]')) return "liked";
    if (art.querySelector('[data-testid="like"]')) return "unliked";
    return "nobtn";
  }

  // 提交按钮可能来自详情页内联回复框，也可能来自弹窗；弹窗里第一条推文才是被回复的原帖
  function likeTargetFor(btn) {
    var dlg = btn && btn.closest ? btn.closest('[role="dialog"]') : null;
    if (dlg) {
      var a = dlg.querySelector('article[data-testid="tweet"]');
      if (a) return a;
    }
    return mainArticle();
  }

  function doLike(art, why) {
    var h = authorOf(art);
    var id = ownStatusId(art, h) || currentTweetId() || "";
    var before = likeState(art);
    if (before === "liked") {
      autoLikeLog.unshift({ ts: Date.now(), id: id, who: h, ok: true, skipped: "已赞过了" });
      return { ok: true, skipped: true };
    }
    if (before !== "unliked") {
      autoLikeLog.unshift({ ts: Date.now(), id: id, who: h, ok: false, why: "找不到赞按钮（X 的 DOM 可能变了）" });
      return { ok: false, why: "找不到赞按钮" };
    }
    var btn = art.querySelector('[data-testid="like"]');
    realClick(btn);
    // 点后校验状态是否真的翻成「已赞」，不盲报成功
    var after = likeState(art);
    var ok = after === "liked";
    autoLikeLog.unshift({ ts: Date.now(), id: id, who: h, ok: ok, why: ok ? "" : "点了但状态未变成已赞（after=" + after + "）" });
    if (autoLikeLog.length > 30) autoLikeLog.length = 30;
    toast(ok ? ("已自动赞 @" + (h || "原帖") + (why ? "（" + why + "）" : "")) : ("自动点赞失败：" + (autoLikeLog[0].why || "")), ok ? "ok" : "err", ok ? 2200 : 5000);
    if (panelOpen && tabState === "diag") renderPanel();
    return { ok: ok };
  }

  // 偏态随机延迟：真人操作的间隔不是均匀的 —— 大多数偏短，偶尔卡很久（分心、切窗口）。
  // 均匀随机在时间序列上仍然太规整，用「两次随机取较小值」得到偏向低端的分布，
  // 再叠加小概率长停顿，整体更接近人的节奏。
  function humanMs(min, max, distractChance) {
    var span = Math.max(0, max - min);
    var t = Math.min(Math.random(), Math.random());                 // 偏向 0
    var v = min + t * span;
    if (Math.random() < (distractChance == null ? 0.10 : distractChance)) {
      v += span * (0.5 + Math.random() * 1.8);                       // 偶发分心
    }
    return Math.round(Math.max(min, v));
  }

  // 点赞延迟：基准值上下偏态浮动。固定间隔的机械节奏比延迟本身更容易被识别成自动化。
  var lastLikeDelay = 0;
  function likeDelay() {
    var base = clamp(parseInt(CFG.autoLikeDelay, 10) || 700, 250, 8000);
    var pct = clamp(parseInt(CFG.autoLikeJitter, 10) || 0, 0, 90);
    if (!pct) { lastLikeDelay = base; return base; }
    var span = base * pct / 100;
    lastLikeDelay = clamp(humanMs(base - span, base + span, 0.12), 250, base + span * 3);
    return lastLikeDelay;
  }

  function scheduleAutoLike(btn) {
    if (!CFG.autoLike) return;
    var art = likeTargetFor(btn);
    if (!art) return;
    var delay = likeDelay();
    setTimeout(function () {
      // 延迟后原节点可能已被 React 回收，重新按当前页面找一次
      var target = art.isConnected ? art : likeTargetFor(null);
      if (!target) return;
      doLike(target, "回复后自动，延迟 " + delay + "ms");
    }, delay);
  }

  // ---------- 发送即记账 ----------
  // 靠翻 /with_replies 和 /notifications 页面记账天然不可靠：X 只渲染已加载的内容，
  // 容器结构还随版本变。而用户点「回复」发送的那一刻插件就在场，
  // 被回复的人和帖子 ID 都在手上 —— 直接记账，零 DOM 猜测，这是最可靠的一条路。
  var sentThisSession = {};   // 本次页面会话里已由发送钩子记过账的人，用于和被动扫描互斥

  function recordReplyAtSend(btn) {
    if (!CFG.trackInteractions || !DATA.me) return;
    var art = likeTargetFor(btn);
    if (!art) return;
    var who = authorOf(art);
    if (!who || who === DATA.me) return;              // 回自己的帖子不算互动对象
    var pid = ownStatusId(art, who);
    // 拿不到父帖 ID 就干脆不记：被动扫描之后会用 r:<我的回复ID> 记上。
    // 两边各用一套键必然重复计数 —— 这正是「回一次加两次」的根因。
    if (!pid) return;
    if (!recordOut(who, "p:" + pid)) return;           // 已记过，不重复提示
    noteSend();                                        // 手速：只在真实点发送时 +1
    sentThisSession[who] = true;
    toast("已记：你回复了 @" + who, "ok", 2200);
    if (panelOpen && tabState === "stats") renderPanel();
  }

  function bindSendHook() {
    document.addEventListener("click", function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      var btn = t.closest('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]');
      if (!btn) return;
      if (btn.disabled || btn.getAttribute("aria-disabled") === "true") return;
      recordReplyAtSend(btn);   // 先记账（同步，趁 DOM 还在）
      scheduleAutoLike(btn);    // 再排队点赞（延迟执行）
    }, true);   // 捕获阶段：赶在 X 自己的 handler 清空输入框、回收节点之前拿到目标
  }

  // ==================== 面板 UI（Shadow DOM，与 X 样式完全隔离） ====================
  var host = null, fab = null, panel = null, panelBody = null, tabState = "drafts";
  var panelOpen = false;

  var PANEL_CSS = [
    ":host{all:initial}",
    "*{box-sizing:border-box;margin:0;padding:0}",
    "button{font:inherit;color:inherit;background:none;border:none;cursor:pointer}",
    ".fab{position:fixed;width:46px;height:46px;border-radius:50%;background:#1d9bf0;color:#fff;",
    "font:800 17px/46px system-ui,-apple-system,sans-serif;text-align:center;pointer-events:auto;",
    "box-shadow:0 4px 14px rgba(29,155,240,.45);cursor:grab;user-select:none;touch-action:none;z-index:2}",
    ".fab:hover{background:#1a8cd8;transform:scale(1.05)}",
    ".fab.dragging{cursor:grabbing;transform:none}",
    ".fab .dot{position:absolute;top:-2px;right:-2px;min-width:17px;height:17px;padding:0 4px;border-radius:9px;",
    "background:#f4212e;color:#fff;font:700 10px/17px system-ui;text-align:center;border:2px solid #0f1419}",
    ".fab .af{position:absolute;bottom:-3px;right:-3px;min-width:18px;height:18px;padding:0 3px;border-radius:9px;",
    "background:#0f1419;color:#71767b;font:800 10px/14px system-ui;text-align:center;border:2px solid #0f1419;",
    "cursor:pointer;pointer-events:auto}",
    ".fab .af.on{background:#1d9bf0;color:#fff}",
    ".fab .af:hover{filter:brightness(1.25)}",
    ".panel{position:fixed;width:372px;max-height:min(74vh,620px);display:flex;flex-direction:column;",
    "background:#16181c;border:1px solid #2f3336;border-radius:14px;overflow:hidden;pointer-events:auto;",
    "box-shadow:0 12px 40px rgba(0,0,0,.6);font:13px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;color:#e7e9ea}",
    ".panel.hidden{display:none}",
    ".hd{display:flex;align-items:center;gap:8px;padding:10px 12px;background:#1d1f23;border-bottom:1px solid #2f3336}",
    ".hd .t{font-weight:800;font-size:13px;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    ".hd .v{font-size:10px;color:#71767b;font-weight:600}",
    ".hd .tg{padding:3px 8px;border-radius:8px;font-size:11px;font-weight:700;color:#71767b;",
    "background:#16181c;border:1px solid #2f3336;white-space:nowrap}",
    ".hd .tg.on{color:#1d9bf0;border-color:#1d9bf0;background:rgba(29,155,240,.14)}",
    ".hd .tg:hover{color:#e7e9ea}",
    ".hd .x{width:24px;height:24px;border-radius:50%;color:#71767b;font-size:16px;line-height:1}",
    ".hd .x:hover{background:#2f3336;color:#e7e9ea}",
    ".tabs{display:flex;gap:2px;padding:6px 8px;background:#16181c;border-bottom:1px solid #2f3336}",
    ".tab{flex:1;padding:6px 4px;border-radius:8px;font-size:12px;font-weight:700;color:#71767b;text-align:center}",
    ".tab:hover{background:#1d1f23;color:#e7e9ea}",
    ".tab.on{background:rgba(29,155,240,.16);color:#1d9bf0}",
    ".bd{flex:1;overflow-y:auto;padding:10px 12px 14px}",
    ".bd::-webkit-scrollbar{width:8px}.bd::-webkit-scrollbar-thumb{background:#2f3336;border-radius:4px}",
    ".ctx{background:#1d1f23;border:1px solid #2f3336;border-radius:10px;padding:9px 10px;margin-bottom:10px}",
    ".ctx .who{font-size:11px;color:#1d9bf0;font-weight:700;margin-bottom:3px}",
    ".ctx .src{font-size:12px;color:#a8b3bd;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}",
    ".gen{width:100%;padding:9px;border-radius:20px;background:#1d9bf0;color:#fff;font-size:12.5px;font-weight:800;margin-top:9px}",
    ".gen:hover{background:#1a8cd8}.gen:disabled{opacity:.5;cursor:progress}",
    ".sec{font-size:11px;font-weight:800;color:#71767b;text-transform:uppercase;letter-spacing:.4px;margin:14px 0 7px;",
    "display:flex;align-items:center;gap:6px}",
    ".sec .n{background:#2f3336;color:#e7e9ea;border-radius:9px;padding:0 6px;font-size:10px;line-height:16px}",
    ".sec .sp{flex:1}",
    ".d{background:#1d1f23;border:1px solid #2f3336;border-radius:10px;padding:9px 10px;margin-bottom:8px}",
    ".d:hover{border-color:#3d4347}",
    ".d.used{border-color:rgba(22,163,74,.5)}",
    ".d .txt{font-size:12.5px;line-height:1.55;color:#e7e9ea;white-space:pre-wrap;word-break:break-word}",
    ".d .txt.clip{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}",
    ".d .bar{display:flex;align-items:center;gap:6px;margin-top:8px}",
    ".b{padding:4px 11px;border-radius:14px;font-size:11.5px;font-weight:700;background:#2f3336;color:#e7e9ea}",
    ".b:hover{background:#3d4347}",
    ".b.pri{background:#1d9bf0;color:#fff}.b.pri:hover{background:#1a8cd8}",
    ".b.ok{background:rgba(22,163,74,.18);color:#4ade80}.b.ok:hover{background:rgba(22,163,74,.28)}",
    ".b.ico{padding:4px 7px;background:none;color:#71767b}.b.ico:hover{background:#2f3336;color:#e7e9ea}",
    ".b.danger:hover{background:rgba(244,33,46,.16);color:#f4212e}",
    ".b.liked{color:#f91880}",
    ".b.liked:hover{background:rgba(249,24,128,.14)}",
    ".d .sp{flex:1}",
    ".d .meta{font-size:10.5px;color:#71767b}",
    ".empty{text-align:center;color:#71767b;padding:26px 12px;font-size:12px}",
    ".empty b{display:block;color:#a8b3bd;font-size:13px;margin-bottom:5px}",
    ".hist{border:1px solid #2f3336;border-radius:10px;margin-bottom:7px;overflow:hidden}",
    ".hist>summary{list-style:none;cursor:pointer;padding:8px 10px;background:#1a1c20;font-size:11.5px}",
    ".hist>summary::-webkit-details-marker{display:none}",
    ".hist>summary:hover{background:#1d1f23}",
    ".hist .h{display:flex;align-items:center;gap:6px}",
    ".hist .h .a{color:#1d9bf0;font-weight:700;white-space:nowrap}",
    ".hist .h .s{flex:1;color:#71767b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    ".hist .h .c{background:#2f3336;border-radius:8px;padding:0 5px;font-size:10px;line-height:15px;color:#a8b3bd}",
    ".hist .inner{padding:8px 10px;background:#16181c}",
    ".st{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px}",
    ".card{background:#1d1f23;border:1px solid #2f3336;border-radius:10px;padding:10px}",
    ".card .k{font-size:10.5px;color:#71767b;margin-bottom:3px}",
    ".card .v{font-size:20px;font-weight:800;color:#e7e9ea;line-height:1.1}",
    ".card .v small{font-size:11px;color:#71767b;font-weight:600}",
    ".row{display:flex;align-items:center;gap:8px;padding:7px 9px;border-radius:8px;font-size:12px}",
    ".row:hover{background:#1d1f23}",
    ".row .a{color:#1d9bf0;font-weight:700;width:132px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".row .p{flex:1;height:5px;background:#2f3336;border-radius:3px;overflow:hidden}",
    ".row .p i{display:block;height:100%;border-radius:3px}",
    ".row .n{font-size:11px;color:#71767b;width:44px;text-align:right}",
    // —— 关注页 ——
    ".fcount{background:#1d1f23;border:1px solid #2f3336;border-radius:12px;padding:12px;margin-bottom:10px}",
    ".fcount .n{font-size:30px;font-weight:800;line-height:1.05}",
    ".fcount .s{font-size:12px;color:#a8b3bd;margin-top:2px}",
    ".fcount .m{font-size:10.5px;color:#71767b;margin-top:7px;line-height:1.5}",
    ".pbar{height:6px;background:#2f3336;border-radius:3px;overflow:hidden;margin-top:9px}",
    ".pbar i{display:block;height:100%;border-radius:3px;transition:width .3s}",
    ".d .h{display:flex;align-items:center;gap:6px;margin-bottom:3px}",
    ".d .h .lnk{font-weight:700;font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".tag{background:#2f3336;color:#a8b3bd;border-radius:8px;padding:1px 6px;font-size:10px;font-weight:700;white-space:nowrap}",
    ".tag.warn{background:rgba(255,173,31,.16);color:#ffad1f}",
    ".tag.ok{background:rgba(22,163,74,.18);color:#4ade80}",
    ".chips{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:9px}",
    ".chip{padding:3px 10px;border-radius:12px;font-size:11px;font-weight:700;background:#1d1f23;color:#71767b;border:1px solid #2f3336}",
    ".chip:hover{color:#e7e9ea;border-color:#3d4347}",
    ".chip.on{background:rgba(29,155,240,.16);color:#1d9bf0;border-color:rgba(29,155,240,.4)}",
    ".fld{display:flex;align-items:center;gap:7px;flex-wrap:wrap}",
    ".fld .lb{font-size:12px;font-weight:700;color:#e7e9ea}",
    ".fld .num{width:66px;padding:4px 7px;border-radius:8px;background:#0f1419;border:1px solid #2f3336;color:#e7e9ea;font-size:12px}",
    ".fld .num:focus{outline:none;border-color:#1d9bf0}",
    ".ckrow{cursor:pointer;margin-bottom:2px}",
    ".ckrow .ck{width:15px;height:15px;accent-color:#1d9bf0;cursor:pointer;flex:none}",
    ".fbadge{position:fixed;left:18px;bottom:18px;min-width:38px;height:38px;padding:0 9px;border-radius:19px;",
    "display:flex;align-items:center;justify-content:center;color:#fff;font:800 14px/1 system-ui;cursor:pointer;",
    "pointer-events:auto;box-shadow:0 4px 16px rgba(0,0,0,.5);border:2px solid #0f1419;z-index:2;user-select:none}",
    ".fbadge:hover{transform:scale(1.06)}",
    ".hint{font-size:11px;color:#71767b;line-height:1.6;margin-top:8px}",
    ".hint code{background:#2f3336;padding:1px 4px;border-radius:3px;color:#a8b3bd}",
    ".lnk{color:#1d9bf0;text-decoration:none}.lnk:hover{text-decoration:underline}",
    ".toastbox{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);display:flex;flex-direction:column;",
    "align-items:center;gap:7px;pointer-events:none;z-index:3}",
    ".toast{background:#2f3336;color:#fff;padding:8px 15px;border-radius:18px;font:600 12.5px/1.4 system-ui;",
    "box-shadow:0 4px 16px rgba(0,0,0,.5);opacity:0;transform:translateY(8px);transition:.2s;max-width:80vw;text-align:center}",
    ".toast.show{opacity:1;transform:none}",
    ".toast.err{background:#f4212e}",
    ".toast.ok{background:#16a34a}",
    /* 草稿标签 */
    ".tags{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:5px}",
    ".tg2{font-size:9.5px;font-weight:700;padding:1px 6px;border-radius:8px;background:#2f3336;color:#8b98a5}",
    ".tg2.refine{background:rgba(29,155,240,.18);color:#4ea9e8}",
    ".tg2.used{background:rgba(22,163,74,.18);color:#4ade80}",
    ".tg2.old{background:#242629;color:#5c646c}",
    ".tg2.best{background:rgba(255,173,31,.2);color:#ffad1f}",
    ".tg2.rank{background:#242629;color:#6b747c}",
    ".d.superseded{opacity:.5}",
    ".d.superseded:hover{opacity:.85}",
    /* 不满意 -> 反馈重写 */
    ".refine{margin-top:9px;padding-top:9px;border-top:1px dashed #38444d}",
    ".chips{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:7px}",
    ".chip{padding:3px 9px;border-radius:12px;background:#242629;border:1px solid #2f3336;",
    "color:#a8b3bd;font-size:11px;font-weight:600}",
    ".chip:hover{background:#2f3336;color:#e7e9ea;border-color:#3d4347}",
    ".fb{width:100%;padding:7px 9px;border:1px solid #2f3336;border-radius:8px;background:#16181c;",
    "color:#e7e9ea;font:12px/1.5 system-ui,-apple-system,sans-serif;resize:vertical;outline:none}",
    ".fb:focus{border-color:#1d9bf0}",
    ".fb::placeholder{color:#5c646c}",
    ".rbar{display:flex;align-items:center;gap:6px;margin-top:7px}",
    ".rbar .sp{flex:1}",
    ".rbar .meta{font-size:10px}",
    ".ctx .used-n{font-size:10.5px;color:#71767b;margin-top:5px}",
    ".btnrow{display:flex;gap:6px;margin-top:10px}",
    /* 备注 */
    ".note{margin-top:7px;padding:6px 8px;background:#1a1c20;border-left:2px solid #d97706;",
    "border-radius:0 6px 6px 0;font-size:11.5px;line-height:1.5;display:flex;gap:6px}",
    ".note .nk{color:#d97706;font-weight:800;flex:none}",
    ".note .nv{color:#a8b3bd;word-break:break-word}",
    ".b.noted{background:rgba(217,119,6,.18);color:#f0a94e}",
    ".b.noted:hover{background:rgba(217,119,6,.28)}",
    ".tg2.vision{background:rgba(168,85,247,.18);color:#c084fc}",
    /* 诊断页 */
    ".dline{display:flex;gap:8px;padding:4px 0;font-size:11.5px;border-bottom:1px solid #1d1f23}",
    ".dline .dk{color:#71767b;flex:none;width:132px}",
    ".dline .dv{color:#e7e9ea;flex:1;word-break:break-all}",
    ".dline.warn .dv{color:#f0a94e}",
    ".fix{margin:7px 0;padding:7px 9px;background:rgba(217,119,6,.1);border:1px solid rgba(217,119,6,.3);",
    "border-radius:8px;font-size:11px;line-height:1.6;color:#f0c98a}",
    ".diag{margin-top:7px;padding:8px;background:#0f1114;border:1px solid #2f3336;border-radius:8px;",
    "font:10.5px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#8b98a5;",
    "white-space:pre-wrap;word-break:break-all;max-height:190px;overflow-y:auto}",
    ".secl{font-size:10.5px;font-weight:700;color:#5c646c;margin:10px 0 2px}",
    ".row .a{width:132px}",
    ".scanrow{display:flex;gap:6px;margin-bottom:7px}",
    ".scanrow .gen{margin-top:0}",
    ".gen.alt{background:#2f3336;color:#e7e9ea}",
    ".gen.alt:hover{background:#3d4347}",
    ".scanprog{font-size:10.5px;color:#71767b;line-height:1.6;margin-bottom:10px}",
    ".scanrow .b{align-self:center}"
  ].join("\n");

  function mountUI() {
    if (host) return;
    host = el("div", { cls: "xrh-root", attrs: { id: "xrh-root" } });
    host.style.cssText = "all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483000;pointer-events:none;";
    shadow = host.attachShadow({ mode: "open" });
    shadow.appendChild(el("style", { text: PANEL_CSS }));

    toastBox = el("div", { cls: "toastbox" });
    fab = el("div", {
      cls: "fab", text: "话", title: "我爱说人话（可拖动）",
      attrs: { role: "button", tabindex: "0", "aria-label": "打开我爱说人话面板" }
    });
    // 键盘可达：Enter/Space 开关，Esc 关闭
    fab.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); togglePanel(); }
    });
    panel = el("div", { cls: "panel hidden", attrs: { role: "dialog", "aria-label": "我爱说人话" } });
    shadow.appendChild(fab);
    shadow.appendChild(panel);
    shadow.appendChild(toastBox);
    document.documentElement.appendChild(host);

    buildPanel();
    bindFab();
    bindSendHook();
    // Esc 关闭面板。装在 window 上（捕获阶段）而不是面板内，
    // 否则焦点在页面里时按 Esc 没反应。
    window.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && panelOpen) { e.stopPropagation(); togglePanel(false); }
    }, true);
    positionUI();
    if (CFG.panelMin === false) togglePanel(true);
  }

  function buildPanel() {
    panel.textContent = "";
    afBtnEl = el("button", {
      cls: "tg" + (autoFillOn() ? " on" : ""),
      text: autoFillLabel(),
      attrs: {
        role: "switch",
        "aria-checked": autoFillOn() ? "true" : "false",
        title: "切换「自动填入首条」：开 = 生成后写进回复框；关 = 只复制不写入"
      },
      on: { click: function () { toggleAutoFill(); } }
    });
    var hd = el("div", { cls: "hd" }, [
      el("div", { cls: "t", text: "我爱说人话" }),
      afBtnEl,
      el("span", { cls: "v", text: "v" + version() }),
      el("button", { cls: "x", text: "×", title: "收起", on: { click: function () { togglePanel(false); } } })
    ]);
    var tabs = el("div", { cls: "tabs", attrs: { role: "tablist" } }, [
      el("button", { cls: "tab on", text: "草稿箱", attrs: { "data-tab": "drafts", role: "tab", "aria-selected": "true" } }),
      el("button", { cls: "tab", text: "互动数据", attrs: { "data-tab": "stats", role: "tab", "aria-selected": "false" } }),
      el("button", { cls: "tab", text: "关注", attrs: { "data-tab": "follow", role: "tab", "aria-selected": "false" } }),
      el("button", { cls: "tab", text: "诊断", attrs: { "data-tab": "diag", role: "tab", "aria-selected": "false" } })
    ]);
    tabs.addEventListener("click", function (e) {
      var b = e.target.closest("[data-tab]");
      if (!b) return;
      tabState = b.dataset.tab;
      syncTabs();
      renderPanel();
    });
    panelBody = el("div", { cls: "bd" });
    panel.appendChild(hd);
    panel.appendChild(tabs);
    panel.appendChild(panelBody);
  }

  function version() {
    try { return chrome.runtime.getManifest().version; } catch (e) { return "2.0.0"; }
  }

  function togglePanel(force) {
    panelOpen = force != null ? !!force : !panelOpen;
    panel.classList.toggle("hidden", !panelOpen);
    fab.textContent = panelOpen ? "−" : "话";   // 这会清掉 fab 上所有子节点
    updateFabDot();                             // 重新挂回草稿数角标和「填」标记
    syncAutoFillUI();                           // 头部按钮按当前配置刷新
    CFG.panelMin = !panelOpen;
    persistCfg();
    if (panelOpen) { renderPanel(); positionUI(); }
  }
  function openPanel(tab) {
    if (tab && tabState !== tab) { tabState = tab; syncTabs(); }
    togglePanel(true);
  }

  var persistCfg = debounce(function () {
    try {
      chrome.storage.local.get([CFG_KEY], function (r) {
        var c = Object.assign({}, (r && r[CFG_KEY]) || {}, { panelMin: CFG.panelMin, panelPos: CFG.panelPos });
        var o = {}; o[CFG_KEY] = c;
        chrome.storage.local.set(o);
      });
    } catch (e) {}
  }, 400);

  // ---------- 悬浮球：拖拽 + 点击 ----------
  function bindFab() {
    var down = false, moved = false, sx = 0, sy = 0, ox = 0, oy = 0;
    fab.addEventListener("pointerenter", function () { warmServiceWorker(); });
    fab.addEventListener("pointerdown", function (e) {
      down = true; moved = false;
      sx = e.clientX; sy = e.clientY;
      ox = CFG.panelPos.right; oy = CFG.panelPos.bottom;
      try { fab.setPointerCapture(e.pointerId); } catch (er) {}
    });
    fab.addEventListener("pointermove", function (e) {
      if (!down) return;
      var dx = sx - e.clientX, dy = sy - e.clientY;
      if (!moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
      moved = true;
      fab.classList.add("dragging");
      setPos(clamp(ox + dx, 4, Math.max(4, innerWidth - 50)), clamp(oy + dy, 4, Math.max(4, innerHeight - 50)));
    });
    fab.addEventListener("pointerup", function (e) {
      down = false;
      fab.classList.remove("dragging");
      try { fab.releasePointerCapture(e.pointerId); } catch (er) {}
      if (moved) { persistCfg(); positionUI(); }
      else togglePanel();
    });
    fab.addEventListener("pointercancel", function () { down = false; fab.classList.remove("dragging"); });
    window.addEventListener("resize", debounce(positionUI, 150));
  }

  function setPos(right, bottom) {
    CFG.panelPos = { right: Math.round(right), bottom: Math.round(bottom) };
    positionUI();
  }

  function positionUI() {
    if (!host) return;
    var p = CFG.panelPos || { right: 20, bottom: 88 };
    var right = clamp(p.right, 4, Math.max(4, innerWidth - 50));
    var bottom = clamp(p.bottom, 4, Math.max(4, innerHeight - 50));
    fab.style.right = right + "px";
    fab.style.bottom = bottom + "px";
    fab.style.display = CFG.showFab === false ? "none" : "";

    var w = 372;
    var pr = innerWidth - right - 46 < w ? Math.max(8, innerWidth - w - 8) : right;
    panel.style.right = pr + "px";
    var h = Math.min(panel.offsetHeight || 500, Math.min(innerHeight * 0.74, 620));
    var pb = bottom + 54;
    if (pb + h > innerHeight - 8) pb = Math.max(8, innerHeight - 8 - h);
    panel.style.bottom = pb + "px";
  }

  // ---------- 渲染 ----------
  var QUICK_FB = ["太客套", "太长", "观点不对", "AI 腔太重", "没接住原帖", "太冲了", "换个角度", "太平淡", "像客服", "不够具体"];
  var openNote = {};   // draftId|idx -> bool

  // 备注框：默认只是本地保存，不花 API。要 AI 重写是另一个明确的按钮。
  function noteBox(draftId, item, idx) {
    var ta = el("textarea", {
      cls: "fb", attrs: { rows: "2", placeholder: "记下哪里不对。例如：太像客服、没提到 34 岁这个点、想反问 HR…" }
    });
    ta.value = item.note || "";

    var chips = el("div", { cls: "chips" });
    QUICK_FB.forEach(function (q) {
      chips.appendChild(el("button", {
        cls: "chip", text: q,
        on: {
          click: function () {
            var cur = ta.value.trim();
            ta.value = cur ? cur.replace(/[；;，,\s]+$/, "") + "；" + q : q;
            ta.focus();
          }
        }
      }));
    });

    var key = draftId + "|" + idx;

    var saveBtn = el("button", {
      cls: "b pri", text: "保存备注", title: "只存到本地，不调用模型、不花额度",
      on: {
        click: function () {
          var v = ta.value.trim();
          if (setNote(draftId, idx, v)) {
            delete openNote[key];
            toast(v ? "备注已保存，下次生成会带上它" : "备注已清除", "ok");
            renderPanel();
          } else {
            toast("找不到这条草稿，可能已被清理", "err");
          }
        }
      }
    });

    var busy = false;
    var rewriteBtn = el("button", {
      cls: "b", text: "按备注重写",
      title: "这一步会调用一次 API（消耗额度），根据上面的备注重写",
      on: {
        click: function () {
          var fb = ta.value.trim();
          if (!fb) { toast("先写下哪里不满意，再点重写", "err"); ta.focus(); return; }
          var d = getDrafts(draftId);
          if (!d) { toast("找不到这条草稿", "err"); return; }
          if (busy) return;
          busy = true;
          setNote(draftId, idx, fb);           // 先把备注落盘，重写失败也不丢
          rewriteBtn.disabled = true;
          rewriteBtn.textContent = "重写中…";
          var ctx = {
            id: draftId, src: d.src || "", author: d.author || "",
            url: d.url || "", images: d.images || []
          };
          var onPage = currentTweetId() === draftId;
          var live = onPage ? currentTweetCtx() : null;
          if (live) { ctx.src = live.src || ctx.src; ctx.images = live.images || ctx.images; }
          var replies = onPage ? ((collectThread() || {}).replies || []) : [];
          generateFor(ctx, null, function () { busy = false; delete openNote[key]; },
            { refine: true, prev: item.text, feedback: fb, replies: replies, busyEl: rewriteBtn });
        }
      }
    });

    return el("div", { cls: "refine" }, [
      chips, ta,
      el("div", { cls: "rbar" }, [
        saveBtn, rewriteBtn,
        el("button", {
          cls: "b ico", text: "取消",
          on: { click: function () { delete openNote[key]; renderPanel(); } }
        }),
        el("div", { cls: "sp" }),
        el("span", { cls: "meta", text: "保存=本地 · 重写=花额度" })
      ])
    ]);
  }

  // 手动赞原帖按钮（仅在当前帖子的草稿卡片上出现）
  function likeBtn() {
    var art = mainArticle();
    var st = likeState(art);
    return el("button", {
      cls: "b ico" + (st === "liked" ? " liked" : ""),
      text: st === "liked" ? "♥" : "♡",
      title: st === "liked" ? "原帖已赞过" : st === "unliked" ? "手动赞一下原帖" : "当前找不到赞按钮",
      on: {
        click: function () {
          var a = mainArticle();
          if (!a) { toast("找不到原帖", "err"); return; }
          var r = doLike(a, "手动");
          if (r.skipped) toast("原帖早就赞过了", "ok");
          renderPanel();
        }
      }
    });
  }

  function draftCard(draftId, item, idx, isCurrent) {
    var txt = el("div", { cls: "txt clip", text: item.text });
    txt.addEventListener("click", function () { txt.classList.toggle("clip"); });

    var tags = el("div", { cls: "tags" });
    // 重排后第一条才是裁判认为最好的那条。不标出来用户只会觉得顺序莫名其妙 ——
    // 流式期间是按生成顺序显示的，排完会换位置。
    if (item.rank === 1) {
      tags.appendChild(el("span", {
        cls: "tg2 best", text: "最佳",
        title: "开了 best-of-N 重排：一次多生成几条，再由裁判模型按质量排序，这条排第一。\n流式显示时是按生成顺序的，排完才换成这个顺序。"
      }));
    } else if (item.rank > 1) {
      tags.appendChild(el("span", { cls: "tg2 rank", text: "第" + item.rank, title: "裁判给的质量名次" }));
    }
    if (item.refined) tags.appendChild(el("span", { cls: "tg2 refine", text: "已按备注重写", title: "依据：" + (item.feedback || "") }));
    if (item.superseded) tags.appendChild(el("span", { cls: "tg2 old", text: "旧版" }));
    if (item.used) tags.appendChild(el("span", { cls: "tg2 used", text: "已填入" }));
    if (item.comments) tags.appendChild(el("span", { cls: "tg2", text: "仿写 " + item.comments + " 条", title: "生成时拿 " + item.comments + " 条已有回复当仿写样本（回复对象仍是原帖作者）" }));
    if (item.images) tags.appendChild(el("span", { cls: "tg2 vision", text: "看图 " + item.images }));

    var rkey = draftId + "|" + idx;
    var noteBtn = el("button", {
      cls: "b" + (item.note ? " noted" : ""),
      text: openNote[rkey] ? "收起" : (item.note ? "✎ 备注·已存" : "✎ 备注"),
      title: item.note ? ("已存备注：" + item.note) : "记下哪里不满意（纯本地保存，不花额度）",
      on: {
        click: function () {
          if (openNote[rkey]) delete openNote[rkey]; else openNote[rkey] = true;
          renderPanel();
          if (openNote[rkey]) {
            var t = panelBody && panelBody.querySelector("textarea.fb");
            if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); }
          }
        }
      }
    });

    var bar = el("div", { cls: "bar" }, [
      el("button", {
        cls: "b pri", text: "复制", title: "复制这条草稿到剪贴板",
        on: {
          click: function () {
            copyText(item.text).then(function (ok) {
              if (ok) showCopiedHint();
              toast(ok ? "已复制：" + (item.text.length > 18 ? item.text.slice(0, 18) + "…" : item.text) : "复制失败，请手动选中", ok ? "ok" : "err");
            });
          }
        }
      }),
      isCurrent ? el("button", {
        cls: "b ok", text: item.used ? "重填" : "填入",
        title: "填入下方回复框（不发送）",
        on: {
          click: function () {
            if (fillOrCopy(item.text)) markUsed(draftId, idx);
            renderPanel();
          }
        }
      }) : el("a", {
        cls: "b lnk", text: "原帖", title: "打开原帖",
        attrs: { href: (getDrafts(draftId) || {}).url || "#", target: "_blank", rel: "noopener" }
      }),
      noteBtn,
      isCurrent ? likeBtn() : null,
      el("button", { cls: "b ico danger", text: "✕", title: "删除这条草稿", on: { click: function () { removeDraft(draftId, idx); renderPanel(); } } }),
      el("div", { cls: "sp" }),
      el("span", { cls: "meta", text: timeAgo(item.ts) })
    ]);

    var kids = [tags.childNodes.length ? tags : null, txt];
    if (item.note && !openNote[rkey]) {
      kids.push(el("div", { cls: "note", title: "本地备注，下次生成会作为约束带给模型" }, [
        el("span", { cls: "nk", text: "备注" }),
        el("span", { cls: "nv", text: item.note })
      ]));
    }
    kids.push(bar);
    if (openNote[rkey]) kids.push(noteBox(draftId, item, idx));
    return el("div", { cls: "d" + (item.used ? " used" : "") + (item.superseded ? " superseded" : "") }, kids);
  }

  function renderDrafts() {
    panelBody.textContent = "";
    var a = acct();
    if (!DATA.me) {
      detectMe();   // 打开面板时再试一次，X 的导航可能刚渲染出来
      if (!DATA.me) {
        panelBody.appendChild(el("div", { cls: "empty" }, [
          el("b", { text: "未识别到你的账号" }),
          "认不出哪个账号是你，草稿和互动数据都无法归档。",
          el("div", { cls: "hint", text: "解决：插件图标 → 互动追踪 → 「我的用户名」填你的 handle（不带 @）→ 保存 → 刷新页面。" }),
          el("button", { cls: "b pri", text: "打开诊断页", on: { click: function () { tabState = "diag"; syncTabs(); renderPanel(); } } })
        ]));
        return;
      }
      a = acct();
    }
    if (!a) return;

    var ctx = currentTweetCtx();
    var ids = Object.keys(a.drafts).sort(function (x, y) { return a.drafts[y].ts - a.drafts[x].ts; });

    if (ctx) {
      var mine = ctx.author === DATA.me;
      var box = el("div", { cls: "ctx" }, [
        el("div", { cls: "who", text: (mine ? "你的帖子" : "@" + ctx.author) + " · " + ctx.id }),
        el("div", { cls: "src", text: ctx.src || "（无正文，可能是图片/视频帖）" })
      ]);

      // 评论区上下文状态，让用户知道 AI 到底看没看到评论
      var th = collectThread();
      var loaded = th ? th.total : 0;
      var willUse = th ? th.replies.length : 0;
      if (!CFG.useComments) {
        box.appendChild(el("div", { cls: "used-n", text: "⚠ 仿写样本已关闭，AI 只能凭原帖正文瞎猜语感，容易写出跟帖子不搭的通用回复" }));
      } else if (!ctx.src) {
        /* 正文都没有，下面统一提示 */
      } else if (loaded === 0) {
        box.appendChild(el("div", { cls: "used-n", text: "评论区还没加载出来（0 条），没有仿写样本。开「自动下滑加载」或手动滚一下再试" }));
      } else {
        box.appendChild(el("div", {
          cls: "used-n",
          text: "评论区已加载 " + loaded + " 条，本次带 " + willUse + " 条给模型仿写（回复对象仍是原帖作者）"
        }));
      }

      var d = a.drafts[ctx.id];
      var n = clamp(parseInt(CFG.candidates, 10) || 3, 1, LIMITS.candidatesMax);
      var busy = !!generating[ctx.id];
      var gen = el("button", {
        cls: "gen", text: busy ? "生成中…" : (d && d.items.length ? "再生成 " + n + " 条" : "生成 " + n + " 条回复草稿"),
        on: { click: function () { generateFor(ctx, null, null); } }
      });
      if (busy) gen.disabled = true;
      box.appendChild(gen);

      // 流式生成中：已到达的候选立刻可用，不必等全部生成完
      if (busy && liveGen && liveGen.id === ctx.id && liveGen.items.length) {
        box.appendChild(el("div", { cls: "secl", text: "生成中，已到达 " + liveGen.items.length + " 条（可先复制）" }));
        liveGen.items.forEach(function (t, i) {
          box.appendChild(el("div", { cls: "d live" }, [
            el("div", { cls: "txt", text: t }),
            el("div", { cls: "bar" }, [
              el("button", {
                cls: "b pri", text: "复制",
                on: {
                  click: function () {
                    copyText(t).then(function (ok) {
                      if (ok) showCopiedHint();
                      toast(ok ? "已复制：" + (t.length > 18 ? t.slice(0, 18) + "…" : t) : "复制失败", ok ? "ok" : "err");
                    });
                  }
                }
              }),
              el("div", { cls: "sp" }),
              el("span", { cls: "meta", text: "生成中…" })
            ])
          ]));
        });
      }


      // 配图情况：开了看图就直接读图，没开就提示只能靠评论推断
      var nImg = (ctx.images || []).length;
      if (nImg) {
        box.appendChild(el("div", {
          cls: "used-n",
          text: CFG.useVision === false
            ? "有 " + nImg + " 张配图，但「配图时自动看图」是关的 —— AI 看不到图，只能靠文字和评论参考猜"
            : "有 " + nImg + " 张配图，将用 " + (CFG.visionModel || DEF.visionModel) + " 直接读图"
        }));
      }
      if (!ctx.src && !nImg && !loaded) {
        box.appendChild(el("div", { cls: "hint", text: "正文、配图、评论全空，AI 没有可参考的内容。等页面加载完再试。" }));
        gen.disabled = true;
      } else if (!ctx.src && !nImg) {
        box.appendChild(el("div", { cls: "hint", text: "这条帖子没有文字也没有配图，将完全依据 " + loaded + " 条评论推断内容后作答。" }));
      }
      panelBody.appendChild(box);

      if (d && d.items.length) {
        panelBody.appendChild(el("div", { cls: "sec" }, [
          "本帖草稿", el("span", { cls: "n", text: String(d.items.length) }), el("span", { cls: "sp" }),
          el("button", {
            cls: "b ico", text: "全部复制", title: "把所有草稿按行复制",
            on: {
              click: function () {
                copyText(d.items.map(function (i, k) { return (k + 1) + ". " + i.text; }).join("\n"))
                  .then(function (ok) { toast(ok ? "已复制 " + d.items.length + " 条" : "复制失败", ok ? "ok" : "err"); });
              }
            }
          }),
          el("button", { cls: "b ico danger", text: "清空", title: "清空本帖草稿", on: { click: function () { delete a.drafts[ctx.id]; markDirty(); renderPanel(); } } })
        ]));
        d.items.forEach(function (item, idx) { panelBody.appendChild(draftCard(ctx.id, item, idx, true)); });
      }
    } else {
      panelBody.appendChild(el("div", { cls: "empty" }, [
        el("b", { text: "当前不在帖子详情页" }),
        "打开任意一条帖子，或在推文工具栏点 ",
        el("b", { text: "AI" }),
        " 按钮，就能生成多条回复草稿。"
      ]));
    }

    var others = ids.filter(function (k) { return !ctx || k !== ctx.id; });
    if (others.length) {
      panelBody.appendChild(el("div", { cls: "sec" }, [
        "历史草稿", el("span", { cls: "n", text: String(others.length) }), el("span", { cls: "sp" }),
        el("button", {
          cls: "b ico danger", text: "全部清空", title: "清空所有历史草稿",
            on: { click: function () { if (confirm("清空全部历史草稿？")) { a.drafts = {}; markDirty(); renderPanel(); } } }
        })
      ]));
      others.slice(0, 25).forEach(function (k) {
        var dd = a.drafts[k];
        if (!dd || !dd.items || !dd.items.length) return;
        var inner = el("div", { cls: "inner" });
        dd.items.forEach(function (item, idx) { inner.appendChild(draftCard(k, item, idx, false)); });
        var det = el("details", { cls: "hist" }, [
          el("summary", {}, [el("div", { cls: "h" }, [
            el("span", { cls: "a", text: "@" + (dd.author || k) }),
            el("span", { cls: "s", text: dd.src ? dd.src.slice(0, 46) : "（无正文）" }),
            el("span", { cls: "c", text: dd.items.length + " · " + timeAgo(dd.ts) })
          ])])
        ]);
        det.appendChild(inner);
        panelBody.appendChild(det);
      });
    }

    if (!ids.length) {
      panelBody.appendChild(el("div", { cls: "hint", text: "草稿保存在本地浏览器（chrome.storage.local），不会上传。上限 " + LIMITS.draftsTweets + " 条帖子 × " + LIMITS.draftsPerTweet + " 条草稿，超出自动淘汰最旧的。" }));
    }
  }

  function renderStats() {
    panelBody.textContent = "";
    var a = acct();

    // 账号识别状态：这是数据不动最常见的原因，必须直接摆出来
    panelBody.appendChild(el("div", { cls: "ctx" }, [
      el("div", { cls: "who", text: DATA.me ? ("当前账号 @" + DATA.me) : "未识别到账号" }),
      el("div", { cls: "src", text: "识别方式：" + (meHow || "（还没跑过识别）") }),
      DATA.me ? null : el("div", { cls: "hint", text: "认不出哪个账号是你，所有计数都只能是 0。请在插件设置的「我的用户名」里手填一次（不带 @）。" })
    ]));

    var scanBtn = el("button", { cls: "gen", text: "立即扫描本页" });
    scanBtn.addEventListener("click", function () {
      scanBtn.disabled = true;
      scanBtn.textContent = "扫描中…";
      var r = scanNow();
      scanBtn.disabled = false;
      scanBtn.textContent = "立即扫描本页";
      var cv = r.addedConv || { inn: 0, out: 0 };
      var added = (r.addedOut || 0) + (cv.out || 0) + (r.addedNotif || 0) + (r.addedThread || 0) + (cv.inn || 0);
      toast(added
        ? ("新增 " + added + " 条记录（你回TA " + (r.addedOut + cv.out) + " / TA回你 " + (r.addedNotif + r.addedThread + cv.inn) + "）")
        : "本页没有新可记录的内容，只扫当前已加载的部分。要看更多请用「继续下滑扫描」。", added ? "ok" : "", 4500);
      lastScan = r;
      renderPanel();
      if (!added) { tabState = "diag"; syncTabs(); }
    });

    // 自动下滑扫描：边走边记，能一次把已加载过的历史都补上
    scanGoBtn = el("button", { cls: "gen alt", text: "继续下滑扫描", title: "从当前位置继续往下滚，边滚边记。不滚回顶部，下次点接着上次的位置走" });
    scanGoBtn.addEventListener("click", function () { autoScan(); });
    scanStopBtn = el("button", { cls: "b", text: "停止", style: "display:none", on: { click: function () { stopAutoScan("手动停止"); } } });
    scanProgressEl = el("div", { cls: "scanprog" });

    panelBody.appendChild(el("div", { cls: "scanrow" }, [scanBtn, scanGoBtn, scanStopBtn]));
    panelBody.appendChild(scanProgressEl);
    paintScanProgress();

    if (!a) { panelBody.appendChild(el("div", { cls: "empty", text: "识别到账号后这里会显示统计" })); return; }

    var hs = Object.keys(a.handles);
    var outN = 0, inN = 0, mutual = [];
    hs.forEach(function (h) {
      var v = a.handles[h];
      var o = (v.out || []).length, i = (v.inn || []).length;
      outN += o; inN += i;
      if (o && i) mutual.push({ h: h, o: o, i: i, s: o + i });
    });

    var card = function (k, v, unit) {
      return el("div", { cls: "card" }, [
        el("div", { cls: "k", text: k }),
        el("div", { cls: "v" }, [String(v), unit ? el("small", { text: " " + unit }) : null])
      ]);
    };
    panelBody.appendChild(el("div", { cls: "st" }, [
      card("追踪人数", hs.length, "人"),
      card("双向互动", mutual.length, "人"),
      card("你回TA", outN, "条"),
      card("TA回你", inN, "条")
    ]));

    // ---------- 手速：按最近的实际发送速度，预估一天能回多少条 ----------
    var s10 = sendRate(10), s60 = sendRate(60);
    panelBody.appendChild(el("div", { cls: "sec" }, ["手速预估"]));
    if (!s60.total) {
      panelBody.appendChild(el("div", { cls: "hint", text: "还没有发送记录。你每点一次「回复」发送就记一次，攒几条之后这里会按你的实际手速折算出每小时、每天能回多少条。" }));
    } else {
      panelBody.appendChild(el("div", { cls: "st" }, [
        card("近10分钟发出", s10.n, "条"),
        card("折算每小时", s10.perHour, "条"),
        card("全天不停", s10.perDay24, "条"),
        card("按每天8小时", s10.perDay8, "条")
      ]));
      panelBody.appendChild(el("div", { cls: "ctx" }, [
        el("div", { cls: "who", text: "近 10 分钟 " + s10.n + " 条 → 近 60 分钟 " + s60.n + " 条" }),
        el("div", { cls: "src", text: "两个窗口折算的每小时速度：" + s10.perHour + " 条（10分钟）/ " + s60.perHour + " 条（60分钟）" +
          (s10.n && s60.n ? (s10.perHour > s60.perHour ? "　↑ 你正在加速" : s10.perHour < s60.perHour ? "　↓ 比刚才慢了" : "　→ 速度稳定") : "") }),
        el("div", { cls: "used-n", text: (s10.newest ? "最近一次发送 " + timeAgo(s10.newest) + "　·　" : "") + "共记录 " + s60.total + " 次发送" })
      ]));
      panelBody.appendChild(el("div", { cls: "hint", text: "只统计你真实点「回复」发送的时刻，所以历史数据一次灌进来多少都不会污染这个速度。全天不停是理论上限（×24），按每天 8 小时更接近实际。最多保留最近 " + SENDS_MAX + " 次发送。" }));
    }

    var fp = countFollowPage();
    if (CFG.highlightFollow && fp) {
      panelBody.appendChild(el("div", { cls: "sec" }, [fp.kind === "following" ? "本页未回关" : "本页待回关"]));
      panelBody.appendChild(el("div", { cls: "ctx" }, [
        el("div", { cls: "src", text: "已加载 " + fp.total + " 人，标记 " + fp.marked + " 人" })
      ]));
    }

    panelBody.appendChild(el("div", { cls: "hint" }, [
      "数据怎么来的（全程被动累积，五个来源，共用一套去重键所以不会重复计）：",
      el("br"), "· ", el("b", { text: "你回TA" }), " — ① 任何页面刷到你自己发的、带「回复 @某人」的推文；② 点「回复」发送的那一刻直接记账；③ X 用对话模块布局省掉「回复 @x」行时，按同一 cell 里前一条的作者反推。",
      el("br"), "· ", el("b", { text: "TA回你" }), " — ① 打开你自己某条帖子时，下面所有回复者；② 对话模块里「我在前、别人在后」的配对；③ 刷 ", el("code", { text: "/notifications" }), " 时逐条识别（已排除「喜欢了你的回复」这类点赞通知）。",
      el("br"), "X 只渲染已加载的内容，所以往下滚动看到更多才能记全。徽章只显示有数据的人，纯浏览过的陌生人不会显示。"
    ]));
  }

  var lastScan = null;
  var lastDiagAt = 0;

  function renderDiag() {
    panelBody.textContent = "";
    var r = lastScan || scanNow();
    lastScan = r;
    lastDiagAt = Date.now();

    var line = function (k, v, warn) {
      return el("div", { cls: "dline" + (warn ? " warn" : "") }, [
        el("span", { cls: "dk", text: k }),
        el("span", { cls: "dv", text: String(v) })
      ]);
    };
    var sec = function (t) { return el("div", { cls: "sec", text: t }); };

    panelBody.appendChild(el("div", { cls: "hint", text: "这一页把插件在当前页面上真实看到的东西全部列出来。哪一项不对，就说明卡在哪一步。" }));

    panelBody.appendChild(sec("1. 账号识别"));
    panelBody.appendChild(line("认到的账号", r.me ? "@" + r.me : "（空）", !r.me));
    panelBody.appendChild(line("识别方式", r.meHow, /未识别/.test(r.meHow || "")));
    panelBody.appendChild(line("开关 trackInteractions", CFG.trackInteractions ? "开" : "关（数据不会增长）", !CFG.trackInteractions));
    if (!r.me) {
      panelBody.appendChild(el("div", { cls: "fix", text: "解决：插件图标 → 互动追踪 → 「我的用户名」填你自己的 handle（不带 @）→ 保存 → 刷新页面。" }));
    }

    panelBody.appendChild(sec("2. 本页推文"));
    panelBody.appendChild(line("当前路径", r.page));
    panelBody.appendChild(line("找到 article 数", r.articles, !r.articles));
    panelBody.appendChild(line("其中是嵌套的引用卡片", r.nestedArticles || 0));
    panelBody.appendChild(line("其中是我发的", r.mineArticles));
    panelBody.appendChild(line("带「回复 @x」的", r.withTarget, r.mineArticles && !r.withTarget));
    panelBody.appendChild(line("提取到的对象", r.targets.length ? r.targets.map(function (t) { return "@" + t; }).join(" ") : "（无）"));
    if (r.articles && !r.mineArticles) {
      panelBody.appendChild(el("div", { cls: "fix", text: "本页没有你自己发的帖子，所以「你回TA」不会增长 —— 这是正常的。去首页刷到你自己回复过的帖子，或访问 /你的用户名/with_replies。" }));
    } else if (r.mineArticles && !r.withTarget) {
      panelBody.appendChild(el("div", { cls: "fix", text: "认出了你的帖子，但一条「回复 @x」都没提取到。把下面「推文结构抽样」复制给我，我按真实 DOM 对准选择器。" }));
    }
    panelBody.appendChild(el("div", { cls: "secl", text: "推文结构抽样" }));
    panelBody.appendChild(el("pre", { cls: "diag", text: r.articleAnatomy || "（无）" }));

    panelBody.appendChild(sec("3. 通知页（TA回你）"));
    if (!r.onNotifications) {
      panelBody.appendChild(line("状态", "当前不在 /notifications 页"));
      panelBody.appendChild(el("div", { cls: "fix", text: "「TA回你」有两个来源：打开你自己的某条帖子（下面所有回复者都会被记上），以及刷通知页。要验证通知这条路，请到 x.com/notifications 再打开诊断页。" }));
    } else {
      panelBody.appendChild(line("容器选择器", r.notifSel || "（未命中）", !r.notifCells));
      panelBody.appendChild(line("命中通知条数", r.notifCells, !r.notifCells));
      panelBody.appendChild(line("容器无关扫描：找到「回复」标签", (r.flatActions || 0) + " 个"));
      panelBody.appendChild(line("容器无关扫描：识别出的发起人",
        (r.flatActors && r.flatActors.length) ? r.flatActors.map(function (a) { return "@" + a; }).join(" ") : "（无）",
        !(r.flatActors && r.flatActors.length)));
      panelBody.appendChild(line("因未提及 @" + (DATA.me || "我") + " 而跳过", r.flatSkipped || 0));
      panelBody.appendChild(el("div", { cls: "secl", text: "通知结构抽样" }));
      panelBody.appendChild(el("pre", { cls: "diag", text: r.notifAnatomy || "（无）" }));
      if (!r.notifCells && !(r.flatActions || 0)) {
        panelBody.appendChild(el("div", { cls: "fix", text: "容器选择和文档顺序推断两条路都没找到「回复」标签。把上面的抽样复制给我 —— 大概率是 X 把「回复」和 @handle 渲染进了同一个文本节点，需要换切分方式。" }));
      } else if ((r.flatActions || 0) && !(r.flatActors || []).length) {
        panelBody.appendChild(el("div", { cls: "fix", text: "找到了「回复」标签但没认出发起人，说明 @handle 不是独立链接。把抽样复制给我。" }));
      }
    }

    panelBody.appendChild(sec("4. 本次扫描新增"));
    var cv = r.addedConv || { inn: 0, out: 0 };
    panelBody.appendChild(line("你回TA（推文里的回复行）", "+" + r.addedOut));
    panelBody.appendChild(line("你回TA（对话模块配对）", "+" + (cv.out || 0)));
    panelBody.appendChild(line("TA回你（帖子详情页）", "+" + r.addedThread));
    panelBody.appendChild(line("TA回你（对话模块配对）", "+" + (cv.inn || 0)));
    panelBody.appendChild(line("TA回你（通知页）", "+" + r.addedNotif));
    var cs = r.convCells || {};
    panelBody.appendChild(line("对话模块 cell", (cs.modules || 0) + " 个（含 " + (cs.artsInModule || 0) + " 条推文）" +
      "，无 cell 包裹的推文 " + (cs.artsNoCell || 0) + " 条", !(cs.modules || 0)));
    panelBody.appendChild(el("div", { cls: "hint", text: "五个来源共用同一套去重键（你回TA 用 p:父帖ID，TA回你 用 r:对方回复ID），同一次互动被多个来源看到只算一次。" }));


    // 最可靠的一路：X 自己的接口响应带 in_reply_to_* 字段，完全不依赖 DOM 结构
    var ap = r.api || {};
    panelBody.appendChild(sec("4b. X 接口数据（最可靠，不依赖 DOM）"));
    panelBody.appendChild(line("intercept.js 是否在跑", ap.msgs ? ("是，已收到 " + ap.msgs + " 批") : "还没收到任何数据", !ap.msgs));
    panelBody.appendChild(line("解析到的回复推文", (ap.tweets || 0) + " 条"));
    panelBody.appendChild(line("由此新增", "你回TA +" + (ap.out || 0) + " / TA回你 +" + (ap.inn || 0)));
    panelBody.appendChild(line("我的 userId", ap.myId || "（还没认出来）", !ap.myId));
    panelBody.appendChild(line("已学到 用户ID→用户名", (ap.ids || 0) + " 个"));
    panelBody.appendChild(line("作者名解析不出", (ap.unresolvedAuthor || 0) + " 条"));
    if (ap.unknownUser || ap.pending) {
      panelBody.appendChild(line("回复对象待解析（映射没学到）", (ap.unknownUser || 0) + " 次，队列积压 " + (ap.pending || 0) + " 条"));
    }
    if (ap.sample) {
      panelBody.appendChild(el("div", { cls: "secl", text: "接口返回结构抽样（intercept.js 上报）" }));
      panelBody.appendChild(el("pre", { cls: "diag", text: apiSampleText(ap.sample) }));
    }
    if (!ap.msgs) {
      panelBody.appendChild(el("div", { cls: "fix", text: "没收到接口数据。可能原因：① intercept.js 是新增文件，必须在 chrome://extensions 里「重新加载」扩展，只刷新页面不够；② 这个页面的数据走了缓存没发新请求，往下滚动触发加载再看；③ 浏览器低于 Chrome 111 不支持 MAIN world。" }));
    } else if (!ap.myId) {
      panelBody.appendChild(el("div", { cls: "fix", text: "收到接口数据了，但还没认出你的 userId —— 这一项没认出来，「TA回你」就判不了，「你回TA」也认不出哪条是你发的。去 x.com/你的用户名/with_replies 往下滚一屏（那里的响应带 data.user.result，能直接认出你），然后回来看这一行。" }));
    } else if (!(ap.out || 0) && !(ap.inn || 0)) {
      panelBody.appendChild(el("div", { cls: "fix", text: "userId 认出来了但没记到账。看上面「接口返回结构抽样」里 withAuthorId / withAuthorName 是不是 0 —— 是 0 就说明 X 的字段名又变了，把抽样内容复制给我。" }));
    }

    var ctx = currentTweetCtx();
    panelBody.appendChild(sec("5. 当前帖子"));
    if (ctx) {
      panelBody.appendChild(line("帖子 ID", ctx.id));
      panelBody.appendChild(line("作者", ctx.author ? "@" + ctx.author : "（没认出来）", !ctx.author));
      panelBody.appendChild(line("正文长度", ctx.src ? ctx.src.length + " 字" : "0（无文字）", !ctx.src));
      panelBody.appendChild(line("配图", (ctx.images || []).length + " 张"));
      var th = collectThread();
      panelBody.appendChild(line("评论区已加载", th ? th.total + " 条" : "0 条"));
      panelBody.appendChild(line("本次作为仿写样本带给模型", th ? th.replies.length + " 条" : "0 条"));
      panelBody.appendChild(line("看图开关", CFG.useVision === false ? "关" : ("开 → " + (CFG.visionModel || DEF.visionModel))));
      if (!ctx.src && !(ctx.images || []).length && !(th && th.total)) {
        panelBody.appendChild(el("div", { cls: "fix", text: "正文、配图、评论全空，AI 没有任何可参考的内容。等页面加载完或往下滚动加载评论后再试。" }));
      }
    } else {
      panelBody.appendChild(line("状态", "不在帖子详情页（" + r.page + "）"));
    }

    panelBody.appendChild(sec("6. 输入框（填入功能）"));
    var ed = findEditor();
    var onDetail = !!currentTweetId();
    panelBody.appendChild(line("页面类型", onDetail ? "帖子详情页" : "非详情页（时间线/个人主页）"));
    panelBody.appendChild(line("选中的输入框", ed ? ("是 · " + describeEditor(ed)) : "没找到", !ed && onDetail));
    if (!ed && !onDetail) {
      panelBody.appendChild(el("div", { cls: "fix", text: "这是正常的：时间线和个人主页上根本没有回复输入框，所以「填入」必然失败。要测填入，请点进任意一条帖子 → 先点一次「回复」把输入框展开 → 再回来看这一节。" }));
    } else if (!ed && onDetail) {
      panelBody.appendChild(el("div", { cls: "fix", text: "在详情页仍找不到输入框。先点一次「回复」展开它；若展开了还是没有，把下面的清单复制给我。" }));
    }
    if (lastFillDiag) {
      panelBody.appendChild(el("div", { cls: "fix", text: "检测到上次「填入」失败，清单已刷新如下：" }));
      lastFillDiag = "";
    }
    panelBody.appendChild(el("pre", { cls: "diag", text: r.editors || editorDiag() }));

    panelBody.appendChild(sec("7. 自动点赞"));
    panelBody.appendChild(line("开关", CFG.autoLike ? "开" : "关", !CFG.autoLike));
    if (CFG.autoLike) {
      var b = clamp(parseInt(CFG.autoLikeDelay, 10) || 700, 250, 8000);
      var pc = clamp(parseInt(CFG.autoLikeJitter, 10) || 0, 0, 90);
      var lo = Math.max(250, Math.round(b - b * pc / 100)), hi = Math.round(b + b * pc / 100);
      panelBody.appendChild(line("延迟", pc ? ("随机 " + lo + "~" + hi + "ms（基准 " + b + "ms ±" + pc + "%）") : ("固定 " + b + "ms")));
      panelBody.appendChild(line("上次实际用的延迟", lastLikeDelay ? lastLikeDelay + "ms" : "（还没点过赞）"));
    }
    var lk = likeState(mainArticle());
    panelBody.appendChild(line("当前原帖点赞状态", { liked: "已赞", unliked: "未赞（可点）", nobtn: "找不到赞按钮", noart: "不在帖子详情页" }[lk] || lk, lk === "nobtn"));
    panelBody.appendChild(line("触发机制", "捕获阶段监听 tweetButton / tweetButtonInline 的点击"));
    if (autoLikeLog.length) {
      panelBody.appendChild(el("div", { cls: "secl", text: "最近 " + Math.min(autoLikeLog.length, 8) + " 次点赞记录" }));
      panelBody.appendChild(el("pre", {
        cls: "diag",
        text: autoLikeLog.slice(0, 8).map(function (x) {
          return new Date(x.ts).toLocaleTimeString() + "  @" + (x.who || "?") + "  " +
            (x.skipped ? "跳过（" + x.skipped + "）" : (x.ok ? "成功" : "失败：" + (x.why || "")));
        }).join("\n")
      }));
    } else {
      panelBody.appendChild(el("div", { cls: "hint", text: "还没有点赞记录。发一条回复后这里会记下成功或失败原因。" }));
    }

    panelBody.appendChild(sec("8. 存储"));
    var acc = DATA.byAccount || {};
    var names = Object.keys(acc);
    var dCount = 0, iCount = 0, hCount = 0;
    names.forEach(function (n) {
      var A = acc[n] || {};
      var ds = Object.keys(A.drafts || {});
      dCount += ds.length;
      ds.forEach(function (k) { iCount += ((A.drafts[k] || {}).items || []).length; });
      hCount += Object.keys(A.handles || {}).length;
    });
    panelBody.appendChild(line("分区账号", names.length ? names.map(function (n) { return "@" + n; }).join(" ") : "（无）"));
    panelBody.appendChild(line("草稿", dCount + " 帖 / " + iCount + " 条"));
    panelBody.appendChild(line("追踪对象", hCount + " 人 / 上限 " + (LIMITS.handlesMax || 5000)));
    panelBody.appendChild(line("userId→用户名 缓存", Object.keys(idMap()).length + " 个 / 上限 " + IDS_MAX));
    panelBody.appendChild(line("手速样本", (Array.isArray(DATA.sends) ? DATA.sends.length : 0) + " 次发送"));
    // 配额可见性：存储写失败以前是完全静默的，用户还以为在正常记录
    var kb = lastSaveBytes ? (lastSaveBytes / 1024) : (function () {
      try { return JSON.stringify(DATA).length / 1024; } catch (e) { return 0; }
    })();
    var quota = 10240;   // chrome.storage.local 默认 10MB（未申请 unlimitedStorage）
    var pctOfQuota = Math.min(100, Math.round(kb / quota * 100));
    panelBody.appendChild(line("本地占用", kb.toFixed(1) + " KB（约配额 " + quota + " KB 的 " + pctOfQuota + "%）", pctOfQuota > 70));
    panelBody.appendChild(line("保存状态", saveFails ? ("失败 " + saveFails + " 次！数据可能没落盘") : "正常", !!saveFails));
    if (pctOfQuota > 70) {
      panelBody.appendChild(el("div", { cls: "fix", text: "本地数据已用掉配额的 " + pctOfQuota + "%。继续涨到满时插件会自动淘汰最久没互动的追踪对象，但更稳妥的做法是去设置里「清空互动数据」重置一次基线。" }));
    }
    panelBody.appendChild(line("插件版本", "v" + version()));

    var report = buildReport(r);
    panelBody.appendChild(el("div", { cls: "btnrow" }, [
      el("button", {
        cls: "b pri", text: "复制诊断报告",
        on: { click: function () { copyText(report).then(function (ok) { toast(ok ? "诊断报告已复制" : "复制失败", ok ? "ok" : "err"); }); } }
      }),
      el("button", { cls: "b", text: "重新扫描", on: { click: function () { lastScan = scanNow(); renderPanel(); toast("已重新扫描", "ok"); } } })
    ]));
  }

  // 把 intercept.js 上报的结构抽样拍平成可读文本。
  // 字段名一变，这里就能直接看出来，不用再靠猜。
  function apiSampleText(s) {
    if (!s || typeof s !== "object") return "（无）";
    var lines = [
      "深扫节点数 = " + (s.nodes || 0),
      "学到用户 = " + (s.users || 0) + " 个",
      "提取推文 = " + (s.tweets || 0) + " 条",
      "  其中带 authorId   = " + (s.withAuthorId || 0) + " 条" + ((s.tweets && !s.withAuthorId) ? "   ← 0 说明 legacy.user_id_str 这条路也没取到" : ""),
      "  其中带 authorName = " + (s.withAuthorName || 0) + " 条" + ((s.tweets && !s.withAuthorName) ? "   ← 0 说明 screen_name 不在预期位置" : "")
    ];
    var keys = s.keys || {};
    Object.keys(keys).forEach(function (tag) {
      var arr = keys[tag];
      if (Array.isArray(arr)) lines.push("[" + tag + "] 字段名: " + arr.join(", "));
    });
    return lines.join("\n");
  }

  function describeEditor(ed) {
    var host = ed.closest ? ed.closest("[data-testid]") : null;
    return "<" + ed.tagName.toLowerCase() + ">" +
      " testid=" + (ed.getAttribute("data-testid") || (host && host.getAttribute("data-testid")) || "-") +
      " role=" + (ed.getAttribute("role") || "-") +
      " data-text=" + (ed.getAttribute("data-text") || "-");
  }

  function buildReport(r) {
    var ctx = currentTweetCtx();
    var th = ctx ? collectThread() : null;
    return [
      "我爱说人话诊断报告 v" + version(),
      "时间: " + new Date().toISOString(),
      "URL: " + location.href,
      "",
      "[账号]",
      "  me = " + (r.me || "(空)"),
      "  识别方式 = " + r.meHow,
      "  trackInteractions = " + CFG.trackInteractions,
      "",
      "[本页]",
      "  article 数 = " + r.articles + "（其中嵌套引用卡片 " + (r.nestedArticles || 0) + "）",
      "  我发的 = " + r.mineArticles,
      "  带回复对象 = " + r.withTarget,
      "  对象 = " + r.targets.join(", "),
      "  新增 你回TA=" + r.addedOut + "(回复行)+" + ((r.addedConv || {}).out || 0) + "(对话模块)" +
      "  TA回你=" + r.addedThread + "(详情页)+" + ((r.addedConv || {}).inn || 0) + "(对话模块)+" + r.addedNotif + "(通知页)",
      "  对话模块 cell = " + ((r.convCells || {}).modules || 0) + " 个 / 含推文 " + ((r.convCells || {}).artsInModule || 0) +
      " 条 / 无 cell 包裹 " + ((r.convCells || {}).artsNoCell || 0) + " 条",
      "",
      "[手速]",
      (function () {
        var a = sendRate(10), b = sendRate(60);
        return "  最近10分钟发出 " + a.n + " 条 -> 每小时约 " + a.perHour + " 条\n" +
          "  最近60分钟发出 " + b.n + " 条 -> 每小时约 " + b.perHour + " 条\n" +
          "  照最近10分钟的速度：全天不停约 " + a.perDay24 + " 条 / 按每天活跃8小时约 " + a.perDay8 + " 条\n" +
          "  样本 " + a.total + " 次发送（只记真实点击发送的时刻，最多留 " + 80 + " 次）" +
          (a.newest ? "\n  最近一次发送 " + new Date(a.newest).toISOString() : "");
      })(),
      "",
      "[X 接口数据]（最可靠来源，不依赖 DOM）",
      "  intercept.js 收到批次 = " + ((r.api || {}).msgs || 0),
      "  解析到回复推文 = " + ((r.api || {}).tweets || 0) + " 条",
      "  由此新增 你回TA = " + ((r.api || {}).out || 0) + " / TA回你 = " + ((r.api || {}).inn || 0),
      "  我的 userId = " + ((r.api || {}).myId || "(未识别)"),
      "  已学到 用户ID→用户名 = " + ((r.api || {}).ids || 0) + " 个",
      "  回复对象 userId 未映射 = " + ((r.api || {}).unknownUser || 0) + " 次（待解析队列 " + ((r.api || {}).pending || 0) + " 条）",
      "  作者名解析不出 = " + ((r.api || {}).unresolvedAuthor || 0) + " 条",
      "  --- 接口返回结构抽样 ---",
      indent(apiSampleText((r.api || {}).sample)),
      "",
      "[推文结构抽样]",
      indent(r.articleAnatomy),
      "",
      "[通知页]",
      "  在通知页 = " + !!r.onNotifications,
      r.onNotifications ? ("  容器选择器 = " + r.notifSel + "\n  容器命中条数 = " + r.notifCells +
        "\n  容器无关扫描: 「回复」标签 " + (r.flatActions || 0) + " 个, 认出发起人 " +
        ((r.flatActors || []).length) + " 个" +
        ((r.flatActors || []).length ? "（" + r.flatActors.slice(0, 10).map(function (a) { return "@" + a; }).join(" ") + "）" : "") +
        ", 因未提及我而跳过 " + (r.flatSkipped || 0) + " 个") : "  （不在 /notifications，无法验证这条路）",
      r.onNotifications ? indent(r.notifAnatomy) : "",
      "",
      "[当前帖子]",
      ctx ? ("  id = " + ctx.id + "\n  author = " + ctx.author + "\n  正文长度 = " + (ctx.src || "").length +
        "\n  配图 = " + (ctx.images || []).length + "\n  评论已加载 = " + (th ? th.total : 0) + "\n  将带给模型 = " + (th ? th.replies.length : 0)) : "  不在详情页",
      "",
      "[配置]",
      "  model = " + CFG.model + " / visionModel = " + (CFG.visionModel || DEF.visionModel),
      "  useVision = " + (CFG.useVision !== false) + "  useComments = " + CFG.useComments +
      "  maxComments = " + CFG.maxComments + "  candidates = " + CFG.candidates,
      "  autoGenerate = " + CFG.autoGenerate + "  autoFill = " + CFG.autoFill,
      "  translateUI = " + CFG.translateUI + "  myHandle = " + (CFG.myHandle || "(自动)"),
      "  baseUrl = " + CFG.baseUrl,
      "",
      "[输入框]",
      "  页面类型 = " + (currentTweetId() ? "帖子详情页" : "非详情页"),
      "  选中 = " + (findEditor() ? describeEditor(findEditor()) : "没找到"),
      "  上次填入失败诊断 = " + (lastFillDiag || "(无)"),
      indent(r.editors || editorDiag()),
      "",
      "[自动点赞]",
      "  开关 = " + (CFG.autoLike ? "开" : "关") + "  基准延迟 = " + (CFG.autoLikeDelay || 700) +
      "ms ±" + (CFG.autoLikeJitter || 0) + "%  上次实际 = " + (lastLikeDelay || 0) + "ms" +
      "  当前原帖 = " + likeState(mainArticle()),
      autoLikeLog.length ? ("  最近记录 = " + autoLikeLog.slice(0, 5).map(function (x) {
        return "@" + (x.who || "?") + ":" + (x.skipped ? "跳过" : (x.ok ? "成功" : "失败(" + (x.why || "") + ")"));
      }).join(" | ")) : "",
      "",
      "[存储]",
      storageSummary(),
      "",
      "[存储占用]",
      "  上次写入大小 = " + ((lastSaveBytes || 0) / 1024).toFixed(1) + " KB（chrome.storage.local 默认配额约 10240 KB）",
      "  保存失败次数 = " + saveFails + (saveFails ? "  ← 数据可能没落盘" : ""),
      "  userId→用户名缓存 = " + Object.keys(idMap()).length + " / 上限 " + IDS_MAX,
      "  手速样本 = " + (Array.isArray(DATA.sends) ? DATA.sends.length : 0) + " 次发送"
    ].filter(function (s) { return s !== ""; }).join("\n");
  }

  function indent(s) {
    return String(s == null ? "" : s).split("\n").map(function (l) {
      return l.indexOf("  ") === 0 ? l : (l ? "  " + l : "");
    }).join("\n");
  }

  function storageSummary() {
    var acc = DATA.byAccount || {}, names = Object.keys(acc);
    var d = 0, it = 0, h = 0, nt = 0;
    names.forEach(function (n) {
      var A = acc[n] || {}, ds = Object.keys(A.drafts || {});
      d += ds.length;
      ds.forEach(function (k) {
        ((A.drafts[k] || {}).items || []).forEach(function (x) { it++; if (x.note) nt++; });
      });
      h += Object.keys(A.handles || {}).length;
    });
    return "  分区账号 = " + (names.join(", ") || "(无)") + "\n  草稿 = " + d + " 帖 / " + it + " 条（含备注 " + nt +
      "）\n  追踪对象 = " + h + " 人";
  }

  // ==================== 关注页 ====================
  var PHASE_COLOR = { idle: "#71767b", going: "#1d9bf0", near: "#ffad1f", full: "#00ba7c", cooling: "#f4212e", ready: "#00ba7c" };
  var PHASE_TEXT = {
    idle: "本轮还没开始关注",
    going: "可以继续关注",
    near: "快到额度了，注意节奏",
    full: "本轮额度用完，歇一会儿",
    cooling: "撞限冷却中，别再点了",
    ready: "等够了，可以再关注一批"
  };

  function renderFollowConsent() {
    var FS = X.FSTATS;
    panelBody.appendChild(el("div", { cls: "ctx" }, [
      el("div", { cls: "who", text: "关注追踪：开始记录前请先看一眼" }),
      el("div", { cls: "src", style: "-webkit-line-clamp:unset", text: "同意后插件会读取页面自己已经发出的关注/取关请求结果，" +
        "并从 X 本来就会加载的用户资料里读出「你关注的人有没有关注你」。" })
    ]));

    panelBody.appendChild(el("div", { cls: "d" }, [
      el("div", { cls: "txt", text: "会记录什么" }),
      el("div", { cls: "hint", style: "margin-top:6px", text:
        "· 关注/取关的结果、时间、当时所在的页面路径（用来算「从哪关注最容易换来回关」）\n" +
        "· 对方的用户名，以及对方有没有关注你\n" +
        "· 撞限的那一下：状态码、X 给的错误文案、之前各时间窗口关注了多少个" })
    ]));

    panelBody.appendChild(el("div", { cls: "d" }, [
      el("div", { cls: "txt", text: "不会做什么" }),
      el("div", { cls: "hint", style: "margin-top:6px", text:
        "· 不替你关注、取关、发任何请求 —— 只旁观页面自己发的\n" +
        "· 不上传任何数据。全部只存在这台电脑的 chrome.storage.local 里\n" +
        "· 不读取凭据、Cookie、私信内容" })
    ]));

    panelBody.appendChild(el("div", { cls: "hint", text:
      "同意之前，注入脚本一个关注类响应都不读（不是「读了不存」，是根本不读）。" +
      "撤回同意后立刻停手，在途的读取也会作废。数据说明有实质变化时会要求你重新同意一次。" }));

    panelBody.appendChild(el("button", { cls: "gen", text: "同意并开始记录", on: { click: grantFollowConsent } }));
    if (!CFG.followTrack) {
      panelBody.appendChild(el("div", { cls: "hint", style: "color:#ffad1f", text:
        "注意：插件设置里的「关注追踪」总开关现在是关的，光同意不会开始记录。" }));
    }
  }

  function renderFollow() {
    panelBody.textContent = "";
    var FS = X.FSTATS;
    var f = F();
    if (!FS.hasConsent(f.consent)) { renderFollowConsent(); return; }

    var now = Date.now();
    var set = followSettings();
    var st = FS.compute(f.events, now, 0);
    var ph = FS.phase(st, set);
    var color = PHASE_COLOR[ph.name] || "#1d9bf0";

    // ---- 1. 本轮计数 ----
    var pct = Math.min(100, Math.round(ph.done / Math.max(1, ph.size) * 100));
    panelBody.appendChild(el("div", { cls: "fcount", style: "border-color:" + color + "55" }, [
      el("div", { cls: "n", style: "color:" + color, text: ph.done + " / " + ph.size }),
      el("div", { cls: "s", text: PHASE_TEXT[ph.name] || "" }),
      el("div", { cls: "pbar" }, [el("i", { style: "width:" + pct + "%;background:" + color })]),
      el("div", { cls: "m", text: "额度来源：" + ph.from + (ph.from === "默认" ? "（X 没公布这个数字，可在下面改成你自己的经验值）" : "") })
    ]));

    // ---- 2. 冷却 / 休息进度 ----
    if (st.cooling) {
      var ref = st.bestKnownCooldown;
      var left = ref ? Math.max(0, ref - st.cooling.elapsed) : null;
      panelBody.appendChild(el("div", { cls: "d", style: "border-color:rgba(244,33,46,.45)" }, [
        el("div", { cls: "txt", style: "color:#f4212e;font-weight:700", text: "撞限冷却中" }),
        el("div", { cls: "hint", style: "margin-top:5px", text:
          "从本轮最后一次成功关注算起，已经等了 " + FS.formatDuration(st.cooling.elapsed) + "\n" +
          "撞限后又试了 " + st.cooling.retries + " 次，每次都失败（每试一次都可能把冷却重新拉长）\n" +
          (ref ? "参考：上次等满 " + FS.formatDuration(ref) + " 后就恢复了，还需约 " + FS.formatDuration(left)
               : "还没有可参考的恢复时长 —— 这次恢复之后就能算出来") })
      ]));
    } else if (st.rest) {
      var rp = Math.min(100, Math.round(st.rest.elapsed / Math.max(1, st.rest.reset) * 100));
      panelBody.appendChild(el("div", { cls: "d" }, [
        el("div", { cls: "txt", text: st.rest.rested ? "已经歇够，可以开新一轮" : "休息中，没撞限" }),
        el("div", { cls: "hint", style: "margin-top:5px", text: "距上次成功关注 " + FS.formatDuration(st.rest.elapsed) + "，满 " + FS.formatDuration(st.rest.reset) + " 算新一轮" }),
        el("div", { cls: "pbar" }, [el("i", { style: "width:" + rp + "%;background:#1d9bf0" })])
      ]));
    }

    // ---- 3. 各窗口计数 ----
    var card = function (k, v, unit) {
      return el("div", { cls: "card" }, [
        el("div", { cls: "k", text: k }),
        el("div", { cls: "v" }, [String(v), unit ? el("small", { text: " " + unit }) : null])
      ]);
    };
    panelBody.appendChild(el("div", { cls: "sec" }, ["各时间窗口"]));
    panelBody.appendChild(el("div", { cls: "st" }, [
      card("15 分钟关注", st.follow15m, "个"),
      card("1 小时关注", st.follow1h, "个"),
      card("24 小时关注", st.follow24h, "个"),
      card("24 小时取关", st.unfollow24h, "个")
    ]));

    // ---- 4. 学到的账号规律 ----
    var rh = FS.rhythm(st);
    panelBody.appendChild(el("div", { cls: "sec" }, ["你这个账号的规律"]));
    if (!rh) {
      panelBody.appendChild(el("div", { cls: "hint", text: "还没撞过限，所以没有可总结的规律。撞过几次之后，这里会给出你账号自己的每轮个数和该等多久 —— 比任何通用建议都准。" }));
    } else {
      panelBody.appendChild(el("div", { cls: "d" }, [
        el("div", { cls: "hint", style: "margin-top:0", text:
          "撞限 " + rh.count + " 轮\n" +
          (rh.typical != null ? "撞限前那一轮通常关注了 " + rh.typical + " 个\n" : "") +
          (rh.waitMin != null ? "等过 " + FS.formatDuration(rh.waitMin) + " 仍然不够（这是下限）\n" : "") +
          (rh.waitMax != null ? "等到 " + FS.formatDuration(rh.waitMax) + " 就能再关注（这是上限）" : "") })
      ]));
      if (st.limitHits && st.limitHits.length) {
        panelBody.appendChild(el("details", { cls: "hist" }, [
          el("summary", {}, [el("div", { cls: "h" }, [
            el("span", { cls: "a", text: "最近 " + st.limitHits.length + " 次撞限" }),
            el("span", { cls: "c", text: "详情" })
          ])]),
          el("div", { cls: "inner" }, st.limitHits.map(function (x) {
            var w = x.windows || {};
            return el("div", { cls: "hint", style: "margin:0 0 7px", text:
              new Date(x.start).toLocaleString() + "\n" +
              "撞限前：15分 " + w.m15 + " / 30分 " + w.m30 + " / 1小时 " + w.h1 + " / 24小时 " + w.h24 + "\n" +
              "那一轮关注了 " + x.batch + " 个，重试 " + x.retries + " 次" +
              (x.end != null ? "，等 " + FS.formatDuration(x.cooldownMax) + " 后恢复" : "，仍在冷却") +
              (x.event && x.event.message ? "\nX 的原话：" + String(x.event.message).slice(0, 100) : "") });
          }))
        ]));
      }
    }

    // ---- 5. churn 护栏 ----
    var ch = FS.churn(f.events, now);
    if (ch.level !== "ok") {
      panelBody.appendChild(el("div", { cls: "d", style: "border-color:" + (ch.level === "high" ? "rgba(244,33,46,.5)" : "rgba(255,173,31,.5)") }, [
        el("div", { cls: "txt", style: "color:" + (ch.level === "high" ? "#f4212e" : "#ffad1f") + ";font-weight:700",
          text: ch.level === "high" ? "取关节奏偏快，建议今天收手" : "注意取关节奏" }),
        el("div", { cls: "hint", style: "margin-top:5px", text:
          "24 小时内取关 " + ch.unfollow24h + " 个，其中 " + ch.quick24h + " 个是关注后 72 小时内就取关的。\n" +
          "X 明确禁止 follow churn（大量关注后取关涨粉），可能被限制、过滤甚至关停账号。" })
      ]));
    }

    // ---- 6. 回关统计 ----
    var fb = FS.followBack(f.follows, now);
    panelBody.appendChild(el("div", { cls: "sec" }, ["回关情况", el("span", { cls: "sp" })]));
    if (!fb.tracked) {
      panelBody.appendChild(el("div", { cls: "hint", text: "还没记录到关注。开始正常用 X 关注人之后，这里会统计回关率，并按「从哪个页面关注的」分档 —— 用来找出对你来说最容易换来回关的入口。" }));
    } else {
      panelBody.appendChild(el("div", { cls: "st" }, [
        card("记录的关注", fb.tracked, "个"),
        card("已回关", fb.yes, "个"),
        card("回关率", fb.rate != null ? Math.round(fb.rate * 100) + "%" : "—", ""),
        card("状态未知", fb.pending, "个")
      ]));
      if (fb.byCat && fb.byCat.length) {
        panelBody.appendChild(el("div", { cls: "d" }, [
          el("div", { cls: "txt", text: "按关注入口分档" }),
          fb.byCat.map(function (r) {
            var p = r.known ? Math.round(r.rate * 100) : 0;
            return el("div", { cls: "row" }, [
              el("span", { cls: "a", text: r.label }),
              el("span", { cls: "p" }, [el("i", { style: "width:" + p + "%;background:#1d9bf0" })]),
              el("span", { cls: "n", text: r.known ? (p + "%/" + r.known) : ("?/" + r.n) })
            ]);
          }),
          el("div", { cls: "hint", text: "分母是「已知回关状态」的个数。状态未知的不算进回关率，免得把刚关注的人当成不回关。" })
        ]));
      }
      if (fb.byVia && fb.byVia.length) {
        panelBody.appendChild(el("details", { cls: "hist" }, [
          el("summary", {}, [el("div", { cls: "h" }, [
            el("span", { cls: "a", text: "回关率最高的具体来源" }),
            el("span", { cls: "c", text: fb.byVia.length + " 个" })
          ])]),
          el("div", { cls: "inner" }, fb.byVia.map(function (r) {
            return el("div", { cls: "row" }, [
              el("span", { cls: "a", text: "@" + r.via }),
              el("span", { cls: "p" }, [el("i", { style: "width:" + Math.round((r.rate || 0) * 100) + "%;background:#00ba7c" })]),
              el("span", { cls: "n", text: Math.round((r.rate || 0) * 100) + "%/" + r.known })
            ]);
          }))
        ]));
      }
    }

    // ---- 7. 未回关名单 ----
    var rows = FS.nonFollowers(f.following, f.follows, now, f.keep);
    var D7 = 7 * 24 * 60 * 60 * 1000, D3 = 3 * 24 * 60 * 60 * 1000;
    var filtered = rows.filter(function (r) {
      if (followFilter === "old") return r.age == null || r.age >= D7;
      if (followFilter === "fresh") return r.age != null && r.age < D3;
      if (followFilter === "unknown") return r.fb == null;
      if (followFilter === "kept") return r.keep;
      return true;
    });
    var shown = followFilter === "kept" ? filtered : filtered.filter(function (r) { return !r.keep; });

    panelBody.appendChild(el("div", { cls: "sec" }, [
      "未回关名单", el("span", { cls: "n", text: String(shown.length) }), el("span", { cls: "sp" }),
      el("button", { cls: "b ico", text: "复制", title: "复制这批用户名（每行一个，带 @）", on: {
        click: function () {
          var txt = shown.map(function (r) { return "@" + r.key; }).join("\n");
          if (!txt) { toast("这个筛选下没有人", "", 2500); return; }
          copyText(txt).then(function (ok) { toast(ok ? ("已复制 " + shown.length + " 个用户名") : "复制失败，浏览器拒绝了剪贴板", ok ? "ok" : "err", 3000); });
        }
      } })
    ]));

    var chips = [["all", "全部"], ["old", "超 7 天"], ["fresh", "3 天内"], ["unknown", "状态未知"], ["kept", "已保留"]];
    panelBody.appendChild(el("div", { cls: "chips" }, chips.map(function (c) {
      return el("button", {
        cls: "chip" + (followFilter === c[0] ? " on" : ""), text: c[1],
        on: { click: function () { followFilter = c[0]; renderPanel(); } }
      });
    })));

    if (!rows.length) {
      panelBody.appendChild(el("div", { cls: "hint", text: "名单是空的。这里的判定来自 X 自己返回的关注关系字段，需要你在页面上刷到过对方（打开 TA 的主页、或在关注/粉丝列表里滚到 TA）才会知道状态。" }));
    } else if (!shown.length) {
      panelBody.appendChild(el("div", { cls: "empty", text: "这个筛选下没有人" }));
    } else {
      shown.slice(0, 200).forEach(function (r) {
        var ageTxt = r.age != null ? "关注 " + FS.formatDuration(r.age) + "前" : "插件装上前就关注了";
        var srcTxt = r.src ? (FS.SOURCE_LABELS[r.src] || r.src) + (r.via ? " · @" + r.via : "") : "";
        panelBody.appendChild(el("div", { cls: "d" }, [
          el("div", { cls: "h" }, [
            el("a", { cls: "lnk", text: "@" + r.key, attrs: { href: "https://x.com/" + r.key, target: "_blank", rel: "noreferrer" } }),
            el("span", { cls: "sp" }),
            r.fb === false ? el("span", { cls: "tag warn", text: "没回关" }) : el("span", { cls: "tag", text: "状态未知" })
          ]),
          el("div", { cls: "meta", text: ageTxt + (r.fresh ? " · 还在 72 小时内，先别急着取关" : "") + (srcTxt ? "\n来源：" + srcTxt : "") }),
          el("div", { cls: "bar" }, [
            el("button", { cls: "b", text: r.keep ? "取消保留" : "保留", title: "保留的人不会出现在催办名单里", on: {
              click: function () {
                if (r.keep) delete f.keep[r.key]; else f.keep[r.key] = true;
                markDirty(); renderPanel();
              }
            } }),
            el("button", { cls: "b ico", text: "复制", on: {
              click: function () { copyText("@" + r.key).then(function (ok) { toast(ok ? "已复制 @" + r.key : "复制失败", ok ? "ok" : "err", 2200); }); }
            } })
          ])
        ]));
      });
      if (shown.length > 200) {
        panelBody.appendChild(el("div", { cls: "hint", text: "只显示前 200 个（共 " + shown.length + " 个）。用上面的筛选缩小范围，或点「复制」拿全部。" }));
      }
    }

    // ---- 8. X 官方限制 ----
    var L = X.X_LIMITS;
    panelBody.appendChild(el("details", { cls: "hist" }, [
      el("summary", {}, [el("div", { cls: "h" }, [
        el("span", { cls: "a", text: "X 官方公布的限制" }),
        el("span", { cls: "c", text: (L.checkedAt || "") + " 存档" })
      ])]),
      el("div", { cls: "inner" }, [
        el("div", { cls: "st" }, L.tiles.map(function (t) {
          return el("div", { cls: "card" }, [
            el("div", { cls: "k", text: t.label, title: t.note }),
            el("div", { cls: "v" }, [t.value, el("small", { text: " " + t.unit })])
          ]);
        })),
        el("div", { cls: "hint", text: L.notes.map(function (n) { return "· " + n; }).join("\n") }),
        el("div", { cls: "hint" }, [
          "来源：", el("a", { cls: "lnk", text: "X Limits", attrs: { href: L.source, target: "_blank", rel: "noreferrer" } }),
          " · ", el("a", { cls: "lnk", text: "关注上限", attrs: { href: L.followSource, target: "_blank", rel: "noreferrer" } })
        ])
      ])
    ]));

    // ---- 9. 设置与数据 ----
    panelBody.appendChild(el("div", { cls: "sec" }, ["设置"]));
    var rsInput = el("input", {
      cls: "num", attrs: { type: "number", min: "0", max: "400", step: "1", value: String(set.roundSize || 0) },
      title: "0 = 用默认 15"
    });
    panelBody.appendChild(el("div", { cls: "d" }, [
      el("div", { cls: "fld" }, [
        el("span", { cls: "lb", text: "每轮关注额度" }),
        rsInput,
        el("button", { cls: "b", text: "保存", on: {
          click: function () {
            var v = Math.max(0, Math.min(400, parseInt(rsInput.value, 10) || 0));
            CFG.followRoundSize = v;
            saveCfgField("followRoundSize", v);
            toast(v ? ("每轮额度改成 " + v + " 个") : "已改回默认 15 个", "ok", 2500);
            renderPanel();
          }
        } })
      ]),
      el("div", { cls: "hint", text: "X 没公布「一轮能关注几个」，15 是经验默认值。撞过限之后照着上面「你这个账号的规律」改成自己的数更准。" })
    ]));

    panelBody.appendChild(el("div", { cls: "d" }, [
      toggleRow("悬浮计数角标", "页面左下角常驻显示本轮已关注几个，撞限时变红。默认关。", "followShowBadge", function () { updateFollowBadge(); }),
      el("div", { cls: "hint", text: "记录到的数据：" + f.events.length + " 条事件 / " + Object.keys(f.follows).length + " 个关注 / " + Object.keys(f.following).length + " 个已知关系。全部只存在这台电脑上。" })
    ]));

    panelBody.appendChild(el("div", { cls: "d" }, [
      el("div", { cls: "bar" }, [
        el("button", { cls: "b danger", text: "清除关注数据", title: "删掉事件、关注记录、关系和保留名单，但不撤回同意", on: {
          click: function () { if (confirm("清除全部关注追踪数据？这不会撤回同意，之后仍会继续记录。")) clearFollowData(); }
        } }),
        el("button", { cls: "b danger", text: "撤回同意并停止", title: "停止读取任何关注类响应，已有数据保留", on: {
          click: function () { if (confirm("撤回同意？注入脚本会立刻停止读取关注类响应，已记录的数据保留（想删请点「清除关注数据」）。")) revokeFollowConsent(); }
        } })
      ])
    ]));
  }

  // 面板里的开关行：改 CFG 并立刻持久化那一个字段
  function toggleRow(label, hint, field, after) {
    var box = el("input", { cls: "ck", attrs: { type: "checkbox" } });
    box.checked = !!CFG[field];
    box.addEventListener("change", function () {
      CFG[field] = box.checked;
      saveCfgField(field, box.checked);
      if (after) after();
    });
    return el("label", { cls: "fld ckrow" }, [box, el("span", { cls: "lb", text: label }), hint ? el("span", { cls: "hint", style: "margin:0;flex-basis:100%", text: hint }) : null]);
  }

  // 只写一个字段：先读回来再合并，避免把 popup 刚改的其它设置覆盖掉
  function saveCfgField(k, v) {
    try {
      chrome.storage.local.get([CFG_KEY], function (r) {
        var c = Object.assign({}, (r && r[CFG_KEY]) || {});
        c[k] = v;
        var o = {}; o[CFG_KEY] = c;
        chrome.storage.local.set(o);
      });
    } catch (e) {}
  }

  function syncTabs() {
    if (!panel) return;
    $$(".tab", panel).forEach(function (t) {
      var on = t.dataset.tab === tabState;
      t.classList.toggle("on", on);
      t.setAttribute("aria-selected", on ? "true" : "false");
    });
  }

  function renderPanel() {
    if (!panelBody) return;
    if (tabState === "stats") renderStats();
    else if (tabState === "follow") renderFollow();
    else if (tabState === "diag") { lastScan = null; renderDiag(); }
    else renderDrafts();
    updateFabDot();
  }

  // ---------- 自动填入开关：面板头部按钮 + 悬浮球标记，两处状态同步 ----------
  var afBtnEl = null;

  function autoFillOn() { return CFG.autoFill === true; }

  function autoFillLabel() { return "自动填入 " + (autoFillOn() ? "开" : "关"); }

  function syncAutoFillUI() {
    if (afBtnEl) {
      afBtnEl.textContent = autoFillLabel();
      afBtnEl.classList.toggle("on", autoFillOn());
      afBtnEl.setAttribute("aria-checked", autoFillOn() ? "true" : "false");
    }
    updateFabAutoFill();
  }

  function toggleAutoFill() {
    var next = !autoFillOn();
    CFG.autoFill = next;                 // 立刻生效，不等 storage 回环
    saveCfgField("autoFill", next);
    syncAutoFillUI();
    toast(
      next ? "自动填入已开启：生成后写进回复框，仍可编辑" : "自动填入已关闭：只复制首条，不写回复框",
      "ok", 2600
    );
  }

  // 悬浮球右下角的「填」标记：亮蓝 = 开，暗灰 = 关，点它直接切换。
  // pointerdown 必须拦住，否则会同时触发悬浮球的拖拽和开面板。
  function updateFabAutoFill() {
    if (!fab) return;
    var b = fab.querySelector(".af");
    if (!b) {
      b = el("span", { cls: "af", text: "填" });
      // pointerdown/pointerup 都要拦：悬浮球的 pointerup 在未拖拽时会切换面板，
      // 只拦 pointerdown 的话点一下标记会顺带把面板开合一次。
      b.addEventListener("pointerdown", function (e) { e.stopPropagation(); });
      b.addEventListener("pointerup", function (e) { e.stopPropagation(); });
      b.addEventListener("click", function (e) { e.stopPropagation(); toggleAutoFill(); });
      fab.appendChild(b);
    }
    b.classList.toggle("on", autoFillOn());
    b.setAttribute("title", autoFillOn() ? "自动填入：开（点一下关闭）" : "自动填入：关（点一下开启）");
  }

  function updateFabDot() {
    if (!fab) return;
    var a = acct();
    var id = currentTweetId();
    var n = a && id && a.drafts[id] ? a.drafts[id].items.length : 0;
    var old = fab.querySelector(".dot");
    if (old) old.remove();
    if (n && !panelOpen) fab.appendChild(el("span", { cls: "dot", text: String(n) }));
    updateFabAutoFill();
  }

  // ==================== 处理管线 ====================
  function process(root) {
    if (!root || root.nodeType !== 1) return;
    if (root.id === "xrh-root") return;
    // 先记账再打徽章，这样新记到的互动能立刻显示出来。
    // 自动下滑扫描期间跳过：autoScanStep 每轮已经全量扫过，observer 再扫纯属重复劳动，
    // 而快速滚动时 mutation 非常密集，这层重复开销不小。
    if (CFG.trackInteractions && DATA.me && !autoScanState.running) {
      scanMyReplies(root);
      scanConversationModules(root);
    }
    injectAiButtons(root);
    badgesIn(root);
    if (CFG.highlightFollow) markFollowCells(root);
    if (CFG.translateUI) translateIn(root);
  }

  var queue = [], queued = false, lastFlush = 0;
  function schedule() {
    if (queued) return;
    queued = true;
    var wait = Math.max(0, 140 - (Date.now() - lastFlush));
    setTimeout(function () { idle(flushQueue); }, wait);
  }

  function flushQueue() {
    queued = false;
    lastFlush = Date.now();
    var batch = queue;
    queue = [];
    for (var i = 0; i < batch.length && i < 400; i++) {
      var n = batch[i];
      if (n && n.isConnected) process(n);
    }
    if (queue.length) schedule();
    updateFabDot();
  }

  var mo = new MutationObserver(function (muts) {
    for (var i = 0; i < muts.length; i++) {
      var m = muts[i];
      if (m.type === "characterData") {
        if (CFG.translateUI && m.target && m.target.parentElement && !m.target.parentElement.closest("#xrh-root")) queue.push(m.target.parentElement);
        continue;
      }
      var added = m.addedNodes;
      for (var j = 0; j < added.length; j++) {
        var n = added[j];
        if (n.nodeType !== 1) continue;
        if (n.id === "xrh-root" || n.classList.contains("xrh-badge") || n.classList.contains("xrh-tag") || n.classList.contains("xrh-ai-btn")) continue;
        queue.push(n);
      }
    }
    if (queue.length) schedule();
  });

  // ==================== 路由（SPA） ====================
  var lastPath = "";
  function routeChanged() {
    var p = location.pathname + location.search;
    if (p === lastPath) return;
    lastPath = p;
    detectMe();
    passiveScan(document.body);
    // 进详情页就预热 Service Worker：MV3 空闲 30 秒会被回收，冷启动要几百毫秒，
    // 等用户真点 AI 时才发现就晚了。
    if (currentTweetId()) warmServiceWorker();
    if (CFG.highlightFollow && followPageKind()) process(document.body);
    renderPanel();
    maybeAutoGenerate();
  }

  function patchHistory() {
    ["pushState", "replaceState"].forEach(function (k) {
      var orig = history[k];
      if (!orig || orig.__xrh) return;
      var wrap = function () {
        var r = orig.apply(this, arguments);
        setTimeout(routeChanged, 0);
        return r;
      };
      wrap.__xrh = true;
      history[k] = wrap;
    });
    window.addEventListener("popstate", function () { setTimeout(routeChanged, 0); });
    window.addEventListener("hashchange", function () { setTimeout(routeChanged, 0); });
  }

  // ==================== 配置热应用 ====================
  function applyCfg() {
    if (!host) return;
    fab.style.display = CFG.showFab === false ? "none" : "";
    if (!CFG.showAiBtn) $$(".xrh-ai-btn").forEach(function (n) { n.remove(); });
    if (!CFG.trackInteractions) $$(".xrh-badge").forEach(function (n) { n.remove(); });
    if (!CFG.highlightFollow) $$(".xrh-tag").forEach(function (n) { n.remove(); });
    if (CFG.trackInteractions) { try { badgesIn(document.body); } catch (e) {} }
    // popup 里关掉总开关要立刻让注入层停手，不能等页面刷新
    pushFollowCtl();
    updateFollowBadge();
    syncAutoFillUI();
    renderPanel();
    positionUI();
  }

  // ==================== 启动 ====================
  function boot() {
    detectMe();
    mountUI();
    patchHistory();
    bindApiBridge();     // 接收 intercept.js 从 X 自身接口响应里提取的回复关系
    pushFollowCtl();     // 告知注入层关注追踪是否已获同意（未同意则一个响应都不读）
    startFollowBadgeTimer();
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    process(document.body);
    routeChanged();
    passiveScan(document.body);
    renderPanel();
    // 兜底轮询：X 有时会整块替换 DOM，observer 之外的场景靠这个补齐
    setInterval(function () {
      detectMe();
      passiveScan(document.body);
      if (CFG.showAiBtn) injectAiButtons(document.body);
      badgesIn(document.body);
      if (CFG.highlightFollow) markFollowCells(document.body);
      routeChanged();
      updateFabDot();
    }, 5000);
  }

  loadAll(function () {
    CFG.panelPos = Object.assign({ right: 20, bottom: 88 }, CFG.panelPos || {});
    if (document.body) boot();
    else document.addEventListener("DOMContentLoaded", boot, { once: true });
  });
})();





