# 2026-09-04 · `replies.source` 一次性历史回填（生产数据变更）

**授权**：AirSonde-总工，逐项批准（先批 1 行，追加批准其余 15 行）。
**范围**：`replies` 全表 16 行，只动 `source IS NULL` 的行。⛔ 未触碰任何其它表、任何其它列。

## 授权依据（重要：写清楚哪条才是证据）

✅ **依据 = 16 行逐条拉出来看过**，每一行的 `from_email` 都在下面的表里。这是**穷举清点**。

⚠️ 另一条理由**故意不作为主依据**：「`replies` 全仓只有两个 INSERT 写入方（grep 确认）」——
`grep` 查的是**此刻的代码**，证明不了历史行是谁写的（早先的版本、一次性脚本、手工 `d1 execute`
都不会留在今天的代码里）。**被回填的是数据，不能拿一条关于代码的断言当主论据。**（总工点名纠正。）

⭐ 与"⛔ 不用推断"那条纪律的边界：**运行时判据 vs 一次性历史回填**。
用 `from_email` 里有没有 `@` 去判来源，作为**运行时**谓词是不可接受的（坏了没人会发现，
它只会安静地把某一类算错）；作为**一次性回填**是可接受的，因为它当场穷举、当场逐行核对，
而且以后不再运行。**同一个 `@`，一个不能用一个能用，区别在于它要活多久。**

## 前置核对（读数 `2026-09-04 08:42:09`）

| 量 | 值 |
|---|---|
| `replies` 总行数 | 16 |
| `source IS NULL` | 16 |
| 其中 `from_email` 不含 `@` | **1** |
| 其中 `from_email` 含 `@` | **15** |

与执行前的独立清点完全一致 ⇒ 放行。

## 执行

```sql
UPDATE replies SET source='manual'
 WHERE source IS NULL AND COALESCE(from_email,'') NOT LIKE '%@%';
UPDATE replies SET source='imap'
 WHERE source IS NULL AND COALESCE(from_email,'') LIKE '%@%';
```
结果：`Executed 2 queries · 16 rows written`。

## 逐行存档（⛔ 不做汇总——那次清点是这次授权的全部依据）

| id | from_email | is_auto | lead_id | 回填后 source |
|---:|---|:---:|---:|---|
| 1 | `joe@airsonde.com` | 0 | 263 | `imap` |
| 2 | `donotreply@conditionedair.com` | 1 | 547 | `imap` |
| 3 | `no-reply@us-1.mimecastreport.com` | 1 | — | `imap` |
| 4 | `postmaster@amazonses.com` | 1 | — | `imap` |
| 5 | `noreply-dmarc-support@google.com` | 1 | — | `imap` |
| 6 | `contact@aom.sg` | 1 | 1135 | `imap` |
| 7 | `noreply-dmarc@zoho.com` | 1 | — | `imap` |
| 8 | `no-reply@uk-1.mimecastreport.com` | 1 | — | `imap` |
| 9 | `no-reply@us-1.mimecastreport.com` | 1 | — | `imap` |
| 10 | `noreply-dmarc-support@google.com` | 1 | — | `imap` |
| 11 | `dmarcreport@microsoft.com` | 1 | — | `imap` |
| 13 | `(邮件)` | 0 | 1135 | **`manual`** |
| 14 | `no-reply@eu-2.mimecastreport.com` | 1 | — | `imap` |
| 15 | `dmarcreport@aruba.it` | 1 | — | `imap` |
| 16 | `no-reply@uk-1.mimecastreport.com` | 1 | — | `imap` |
| 17 | `no-reply@us-1.mimecastreport.com` | 1 | — | `imap` |

⚠️ id 12 不存在 —— 09-03「942 误点回退」时按授权删掉的那一行（见
`2026-09-03-rollback-942-and-legacy-category.md`），**不是这次回填漏了**。

## 这次回填能被看见的两个效果

1. `unknown_source_rows`：**16 → 0**。⚠️ 回填**之前**这个数在生产上真的显示过一次
   （看板「回信都是些什么信？」卡里：「另有 16 条回信来源没标」）—— 那道显示因此是**两向都验过**的，
   ⛔ 不是只见过它沉默的样子。
2. AOM 那条线索（1135）的归类：`unknown_only` → **`manual_only`**。
   ⇒ 这条回填**不只是让一个警告归零**，它让那条线索第一次被正确归类：
   **「人工标记 · 没有收到信」**，而它正是 B−A 那个差额本身。

## ⛔ 一件**没有**做的事

**没有**给 `source` 加 `NOT NULL` 约束。总工裁定：D1 加约束要重建表，代价远大于收益；
而且已经有更好的闸 —— `unknown_source_rows` 恒算恒返回并在 >0 时显示出来，
**将来哪个写入方忘了给值，它会自己冒出来**。
> 🔴 **一个会说话的计数器，比一个会拒绝的约束更有用** —— 约束只在写的那一刻响一次，计数器天天都在。
