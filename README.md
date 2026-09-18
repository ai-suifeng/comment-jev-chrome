# comment-jev — 自媒体评论智析

用 TypeSafe 的 Jev（System One 模型）对自媒体评论做类型化判断：**恶意 / 水 / 灵感 / 普通**
四分类，恶意评论附带敌意程度评分，低置信度和灵感边界样本进专门视图。

两部分：

- `extension/` — **浏览器插件**（Chrome MV3）：分析 B站 / 抖音 / 小红书 / YouTube 当前页面的评论
- 根目录的 `classifier.mjs` + `cli.mjs` — 命令行版，用来离线调试问题定义（prompt）

## 安装插件

1. 打开 `chrome://extensions`，右上角开「开发者模式」
2. 「加载已解密的扩展程序」→ 选择 `extension/` 目录
3. 点插件图标 → ⚙ 填入 TypeSafe API key（[docs.typesafe.ai](https://docs.typesafe.ai) 申请）→ 保存
4. 打开一个 B站/抖音/小红书/YouTube 的视频或笔记页，**先把评论区往下滚动加载一些评论**
   （评论是懒加载的，加载出多少分析多少），再点插件 → 「分析本页评论」

> 注意：分析在 popup 里进行，中途关掉 popup 会取消本次分析（进度会丢，重新点即可）。
> key 只存在本机 `chrome.storage.local`。这是个人自用插件的合理做法；如果要公开发布，
> 应改为走一个代理服务端持有 key。

## 使用

- **💡 灵感**：确定的灵感评论（按灵感概率排序）+ 灵感候选（首选是普通但灵感概率 ≥ 0.25
  的边界样本——挖选题时这些往往最值钱）
- **⚠️ 待复核**：confidence < 0.5 的低置信结果
- **😡 恶意**：按敌意程度排序，可据此决定删除 / 隐藏 / 忽略
- **导出 JSON**：完整结果（含每条的概率分布）下载，可二次加工

## 工作方式

```
popup(编排) ──sendMessage──> content script(四平台适配器抓取已加载的 DOM)
   │                              │
   │◄───── 评论数组 ──────────────┘
   │
   ├─ 批量分类：每批 10 条放进同一个 state，每条一个 Choice 问题（c0..c9）
   │   并行 3 批，429/529 指数退避重试
   │
   └─ 二级请求：只对恶意评论评 0-3 敌意程度（Score）
```

- 抓取层是**多级选择器回退**：平台改版 class 变了时，往对应适配器的选择器列表
  （`extension/content/content.js` 的 `ADAPTERS`）头部加新选择器即可，旧的留着兜底
- 抓到 0 条时报告里会带各选择器的命中数诊断，方便定位是选择器失效还是评论没加载
- 分类标准在 `extension/popup/popup.js` 的 `CATEGORY_CRITERIA`；两类容易混淆时，
  优先往 `not_for` / `examples` 加反例
- 路由策略（阈值）在 `POLICY`，改阈值不影响已有判断的语义

## 命令行版（调试 prompt 用）

```bash
export TYPESAFE_API_KEY=sk-...
node cli.mjs sample-comments.json              # 全量分类
node cli.mjs sample-comments.json --dry-run    # 打印将发送的请求体，不需要 key
```

## 已知边界

- B站新版评论区是 Web Component（多层 open Shadow DOM），抓取层用深度查询穿透
  （`content/content.js` 的 `deepQuery` / `deepText`），新旧结构同时兼容
- YouTube / 抖音 / 小红书抓的是一级评论，未展开的回复抓不到（B站含已加载的楼中楼）
- 抖音、小红书前端结构变动频繁，若某平台突然抓不到，看诊断信息更新选择器
- 命令行版 `classifier.mjs` 与插件的 `CATEGORY_CRITERIA` 是两份拷贝，改定义需同步
