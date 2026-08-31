# AirSonde-CRM 全系统独立审计 — 2026-08-31（AU-CRM-1）

**派单**：AU-CRM-1（总工 · Joe 点名）。⚠️ 派单只走了消息通道，`airsonde文件/派单/` 无正本（AU3/4/5 同此，总工已知）。
**执行**：AirSonde-审计窗 · **全程只读**：未改代码、未提交、未部署；生产 D1 只跑 SELECT 且按 runbook §0 在摘掉 `CLOUDFLARE_API_TOKEN` 的进程里跑（已先 `whoami` 验证走 OAuth）；**未触发任何发信（含模拟地址）**。
**使命**：真实外发开始前的最后一道独立闸——验证 ①不会伤害我们 ②按宪法运转。

---

## 审计基线

| 项 | 值 |
|---|---|
| 代码基线 | `0e3b7ba` = origin/master = CRM 窗 HEAD（三者一致，开审时其树干净） |
| 读取方式 | **独立只读 worktree**（detach 在 origin/master，未碰 CRM 窗工作区） |
| 本地实证环境 | 我自己的 wrangler dev（端口 8799、零钥匙、空库、devguard 出站锁开启、`_whoami` 已证进程身份） |
| 生产探针 | crm.airsonde.com / link.airsonde.net 零副作用请求 + D1 远程 SELECT |
| 测量时段 | 2026-08-31 08:20–09:10 UTC 前后 |

---

## 结论摘要

**误发不可能性：当前状态成立，但成立得比想象中薄。** 生产此刻发不出任何信——`emails` 表 0 行、approved 池 0、`auto_send_enabled=0` 显式在库、跟进开关默认关。但整条上游管线（分析→自动批准）**默认全开**，挡在"AI 打 60 分"与"每天 30 封真实冷邮件"之间的，只有 **settings 表里那一行 `auto_send_enabled=0`**——而它的**代码默认值是 "1"**。

| 级别 | 条数 |
|---|---|
| 🔴 必须修 | 1 |
| 🟡 应该修 | 5 |
| ⚪ 建议/知会 | 5 |
| 已在途（不算新发现） | C5-2..5 四页 · MEASURED_SEND_MS 过期回填（runbook §5）· 生产今天页复量 |

---

# 一、🔴 误发不可能性（维度 1）

## 1.1 发信路径全枚举（7 条，逐条验证）

| # | 路径 | 触发方 | 当前可达性 | 证据 |
|---|---|---|---|---|
| P1 | cron 自动批量 `sendApprovedBatch(auto)` | 每小时 cron | **拦住**：`auto_send_enabled=0`（生产 D1 实证）；且 approved 池=0 | D1 SELECT；本地 cron 实测见 1.2 |
| P2 | cron 自动跟进 `sendFollowupBatch` | 每小时 cron | **拦住**：`followup_enabled` 无行→代码默认 **"0"**（fail-closed ✓） | send.ts:598；D1 无该行 |
| P3 | 手动单条 `POST /api/leads/:id/send` | Joe 在后台点 | Access 门后 + 需已批准线索；当前池 0 | 生产 302 三信号实证 |
| P4 | 手动批量 / 跟进选中 | Joe 在后台点 | 同 P3，复用 P1/P2 同一路径（无旁路） | index.ts:1511/1543 |
| P5 | 趁热跟进 `sendWarmFollowupNow` | Joe 在后台点 | 同 P3 | index.ts:1499 |
| P6 | 回信发送（后台 `/api/replies/:id/send` + 飞书卡片 `rsend`） | Joe 点按钮 | 后台侧在 Access 后；**卡片侧生产实测 503「未配 LARK_VERIFICATION_TOKEN（fail-closed）」→ 不可达**；且 `replies` 表 0 行，无卡可点 | 生产 POST 探针；D1 |
| P7 | 询盘确认信 `sendInboundConfirmation` | — | **死代码，无任何调用方**（/api/inbound 已删自动确认信，代码注释 index.ts:2721 写明原因） | 全仓 grep 0 调用 |

⚠️ P1–P6 全部经由 `deliverEmail` 单一出口，其内部：压制名单终极闸 → initial 幂等（lead_id 级 + **邮箱地址级**，堵重复录入）→ Resend。无绕行路径。

