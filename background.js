// 我爱说人话 — Service Worker
// 唯一的对外网络出口：content script 在 x.com 页面内 fetch 第三方 API 会被 CORS 拦死，
// 所有 AI 请求必须走这里。
importScripts("defaults.js");

var X = self.XRH;
var DEF = X.DEFAULTS;
var LIMITS = X.LIMITS;
var TIMEOUT_MS = 45000;

self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });

// ---------- 工具 ----------
function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
function toInt(v, d) { var n = parseInt(v, 10); return isFinite(n) ? n : d; }

function normBase(u) {
  var url;
  try { url = new URL(u || DEF.baseUrl); }
  catch (e) { throw new Error("Base URL 格式不正确：" + u); }
  if (url.protocol !== "https:") throw new Error("Base URL 必须使用 https");
  return (url.origin + url.pathname).replace(/\/+$/, "");
}

function classify(status, data, text) {
  var msg = (data && data.error && (data.error.message || data.error.code)) || "";
  if (!msg && text) msg = String(text).slice(0, 300);

  if (/DataInspectionFailed|inappropriate content|content_filter|data_inspection|risk|违规|审核|敏感|不符合/i.test(msg)) {
    return { code: "content_filter", error: "该推文被模型内容安全策略拦截，换一条或换个模型" };
  }
  if (status === 401 || status === 403) return { code: "auth", error: "API Key 无效或无权访问 (HTTP " + status + ")" };
  if (status === 404) return { code: "not_found", error: "接口或模型不存在，检查 Base URL 和模型名 (HTTP 404)" };
  if (status === 429) return { code: "rate_limit", error: "触发限流或额度不足 (HTTP 429)" };
  if (status >= 500) return { code: "server", error: "服务商端错误 (HTTP " + status + ")" };
  if (status !== 200) return { code: "http", error: msg || ("请求失败 HTTP " + status) };
  return { code: "empty", error: msg || "API 返回内容为空" };
}

function postJSON(url, key, body) {
  var ac = new AbortController();
  var timer = setTimeout(function () { ac.abort(); }, TIMEOUT_MS);
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
    body: JSON.stringify(body),
    signal: ac.signal
  }).then(function (r) {
    return r.text().then(function (t) {
      var d = null;
      try { d = t ? JSON.parse(t) : null; } catch (e) { /* 非 JSON 响应 */ }
      return { status: r.status, data: d, text: t };
    });
  }).catch(function (e) {
    if (e && e.name === "AbortError") return { status: 0, data: null, text: "请求超时（" + (TIMEOUT_MS / 1000) + "s）" };
    // 没有 host permission 时 Chrome 报的是 TypeError: Failed to fetch
    return { status: 0, data: null, text: (e && e.message ? e.message : "网络错误") + "（若为 Failed to fetch，通常是 Base URL 域名未授权或被 CORS 拦截）" };
  }).then(function (res) { clearTimeout(timer); return res; });
}

function getJSON(url, key) {
  var ac = new AbortController();
  var timer = setTimeout(function () { ac.abort(); }, 20000);
  return fetch(url, { headers: { "Authorization": "Bearer " + key }, signal: ac.signal })
    .then(function (r) {
      return r.text().then(function (t) {
        var d = null;
        try { d = t ? JSON.parse(t) : null; } catch (e) {}
        return { status: r.status, data: d, text: t };
      });
    })
    .catch(function (e) { return { status: 0, data: null, text: (e && e.message) || "网络错误" }; })
    .then(function (res) { clearTimeout(timer); return res; });
}

// 实测：qwen3.x 系列默认跑思考模式，同一个请求 7-50 秒 / token 翻 3-10 倍；
// 传 enable_thinking:false 后延迟降 74-96%。但 glm 等厂商会 400 拒绝这个参数，
// 所以做成「先带上，被拒就去掉重试一次」，对上游完全透明。
function chatRequest(base, key, body) {
  var url = base + "/chat/completions";
  return postJSON(url, key, body).then(function (res) {
    if (body.enable_thinking === undefined) return res;
    var bad = res.status === 400 || res.status === 422;
    var txt = res.text || "";
    if (bad && /enable_thinking|InvalidParameter|unsupported|unknown (field|param)/i.test(txt)) {
      var b2 = Object.assign({}, body);
      delete b2.enable_thinking;
      return postJSON(url, key, b2);
    }
    return res;
  });
}

