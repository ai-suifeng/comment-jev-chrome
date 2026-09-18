// UI 胶水：视图切换、渲染报告。分类逻辑都在 popup.js 里。

const $ = (id) => document.getElementById(id);
let lastReport = null;
let activeTab = "inspiration";

// ---------- 初始化 ----------

init();

async function init() {
  const s = await loadSettings();
  $("inp-key").value = s.apiKey;
  $("inp-batch").value = s.batchSize;
  $("inp-max").value = s.maxComments;

  $("btn-settings").onclick = () => $("settings").classList.toggle("hidden");
  $("btn-save-key").onclick = saveSettings;
  $("btn-analyze").onclick = startAnalysis;
  $("btn-retry").onclick = startAnalysis;
  $("btn-dump").onclick = dumpStructure;
  $("btn-again").onclick = () => show("view-ready");
  $("btn-export").onclick = exportJson;

  const tab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  const info = await pingTab(tab);
  if (info?.ok) {
    const names = { bilibili: "B站", douyin: "抖音", xiaohongshu: "小红书", youtube: "YouTube" };
    $("page-info").innerHTML = `<b>${names[info.platform] ?? info.platform}</b> · 先滚动加载评论区，再点分析`;
    $("btn-analyze").disabled = false;
  } else {
    $("page-info").innerHTML = "当前页面不是 B站 / 抖音 / 小红书 / YouTube 的视频或笔记页";
    $("btn-analyze").disabled = true;
  }
}

/** ping 失败可能只是页面比插件先打开（content script 未注入），现场注入后再试一次 */
async function pingTab(tab) {
  try {
    return await chrome.tabs.sendMessage(tab.id, { type: "JEV_PING" });
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content/content.js"] });
      return chrome.tabs.sendMessage(tab.id, { type: "JEV_PING" });
    } catch {
      return null;
    }
  }
}

async function saveSettings() {
  await chrome.storage.local.set({
    apiKey: $("inp-key").value.trim(),
    batchSize: clamp($("inp-batch").value, 5, 25, 10),
    maxComments: clamp($("inp-max").value, 10, 500, 200),
  });
  $("btn-save-key").textContent = "已保存";
  setTimeout(() => ($("btn-save-key").textContent = "保存"), 1200);
}

const clamp = (v, lo, hi, dft) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dft;
};

// ---------- 分析流程 ----------

async function startAnalysis() {
  show("view-running");
  setProgress(0, 1, "抓取评论中…");
  try {
    lastReport = await analyze({
      onProgress: (doneBatches, totalBatches, classified) => {
        const label = totalBatches > doneBatches || totalBatches === 0 ? "分类中" : "评估恶意程度";
        setProgress(doneBatches, Math.max(totalBatches, 1), `${label}…已分类 ${classified} 条`);
      },
      onPartial: () => {},
    });
    renderReport(lastReport);
    show("view-report");
  } catch (err) {
    $("error-text").textContent = String(err.message ?? err);
    show("view-error");
  }
}

function setProgress(done, total, text) {
  $("progress-bar").style.width = `${Math.round((done / total) * 100)}%`;
  $("progress-text").textContent = text;
}

function show(id) {
  for (const v of ["view-ready", "view-running", "view-error", "view-report"]) {
    $(v).classList.toggle("hidden", v !== id);
  }
}

/** 把当前页第一条评论的 DOM 结构复制到剪贴板，供离线修复选择器 */
async function dumpStructure() {
  const btn = $("btn-dump");
  try {
    const tab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    const res = await chrome.tabs.sendMessage(tab.id, { type: "DUMP_STRUCTURE" });
    if (!res?.ok) throw new Error(res?.error || "容器选择器全部未命中");
    await navigator.clipboard.writeText(JSON.stringify(res, null, 2));
    btn.textContent = "已复制到剪贴板";
  } catch (err) {
    btn.textContent = "复制失败：" + String(err.message ?? err).slice(0, 40);
  }
  setTimeout(() => (btn.textContent = "复制结构诊断"), 2500);
}

// ---------- 报告渲染 ----------

const CATEGORY_LABELS_UI = { malicious: "恶意", water: "水", inspiration: "灵感", normal: "普通" };

