# AirSonde CRM 深度独立审计报告（Claude 修复交接版）

> 本文可直接整段复制给 Claude。请按优先级逐项修复，不要只处理表面症状；每项都必须满足文末验收条件。

## 0. 审计元数据

- 审计日期：2026-09-02（America/Los_Angeles）
- 生产站：`https://crm.airsonde.com/`
- GitHub：`https://github.com/zq8345/AirSonde-CRM`
- 本地仓库：`C:\开发\airsonde\airsonde-crm`
- 本地 HEAD：`fd0028faf74610e344eb60e01e68eebdee127495`
- `origin/master`：`fd0028faf74610e344eb60e01e68eebdee127495`
- 生产页面版本戳：`d1be6c3+dirty · 2026-09-02 07:16Z`
- 审计方式：源码静态审查、依赖审计、现有自检、生产登录态只读页面检查、匿名入口检查、生产/源码交叉核对。
- 明确未做：没有发送邮件、没有提交表单、没有触发 webhook、没有改 D1、没有改 Cloudflare 配置、没有部署、没有修改业务代码。

## 1. 结论先行

当前版本**不应被认定为“审计通过”**。发现 2 项业务 P0、9 项 P1、6 项 P2。最危险的不是传统的“服务挂掉”，而是系统可能在仍然返回成功、页面仍显示正常的情况下：

1. 绕过审批、状态、日限额、跟进冷却和次数限制发送真实邮件；
2. 并发时突破配额或重复发送；
3. 因迟到事件覆盖客户阶段；
4. 给管理员展示互相矛盾的经营数据；
5. 运行一个无法从任意 Git commit 精确重建的生产版本。

**立即建议**：在 P0-01、P0-02、P1-01 完成并通过并发测试前，关闭自动发送并限制人工单发；不要依赖 UI 提示或调用方“正常使用”来保证合规。

### 风险清单

| ID | 级别 | 结论 |
|---|---:|---|
| P0-01 | P0 | 单条初次发送绕过 approved 状态和系统日限额 |
| P0-02 | P0 | 暖跟进直发绕过 sent 状态、跟进开关、冷却、次数和日限额 |
| P1-01 | P1 | 配额、锁和发送幂等均为 check-then-act，并发下不成立 |
| P1-02 | P1 | Access JWT 验签器存在但未接入，实际只信任一个请求头 |
| P1-03 | P1 | 外部来信地址进入内联 JS，形成存储型 XSS |
| P1-04 | P1 | 迟到 webhook/回复会无条件覆盖 won、replied 等业务阶段 |
| P1-05 | P1 | 抓站和找邮箱允许访问未校验目标及跟随未复核重定向，存在 SSRF 面 |
| P1-06 | P1 | 数据看板使用多套互相矛盾的回复/测试数据口径 |
| P1-07 | P1 | 生产为 dirty 混合构建，无法按 Git SHA 重现或可信回滚 |
| P1-08 | P1 | 最新“机器房”控制迁移在线上不可用，字段长期空白/加载中 |
| P1-09 | P1 | `schema.sql` 声称完整但缺少运行必需列，首次运行存在竞态 |
| P2-01 | P2 | 三个公网 POST 入口在鉴权/验签前无界缓冲请求体 |
| P2-02 | P2 | `/api/inbound` 允许无 token 浏览器直投，易被分布式滥用 |
| P2-03 | P2 | 飞书卡片回调无事件幂等，重放可重复发送回信（当前功能未配置） |
| P2-04 | P2 | Hono 当前版本命中 4 个 moderate 通告 |
| P2-05 | P2 | 没有 CI 和真实运行时/数据库/路由集成测试 |
| P2-06 | P2 | Workers compatibility date 停在 2025-07-01 |

## 2. 详细发现

### P0-01：单条初次发送绕过审批状态与日限额

**证据**

- `src/index.ts:1948-1954` 注释声称“要求已批准 approved”，但路由只读取 lead 后直接调用 `sendLead()`。
- `src/send.ts:618-644` 的 `sendLead()` 只检查 API key、邮箱及压制状态，不要求 `lead.status === 'approved'`，也不调用 `systemDailySendLimit()`。
- `public/index.html:3280-3288`、`3617-3623` 的真实前端动作会调用此接口。

