// 评论智析 content script：在四个平台的页面上按需抓取当前已加载的评论。
// 只读取用户已经看到（滚动加载出来）的 DOM，不做任何页面操作。
//
// B站新版评论区是 Web Component（bili-comments），内容封装在多层 open Shadow DOM
// 里，普通 querySelector 穿不透；下面这套深度查询统一处理（对无 shadow 的平台
// 是无害的超集）。

const ADAPTERS = {
  "www.bilibili.com": {
    name: "bilibili",
    label: "B站",
    title: [".video-info-title h1", "h1.video-title"],
    // 新版结构：bili-comment-thread-renderer(一级) 内含 bili-comment-renderer；
    // 子回复也是 bili-comment-renderer，会与一级重复命中，靠文本去重合并。
    containers: [
      "bili-comment-thread-renderer",
      "bili-comment-renderer",
      ".reply-item",
      ".sub-reply-item",
    ],
    // 以下选择器经真实页面核验（BV1rWeC6LEWz，2026-09）：
    // 文本在 bili-rich-text 的 shadow 里 <style> 之后，必须精确定位 #contents
    text: [
      "bili-rich-text >>> #contents",
      ".reply-content",
      ".reply-content-container",
    ],
    // 作者：bili-comment-user-info 的 shadow → div#user-name（无 bili-user-profile）
    author: [
      "bili-comment-user-info >>> #user-name",
      "bili-user-profile >>> app-link",
      ".user-name",
      ".sub-user-name",
    ],
    likes: [
      "bili-comment-action-buttons-renderer >>> #like >>> #count",
      ".reply-like .total",
    ],
  },
  "www.douyin.com": {
    name: "douyin",
    label: "抖音",
    title: ['[data-e2e="video-title"]', ".video-info-detail h1", "h1"],
    containers: ['div[data-e2e="comment-item"]'],
    text: [
      '[data-e2e="comment-item-content"]',
      ".comment-item-content",
      ".comment-content",
      '[data-e2e="comment-reply-content"]',
    ],
    author: ['[data-e2e="comment-user-info"]', ".nickname", ".author-name"],
    likes: ['[data-e2e="comment-item-likes"]'],
  },
  "www.xiaohongshu.com": {
    name: "xiaohongshu",
    label: "小红书",
    title: ["#detail-title", ".note-content .title", "h1"],
    containers: [".comment-item", ".reply-item"],
    text: [".content", ".comment-content"],
    author: [".author .name", ".name", ".username"],
    likes: [".like .count", ".like-wrapper .count", ".bottom .count"],
  },
  "www.youtube.com": {
    name: "youtube",
    label: "YouTube",
    title: ["h1.ytd-watch-metadata", "h1.title"],
    containers: ["ytd-comment-thread-renderer", "ytd-comment-thread-view-model"],
    text: ["#content-text"],
    author: ["#author-text", "#author-name"],
    likes: ["#vote-count-middle"],
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "JEV_PING") {
    const adapter = ADAPTERS[location.hostname];
    sendResponse({ ok: !!adapter, platform: adapter?.name, host: location.hostname });
    return;
  }
  if (msg?.type === "SCRAPE_COMMENTS") {
    sendResponse(scrape(msg.max ?? 300));
  }
  if (msg?.type === "DUMP_STRUCTURE") {
    sendResponse(dumpStructure());
  }
});

/** 调试用：返回第一个命中的评论容器的外层 HTML，用于离线分析选择器 */
function dumpStructure() {
  const adapter = ADAPTERS[location.hostname];
  if (!adapter) return { ok: false, error: `不支持的平台：${location.hostname}` };
  for (const sel of adapter.containers) {
    const nodes = deepQuerySelectorAll(sel);
    if (nodes.length > 0) {
      return {
        ok: true,
        platform: adapter.name,
        usedSelector: sel,
        count: nodes.length,
        firstHtml: nodes[0].outerHTML.replace(/\s+/g, " ").slice(0, 4000),
      };
    }
  }
  return { ok: false, platform: adapter.name, error: "容器选择器全部未命中" };
}

function scrape(max) {
  const adapter = ADAPTERS[location.hostname];
  if (!adapter) {
    return { ok: false, error: `不支持的平台：${location.hostname}` };
  }

  const title = firstText(adapter.title) || document.title || "";
  const diagnostics = [];
  const seen = new Set();
  const comments = [];
  let heuristicCount = 0;

  for (const sel of adapter.containers) {
    const nodes = deepQuerySelectorAll(sel);
    diagnostics.push(`${sel} -> ${nodes.length} 个节点`);
    for (const node of nodes) {
      const textEl = firstMatch(node, adapter.text);
      let text = textEl ? normWs(deepText(textEl)) : null;
      let author = "";
      let likes = 0;
      if (text) {
        const authorEl = firstMatch(node, adapter.author);
        author = authorEl ? normWs(deepText(authorEl)) : "";
        const likesEl = firstMatch(node, adapter.likes);
        likes = parseLikes(likesEl ? deepText(likesEl) : "");
      } else {
        // 选择器全未命中（平台改版/混淆 class）：按行启发提取兜底
        const guess = heuristicExtract(node);
        if (!guess) continue;
        ({ text, author, likes } = guess);
        heuristicCount++;
      }
      const key = author + " " + text;
      if (!text || seen.has(key)) continue;
      seen.add(key);
      comments.push({ text: text.slice(0, 1000), author, likes });
      if (comments.length >= max) break;
    }
    if (comments.length >= max) break;
  }

  return {
    ok: true,
    platform: adapter.name,
    platformLabel: adapter.label,
    title: title.trim().slice(0, 200),
    url: location.href.split("?")[0],
    comments,
    diagnostics,
    heuristicCount,
  };
}