// ---------- 候选解析 ----------
// 模型不一定老实按格式输出，这里做两遍扫描：
// 优先取编号行；模型完全没编号时才退回普通行，并且必须过 meta 过滤。
var META_RE = [
  /^(以下是|下面是|如下是?|这里是|回复候选|候选回复|候选项|选项)\s*[:：]?\s*\d*\s*条?/,
  /^(以下是|下面是|如下|回复候选|候选回复)\s*[:：]$/,
  /^(好的|当然|没问题|可以)[，,、]?\s*(以下是|下面是|这是|如下)/,
  /^(希望|以上|这几条).{0,14}(帮助|参考|有用|喜欢)/,
  /^(注|备注|说明|提示)\s*[:：]/,
  /^\d+\s*[条个]\s*(回复|候选)/,
  /^(好的|当然|没问题|收到|明白|了解了|嗯+)[，,、。！!]?.{0,20}(帮你|为您|为你|给你|如下|以下|写[好出]|生成)/
];

function isMeta(s) {
  for (var i = 0; i < META_RE.length; i++) if (META_RE[i].test(s)) return true;
  return false;
}

var QUOTE_PAIRS = [['"', '"'], ["'", "'"], ["“", "”"], ["「", "」"], ["『", "』"], ["【", "】"]];

function stripWrap(s) {
  s = s.replace(/^[\s>]+/, "").replace(/\s+$/, "");
  // 整体被强调符号包裹：**x** / __x__
  var em = /^\*{1,3}([^*]+)\*{1,3}$/.exec(s) || /^_{2,3}([^_]+)_{2,3}$/.exec(s);
  if (em) s = em[1].trim();
  // 整体被引号包裹
  for (var i = 0; i < QUOTE_PAIRS.length; i++) {
    var p = QUOTE_PAIRS[i];
    if (s.length > 2 && s.charAt(0) === p[0] && s.charAt(s.length - 1) === p[1]) {
      return s.slice(1, -1).trim();
    }
  }
  return s;
}

function parseCandidates(content, n) {
  var lines = String(content).split(/\r?\n/);
  var numbered = [], plain = [];

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    // 先剥 blockquote，再剥列表符号，否则 "> 1. xxx" 会漏判编号
    while (/^>\s?/.test(line)) line = line.replace(/^>\s?/, "").trim();
    // 列表符号只在后面跟空白时才算，避免吃掉 "**加粗**" 这种 markdown
    line = line.replace(/^[-*•·]\s+/, "").trim();
    if (!line) continue;
    // 支持 1. / 1、 / 1) / 1） / 1: / 1：
    var m = /^\d{1,2}\s*[.、)）:：]\s*(.+)$/.exec(line);
    if (m) { if (m[1].trim()) numbered.push(m[1].trim()); continue; }
    plain.push(line);
  }

  var src = numbered.length ? numbered : plain;
  var out = [], seen = {};

  for (var j = 0; j < src.length; j++) {
    var s = stripWrap(src[j]);
    if (s.length < 3) continue;       // 单字/双字基本是噪声
    if (isMeta(s)) continue;          // 前言、结尾客套话
    var k = s.toLowerCase();
    if (seen[k]) continue;
    seen[k] = 1;
    out.push(s);
    if (out.length >= n) break;
  }
  return out;
}

function buildSystem(cfg, refining) {
  var base = cfg.prompt || DEF.prompt;
  var st = X.STYLES[cfg.replyStyle] || X.STYLES[DEF.replyStyle];
  var sys = base + "\n\n本次风格要求：" + st.label + " — " + st.extra;
  if (refining) sys += "\n\n" + (X.REFINE_PROMPT || "");
  return sys;
}