**可利用结果**

任意已通过后台鉴权的调用方都能对 `new`、`analyzed`、`replied` 等非 approved 线索发送第一封邮件；即使系统今日额度已经用完，仍可继续逐条发送。它破坏了项目自己宣称的“唯一咽喉点”。

**修复要求**

- 不要只在路由增加一个 `if`；把单发纳入与批量相同的服务层命令。
- 推荐让单发调用 `sendApprovedBatch(env, 1, [id])`，或建立统一 `reserveAndSendInitial()`。
- 状态认领、系统/自动配额预留、地址幂等、压制检查必须在一个可审计入口完成。
- 非 approved 返回 409；额度为 0 返回明确 cap 结果；不能调用 Resend。

### P0-02：暖跟进直发绕过全部跟进策略

**证据**

- `src/index.ts:2037-2044` 读取任意 lead 和正文后直接调用 `sendWarmFollowupNow()`。
- `src/send.ts:683-691` 只检查 key、邮箱、压制状态和正文非空，然后直接 `deliverEmail(kind='followup')`。
- 没有要求 `status='sent'`，没有检查 `followup_enabled`、`followup_delay_days`、`engaged_follow_up_delay_days`、`followup_max` 或系统日限额。
- 前端 `public/index.html:3137` 可触发该路径。

**可利用结果**

同一线索可以被反复发送无限次暖跟进，也可在从未发过初次邮件、已经回复或业务阶段不合适时发送。`deliverEmail()` 对 followup 没有幂等约束。

**修复要求**

- 暖跟进必须进入统一 `reserveFollowup()`，复用批量跟进的状态、开关、冷却、次数、全局配额和压制规则。
- 人工编辑正文可以保留，但“正文来源”不能成为绕过策略的理由。
- 对同一操作生成 idempotency key；重复请求必须返回同一结果而不是再次发送。

### P1-01：发送一致性不是原子的，并发时配额与幂等失效

这是三个相关缺陷，应一起修，不能分别加更多 `SELECT`。

**A. 定时锁非原子**

- `src/index.ts:4143-4147` 先读 `fast_tick_lock`，判断后再写；两个并发 tick 可同时读到空值并同时取得“锁”。
- `src/index.ts:4218-4221` finally 无条件清锁；旧 owner 可清除新 owner 的租约。

**B. 日限额 check-then-act**

- `src/send.ts:705-711` 和 `787-790` 都先统计今日发送，再计算剩余额度。
- 两个并发批次可以读到同一个余额，各自发送不同线索，合计突破额度。
- P0 两条直发路径则完全不读取额度。

**C. 邮件幂等 check-then-insert**

- `src/send.ts:506-533` 先查询是否存在 sent/queued；`555-559` 才插入 queued。
- schema 没有能阻止重复 initial 的唯一约束。
- 同一 lead 的并发直发，或同邮箱的重复 lead 并发，都可能同时通过查询后各发一封。

**修复要求**

- 使用 owner token 的原子租约；只有当前 owner 能续租和释放。
- 在 D1 中原子预留“今日发送名额”，外部请求前拿到 reservation；失败后按明确策略释放或记为失败。
- 为一次业务发送建立稳定 idempotency key 和数据库唯一约束；不要依赖 `SELECT` 后 `INSERT`。
- 把外部 Resend 调用设计成可恢复状态机：`reserved -> dispatching -> sent/failed/unknown`，明确超时后的对账策略。
- 至少做 20 个并发请求测试，证明总发送数不超过额度、同一 idempotency key 只产生一次外发。

### P1-02：Access JWT 验签没有接入实际鉴权

**证据**

- `src/index.ts:246-254` 对管理员域只检查 `cf-access-authenticated-user-email` 是否存在。
- `src/accessjwt.ts` 已实现 RS256、issuer、audience、exp/nbf 验证，但 `src/index.ts` 没有导入或调用它。
- `wrangler.jsonc` 没有 `ACCESS_AUD`；`src/accessjwt.ts:27` 的默认值属于另一套 Wanew 应用，不是 AirSonde。
- 自测 14/14 通过只证明孤立模块工作，不证明生产请求使用了它。

