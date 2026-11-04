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
(function () {
  "use strict";

  if (window.__XRH_INTERCEPT__) return;
  window.__XRH_INTERCEPT__ = true;

  var MARK = "__xrh_api__";
  var MAX_TWEETS = 400;      // 单次响应上限，防止异常大的 payload 拖慢页面
  var MAX_USERS = 600;
  var MAX_NODES = 30000;     // 深扫节点预算，防止病态 payload 卡住页面

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

  // ---------- 包住 fetch ----------
  var origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (input) {
      var url = "";
      try {
        url = typeof input === "string" ? input
          : (input && typeof input.url === "string") ? input.url : "";
      } catch (e) {}
      var p = origFetch.apply(this, arguments);
      if (!isGraphQL(url)) return p;
      // clone() 而不是直接读 body：不能干扰页面自己的消费
      try {
        p.then(function (res) {
          if (!res || typeof res.clone !== "function") return;
          res.clone().text().then(function (t) { handleText(url, t); }, function () {});
        }, function () {});
      } catch (e) {}
      return p;
    };
  }

  // ---------- 包住 XMLHttpRequest ----------
  var XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    var origOpen = XHR.prototype.open;
    var origSend = XHR.prototype.send;
    XHR.prototype.open = function (method, url) {
      try { this.__xrhUrl = typeof url === "string" ? url : String(url || ""); } catch (e) { this.__xrhUrl = ""; }
      return origOpen.apply(this, arguments);
    };
    XHR.prototype.send = function () {
      var self = this;
      if (isGraphQL(self.__xrhUrl)) {
        self.addEventListener("load", function () {
          try {
            if (self.responseType === "" || self.responseType === "text") handleText(self.__xrhUrl, self.responseText);
          } catch (e) {}
        });
      }
      return origSend.apply(this, arguments);
    };
  }
})();
