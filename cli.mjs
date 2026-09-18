#!/usr/bin/env node
// 用法: node cli.mjs sample-comments.json [--dry-run] [--concurrency 4]
// 依赖: Node >= 18（内置 fetch），无第三方依赖
// 密钥: 环境变量 TYPESAFE_API_KEY

import { readFileSync } from "node:fs";
import { classifyComment, buildState, buildQuestions, MODEL } from "./classifier.mjs";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const concurrencyIdx = args.indexOf("--concurrency");
const concurrency = concurrencyIdx >= 0 ? Number(args[concurrencyIdx + 1]) || 4 : 4;
const file = args.find((a) => !a.startsWith("--") && a !== String(concurrency));

if (!file) {
  console.error("用法: node cli.mjs <comments.json> [--dry-run] [--concurrency 4]");
  process.exit(1);
}

const items = JSON.parse(readFileSync(file, "utf8"));
const apiKey = process.env.TYPESAFE_API_KEY;

if (dryRun) {
  console.log(`—— 发送给 ${MODEL} 的请求体（第 1 条评论）——\n`);
  console.log(
    JSON.stringify({ state: buildState(items[0]), model: MODEL, questions: buildQuestions() }, null, 2),
  );
  console.log(`\n共 ${items.length} 条评论。去掉 --dry-run 并设置 TYPESAFE_API_KEY 后正式运行。`);
  process.exit(0);
}

if (!apiKey) {
  console.error("缺少 API key：请先 export TYPESAFE_API_KEY=sk-...");
  process.exit(1);
}

// 简单并发池：评论之间相互独立，逐条独立请求（每条的 state 不同）
const results = new Array(items.length);
let next = 0;
async function worker() {
  while (next < items.length) {
    const i = next++;
    try {
      results[i] = await classifyComment(items[i], { apiKey });
    } catch (err) {
      results[i] = { text: items[i].text, category: "error", error: String(err.message ?? err) };
    }
    process.stderr.write(`\r已处理 ${Math.min(next, items.length)}/${items.length}`);
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
process.stderr.write("\n\n");

printReport(results);

function printReport(results) {
  const byCategory = {};
  for (const r of results) (byCategory[r.category] ??= []).push(r);

  const labels = {
    malicious: "恶意评论",
    water: "水评论",
    inspiration: "灵感评论",
    normal: "普通评论",
    error: "处理失败",
  };

  for (const [cat, list] of Object.entries(byCategory)) {
    console.log(`\n===== ${labels[cat] ?? cat}（${list.length} 条）=====`);
    for (const r of list) {
      const flag = r.flags?.length ? `  [${r.flags.join(",")}]` : "";
      const sev =
        cat === "malicious" ? `  恶意程度 ${r.maliceSeverity}/3` : "";
      console.log(`· (${r.confidence?.toFixed(2) ?? "-"}) ${r.text}${sev}${flag}`);
      if (r.flags?.includes("needs_review") || r.top2?.[1]) {
        const [first, second] = r.top2;
        if (second && Number(second.split("=")[1]) > 0.15) {
          console.log(`    分布: ${first}  ${second}`);
        }
      }
      if (r.error) console.log(`    错误: ${r.error}`);
    }
  }

  const candidates = results.filter((r) => r.flags?.includes("inspiration_candidate"));
  if (candidates.length) {
    console.log(`\n===== 灵感候选（首选不是灵感但概率 >= 0.25，共 ${candidates.length} 条）=====`);
    for (const r of candidates) {
      console.log(`· 灵感=${r.probabilities.inspiration.toFixed(2)}  ${r.text}`);
    }
  }

  const review = results.filter((r) => r.flags?.includes("needs_review"));
  console.log(`\n小计: 共 ${results.length} 条，其中待人工复核 ${review.length} 条`);
}
