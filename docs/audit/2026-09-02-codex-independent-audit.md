# AirSonde CRM 独立代码与线上审计报告

**审计日期**：2026-09-02  
**审计对象**：`https://crm.airsonde.com/` 及本地仓库 `C:\开发\airsonde\airsonde-crm`  
**本地基线**：`d1be6c3`（`master`，与 `origin/master` 一致）  
**线上部署标识**：`18463cd+dirty · 2026-09-02 06:46Z`  
**审计方式**：只读源码检查、线上登录态页面检查、匿名入口检查、类型检查、项目自检及依赖漏洞检查。未修改代码、数据库、Cloudflare 配置或线上数据。

## 一、执行摘要

项目当前能够运行，Cloudflare Access 匿名拦截和公开域隔离均有效，类型检查及现有自检通过。但审计发现：

- **2 项高风险问题**：孤儿回复页面存在潜在存储型 XSS；Access JWT 验签器未接入实际鉴权链。
- **3 项中风险问题**：看板回信口径互相矛盾；公网入口未限制请求体大小；生产部署来自脏工作树且落后于 Git 基线。
- **1 项低风险问题**：当前 Hono 版本命中一项 moderate 级依赖通告。

建议修复顺序：

1. 去除孤儿回复列表中的内联 `onclick` 字符串拼接。
2. 配置 AirSonde 正确的 Access AUD，并将 JWT 验签接入管理员域名鉴权。
3. 统一看板的真人回信、测试数据和自动回执排除谓词。
4. 给所有公网 POST 入口增加请求体上限。
5. 禁止从脏工作树部署。

## 二、审计发现

### HIGH-01：孤儿回复列表存在潜在存储型 XSS

**位置**：`public/index.html:4074`、`public/index.html:5460`

孤儿回复列表将外部邮件的发件地址插入内联 JavaScript：

```html
onclick="linkOrphan(${o.id},'${esc(o.from_email)}')"
```

当前 `esc()` 只转义 `& < > "`，不转义单引号：

```js
function esc(s) {
  return (s == null ? "" : String(s)).replace(
    /[&<>"]/g,
    c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c])
  );
}
```

`from_email` 来源于外部来信，不应被视为可信数据。包含单引号或特制 quoted local-part 的地址可破坏 JavaScript 字符串；最轻会使“关联到线索”按钮失效，最坏可能在管理员打开孤儿回复列表时执行攻击者构造的脚本。由于内容来自邮件并持久化到 D1，该问题具备存储型 XSS 的形态。

**建议修复**：

- 不要在 HTML 字符串中生成内联 `onclick`。
- 将 `replyId` 和地址放入 `data-reply-id`、`data-from` 属性。
- 使用统一事件监听器，通过 `event.currentTarget.dataset` 读取数据。
- 增加包含单引号、双引号及 quoted local-part 地址的前端回归测试。

示意：

```html
<button class="btn orphan-link" data-reply-id="..." data-from="...">关联到线索…</button>
```

```js
document.addEventListener("click", (event) => {
  const button = event.target.closest(".orphan-link");
  if (!button) return;
  linkOrphan(Number(button.dataset.replyId), button.dataset.from || "");
});
```

### HIGH-02：Access JWT 验签器未接入实际管理员鉴权

**位置**：`src/index.ts:250-254`、`src/accessjwt.ts:123-199`、`wrangler.jsonc:63-65`

管理员域名当前只检查以下头是否存在：

```ts
const email = c.req.header("cf-access-authenticated-user-email");
if (email) return next();
```

仓库中已经实现了完整的 `observeAccessJwt()`，包括签名、issuer、AUD、过期时间和 `nbf` 检查，但 `src/index.ts` 没有导入或调用它。实际鉴权链仍然信任一个普通请求头的存在性。

线上匿名请求目前会被 Cloudflare Access 302 拦截，因此审计没有确认到即时可利用的生产绕过。不过，只要 Access 应用、路由或策略发生误配置，请求抵达 Worker 后便可通过自带 `cf-access-authenticated-user-email` 头进入全部后台接口。这些接口包括设置修改、线索状态修改和发信动作，影响面很大。

另有一项接线前置问题：

- `src/accessjwt.ts` 的默认 AUD 是 Wanew CRM 的 `9a9ae044…`。
- AirSonde CRM 的真实 AUD 是 `b7c3296b15d1012a18800aee72f009e9d5a2910133715eb90958b0b947291233`。
- 该值已写入 `docs/accessjwt接线评估-2026-08-12.md`，但未配置在 `wrangler.jsonc`。

