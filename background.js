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
    "  2) 25-40 字最好、70 字封顶，永远高于仿写。参考里有长句也不要跟着写长。",
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
var BAN_WORD = /(首先|其次|再者|总之|综上|值得注意的是|作为\s*AI|希望对你有帮助|有所帮助|赋能|闭环|抓手|家人们|互关求赞|学到了|收藏了|说白了|其实|真正的|重点是|加油|会好的|别灰心|慢慢来|提升自己|一起加油)/;
// 空洞附和：只表示同意、不含任何「看了这条帖子才说得出」的东西。
//
// 依据不是 LLM 裁判，是用户亲手划选的地面真相 —— 152 条历史差评草稿里，
// reason 字段是在草稿上划选出的「问题就在这段」。含这几个词的草稿 18 条，
// 其中 16 条（89%）划选的片段正好就是这个词本身：
//   我认 10 条 / 划选 9；确实 3 条 / 划选 3；我信 5 条 / 划选 4。
//   「互动我认，可你这条自己就是靠疯狂留言刷出来的」被划选了三次。
//
// 这一条必须说清楚：我的 5 维 LLM 裁判判这些句子大多是「干净」的
// （精确版「我认」在 461 条实测产出里 1 命中 0 缺陷）。也就是说
// **裁判的标准和用户的口味在这一点上不一致，以用户为准** ——
// 裁判是我按维度定义出来的，划选是用户一条一条亲手标的。
//
// 必须带否定预查：裸词「我认」会误杀「我认识个专干这个的，一天搬十几单」，
// 那是「我认识」(I know someone)，跟让步附和「我认」是两个词。实测 461 条里
// 裸词命中 3 条、其中 2 条是「我认识」；加了预查后只剩 1 条，误杀归零。
//
// 「我信」用分句末尾判据而不是裸词：让步附和的形态是「……，我信」「我信了」，
// 后面接名词宾语的（我信宗教 / 我信仰科学 / 我信服他 / 我信任你）是真在说信仰，不能拦。
// 四种候选判据在 461 条实测上命中数完全相同（都是 4 条），只有这个能放过「我信宗教」。
//
// 各词实测损耗（占 461 条产出）：我认 0.2% / 我信 0.9% / 确实 0.9% /
// 蹲一个、我太懂了、是真的 均为 0%（提示词的软约束已经完全压住，过滤器只是保险）。
// 合计 2.0%。「确实」是里面损耗最高、裁判最不认同的一个（4 命中仅 1 条被判坏），
// 但历史上 3 条含「确实」的草稿用户全部划选了它，按用户口味保留。
var BAN_FILLER = /(我认(?!识|为|可|定|输|错|账|领|同)|我信(?!任|仰|心|服|宗|教)了?(?=$|[，。！？,.!?；\s])|确实|蹲一个|我太懂了|是真的)/;
// 「算账」框架：把一件事当成账本来算、来点评（这账算得明白 / 真会算账 / 这账算谁头上 /
// 账还没算回来 / 这账本我头回见 / 算得比我记账都清楚）。用户明确要求不要出现。
//
// 不能用裸字「账」：921 条实测产出里含「账」的有 23 条，其中 13 条是完全合法的用法 ——
// 账号 / 账单 / 坏账 / 分账 / 认账 / 报账 / 结账 / 账上，以及「时薪算下来未必比上班高」
// 这种真在算帖子里那个数的。裸字规则会一并误杀，所以只认下面这几个形态。
// 精确规则在 921 条上命中 10 条（1.1%），28 条边界断言全过（9 个该拦的全拦住、19 个该放的全放过）。
//
// 来源追溯：这个句式原本是提示词【好回复长这样】里的例句「500天，这数算得比我记账都清楚」，
// 而那条其实是用户划选否掉的差评草稿（v2.17.0 查出的标签反转问题）。删掉例句后
// 出现频次从改动前那轮的 8 条降到 2 条，这里再加机械兜底。
var BAN_LEDGER = /(算账|账算得|这账|那账|账本|记账|账还没算|算得[^，。！？\n]{0,4}(清楚|明白|准))/;
// 「落地」原来混在 BAN_WORD 里当职场黑话禁，实测误杀严重：
// 「放个落地灯」「6.1还没落地呢」都是完全正常的日常用法，占 deepseek 全部误拦的一半。
// 改成只拦明显的黑话搭配，其余放行。
var BAN_JARGON = /(方案|战略|项目|计划|想法|建议|需求|能力|价值|业务|模式)[^，。！？\n]{0,4}落地|落地(执行|方案|能力|效果|闭环)/;
// v2.17 放宽：原来要求「而是/，是/,是」，实测漏掉了不带逗号的形态
// （真实样本「代言的不是饮料是流量」）。放宽后在 460 条带标签样本上命中 2 条，2 条都被判有缺陷。
var BAN_STRUCT = /不是[^。！？!?\n]{1,16}(而是|，是|,是|是)/;
// 对比句式：用户明确要求回复里不要出现「比 xxx」这类比较。
// 负向前瞻放行非对比用法：比如 / 比赛 / 比分 / 比例 / 比率 / 比重 / 比较 / 比值 / 比照。
var BAN_COMPARE = /比(?!如|赛|分|例|率|重|较|值|照)|不如|比不上|胜过|强过|优于|秒杀|吊打|碾压|完胜/;
// 引流话术：回复里不该出现「戳我」这类引导动作。
var BAN_CTA = /(戳我|戳这里|戳链接|私我|私信我|滴滴我)/;
var LEN_MAX = 70;