## 1.2 本地空转实证（我的实例：零钥匙、空库、出站锁）

手动触发一整轮 cron（`/cdn-cgi/handler/scheduled`），日志逐段：

```
discovery skipped: discovery_enabled=0                    ← 默认关 ✓
directory refresh skipped: 不是目录班次                    ← 且注册表为空（C2-A）
auto-send: 取 0 条 → 发出 0 封（本轮额度 30，自动上限 30/天，全局 30）   ← ⚠️ 见 1.3
subreq: ext=0 …                                           ← 全轮零外部请求 ✓
```

## 1.3 🔴 R1 — `auto_send_enabled` 代码默认值是 "1"：不可逆出站动作的 fail-open 默认

**实测证据（三点闭合）：**
1. 代码：`getSetting(env, "auto_send_enabled", "1")`（index.ts:3419/3434 等 6 处，默认串一致）
2. 本地空库实测：上面那行日志——**没有** `auto-send skipped: auto_send_enabled=0`，auto-send 分支真的跑了（只因池空发出 0 封），本轮额度已按爬坡地板算到 **30**
3. 生产对照：settings 表**恰好有**显式 `auto_send_enabled = 0` 行 → 当前被拦住 ✓

**为什么这是 🔴 而不是"生产已配就算了"：**
- 对照本仓自己的纪律：`followup_enabled` 默认 "0"、`discovery_enabled` 默认 "0"、发信钥匙不配即 fail-closed、`DEV_BYPASS_AUTH` 存在而不满足条件时**宁可 503 停服**。唯独**最不可逆的那个动作**默认是开。
- 保护它的只是**一行可被删除的数据**。这仓刚经历过 C2 系列"清库"；settings 这次幸存是事实，但"清库/重建/换环境必然保留这一行"没有任何结构保证。行没了 = 下一个整点起，机器以 30 封/天起步自动冷发（爬坡地板保证起得来——这个"优点"在这里正好反过来咬人）。
- 上游管线默认全开放大了它：`auto_approve_enabled` 默认也是 "1" 且**生产无显式行 = 此刻活着**（见 🟡 Y1）。今天任何一条被 AI 打到 ≥60 的线索会在整点被自动批准进池。届时与真实外发之间只隔那一行。

**建议改法**：默认串 "1"→"0"（一行）；Joe 要开自动发送本来就走设置页（那条路径会写入显式行，还会顺带写 resumed_at）。改完跑一次本地空转，验证日志出现 `auto-send skipped`。

## 1.4 压制/幂等/熔断/爬坡（算术逐项复核）

| 项 | 复核结果 |
|---|---|
| 压制名单位置 | `deliverEmail` 第一行（终极闸，不依赖可变 status）+ 调用方 `SUPPRESSED_STATUSES` 状态闸 = 双闸 ✓。退订→`addSuppressedEmail(reason='unsubscribe')` 联动 ✓（send.ts:791-799） |
| 幂等 | 三层：lead_id 级 + **邮箱地址级**（堵 #163/#238 型重复录入）+ 原子取批（`UPDATE…WHERE status='approved'` 单方 changes=1）✓ |
| 爬坡 | `effective = min(天花板, max(30, ⌊昨日冷发×1.5⌋))`。序列复算：30→45→67→100→150→225→337→505→757→1000，**10 天达 1000，与注释一致** ✓。只约束批量通道、手动豁免为结构性（无 if）✓ |
| 熔断 | 窗口 30 封**自动 initial 已发**信 / 退订 ≥15% 熔断 / 样本不足不判 / `resumed_at` 后重计（防"重开即再熔断"死锁）✓。分母只数 `status='sent'`——已核实 8 种 skip 全部 return 在 INSERT 之前，不污染窗口 ✓ |
| ⚪ 首日敞口 | 爬坡首日最多 30 封在熔断样本凑齐（30 封）之前全部发出——首日若是退订风暴，熔断最快下一轮才触发。最大敞口 = 30 封 + 在飞。设计权衡（样本不足不判是对的），知会不判修 |

---

# 二、🔴 合规（维度 2）——全部生产实测通过

