# 「已联系那 345 家还没按新标准打分」—— 前提不成立（2026-09-05 核）

派单：`airsonde-dispatch/crm-recontacted-rescore/SPEC.md`
Joe 原话：「把已联系列表的里面的所有信息按照新标准重新分析打分一遍，其他信息都已经重新分析打分了，就差已联系页面了。需要把自动发信关掉不？」

## 结论

**不用刷，也不用关自动发信。** 已联系这批今早已经跟其余各态**一起**刷完了 —— 它不是"漏下的一格"。

## 证据

### ① 全库零条陈旧

重扫窗口 `rescan_started_at = 2026-09-05 04:21:28` → `rescan_done_at = 09:53:16`。

| status | 家数 | 缺分析 | 重扫后刷过 | 仍陈旧 |
|---|---|---|---|---|
| analyzed | 1249 | 0 | 1249 | **0** |
| **sent（已联系）** | **356** | 0 | **356** | **0** |
| approved | 255 | 0 | 255 | **0** |
| ignored | 38 | 0 | 38 | **0** |
| bounced | 5 | 0 | 5 | **0** |
| replied | 1 | 0 | 1 | **0** |

已联系那批的 `analyzed_at` 落在 `04:21:53 – 09:43:10`，全部在重扫窗口内。

### ② 为什么 sent 也被刷到了（不是巧合，是取数写法）

`/api/rescan/batch`（index.ts:4586）的取数**不筛状态**：

```sql
SELECT l.* FROM leads l LEFT JOIN lead_analysis a ON a.lead_id = l.id
 WHERE (a.lead_id IS NULL OR a.analyzed_at IS NULL OR a.analyzed_at < ?)
```

只有 `/api/rescan/start` 的**重置**筛状态（`RESCAN_RESET_STATUSES` 不含 sent）。
⇒ sent 属于「只刷新组」：**analysis 换新、status 纹丝不动**（index.ts:4866 已写明依据）。

⚠️ 易混点：另一个端点 `/api/admin/rescore-taxonomy` 的 `RESCORE_SKIP_STATUSES` **确实**跳过 sent（index.ts:1598）。
那是 C5-13 分类重刷，不是今早跑的那条。**两条路的覆盖面不同，别拿它去推今早刷没刷。**

### ③ 打的确实是"当前标准"

- `settings.customer_profile` 现值 **895 字符**，与 `scratchpad/profile_after.txt`（2026-09-05 04:01:06 UTC 写）
  **首 40 / 末 40 字符逐字相同**，长度相同 ⇒ 画像自 04:01 起未再变，早于重扫 20 分钟落库。
- 打分提示词/模型自 04:21 之后**无提交**（其间四个 commit `efaa04e`/`419b77b`/`ba02d58`/`cdf349c` 全是界面）。
- `lead_analysis.model` 分布（sent 356 家）：

| model 标记 | 家数 |
|---|---|
| `deepseek-v4-flash-0731（重扫·只刷新分数）` | 336 |
| `deepseek-v4-flash-0731（打分；开发信在发送时生成）` | 14 |
| `fetch-failed(重扫·抓不到，旧分数已作废)` | 8 |

- 抽样理由文本用的是**新画像的词**（"ODM贴牌采购"/"IAQ 贴牌采购方"/"属于竞品"）与 C5-13 八类 slug
  （brand / distributor / excluded / unclear）⇒ 是真重打，不只是时间戳前移。

### ④ 已联系分数分布（刷完后的现状）

≥80：**147** · 60–79：**145** · 40–59：**18** · <40：**38** · 未打分：**8** ｜ 合计 **356**

## 那"要不要关自动发信"呢——按证据，即使真要单独刷 sent 也不用关

逐条枚举发信管道消费什么：

1. **初次发信** `SENDABLE_WHERE`（index.ts:476）要求 `l.status='approved'` ⇒ sent 不在池内。
2. **自动批准** `autoApproveRound`（index.ts:5063）只取 `l.status='analyzed'` ⇒ sent 进不来。
3. **重打分路径上所有写 `leads.status` 的语句都带守卫**，逐条核过，没有一条匹配 `'sent'`：
   - `analyzeLead` 推进：`WHERE id=? AND status='new'`（service.ts:284）
   - 抓失败到上限：`WHERE id=? AND status='new'`（service.ts:105）
   - 两处「归位」：`WHERE id=? AND status='approved' AND human_approved=0`（service.ts:117、311）
   ⇒ 一条 sent 走完重打分，**结构上出不了「已联系」格**。
4. **跟进链** `sendFollowupBatch`（send.ts:785）的 WHERE **完全不消费 `match_score`**
   ⇒ 重打分不会让任何人多收/少收一封跟进信。
5. 唯一会写 `leads` 的副作用是"邮箱为空时回填"（service.ts:226）。但跟进链
   `JOIN emails e ON e.lead_id=l.id AND e.status='sent'` ⇒ 手动触达（bench）那批没有 emails 行，
   回填了邮箱也进不了跟进链。**这条也是封死的。**

⚠️ **但界面上的「重扫全部」按钮仍然要求先关自动发信** —— 那个闸（index.ts:4557）防的是
`approved/queued` 被打回 `new` 再重新升过 60 分线被立刻发出去，**不是防 sent**。两件事别混。

## 🔴 顺带发现（本单未修，只报告）

### A. 跟进链**不看**「自动发信」开关 —— 关了它照样发（已实证）

`hourlyTick` 3.5 步（index.ts:5621-5628）**没有 `autoSendEnabled` 检查**，
而它上面第 5610 行的日志却写着「跟进步骤会照此跳过」—— **日志说了一件代码没做的事**。

生产实证（2026-09-05）：`auto_send_enabled` 从 04:08:47 关到 15:09:32（`auto_send_resumed_at`），
其间 **27 封跟进信照常发出**：

| 时刻 | 封数 |
|---|---|
| 14:02–14:05 | 11 |
| 15:01–15:06 | 16 |

两簇都贴着整点 ⇒ 整点班干的，不是人手点的。且 15:05 一分钟内 7 封，
`send_interval_seconds=30` 对它**完全不生效**（与"间隔管的是批不是封"同一个根，见队列第 3 条）。

⇒ **对 Joe 的含义**：「把自动发信关掉」目前**不等于**"机器停止发信"。这一条独立于本单，建议单独派。

### B. 界面上一处都不显示 `analyzed_at`

全前端 grep `analyzed_at` 只命中一行注释。列表和详情页**都不显示"这条什么时候被分析的"**
⇒ Joe 在界面上**无从判断某一页刷没刷过**。这是"就差已联系页面了"这个印象最可能的来源。

### C. 已联系里有 8 家现在显示「—」（未打分）

重扫抓不到官网 ⇒ 按重扫语义旧分数作废置 NULL（`fetch_fail_count=3`）：
Zefon(#287) · Ibc(#306) · Traceheatingsupplies(#395) · Nationalairwarehouse(#458) ·
2jsupply(#459) · Nassguard(#467) · Globalmechanical(#1436) · Controlco(#1483)

### D. 数字对不上：派单写 345，实际 356

差的 11 家是重扫期间新发出去、因而进了 sent 的（14 家标着「打分；开发信在发送时生成」）。