// 以下四条是 v2.17 新增，全部在 460 条「真实帖子 × 真实模型产出 × LLM 逐条判定」的
// 带标签样本上离线调过参，精确率写在各自注释里。加规则前请照同样方式量一遍，别凭感觉。
//
// 套模板：抄提示词好例句「63岁这个数我先记住了」的框架。实测两个模型合计产出 24 条，
// 贴在全然无关的帖子下（加沙、不丹机场、币圈、李白），单看每条都还过得去，
// 但同一个句式反复出现本身就是缺陷 —— 这正是逐条判定看不出来、只有机械过滤拦得住的。
var BAN_TEMPLATE = /(这|那)(个)?(数|数字|几个数|俩数|些数|句|话|梗|细节|事儿|事|名字|标题|说法)(我)?(先|这就)?(记住|记下|记一下|记上)|我(先|这就)?记(住|下)了/;
// 夸措辞：点评对方的用词/用字/说法本身，而不是回应内容。deepseek-v4.1-flash 的头号病灶
// （12.6%），根源是提示词里那个教符号规则的例子「绞尽脑汁这词选得准」被当成了句式学走。
// 命中 22 条，18 条被判有缺陷（82%）；4 条误判里有 2 条是裁判在不同批次自己判定不一致。
var BAN_FLATTER = /(这|那)(个)?(词|字|名字|称呼|标题|说法|问法|评价|比喻|形容|梗)[^，。！？\n]{0,8}(用得|选得|写得|说得|问得|起得|叫得|下得|打得|自己先升|就没跑)|[一二三四五六七八九十两几\d]+(个)?字[^，。！？\n]{0,10}(用得|选得|写得|说得|我信|我认|爱听|就把|才|就)|这(话|句|说法)(我)?(爱听|信|认|服)/;
// 金句腔：前后两个小句对仗 + 升华词。裁判反复点名「对仗工整的书面腔」「对仗式升华」。
// 单纯对仗不预测缺陷（254 条里 37% 有缺陷，与总体基准持平），必须叠加升华词才准：
// 命中 8 条，8 条有缺陷（100%）。升华词表里的「才是真」会误杀，已剔除。
var BAN_APHORISM_SHAPE = /^[^，。！？\n]{4,12}，[^，。！？\n]{4,12}$/;
var BAN_APHORISM_WORD = /(本质|修行|赦免|智慧|浪漫|勇气|答案|终点|起点|格局|境界|底色|注脚|仪式感|真实进度|标准答案|才是本|才是常)/;