// 评论区上下文：这些是【参考素材】，不是对话对象。
// 早期版本把评论当成要接话的对象，结果模型跑去回答评论里的提问
// （原帖说月入5万，评论问税前税后，模型就答"税前5万到手不到4万"）—— 那是回错人了。
function formatReplies(replies) {
  if (!replies || !replies.length) return "";
  var cap = Math.min(replies.length, LIMITS.commentsMax);
  var per = LIMITS.commentChars || 140;
  var s = "\n\n这条帖子下面别人已经发过的回复（只是参考素材）：\n";
  var listed = 0, droppedQ = 0, scanned = 0;
  for (var i = 0; i < replies.length && scanned < cap; i++) {
    scanned++;
    var r = replies[i] || {};
    var txt = String(r.text || "").replace(/\s+/g, " ").trim().slice(0, per);
    if (!txt) continue;
    // 别人向楼主提的问题：参考价值几乎为零（不提供语气也不提供角度），
    // 却是最强的诱饵——实测喂进去会有 33% 的草稿跑去解答这个问题。直接不给。
    if (/[？?]\s*$/.test(txt) || /(是税前还是|吗\s*[？?]|多少\s*[？?])/.test(txt)) { droppedQ++; continue; }
    listed++;
    s += listed + ". " + (r.author ? "@" + r.author : "某用户") + "：" + txt + " （这是别人对楼主说的话）\n";
  }
  if (droppedQ) {
    s += "（另有 " + droppedQ + " 条是别人在向楼主提问，已略去。那些问题轮不到你答，也别拿它们当切入点。）\n";
  }
  if (!listed) return "";
  var notShown = replies.length - scanned;
  if (notShown > 0) s += "（另有 " + notShown + " 条未列出）\n";
  return s + [
    "",
    "怎么用这些参考素材（这一段最重要）：",
    "· 这些是已经发出去、并且被这条帖子接纳了的回复。它们等于在告诉你：",
    "  在这条帖子下面，什么样的话是「搭」的。你写的东西必须和它们处在同一个语境里。",
    "· 照着仿写：学它们的语气、口语程度，以及它们抓的是原帖里哪个具体的点。",
    "  可以贴近模仿，但必须换成你自己的说法、换一个切入点，不能逐字抄、不能只改几个词。",
    "· 仿写有两条硬性优先级，冲突时按这个顺序：",
    "  1) 接住原帖一个具体的点，永远高于仿写。参考里若有「可惜了」「唉」这种空泛回复，",
    "     绝对不要学它们的空泛 —— 参考只给语气样本，不给「可以不具体」的许可。",
    "  2) 20 字最好、50 字封顶，永远高于仿写。参考里有长句也不要跟着写长。",
    "· 你要回复的是【原帖作者】，不是这些人。不要回答他们提的问题，不要 @ 他们，不要接他们的话头。",
    "· 参考跟原帖关系不大时直接忽略，回到原帖本身。",
    ""
  ].join("\n");
}

function outputFormat(n) {
  // 收尾再钉一次回复对象。指令放在模型最后读到的位置，遵循率明显更高。
  return "\n\n请给出 " + n + " 条互相不重复、角度不同的回复候选。\n" +
    "严格按下面格式输出，每条一行，行首用数字编号，除候选外不要输出任何解释。\n" +
    "注意：编号只是输出格式，不属于回复内容，更不要因为要编号就写成列点体的小作文。\n" +
    Array.from({ length: n }, function (_, i) { return (i + 1) + ". …"; }).join("\n") +
    "\n\n最后确认一次：这 " + n + " 条全部是发给【原帖作者】的，不是发给上面那些回复者的。" +
    "不要回答他们提的问题，不要接他们的话头。";
}

// 用户之前存下的备注（对旧草稿的意见）。备注本身不调用模型，
// 只在下次生成时作为约束带进去，所以攒着不花钱。
function formatGuidance(notes) {
  if (!notes || !notes.length) return "";
  var s = "\n\n用户对之前草稿提过的意见（必须避免重犯）：\n";
  for (var i = 0; i < Math.min(notes.length, 8); i++) {
    var t = String(notes[i] || "").replace(/\s+/g, " ").trim().slice(0, 120);
    if (t) s += "- " + t + "\n";
  }
  return s;
}

function buildUser(tweetText, n, replies, opts) {
  opts = opts || {};
  var s = "";
  if (tweetText) {
    s += "原帖文字：\n\"\"\"\n" + tweetText + "\n\"\"\"";
  } else if (opts.imageCount) {
    s += "原帖只有配图、没有文字（图已附在这条消息里）。请先看懂图再写回复，不要假装看到了文字。";
  } else {
    s += "原帖没有可读文字。请完全依据下面的评论推断这条帖子在说什么，再写回复。";
  }
  s += formatReplies(replies) + formatGuidance(opts.notes);
  return s + outputFormat(n);
}

