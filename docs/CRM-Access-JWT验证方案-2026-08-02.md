# CRM 验 Access JWT —— 方案（2026-08-02，未写码）

> 目标（Joe 原话）：**「我在 Cloudflare Access 里加的账号就是我认为该登录的账号」** ⇒ 验过 JWT 之后，
> **Access 策略是唯一权威**，代码里不再有第二张名单、也不再盲信一个 HTTP 头。

---

## 〇、先修正派单里两个前提（都是实测，不是推理）

### ① 团队域**已实测确定** = `wanewgroup.cloudflareaccess.com` —— 不需要靠步骤①去发现

两条**互相独立**的证据指向同一个租户：

```
证据1  生产 302 的目的地：
  curl -D- https://crm.wanew.com/api/leads
  → Location: https://wanewgroup.cloudflareaccess.com/cdn-cgi/access/login/crm.wanew.com?kid=9a9ae044…

证据2  该跳转里 meta JWT 的**签名 kid**，只出现在 wanewgroup 的 JWKS 里：
  meta JWT header.kid = 91dca4c63afa17342d39b7fb13ec663fca15c1f8b281155d67f10cb3afe5033e
  wanewgroup/cdn-cgi/access/certs → 含该 kid  ✅
  wanew     /cdn-cgi/access/certs → 不含      ❌（另一个租户，指纹完全不同）
  tejoy                            → 404（不存在）
```
且登录 URL 的 `kid=` 参数 = 派单给的 **AUD `9a9ae044…`**，与 wanew-crm 对上。

⇒ `iss = https://wanewgroup.cloudflareaccess.com` · `aud = 9a9ae044…`
⚠️ **但步骤① 仍然要做**，理由变了：不是为了发现 iss，是为了观测**票据从哪来**（头 vs cookie）、
以及**真实 claim 长什么样**。这两件事没有真实登录会话就是猜的。

### ② "伪造头今天能进" —— **今天进不去**，三个入口全测了

```
伪造 cf-access-authenticated-user-email: attacker@evil.com
  https://crm.wanew.com/api/leads                 → 302（Access 在边缘就挡了，请求根本到不了 Worker）
  https://wanew-crm.zq8345.workers.dev/api/leads  → 401（走 Basic Auth，adminHosts 里没有 workers.dev）
  https://api.wanew.com/api/leads                 → 404（API_HOST 分支）
```
⇒ **这不是一个"今天可利用"的洞。** 严重度按可利用性算，它现在是**纵深防御缺失**，不是活口子。

**但修法依然成立，理由要换成真的那个**：
> **Worker 自己零验证，安全性 100% 押在边缘行为上** —— 和 H12（`Host: localhost` 免登录）
> 是同一个形状，那条我们已经判过：**不该把认证押在一个我们不控制、且很少被测的平台行为上。**

⚠️ 另外派单说"产品后台至少还有白名单，你这里是带上头就是管理员" —— 结论对，但**范围要收窄**：
`admin.tejoy.com` 在到达那段代码**之前就被 301 走了**（实测 301 → crm.wanew.com），
所以真正走这条分支的**只有 `crm.wanew.com` 一个域名**。改动面比看起来小。

---

## 一、🔴 我认为真正更该先处理的是 **Basic Auth 兜底**，不是那个头

```
workers.dev 主机 → 不在 Access 后面 → 公网可达 → 只有 ADMIN_PASSWORD 一道口令
                → 通向：全部客户数据 + 发信能力 + 所有后台 API
```
它**不是"第二道闸门"（Joe 讨厌的那种），而是"绕过第一道闸门的旁路"** —— 性质相反、更危险：
验完 JWT 之后，`crm.wanew.com` 由 Access 策略说了算；而 `workers.dev` 上一个口令仍然能进同一套数据。
**那等于把 Access 变成装饰。**