function auditItem(s) {
  var hits = [];
  // 非字符串一律当空处理。这里抛异常的话会一路冒到 runChat 的 reject，
  // 用户看到的是「生成失败」而不是候选 —— 一个脏元素毁掉整次生成不值得。
  if (typeof s !== "string") return hits;
  var sym = s.match(BAN_SYMBOL);
  if (sym) hits.push("括号/引号(" + sym[0] + ")");
  if (BAN_PUNCT.test(s)) hits.push("破折号/省略号/分号");
  var w = s.match(BAN_WORD);
  if (w) hits.push("禁语(" + w[0] + ")");
  if (BAN_JARGON.test(s)) hits.push("禁语(落地·职场黑话)");
  var fl = s.match(BAN_FILLER);
  if (fl) hits.push("空洞附和(" + fl[0] + ")");
  var lg = s.match(BAN_LEDGER);
  if (lg) hits.push("算账式点评(" + lg[0] + ")");
  if (BAN_STRUCT.test(s)) hits.push("不是A而是B");
  var n = Array.from(s).length;
  if (n > LEN_MAX) hits.push("超长" + n + "字");
  // 「你应该/别再」放在句中也是说教，不限句首。
  // 「记住」分两种：句首祈使的「记住这点」是在教育对方，要拦；
  // 「记住了，回头我也去试试」是第一人称表态，是像人话的，放行。
  // 真正要拦的滥用是下面 BAN_TEMPLATE 那个「X这数我先记住了」套模板框架 ——
  // 实测 20 条含「记住」的样本全部落在该框架内，TEMPLATE 一条不漏，无需再禁裸词。
  if (/(你应该|别再)/.test(s)) hits.push("说教(" + (s.match(/(你应该|别再)/) || [])[0] + ")");
  else if (/^(记住(?!了)|一定要|请先)/.test(s)) hits.push("说教式开头");
  if (BAN_TEMPLATE.test(s)) hits.push("套模板(这数我先记住了)");
  var flt = s.match(BAN_FLATTER);
  if (flt) hits.push("夸对方措辞(" + flt[0].slice(0, 12) + ")");
  if (BAN_APHORISM_SHAPE.test(s.trim()) && BAN_APHORISM_WORD.test(s)) hits.push("金句腔(对仗+升华)");
  var cmp = s.match(BAN_COMPARE);
  if (cmp) hits.push("对比句式(" + cmp[0] + ")");
  var cta = s.match(BAN_CTA);
  if (cta) hits.push("引流话术(" + cta[0] + ")");
  return hits;
}

// 「超长」只是长度问题，不算禁用词；其余命中都是硬违规。
function isSoftHit(h) { return /^超长/.test(h); }

function hasHardHit(s) {
  var hits = auditItem(s);
  for (var i = 0; i < hits.length; i++) if (!isSoftHit(hits[i])) return true;
  return false;
}

