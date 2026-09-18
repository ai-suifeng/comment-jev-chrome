// 自媒体评论分类器：基于 TypeSafe Jev (System One) 的类型化判断
// API 契约见 https://docs.typesafe.ai/api.md

const API_URL = "https://api.typesafe.ai/v1/systemone";
export const MODEL = "jev-latest";

/**
 * 分类策略（纯代码策略，改阈值不需要重新跑推理）：
 * - confidence >= 0.7          -> 自动归类
 * - confidence <  0.5          -> 进人工复核
 * - 灵感概率 >= 0.25           -> 即使首选不是灵感，也进"灵感候选"
 *   （挖选题的场景下，边界样本往往最有价值，靠完整分布而不是只看 argmax）
 */
export const POLICY = {
  autoConfidence: 0.7,
  reviewConfidence: 0.5,
  inspirationCandidateProbability: 0.25,
};

/**
 * 每条评论的 state：评论不是孤立的文本，标题等上下文会改变语义
 * （"这个不行"在不同视频下含义完全不同），所以用命名字段组装。
 */
export function buildState(item) {
  return {
    content_title: item.contentTitle ?? "",
    comment: {
      text: item.text,
      author: item.author ?? "",
      likes: item.likes ?? 0,
    },
  };
}

/**
 * 一次请求里问两个相互独立的问题（并行执行，互不可见）：
 * 1. category         —— 四选一，主分类，带完整分布和 confidence
 * 2. malice_severity  —— 有序等级评分；仅在恶意分支消费，但原始判断
 *                        保留在结果里，日后改处置策略无需重跑推理。
 */
export function buildQuestions() {
  return {
    category: {
      type: "choice",
      instructions:
        "判断 `comment.text` 这条自媒体评论属于哪一类。结合 `content_title` 的内容主题理解评论语义。",
      criteria: {
        malicious: {
          what: "针对博主或其他网友的人身攻击、辱骂、嘲讽贬低、仇恨言论，或恶意揣测博主动机（如认定收钱吹捧）",
          not_for: "针对内容本身、语气理性的批评不算恶意，即使观点尖锐",
          examples: [
            "就这水平也敢出来教人？",
            "博主这口音听着真难受，练练再录吧",
            "收了多少钱这么卖力吹？",
          ],
        },
        water: {
          what: "无实质信息的灌水：纯表情、玩梗刷存在感、模板化复制粘贴、机器人式评论、与内容无关的抢楼",
          not_for: "简短但和内容相关的真诚互动不算水",
          examples: ["666", "沙发！", "哈哈哈哈哈哈", "感谢分享，已三连"],
        },
        inspiration: {
          what: "对创作者有启发的评论：提出值得做成下期内容的选题或问题、有洞察的分析、建设性建议、补充了有价值的信息、指出了内容中可深挖的点",
          not_for: "单纯的夸赞即使很热情也不算灵感",
          examples: [
            "能不能出一期对比两个工具在团队协作下的表现？",
            "亲测这个方法在南方潮湿环境会失败，原因是……",
          ],
        },
        normal: {
          what: "真诚但平凡的互动：具体化的称赞、围绕内容的提问、正常讨论、个人经验分享",
          not_for: "平凡不等于灌水，只要有真实具体的交流就属于普通评论",
          examples: ["学到了，正好最近在折腾这个", "请问背景音乐叫什么"],
        },
      },
    },
    malice_severity: {
      type: "score",
      instructions:
        "评估 `comment.text` 中针对人的敌意程度（当评论针对内容而非人时给低分）。",
      criteria: [
        "针对内容或话题本身表达观点，没有针对任何人的敌意",
        "带刺的调侃或阴阳怪气，让人不适但不构成直接辱骂",
        "明确的辱骂、人身攻击，或恶意揣测博主动机",
        "严重辱骂、威胁、仇恨言论或骚扰",
      ],
    },
  };
}

export async function classifyComment(item, { apiKey, fetchImpl = fetch } = {}) {
  const body = {
    state: buildState(item),
    model: MODEL,
    questions: buildQuestions(),
  };

  const res = await postWithRetry(body, apiKey, fetchImpl);
  return decorate(item, res.answers);
}

/** 按路由策略给原始判断加上处置结论；原始概率全部保留 */
export function decorate(item, answers) {
  const { choice, probabilities, confidence } = answers.category;
  const top2 = Object.entries(probabilities)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([name, p]) => `${name}=${p.toFixed(2)}`);

  const flags = [];
  if (confidence < POLICY.reviewConfidence) flags.push("needs_review");
  if (probabilities.inspiration >= POLICY.inspirationCandidateProbability && choice !== "inspiration") {
    flags.push("inspiration_candidate");
  }

  return {
    text: item.text,
    author: item.author ?? "",
    category: choice,
    confidence,
    probabilities,
    top2,
    maliceSeverity: answers.malice_severity.score,
    maliceSeverityLegend: answers.malice_severity.legend,
    flags,
  };
}

async function postWithRetry(body, apiKey, fetchImpl, maxRetries = 3) {
  let delay = 1000;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetchImpl(API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (res.ok) return res.json();
    if (res.status === 429 || res.status === 529) {
      if (attempt === maxRetries) {
        throw new Error(`TypeSafe API 过载（${res.status}），已重试 ${maxRetries} 次`);
      }
      await sleep(delay);
      delay *= 2;
      continue;
    }
    const text = await res.text();
    throw new Error(`TypeSafe API ${res.status}: ${text}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