| 项 | 实测 |
|---|---|
| CAN-SPAM 地址进邮件 | 代码核实：`buildHtml`/`buildText` 无条件拼入 `company_address`（默认值与官网 contact 地址**逐字一致**，AU1 时实测过官网端）。⚠️ **渲染态（真信里长什么样）无法验证**——runbook §4 本来就规定必须肉眼看真信，那是执行窗试发时的活 |
| 退订链接公网可达 | ✓ `GET https://link.airsonde.net/u/<token>` → 200 确认页（非 Access 登录页） |
| GET 不生效、POST 才生效 | ✓ GET 返回确认页 + POST 表单（防企业网关误退订）；`POST /u/<token>` → 200 "Unsubscribed"；RFC 8058 头（`List-Unsubscribe-Post: One-Click`）在 send.ts:476-477 ✓。⚠️ "GET 两次不生效"用假 token 验的是路径语义（GET 处理器无任何写库语句，代码核实）；真 token 的状态变化无法零副作用地验，未验 |
| 退订→压制联动 | 代码核实 `unsubscribeByToken` → status='unsubscribed' + `addSuppressedEmail` ✓（生产两表现均 0 行，无实例可对账） |
| 公开正门最小面 | ✓ 实测 8 路径全 404：`/` `/catalog` `/api/leads` `/api/ignition` `/api/stats` `/api/_whoami` `/api/settings/sending` `/index.html`。公开面仅 `/u/*`、`/api/webhooks/*`（无签名 401 fail-closed 实测）、`/api/inbound`（未配 token 503 fail-closed 实测） |
| 后台 Access 门 | ✓ 三信号齐：302 + `Www-Authenticate: Cloudflare-Access` + `Set-Cookie: CF_AppSession`（wanewgroup.cloudflareaccess.com） |

---

# 三、🔴 诚实红线（维度 3）

## 3.1 打分/写信 prompt 纪律 —— 通过

- 三层防注入：`<<<UNTRUSTED_*>>>` 围栏 + 背书只走 system 段 + 回信起草明拒执行内嵌指令 ✓
- 写信规则明文：`Do NOT invent facts`、`NEVER quote…specific prices, certifications we have not confirmed, or delivery promises` ✓
- 打分 prompt 不诱导编造：一票压低要求引用官网具体证据；"信息不全 ≠ 不合格，给 40-55 待人工复核"（两类错不对称的取舍写在 prompt 里）✓
- 背书通道当安全边界设计（服务端白名单、正文自称无效），且上游两个目录源在 AirSonde 为死壳（`ENABLED_DIRECTORY_SOURCES=[]`）✓

## 3.2 🟡 Y2 — 卖点/话术**默认值**含未经 Joe 审定的能力主张，且生产正在生效

**事实**：生产 settings **无** `selling_points` / `chat_script` / `customer_profile` 行 ⇒ 三者全部落在代码默认值上。逐句核：

| 默认文案（生效中） | 断言 | 对照 |
|---|---|---|
| `Factory-direct supply of indoor air quality monitors…`（DEFAULT_SELLING_POINTS，**每封 AI 信都注入**） | 工厂直供 | 与官网已发布口径（"The IAQ line of an established Shenzhen manufacturing group"）方向一致，**可辩护** |
| `…OEM/ODM private-label support with flexible MOQs…` | **MOQ 灵活** | `给工厂的问题清单.md` 三-9（MOQ 档位）**工厂未答**。不违画像终稿 §5 的三类禁令（认证/协议/技术），但属**无工厂确认的商务能力承诺** |
| DEFAULT_CHAT_SCRIPT：`…factory-direct, with OEM/private-label options… May I send you our trade price list?` | 同上 + 承诺发价单 | 同上 |
| DEFAULT_PROFILE（打分画像） | 无对外断言（内部中文画像，诚实描述"中国供应链 ODM/OEM 制造方"） | ✓ 无问题 |

代码注释自认这些是"**草稿**…待 Joe 逐条核实后在发信设置里填"——**但点火后第一封真信不会等 Joe 填**。
**建议**：点火发信前，Joe 在设置页把 selling_points/chat_script 过目定稿（C5-2 设置页恰在途，可并单）；或先把 "flexible MOQs" 从默认值里拿掉。