Cloudflare 官方说明：Worker 仍应验证 `Cf-Access-Jwt-Assertion` 的签名、issuer 与 audience，不能只信任辅助身份头：[Validating the Access token](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)。

**当前缓解与边界**

匿名访问生产域目前被 Access 边缘拦截，因此本次没有确认即时公网绕过。但一旦 Access 路由、应用或 Host 边界误配，请求抵达 Worker 后，伪造该头即可进入所有后台写接口。防线不应只存在于部署配置。

**修复要求**

- 对 admin host 强制验 `Cf-Access-Jwt-Assertion`/cookie，缺票、错签名、错 iss、错 aud、过期均 fail-closed。
- 配置 AirSonde 的正确 AUD；不要依赖当前错误默认值。
- `/api/me` 和审计日志只使用已验证 JWT 中的 email。
- 把 `accessjwt-selftest` 及中间件集成测试纳入部署闸。

### P1-03：孤儿回复列表存在存储型 XSS

**证据**

- `public/index.html:4108` 将外部 `from_email` 拼入单引号包裹的内联 `onclick`：`onclick="linkOrphan(...,'${esc(o.from_email)}')"`。
- `public/index.html:5500` 的 `esc()` 只处理 `&<>"`，不处理单引号，也不是 JavaScript 上下文编码器。
- `from_email` 来自入站邮件并持久化，见 `src/replies.ts:190-230`。

**影响**

攻击者可构造包含单引号的合法/边界邮箱 local-part，使管理员打开孤儿回复区域时破坏 JS 字符串，最坏执行脚本。即使某一邮件供应商会规范化地址，也不能把外部值插入内联执行上下文。

**修复要求**

- 删除所有由数据拼接生成的 inline handler；使用 `data-*` 和统一事件监听器。
- `dashAction('${esc(a.cta.action)}')` 也应一并改掉，避免未来服务端 action 变为外部数据时重复踩坑。
- 增加 `'`, `"`, 反斜杠、换行、HTML entity、quoted local-part 的浏览器测试，并配置严格 CSP，逐步禁用 inline script。

### P1-04：迟到事件会覆盖受保护或更高价值阶段

**证据**

- `src/webhook.ts:107-116` bounce/complaint 无条件把 lead 改为 bounced/blacklisted。
- `src/replies.ts:242-252` 真人回复无条件把 lead 改为 replied，可能把 won/ignored 降级。
- `src/index.ts:3387-3406` 孤儿回复人工关联也无条件改状态。
- 相比之下，`src/index.ts:1587-1594` 的人工渠道回复已经显式保护合规终态，说明不同入口的状态规则已分叉。

**影响**

旧邮件的迟到退信可以覆盖后续成交；迟到回复可把 won 改成 replied；人工关联可把合规终态重新推进。回复记录本身应被保存，但不等于允许任意状态转移。

**修复要求**

- 定义唯一状态转移矩阵，所有 webhook、IMAP、人工关联、渠道回复共用。
- `won` 不得被普通回复降级；合规压制状态不得因回复解除。
- 使用条件 UPDATE，并记录事件与“状态未变原因”。
- 增加乱序事件测试：sent -> replied -> won -> late bounce/reply。

### P1-05：抓站与找邮箱存在 SSRF 面

**证据**

- `src/scrape.ts:278-287` 与 `src/findemail.ts:320-324` 只补协议并解析 URL，不阻止 localhost、私网、链路本地、IPv6 本地、带凭据 URL 或非标准端口。
- `src/scrape.ts:232-250`、`src/findemail.ts:259-279` 使用 `redirect:'follow'`，重定向后的目标没有重新验证。
- 管理员可通过 `src/index.ts:1964-1978` 修改 website；自动发现得到的网站同样属于不可信互联网输入。

**影响与边界**

当前 Workers 网络环境可能限制部分内网访问，但代码本身允许目标探测与重定向绕过；未来一旦接入私有网络、Service Binding 或其他内部资源，影响会扩大。自动发现还使该面不只受管理员手工输入影响。

