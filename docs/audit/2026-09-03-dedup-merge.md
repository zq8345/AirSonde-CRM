# 生产数据变更存档：同网址重复线索合并（10 组）

- 时间：2026-09-03 ~15:33Z
- 授权：AirSonde 总工转 Joe 裁定（Joe 原话「按照你的建议来：留走得远的那条」）
- 执行者：AirSonde-CRM 窗
- 方式：`wrangler d1 execute airsonde_crm --remote --file`（⛔ 不走浏览器 `?confirm=write`）

## 规则

留**阶段走得远**的那条（sent > approved/queued > 有分 analyzed > 无分 analyzed/new），
同一阶段留**老的**（id 小）。分差不作判据（总工明示）。

## 执行前重读的此刻状态（与下表逐条相符，无漂移）

| 域名 | 留 | 删 |
|---|---|---|
| climatec.com | 1569 sent | 1672 approved |
| cooltech.com.sa | 1691 sent | 1864 approved |
| envea.global | 1616 analyzed | 1807 analyzed |
| enviroair-mvhr.com | 1596 approved | 1799 approved |
| instrumatics.co.nz | **1751 sent** | **1382 approved** |
| kimoinstruments.com | 1776 sent | 1542 analyzed |
| nts-oman.com | 1684 approved | 1851 analyzed |
| quatek.com.hk | 1544 analyzed | 1779 analyzed |
| saudisana.com | 1673 sent | 1827 approved |
| thehealthyhome.me | 1676 approved | 1830 approved |

⚠️ instrumatics 与总工最初的清单**相反**：干跑之后 1751 于 14:12 真发出了一封开发信（status→sent），
按同一条规则它才是"走得远"的那条。总工确认反转，且这样零迁移（1751 名下那封 email 不用改指向）。

## 干跑结论（只读，执行前）

- 10 个待删 id 的子表引用：`emails` 0 · `replies` 0 · `lark_bitable_map` 0 · `lead_analysis` 各 1（PK + ON DELETE CASCADE，随删）。时间线无独立表（从 emails/replies 聚合）。
- 待删行**独有字段：零** —— 每组邮箱相同、channels 有无相同、notes 全空、next_action 全空、bench_* 全空 ⇒ **不需要任何补写**。
- country 有 4 组两行不同（climatec US/BR · envea GB/US · enviroair NO/NZ · quatek RO/SG）：保留行取自己的值，不动。

## SQL（每条带 status + website 原值守卫）

```sql
DELETE FROM leads WHERE id=1672 AND status='approved' AND website='https://climatec.com';
DELETE FROM leads WHERE id=1864 AND status='approved' AND website='https://cooltech.com.sa';
DELETE FROM leads WHERE id=1807 AND status='analyzed' AND website='https://envea.global';
DELETE FROM leads WHERE id=1799 AND status='approved' AND website='https://enviroair-mvhr.com';
DELETE FROM leads WHERE id=1382 AND status='approved' AND website='https://instrumatics.co.nz';
DELETE FROM leads WHERE id=1542 AND status='analyzed' AND website='https://kimoinstruments.com';
DELETE FROM leads WHERE id=1851 AND status='analyzed' AND website='https://nts-oman.com';
DELETE FROM leads WHERE id=1779 AND status='analyzed' AND website='https://quatek.com.hk';
DELETE FROM leads WHERE id=1827 AND status='approved' AND website='https://saudisana.com';
DELETE FROM leads WHERE id=1830 AND status='approved' AND website='https://thehealthyhome.me';
```

执行结果：`Executed 10 queries · 20 rows written`（10 leads + 10 lead_analysis 由 CASCADE 带走）。

⚠️ 第一次执行撞到 `fetch failed`（网络）。**先只读复核确认一行未删**（leads 仍 1611、10 个待删 id 仍在）
才原路重试 —— ⛔ 不盲重试写操作。

## 只读复查

| 量 | 前 | 后 |
|---|---|---|
| leads | 1611 | **1601** |
| lead_analysis | 1611 | **1601** |
| 10 个待删 id 残留 | 10 | **0** |
| 10 个域名各自行数 | 2 | **各 1** |
| 孤儿 emails / replies / lead_analysis | — | **0 / 0 / 0** |
| 10 个保留行 | — | 全部在，status 与上表一致 |

⚠️ `emails` 299→**300**、`replies` 10→**12** 不是本次变更造成的（DELETE 不会新增行）：
是这 20 分钟里机器自己在跑（email 300 于 14:16 发出、301 于 15:35 失败；reply 11 是 13:00 的 DMARC 报告、
reply 12 见下）。**如实记下，不写成"emails 不变"。**

## 顺带记录的一件事（非本次变更）

`replies` id=12（2026-09-03 15:36:12）落在 lead 942 Engineeredservices 上，
`from_email='(邮件)'` · `subject='邮件回复'` · `content='（在 邮件 上回复了，由人工标记）'` · `is_auto=0`，
lead 942 随之 `status='replied'`。这是**详情页/列表「他回了」那条人工写路径**（`channelReply`，channel=email）的签名。
时间点与本窗在生产做 detail-v6 验收（openDetail(942) + 备注往返）重叠，但本窗脚本**没有任何** channelReply /
「他回了」调用（只有 openDetail 读取与 notes 的写入+还原）；同一浏览器此刻也在 Joe 手里。
⇒ **谁点的无法从库里判定**，此处只记事实，不下结论；若属误触，回退是写操作，等授权。

## 队列（总工已记，⛔ 不在本次）

发送链加**跨线索邮箱判重**：同一邮箱在 `emails` 里已有 `sent` 就跳过并标原因。
这次是 10 组，下次入库判重再漏一条，就又是同一个洞。
