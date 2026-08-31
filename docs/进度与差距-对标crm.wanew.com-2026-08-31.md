# AirSonde-CRM 进度与差距（对标 crm.wanew.com）· 2026-08-31 · CRM 窗

> 一句话：**代码已经到位，差的是钥匙、入口、业务配置和数据。**
> 标注纪律：每条注明「已实测」或「待验」；读数注明测量时间（本仓 D1 现在读不了，见 §0）。

## 0. ⚠️ 当前有个环境阻塞（影响 C2-A）

`CLOUDFLARE_API_TOKEN` 环境变量里现在是一把 **User API Token**（C1 时期是 OAuth 登录）。
已实测：**Workers 面正常**（`deployments list` 可用），**D1 面全拒**（`d1 list` → Authentication error 10000；
`d1 execute --remote` → code 7403）。

⇒ **我现在既导不出备份、也读不了库**。C2-A 的红线是"备份没落地前不许删"，所以 **C2-A 卡住**，
等这把 token 加上 D1 权限（或恢复 OAuth 登录）。C2-B/C/D/E 不依赖 D1，可以照做。

## 1. 已完成（全部已实测，生产在跑）

| 项 | 状态 | 证据 |
|---|---|---|
| 整套代码搬迁（13k 行管线） | ✅ | fork 自 AI云端获客@e2d0ad0；与源仓主干实质同步（只差一个 README 提交，我们还多一个 accessjwt 模块） |
| 生产部署 + Access 门 | ✅ | crm.airsonde.com，匿名 302 + 三信号；活跃版本 08930706 |
| 新库 airsonde_crm | ✅ | 表数与源库对账 9==9 |
| 脱牌 / 浅色底 / 品牌 logo + favicon 七件 | ✅ | 逐元素对比度扫描 0 低对比；资产 9/9 与定稿源逐字节相同 |
| 发信结构性锁死 | ✅ | 无 key ⇒ 发信/通知/收信/搜索/AI 逐项 fail-closed（实测拒发原话） |
| 官网询盘管道（鉴权+幂等+来源标记+自测） | ✅ 代码 | 自测 15/15；⛔ 公开入口未开，尚未端到端 |
| 四份决策文档 | ✅ | 发信通道选型 / 客户画像终稿 / 预热计划 / accessjwt 评估 |

## 2. 差距清单 —— 要跑成 crm.wanew.com 那样，缺的是这些

### A. 钥匙（生产已配 secret = **0 个**，已实测 `wrangler secret list` 返回 `[]`）

| Secret | 缺了什么跑不起来 |
|---|---|
| `OPENROUTER_API_KEY` | AI 打分 + 写开发信 —— 整条 discover→score→draft 链断 |
| `RESEND_API_KEY` | 发信本身 |
| `RESEND_WEBHOOK_SECRET` | 退信/投诉回传 → 熔断器、自动压制名单**全瞎** |
| `SEARCH_API_KEY`（Serper） | 自动找客户 |
| `EMAIL_FINDER_API_KEY`（Hunter） | 自动补邮箱（可后补，非首发必需） |
| `LARK_IMAP_PASS` + `LARK_IMAP_USER` | 收客户回复 |
| `LARK_WEBHOOK_URL`(+`_SECRET`) | 飞书群通知 |
| `LARK_APP_ID`/`_SECRET`/`_VERIFICATION_TOKEN` | 多维表格镜像 + 飞书卡片按钮操作 |
| `INBOUND_TOKEN` | 官网询盘转发通道（代码已就绪） |

### B. 入口（Wanew 有三个域，我们只有一个）

- ✅ `crm.airsonde.com`（Access 门后，团队后台）
- ❌ **公开正门**（Wanew 是 `api.wanew.com`）：现在没有 ⇒ **退订链接、Resend webhook、落地页 /catalog、
  官网询盘转发** 四件全部不可达。发信前**必须**解决（退订链接不可达 = 合规红线）。