function buildRefineUser(tweetText, prev, feedback, n, replies, opts) {
  var s = "原帖文字：\n\"\"\"\n" + (tweetText || "（无文字，见配图或评论）") + "\n\"\"\"";
  s += formatReplies(replies) + formatGuidance(opts && opts.notes);
  s += "\n\n你上一版写的是：\n\"\"\"\n" + prev + "\n\"\"\"";
  s += "\n\n用户不满意，反馈如下：\n\"\"\"\n" + (feedback || "").trim() + "\n\"\"\"";
  return s + outputFormat(n);
}

// 有图就走视觉模型，content 用多模态数组
function buildContent(text, images) {
  if (!images || !images.length) return text;
  var parts = images.map(function (u) { return { type: "image_url", image_url: { url: u } }; });
  parts.push({ type: "text", text: text });
  return parts;
}

// 只允许 X 自己的图片 CDN 上的「内容图」路径，以及 data:image。
// 必须在这里卡死：content script 传什么进来是不可信的，
// 放开成任意 pbs.twimg.com/* 会把头像/profile_images 也带出去，
// 放开成任意 https 就等于让页面能借扩展的 host 权限往外发请求（SSRF/外带）。
var IMG_OK = /^https:\/\/pbs\.twimg\.com\/(media|ext_tw_video_thumb|amplify_video_thumb|tweet_video_thumb)\//;
var IMG_DATA = /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=\s]+$/i;

function safeImages(list, cap) {
  var out = [];
  if (!Array.isArray(list)) return out;
  for (var i = 0; i < list.length && out.length < cap; i++) {
    var u = String(list[i] || "").trim();
    if (!u || u.length > 2048) continue;
    if (IMG_OK.test(u) || IMG_DATA.test(u)) out.push(u);
  }
  return out;
}

// ---------- 踩雷硬过滤 ----------
// 提示词只能降低概率，不能保证。这里做确定性校验：
// 规则全部来自旧扩展 152 条真实差评（「像AI」37 条 / 禁符号 / 太长 / 不是A而是B）。
var BAN_SYMBOL = /[「」『』【】《》（）()\[\]“”‘’"]/;
var BAN_PUNCT = /——|…|；|;/;
var BAN_WORD = /(首先|其次|再者|总之|综上|值得注意的是|作为\s*AI|希望对你有帮助|有所帮助|赋能|落地|闭环|抓手|家人们|互关求赞|学到了|收藏了|说白了|其实|真正的|重点是|加油|会好的|别灰心|慢慢来|提升自己|一起加油)/;
var BAN_STRUCT = /不是[^，。！？!?\n]{1,16}(而是|，是|,是)/;
var LEN_MAX = 50;

function auditItem(s) {
  var hits = [];
  var sym = s.match(BAN_SYMBOL);
  if (sym) hits.push("括号/引号(" + sym[0] + ")");
  if (BAN_PUNCT.test(s)) hits.push("破折号/省略号/分号");
  var w = s.match(BAN_WORD);
  if (w) hits.push("禁语(" + w[0] + ")");
  if (BAN_STRUCT.test(s)) hits.push("不是A而是B");
  var n = Array.from(s).length;
  if (n > LEN_MAX) hits.push("超长" + n + "字");
  if (/^(记住|你应该|别再|一定要|请先)/.test(s)) hits.push("说教式开头");
  return hits;
}

// 干净的优先；全踩雷时按违规数排序返回最轻的，并带上原因，不返回空列表
function hardFilter(items) {
  var audited = items.map(function (t) { return { text: t, hits: auditItem(t) }; });
  var clean = audited.filter(function (a) { return !a.hits.length; });
  if (clean.length) {
    return {
      items: clean.map(function (a) { return a.text; }),
      dropped: audited.length - clean.length,
      droppedDetail: audited.filter(function (a) { return a.hits.length; })
        .map(function (a) { return a.text + " ← " + a.hits.join("、"); }),
      allBad: false
    };
  }
  audited.sort(function (x, y) { return x.hits.length - y.hits.length; });
  return {
    items: audited.map(function (a) { return a.text; }),
    dropped: 0,
    droppedDetail: [],
    allBad: true,
    warnings: audited.map(function (a) { return a.hits.join("、"); })
  };
}

// ---------- 流式生成 ----------
// 实测：非流式要等 932ms 才拿到全部候选；流式首条内容 172ms 就可见。
// 感知延迟差 ~6 倍，所以走 chrome.runtime.connect 长连接把增量推给页面。
function parseSSE(buf, onEvent) {
  var parts = buf.split("\n");
  var rest = parts.pop();                 // 最后一段可能不完整，留到下次
  for (var i = 0; i < parts.length; i++) {
    var line = parts[i].trim();
    if (!line || line.charAt(0) !== ":") {
      if (line.indexOf("data:") === 0) {
        var payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        var j = null;
        try { j = JSON.parse(payload); } catch (e) { continue; }
        onEvent(j);
      }
    }
  }
  return rest;
}

function streamChat(base, key, body, onDelta) {
  var ac = new AbortController();
  var timer = setTimeout(function () { ac.abort(); }, TIMEOUT_MS);
  return fetch(base + "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
    body: JSON.stringify(Object.assign({ stream: true }, body)),
    signal: ac.signal
  }).then(function (res) {
    if (!res.ok || !res.body || typeof res.body.getReader !== "function") {
      // 服务商不支持流式或报错：读成文本，交回上层降级处理
      return res.text().then(function (t) {
        var d = null; try { d = t ? JSON.parse(t) : null; } catch (e) {}
        return { status: res.status, data: d, text: t, streamed: false };
      });
    }
    var reader = res.body.getReader();
    var dec = new TextDecoder();
    var buf = "", full = "", usage = null, model = "", finish = "";
    var pump = function () {
      return reader.read().then(function (r) {
        if (r.done) {
          return { status: 200, streamed: true, content: full, usage: usage, model: model, finish: finish };
        }
        buf += dec.decode(r.value, { stream: true });
        buf = parseSSE(buf, function (j) {
          var ch = j.choices && j.choices[0];
          if (ch) {
            var d = ch.delta && ch.delta.content;
            if (d) { full += d; onDelta(full); }
            if (ch.finish_reason) finish = ch.finish_reason;
          }
          if (j.usage) usage = j.usage;
          if (j.model) model = j.model;
        });
        return pump();
      });
    };
    return pump();
  }).catch(function (e) {
    if (e && e.name === "AbortError") return { status: 0, streamed: false, text: "请求超时（" + (TIMEOUT_MS / 1000) + "s）" };
    return { status: 0, streamed: false, text: (e && e.message ? e.message : "网络错误") };
  }).then(function (res) { clearTimeout(timer); return res; });
}

