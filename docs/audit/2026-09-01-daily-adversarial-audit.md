# AirSonde-CRM 2026-09-01 全天交付对抗性审计（AU-CRM-2）

**派单**：总工（documents-75）· 消息通道（派单目录无正本，惯例记录）
**执行**：AirSonde-审计窗 · 全程只读（未改代码/未 deploy/生产 D1 只 SELECT 且摘 token/未发信）
**基线**：`1825917a`（8-31 22:24）→ 本地 master `b166156`，**26 个 commit，+2781/−513，17 文件**
⚠️ **对账事实**：origin/master 只含其中 2 个 commit——**24 个已提交未推送**；生产今天发信 97+ 封，跑的必然是未推送代码的 deploy ⇒ **git push 落后于生产部署**（见 🟡Y6）。
**测量时段**：2026-09-01 16:1x–17:0x UTC（生产为移动靶：审计中机器每分钟在跑，读数均带时刻）。

---

## 执行摘要（≤10 行）

1. 八个新端点**零匿名面**（生产双域实测：crm 全 302 进 Access，link 全 404）。
2. fastTick **没有绕闸**：发送走 sendApprovedBatch 唯一咽喉，逐闸行号核对齐全；生产实况**冷发 100 封=爬坡 effective(地板 100)顶满即停**——闸精确工作的活证据。
3. 但 fastTick 有**三条并发缝**：tick 预算(13min) > 锁过期(5min)；整点 fastTick 与整点班并发（tick_lock 不覆盖后者）；analyzePending 无原子认领 ⇒ 重复打分双花 AI。
4. `Too many subrequests` 失败 23 封全部落在 12–13 时（fastTick 上线前）；上线后**零复发**（生产按小时分布实证）。
5. AU-CRM-1 的 R1 **确认已修**且修法优于建议（automation_enabled 总开关 + 迁移回落读旧键默认 0 + 熔断态与意图分键正交）。
6. 铁律五反扫：6 个量已单源（含 Serper 单展示位）；**4 处仍散装**，含已知 372/276（本审计补全机制：左栏在前端拿 byStatus 自算，而后端 unscoredShow 正确口径已返回却没人用——一行修复）。
7. 生产不变量实测 **0 违反**（approved ⇒ score≥60 ∨ human_approved），C5-33 钩子在生产活着；queued 滞留 0。
8. 部署闸物理化验真：wrangler `build.command` 层面，换任何命令都绕不开——修法漂亮。
9. index.html 239KB 内联 JS 语法过；**11 个疑似零引用函数**（多为已废看板/旧今天页残留）。
10. **总评 B+**。明早前三件：①fastTick 并发缝合 ②左栏待分析一行改用 unscoredShow ③sendable 收敛单源并给机器房那处改名。

---

# 分级发现

## 🟡 Y1 — fastTick 并发缝三条（同根：新路径的互斥假设未闭合）【已实测/代码核】

| 缝 | 证据 | 后果 |
|---|---|---|
| a. tick 预算 > 锁过期 | `fastTick` 用 `new RoundBudget(now)` 默认 **13 min**（pool.ts `ROUND_BUDGET_MS`），而 `TICK_LOCK_STALE_MS = 5 min`（index.ts:3929）。慢 AI（超时重试）可把一个 tick 拖过 5 min，锁被判过期，下一 tick 并发进入 | 并发 tick：发送侧有原子取批兜底（send.ts:854），**分析侧无**（见 c） |
| b. 整点双跑 | crons = `["* * * * *","0 * * * *"]`；调度器 `if cron==="* * * * *" return fastTick`（index.ts:4576）。**每逢整点两个事件并发**，整点班不看 `tick_lock`（全仓仅 fastTick 引用它） | 同一分钟内 analyzePending×2、sendApprovedBatch×2 并发；发送重叠由原子取批挡（超发上限 ≤ tick 的 take=3），分析重叠不挡 |
| c. analyzePending 无认领 | index.ts:3852-3856：`SELECT … WHERE status='new' … LIMIT`，无 `UPDATE…WHERE status='new'` 式抢占（对比 send 的 claim）；status 到 analyzeLead 成功后才推进（service.ts:105） | 并发双方取到**同一批 new** ⇒ 同一线索被打分两次 = **AI 双花**（每次整点最多 3 条、a 缝触发时更多）。C5-11 的"不重复花钱"针对的是单调用内并发，未覆盖跨调用 |
| （附）传参死代码 | fastTick 传 `{concurrency: ANALYZE_CONCURRENCY}`（3972）但 analyzePending **未使用** opts.concurrency（3839-3882 为串行 for 循环） | 误导后续读者以为已并行 |

