// popup 编排层：抓取 → 分批调 Jev → 恶意严重度二级请求 → 汇总渲染
// 在 popup（扩展页面）里直接 fetch，避开 MV3 service worker 闲置回收问题。

const API_URL = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";

// 路由策略：改这里不需要动问题定义
const POLICY = {
  autoConfidence: 0.7,
  reviewConfidence: 0.5,
  inspirationCandidateProbability: 0.25,
};

const DEFAULTS = { batchSize: 10, maxComments: 200 };

const CATEGORY_CRITERIA = {
  malicious: {
    what: "针对博主或其他网友的人身攻击、辱骂、嘲讽贬低、仇恨言论，或恶意揣测博主动机（如认定收钱吹捧）",
    not_for: "针对内容本身、语气理性的批评不算恶意，即使观点尖锐",
    examples: ["就这水平也敢出来教人？", "收了多少钱这么卖力吹？"],
  },
  water: {
    what: "无实质信息的灌水：纯表情、玩梗刷存在感、模板化复制粘贴、机器人式评论、与内容无关的抢楼",
    not_for: "简短但和内容相关的真诚互动不算水",
    examples: ["666", "沙发！"],
  },
  inspiration: {
    what: "对创作者有启发的评论：提出值得做成下期内容的选题或问题、有洞察的分析、建设性建议、补充了有价值的信息、指出了内容中可深挖的点",
    not_for: "单纯的夸赞即使很热情也不算灵感",
  },
  normal: {
    what: "真诚但平凡的互动：具体化的称赞、围绕内容的提问、正常讨论、个人经验分享",
    not_for: "平凡不等于灌水，只要有真实具体的交流就属于普通评论",
  },
};

const SEVERITY_LEVELS = [
  "针对内容或话题本身表达观点，没有针对任何人的敌意",
  "带刺的调侃或阴阳怪气，让人不适但不构成直接辱骂",
  "明确的辱骂、人身攻击，或恶意揣测博主动机",
  "严重辱骂、威胁、仇恨言论或骚扰",
];

const CATEGORY_LABELS = {
  malicious: "恶意",
  water: "水",
  inspiration: "灵感",
  normal: "普通",
};

// ---------- API ----------

async function classifyBatch(batch, meta, apiKey) {
  const questions = {};
  batch.forEach((_, i) => {
    questions[`c${i}`] = {
      type: "choice",
      instructions: `判断 \`comments[${i}].text\` 这条${meta.platformLabel}评论属于哪一类。结合 \`content_title\` 的内容主题理解评论语义。`,
      criteria: CATEGORY_CRITERIA,
    };
  });

  const res = await postWithRetry(
    {
      state: { platform: meta.platform, content_title: meta.title, comments: batch },
      model: MODEL,
      questions,
    },
    apiKey,
  );

  return batch.map((item, i) => {
    const a = res.answers[`c${i}`];
    return decorate(item, a);
  });
}

/** 二级请求：只对恶意评论评敌意程度，原始判断保留可复用 */
async function scoreSeverity(maliciousItems, meta, apiKey) {
  const questions = {};
  maliciousItems.forEach((_, i) => {
    questions[`s${i}`] = {
      type: "score",
      instructions: `评估 \`comments[${i}].text\` 中针对人的敌意程度（当评论针对内容而非人时给低分）。`,
      criteria: SEVERITY_LEVELS,
    };
  });

  const res = await postWithRetry(
    {
      state: {
        platform: meta.platform,
        content_title: meta.title,
        comments: maliciousItems.map((m) => m.item),
      },
      model: MODEL,
      questions,
    },
    apiKey,
  );

  maliciousItems.forEach((m, i) => {
    m.severity = res.answers[`s${i}`].score;
  });
}

function decorate(item, answer) {
  const { choice, probabilities, confidence } = answer;
  const flags = [];
  if (confidence < POLICY.reviewConfidence) flags.push("needs_review");
  if (
    probabilities.inspiration >= POLICY.inspirationCandidateProbability &&
    choice !== "inspiration"
  ) {
    flags.push("inspiration_candidate");
  }
  return {
    item,
    category: choice,
    confidence,
    probabilities,
    severity: null,
    flags,
  };
}

async function postWithRetry(body, apiKey, maxRetries = 3) {
  let delay = 1000;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res;
    try {
      res = await fetch(API_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new Error(`网络错误：无法连接 TypeSafe API（${e.message}）`);
    }
    if (res.ok) return res.json();
    if (res.status === 401) throw new Error("API key 无效，请检查设置");
    if (res.status === 429 || res.status === 529) {
      if (attempt === maxRetries) throw new Error(`TypeSafe API 过载（${res.status}），请稍后再试`);
      await sleep(delay);
      delay *= 2;
      continue;
    }
    throw new Error(`TypeSafe API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 编排 ----------

async function analyze({ onProgress, onPartial }) {
  const { apiKey, batchSize, maxComments } = await loadSettings();
  if (!apiKey) throw new Error("请先在设置里填入 TypeSafe API key");

  const tab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  const scraped = await requestScrape(tab, maxComments);
  if (!scraped.ok) throw new Error(scraped.error);
  if (scraped.comments.length === 0) {
    const hint = scraped.diagnostics?.length
      ? `（诊断：${scraped.diagnostics.join("；")}）`
      : "";
    throw new Error(
      `没有抓到评论。请先在页面上把评论区滚动加载出一些评论再分析。${hint}`,
    );
  }

  const meta = {
    platform: scraped.platform,
    platformLabel: scraped.platformLabel,
    title: scraped.title,
    url: scraped.url,
    scrapedAt: new Date().toISOString(),
  };
  const comments = scraped.comments;
  const batches = [];
  for (let i = 0; i < comments.length; i += batchSize) {
    batches.push(comments.slice(i, i + batchSize));
  }

  const results = [];
  let done = 0;
  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      const b = batches[next++];
      const decorated = await classifyBatch(b, meta, apiKey);
      results.push(...decorated);
      done++;
      onProgress(done, batches.length, results.length);
      onPartial(decorated);
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, batches.length) }, worker));

  // 二级请求：恶意评论的敌意程度（用于决定删除/隐藏/忽略）
  const malicious = results.filter((r) => r.category === "malicious");
  if (malicious.length > 0) {
    onProgress(batches.length, batches.length, results.length);
    await scoreSeverity(malicious, meta, apiKey);
  }

  return { meta, comments, results };
}

/** 优先找已声明的 content script；找不到（页面先于插件加载）就现注入一次 */
async function requestScrape(tab, max) {
  try {
    return await chrome.tabs.sendMessage(tab.id, { type: "SCRAPE_COMMENTS", max });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content/content.js"] });
    return chrome.tabs.sendMessage(tab.id, { type: "SCRAPE_COMMENTS", max });
  }
}

async function loadSettings() {
  const s = await chrome.storage.local.get(["apiKey", "batchSize", "maxComments"]);
  return {
    apiKey: s.apiKey ?? "",
    batchSize: s.batchSize ?? DEFAULTS.batchSize,
    maxComments: s.maxComments ?? DEFAULTS.maxComments,
  };
}