**建议修复**：

1. 在版本化非机密配置中加入正确的 `ACCESS_AUD`，保证它与代码同批部署。
2. 管理员域名收到请求时，调用 JWT 验签器。
3. 只有 `verified === true` 且存在可信 JWT email 时才放行。
4. 身份展示与审计日志也改用 JWT email，不再使用未验证的 email 头。
5. 将 `scripts/accessjwt-selftest.mjs` 纳入 `npm run typecheck` 和 Wrangler `build.command`，避免验签回归测试游离于部署闸之外。

### MEDIUM-01：看板“真人回信”存在多套互相矛盾的统计口径

**位置**：`src/index.ts:658-669`、`src/index.ts:721-759`、`src/index.ts:912-917`、`public/index.html:4778-4811`、`public/index.html:5106-5123`

线上同一张数据看板实测同时显示：

- 顶部真人回信指标为 **0**；
- 回信构成显示真人回信 **当前 1/3**；
- 周图显示最近一周 **回 3**。

根因包括：

1. 顶部 `counts.replied` 使用当前 `leads.status='replied'` 的线索数。
2. 回信构成使用 `replies` 表，并区分 `is_auto`。
3. 周图查询直接统计全部 `replies`，没有套用 `REAL_REPLY_SQL`，也没有排除测试线索：

```sql
SELECT strftime('%Y-%W', received_at) AS w, COUNT(*) AS n
FROM replies
WHERE received_at IS NOT NULL
  AND date(received_at) >= date('now','-84 days')
GROUP BY w
```

此外，部分国家、分类、收件箱、每日和周粒度查询也没有统一套用测试数据排除谓词。页面虽然声明“已排除自动回执和测试数据”，但该声明只对部分区块成立。

**影响**：

- 看板不能可靠回答“有多少真人回复”。
- 周趋势、维度表现、回信成本和发现卡可能基于不同分子。
- 用户会把口径差异误认为数据丢失、缓存问题或系统故障。

**建议修复**：

- 明确定义两个不同指标：`real_reply_messages`（真人回复邮件数）与 `real_reply_leads`（发生真人回复的去重线索数）。
- 在服务端建立唯一 SQL helper，统一组合：`REAL_REPLY_SQL`、`NOT_TEST_SQL`、是否要求 `lead_id IS NOT NULL`。
- 周图、每日图、维度切片、成本和发现卡分别明确使用哪个指标。
- 孤儿真人回复应单独显示，不要悄悄混入或排除。
- 使用自动回执、测试线索、孤儿真人回复、同一线索多封回复四类固定样本做回归测试。

### MEDIUM-02：公网 POST 入口在验证前完整缓冲请求体

**位置**：`src/index.ts:3049-3054`、`src/index.ts:3067-3070`、`src/index.ts:3455-3463`

以下公网入口会直接调用 `text()` 或 `json()`，代码中没有统一请求体大小限制：

- `POST /api/webhooks/resend`
- `POST /api/webhooks/lark-card`
- `POST /api/inbound`

其中 Resend webhook 在签名校验前执行：

```ts
const raw = await c.req.text();
const ok = await verifyResendSignature(c.env, c.req.raw, raw);
```

公开调用方可以重复提交大请求，使 Worker 在解析或验签前消耗较多内存和 CPU。字段级 `.slice()` 发生在 JSON 已经被完整读入以后，不能防止大请求体造成的资源消耗。

**建议修复**：

- 为公开入口增加统一 body-limit 中间件。
- 根据供应商真实 webhook 大小设置保守上限，例如几十或几百 KB，而不是平台最大值。
- 对可信的 `Content-Length` 超限请求立即返回 `413`。
- 对 chunked/未知长度请求使用带累计字节上限的流式读取。
- 在超限测试中确认不会进入 JSON 解析、签名验证、D1 或通知逻辑。

### MEDIUM-03：生产部署来自脏工作树，且落后于当前 Git 基线

**位置**：`scripts/stamp-build.js`、线上页面右下角部署标识

审计时观察到：

- 线上部署：`18463cd+dirty · 2026-09-02 06:46Z`
- 本地及远端 Git：`d1be6c3`
- 本地工作树：干净

`+dirty` 由 `scripts/stamp-build.js` 根据部署时的 `git status --porcelain` 产生，表示实际部署内容与 `18463cd` 不完全一致。因此当前生产版本不能仅靠 Git commit 精确重建。同时，最新提交 `d1be6c3` 尚未在线上生效。

**影响**：