// 干净的优先；只超长的放行并带原因；硬违规一律不交付。
// 全部踩雷时返回空列表，由 shapeResult 转成明确报错 ——
// 旧行为是「按违规数排序返回最轻的」，那正是禁用词仍会出现在草稿里的原因。
function hardFilter(items) {
  var audited = items.map(function (t) { return { text: t, hits: auditItem(t) }; });
  var detail = function (list) {
    return list.map(function (a) { return a.text + " ← " + a.hits.join("、"); });
  };
  var clean = audited.filter(function (a) { return !a.hits.length; });
  if (clean.length) {
    return {
      items: clean.map(function (a) { return a.text; }),
      dropped: audited.length - clean.length,
      droppedDetail: detail(audited.filter(function (a) { return a.hits.length; })),
      allBad: false
    };
  }
  var soft = audited.filter(function (a) { return a.hits.length && a.hits.every(isSoftHit); });
  if (soft.length) {
    return {
      items: soft.map(function (a) { return a.text; }),
      dropped: audited.length - soft.length,
      droppedDetail: detail(audited.filter(function (a) { return !a.hits.every(isSoftHit); })),
      allBad: false,
      warnings: soft.map(function (a) { return a.hits.join("、"); })
    };
  }
  audited.sort(function (x, y) { return x.hits.length - y.hits.length; });
  return {
    items: [],
    dropped: audited.length,
    droppedDetail: detail(audited),
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
  // 开重排时要多要几条，否则排完还是原来那几条，等于白花一次裁判调用。
  // 多要的条数受 rankPoolMax 夹住：n=3 时问 6 条，n=5 时问 8 条。
  if (cfg.rerank !== false) return clamp(n + (LIMITS.rankExtra || 3), n, LIMITS.rankPoolMax || 8);
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

  // 重排会让 ask 变大（n=3 时从 4 条变 6 条），token 预算要跟着抬，
  // 否则第 5、6 条会被截断，白问。110 token/条 是按上限 70 个中文字估的。
  var maxTok = clamp(Math.max(toInt(cfg.maxTokens, 400), ask * 110), 50, 4000);

  var body = {
    model: model,
    messages: [
      { role: "system", content: buildSystem(cfg, refining) },
      { role: "user", content: buildContent(userText, images) }
    ],
    max_tokens: maxTok,
    temperature: clamp(parseFloat(cfg.temperature) || DEF.temperature, 0, 2)
  };
  var th = wantThinking(cfg);
  if (th !== undefined) body.enable_thinking = th;

  return {
    base: base, body: body, n: n, ask: ask, replies: replies, notes: notes,
    images: images, useVision: useVision, model: model,
    // 重排要用：原帖文本（判据要对着原帖判）和开关
    tweetText: tweetText, rerank: cfg.rerank !== false && !refining
  };
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
  if (!f.items.length) {
    var why = (f.warnings && f.warnings[0]) || "触发禁用规则";
    return {
      ok: false,
      code: "all_filtered",
      error: "这 " + items.length + " 条候选全部触发禁用规则，已全部丢弃（例：" + why + "）。再点一次生成，或换个风格/模型。",
      droppedDetail: f.droppedDetail || []
    };
  }
  // 重排池：过滤后、切片前的全集。applyRank 会从这个池子里排序再取前 n 条。
  // 先切片再排就等于在已经被截断的集合里排，白问的那几条永远没机会。
  var pool = req.rerank ? f.items.slice(0, LIMITS.rankPoolMax || 8) : null;
  if (f.items.length > req.n) f.items = f.items.slice(0, req.n);
  return {
    ok: true,
    items: f.items,
    pool: pool,
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

// ---------- best-of-N 重排 ----------
function resContent(res) {
  if (!res) return "";
  if (res.content != null) return String(res.content);
  var d = res.data;
  return String((d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || "");
}

// 解析裁判给的排序。裁判可能输出「3,1,5」、"3、1、5"、"排序：3 > 1 > 5"，
// 也可能不听格式多写解释。策略：优先找「几乎只有数字和分隔符」的那一行，
// 找不到再退回全文扫描。解析不出就返回 null，调用方按原顺序交付 —— 绝不因为裁判不听话而丢候选。
function parseRank(text, n) {
  var s = String(text || "");
  if (!s) return null;
  var lines = s.split(/\r?\n/);
  var best = null;
  for (var i = 0; i < lines.length; i++) {
    var L = lines[i].trim();
    if (!L) continue;
    // 这一行除了数字和分隔符几乎没别的东西，才当成排序行
    if (!/^[\d\s,，、.。;；:：\-–—>»()（）\[\]#]+$/.test(L)) continue;
    var nums = L.match(/\d+/g);
    if (!nums || nums.length < 2) continue;
    if (!best || nums.length > best.length) best = nums;
  }
  var raw = best || (s.match(/\d+/g) || []);
  var seen = {}, out = [];
  for (var k = 0; k < raw.length; k++) {
    var v = parseInt(raw[k], 10);
    if (!(v >= 1 && v <= n)) continue;      // 越界或非法序号直接丢
    if (seen[v]) continue;                   // 重复只取第一次出现
    seen[v] = 1;
    out.push(v - 1);                         // 转成 0 基下标
  }
  return out.length ? out : null;
}

function buildRankBody(cfg, pool, tweetText, model) {
  var list = pool.map(function (t, i) { return (i + 1) + ". " + t; }).join("\n");
  var user = "【原帖】\n" + (String(tweetText || "").slice(0, 2000) || "（原帖只有图片，没有文字）") +
    "\n\n【候选，共 " + pool.length + " 条】\n" + list +
    "\n\n按质量从最好到最差排序，只输出一行序号，用英文逗号分隔。";
  var body = {
    model: model,
    messages: [
      { role: "system", content: X.RANK_CRITERIA },
      { role: "user", content: user }
    ],
    max_tokens: 80,          // 只输出一行序号，给多了纯浪费
    temperature: 0           // 排序要可复现，不要随机
  };
  var th = wantThinking(cfg);
  if (th !== undefined) body.enable_thinking = th;
  return body;
}

// 裁判调用。任何失败（超时、报错、解析不出）都返回 null，由调用方退回原顺序。
function rankRequest(req, cfg, pool) {
  var model = String(cfg.rerankModel || "").trim() || req.model;
  var body;
  try { body = buildRankBody(cfg, pool, req.tweetText, model); } catch (e) { return Promise.resolve(null); }
  var timeout = clamp(toInt(cfg.rerankTimeout, 12000), 2000, 60000);

  var call = chatRequest(req.base, cfg.apiKey, body).then(function (res) {
    if (!res || res.status < 200 || res.status >= 300) return null;
    return parseRank(resContent(res), pool.length);
  }, function () { return null; });

  // 裁判卡住不能把用户一起卡住：超时就放弃重排
  return new Promise(function (resolve) {
    var done = false;
    var fin = function (v) { if (!done) { done = true; resolve(v); } };
    setTimeout(function () { fin(null); }, timeout);
    call.then(fin, function () { fin(null); });
  });
}

// 把重排结果套回交付结果。裁判漏给的候选按原顺序补到末尾 ——
// 宁可顺序不完美，也不能因为裁判少报一个就让用户少看到一条候选。
function applyRank(res, req, cfg) {
  if (!res) return Promise.resolve(res);
  var pool = res.pool;
  if (pool) delete res.pool;              // 内部字段，不外泄给页面
  if (!res.ok || !req.rerank || !pool || pool.length <= 1) {
    res.ranked = false;
    return Promise.resolve(res);
  }
  return rankRequest(req, cfg, pool).then(function (order) {
    if (!order || !order.length) { res.ranked = false; return res; }
    var picked = [], used = {};
    order.forEach(function (i) {
      if (pool[i] != null && !used[i]) { used[i] = 1; picked.push(pool[i]); }
    });
    pool.forEach(function (t, i) { if (!used[i]) picked.push(t); });
    var changed = picked.slice(0, req.n).join("\u0000") !== res.items.join("\u0000");
    res.items = picked.slice(0, req.n);
    res.ranked = true;
    res.rankPool = pool.length;
    res.rankOrder = order.slice(0, pool.length).map(function (i) { return i + 1; });
    res.rankChanged = changed;            // 顺序真的变了吗，用来决定要不要提示
    return res;
  }, function () { res.ranked = false; return res; });
}

function runChat(cfg, msg, refining) {
  var req = buildRequest(cfg, msg, refining);
  if (req.error) return Promise.resolve(req.error);
  req.cfgHardFilter = cfg.hardFilter;
  return chatRequest(req.base, cfg.apiKey, req.body).then(function (res) {
    return shapeResult(res, req, refining);
  }).then(function (out) {
    return applyRank(out, req, cfg);
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
    // 流式面板上的候选带「可先复制」按钮，必须和最终交付走同一套过滤，
    // 否则用户能从实时列表里复制到踩雷的句子（禁用词漏出的主要路径之一）。
    if (req.cfgHardFilter !== false) {
      items = items.filter(function (t) { return !hasHardHit(t); });
    }
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
  }).then(function (out) {
    // 重排放在流式结束之后：流式期间按生成顺序实时显示（首条 ~170ms 就出来），
    // 排完再把最终顺序推给页面。先让用户看到东西，再看到更好的顺序，比干等强。
    return applyRank(out, req, cfg);
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