**建议**：tick 的 budget 显式传 total≈50s（对齐分钟节奏，锁过期永不早于预算）；fastTick 在 `minute==0` 时让位（一行）；analyzePending 加 `status='new'→'analyzing'` 原子认领或复用 tried 思路落库。

## 🟡 Y2 — 铁律五仍散装清单（核心交付物，见下表"仍散装"节）【代码核，行号齐】

最重的两条：
- **左栏「待分析」自算错口径**（已知 372/276，本审计补全机制）：`public/index.html:1536-1537` 用 `/api/stats.byStatus` 做 `new→unscored, analyzed→review` 整组映射——**byStatus 无分数信息，结构上拆不开** analyzed-无分（应计入待分析）；而 `/api/stats` **已返回**正确口径 `unscoredShow`（index.ts:461-463，UNSCORED_SHOW_WHERE），前端没用。⇒ 修复 = 徽章改读 `s.unscoredShow`，一行。
- **`sendable` 同名不同义**：`getBacklog`（index.ts:348）、`/api/today`（1610）两处同文 SQL（approved+≥60+有邮箱+未压制）；**机器房 `pool.sendable`（627）少了分数与压制过滤**（approved+有邮箱）——同一个词，两页两个数。另：三处均不含 `OR human_approved=1`，而发送谓词含 ⇒ Joe 亲手放行的低分线索**真实可发但不被计数**（C5-33 之后该形态合法存在）。

## 🟡 Y3 — 熔断评估节奏与发送节奏脱节【代码核】

发送已提频到每分钟（fastTick），但退订率评估仍只在整点班跑（getBreakerStatus 调用点唯一，index.ts:4318）。`autoSendEnabled()` 每 tick 查 `auto_send_tripped_at` ✓——但**写**它的人一小时才醒一次。最坏敞口：整点后立刻越过 15% 阈值，继续发到下一个整点才跳闸（受日限/间隔约束，当前地板 100 下最多几十封）。
**建议**：fastTick 发送分支前廉价复用 `getBreakerStatus`（纯 D1，无 fetch），或每 N tick 一查。

## 🟡 Y4 — 今日 24 封失败无任何人看见的出口【已实测】

生产今日 failed=24（23×`platform:subrequest-limit`、1×OpenRouter 空内容），**全部落在 12–13 时**=fastTick 上线前的整点班事故（与 fastTick 注释里"13:00 那轮"互证）；上线后零复发 ✓。但这 24 封对应的 24 条线索已被 sendApprovedBatch 退回 approved 等重发——**待办/今天页没有"今天有 X 封没发出去"的条目**（failedTodayBreakdown 存在但我在 /api/today 的 alerts 里未见消费——待验：登录后台看今天页是否显示）。橙灯修复(0588f20)管的是"此刻受阻"，不管"今天损失了多少"。

## 🟡 Y5 — `TICK_FETCH_BUDGET_ASSUMED = 800` 是假定值在岗【代码自认】

index.ts:3933-3937 诚实标注"1000 是假定：实测只有免费档=50、付费档≥200（探针上限）"。诚实 ✓，但每分钟真跑的东西押在一个没量过的数上。**建议**：把探针上限从 200 逐级提到 800+ 实测一次（探针端点已有，登录后跑，零风险），把"假定"变"已测"。