// 与 chatRequest 同样的 enable_thinking 回退：流式报错也可能是因为不支持该参数
function streamWithFallback(base, key, body, onDelta) {
  return streamChat(base, key, body, onDelta).then(function (res) {
    if (body.enable_thinking === undefined) return res;
    var bad = (res.status === 400 || res.status === 422) && !res.streamed;
    if (bad && /enable_thinking|InvalidParameter|unsupported|unknown (field|param)/i.test(res.text || "")) {
      var b2 = Object.assign({}, body);
      delete b2.enable_thinking;
      return streamChat(base, key, b2, onDelta);
    }
    return res;
  });
}

function wantThinking(cfg) {
  return cfg.disableThinking === false ? undefined : false;
}

// ---------- 处理器 ----------
// 过量生成：提示词只能降低踩雷概率，所以多要几条再过滤，保证交付条数不少。
// 但实测多问 2 条要 +285ms（+37%），而新提示词下 160 条样本零踩雷，
// 所以只多要 1 条：既留过滤余量，又把延迟压回来。
function askCount(n, cfg) {
  if (cfg.hardFilter === false) return n;
  return clamp(n + 1, n, 8);
}

// 组装请求。流式与非流式共用，保证两条路径的行为完全一致。
function buildRequest(cfg, msg, refining) {
  var n = clamp(toInt(msg.count != null ? msg.count : cfg.candidates, 3), 1, LIMITS.candidatesMax);
  var ask = askCount(n, cfg);
  var tweetText = String(msg.tweetText || "").trim().slice(0, 6000);
  var replies = Array.isArray(msg.replies) ? msg.replies : [];
  var notes = Array.isArray(msg.notes) ? msg.notes.filter(Boolean) : [];

  var images = [];
  if (cfg.useVision !== false) images = safeImages(msg.images, clamp(toInt(cfg.imagesMax, 2), 1, 4));
  var useVision = images.length > 0;
  var model = useVision ? (cfg.visionModel || DEF.visionModel) : (cfg.model || DEF.model);

  if (!tweetText && !useVision && !replies.length) {
    return { error: { ok: false, code: "empty_input", error: "这条帖子没有文字也没有配图，取不到任何可参考的内容" } };
  }
  if (!cfg.apiKey) return { error: { ok: false, code: "no_key", error: "未配置 API Key，点插件图标填写" } };
  if (refining && !String(msg.feedback || "").trim()) {
    return { error: { ok: false, code: "no_feedback", error: "请先说说哪里不满意" } };
  }
  var base;
  try { base = normBase(cfg.baseUrl); }
  catch (e) { return { error: { ok: false, code: "bad_url", error: e.message } }; }

  var userText = refining
    ? buildRefineUser(tweetText, String(msg.prev || "").slice(0, 500), String(msg.feedback || "").slice(0, 500), ask, replies, { notes: notes })
    : buildUser(tweetText, ask, replies, { notes: notes, imageCount: images.length });

  var body = {
    model: model,
    messages: [
      { role: "system", content: buildSystem(cfg, refining) },
      { role: "user", content: buildContent(userText, images) }
    ],
    max_tokens: clamp(toInt(cfg.maxTokens, 400), 50, 4000),
    temperature: clamp(parseFloat(cfg.temperature) || DEF.temperature, 0, 2)
  };
  var th = wantThinking(cfg);
  if (th !== undefined) body.enable_thinking = th;

  return { base: base, body: body, n: n, ask: ask, replies: replies, notes: notes, images: images, useVision: useVision, model: model };
}

