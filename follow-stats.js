// 我爱说人话 — 关注追踪统计（纯函数，无 DOM）
//
// content.js / popup.js / 测试三方共用。输入是事件列表和记录，输出是各项统计。
//
// ---------------------------------------------------------------------------
// 本文件的算法移植自 mikuairai/follow-counter（MIT License）
//   https://github.com/mikuairai/follow-counter
//   Copyright (c) 2026 mikuairai
// 完整许可文本见随仓库的 LICENSE.follow-counter。
// 移植时保留原有算法与阈值语义，仅改命名空间、补齐注释；
// 上限/窗口等数值仍沿用原作（见下方各常量注释里对来源的标注）。
// ---------------------------------------------------------------------------
(function (g) {
  "use strict";

  var MIN = 60 * 1000;
  var KEEP_MS = 7 * 24 * 60 * MIN;      // 事件保留 7 天
  var MAX_EVENTS = 3000;                // 事件条数上限
  var ROUND_RESET = 15 * MIN;           // 没撞限时，距上次成功关注满 15 分钟算新一轮
  var DEFAULT_ROUND = 15;               // 每轮额度默认 15（原作默认值，X 未公布）
  var QUICK_UNFOLLOW_MS = 72 * 60 * MIN; // 关注后 72 小时内取关算「快取关」（churn 风险）
  var CHURN_LINES = { warnQuick: 5, highQuick: 15, warnTotal: 50, highTotal: 100 };
  var FOLLOW_KEEP_MS = 60 * 24 * 60 * MIN; // 关注记录保留 60 天
  var MAX_FOLLOWS = 5000;

  // 数据说明的版本：说明内容有实质变化时加 1，旧的同意随之失效，需要重新同意
  var CONSENT_VERSION = 1;
  function hasConsent(c) {
    return !!(c && c.v === CONSENT_VERSION && c.at);
  }

  function countSince(events, type, now, ms) {
    var n = 0;
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      if (e.type === type && e.ok && now - e.ts <= ms) n++;
    }
    return n;
  }

  function prune(events, now) {
    var kept = [], i;
    for (i = 0; i < events.length; i++) if (now - events[i].ts <= KEEP_MS) kept.push(events[i]);
    return kept.slice(-MAX_EVENTS);
  }

  // 撞限那一刻往前各窗口的成功关注数：用来摸出自己账号的实际阈值。
  function windowsBefore(events, ts) {
    var before = events.filter(function (e) { return e.ts < ts; });
    return {
      m15: countSince(before, "follow", ts, 15 * MIN),
      m30: countSince(before, "follow", ts, 30 * MIN),
      h1: countSince(before, "follow", ts, 60 * MIN),
      h24: countSince(before, "follow", ts, 24 * 60 * MIN)
    };
  }

  // 把撞限整理成「轮次」：从本轮最后一次成功关注（waitFrom）到下一次成功关注之间算一段冷却。
  // 等待从最后一次成功关注算起，因为撞限前你可能已经歇了一阵，那段时间也算在等。
  // 每次撞限失败给出下限（等了这么久还不够），第一次重新成功给出上限（等这么久已够）。
  function episodes(events, resetMs) {
    var gap = resetMs || ROUND_RESET;
    var list = [];
    var cur = null;
    var batch = 0;
    var lastOk = null;
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      if (e.type !== "follow") continue;
      if (e.ok) {
        if (cur) {
          cur.end = e.ts;
          cur.cooldownMax = e.ts - cur.waitFrom;
          cur = null;
        } else if (lastOk != null && e.ts - lastOk >= gap) {
          // 没撞限、但已歇够重置时间，这一个算新一轮的第一个
          batch = 0;
        }
        batch += 1;
        lastOk = e.ts;
      } else if (e.limit) {
        if (!cur) {
          var waitFrom = lastOk != null ? lastOk : e.ts;
          cur = {
            start: e.ts, waitFrom: waitFrom, end: null, batch: batch, retries: 0,
            lastFail: e.ts, cooldownMin: e.ts - waitFrom, cooldownMax: null, event: e
          };
          list.push(cur);
          batch = 0;
        } else {
          cur.retries += 1;
          cur.lastFail = e.ts;
          cur.cooldownMin = e.ts - cur.waitFrom;
        }
      }
    }
    return { list: list, currentBatch: batch, lastOk: lastOk, ongoing: cur };
  }

  function compute(events, now, resetMs) {
    var gap = resetMs || ROUND_RESET;
    var follows = events.filter(function (e) { return e.type === "follow" && e.ok; });
    var limits = events.filter(function (e) { return e.limit; });
    var lastFollow = follows[follows.length - 1] || null;
    var lastLimit = limits[limits.length - 1] || null;
    var ep = episodes(events, gap);
    var rested = !ep.ongoing && ep.lastOk != null && now - ep.lastOk >= gap;
    var done = ep.list.filter(function (x) { return x.end != null; });
    var cooldowns = done.map(function (x) { return x.cooldownMax; });
    return {
      lastFollow: lastFollow,
      sinceLastFollow: lastFollow ? now - lastFollow.ts : null,
      follow15m: countSince(events, "follow", now, 15 * MIN),
      follow30m: countSince(events, "follow", now, 30 * MIN),
      follow1h: countSince(events, "follow", now, 60 * MIN),
      follow24h: countSince(events, "follow", now, 24 * 60 * MIN),
      unfollow24h: countSince(events, "unfollow", now, 24 * 60 * MIN),
      lastLimit: lastLimit,
      sinceLastLimit: lastLimit ? now - lastLimit.ts : null,
      lastLimitWindows: lastLimit ? windowsBefore(events, lastLimit.ts) : null,
      // 本轮（上次解封后）已成功关注几个；冷却中则为 0
      currentBatch: ep.ongoing || rested ? 0 : ep.currentBatch,
      // 没撞限时的休息进度：距上次成功关注多久、还差多久开新一轮
      rest: ep.ongoing || ep.lastOk == null ? null : { elapsed: now - ep.lastOk, reset: gap, rested: rested },
      // 最近一次撞限时那一轮关注了几个，作为本轮的参考线
      lastBatch: ep.list.length ? ep.list[ep.list.length - 1].batch : null,
      // elapsed 从本轮最后一次成功关注算起；sinceHit 是距撞限那一下
      cooling: ep.ongoing ? {
        start: ep.ongoing.start, waitFrom: ep.ongoing.waitFrom,
        elapsed: now - ep.ongoing.waitFrom, sinceHit: now - ep.ongoing.start,
        retries: ep.ongoing.retries, cooldownMin: ep.ongoing.cooldownMin
      } : null,
      // 已结束冷却里最短的上限：从最后一次成功关注起等这么久，曾经能再关注
      bestKnownCooldown: cooldowns.length ? Math.min.apply(null, cooldowns) : null,
      limitHits: ep.list.slice(-5).reverse().map(function (x) {
        return Object.assign({ windows: windowsBefore(events, x.start) }, x);
      }),
      rounds: ep.list
    };
  }

  // 每轮额度：默认 15，只听用户设置。单次撞限的个数受上一轮余量影响，不拿来自动改额度
  function roundSize(stats, settings) {
    if (settings && settings.roundSize > 0 && settings.roundSize !== DEFAULT_ROUND) {
      return { size: settings.roundSize, from: "手动设置" };
    }
    return { size: DEFAULT_ROUND, from: "默认" };
  }

  // 最后几格算「快满了」
  function tailFrom(size) {
    return Math.max(0, size - Math.max(2, Math.round(size * 0.2)));
  }

  // 本轮所处阶段，浮标、面板、角标共用
  function phase(stats, settings) {
    var r = roundSize(stats, settings);
    var done = stats.currentBatch;
    if (stats.cooling) {
      var ref = stats.bestKnownCooldown;
      return { name: ref && stats.cooling.elapsed >= ref ? "ready" : "cooling", size: r.size, done: done, from: r.from };
    }
    if (done >= r.size) return { name: "full", size: r.size, done: done, from: r.from };
    if (done > 0 && done >= tailFrom(r.size)) return { name: "near", size: r.size, done: done, from: r.from };
    return { name: done > 0 ? "going" : "idle", size: r.size, done: done, from: r.from };
  }

  // 撞过的几轮里总结出的账号规律
  function rhythm(stats) {
    var all = stats.rounds;
    if (!all.length) return null;
    var batches = all.filter(function (x) { return x.batch > 0; }).map(function (x) { return x.batch; }).sort(function (a, b) { return a - b; });
    var done = all.filter(function (x) { return x.end != null; });
    return {
      count: all.length,
      typical: batches.length ? batches[Math.floor((batches.length - 1) / 2)] : null,
      // 等过却仍撞限的最长时间（下限）与等到就能关注的最短时间（上限）
      waitMin: done.length ? Math.max.apply(null, done.map(function (x) { return x.cooldownMin; })) : null,
      waitMax: done.length ? Math.min.apply(null, done.map(function (x) { return x.cooldownMax; })) : null
    };
  }

  // 角标上的小字和底色
  function iconBadge(stats, settings) {
    var p = phase(stats, settings);
    if (p.name === "cooling" || p.name === "ready") {
      var m = Math.floor(stats.cooling.elapsed / MIN);
      return { text: m >= 60 ? Math.floor(m / 60) + "h" : m + "m", color: p.name === "ready" ? "#00ba7c" : "#f4212e" };
    }
    if (!stats.lastFollow) return { text: "", color: "#1d9bf0" };
    var color = p.name === "full" ? "#00ba7c" : p.name === "near" ? "#ffad1f" : "#1d9bf0";
    return { text: String(p.done), color: color };
  }

  // —— 回关追踪 ——
  // 关注发生在哪个页面：决定「从哪关注最容易换来回关」
  var SOURCE_LABELS = {
    followers: "某人的粉丝列表", following: "某人的关注列表", engagers: "点赞/转发名单", replies: "帖子回复区",
    search: "搜索/探索", profile: "对方主页", home: "首页时间线", connect: "推荐关注",
    notifications: "通知", other: "其他"
  };
  var RESERVED = /^(i|settings|messages|compose|search|explore|home|notifications|bookmarks|lists|communities|jobs|premium|hashtag)$/i;
  function sourceOf(path) {
    path = String(path || "");
    var m;
    if (/^\/(search|explore)(\/|$)/.test(path)) return { cat: "search", via: "" };
    if (/^\/home(\/|$)/.test(path)) return { cat: "home", via: "" };
    if (/^\/notifications(\/|$)/.test(path)) return { cat: "notifications", via: "" };
    if (/^\/i\/connect/.test(path)) return { cat: "connect", via: "" };
    if ((m = path.match(/^\/([^/]+)\/(followers|verified_followers|followers_you_follow)(\/|$)/)) && !RESERVED.test(m[1])) return { cat: "followers", via: m[1] };
    if ((m = path.match(/^\/([^/]+)\/following(\/|$)/)) && !RESERVED.test(m[1])) return { cat: "following", via: m[1] };
    if ((m = path.match(/^\/([^/]+)\/status\/\d+\/(likes|retweets|reposts|quotes)(\/|$)/))) return { cat: "engagers", via: m[1] };
    if ((m = path.match(/^\/([^/]+)\/status\/\d+/))) return { cat: "replies", via: m[1] };
    if ((m = path.match(/^\/([^/]+)\/?(with_replies|media|likes|highlights|articles)?\/?$/)) && !RESERVED.test(m[1])) return { cat: "profile", via: m[1] };
    return { cat: "other", via: "" };
  }

  function pruneFollows(map, now) {
    var entries = Object.keys(map || {}).map(function (k) { return [k, map[k]]; })
      .filter(function (p) { return now - p[1].ts <= FOLLOW_KEEP_MS; });
    entries.sort(function (a, b) { return a[1].ts - b[1].ts; });
    var out = {};
    entries.slice(-MAX_FOLLOWS).forEach(function (p) { out[p[0]] = p[1]; });
    return out;
  }

  // follows：{ 小写用户名: { ts, src, via, fb: true/false/null, fbAt, unfollowedAt } }
  function followBack(follows, now) {
    var list = Object.keys(follows || {}).map(function (k) { return follows[k]; })
      .filter(function (f) { return !f.unfollowedAt; });
    var byCat = {}, byVia = {};
    var known = 0, yes = 0, stale = 0;
    for (var i = 0; i < list.length; i++) {
      var f = list[i];
      var c = (byCat[f.src] = byCat[f.src] || { cat: f.src, label: SOURCE_LABELS[f.src] || "其他", n: 0, known: 0, yes: 0 });
      c.n += 1;
      if (f.fb != null) { c.known += 1; known += 1; }
      if (f.fb === true) { c.yes += 1; yes += 1; }
      if (f.fb !== true && now - f.ts > 7 * 24 * 60 * MIN) stale += 1;
      if (f.via && (f.src === "followers" || f.src === "following" || f.src === "engagers" || f.src === "replies")) {
        var k2 = f.src + ":" + String(f.via).toLowerCase();
        var v = (byVia[k2] = byVia[k2] || { via: f.via, cat: f.src, label: SOURCE_LABELS[f.src], n: 0, known: 0, yes: 0 });
        v.n += 1;
        if (f.fb != null) v.known += 1;
        if (f.fb === true) v.yes += 1;
      }
    }
    function rate(x) { return x.known ? x.yes / x.known : null; }
    function sortRows(rows) {
      return rows.map(function (r) { r.rate = rate(r); return r; })
        .sort(function (a, b) { return (b.known - a.known) || (b.n - a.n); });
    }
    return {
      tracked: list.length, known: known, yes: yes, pending: list.length - known, stale: stale,
      rate: known ? yes / known : null,
      byCat: sortRows(Object.keys(byCat).map(function (k) { return byCat[k]; })),
      byVia: sortRows(Object.keys(byVia).map(function (k) { return byVia[k]; })).filter(function (v) { return v.known >= 3; }).slice(0, 5)
    };
  }

  // —— 未回关名单 ——
  // following：在页面数据里读到的、你正在关注的人 { 小写用户名: { name, fb, seenAt } }
  // follows：插件记录过的关注，用来补上「在哪关注的、关注了多久」
  // keep：保留名单 { 小写用户名: true }，这些人标记为 keep，由调用方决定是否显示
  function nonFollowers(following, follows, now, keep) {
    var rows = [];
    keep = keep || {};
    Object.keys(following || {}).forEach(function (key) {
      var f = following[key];
      if (!f || f.fb === true) return;
      var tr = (follows || {})[key];
      var tracked = tr && !tr.unfollowedAt ? tr : null;
      // 插件记过的回关也算数：主页上看到「关注了你」时，following 里可能还是旧值
      if (tracked && tracked.fb === true) return;
      var age = tracked ? now - tracked.ts : null;
      rows.push({
        key: key, name: f.name || key, fb: f.fb, seenAt: f.seenAt,
        followedAt: tracked ? tracked.ts : null, age: age,
        src: tracked ? tracked.src : null, via: tracked ? tracked.via : "",
        fresh: age != null && age < QUICK_UNFOLLOW_MS,
        keep: !!keep[key]
      });
    });
    // 关注时间已知的按关注最久排前；插件安装前就关注的放最前（通常更久）
    function at(r) { return r.followedAt == null ? -Infinity : r.followedAt; }
    rows.sort(function (a, b) { return (at(a) === at(b) ? a.key.localeCompare(b.key) : at(a) < at(b) ? -1 : 1); });
    return rows;
  }

  // —— 取关护栏 ——
  // X 禁止 follow churn（大量关注后又取关来涨粉）。阈值是本模块自定的提醒线，X 没有公布具体数字。
  function churn(events, now) {
    var day = events.filter(function (e) { return e.type === "unfollow" && e.ok && now - e.ts <= 24 * 60 * MIN; });
    var quick = day.filter(function (e) { return e.heldMs != null && e.heldMs < QUICK_UNFOLLOW_MS; });
    var L = CHURN_LINES;
    var level = quick.length >= L.highQuick || day.length >= L.highTotal ? "high"
      : quick.length >= L.warnQuick || day.length >= L.warnTotal ? "warn" : "ok";
    return {
      unfollow24h: day.length, quick24h: quick.length, level: level,
      lastQuick: quick[quick.length - 1] || null, lines: L
    };
  }

  function formatDuration(ms) {
    if (ms == null) return "—";
    var s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return s + " 秒";
    var m = Math.floor(s / 60);
    if (m < 60) return m + " 分 " + (s % 60) + " 秒";
    var h = Math.floor(m / 60);
    if (h < 24) return h + " 小时 " + (m % 60) + " 分";
    return Math.floor(h / 24) + " 天 " + (h % 24) + " 小时";
  }

  g.XRH = g.XRH || {};
  g.XRH.FSTATS = {
    CONSENT_VERSION: CONSENT_VERSION, hasConsent: hasConsent,
    compute: compute, episodes: episodes, prune: prune, windowsBefore: windowsBefore,
    formatDuration: formatDuration, roundSize: roundSize, tailFrom: tailFrom, phase: phase,
    rhythm: rhythm, iconBadge: iconBadge, sourceOf: sourceOf, pruneFollows: pruneFollows,
    followBack: followBack, churn: churn, nonFollowers: nonFollowers,
    SOURCE_LABELS: SOURCE_LABELS,
    CONST: {
      MIN: MIN, KEEP_MS: KEEP_MS, MAX_EVENTS: MAX_EVENTS, ROUND_RESET: ROUND_RESET,
      DEFAULT_ROUND: DEFAULT_ROUND, QUICK_UNFOLLOW_MS: QUICK_UNFOLLOW_MS,
      CHURN_LINES: CHURN_LINES, FOLLOW_KEEP_MS: FOLLOW_KEEP_MS, MAX_FOLLOWS: MAX_FOLLOWS
    }
  };
  if (typeof module !== "undefined" && module.exports) module.exports = g.XRH.FSTATS;
})(typeof globalThis !== "undefined" ? globalThis : self);