function renderReport({ meta, results }) {
  const counts = { malicious: 0, water: 0, inspiration: 0, normal: 0 };
  for (const r of results) counts[r.category]++;

  $("report-meta").innerHTML = `<b>${esc(meta.platformLabel)}</b> · ${esc(meta.title)} · 共 ${results.length} 条`;
  $("stat-chips").innerHTML = ["malicious", "water", "inspiration", "normal"]
    .map((c) => `<span class="chip ${c}"><span class="n">${counts[c]}</span>${CATEGORY_LABELS_UI[c]}</span>`)
    .join("");

  const tabs = [
    { id: "inspiration", label: `💡 灵感 ${counts.inspiration + countFlag(results, "inspiration_candidate")}` },
    { id: "review", label: `⚠️ 待复核 ${countFlag(results, "needs_review")}` },
    { id: "malicious", label: `😡 恶意 ${counts.malicious}` },
    { id: "water", label: `💧 水 ${counts.water}` },
    { id: "normal", label: `💬 普通 ${counts.normal}` },
    { id: "all", label: "全部" },
  ];
  $("tabs").innerHTML = tabs
    .map((t) => `<button class="tab" data-tab="${t.id}">${t.label}</button>`)
    .join("");
  for (const el of $("tabs").querySelectorAll(".tab")) {
    el.onclick = () => {
      activeTab = el.dataset.tab;
      renderList(lastReport);
    };
  }
  renderList(lastReport);
}

const countFlag = (results, flag) => results.filter((r) => r.flags.includes(flag)).length;

function itemsForTab(report, tab) {
  const rs = report.results;
  const byInsp = (a, b) => b.probabilities.inspiration - a.probabilities.inspiration;
  switch (tab) {
    case "inspiration": {
      const direct = rs.filter((r) => r.category === "inspiration").sort(byInsp);
      const candidates = rs
        .filter((r) => r.flags.includes("inspiration_candidate"))
        .sort(byInsp);
      return [...direct, ...candidates];
    }
    case "review":
      return rs.filter((r) => r.flags.includes("needs_review"));
    case "malicious":
      return rs
        .filter((r) => r.category === "malicious")
        .sort((a, b) => (b.severity ?? -1) - (a.severity ?? -1));
    case "water":
      return rs.filter((r) => r.category === "water");
    case "normal":
      return rs.filter((r) => r.category === "normal");
    default:
      return rs;
  }
}

function renderList(report) {
  for (const el of $("tabs").querySelectorAll(".tab")) {
    el.classList.toggle("active", el.dataset.tab === activeTab);
  }
  const items = itemsForTab(report, activeTab);
  if (items.length === 0) {
    $("comment-list").innerHTML = '<div class="empty-tab">这个分类下暂无评论</div>';
    return;
  }
  $("comment-list").innerHTML = items.map(itemHtml).join("");
  for (const el of $("comment-list").querySelectorAll(".text.clamp")) {
    el.onclick = () => el.classList.toggle("clamp");
  }
}

function itemHtml(r) {
  const badges = [];
  if (r.flags.includes("inspiration_candidate") && activeTab === "inspiration") {
    badges.push('<span class="badge cand">灵感候选</span>');
  }
  if (r.flags.includes("needs_review")) badges.push('<span class="badge review">待复核</span>');
  if (r.category === "malicious" && r.severity != null) {
    badges.push(`<span class="badge sev">敌意 ${r.severity.toFixed(1)}/3</span>`);
  }
  if (activeTab === "all" || activeTab === "review") {
    badges.push(`<span class="badge">${CATEGORY_LABELS_UI[r.category]}</span>`);
  }
  const likes = r.item.likes > 0 ? ` · ❤ ${r.item.likes}` : "";
  return `<div class="item ${r.category}">
    <div class="meta-line">
      <span class="author">${esc(r.item.author) || "匿名"}${likes}</span>
      <span>置信 ${r.confidence.toFixed(2)}</span>
    </div>
    <div class="text clamp">${esc(r.item.text)}</div>
    <div>${badges.join("")}</div>
  </div>`;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

// ---------- 导出 ----------

function exportJson() {
  if (!lastReport) return;
  const blob = new Blob([JSON.stringify(lastReport, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `comments-${lastReport.meta.platform}-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