### 但 workers.dev 不能整个关掉（合规红线）
`APP_URL = https://wanew-crm.zq8345.workers.dev`，已发出的邮件里的退订链接、已在 Resend/Lark 注册的回调都指着它。
好消息：**这些路径在鉴权之前就被豁免了**，与 Basic Auth 无关：
```
/u/*  ·  /api/webhooks/*  ·  /catalog  ·  /api/inbound
```
⇒ **建议：让 workers.dev 与 `api.wanew.com` 同构 —— 非公开路径一律 404，删掉 Basic Auth。**
公开路径一个字节不受影响，后台面从公网消失。

⚠️ 代价：**没有应急入口了**。所以我建议**它单独一批做，排在 JWT 三步之后** ——
不要在同一次改动里既换验证方式、又拆掉应急门。（同 "别一次上强制" 是同一条纪律。）
✅ 已核实：Basic Auth **没有任何机器调用方**（代码里只有中间件自己引用 `basicAuth`）。

---

## 二、三步走（采纳派单的顺序，细化到可执行）

### 步骤①：验签**只观察不拦人**
- 取票据：**`Cf-Access-Jwt-Assertion` 头 与 `CF_Authorization` cookie 都试**（不知道生产实际走哪个，正是要观测的）
- 校验：RS256 签名（JWKS）· `iss` · `aud` · `exp/nbf`
- **无论成败一律 `next()`**；把 `iss / aud / kid / 校验结果 / 失败原因原文 / email claim / 票据来源 / 与旧头是否一致` 打进日志
- ⭐ 多打一条 **"JWT 里的 email 与旧头里的 email 是否相同"** —— 步骤②要换数据源，
  换之前必须证明两者一致，否则②上线当天所有人的身份会悄悄变
- ⇒ **安全性不变、不可能锁人**

### 步骤②：开强制（**等你拿到真实登录日志确认之后**，同一次发版）
- 验签通过 → 放行；`email` **改从 JWT claim 取，不再读头**
- ⚠️ **`/api/me`（`src/index.ts:163`）也读同一个头，必须一起改** ——
  否则"闸门认的人"和"界面显示的人"来自两个源、可能不一致。**一条规则，不留特例。**

### 步骤③：真人各登一次确认（Joe + 同事）

---

## 三、技术要点（三条会咬人的）

### 1) JWKS 拉取是**外部子请求** —— 这个仓刚为它打过一周
每个请求都拉一次 = 每个后台请求 +1 子请求（免费版单次 50）。
⇒ **模块级缓存 + TTL 1h + 只有遇到未知 kid 才回源**。冷 isolate 最多 1 次。

### 2) 失败必须**三态**，不能二态
| 情况 | 返回 | 理由 |
|---|---|---|
| 票据有效 | 放行 | |
| 票据存在但无效（签名/aud/iss/过期） | **403** | 你无权 |
| **验不了**（JWKS 拉不到且无缓存） | **503 + 明确文案** | **"我现在验不了" ≠ "你无权"** |
⇒ 这正是这两天定下的那条：**两种看起来一样的失败，要求相反的动作，就必须说不同的话。**
（把第三种塞进 403，排查的人会去查 Access 策略，而真正的原因在网络。）

### 3) ⛔ 我**不建议**加"运行时关闭强制"的开关
听起来是防锁人的保险，实际是**再造一个 `DEV_BYPASS_AUTH`** —— 我们上一批刚把它从 fail-open 改成 fail-closed，
理由是「一个被误配的后门，应该让服务停，而不是让服务安静地敞着」。
**回滚手段用重新部署上一版**（部署在你手上，很快）。
⚠️ 而且真要说锁人风险：JWT 验证**不是第二道闸**，它是在核验第一道闸的签名 ——
Access 放进来的人，票据必然验得过。唯一的锁人场景是**我们自己写错**，那该修/回滚，不该留后门。

---

## 四、验收判据（含对派单的一处修正）