## 3.3 ⚪ 相关：`sendInboundConfirmation` 死代码里的占位文案

含 "factory-direct — OEM/ODM private-label, flexible MOQs"，注释还写着「C1 无 RESEND_API_KEY，此信发不出」——**钥匙已配，这句过时了**；它现在发不出的真正原因是"无调用方"。过时注释 + 未审文案躺在真实发信函数里，建议删函数或至少更新注释（同类过时注释另见 landing.ts 头部「C1 未配 API_HOST → 本页无公开入口」——API_HOST 已配，该页不可达靠的是 C2-F 的路由豁免收窄，不是未配）。

---

# 四、数据正确性（维度 4）

| 项 | 结果 |
|---|---|
| 关键词 26 | ✓ 代码 DEFAULT_KEYWORDS 26 条（逐条数），生产 keywords 表 26 行，**双向差集 ∅**（独立复核，未采信执行窗报告） |
| 国家 27 | ✓ 代码 COUNTRIES 27（15+12），生产 `search_countries` 27 码，**双向差集 ∅**；黑名单 10 国为第二层硬挡且与 27 国无交集 ✓ |
| 点火 8 项 | 面板本身在 Access 后**读不到**（见"砍了什么"）。行为侧写：inbound **未配**（503 实证）、appbot **未配**（503 实证）、send/notify 按派单断言已配（**无法独立验证**）、能力↔钥匙映射与 `src/ignition.ts` 单一真源一致（代码核对 8 条）✓ |
| 生产库量 | leads 仅 2 条（#263 = Resend 模拟地址测试数据；#264 = **真实公司 HOLDEKS 真人邮箱**，score 10、analyzed，结构上发不出——知会 ⚪）；emails/replies/suppressed 全 0 |
| 阶段计数口径 | `sentTodayBreakdown` initial 已收紧为严格 kind 口径（防事务信混入"首触"）✓；failed 与 sent 配对成表 ✓ |

## 🟡 Y3 — `taxonomy.ts` 的客户分类轴与杀因语料仍是上游星链行业

`CUSTOMER_CATEGORIES` 含「船舶/海事」「房车/RV」「离网/偏远」；`categorizeCustomerType` 的正则匹配 marine/yacht/RV/off-grid/wisp；`classifyKillReason` 的示例语料含「未提及**星链**配件」「Starlink Maritime」。IAQ 客户（品牌方/楼控集成商/暖通分销商）会几乎全部归入「其他」或被错吸——列表徽章、多维筛选、翻牌堆分组三处失准。**非发信路径，不影响误发结论**；但它是 Joe 天天看的分组轴。C4-A 换了词表和国家，**没换这根轴**，不在 C5 已排程清单里 → 计新发现。

---

# 五、未点火语义覆盖（维度 5）

在**我自己的**零钥匙实例上全量扫描（先证 `_whoami`：guard:true、八能力全 false）：

| 端点 | 结果 |
|---|---|
| `/api/ignition` | 8 项清单，未点火项报「缺哪把钥匙」，零故障语 ✓ |
| `/api/stats` `/api/replies` `/api/leads` `/api/today` | 200，无"失败/连续 N 轮"话术 ✓ |
| `/api/settings/sending` | 200，"未点火"中性文案 ✓ |
| 整轮 cron 空转 | 每段一句人话跳过原因，零 error、零外呼（subreq ext=0）✓ |
| 今天页（浏览器渲染） | 「今天没发信 —— 机器还没点火…**不是故障**」+「去把这 **4** 把钥匙配」——缺钥匙数**由真实 env 派生**（我的实例恰缺 4 把核心钥匙），铁律三活体验证 ✓ |
| 无 `.dev.vars` 时 | 后台全线 403 fail-closed；`DEV_BYPASS_AUTH` 存在但条件不满足时 503 停服（代码核）✓ |

**未发现新的"未点火吼故障"漏网端点。** C2-C/C5-1 的修复覆盖住了我扫到的面（⚠️ 覆盖面=上表端点 + 今天页；C5-2..5 未做的页面未扫，已在途）。

---

# 六、宪法闸有效性（维度 6）