/**
 * 选择器失效时的兜底：从评论容器的 innerText 按行提取。
 * 抖音/小红书的 class 是构建哈希、随版本变化，这个路径不依赖 class。
 * 典型结构：昵称 / 时间·IP属地 / 正文 / 回复 / 点赞数
 */
const NOISE_LINE =
  /^(回复|赞|分享|举报|\d+|[\d.,]+\s*万?|.*\d+\s*(秒|分钟|小时|天|周|月|年)前.*|IP属地.*|展开|收起|查看\s*\d+\s*条回复|—+)$/;

function heuristicExtract(el) {
  const lines = (el.innerText || "").split("\n").map((s) => s.trim()).filter(Boolean);
  if (!lines.length) return null;
  const meaningful = lines.filter((l) => !NOISE_LINE.test(l));
  const text = [...meaningful].sort((a, b) => b.length - a.length)[0];
  if (!text || text.length < 2) return null;
  const author = lines[0] !== text && !NOISE_LINE.test(lines[0]) ? lines[0] : "";
  const likesLine = [...lines].reverse().find((l) => /^[\d.,]+\s*万?$/.test(l));
  return { text, author, likes: parseLikes(likesLine ?? "") };
}

/** 依次尝试选择器，返回第一个命中的元素 */
function firstMatch(root, selectors) {
  for (const sel of selectors) {
    const el = deepQuery(root, sel);
    if (el) return el;
  }
  return null;
}

function firstText(selectors) {
  const el = firstMatch(document, selectors);
  return el ? normWs(deepText(el)) : null;
}

/**
 * 深度查询单个元素。
 * - 支持 "a >>> b >>> c" 语法：逐段下钻，元素有 shadowRoot 就进 shadow 查，
 *   没有就在元素自身查（B站 div#like 无 shadow，#count 是其普通子元素）
 * - 普通选择器：先在当前 root 直接查，再递归穿透所有后代的 shadowRoot
 */
function deepQuery(root, selector) {
  const parts = selector.split(">>>").map((s) => s.trim());
  if (parts.length > 1) {
    let el = deepQuery(root, parts[0]);
    for (let i = 1; i < parts.length && el; i++) {
      el = (el.shadowRoot || el).querySelector(parts[i]);
    }
    return el;
  }
  const direct = root.querySelector?.(selector);
  if (direct) return direct;
  if (root.shadowRoot) {
    const r = deepQuery(root.shadowRoot, selector);
    if (r) return r;
  }
  for (const el of root.querySelectorAll("*")) {
    if (el.shadowRoot) {
      const r = deepQuery(el.shadowRoot, selector);
      if (r) return r;
    }
  }
  return null;
}

/** 深度查询所有匹配（穿透整个文档含全部 shadow root） */
function deepQuerySelectorAll(selector, root = document, acc = new Set()) {
  for (const el of root.querySelectorAll(selector)) acc.add(el);
  if (root.shadowRoot) deepQuerySelectorAll(selector, root.shadowRoot, acc);
  for (const el of root.querySelectorAll("*")) {
    if (el.shadowRoot) deepQuerySelectorAll(selector, el.shadowRoot, acc);
  }
  return [...acc];
}

/** 取元素文本，穿透 shadow 边界（innerText 看不到 shadow 里的内容）；
 *  跳过 style/script 等非可见文本——B站 shadow 里 <style> 带上千字节 CSS */
const NON_VISIBLE_TAGS = new Set(["STYLE", "SCRIPT", "TEMPLATE", "LINK", "META", "TITLE"]);

function deepText(el) {
  if (!el) return "";
  if (NON_VISIBLE_TAGS.has(el.tagName)) return "";
  let out = "";
  if (el.shadowRoot) out += deepText(el.shadowRoot);
  for (let c = el.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === Node.TEXT_NODE) out += c.textContent;
    else out += deepText(c);
  }
  return out;
}

const normWs = (s) => s.replace(/\s+/g, " ").trim();

/** 点赞数解析：兼容 "1234"、"1.2万"、"1.2w"、"" */
function parseLikes(raw) {
  if (!raw) return 0;
  const m = raw.replace(/,/g, "").match(/([\d.]+)\s*(万|w|k)?/i);
  if (!m) return 0;
  let n = parseFloat(m[1]);
  if (m[2] === "万" || m[2]?.toLowerCase() === "w") n *= 10000;
  else if (m[2]?.toLowerCase() === "k") n *= 1000;
  return Math.round(n);
}