| # | 判据 | 备注 |
|---|---|---|
| ① | 伪造头直打 → **②之后 403** | ⚠️ 派单写"今天能进"，**实测今天是 302/401/404**。所以这条的正确说法是：**②之后即使票据能到达 Worker 也必须 403**，要在能到达 Worker 的入口上测（本地 `wrangler dev` 或 workers.dev 带正确 Basic Auth 时） |
| ② | 真实登录 → 200，且日志里 `email` 来自 **JWT claim** | |
| ③ | `aud` 换成别的值 → **403** | 证明 aud 真在验（不是只验签名） |
| ④ | `iss` 换成 `wanew.cloudflareaccess.com` 的公钥 → **403** | 证明 iss 真在验 —— **两个租户都真实存在**，这条不是理论 |
| ⑤ | 过期票据 → **403** | |
| ⑥ | JWKS 断网 + 无缓存 → **503 不是 403** | 三态那条的自验 |
| ⑦ | 步骤①的日志里 **JWT email 与旧头 email 一致** | ②换数据源的前提 |

---

## 五、不做 / 待定

- ❌ 不加任何邮箱白名单（Joe 的要求就是不要第二张名单）
- ❌ 不加运行时旁路开关（见 三.3）
- ❌ 不动 `feat/split-cron-by-minute`（#84 停着）
- ⏸ **Basic Auth 是否删** —— 我建议删，但**单独一批、排在三步之后**；要你拍板
- ⏸ 是否顺便把 `ADMIN_HOST` 里已 301 的 `admin.tejoy.com` 摘掉（它现在到不了那段代码，留着是死配置）

---

## 六、发版纪律（本仓老规矩，照抄）

```
部署走独立 worktree  C:\开发\AI云端获客-deploy (master)，绝不 deploy 开发分支
三步绝不用 ; 串：git merge --no-ff -F <消息文件>  →  git merge-base --is-ancestor 人工看一眼  →  npm run deploy
PowerShell 5.1 没有 &&，条件执行写  A; if ($?) { B }
测闸用 npm run typecheck，永远不用 npm run deploy 去测
```

---

# 七、补充派单的三条 + 两条裁决（2026-08-02 追加，全部已实测）

## ① 凭证位置：照做，且**只记在不在与长度，绝不记值**
①的每条日志必须逐请求记：
```
hasHeader   (Cf-Access-Jwt-Assertion 在不在) + 长度
hasCookie   (CF_Authorization 在不在)        + 长度
both / neither
```
🔴 **绝不记 token / cookie 值 / 签名本身** —— 日志是一个能拿去换身份的东西。
②取凭证时**头与 cookie 都读**（头优先，取不到读 cookie），不押注在①观测到的那一种上：
观测样本再多也只是样本，而两种形态的代价是"所有人 403，包括 Joe"。

## ② `iss` 未验签之前不是证据：**记"谁的钥匙真的签了它"**
做法：按 token 自称的租户先取 JWKS 验一次，**命中即停**；不过再试另一个已知租户；
日志记 **`signedBy`**（真正验过的那个租户）与 `claimedIss`（token 自称的）。
⚠️ 我在〇节已用**生产 302 + meta JWT 的 kid 归属**实测出 `wanewgroup`，但那测的是
**Access 登录跳转的签名**，不是**用户会话票据的签名** —— 严格说是两个东西。
所以这条照做：**以"谁签了用户的票"为准**，我那份证据当先验假设，不当结论。

## ③ 子请求预算：**CRM 与产品后台结构不同，已查清**
```
export default {
  fetch:     (req, env, ctx) => { installDevEgressGuard(env); return app.fetch(req, env, ctx); },
  scheduled: (event, env, ctx) => { installDevEgressGuard(env); return scheduled(event, env, ctx); },
};
```
- **cron 直接调 `scheduled()`，从不经过 `app.fetch`** ⇒ **中间件对 cron 不生效，JWKS fetch 不会吃发信预算。**
- `RoundBudget` / `installFetchMeter` / `meteredDB` **全部只在 `scheduled()` 内**（2952-2959 行，起点 2942）
  ⇒ HTTP 路径**本来就没有预算包装，也没有计量**。产品后台那个"鉴权跑在预算包装里面"的结构，**这个仓没有**。
