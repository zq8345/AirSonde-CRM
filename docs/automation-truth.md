# 自动化全链路：流程 · 开关 · 限额（真相表）

> 口径时点：**2026-09-05，commit `a166803`**（总开关补闸之后）。
> ⚠️ 行号会漂，**以函数名为准**，行号只作路标。
> ⚠️ 这份表的用途是"照着代码回答问题"，⛔ 不是设计稿 —— 与代码不一致时**以代码为准，并回来改这份表**。

---

## 0. 两条班次（这是理解一切的前提）

机器只有两条自动班次，别的都是人点的：

| 班次 | cron | 入口 | 总开关闸 | 干什么 |
|---|---|---|---|---|
| **快班 fastTick** | `* * * * *`（每分钟） | `index.ts fastTick()` | ✅ **函数顶部 `return`**（`automationEnabled`，约 5207） | 分析 · 自动批准 · 熔断评估 · 找客户 · **发新开发信** |
| **整点班 scheduled** | `0 * * * *`（每小时） | `index.ts scheduled()` | ⚠️ **没有顶部闸**，改为**四步各自加闸**（`autoOn`，约 5443 起） | 收回复 · 目录源 · 分析 · 自动批准 · 补邮箱 · 熔断评估 · **发跟进信** · 简报告警 |

🔴 **为什么整点班不能在顶部 return**：Joe 定的语义是「**关的是机器的嘴和手，不关耳朵**」
（设置页卡五卡头副标就是这七个字）。顶部 return 会把 **step 0 收客户回复** 和 **step 4 告警** 一起停掉 ——
关一次总开关等于"客户回信也不收了、机器坏了也不吼了"，那是这个开关从没承诺过的事。

---

## 1. 流程表

| # | 环节 | 触发 | 取数条件（真源） | 写什么 | 受哪些闸 | 代码出处 |
|---|---|---|---|---|---|---|
| 1 | **找客户** | 快班，每分钟 | 关键词 × 国家 的组合，游标 `discovery_cursor` 平铺推进；关键词按 `lang` 决定国家组 | 新 `leads`（去重后），`source='search'` | 总开关 · `serper_daily_budget`（用完停到次日 UTC）· `TICK_DISCOVER_MAX=25` 组合/tick | `discover.ts runDiscovery()`；调用点 `index.ts:5262` |
| 1b | **目录源** | 整点班，仅 0/6/12/18 | 免费目录（NMEA / rvwithtito），内部自判 >7 天才真跑 | 新 `leads` | **总开关**（本次新加）· `directory_autorefresh_enabled` · `directorySourcesEnabled()`（⚠️ 当前恒 false，这一步事实上是惰的） | `discover.ts runDirectoryRefresh()`；调用点 `index.ts:1.5 步` |
| 2 | **分析打分** | 快班（`TICK_ANALYZE_MAX=3`/分钟，并发 `ANALYZE_CONCURRENCY=3`）+ 整点班（`CRON_ANALYZE_MAX=12`/班） | `status='new'`，本轮已试过的 id 排除 | `lead_analysis`（分数/分类/理由/`analyzed_at`）；`leads.status` **只从 `new` → `analyzed`** | 总开关（两条班次都有）· 时间预算 · `FETCH_FAIL_MAX=3` | `service.ts analyzeLead()`；`index.ts analyzePending():4994`、`:5229`、`:5498` |
| 2b | **抓不到官网** | 同上 | 正文 < `MIN_USABLE_TEXT=200` 字 | `fetch_fail_count+1`；满 3 次转 `analyzed` 且 `match_score=NULL`（**未打分 ≠ 不合格**） | — | `service.ts recordFetchFailure():65` |
| 3 | **自动批准** | 快班 + 整点班 | `status='analyzed'` ∧ `match_score >= auto_approve_min`（默认 **60**）∧ 未与已发线索同邮箱 | `status='approved'` | 总开关（`autoApproveEnabled` 内含）· `auto_approve_enabled` | `index.ts autoApproveRound():5054` |
| 4 | **发新开发信** | **只在快班** | `SENDABLE_WHERE`：`status='approved'` ∧ `match_score>=60` ∧ 有邮箱 ∧ 未压制 ∧ 未重地址 | `emails`(kind=`initial`) · `status='sent'` | 总开关 · **机器自己发** · 熔断 · 每封间隔 · 日限 · 自动通道单独限量 · `TICK_SEND_MAX=3`/tick | `send.ts sendApprovedBatch():835`；`SENDABLE_WHERE index.ts:476`；调用点 `:5303` |
| 5 | **发跟进信** | **只在整点班** | `status='sent'` ∧ 有邮箱 ∧ **有已发出的 emails 行** ∧ `sent_count <= followup_max` ∧ 距上次发信 ≥ 冷却天数 | `emails`(kind=`followup`) | **总开关（本次新加）** · `followup_enabled` · 日限 ⛔ **不看分数、不看「机器自己发」、不看熔断、⚠️ 没有每封间隔** | `send.ts sendFollowupBatch():754`；调用点 `index.ts` 3.5 步 |
| 6 | **补邮箱** | 整点班 | `email` 空 ∧ 有官网 ∧ `status IN ('approved','analyzed')`，每轮 ≤ `find_email_per_round`(20) | `leads.email` | **总开关（本次新加）** · `find_email_enabled` · 时间预算 ⛔ 硬编码不走 Hunter（不给"配置一改就烧积分"的口子） | `index.ts` 2.55 步 |
| 7 | **收客户回复** | 整点班 **step 0（最前）** | IMAP 拉取 | `replies` · `leads.status='replied'` | ⛔ **不受总开关约束**（耳朵）· 需要 `LARK_IMAP_PASS` | `index.ts` step 0 |
| 7b | **官网询盘** | 访客提交，实时 | `POST /api/inbound` | 落 `status='replied'` + 一条 `replies`(`source='inbound'`) | ⛔ 结构上进不了发信池（`SENDABLE_WHERE` 要 `approved`） | `index.ts /api/inbound:约 4435` |
| 8 | **退订** | 收件人点邮件里的退订链接（`POST /u/:token`，RFC 8058 一键退订 + GET 页面）——⚠️ **公开路由，不走 Access**（合规必须） | `unsubscribe_token` | `leads.status='unsubscribed'` + 压制名单。⚠️ **退订没有独立的表**，真源就是 `leads.status`（`index.ts:1214` 明写过，有人写过 `FROM unsubscribes` 那个不存在的表） | — | `index.ts:2978 app.post("/u/:token")` → `unsubscribeByToken()`；公开豁免 `index.ts:237` |
| 8b | **退信 / 投诉** | Resend webhook（`/api/webhooks/*`，自带签名校验，公开） | 事件类型 | 压制名单（`bounced` / `complaint`）+ 对应状态 | — | `webhook.ts:129`、`:135` `addSuppressedEmail()` |
| 9 | **熔断评估** | 快班（发信前）+ 整点班 | 最近 `BREAKER_WINDOW=30` 封**自动发出的初次信**里退订占比 ≥ `BREAKER_THRESHOLD=0.15` | `auto_send_tripped_at` + `auto_send_trip_reason` | 幂等（已熔断直接返回）；⛔ **只写自己那格，不去掀 `auto_send_enabled`** | `send.ts:482-`；`index.ts evaluateSendBreaker():5179` |
| 10 | **简报 / 告警** | 整点班 step 4 | — | 飞书推送 | ⛔ **不受总开关约束**（机器坏了要吼） | `index.ts` 4 步 · `notify.ts` |