**guard-design 自检 + 我构造的违宪样本，全红该红、该绿的绿：**

| 样本 | 期望 | 实际 |
|---|---|---|
| 自带自检 4 用例（含 C2-D 真实事故原句「预算/熔断/爬坡/点火明细」） | 2 红 2 绿 | ✓ 全对 |
| 我构造 A：设置页 901 字（边界+1） | 红 | ✓「字数 901 > 预算 900」 |
| 我构造 B：客户页含真禁词 `Serper` | 红 | ✓「出现禁词：Serper」 |
| 我构造 C：健康样本 | 绿 | ✓（反向自证：不误报） |

**今天页宪法测量（零数据态、本地渲染口径，按宪法冻结口径执行）**：`#v-page` innerText 归一后 **285 字 / 预算 400** ✓，禁词 **0** ✓——与宪法记载的"当前实测 285"逐字吻合。
⚠️ 宪法自己要求"终验必须在生产上抽一页复量"——生产在 Access 后，本窗做不了，**列为点火 checklist 待办**（执行窗有 Access 会话时顺手一量）。

---

# 七、🟡 其余发现

## 🟡 Y1 — `auto_approve_enabled` 默认 "1" 且生产无显式行 = 自动批准此刻活着
与 R1 同形（上游管线的 fail-open 默认），后果轻一级（批准≠发信）。但它让 R1 的链条更短：任何 ≥60 分线索整点自动进池。同一批改默认值时一起改，或在生产写显式行。

## 🟡 Y4 — 官网询盘目前**不进 CRM**（两侧都未接线）
- CRM 侧：`INBOUND_TOKEN` 未配（生产 503 实证，fail-closed 正确）
- 官网侧：`airsonde-web/functions/api/contact.ts` **无任何向 CRM 转发的代码**（grep inbound/token/link.airsonde 零命中）
⇒ 官网询盘现在只进 Lark 群，CRM 里不会有。结构上无危害；但若任何人以为"官网询盘接入已通"（CRM 仓有 a00295b 那条"wire website enquiries into the CRM pipeline"提交），**那是收信端就绪、发信端从未接线**。要通需要：官网侧加转发 + 两边配同一个 INBOUND_TOKEN。归 Joe/总工排期。

## 🟡 Y5 — runbook §3① 的进程身份判据，认不出"同 repo 的两个进程"（本次实测栽进去）
我按 runbook 打 `127.0.0.1:8791/api/_whoami`，拿到 `repo:airsonde-crm` ✓——**但那是 CRM 窗自己的 dev 进程**（我的实例被端口挤掉了；他们的实例带着自己的 .dev.vars 在 8791 上应答）。`repo` 字段对两个进程给出同一个答案，三信号全过，串台照样发生。另：README 写 dev 端口 **8787**、runbook 写 **8791**——恰好在防串台那一步上两份文档不一致。
**建议**：`_whoami` 加每进程随机启动标记（boot id）；runbook §3① 改为"先在自己终端里看 Ready 的端口号，再 curl 该端口，比对 boot id"；README/runbook 端口统一。

---

# ⚪ 知会（不判修）

1. `isEmailSuppressed` DB 异常时返回 false 退回 status 闸（注释自认的取舍；双闸仍在，单闸失效不裸奔）
2. HOLDEKS 真人邮箱已在生产库（score 10 不可发；试发/演示时留意别拿它当测试对象）
3. Resend webhook 的 401 无法区分"secret 已配签名错"与"secret 未配"（fail-closed 两态同响应——安全上正确，但点火 checklist 里"RESEND_WEBHOOK_SECRET 配了没"**不能**用这个探针验，得看 secret 清单）
4. 首日熔断敞口 ≤30 封（见 1.4 表尾）
5. 过时注释两处（send.ts:780「C1 无 key 发不出」、landing.ts:4「未配 API_HOST」）——都是"曾经为真"类，正是 AU2 点名过的病种

---

# 覆盖率表：审了什么 · 怎么审 · 什么没审到

