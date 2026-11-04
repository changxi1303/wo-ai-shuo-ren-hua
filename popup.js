// 我爱说人话 — popup
// 所有渲染只用 textContent，API 返回的字符串不进 innerHTML（避免扩展页被注入）。
(function () {
  "use strict";

  var X = globalThis.XRH;
  var DEF = X.DEFAULTS;
  var STYLES = X.STYLES;
  var LIMITS = X.LIMITS;
  var GROUPS = X.MODEL_GROUPS || [];
  var CFG_KEY = X.CFG_KEY;
  var DATA_KEY = X.DATA_KEY;

  var $ = function (id) { return document.getElementById(id); };
  var TOGGLES = ["autoGenerate", "autoFill", "showAiBtn", "showFab", "translateUI",
    "highlightFollow", "trackInteractions", "useComments", "autoScrollComments",
    "disableThinking", "useVision", "autoLike", "hardFilter",
    "followTrack", "followShowBadge", "rerank"];

  var CUSTOM = "__custom__";

  var statusEl = $("status");
  var statusTimer = 0;

  function status(msg, kind, extra) {
    clearTimeout(statusTimer);
    statusEl.textContent = "";
    statusEl.className = kind || "";
    if (!msg) { statusEl.style.display = "none"; return; }
    statusEl.appendChild(document.createTextNode(msg));
    if (extra) {
      statusEl.appendChild(document.createElement("br"));
      var s = document.createElement("span");
      s.className = "mono";
      s.textContent = String(extra).slice(0, 400);
      statusEl.appendChild(s);
    }
    statusEl.style.display = "";
    if (kind === "ok") statusTimer = setTimeout(function () { status("", ""); }, 5000);
  }

  function send(msg) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(msg, function (r) {
          if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
          else resolve(r || { ok: false, error: "后台无响应" });
        });
      } catch (e) { resolve({ ok: false, error: e.message }); }
    });
  }

  // ==================== 模型下拉框 ====================
  var fetchedModels = [];       // 测试连接后拉到的账号可用模型
  var fetchedGroupLabel = "";

  function knownIds() {
    var s = {};
    GROUPS.forEach(function (g) { g.models.forEach(function (m) { s[m.id] = m.note || ""; }); });
    return s;
  }

  function addGroup(sel, label, items) {
    if (!items.length) return;
    var og = document.createElement("optgroup");
    og.label = label;
    items.forEach(function (it) {
      var o = document.createElement("option");
      o.value = it.id;
      o.textContent = it.note ? (it.id + " — " + it.note) : it.id;
      og.appendChild(o);
    });
    sel.appendChild(og);
  }

  // 填充模型下拉框：预设分组 + 账号实测可用 + 当前值 + 自定义入口
  function fillModelSelect(sel, current, visionOnly) {
    sel.textContent = "";
    var seen = {};
    var mark = function (id) { seen[id] = 1; };

    if (visionOnly) {
      var vg = GROUPS.filter(function (g) { return /看图/.test(g.label); })[0];
      addGroup(sel, "可看图", vg ? vg.models.map(function (m) { mark(m.id); return m; }) : []);
    } else {
      GROUPS.forEach(function (g) {
        addGroup(sel, g.label, g.models.map(function (m) { mark(m.id); return m; }));
      });
    }

    // 测试连接后拉到的账号可用模型（去重、排除已列出的）
    if (fetchedModels.length) {
      var extra = fetchedModels.filter(function (id) {
        if (seen[id]) return false;
        if (visionOnly && !/vl|omni|vision/i.test(id)) return false;
        mark(id);
        return true;
      });
      if (extra.length) addGroup(sel, fetchedGroupLabel || ("账号可用（" + extra.length + "）"),
        extra.map(function (id) { return { id: id }; }));
    }

    // 当前保存的值如果不在列表里，单独置顶，避免 select 静默跳到第一项
    if (current && !seen[current]) {
      var og = document.createElement("optgroup");
      og.label = "当前使用";
      var o = document.createElement("option");
      o.value = current;
      o.textContent = current + "（未在预设列表中）";
      og.appendChild(o);
      sel.insertBefore(og, sel.firstChild);
      seen[current] = 1;
    }

    var co = document.createElement("option");
    co.value = CUSTOM;
    co.textContent = "自定义…（手动输入模型名）";
    sel.appendChild(co);

    sel.value = current || "";
    if (sel.value !== current) sel.value = CUSTOM;
  }

  function syncCustomBox() {
    var isCustom = $("model").value === CUSTOM;
    $("modelCustom").style.display = isCustom ? "" : "none";
    var note = knownIds()[$("model").value];
    $("modelNote").textContent = isCustom
      ? "输入服务商支持的任意模型 ID。注意：只有 VL / Omni 类模型能读图。"
      : (note ? "实测：" + note : "");
  }

  // 实时显示随机延迟区间，改数字立刻能看到效果
  function syncLikeRange() {
    var b = Math.min(8000, Math.max(250, parseInt($("autoLikeDelay").value, 10) || DEF.autoLikeDelay));
    var pc = Math.min(90, Math.max(0, parseInt($("autoLikeJitter").value, 10) || 0));
    var lo = Math.max(250, Math.round(b - b * pc / 100)), hi = Math.round(b + b * pc / 100);
    $("likeRange").textContent = pc
      ? ("实际延迟：每次在 " + lo + " ~ " + hi + " ms 之间随机取（均值 " + b + "ms）")
      : ("实际延迟：固定 " + b + " ms（把浮动设为 0 就是不随机）");
  }

  function currentModelValue() {
    return $("model").value === CUSTOM ? $("modelCustom").value.trim() : $("model").value;
  }

  // ==================== 表单读写 ====================
  function readForm() {
    var cfg = {};
    cfg.apiKey = $("apiKey").value.trim();
    cfg.baseUrl = $("baseUrl").value.trim().replace(/\/+$/, "");
    cfg.model = currentModelValue() || DEF.model;
    cfg.visionModel = $("visionModel").value === CUSTOM ? DEF.visionModel : ($("visionModel").value || DEF.visionModel);
    cfg.myHandle = $("myHandle").value.trim().replace(/^@/, "").toLowerCase();
    cfg.scanRoundsMax = Math.min(400, Math.max(3, parseInt($("scanRoundsMax").value, 10) || DEF.scanRoundsMax));
    cfg.scanStepMs = Math.min(5000, Math.max(250, parseInt($("scanStepMs").value, 10) || DEF.scanStepMs));
    cfg.candidates = Math.min(LIMITS.candidatesMax, Math.max(1, parseInt($("candidates").value, 10) || 3));
    cfg.maxComments = Math.min(LIMITS.commentsMax, Math.max(1, parseInt($("maxComments").value, 10) || 12));
    cfg.imagesMax = Math.min(4, Math.max(1, parseInt($("imagesMaxN").value, 10) || DEF.imagesMax));
    cfg.imageSize = $("imageSize").value === "medium" ? "medium" : "small";
    cfg.autoLikeDelay = Math.min(8000, Math.max(250, parseInt($("autoLikeDelay").value, 10) || DEF.autoLikeDelay));
    cfg.autoLikeJitter = Math.min(90, Math.max(0, parseInt($("autoLikeJitter").value, 10) || 0));
    cfg.replyStyle = $("replyStyle").value in STYLES ? $("replyStyle").value : DEF.replyStyle;
    cfg.temperature = parseFloat($("temperature").value) || 0;
    cfg.maxTokens = Math.min(4000, Math.max(50, parseInt($("maxTokens").value, 10) || DEF.maxTokens));
    cfg.prompt = $("prompt").value;
    TOGGLES.forEach(function (k) { cfg[k] = $(k).checked; });
    return cfg;
  }

  function writeForm(cfg) {
    $("apiKey").value = cfg.apiKey || "";
    $("baseUrl").value = cfg.baseUrl || DEF.baseUrl;
    fillModelSelect($("model"), cfg.model || DEF.model, false);
    syncCustomBox();
    if ($("model").value === CUSTOM) $("modelCustom").value = cfg.model || "";
    fillModelSelect($("visionModel"), cfg.visionModel || DEF.visionModel, true);
    $("myHandle").value = cfg.myHandle || "";
    $("scanRoundsMax").value = cfg.scanRoundsMax || DEF.scanRoundsMax;
    $("scanStepMs").value = cfg.scanStepMs || DEF.scanStepMs;
    $("candidates").value = cfg.candidates || DEF.candidates;
    $("maxComments").value = cfg.maxComments || DEF.maxComments;
    $("imagesMaxN").value = cfg.imagesMax || DEF.imagesMax;
    $("imageSize").value = cfg.imageSize === "medium" ? "medium" : "small";
    $("autoLikeDelay").value = cfg.autoLikeDelay != null ? cfg.autoLikeDelay : DEF.autoLikeDelay;
    $("autoLikeJitter").value = cfg.autoLikeJitter != null ? cfg.autoLikeJitter : DEF.autoLikeJitter;
    syncLikeRange();
    $("replyStyle").value = cfg.replyStyle in STYLES ? cfg.replyStyle : DEF.replyStyle;
    $("temperature").value = cfg.temperature != null ? cfg.temperature : DEF.temperature;
    $("tempVal").textContent = String($("temperature").value);
    $("maxTokens").value = cfg.maxTokens || DEF.maxTokens;
    $("prompt").value = cfg.prompt || DEF.prompt;
    // 布尔开关严格按 DEFAULTS 回落，不能因为字段缺失就全勾上
    TOGGLES.forEach(function (k) {
      $(k).checked = (cfg[k] === undefined) ? !!DEF[k] : !!cfg[k];
    });
  }

  // ==================== 域名授权 ====================
  function originOf() {
    try {
      var u = new URL($("baseUrl").value.trim());
      if (u.protocol !== "https:") return null;
      return u.origin + "/*";
    } catch (e) { return null; }
  }

  function ensureOrigin(silent) {
    var o = originOf();
    if (!o) { status("Base URL 必须是合法的 https 地址", "err"); return Promise.resolve(false); }
    return new Promise(function (resolve) {
      chrome.permissions.contains({ origins: [o] }, function (has) {
        if (has) { resolve(true); return; }
        chrome.permissions.request({ origins: [o] }, function (granted) {
          if (granted) { if (!silent) status("已授权访问 " + o, "ok"); resolve(true); }
          else { status("未授权 " + o + "，AI 请求会被浏览器 CORS 拦截", "err"); resolve(false); }
        });
      });
    });
  }

  // ==================== 测试连接 ====================
  $("testBtn").addEventListener("click", function () {
    var cfg = readForm();
    if (!cfg.apiKey) { status("请先填写 API Key", "err"); return; }
    if (!cfg.baseUrl) { status("请先填写 Base URL", "err"); return; }

    var btn = $("testBtn");
    btn.disabled = true;
    btn.textContent = "测试中…";
    status("正在连接 " + cfg.baseUrl + " …");

    ensureOrigin(true).then(function () {
      return send({ type: "xrh:models", cfg: cfg });
    }).then(function (res) {
      btn.disabled = false;
      btn.textContent = "测试连接";
      if (!res.ok) { status(res.error || "连接失败", "err"); return; }

      var prev = currentModelValue();
      if (res.models && res.models.length) {
        fetchedModels = res.models;
        fetchedGroupLabel = "账号可用（" + res.models.length + " 个，测试连接后拉取）";
        fillModelSelect($("model"), prev, false);
        fillModelSelect($("visionModel"), $("visionModel").value, true);
        syncCustomBox();
        status("连接成功，已把 " + res.models.length + " 个可用模型加入下拉框", "ok",
          res.models.slice(0, 30).join("、") + (res.models.length > 30 ? " …" : ""));
      } else {
        status("Key 可用" + (res.note ? "：" + res.note : ""), "ok");
      }
    }).catch(function (e) {
      btn.disabled = false;
      btn.textContent = "测试连接";
      status("出错：" + e.message, "err");
    });
  });

  $("permBtn").addEventListener("click", function () { ensureOrigin(false); });

  // ==================== 保存 ====================
  $("saveBtn").addEventListener("click", function () {
    var cfg = readForm();
    if (cfg.baseUrl && !/^https:\/\//i.test(cfg.baseUrl)) { status("Base URL 必须以 https:// 开头", "err"); return; }
    if (!cfg.model) { status("请选择或填写模型", "err"); return; }

    var btn = $("saveBtn");
    btn.disabled = true;
    ensureOrigin(true).then(function () {
      var o = {};
      o[CFG_KEY] = cfg;
      chrome.storage.local.set(o, function () {
        btn.disabled = false;
        status("已保存。已打开的 x.com 标签页会自动热生效，个别改动需刷新页面。", "ok");
      });
    });
  });

  $("resetBtn").addEventListener("click", function () {
    if (!confirm("恢复全部默认设置？API Key 会被清空。")) return;
    writeForm(DEF);
    var o = {}; o[CFG_KEY] = Object.assign({}, DEF);
    chrome.storage.local.set(o, function () { status("已恢复默认", "ok"); });
  });

  $("resetPrompt").addEventListener("click", function () {
    $("prompt").value = X.PROMPT;
    status("提示词已恢复默认，记得点保存", "ok");
  });

  // ==================== 小交互 ====================
  $("toggleKey").addEventListener("click", function () {
    var i = $("apiKey");
    var show = i.type === "password";
    i.type = show ? "text" : "password";
    $("toggleKey").textContent = show ? "隐藏" : "显示";
  });

  $("temperature").addEventListener("input", function () { $("tempVal").textContent = this.value; });
  $("model").addEventListener("change", syncCustomBox);
  $("autoLikeDelay").addEventListener("input", syncLikeRange);
  $("autoLikeJitter").addEventListener("input", syncLikeRange);

  // ==================== 数据 ====================
  function loadDataInfo() {
    chrome.storage.local.get([DATA_KEY], function (r) {
      var d = (r && r[DATA_KEY]) || { byAccount: {} };
      var ba = d.byAccount || {};
      var accts = Object.keys(ba), drafts = 0, items = 0, handles = 0, notes = 0;
      accts.forEach(function (a) {
        var A = ba[a] || {};
        var ds = Object.keys(A.drafts || {});
        drafts += ds.length;
        ds.forEach(function (k) {
          ((A.drafts[k] || {}).items || []).forEach(function (it) { items++; if (it.note) notes++; });
        });
        handles += Object.keys(A.handles || {}).length;
      });
      $("dataInfo").textContent = accts.length
        ? "账号 " + accts.map(function (a) { return "@" + a; }).join("、") +
          " · 草稿 " + drafts + " 帖 / " + items + " 条（含备注 " + notes + "）· 追踪 " + handles + " 人"
        : "暂无本地数据。互动数据需要先认得出你的账号，见上方「我的用户名」。";
    });
  }

  $("exportBtn").addEventListener("click", function () {
    chrome.storage.local.get([DATA_KEY, CFG_KEY], function (r) {
      var out = {
        exportedAt: new Date().toISOString(),
        version: chrome.runtime.getManifest().version,
        // 不导出 apiKey，避免分享文件时泄漏密钥
        config: (function () { var c = Object.assign({}, r[CFG_KEY] || {}); delete c.apiKey; return c; })(),
        data: r[DATA_KEY] || { byAccount: {} }
      };
      var blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "x-reply-helper-" + new Date().toISOString().slice(0, 10) + ".json";
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
      status("已导出（不含 API Key）", "ok");
    });
  });

  $("importBtn").addEventListener("click", function () { $("importFile").click(); });
  $("importFile").addEventListener("change", function (ev) {
    var f = ev.target.files && ev.target.files[0];
    if (!f) return;
    var fr = new FileReader();
    fr.onload = function () {
      try {
        var o = JSON.parse(String(fr.result));
        if (!o || typeof o !== "object" || !o.data || typeof o.data.byAccount !== "object") {
          status("文件格式不对：缺少 data.byAccount", "err");
          return;
        }
        chrome.storage.local.get([DATA_KEY, CFG_KEY], function (r) {
          var cur = r[DATA_KEY] || { byAccount: {} };
          cur.byAccount = cur.byAccount || {};
          var merged = 0;
          Object.keys(o.data.byAccount).forEach(function (a) {
            var src = o.data.byAccount[a] || {};
            var dst = cur.byAccount[a] || (cur.byAccount[a] = { handles: {}, drafts: {} });
            dst.handles = Object.assign({}, dst.handles, src.handles || {});
            dst.drafts = Object.assign({}, dst.drafts, src.drafts || {});
            merged++;
          });
          var w = {};
          w[DATA_KEY] = cur;
          if (o.config) w[CFG_KEY] = Object.assign({}, r[CFG_KEY] || {}, o.config);
          chrome.storage.local.set(w, function () {
            status("已导入 " + merged + " 个账号的数据", "ok");
            loadDataInfo();
            chrome.storage.local.get([CFG_KEY], function (r2) { writeForm(Object.assign({}, DEF, X.normalizeCfg(r2[CFG_KEY] || {}))); });
          });
        });
      } catch (e) { status("解析失败：" + e.message, "err"); }
      ev.target.value = "";
    };
    fr.readAsText(f);
  });

  function wipe(part) {
    chrome.storage.local.get([DATA_KEY], function (r) {
      var d = r[DATA_KEY] || { byAccount: {} };
      d.byAccount = d.byAccount || {};
      Object.keys(d.byAccount).forEach(function (a) {
        if (part === "drafts") d.byAccount[a].drafts = {};
        else d.byAccount[a].handles = {};
      });
      var o = {}; o[DATA_KEY] = d;
      chrome.storage.local.set(o, function () {
        status(part === "drafts" ? "草稿已清空" : "互动数据已清空", "ok");
        loadDataInfo();
      });
    });
  }
  $("clearDrafts").addEventListener("click", function () { if (confirm("清空所有草稿？不可恢复。")) wipe("drafts"); });
  $("clearStats").addEventListener("click", function () { if (confirm("清空所有互动追踪数据？不可恢复。")) wipe("handles"); });

  // ==================== 初始化 ====================
  (function init() {
    $("ver").textContent = "v" + chrome.runtime.getManifest().version;

    var sel = $("replyStyle");
    Object.keys(STYLES).forEach(function (k) {
      var o = document.createElement("option");
      o.value = k;
      o.textContent = STYLES[k].label;
      sel.appendChild(o);
    });

    var apply = function (cfg) { writeForm(Object.assign({}, DEF, cfg || {})); loadDataInfo(); };

    chrome.storage.local.get([CFG_KEY], function (r) { apply(X.normalizeCfg(r[CFG_KEY])); });

    // v1 把配置平铺存在 apiKey/baseUrl/model 上，这里迁过来，避免升级后 Key 丢失
    if (X.migrateCfg) {
      X.migrateCfg(chrome.storage, function (cfg, migrated) {
        if (!migrated || !cfg) return;
        apply(cfg);
        status("检测到旧版本保存的 API Key，已自动迁移", "ok");
      });
    }
  })();
})();