// 把模型输出整理成统一的成功/失败结果
function shapeResult(res, req, refining) {
  var content = res.content != null ? res.content
    : (res.data && res.data.choices && res.data.choices[0] && res.data.choices[0].message && res.data.choices[0].message.content);
  if (!content) {
    var c = classify(res.status, res.data, res.text);
    if (req.useVision && /image|vision|multimodal|vl|InvalidParameter|not support/i.test((res.text || "") + (c.error || ""))) {
      c.error = "看图模型「" + req.model + "」调用失败：" + c.error + "。可在设置里换一个 VL/Omni 模型，或关掉「配图时自动看图」。";
    }
    return { ok: false, code: c.code, error: c.error };
  }
  var items = parseCandidates(content, req.ask);
  if (!items.length) {
    return { ok: false, code: "parse", error: "模型返回内容无法解析成候选", raw: String(content).slice(0, 400) };
  }
  var f = req.cfgHardFilter === false ? { items: items, dropped: 0, droppedDetail: [], allBad: false } : hardFilter(items);
  if (!f.items.length) f.items = items;
  if (f.items.length > req.n) f.items = f.items.slice(0, req.n);
  return {
    ok: true,
    items: f.items,
    model: (res.data && res.data.model) || res.model || req.model,
    usage: (res.data && res.data.usage) || res.usage || null,
    comments: req.replies.length,
    images: req.images.length,
    notes: req.notes.length,
    asked: req.ask,
    rawCount: items.length,
    dropped: f.dropped || 0,
    droppedDetail: f.droppedDetail || [],
    allBad: !!f.allBad,
    warnings: f.warnings || null,
    refined: !!refining,
    finish: res.finish || (res.data && res.data.choices && res.data.choices[0] && res.data.choices[0].finish_reason) || ""
  };
}

function runChat(cfg, msg, refining) {
  var req = buildRequest(cfg, msg, refining);
  if (req.error) return Promise.resolve(req.error);
  req.cfgHardFilter = cfg.hardFilter;
  return chatRequest(req.base, cfg.apiKey, req.body).then(function (res) {
    return shapeResult(res, req, refining);
  });
}