**修复要求**

- 只允许 `http:`/`https:`，拒绝 credentials、异常端口和本地/私有/保留 IP 段（IPv4 与 IPv6）。
- 使用 `redirect:'manual'`，每一跳重新验证 scheme、host、端口、解析结果与最大跳数。
- 防 DNS rebinding；优先使用明确的 outbound proxy/allow policy。
- 用 `127.0.0.1`、`169.254.169.254`、RFC1918、`::1`、IPv4-mapped IPv6、十进制/十六进制 IP 和恶意 30x 做测试。

### P1-06：看板存在多套互相矛盾的数据口径

**源码证据**

- `src/index.ts:668-669` 顶部 replied 统计当前 `leads.status='replied'`，不是回复事实。
- `682-690` 维度切片使用回复记录，但没有统一排除测试 lead。
- `701-718` inbox 使用 replied/won 或 click，又是一套定义。
- `721-730` 日趋势、`751-760` 周趋势、`782-792` 分数桶/缺邮箱等查询对测试数据处理不一致。
- `912-917` 回信构成才显式区分 `is_auto`。

**生产复现**

同一页面同时出现：周图 sent 136 / replies 3、回信构成真人“当前 1/3”另有 auto 1、漏斗 replies 0、顶部已发 135。至少四个区块不能由同一事实口径解释。

**修复要求**

- 明确定义并分别命名：`real_reply_messages` 与 `real_reply_leads`。
- 建立唯一 SQL 构造器/视图，统一 real reply、test lead、orphan 的规则。
- 每个卡片在 API schema 中声明 metric definition，不允许前端自己猜。
- 用固定夹具覆盖自动回执、测试 lead、孤儿回复、同 lead 多封回复、won 后回复。

### P1-07：生产构建不可重现

**证据**

- 当前本地与远端均为 `fd0028f...`。
- 生产页显示 `d1be6c3+dirty · 2026-09-02 07:16Z`。
- 生产 UI 已包含只在后续 `fd0028f` 中提交的“设置控制迁入机器房”改动。

所以生产不是简单的“落后一个 commit”，而是以 `d1be6c3` 为基线、混入未提交改动的构建。回滚到 `d1be6c3` 也不能得到当前生产内容。

**修复要求**

- 正式部署遇到 dirty tree 必须失败；紧急 override 也必须归档 patch、操作者与原因。
- CI 从 commit checkout 构建，不从开发者当前目录构建。
- 部署后自动读取版本端点，要求完整 SHA 一致且无 `+dirty`。
- 保留上一版本构建产物和数据库迁移兼容说明。

### P1-08：“机器房”控制迁移在线上不可用

**证据**

- 最新提交把发送/搜索控制从设置页移入机器房。
- `public/index.html:5354-5463` 的 `openMachineRoom()` 虽会获取状态，却没有调用 `fillSettingsFields()` 或 `loadSearchCfg()`。
- `openSettings()`（`4176-4200`）仍是唯一负责填充这些表单的入口。
- 生产机器房等待超过 18 秒后，分数档仍显示 `≥…`，数值控件为空，方向/画像停在“加载中…”。
- 机器房失败 UI 仍引用旧设置页按钮/错误节点，Cancel 还会跳回旧设置页。

**影响**

关键发送与搜索设置无法可靠查看或编辑。当前 `_cfgLoaded` 保护会阻止直接保存，降低了误写风险，但也证明迁移没有完成；现有 design guard 仍全绿，说明测试没有覆盖真实页面行为。

**修复要求**

- 机器房打开时显式加载并填充全部控制；加载前禁用编辑，失败时在当前面板显示原因和重试。
- 移除对旧设置页节点的隐式依赖。
- 增加 Playwright/Miniflare 测试：打开机器房 -> 等待 -> 字段有真实值 -> 编辑/取消不跨页 -> 网络失败可见且不可保存。

### P1-09：新数据库 schema 不是自包含的

**证据**