## 🟡 Y6 — 24 个 commit 已 deploy 未 push【已实测】

生产跑的代码在 origin 上不存在。机器 push 落后 deploy 一整天 ⇒ 任何依赖 GitHub 的对账（跨窗审读、回滚参照、CI）都在看旧代码。**建议**：deploy 脚本尾部提醒或每日收工 push 纪律。

## 🔵 观察（不判修）

1. `emails` 表 `MAX(sent_at)` 间隔判据含手动/事务信（send.ts gap 查询无 kind 过滤）——手动发一封会顺延自动 tick 的 90s 间隔，偏保守方向，无害。
2. `APPROVE_MIN_SCORE` 双常量（index.ts:361 vs service.ts SVC）有启动期断言但仅 console.error 不停服——半道闸。
3. bulk-status 可把 `queued`（发送途中）置 ignored；sendLead 成功后 `SET status='sent'` 无状态守卫（send.ts:642）会盖回——竞态窗口极窄且信已发出，仅语义瑕疵。
4. index.html 疑似零引用函数 11 个：`funnelBars/trendSVG/todaySection/todayItem/channelsHtml/channelsInline/actionPanelHtml/detailScoreBorder/emailSubjectOf/followupTruth/wireDropdown`（启发式：全文引用计数≤1；其中 funnel/trend/today* 与已删除的数据看板及旧今天页对应。⚠️ 动态调用会误报，删前逐个确认）。
5. 今日实发节奏：14 时 29 封 / 15 时 9 封 / 16 时 61 封——90s 间隔下理论 ≤40/时，16 时的 61 封说明**间隔闸在部分路径未生效或手动批量参与**（gap 闸只在 fastTick；整点班与手动批量无间隔约束——设计如此，非缺陷，记录节奏形态供 Joe 判断域名信誉风险）。
6. 生产 `automation_enabled` 键不存在 → 走迁移回落（旧键 1/1 = 开）——与设计一致；Joe 一动新开关即定格。

---

# 通过项（对抗性验证，全部有证据）

| 项 | 方法与结果 |
|---|---|
| A 新端点鉴权 | 8 端点行号均在 auth 中间件(180)之后、中间件前零路由；生产实测 crm 全 302（Access 三信号）/link 全 404 |
| B 逐闸 | 日限+爬坡（send.ts systemDailySendLimit 唯一咽喉）→ 自动通道限（autoSendDailyLimit）→ 断路器态（autoSendEnabled 每 tick 查 tripped）→ 压制（deliverEmail 首行）→ 双幂等（lead_id+邮箱级）→ auto_sent 记账（INSERT 带 autoSent）→ 90s 间隔（真源=emails.MAX(sent_at)）——**一个不缺**，fastTick 只改触发节奏未改闸 |
| B 生产活证 | 昨日冷发 0 ⇒ effective=max(地板100,0)=100；今日冷发**恰好 100 封停**（78 auto+22 手动）——闸打满即停实测 |
| AU-CRM-1 R1 | 已修：automation_enabled 总开关默认 fail-closed（空→读旧键默认"0"）；熔断态/意图分键，整点班 4193/4319/4337 全换新函数 |
| 子请求事故 | 失败 23 封全在 12-13 时；14 时后零复发（按小时分布实测） |
| D 状态机 | 15 处写点全清点：rescan 只重置 new/analyzed/approved/queued/pending（**ignored 不会被重分析**）；C5-33 钩子边界精确（只降 approved、human_approved 与 queued/sent 不碰）；生产不变量 **0 违反**；bulk 端点 M3b 终态护栏+approveGate 在岗 |
| E | 239KB 内联 JS `node --check` 通过 |
| F 闸自证 | guard-design 自检 6/6（含真实事故样本）；guard-cadence 通过（已适配双 cron）；部署闸物理化=wrangler build.command 实读；今天页渲染串禁词静态复核：命中全为注释或机器房豁免区 |
| H 三修 | 橙灯=「此刻仍成立」三条件（diff 核）✓；设置页+方向盘双入口加载失败横幅（923/1052）✓；sending 并行化=2×Promise.all+loadSettings 单查（2034/2054）✓ |
| G 资源 | 空转 tick ≈15-25 次 D1 读/分钟（≤3.6 万/天，付费档量级无虞）；出站 fetch 空转=0；每步预算门 budget.has() 在岗 |