## 审了（方法）
| 面 | 方法 |
|---|---|
| 发信路径 | 全仓 grep deliverEmail/send* 调用图 + 逐条读闸 |
| cron | scheduled() 全读 + 本地空转实测（devguard 锁出站） |
| 生产状态 | D1 远程 SELECT（settings/leads/emails/suppressed/keywords/replies），摘 token 进程 |
| 公开面 | 生产零副作用探针 11 个（GET×9 + 无效凭证 POST×3，全部在写库语句之前被拒，代码核实零写入） |
| 宪法闸 | 自检 + 3 个自构样本 + 今天页浏览器实测 285/400 |
| prompts | openrouter.ts 全读逐句 |
| 词表/国家 | 代码逐条数 + 生产双向差集 |

## 没审到（原因，⛔ 未推断）
| 项 | 原因 |
|---|---|
| 生产 `/api/ignition` 8 项面板、今天页生产复量、后台 UI 全部 | Access 门后，本窗无会话。**能力布尔面只有 inbound/appbot 两项有公开行为可证（都未配）；send/notify/ai/search/imap/emailfinder 的"已配"取自派单断言，我未独立验证** |
| CAN-SPAM 页脚**渲染态**、Resend 是否尊重自指定 Message-ID | 必须发真信才可验（runbook §4/commit 自己也这么标）——执行窗试发时肉眼验，⛔ 本窗不发信 |
| IMAP 收信链路 | 无公开可探测面且不可零副作用触发 |
| `RESEND_WEBHOOK_SECRET` 配没配 | 401 两态同响应（见 ⚪3） |
| 真 token 退订的状态联动 | 零副作用原则下不可验（假 token 只验了路径语义与零写入） |
| C5-2..5 未做页面 | 已在途，按派单不计 |
| 飞书通知"已通" | 取自派单断言；LARK_WEBHOOK_URL 无公开探测面 |

## 审计过程中我自己犯的错（如实记）
1. **串台**：第一轮本地测量打在 CRM 窗的 8791 dev 进程上（端口被占 + wrangler 静默共存），未点火语义那组数据后来在我自己的 8799 实例上**全部重测**（两轮结论一致）。此事故直接产出 Y5。
2. **僵尸进程**：TaskStop 未杀净 workerd，8797 上旧进程接走请求造成第二轮假 403；按 PID 清理后重来。两次都靠"结果与预期矛盾就停下来查环境"抓住，未污染报告数据。

---

# 点火前建议清单（按序）

1. **R1**：`auto_send_enabled` 默认串改 "0"（一行 diff + 本地空转回归）——发信前最该动的一行
2. **Y2**：Joe 定稿 selling_points / chat_script（或先删 "flexible MOQs"）——第一封真信引用的就是它
3. Y1 顺手：auto_approve 默认同批改，或生产写显式行
4. 执行窗试发时补：真信页脚肉眼验（runbook §4）+ Message-ID 确认 + 生产今天页复量 + MEASURED_SEND_MS 回填（runbook §5，已在途）
5. Y5：runbook §3① 判据补 boot id；README/runbook 端口统一
6. Y4/Y3：官网询盘接线、taxonomy 换轴——独立排期，不阻塞点火

---

*本报告全部事实性断言：标"实测/实证"者为本窗直接测量；标"代码核实"者为对 `0e3b7ba` 的源码判读；标"派单断言"者未独立验证。审计副产品（worktree、本地库、dev 实例、`.dev.vars`）已清理。*

---

# 事后更正（2026-08-31，总工验收回执后追加；原文一字未动）

**更正 Y3 的定性**：报告称 taxonomy 星链轴「不在 C5 已排程清单里 → 计新发现」——**"新发现"三字不成立**。CRM 窗在 C4-A 时已自报此项、总工已立案 **C4-E**（排在 C5 之后）；且派单原文的对账清单里就写着「是否与已排程（C5/**C4-E**/点火剩余项）重叠」——**我没有去查 C4-E 是什么就断言了"不在清单"**。我的独立撞见构成**双源确认**（分级维持 🟡），但发现权属于 CRM 窗的自报。
判据教训（与 AU2 更正同族）：**"我没查到"不等于"不存在"——对账清单里的每一个代号，核对前都不许说"不在其中"。**（更正人：审计窗；依据：总工 AU-CRM-1 验收回执 + 派单原文复读。）
