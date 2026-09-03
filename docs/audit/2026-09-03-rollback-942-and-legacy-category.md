# 生产数据变更存档（第二批）：942 误触回退 + 23 行旧分类桶归一

- 时间：2026-09-03 ~15:5xZ
- 授权：AirSonde 总工（942 回退经 Joe 本人确认为误触；23 行归一为总工批准）
- 执行者：AirSonde-CRM 窗 · `wrangler d1 execute --remote --file`
- 同日第一批（10 组同网址重复合并）见 `2026-09-03-dedup-merge.md`

## 一、回退 Joe 误触的「他回了 · 邮件」（lead 942 Engineeredservices）

### 事实
`replies` id=12（2026-09-03 15:36:12）· `from_email='(邮件)'` · `subject='邮件回复'` ·
正文「（在 邮件 上回复了，由人工标记）」· `is_auto=0`，lead 942 随之 `status='replied'`。
这是 `channelReply`（channel=email）的写路径签名。第一批存档里我只记了事实、未归因；
**Joe 本人确认是误触**，总工授权回退。

### SQL（带原值守卫）
```sql
DELETE FROM replies WHERE id=12 AND lead_id=942 AND from_email='(邮件)' AND is_auto=0;
UPDATE leads SET status='sent' WHERE id=942 AND status='replied';
```
执行结果：`Executed 2 queries · 4 rows written`（1 行 replies + 1 行 leads，各带索引更新）。
⚠️ 第一次执行撞 `fetch failed`（网络）。**先只读复核**（942 仍 replied、id=12 仍在、replied 仍 2）
确认一行未动，才原路重试 —— ⛔ 不盲重试写操作。今天这是第二次撞同一种网络失败。

### 只读复查
| 量 | 前 | 后 |
|---|---|---|
| lead 942 status | replied | **sent** |
| replies id=12 | 1 行 | **0 行** |
| status='replied' 的线索数 | 2 | **1** |
| lead 942 的 replies 行数 | 1 | **0**（时间线上那条「收到回信」随之消失） |
| lead 942 notes / next_action | null | **null（未动）** |

## 二、23 行 `customer_category` 旧中文桶归一

### 判据先说清（审计窗报的列名是错的）
审计窗报「customer_type 旧中文串还剩 23 行」。**列错了**：
- `customer_type` 在 C5-13 之后存的是**中文自由描述**（customer_desc），旧抓取失败串 **0 行**，
  新串「无官网·无法判断」323 行 —— 我此前报的 259→0 仍然成立。
- 真正的 23 行在 **`customer_category`**（slug 列）。

### 成因（有据，不是猜）
23 行的 `analyzed_at` 全部落在 **2026-09-01 11:47–12:33**，即 C5-13 slug 化上线之前；之后再无新增。
写路径 `service.ts` 只写 `normalizeCustomerType()` 的返回值（永远是 8 个 slug 之一），
**产生不出中文桶** ⇒ 是**回填漏的**，不是回填后又写入的。

### 它们此前有害吗
不算错数据，是**口径不齐**：筛选侧 `categoryValuesFor(slug)` 会把旧桶一并捞（v8 补丁⑧g），
显示侧 `customerTypeLabel` 认不出**原样返回**（当年就是为这批写的：宁可显示「安装/集成」
也不谎报成「资料不足」）。归一之后这两条兼容路径仍留着，⛔ 不删。

### SQL（映射逐条抄自 `taxonomy.ts` 的 `LEGACY_CATEGORY_MAP`，单源）
```sql
UPDATE lead_analysis SET customer_category='integrator'  WHERE customer_category='安装/集成';
UPDATE lead_analysis SET customer_category='distributor' WHERE customer_category='经销/零售';
UPDATE lead_analysis SET customer_category='integrator'  WHERE customer_category='企业/IT';
UPDATE lead_analysis SET customer_category='unclear'     WHERE customer_category='其他';
UPDATE lead_analysis SET customer_category='unclear'     WHERE customer_category='船舶/海事';
UPDATE lead_analysis SET customer_category='unclear'     WHERE customer_category='房车/RV';
UPDATE lead_analysis SET customer_category='unclear'     WHERE customer_category='离网/偏远';
```
执行结果：`Executed 7 queries · 46 rows written`。
⚠️ 46 ≠ 23 是因为 `customer_category` 上有索引 `idx_analysis_category`，D1 把索引更新也计进 rows written
（23 行 × 2）。**如实记下，⛔ 不把 46 说成"改了 46 行"。** 后三条（船舶/房车/离网）库里本就 0 行，0 changes。

### 只读复查
| 量 | 前 | 后 |
|---|---|---|
| 枚举外的 customer_category | 23（其他 6 · 安装/集成 6 · 经销/零售 6 · 企业/IT 5） | **0** |
| lead_analysis 总行数 | 1601 | **1601（未增未减）** |
| 分布 | — | excluded 681 · unclear 468 · distributor 247 · integrator 144 · monitoring-service 32 · brand 17 · manufacturer-2nd-source 12 |

## 三、顺带只读读出的一条（不修，报给总工）

`emails` id=301（2026-09-03 15:35:29，lead 1504，kind=initial）`status='failed'`，
`error` 原文：

```
unknown | Error: Resend 422: {"statusCode":422,"name":"validation_error",
"message":"The `subject` field must be less than 2000 characters."}
```

⇒ 不是额度/鉴权问题：**AI 写出来的 subject 超过 2000 字符**被 Resend 拒了。
`errHuman` 把它归进 `unknown`，所以界面上只会说"发送失败"。⛔ 本单不修，报队列。
