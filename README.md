# AirSonde-CRM · AI 自动获客系统

> **fork 自 `AI云端获客`（Wanew-CRM 生产仓）@ `e2d0ad051f4991c8d772b9e8af7a32abd3082b3b`**
> （分支 feat/access-jwt-authoritative 工作树，2026-08-11 搬迁，派单 C1）。
> 那 13k 行和 16 个 schema 文件是上游几个月的踩坑史——本仓的原则是**搬和改名，不重写**。
> 上游事故注释一律保留（品牌词已中性化），它们是这套系统为什么长这样的原始记录。

为 [airsonde.com](https://airsonde.com/)（欧美 B2B/ODM 空气质量检测仪）自动寻找潜在客户。
全 Serverless 架构：Cloudflare Workers + D1 + 静态资源 + OpenRouter + Resend + Lark IMAP。

## ⛔ 当前状态（C1 骨架期）：发信结构性锁死

- `RESEND_API_KEY` / `LARK_WEBHOOK` / `LARK_IMAP_PASS` / `SEARCH_API_KEY` / `OPENROUTER_API_KEY` **全部未配** = 发信/通知/收信/搜索/AI 逐项 fail-closed
- dev 出站闸（`src/devguard.ts`）保持激活：本地进程默认只准出 localhost
- 发信域未定（候选 airsonde.net，待 Joe 确认）；飞书 webhook 待 Joe 建新群，**绝不复用 Wanew 的**
- 公开 API 正门（API_HOST/PUBLIC_API_URL）故意不配 = 公开分支不激活，全站在 Access 门后

## 链路（继承上游）

discover（Serper 搜索/目录）→ scrape（抓官网）→ findemail → AI 打分+写信（OpenRouter）
→ **人工审批**（humanapprove 闸，永不放开全自动）→ 发信（Resend，节流+熔断+suppress 压制）
→ 收回复（Lark IMAP + 回复匹配）→ 飞书通知

## 本地开发

```bash
npm install
npm run db:init:local     # 建表（本地 D1，schema.sql 已是合并后的单一真源）
npm run dev               # http://localhost:8787
```

## 部署

```bash
npm run deploy            # 前置 typecheck 是部署闸，别绕
```

生产域 `crm.airsonde.com`（custom_domain，Cloudflare Access 门后）。

## D1 结构

- `schema.sql` — **单一真源**（上游 #45 已把 14 个 schema_*.sql 增量合并进来，新库跑它一次即全）
- `migrations/0001_emails_error.sql` — 晚于 #45 合并的唯一增量（emails.error），新库需补跑
- `schema_*.sql` — 上游历史增量，仅作留档与旧库补列用，**新库不要跑**（会 duplicate column）

## 不在本仓的上游资产（要用去上游 `C:\开发\AI云端获客` 取）

- `fix_*.sql` ×5 —— Wanew 生产库的一次性数据修复脚本，描述的是**另一个库**的事故，留在本仓会误导，故删（总工裁定，C1 关单）
- `shim-tejoy-ai-getke/` —— 给 Wanew 已发邮件老退订链接续命的独立 worker，AirSonde 零历史邮件用不上

## 目录

- `src/index.ts` — Worker + Hono API（主路由与 auth 中间件）
- `src/send.ts` — 发信（节流/熔断/审批闸/suppress）
- `src/devguard.ts` — dev 出站闸门（本地不许碰真实第三方）
- `public/index.html` — 后台前端（零构建）
- `docs/` — **上游 Wanew-CRM 历史文档，原样保留**（品牌词属历史事实，不改写）