- ❌ workers.dev 已关（我们不需要，正门解决即可）

### C. 发信域（airsonde.net）

- ✅ MX/SPF/DKIM/DMARC 四件套已配（Lark 收信方向）
- ❌ **Resend 的 `send.airsonde.net` 三条记录未加**（MX + SPF + DKIM，落在子域，根域 Lark SPF 不动）
- ❌ 未预热（计划见 `docs/预热计划草案`，W0→W4+）

### D. 业务配置（settings 表 9 个键**全是机器记账**，业务项一个没配 —— 08-13 实测）

| 该配的 | 后果 |
|---|---|
| `customer_profile` | 现在吃代码默认（我的草稿），Joe 还没审 |
| `daily_send_limit` | 未配 ⇒ 守卫每天吼「上限没人配过」（Wanew 的 -90% 静默事故就出在这） |
| `company_name` / **`company_address`** | **地址是 CAN-SPAM 页脚必填**，没有它不能合规发信 |
| `selling_points` / `chat_script` | 吃代码默认（保守版，因认证/能力未经工厂书面确认） |
| `bcc_archive` / 自动化三开关 | 存档与自动通道 |

### E. 数据与渠道

- 线索：**没有一条是 AirSonde 的目标客户**。库里那批是上游 Wanew 垂直（NMEA 海事 / rvwithtito 房车）
  被 cron 目录抓取灌进来的。我 08-12 实测 242 条，总工 08-31 报 261 条 —— **数字在长**（每 6 小时一轮）。
  ⚠️ 我此刻读不了库（§0），261 这个数是引用总工的，不是我复测的。
- 打分 0 / 邮件 0 / 回复 0（08-13 实测）
- 关键词：✅ 20 个 IAQ 词已在库（我的草稿，已生效）
- ❌ **没有 AirSonde 自己的权威目录源**。Wanew 有 NMEA + rvwithtito 两个（还带来源背书逻辑）。
  IAQ 侧要找对应物（暖通/楼控行业协会名录、展会参展商名单、B2B 目录）——这是"自动找客户"质量的关键输入。

### F. 代码侧仅剩两项（其余已同源）

- `accessjwt` 未接线（模块已在仓、自测 14/14；评估结论：随发信单同批做，AUD 已捕获）
- 两个既有缺陷待裁：搜索长串必 500（生产 D1 已复现）、目录抓取绕过零密钥锁死

## 3. 差距 ↔ C2 派单 的对应

| 差距 | C2 覆盖 |
|---|---|
| E 错源数据 + 目录抓取绕锁 | **C2-A**（清库换源）⚠️ 被 §0 卡住 |
| D 公司地址 / 发件人身份 | **C2-B** |
| 「未配置被当故障吼」 | **C2-C**（这正是 Joe 说的 D「老故障」观感根子） |
| 首页看不懂 | **C2-D** |
| 模型 ID 存在性 + 点火 runbook | **C2-E** |
| **A 钥匙五把** | C2 说了「钥匙没给，到位前做不依赖钥匙的部分」——**仍是首要外部阻塞** |
| **B 公开正门** | ❗ C2 未提。发信/询盘/退订都要它，建议随点火单一并定 |
| **C Resend DNS + 预热** | ❗ C2 未提（runbook 里写清楚，执行仍需 Joe） |
| **E 缺 IAQ 目录源** | ❗ C2 未提。清掉 Wanew 源之后，自动找客户只剩关键词搜索这一条腿 |
| F accessjwt 接线 | ❗ C2 未提（已挂账，随发信单） |

## 4. 一句话结论

**代码已经是 crm.wanew.com 的同一套（还多了两块）；剩下的全是"接上外部世界"的活：
五把钥匙、一个公开正门、一套发信域记录、一批业务配置、一个属于 IAQ 的线索来源。**
钥匙到位后，从"能发第一封"到"跑成 Wanew 那样"的路径已经写死在
`docs/发信通道选型` + `docs/预热计划草案` + 本单 runbook 里。