## 铁律五清点表（C 维度核心交付）

| 业务量 | 已单源？ | 位置 |
|---|---|---|
| 今日已发/构成 | ✅ sentToday/sentTodayBreakdown 咽喉 | send.ts |
| 日限/爬坡 | ✅ systemDailySendLimit 唯一咽喉 | send.ts |
| 发不出的原因 | ✅ autoSendBlockedReason 单函数，前后端共用 | send.ts |
| 机器活动 | ✅ activity.ts + /api/activity | aa97bcb/cf65fc1 |
| Serper 用量展示 | ✅ 全站单展示位（机器房），代码明注铁律五 | index.html openMachineRoom |
| 60 分线 | 🟨 approveGateReason 单真源，但常量双份（断言仅打日志） | index.ts:361 |
| **待分析数** | ❌ 左栏前端自算(byStatus) vs 后端 unscoredShow/getBacklog——**372/276 根因** | index.html:1536 vs index.ts:463 |
| **sendable** | ❌ 三处同文 SQL + 机器房同名异义 + 均缺 human_approved 支 | index.ts:348/1610/627 |

---

# 覆盖率表

| 审了 | 怎么审 |
|---|---|
| A/B/D/F/H 全部、C/E/G 主体 | 26 commit diff 全读关键文件；生产双域 11 个零副作用探针；生产 D1 只读 7 批查询；闸脚本本地实跑；死代码启发式扫描 |

| 没审到 | 原因/待验方法 |
|---|---|
| 登录态 UI（今天页渲染字数、Y4 的"失败是否可见"、设置页两态实操、详情页三态） | Access 门后。**待验清单给总工**：①今天页是否显示今日 failed=24；②零数据态字数复量（宪法要求生产复量仍欠着）；③设置页编辑态并发保存 |
| fastTick 并发缝的**实证复现**（Y1 是代码推理） | 需受控环境压慢 AI 调用；本地可复现但耗时，未做 |
| 30+ 工单逐单验收 | 只按总工大事记抽审了架构面；未逐工单对照验收标准 |
| C5-13 新 8 类分类的语义质量、重刷未跑的影响面 | 数据侧未审（重刷未跑=存量 customer_category 仍旧轴，已在途） |
| Hunter 三重闸（53a4d4e） | 只确认闸存在未逐条核（钥匙未配，路径 fail-closed 兜底） |
| index.html 死代码的动态调用误报排除 | 启发式，删除前需逐个人工确认 |

---

# 总评：**B+**

无 🔴。今天的交付质量高：闸的修法普遍"物理化/单源化/正交化"（部署闸进 build.command、意图与熔断分键、活动单真源），生产实况三项活证（爬坡顶满即停、不变量 0 违反、子请求事故零复发）。扣分集中在：**fastTick 这个"每分钟真跑"的新心脏，其互斥与节奏假设（锁、整点、熔断评估、fetch 预算）有四处未闭合**——都是新结构一天内的正常毛边，但它们恰好都长在最不可逆的路径旁边。

## 明早最该修的三件
1. **fastTick 并发缝合**（Y1 三条一起：budget 对齐 50s + 整点让位一行 + analyze 原子认领）——每分钟跑的东西，互斥必须是闭合的
2. **左栏待分析改读 `unscoredShow`**（一行，消掉 Joe 每天看见的 372/276 分裂）
3. **sendable 单源化**（SQL 收进一个函数；机器房那处改名 `pool_with_email` 或补齐过滤；补 human_approved 支）

---

*双源比对预告：另一名后台审计员报告到达后，分歧点清单由总工转回本窗比对。本报告全部断言标注：生产实测/代码核（行号）/待验三类。*
