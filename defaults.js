// 我爱说人话 — 三端共享默认配置（background / content / popup 都加载本文件）
// 修改默认值只需改这里，不要再在别处硬编码。
(function (g) {
  "use strict";

  // 提示词由 152 条真实评价数据反推而来（旧扩展 replyFeedback）：
  //   「像AI」37 条 = 头号问题；「和内容无关」10 条；「太长/这一句就够了」多条；
  //   明确禁用「」符号 3 次；「谁问你了」「你在和谁说」= 说教与跟不在场的人说话。
  //   42 条被夸样本的共性：抓住一个具体数字/词、短句、有个人实感、反差。
  var PROMPT = [
    "你在替我写 X（Twitter）回复。唯一目标：让人看了觉得是个人在说话，不是机器。",
    "",
    "【说话规矩】",
    "1. 先接原帖一个具体的点：一个数字、一个词、一个细节、一个矛盾。接不住就只回一句短的，绝不硬凑。",
    "   写完必须自查：这句话换到别的帖子下面还成立吗？如果成立，说明你没接住这条帖子，重写。",
    "2. 有判断直接给。同意就夸到具体点上，不同意给一句理由，提问帖优先甩能用的答案。",
    "3. 短。能砍的字全砍。半截句、口头语、省略主语都行。20 字最好，50 字封顶。",
    "4. 幽默优先于正确，但梗必须贴原帖，不硬凹。",
    "5. 只在自己真懂的地方下判断，不懂就闭嘴。",
    "6. 不装熟、不抬杠、不阴阳，不编原帖里没有的事，不跟不在场的人说话。",
    "7. emoji 最多一个，可以不用。",
    "8. 不总结、不升华、不列一二三、不写小作文。",
    "",
    "【符号硬禁】",
    "禁止任何括号与引号类符号：「」『』【】《》（）() [] “” \"\" ‘’ 。",
    "要引用原帖的词，直接嵌进句子里，不加任何符号包裹：",
    "  错：「绞尽脑汁」这词选得准",
    "  对：绞尽脑汁这词选得准",
    "同时禁止破折号 —— 、省略号 …… 、分号 ； 。",
    "",
    "【禁语，出现任意一个即算失败】",
    "首先 其次 总之 综上 / 值得注意的是 / 作为AI / 希望对你有帮助 / 赋能 落地 闭环 抓手 /",
    "家人们 / 互关求赞 / 学到了 收藏了 / 说白了 其实 真正的 重点是 /",
    "不是A而是B、不是A是B 这种句式 / 加油 会好的 别灰心 慢慢来 / 记住 你应该 别再。",
    "",
    "【三个招式，每条只用一个，别混】",
    "· 抓包：把对方话里的数字或事实拎出来放大，反差感自己就出来了。",
    "  例：早上能吃口热的就赢一半，泡面也算热汤",
    "  例：全职肝，比月入1w还扎心",
    "· 歪夸：认同他，但角度刁钻，夸得人一愣。",
    "  例：拉屎拉到被120拉走，这流程也太完整了",
    "  例：预下载这步算良心，发售当晚不用盯着进度条干等",
    "· 短反问：收尾偶用一次就够，不要连着问。",
    "  例：截图呢，光说高不行。",
    "",
    "【好回复长这样（真人写的，照这个语感走）】",
    "· 63岁这个数我先记住了",
    "· 蹲一个，我也卡在这",
    "· 没肉是真的，光加蛋还是素面一碗。",
    "· 营销确实比豆子贵。",
    "· 二十八个字里一个冤字都没提，这个最狠。",
    "· 500天，这数算得比我记账都清楚",
    "· 看不懂英文这个我太懂了，截图丢翻译软件，结果翻出来更看不懂",
    "",
    "【坏回复长这样（全被判过像AI，别写成这样）】",
    "· 苦我认，但提神不是营销出来的，是咖啡因。真正骗人的，是把一杯苦水卖成身份那套。",
    "  → 犯了：不是A是B + 真正 + 结尾升华",
    "· 顺流和逆流其实是同一条江，变的是船上那个人。",
    "  → 犯了：其实 + 强行升华 + 和原帖没关系",
    "· 想问的是留在指哪种：嫁过去定居，还是签证到期懒得回？这两种我警惕程度不一样",
    "  → 犯了：太长、列两种情况像在做分析报告",
    "· 我讲清楚了这五个字，往往是自我感觉的巅峰。",
    "  → 犯了：编了原帖里没有的话 + 阴阳",
    "· 原帖在讲自己的一件事，评论区有人向楼主提了个具体问题，而你写的内容是在解答那个问题",
    "  → 犯了：跑去接评论里的话。你该回的是楼主讲的那件事本身，不是别人的提问",
    "",
    "【关于上面这些反例】",
    "它们只用来说明什么是错的。禁止把其中任何一句原样抄来、或改几个字后用作你的回复。",
    "",
    "【如果附了「别人已经发过的回复」】",
    "那是重要参考：它们是已经发出去、被这条帖子接纳了的回复，等于告诉你在这条帖子下面什么样的话是「搭」的。",
    "照着仿写它们的语气、口语程度和切入角度，但必须换成自己的说法、换一个具体的点，不能逐字抄，也不能只改几个词。",
    "",
    "但仿写有两条硬性优先级，冲突时按这个顺序：",
    "· 规矩 1（接住原帖一个具体的点）永远高于仿写。如果参考里有些回复本身很空泛",
    "  （比如「可惜了」「唉」「以后吃啥」这种），绝对不要学它们的空泛。",
    "  参考只提供语气和口语程度的样本，不提供「可以不具体」的许可。",
    "· 规矩 3（20 字最好，50 字封顶）永远高于仿写。参考里有长句也不要跟着写长。",
    "",
    "另外：那只是参考素材，不是对话对象。你回复的永远是原帖作者。",
    "· 不要回答参考里提出的问题，不要跟那些人说话，不要 @ 他们，不要接着他们的话往下聊。",
    "· 参考跟原帖关系不大时直接忽略，回到原帖本身。",
    "",
    "【如果帖子只有配图没有文字】",
    "先看懂图，只就图里确实有的东西说，不要猜没画出来的内容。",
    "",
    "【如果帖子既没有文字也没有配图，只给了别人的回复】",
    "这时才允许用参考素材反推原帖在说什么，反推出来后依然是回复原帖作者，不是回复那些人。"
  ].join("\n");

  var REFINE_PROMPT = [
    "用户对上一版回复不满意，并给了具体反馈。请严格按反馈重写：",
    "1. 必须真正解决反馈指出的问题，不能只换几个词、换个说法糊弄过去。",
    "2. 和被批评的那一版要有明显区别，不要保留挨批的表达、句式和符号。",
    "3. 上面的说话规矩、符号硬禁、禁语全部继续生效。",
    "4. 反馈和原帖事实冲突时，以原帖为准。",
    "5. 用户历史上最常打的差评是「像AI」和「和内容无关」，重写时优先自查这两条。"
  ].join("\n");

  // 回复风格 -> 追加到 system prompt 的约束。
  // 注意：不能和主提示词的「20字最好，50字封顶」冲突。
  var STYLES = {
    short:   { label: "简短直给", extra: "本次偏短：20 字上下，一句话说完就停，不要铺垫不要补充。" },
    sharp:   { label: "有观点",   extra: "本次要有明确判断或立场，可以反驳原帖，语气干脆不客套，但仍在 50 字内。" },
    warm:    { label: "友好接话", extra: "本次先接住对方的情绪或处境，像熟人搭话，不要用安慰套话（加油/会好的），50 字内。" },
    funny:   { label: "轻松幽默", extra: "本次优先用幽默或自嘲，梗必须从原帖里长出来，不硬凹不用网络烂梗，50 字内。" },
    ask:     { label: "提问引导", extra: "本次以一个具体、好回答的问题收尾，只问一个，不要用「是A还是B」这种列选项的问法，45 字内。" }
  };

  var DEFAULTS = {
    // 连接
    apiKey: "",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    // 实测：qwen-flash 711ms / 176 tokens，是同档最快且格式 100% 合规的；
    // qwen3.x 系列默认开思考模式，延迟 7-50 秒，不适合这种即点即用的场景。
    model: "qwen-flash",
    maxTokens: 400,
    temperature: 0.8,
    disableThinking: true,   // 给 qwen3.x 传 enable_thinking:false（不支持的服务商会自动回退重试）

    // 生成
    candidates: 3,
    replyStyle: "short",
    prompt: PROMPT,
    hardFilter: true,     // 踩雷硬过滤：括号引号/禁语/超长/不是A而是B 的候选直接丢掉

    // 图片帖（纯图无正文时用视觉模型直接看图）
    useVision: true,
    // 实测（600px 单图）：omni-flash 507ms / vl-plus 798-936ms / 3.8-omni-flash 3591ms
    visionModel: "qwen3.5-omni-flash",
    imagesMax: 2,
    imageSize: "small",   // small≈600px(401tok) / medium≈1200px(1480tok)。实测 360px 会看错细节，small 是甜点

    // 评论区上下文
    useComments: true,        // 生成时把已加载的评论一起喂给模型（重要参考，用来对齐语感、避免不搭）
    maxComments: 20,          // 最多带多少条。参考越多越能仿准，但 token 线性增长
    autoScrollComments: false,// 生成前自动下滑加载更多评论（会动你的滚动位置）

    // 行为
    autoGenerate: true,    // 进入帖子详情页自动生成候选（会消耗额度，不想要就在这里关）
    autoFill: false,       // 生成后自动填入第一条到回复框
    showAiBtn: true,       // 推文工具栏上的 AI 按钮

    // 回复后自动点赞原帖。会在你的账号上真实执行点赞，已赞过的不会重复点。
    autoLike: true,
    // 基准延迟（毫秒）。太短 X 还没处理完回复，点赞会失败。
    autoLikeDelay: 700,
    // 随机浮动百分比：实际延迟在 基准×(1±jitter/100) 内均匀取值。
    // 默认 700ms ±40% => 420~980ms。固定间隔的机械节奏比延迟本身更容易被识别成自动化。
    autoLikeJitter: 40,

    // 界面
    translateUI: true,
    highlightFollow: true,
    trackInteractions: true,
    showFab: true,

    // 互动追踪：自动识别失败时在这里手填自己的用户名（不带 @）
    myHandle: "",
    // 「自动下滑扫描」：边走边记，补历史数据用
    scanRoundsMax: 40,     // 最多滚多少轮。每轮约一屏，40 轮够翻很深了
    scanStepMs: 900,       // 每轮间隔。太短 X 还没渲染完就滚走了，会漏记


    // 面板
    panelPos: { right: 20, bottom: 88 },
    panelMin: true
  };

  // 模型下拉框分组。label 里带上实测数据，省得用户自己试。
  var MODEL_GROUPS = [
    {
      label: "推荐（快 · 便宜 · 格式稳）",
      models: [
        { id: "qwen-flash", note: "711ms / 176tok · 默认首选" },
        { id: "deepseek-v4.1-flash", note: "780ms · 最像真人，AI腔最少" },
        { id: "qwen-plus", note: "1.5s · 比 flash 稳一点" }
      ]
    },
    {
      label: "能看图（图片帖必选）",
      models: [
        { id: "qwen3-vl-plus", note: "549ms · 纯文本也能用，可当全能模型" },
        { id: "qwen3.5-omni-flash", note: "274ms · 最快，多模态" }
      ]
    },
    {
      label: "更强但更慢",
      models: [
        { id: "qwen3.8-max", note: "关思考后约 2s，质量最高" },
        { id: "qwen3.8-flash", note: "关思考后 1.9s" },
        { id: "qwen-max", note: "1.5s+" }
      ]
    },
    {
      label: "不建议（实测有问题）",
      models: [
        { id: "glm-5.3", note: "格式 0/9 合规，解析不出候选" },
        { id: "qwen-flash-character", note: "角色扮演调优，输出是安慰腔" }
      ]
    }
  ];

  var LIMITS = {
    draftsTweets: 60,      // 最多保留多少条推文的草稿
    draftsPerTweet: 12,    // 每条推文最多多少草稿
    candidatesMax: 5,
    handlesMax: 5000,
    idsPerHandle: 500,
    commentsMax: 40,       // 硬上限，防止 prompt 爆掉
    commentChars: 200      // 单条评论截断长度（太短会丢掉语感信息）
  };

  g.XRH = g.XRH || {};
  g.XRH.DEFAULTS = DEFAULTS;
  g.XRH.STYLES = STYLES;
  g.XRH.MODEL_GROUPS = MODEL_GROUPS;
  g.XRH.LIMITS = LIMITS;
  g.XRH.PROMPT = PROMPT;
  g.XRH.REFINE_PROMPT = REFINE_PROMPT;
  g.XRH.CFG_KEY = "xrh_cfg";
  g.XRH.DATA_KEY = "xrh_data";

  // 旧版本存的配置里 autoLikeDelay 是 1200（当时的默认值），而 v2.6 起改成了 700±40%。
  // 只在「值正好等于旧默认、且新字段从未存在过」时才迁移 —— 用户手动设过的不动。
  g.XRH.normalizeCfg = function (cfg) {
    if (!cfg || typeof cfg !== "object") return cfg;
    if (cfg.autoLikeJitter === undefined && Number(cfg.autoLikeDelay) === 1200) {
      cfg.autoLikeDelay = DEFAULTS.autoLikeDelay;
      cfg.autoLikeJitter = DEFAULTS.autoLikeJitter;
    }
    if (cfg.autoLikeJitter === undefined) cfg.autoLikeJitter = DEFAULTS.autoLikeJitter;
    return cfg;
  };

  // v2.8 起去重键带命名空间前缀（out 用 p:<父帖ID>、inn 用 r:<对方回复ID>），
  // 旧数据是裸 ID。不归一化的话同一次互动会因为键不同被记两次。
  // 注意：旧 out 键本身就有歧义（发送钩子存的是父帖ID，被动扫描存的是我的回复ID），
  // 无法回溯区分，统一按 p: 处理 —— 这只能保证此后不再新增重复，修不了已经虚高的旧计数。
  g.XRH.normalizeData = function (data) {
    if (!data || typeof data !== "object" || !data.byAccount) return { data: data, changed: false };
    var changed = false;
    Object.keys(data.byAccount).forEach(function (a) {
      var A = data.byAccount[a] || {};
      var handles = A.handles || {};
      Object.keys(handles).forEach(function (h) {
        var slot = handles[h];
        if (!slot) return;
        [["out", "p:"], ["inn", "r:"]].forEach(function (pair) {
          var dir = pair[0], pre = pair[1];
          if (!Array.isArray(slot[dir])) { slot[dir] = []; changed = true; return; }
          var seen = {}, out = [];
          slot[dir].forEach(function (k) {
            k = String(k);
            var nk = /^[a-z]:/.test(k) ? k : (pre + k);
            if (nk !== k) changed = true;
            if (seen[nk]) { changed = true; return; }
            seen[nk] = 1;
            out.push(nk);
          });
          if (out.length !== slot[dir].length) changed = true;
          slot[dir] = out;
        });
      });
    });
    return { data: data, changed: changed };
  };

  // 旧版本把配置平铺存在 chrome.storage.local 的 apiKey/baseUrl/model 上，
  // v2 改成 xrh_cfg 对象。这里做一次性无损迁移，避免升级后 Key 丢失。
  g.XRH.migrateCfg = function (storage, cb) {
    var KEYS = [g.XRH.CFG_KEY, "apiKey", "baseUrl", "model"];
    try {
      storage.local.get(KEYS, function (r) {
        r = r || {};
        var legacy = (r.apiKey || r.baseUrl || r.model)
          ? { apiKey: r.apiKey || "", baseUrl: r.baseUrl || "", model: r.model || "" }
          : null;
        if (!legacy) { cb && cb(r[g.XRH.CFG_KEY] || null, false); return; }
        var merged = Object.assign({}, legacy, r[g.XRH.CFG_KEY] || {});
        // 新对象里没填的字段用旧值补上（用户在旧版存过 Key 但新版还没保存过）
        if (!merged.apiKey && legacy.apiKey) merged.apiKey = legacy.apiKey;
        var o = {}; o[g.XRH.CFG_KEY] = merged;
        storage.local.set(o, function () {
          storage.local.remove(["apiKey", "baseUrl", "model"], function () {
            cb && cb(merged, true);
          });
        });
      });
    } catch (e) { cb && cb(null, false); }
  };
})(typeof globalThis !== "undefined" ? globalThis : self);