- `schema.sql` 文件头声称完整、自包含。
- `schema.sql:76-94` 的 `emails` 缺少代码会读写的 `error TEXT`。
- `schema.sql:102+` 的 `replies` 缺少代码插入和聚合所需的 `is_auto INTEGER`。
- `src/send.ts:26-30` 运行时临时补 `emails.error`。
- `src/index.ts:2624-2641` 运行时临时补 `replies.is_auto`，但 scheduled handler 用 `waitUntil` 并发启动自愈；首次收信可能先执行 `src/replies.ts:228-230` 的 INSERT 而失败。

**修复要求**

- 把所有当前必需列、索引、约束写入 `schema.sql`。
- 用顺序版本迁移替代请求路径中的“catch 即已存在”DDL；不要吞掉权限、语法或存储故障。
- CI 创建空 D1、执行 schema，再跑全部查询和首封回复/首封发送 smoke test。
- 增加 schema drift 检查，比较代码所需列与 fresh DB。

### P2-01：公网入口没有业务级请求体上限

**证据**

- `src/index.ts:3049-3055` Resend webhook 在签名验证前 `c.req.text()`。
- `3067-3071` 飞书回调在 token 校验前 `c.req.json()`。
- `3455-3463` inbound 通过共享 JSON helper 完整读取 body。
- 代码没有 `Content-Length` 早拒绝或有界流式读取。

Cloudflare 账户计划允许的请求体可达 100–500 MB，而 Worker isolate 内存为 128 MB；官方也建议避免缓冲大对象并使用流：[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)。平台最大值不是 webhook 的安全业务上限。

**修复要求**

- 给三个入口分别定义保守 byte limit；先检查 `Content-Length`，未知长度则用累计字节的流读取。
- Resend 必须对“有界的原始字节”验签，不能先 JSON parse。
- 超限返回 413，且不进入 D1、通知、签名验证或业务处理。

### P2-02：inbound 无 token 路径可被分布式滥用

**证据**

- `/api/inbound` 在 `src/index.ts:181-185` 全局免登录。
- `authInbound()` 在无 token 时返回 `trusted:false` 而不是拒绝（`3441-3450`）。
- 后续虽有 honeypot、每 IP 30/h 硬限与 10/h 软限，但 IP 轮换可绕过。
- 生产机器房显示 `INBOUND_TOKEN` 未配置，可信官网后端通道当前不可用。

**影响与缓解**

攻击者可制造垃圾 lead 与通知噪声。当前路径不会自动发送确认邮件，降低了被借用发信的风险，因此列为 P2 而非 P0/P1。

**修复要求**

- 生产只接受服务端转发 token，或给浏览器直投加入 Turnstile 并服务端校验。
- 限流维度加入邮箱/domain、ASN/行为指纹和全局熔断，不只按 IP。
- 记录拒绝原因但不记录 token；给异常速率告警。

### P2-03：飞书卡片发送回调可重放

**证据**

- `src/lark-app.ts:264-280` 只校验静态 verification token，没有持久事件 ID、时间窗或幂等状态。
- `src/index.ts:3130-3163` 的 `rsend` 后台任务直接 `deliverEmail(kind='reply')`。
- reply kind 没有唯一幂等键；供应商重试、重复点击或有效回调重放会多次发出同一正文。

**当前边界**

生产机器房显示 Lark App 凭据未配置，所以当前是潜伏路径；一旦启用即成为真实发送风险。

**修复要求**

- 持久化 Lark event/callback 唯一 ID，原子插入成功者才处理。
- 给 rsend 自身建立稳定 idempotency key；按钮点击后原子转为 processing/done。
- 验证官方回调的签名、时间戳和重放要求，不只校验静态 token。

### P2-04：Hono 版本命中已知 moderate 通告

- 当前安装：`hono@4.12.28`。
- `npm audit --omit=dev --audit-level=moderate` 报 1 个 vulnerable package、4 个通告：CORS ReDoS、memo 跨用户缓存、Proxy Helper 头处理、Language Middleware 算法复杂度。
- 当前源码未使用这些特定 helper，所以未确认直接可达利用；仍应升级到已修复的 `4.13.5` 并回归。
- 不要不审查地执行批量 `npm audit fix`。

### P2-05：部署闸不覆盖真实行为