---

## 2. 开关与限额真相表

⚠️ **「实际管到哪一步」这一列才是重点** —— 今天所有的坑都长在"名字比它管得宽"上。

| 界面叫什么 | 键 | **实际管什么** | **⛔ 管不到什么** | 代码出处 |
|---|---|---|---|---|
| **自动模式**（卡一右上） | `automation_enabled` | **出站全停**：快班整条（顶部 return）+ 整点班四步（目录源/分析/补邮箱/**跟进**） | **收客户回复**、**告警/简报**、Joe 手点的任何动作 | `send.ts automationEnabled()`；`index.ts:5207` + `scheduled()` 里的 `autoOn` |
| **机器自己发** | `auto_send_enabled` | **只停"自动发新开发信"这一步** | ⚠️ **跟进信照发** · 分析/批准/找客户照跑 · 手动「发选中」照发 | `send.ts autoSendEnabled():102`（⚠️ 它同时含总开关与熔断两条） |
| **无回复跟进** | `followup_enabled` | 跟进链的**唯一**专属开关 | 不影响初次开发信 | `send.ts sendFollowupBatch():755` |
| **退订就停**（熔断） | `auto_send_tripped_at` | 停自动发**新开发信** | ⚠️ **跟进照发** · 分析/批准照跑 · 要人手动复位，⛔ 不会自动恢复 | `send.ts autoSendTripped():98` |
| **每天最多发** | `daily_send_limit` | 全系统总闸：**手动 + 自动 + 跟进 + 事务信共用**，跨全部发件域 | — | `send.ts systemDailySendLimit()` |
| **自动通道单独限量** | `auto_send_daily_limit` | 只约束"自动发的初次信"（与总闸取更紧者） | ⚠️ **跟进不占这个配额**（`sendFollowup` 不写 `auto_sent`） | `send.ts autoSendDailyLimit()`；`index.ts:5297` |
| **每封间隔** | `send_interval_seconds`（默认 90） | ⚠️ **只管快班的初次信**，且**闸每 tick 只查一次、在批之前** ⇒ 它隔开的是**批**不是**封**（一批最多 `TICK_SEND_MAX=3`） | ⛔ **完全不管跟进信** | `index.ts:5277-5294` |
| **新域保护** | `send_ramp_enabled` | 每日实际上限 = max(起步, 昨日发出量 × 倍数) | — | `send.ts systemDailySendLimit()` |
| **搜索预算** | `serper_daily_budget` | 每搜一次即记账，用完停到次日 UTC | — | `discover.ts runDiscovery()` |
| **重扫闸** | — | `/api/rescan/start` 在 `auto_send_enabled` 开着时**拒绝启动** | ⚠️ 它防的是"`approved/queued` 被打回 `new` 再升过 60 分线被立刻发出去"，**不是防已联系那批** | `index.ts:4557`（另有 `rescoreLowGate` 同时查自动批准） |

---

## 3. 机制检查（⛔ 只报不修）

按"名不副实 / 无人看守 / 互相打架"分类。已修的列出来是为了让下一个人知道**病型**，不是邀功。

### A. 名不副实（今天修掉的三条 —— 病型记住）
1. ~~开关文案列举"什么不受影响"却**漏掉跟进**~~ → 已修（`87df752`）。**病型：漏列举 = 反向断言。**
2. ~~整点班日志说"跟进会照此跳过"，而代码从没这么做~~ → 已修。**病型：日志说了代码没做的事。**
3. ~~`followupTruth()` 写完没有调用点~~ → 已修（复活并接线）。**病型：唯一说真话的那句从没渲染过。**

### B. 无人看守 / 潜伏
4. 🔴 **`confirm()` 原生弹窗**（`index.html applyAutomation` 约 5635）——
   全仓其它对外动作一律走 `uiConfirm`（`applyAutoSend`、`mrResumeAutoSend` 都是），
   **唯独总开关这个最重的动作用了原生 `confirm`**。⚠️ 它还会被浏览器"阻止弹窗"策略静默吞掉 ⇒
   最坏形态：**Joe 以为自己点开了，实际没开**（或反过来）。
5. 🔴 **跟进链没有每封间隔**（见 §2「每封间隔」行）。实测：3 封在**同一秒**发出。
   ⇒ 总开关关得越久，重开那一刻放得越多：`sendFollowupBatch` 一个 tick 取走的是**当日全部剩余额度**
   （`take = min(requested, dailyLimit - coldUsed)`，而 cron 传进去的 `requested` 就是那个剩余额度）。
   生产 `daily_send_limit=1000` ⇒ 理论上一个整点班可以一次放出上百封。
   ⚠️ **本单奉命不改间隔语义**，此条留给「间隔改成真·每封间隔」那一单。
6. **重扫停摆告警看不见重扫**：`produced = !!(inserted||analyzed||…)` ——
   重扫死了而 cron 照常分析 ⇒ `produced` 为真 ⇒ **永不告警**。
   反向验收用例现成的：2026-09-05 06:13→06:53 那 40 分钟。（`index.ts` 简报那段）
7. **`drainRescan` 零重试**：`index.html` 的重扫循环一次 fetch 失败就 `return` 退出整个 while
   ⇒ 一次网络抖动杀掉一场 5 小时跑批（09-05 已发生一次）。
8. **`/api/settings/search` 的回显少了 `!BLACKLIST_GL.has(x)`** ⇒ 有人把黑名单国家码加进 `COUNTRIES` 时，
   界面会出现"能勾但机器不搜"的假勾。

### C. 互相打架 / 口径分叉
9. **`autoSendEnabled()` 一个函数含三种语义**（总开关 / 熔断 / 小开关各自为假都返回 false）——
   凡是拿它的返回值去**解释原因**的地方都必须自己分叉，否则必说错话
   （今天整点班那句日志就是这么错的，已在 `a166803` 里改成分叉）。
   ⇒ **判据：任何新增的"为什么没在发"的文案，都要问一句"这三种来路它分得开吗"。**
10. **`sent_today_breakdown` 后端一直在返回、前端从没消费过**（本次才接上跟进那一格）。
    ⚠️ 它**没有失败计数** ⇒ ⛔ 谁都不许拿它去说"没失败 ⇒ 它没坏"。

---

## 4. 给下一个人的三条规矩

1. 🔴 **往整点班加任何出站步骤，必须自己加 `autoOn` 闸。**
   现在的形状是"一次读 + 四处显式闸"，⛔ 它不会自动罩住新步骤。
   （理想形状是把四步包进一个 if 块，没做是因为要重排约 185 行缩进、会淹掉行为改动本身。
   哪天有人重构这一段，**顺手包起来**。）
2. **改开关文案前先问：这句话列举了什么？漏掉的那一项是不是正好还在跑？**
3. **`autoSendEnabled()` 为假有三种来路** —— 拿它写给人看的句子，先分叉再写。
