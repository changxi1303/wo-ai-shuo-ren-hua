// 我爱说人话 — MAIN world 拦截器
//
// 为什么需要它：X 在 /with_replies 上渲染你的回复时，DOM 里既没有「回复 @xxx」那一行，
// 也没有指向被回复者的链接（v2.10.1 诊断报告实测：5 个链接全指向自己，cellInnerDiv 每格只有
// 1 条 article）。渲染层根本没给出回复关系，任何选择器都挖不出来。
//
// 但 X 自己的 GraphQL 响应里每条推文都带 in_reply_to_status_id_str / in_reply_to_user_id_str，
// 这是权威数据，且不随界面改版变化。这里只是被动观察页面自己发出的请求：
//   · 不额外发任何请求
//   · 不读取、不存储、不转发任何凭据
//   · 只提取「谁回复了哪条推文」这一组关系，postMessage 给隔离世界的 content script
//
// v2.11.0 实测教训：不要假设 core.user_results.result.legacy.screen_name 这条嵌套路径。
// 那一版收到了 19 批 / 330 条推文，in_reply_to_* 全对，但 userId→用户名映射学到 0 个，
// 因为嵌套路径猜错了。现在改成：
//   · 推文作者 ID 直接取 legacy.user_id_str（推文对象上就有，不用钻 core）
//   · 用户名映射靠全量深扫，凡是「同时有 id 和 screen_name」的对象都收，不认路径
//   · 顺带把 data.user.result / data.viewer 当成「可能是我」上报
//   · 附带结构抽样，方便下次直接从诊断报告看出真实字段名
//
// 运行在 MAIN world（manifest 里声明），必须在 document_start 就包住 fetch/XHR，
// 否则 X 已经拿到原始引用了。
//
// ---------------------------------------------------------------------------
// 关注/取关事件的识别、撞限判定、以及「你关注的人有没有回关你」的关系扫描，
// 移植自 mikuairai/follow-counter（MIT License，Copyright (c) 2026 mikuairai）
//   https://github.com/mikuairai/follow-counter
// 完整许可文本见随仓库的 LICENSE.follow-counter。
// 合并进本文件而不是单独注入一个脚本：两边都要包 fetch/XHR，分成两个脚本会双重包装。
// 同时采纳了原作的两项机制：
//   · __xrhOrig 保存浏览器原始 fetch/XHR —— 扩展热更新时新版从原函数重新包一层并替换旧版，
//     不会越叠越多（旧版没有保存原函数，无法替换，只能等页面刷新）。
//   · 同意门控 —— 关注追踪相关的读取默认完全关闭，只有 content.js 发来开启信号才读，
//     并用 generation 计数让在途读取立即失效。
// ---------------------------------------------------------------------------
(function () {
  "use strict";

  var VERSION = 1;
  // 已被更新版接管就不重复注入；旧版没存原函数的话只能等页面刷新
  if (window.__XRH_INTERCEPT__ && !window.__xrhOrig) return;
  if (window.__xrhVersion >= VERSION) return;
  window.__XRH_INTERCEPT__ = true;
  window.__xrhVersion = VERSION;

  var XHRp = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  window.__xrhOrig = window.__xrhOrig || {
    fetch: window.fetch,
    open: XHRp && XHRp.open,
    send: XHRp && XHRp.send
  };
  var ORIG = window.__xrhOrig;

  var MARK = "__xrh_api__";
  var CTL = "__xrh_ctl__";
  var MAX_TWEETS = 400;      // 单次响应上限，防止异常大的 payload 拖慢页面
  var MAX_USERS = 600;
  var MAX_NODES = 30000;     // 深扫节点预算，防止病态 payload 卡住页面
  var MAX_REL = 400;         // 单次关系扫描上报上限

  // ---------- 关注追踪的同意门控 ----------
  // 只认插件自己的开关信号；页面脚本即使伪造，数据到了 content.js 那边仍会因未同意被丢弃
  var followOn = false;
  var followGen = 0;
  window.addEventListener("message", function (e) {
    if (e.source !== window) return;
    if (e.origin && e.origin !== window.location.origin) return;
    if (!e.data || e.data.__xrhCtl !== CTL) return;
    var next = e.data.on === true;
    if (next !== followOn) followGen += 1;
    followOn = next;
  });
  // 新装入时问一声当前是否已同意（content.js 可能比本脚本先就绪）
  try { window.postMessage({ __xrh: MARK, type: "hello" }, window.location.origin); } catch (e) {}

  // ---------- 关注 / 取关请求识别（移植自原作）----------
  var REST_FOLLOW = /\/i\/api\/1\.1\/friendships\/(create|destroy)\.json/;
  var GQL_FOLLOW = /\/graphql\/[^/]+\/(CreateFriendship|DestroyFriendship|Follow|Unfollow)\b/;
  var LIMIT_CODES = [88, 161, 344];
  var LIMIT_TEXT = /unable to follow|can't follow|cannot follow|limit|无法关注|上限|限制/i;

  function classifyFollow(url) {
    if (typeof url !== "string") return null;
    var m = url.match(REST_FOLLOW);
    if (m) return m[1] === "create" ? "follow" : "unfollow";
    m = url.match(GQL_FOLLOW);
    if (m) return /^(CreateFriendship|Follow)$/.test(m[1]) ? "follow" : "unfollow";
    return null;
  }

  function findScreenName(body) {
    if (!body || typeof body !== "object") return "";
    if (typeof body.screen_name === "string") return body.screen_name;
    var stack = [body], steps = 0;
    while (stack.length && steps < 20000) {
      var cur = stack.pop();
      steps++;
      if (cur && typeof cur === "object") {
        if (typeof cur.screen_name === "string" && cur.screen_name) return cur.screen_name;
        for (var k in cur) { if (cur[k] && typeof cur[k] === "object") stack.push(cur[k]); }
      }
    }
    return "";
  }

  // 把一次关注/取关的结果整理成事件，交给 content.js 记账
  function postFollowEvent(kind, status, text) {
    var body = null;
    try { body = JSON.parse(text); } catch (e) {}
    var err = body && Array.isArray(body.errors) && body.errors[0];
    var ok = status >= 200 && status < 300 && !err;
    var code = err && typeof err.code === "number" ? err.code : null;
    var message = err ? String(err.message || "") : "";
    var limit = !ok && (status === 429 || LIMIT_CODES.indexOf(code) >= 0 || LIMIT_TEXT.test(message));
    try {
      window.postMessage({
        __xrh: MARK, type: "followEvt",
        event: {
          type: kind, ok: ok, limit: limit, status: status, code: code, message: message,
          user: ok ? findScreenName(body) : "",
          path: window.location.pathname, ts: Date.now()
        }
      }, window.location.origin);
    } catch (e) {}
  }

  // 找出响应里带关注关系的用户：你是否关注对方、对方是否关注你。
  // 兼容旧字段 legacy.* 和新字段 relationship_perspectives。
  function scanRelations(body) {
    var out = [];
    var stack = [body];
    var steps = 0;
    while (stack.length && steps < MAX_NODES && out.length < MAX_REL) {
      var cur = stack.pop();
      steps++;
      if (!cur || typeof cur !== "object") continue;
      if (cur.rest_id && (cur.legacy || cur.core)) {
        var leg = cur.legacy || {};
        var rp = cur.relationship_perspectives || {};
        var name = leg.screen_name || (cur.core && cur.core.screen_name);
        var following = leg.following === true || rp.following === true;
        var notFollowing = leg.following === false || rp.following === false;
        // f：你是否正在关注对方；只有字段明确存在时才上报「没关注」，避免数据不全时误删
        if (name && (following || notFollowing)) {
          out.push({ name: String(name), uid: String(cur.rest_id), f: following, fb: leg.followed_by === true || rp.followed_by === true });
        }
      }
      for (var k in cur) {
        var v = cur[k];
        if (v && typeof v === "object") stack.push(v);
      }
    }
    return out;
  }

  function postRelations(text) {
    // 快速预筛：没有关系字段的响应直接跳过
    if (text.indexOf("followed_by") < 0 && text.indexOf("relationship_perspectives") < 0) return;
    var body;
    try { body = JSON.parse(text); } catch (e) { return; }
    var users = scanRelations(body);
    if (!users.length) return;
    try { window.postMessage({ __xrh: MARK, type: "followRel", users: users }, window.location.origin); } catch (e) {}
  }

  function isGraphQL(url) {
    return typeof url === "string" && url.indexOf("/i/api/graphql/") >= 0;
  }

  function pickScreenName(o) {
    if (!o || typeof o !== "object") return "";
    var lg = o.legacy;
    var cands = [
      lg && lg.screen_name, lg && lg.screenName,
      o.screen_name, o.screenName, o.screen_name_str
    ];
    for (var i = 0; i < cands.length; i++) {
      if (typeof cands[i] === "string" && cands[i]) return cands[i];
    }
    return "";
  }

  function pickId(o) {
    if (!o || typeof o !== "object") return "";
    var lg = o.legacy;
    var cands = [
      o.rest_id, o.id_str,
      lg && lg.id_str, lg && lg.user_id_str, lg && lg.userId_str,
      o.user_id_str, o.userId, o.user_id
    ];
    for (var i = 0; i < cands.length; i++) {
      var v = cands[i];
      if (v == null) continue;
      var s = String(v);
      if (/^\d{1,25}$/.test(s)) return s;      // 只要纯数字 ID，跳过 base64 的 "VXNlcjo…"
    }
    // o.id 可能是 base64，也可能正好是数字
    if (o.id != null && /^\d{1,25}$/.test(String(o.id))) return String(o.id);
    return "";
  }

  function numStr(v) {
    if (v == null) return "";
    var s = String(v);
    return /^\d{1,25}$/.test(s) ? s : "";
  }

  // ---------- 从响应 JSON 里提取关系 ----------
  function extract(json) {
    var users = {};                 // userId -> screen_name（小写）
    var tweets = [];
    var seenTweet = {};
    var meCandidates = [];          // data.user.result / data.viewer 之类，可能是当前登录用户
    var nodes = 0;
    var keySample = {};             // 出现过的字段名，用于诊断

    function noteUser(id, sn) {
      if (!id || !sn) return;
      sn = String(sn).toLowerCase();
      if (!/^[a-z0-9_]{1,15}$/.test(sn)) return;
      if (!users[id] && Object.keys(users).length < MAX_USERS) users[id] = sn;
    }

    function sampleKeys(o, tag) {
      if (keySample[tag]) return;
      try { keySample[tag] = Object.keys(o).slice(0, 24); } catch (e) {}
    }

    function walk(node, depth) {
      if (!node || depth > 60 || nodes > MAX_NODES) return;
      if (Array.isArray(node)) {
        for (var i = 0; i < node.length && i < 800; i++) walk(node[i], depth + 1);
        return;
      }
      if (typeof node !== "object") return;
      nodes++;

      // 1) 任何「同时有 id 和 screen_name」的对象都当成用户收下来，不认嵌套路径
      var sn = pickScreenName(node);
      var uid = pickId(node);
      if (sn && uid) noteUser(uid, sn);
      if (sn) sampleKeys(node, "user");

      // 2) 推文对象：legacy 里带 id_str
      var lg = node.legacy;
      if (lg && typeof lg === "object") {
        sampleKeys(lg, "tweetLegacy");
        var tid = numStr(lg.id_str) || numStr(node.rest_id);
        var rts = numStr(lg.in_reply_to_status_id_str) || numStr(lg.in_reply_to_status_id);
        var rtu = numStr(lg.in_reply_to_user_id_str) || numStr(lg.in_reply_to_user_id);
        if (tid && (rts || rtu) && !seenTweet[tid]) {
          seenTweet[tid] = 1;
          // 作者 ID 优先用 legacy.user_id_str —— 它就在推文对象上，不需要钻 core
          var authorId = numStr(lg.user_id_str) || numStr(lg.user_id) || "";
          var authorSn = "";
          var cand = (node.core && node.core.user_results && node.core.user_results.result) ||
            node.user || (node.user_results && node.user_results.result) || null;
          if (cand) {
            authorSn = pickScreenName(cand);
            if (!authorId) authorId = pickId(cand);
            if (authorSn && authorId) noteUser(authorId, authorSn);
          }
          // v2.12 实测：core.user_results 这条路在某些响应形状下不存在（withAuthorName = 0），
          // 但 legacy 上有 in_reply_to_screen_name —— 回复对象的用户名直接给了，
          // 不必依赖 userId→用户名 映射，冷启动也不会丢数据。
          var replyToSn = "";
          if (typeof lg.in_reply_to_screen_name === "string") replyToSn = lg.in_reply_to_screen_name;
          if (replyToSn && rtu) noteUser(rtu, replyToSn);
          if (tweets.length < MAX_TWEETS) {
            tweets.push({
              id: tid,
              authorId: authorId,
              author: authorSn ? authorSn.toLowerCase() : "",
              replyToStatus: rts,
              replyToUser: rtu,
              replyToScreen: replyToSn ? replyToSn.toLowerCase() : ""
            });
          }
        }
      }

      for (var k in node) {
        if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
        var v = node[k];
        if (v && typeof v === "object") walk(v, depth + 1);
      }
    }

    try { walk(json, 0); } catch (e) { return null; }

    // 「可能是我」：个人页/with_replies 响应里的 data.user.result，以及 data.viewer
    try {
      var d = json && json.data;
      if (d) {
        [["user", d.user && d.user.result], ["user2", d.user], ["viewer", d.viewer],
         ["viewer2", d.viewer && d.viewer.user_results && d.viewer.user_results.result]]
          .forEach(function (pair) {
            var o = pair[1];
            if (!o || typeof o !== "object") return;
            var s = pickScreenName(o), id = pickId(o);
            if (s && id) { noteUser(id, s); meCandidates.push({ id: id, screenName: s.toLowerCase() }); }
          });
      }
    } catch (e) {}

    if (!tweets.length && !Object.keys(users).length) return null;
    return {
      users: users,
      tweets: tweets,
      me: meCandidates,
      sample: {
        users: Object.keys(users).length,
        tweets: tweets.length,
        withAuthorId: tweets.filter(function (t) { return !!t.authorId; }).length,
        withAuthorName: tweets.filter(function (t) { return !!t.author; }).length,
        withReplyToScreen: tweets.filter(function (t) { return !!t.replyToScreen; }).length,
        nodes: nodes,
        keys: keySample
      }
    };
  }

  function post(payload) {
    try {
      window.postMessage({
        __xrh: MARK, type: "tweets",
        users: payload.users, tweets: payload.tweets, me: payload.me, sample: payload.sample
      }, window.location.origin);
    } catch (e) {}
  }

  function handleText(url, text) {
    if (!isGraphQL(url) || !text) return;
    // 快速预筛：没有回复字段也没有 screen_name 的响应直接跳过，避免白白 parse 大对象
    if (text.indexOf("in_reply_to_") < 0 && text.indexOf("screen_name") < 0) return;
    var json;
    try { json = JSON.parse(text); } catch (e) { return; }
    var out = extract(json);
    if (out) post(out);
  }

  // ---------- 一个响应该观察什么 ----------
  // followOn 为 false（未同意）时，关注类请求一律不观察，等于这部分数据一个字节都不读。
  function plan(url, gen) {
    if (typeof url !== "string" || !url) return null;
    if (followOn && gen === followGen) {
      var kind = classifyFollow(url);
      if (kind) return { follow: kind, gen: gen };
    }
    if (!isGraphQL(url)) return null;
    return { gql: true, url: url, rel: followOn && gen === followGen, gen: gen };
  }

  function observe(p, status, text) {
    if (!p) return;
    // 在途请求期间用户关掉了同意：立即作废，不上报
    if ((p.follow || p.rel) && p.gen !== followGen) return;
    if (p.follow) { postFollowEvent(p.follow, status, text); return; }
    handleText(p.url, text);              // 原有：回复关系提取，行为不变
    if (p.rel) postRelations(text);       // 新增：回关关系扫描，需同意
  }

  function xhrText(x) {
    try {
      if (x.responseType === "" || x.responseType === "text") return x.responseText;
      if (x.response && typeof x.response === "object") return JSON.stringify(x.response);
    } catch (e) {}
    return "";
  }

  // ---------- 包住 fetch ----------
  var origFetch = ORIG.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (input) {
      var url = "";
      try {
        url = typeof input === "string" ? input
          : (input && typeof input.url === "string") ? input.url : "";
      } catch (e) {}
      var p = plan(url, followGen);
      var out = origFetch.apply(this, arguments);
      if (!p) return out;
      // clone() 而不是直接读 body：不能干扰页面自己的消费
      try {
        out.then(function (res) {
          if (!res || typeof res.clone !== "function") return;
          res.clone().text().then(function (t) { observe(p, res.status, t); }, function () {});
        }, function () {});
      } catch (e) {}
      return out;
    };
  }

  // ---------- 包住 XMLHttpRequest ----------
  var XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype && typeof ORIG.open === "function") {
    var origOpen = ORIG.open;
    var origSend = ORIG.send;
    XHR.prototype.open = function (method, url) {
      try { this.__xrhUrl = typeof url === "string" ? url : String(url || ""); } catch (e) { this.__xrhUrl = ""; }
      return origOpen.apply(this, arguments);
    };
    XHR.prototype.send = function () {
      var self = this;
      var p = plan(self.__xrhUrl, followGen);
      if (p) {
        // loadend 而不是 load：撞限时请求可能是失败的，那一下正是要记的
        self.addEventListener("loadend", function () { observe(p, self.status, xhrText(self)); });
      }
      return origSend.apply(this, arguments);
    };
  }

  // 供测试直接调用，不依赖真实网络
  window.__xrhClassifyFollow = classifyFollow;
})();