- `package.json` 只有 typecheck/cadence，没有 `test`。
- 仓库未发现 `.github/workflows`。
- `accessjwt-selftest` 与 `guard-design` 都不在 `npm run typecheck` 内。
- `guard-design` 9/9 通过，但生产机器房仍实际加载失败；说明它验证的是局部 helper，不是用户路径。
- 没有覆盖 D1 并发、发送幂等、路由鉴权、迁移、乱序 webhook、前端 XSS 的运行时测试。

**最低测试栈**

1. Miniflare / Workers Vitest 的路由与 D1 集成测试；
2. Playwright 的后台核心路径测试；
3. 伪 Resend transport，任何测试环境都绝不触发真实外发；
4. 并发 quota/idempotency 测试；
5. fresh schema 与 migration 测试；
6. CI 必跑 typecheck、audit policy、集成测试和 clean-build 检查。

### P2-06：compatibility date 长期未更新

- `wrangler.jsonc:8` 为 `2025-07-01`，审计日为 2026-09-02。
- Cloudflare 建议项目初始使用当前日期并定期更新，更新时检查 compatibility flags 并测试：[Compatibility dates](https://developers.cloudflare.com/workers/configuration/compatibility-dates/)。

旧日期本身不会立即使 Worker 停止，因此不是安全漏洞；问题是项目会长期依赖历史运行时行为，升级差距越来越难验证。应单独分支更新并完成全套运行时回归，不要只改日期后直接生产部署。

## 3. 较低优先级但应登记的事项

1. `src/subreq.ts` 用 isolate 级可变全局变量记录计数；并发 invocation 会互相 reset/累加，诊断数字可能串线。它当前只影响观测，不应被当成精确配额账本。
2. `src/send.ts:206-230` 的 HTML escape 不转义引号，而 company website 被放进 `href`。当前值来自管理员设置，攻击边界较窄；仍应做 URL allowlist 与属性上下文编码。
3. Resend webhook 没有持久化 `svix-id` 去重。重复 delivery/open/click 事件可能重复计数；需根据产品想要“原始事件次数”还是“唯一事件”明确语义。
4. `isEmailSuppressed()` 在 D1 查询异常时 fail-open。应区分“未命中”和“查询失败”；发送合规闸遇到未知状态更适合 fail-closed 并告警。
5. 仓库当前存在未跟踪 `__pycache__/` 与旧审计报告。未发现被 Git 跟踪的 `.env`、私钥、pem/p12/key 文件；对当前快照与常见历史 token/私钥模式扫描未命中，但这不等价于专用 secret scanner 的完整历史证明。

## 4. 已验证通过的控制

- 本地 HEAD 与 `origin/master` 一致：`fd0028f...`。
- `npm run typecheck`：通过。
- cadence guard：通过；240s 预算小于 300s 锁 TTL，且大于最大步骤需求。
- `scripts/accessjwt-selftest.mjs`：14/14 通过（注意：模块未接线）。
- `scripts/guard-design.mjs`：9/9 通过（注意：未覆盖真实机器房流程）。
- 前端内联脚本语法解析通过；扫描到 150 个元素 ID，无重复 ID。
- 匿名访问 `crm.airsonde.com` 会进入 Cloudflare Access；`link.airsonde.net` 根路径未暴露后台。
- `workers_dev` 关闭，静态资源配置为先经过 Worker。
- 压制名单、退订 token、自动回执识别、初次信地址级去重的设计方向正确；问题主要在原子性与入口不统一。
- 当前快照未发现硬编码私钥或常见生产 token。

## 5. 验证结果原文摘要

```text
npm run typecheck                         PASS
scripts/accessjwt-selftest.mjs            14 passed / 0 failed
scripts/guard-design.mjs                  9 passed / 0 failed
frontend inline JS syntax                 PASS
HTML id uniqueness                        150 ids / 0 duplicates
git diff --check                          PASS
npm audit --omit=dev --audit-level=moderate
  1 vulnerable package (hono), 4 moderate advisories
```

可更新依赖快照：

```text
hono                        4.12.28 -> 4.13.5
postal-mime                   2.7.5 -> 2.7.6 (3.0.0 major)
wrangler                    4.110.0 -> 4.128.0
@cloudflare/workers-types  5.20260717.1 -> 5.20260902.1
```

## 6. Claude 实施顺序

### 阶段 A：先停止不可逆风险

1. 修 P0-01、P0-02：所有初次发送/跟进进入统一 command。
2. 修 P1-01：原子 quota reservation、owner lease、idempotency unique key。
3. 加 fake transport 与并发测试；在此之前不要用真实 Resend 验收。
4. 修 P1-02、P1-03：真实 JWT 中间件与 XSS。

### 阶段 B：恢复数据与状态可信度

5. 建立状态转移矩阵，修迟到事件覆盖。
6. 统一 dashboard metric 语义和 SQL。
7. 修 schema/migration，并用 fresh D1 验证。

### 阶段 C：恢复运维可信度

8. 修机器房加载与端到端测试。
9. 建立 clean commit CI build、部署后 SHA 验证和可回滚产物。
10. 补 body limit、inbound 防滥用、SSRF、Lark replay。
11. 升级依赖和 compatibility date，各自在独立变更中回归。

## 7. 必须满足的最终验收清单

### 发送与合规

- [ ] 非 approved lead 不能发送 initial，服务端返回 409，Resend 调用次数为 0。
- [ ] 非 sent lead、跟进关闭、未到冷却、超过次数时，暖跟进不能发送。
- [ ] 单发、批量、fast tick、普通跟进、暖跟进共享一个系统配额账本。
- [ ] 20+ 并发请求下，总外发不超过剩余额度。
- [ ] 同 lead、同邮箱重复 lead、同 idempotency key 均至多外发一次。
- [ ] suppressed 查询失败时不允许外发，并产生可观测告警。

### 鉴权与输入

- [ ] 只有伪造 email 头而无合法 Access JWT 的请求被拒绝。
- [ ] 错 aud/iss、过期、未知 key、缺票均 fail-closed；合法 AirSonde 票放行。
- [ ] 外部邮件值不进入 inline JS；XSS 回归样本全部只是文本。
- [ ] 三个公网 POST 超限时返回 413，且零副作用。
- [ ] SSRF 测试覆盖私网、IPv6、混淆 IP 与重定向，每一类均被拒绝。
- [ ] Lark 重复回调只处理一次。

### 数据与状态

- [ ] won 不会被迟到 reply/bounce 降级；合规终态不会被回复解除。
- [ ] 回复事实照常落库，状态未改变时有原因记录。
- [ ] 顶部、漏斗、周图、回复构成对同一 fixture 得出可解释且一致的结果。
- [ ] fresh `schema.sql` 无需请求时自愈即可完成首发、首收和全部 dashboard 查询。

### 前端与发布

- [ ] 机器房首次打开后所有控制显示服务端真值；失败可见且不可保存。
- [ ] 正式部署只能来自 clean commit；线上完整 SHA 与发布目标一致且无 `+dirty`。
- [ ] CI 含 typecheck、JWT 集成、D1、并发发送、状态乱序、Playwright 和 clean-build gate。
- [ ] 依赖与 compatibility date 更新通过 Wrangler 真实运行时 smoke test。

## 8. 审计边界

本报告没有直接查询生产 D1，也没有读取或验证任何 secret 的实际值；生产数据结论来自后台公开给已登录管理员的只读聚合页面。没有发送测试邮件，因为真实外发是不可逆副作用。因此，发送缺陷是通过可达代码路径和缺失服务端闸门确认的，修复验收必须在 fake transport/隔离环境完成后再做极小范围生产验证。

## 9. 最终判定

**判定：未通过，需阻断性整改。**

项目已有不少正确方向的防线，例如压制名单、退订、熔断、Access 自测和部署前类型检查；但这些防线目前不是所有入口共享、也不是并发原子。对于会真实向外发邮件的 CRM，“大多数路径有检查”不够，必须做到：**唯一发送入口、数据库原子预留、稳定幂等键、明确状态机、可重现部署**。完成阶段 A 并通过并发验收后，才适合恢复自动发送；完成阶段 B/C 后，才适合把该版本标记为审计通过。