// 流式版：边生成边把已解析出的候选推给页面。
// onPartial 节流到 ~110ms，避免高频消息把页面拖慢。
function runChatStream(cfg, msg, refining, onPartial) {
  var req = buildRequest(cfg, msg, refining);
  if (req.error) return Promise.resolve(req.error);
  req.cfgHardFilter = cfg.hardFilter;

  var lastPush = 0, lastCount = 0;
  var push = function (full) {
    var now = Date.now();
    if (now - lastPush < 110) return;
    var items = parseCandidates(full, req.ask);
    if (items.length <= lastCount) return;      // 没有新的完整候选就不推
    lastCount = items.length;
    lastPush = now;
    onPartial(items.slice(0, req.n), full);
  };

  return streamWithFallback(req.base, cfg.apiKey, req.body, push).then(function (res) {
    if (!res.streamed) {
      // 服务商不支持流式：退回非流式，功能不降级
      return chatRequest(req.base, cfg.apiKey, req.body).then(function (r2) {
        var out = shapeResult(r2, req, refining);
        if (out.ok) out.degraded = true;
        return out;
      });
    }
    var out = shapeResult(res, req, refining);
    if (out.ok) out.streamed = true;
    return out;
  });
}

function handleReply(msg) {
  return runChat(Object.assign({}, DEF, msg.cfg || {}), msg, false);
}

function handleRefine(msg) {
  return runChat(Object.assign({}, DEF, msg.cfg || {}), msg, true);
}

function handleModels(msg) {
  var cfg = Object.assign({}, DEF, msg.cfg || {});
  if (!cfg.apiKey) return Promise.resolve({ ok: false, code: "no_key", error: "未配置 API Key" });
  var base;
  try { base = normBase(cfg.baseUrl); }
  catch (e) { return Promise.resolve({ ok: false, code: "bad_url", error: e.message }); }

  return getJSON(base + "/models", cfg.apiKey).then(function (res) {
    if (res.status === 200 && res.data && Array.isArray(res.data.data)) {
      return { ok: true, models: res.data.data.map(function (m) { return m.id; }).filter(Boolean) };
    }
    // /models 不支持时退化成一次最小对话探测
    return chatRequest(base, cfg.apiKey, {
      model: cfg.model || DEF.model,
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
      enable_thinking: false
    }).then(function (r2) {
      if (r2.status === 200 && r2.data && r2.data.choices) {
        return { ok: true, models: [], note: "模型列表接口不可用，但对话调用正常（Key 有效）" };
      }
      var c = classify(r2.status || res.status, r2.data || res.data, r2.text || res.text);
      return { ok: false, code: c.code, error: c.error };
    });
  });
}

function handleDefaults() {
  return Promise.resolve({
    ok: true,
    defaults: DEF,
    styles: X.STYLES,
    limits: LIMITS,
    refinePrompt: X.REFINE_PROMPT,
    version: chrome.runtime.getManifest().version
  });
}

// ---------- 路由 ----------
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || typeof msg.type !== "string" || msg.type.indexOf("xrh:") !== 0) return;
  var p;
  switch (msg.type) {
    case "xrh:reply":   p = handleReply(msg); break;
    case "xrh:refine":  p = handleRefine(msg); break;
    case "xrh:models":  p = handleModels(msg); break;
    case "xrh:warm":    p = Promise.resolve({ ok: true, version: chrome.runtime.getManifest().version }); break;
    case "xrh:defaults": p = handleDefaults(); break;
    default: p = Promise.resolve({ ok: false, error: "未知消息类型 " + msg.type });
  }
  p.then(sendResponse, function (e) { sendResponse({ ok: false, error: (e && e.message) || String(e) }); });
  return true; // 异步响应
});

// 流式通道：sendMessage 是一问一答，推不了增量，所以用长连接端口。
// 页面断开（切帖、关面板、刷新）时停止推送，避免白做功。
chrome.runtime.onConnect.addListener(function (port) {
  if (!port || port.name !== "xrh:stream") return;
  var alive = true;
  port.onDisconnect.addListener(function () { alive = false; });

  port.onMessage.addListener(function (msg) {
    if (!msg || typeof msg.type !== "string" || msg.type.indexOf("xrh:") !== 0) return;
    var refining = msg.type === "xrh:refine";
    var cfg = Object.assign({}, DEF, msg.cfg || {});
    var send = function (payload) {
      if (!alive) return;
      try { port.postMessage(payload); } catch (e) { alive = false; }
    };
    runChatStream(cfg, msg, refining, function (items, raw) {
      send({ id: msg.id, partial: true, items: items, rawLen: raw.length });
    }).then(function (res) {
      send(Object.assign({ id: msg.id, partial: false }, res));
    }, function (e) {
      send({ id: msg.id, partial: false, ok: false, error: (e && e.message) || String(e) });
    });
  });
});