- 平台的 50 是**每次调用**独立的 ⇒ HTTP 请求有自己的 50，JWKS fetch 花的是它自己的。

⚠️ **但有一个既有的计量污染，JWT 会给它添一点料，先说明白**：
`installFetchMeter()` 包的是 **`globalThis.fetch`，isolate 级且不卸载**，而 `subReset()` 只在 cron 开头调。
⇒ **HTTP 请求若与某次 cron 并发跑在同一个 isolate，它的 fetch 会被计进那一轮 cron 的 `ext`。**
**平台真实花费不受影响（预算按调用分），受影响的只有我们的读数。** 这是既有问题，不是 JWT 引入的；
JWKS 有缓存后每请求约 0 次 fetch，增量极小。**记在这里，免得下次看到 ext 多 1 又去查错方向。**

⇒ ①的日志记 **`authSubreq`**（本次鉴权真的发了几次 fetch，缓存命中应为 **0**）。
⚠️ 这是**调用点计数**，不是包出口计数 —— 按本仓的老教训，标清楚它数的是什么。

## 两条裁决

### A) 静态资源：**验全量，记日志按白名单**
`wrangler.jsonc` 里 `run_worker_first: true` ⇒ **静态资源也过这个中间件**（原本就是为了让 Basic Auth 能保护静态页）。
⇒ 验证全量做；**日志只记白名单**：`/api/*` 与文档请求（`/` 及 `Accept: text/html` 的导航）。
⚠️ **白名单式，不是黑名单排除扩展名** —— 黑名单漏一个新扩展名就会把噪音放回来，而且不会有人发现。

### B) Basic Auth 兜底：**结论 = 删。** 理由比"兜底口就是后门"更强的四条：
1. **它抵消这次改造本身**：验完 JWT 后 `crm.wanew.com` 由 Access 说了算，
   而 `workers.dev` 上**一个共享口令仍能进同一套数据** ⇒ 本次收益基本归零。
2. **后果面更大**：产品后台那个口通向代码仓；**这个口通向客户 PII + 以 wanew.net 名义对外发信的能力**
   —— 可导出全部线索邮箱、可群发。域名声誉一旦烧掉要几个月养回来（这条本仓已有前科记录）。
3. **它是单因素、无 MFA、无审计、无法按人吊销**（一个共享口令）；Access 那边可按人增删、有登录日志。
   留着它 = 保留一个**永远无法归因**的管理员身份。
4. **实测无机器调用方**：全仓只有中间件自己 `import { basicAuth }`，没有任何脚本/回调依赖它。
   合规路径（`/u/*` `/api/webhooks/*` `/catalog` `/api/inbound`）在鉴权**之前**就豁免，删它们一个字节不受影响。

⚠️ **代价**：没有应急入口。锁人时的自救路径在 Access 侧（Joe 在 Cloudflare 控制台改策略），
不需要在应用里留一个常驻旁路。
⇒ **建议排在 JWT 三步全部验完之后，单独一批** —— 不在同一次改动里既换验证方式又拆应急门。

## 观察期退出判据（先写死，不许"看着差不多"）
```
Joe 在真实浏览器上：≥1 次文档请求 + ≥1 次写请求（两条路径的凭证形态可能不同）
全部满足：verified ∧ audMatch ∧ emailAgrees ∧ 同一 tenant  → 才进 ②
⚠️ 有任何一条 verified=false → 不进 ②，先查为什么
⚠️ emailAgrees=false → 报总工，不自己判哪个对
```

## 最强的一条验收（不省）
```
把 JWKS 换成另一个租户的（wanew ↔ wanewgroup，两份都是真的）→ 必须 403
```
⚠️ 它防的是**"验签写成了只 decode 不 verify"** —— 那种代码在所有正例上表现完全正常，
只有反例能把它揪出来。我们手上正好有两个真租户，是**天然反例源**，没有理由不用。