- 生产故障时无法确定准确源码。
- 回滚到 `18463cd` 不等于回滚到当前生产内容。
- 审计和代码复核看到的 Git 版本与生产实际版本不同。

**建议修复**：

- 部署前若 `git status --porcelain` 非空，直接中止部署。
- 如确有紧急脏树部署需求，要求显式 override，并保存完整 diff 作为部署产物。
- 部署完成后校验线上 `_whoami`/版本戳必须等于目标 commit 且不含 `+dirty`。
- 将“线上版本等于当前发布目标”加入发布完成判据。

### LOW-01：Hono 当前版本命中 moderate 级依赖通告

**位置**：`package-lock.json`、`package.json:17-19`

当前安装版本为 `hono@4.12.28`。`npm audit --omit=dev --audit-level=moderate` 报告 1 个 moderate severity 依赖问题，修复版本高于 `4.12.33`。

通告覆盖 CORS、SSR memo、Proxy Helper 和 Language Middleware 等路径。当前仓库没有使用这些受影响 helper，因此本次审计没有发现明确的可达利用路径；但版本仍应更新，避免未来引入相关 middleware 后带入已知问题。

**建议修复**：

- 升级 Hono 到已修复版本。
- 升级后运行类型检查、自检，并至少启动一次真实 Wrangler dev 验证 Worker boot。
- 避免直接执行未审核的批量 `npm audit fix`。

## 三、通过项与正面证据

以下项目在本次审计中通过：

- `npm run typecheck` 通过。
- `scripts/accessjwt-selftest.mjs`：14 项通过、0 失败。
- `scripts/guard-design.mjs`：9 项通过、0 失败。
- 匿名访问 `https://crm.airsonde.com/` 返回 302，并进入 Cloudflare Access。
- `https://link.airsonde.net/` 根路径返回 404，未直接暴露后台首页。
- `workers_dev` 已关闭。
- `assets.run_worker_first` 已开启，静态后台资源会先经过 Worker 中间件。
- Wrangler 已启用 `nodejs_compat` 和 Workers Logs。
- 审计取证时，本地 `master` 与 `origin/master` 一致且工作树干净；报告生成后工作区出现了其它并行改动，不属于本次审计报告写入。
- 线上登录态主页、待办页和数据看板能够加载，检查期间浏览器控制台未观察到错误或警告。

## 四、测试覆盖缺口

当前 `npm run typecheck` 只执行：

- `guard:tsc`
- `guard:cadence`
- `tsc --noEmit`

以下已有自检没有进入部署闸：

- `scripts/accessjwt-selftest.mjs`
- `scripts/guard-design.mjs`
- `scripts/inbound-selftest.mjs`（需要受控运行环境）

项目也没有观察到基于 `@cloudflare/vitest-pool-workers` 的运行时测试。类型检查无法覆盖 Worker boot、路由鉴权、D1 行为、HTML 注入和真实运行时限制。

建议至少补齐：

1. 鉴权中间件集成测试：无票、伪造 email 头、错误 AUD、过期票、合法票。
2. 孤儿回复渲染 XSS 回归测试。
3. 看板统一口径固定数据集测试。
4. 公网端点超限请求测试。
5. Wrangler 运行时 boot smoke test。

## 五、建议给修复执行者的验收清单

- [ ] 孤儿回复中的任意发件地址都不会进入内联 JavaScript。
- [ ] 伪造 `cf-access-authenticated-user-email` 且无合法 JWT 的请求返回 401/403。
- [ ] AirSonde AUD 配置错误或缺失时 fail-closed。
- [ ] Access JWT 自检已进入部署闸。
- [ ] 同一固定数据集下，顶部、周图、回信构成和成本使用清楚且一致的口径。
- [ ] 自动回执、测试数据和孤儿回复的排除/展示规则有自动化测试。
- [ ] 三个公网 POST 入口对超限 body 返回 413，且不触发后续副作用。
- [ ] 脏工作树无法执行正式部署。
- [ ] 线上版本戳与目标 Git SHA 完全一致且不含 `+dirty`。
- [ ] Hono 已升级并完成 Worker boot 验证。

## 六、最终评价

项目在发送护栏、压制名单、部署前类型检查、公开域隔离和运行状态可见性方面已有较强的工程意识。当前最需要优先处理的不是业务功能，而是两个边界问题：**外部邮件数据进入内联 JavaScript**，以及**写好的 JWT 验签器没有真正成为鉴权判据**。这两项修复后，再统一看板数据口径与发布可追溯性，项目的安全性和可审计性会明显提升。
