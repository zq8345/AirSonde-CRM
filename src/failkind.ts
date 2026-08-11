// 失败原因的**唯一判据表** —— 只此一处，不许散在各个 catch 里。
//
// 为什么必须单点：2026-07-28 我们同时踩了两个形状一样的坑 ——
//   · `timeout-or-network`：为了分类，**把平台错误伪装成了业务错误**
//     （真相是 `Too many subrequests`，而我们照着"超时"去调了 TIMEOUT，白改一轮）
//   · Admin 那边 `catch → "commit failed"`：为了给用户友好措辞，**把唯一的线索丢了**
//   判据散落在各处时，**漏掉一个平台错误，它就会伪装成业务错误** —— 与那次一模一样。
//   放在一处，至少可以被审、被 grep、被一次性补全。
//
// ⚠️⚠️⚠️ 通则（2026-08-01 定，适用于本仓所有"报告故障"的代码）：
//
//   **任何报告故障的通道，不能与它所报告的故障共享同一种会耗尽的资源。**
//   换句话说：**"出事的时候，通知你出事的那条路自己也死了" 是结构缺陷，不是运气不好。**
//
//   本仓已确认的两个实例（同一形状，一个已修一个未修）：
//     ① ✅ 已修：起草失败落库 —— `send.ts:recordDraftFailure` **只用 D1、不发 fetch**。
//        而子请求上限只掐 fetch（D1 不吃那 50，生产探针实测过）⇒ 哪怕整轮已越线、
//        每个 fetch 都在抛错，这一行照样写得进去。
//     ② ❌ 未修：飞书告警 —— `notify.ts:larkSend` 走 `fetch`，与它要报告的
//        「子请求耗尽」**共用同一个 50**。排在越线之后的告警（熔断 / 上限未配置 /
//        停摆 / 日报）一律发不出去，而 `larkSend` 失败只返回 `{ok:false}` **不抛**
//        ⇒ 静默。生产实测：`4-简报告警` 每轮 32 次 fetch 全在越线之后。
//        ⚠️ 目前只有 step 0 的「收回复失败」告警发得出去 —— **那是排序的运气，不是设计**：
//        补邮箱哪天挪到它前面，这条也会跟着哑。
//
//   → 新写任何告警/落库/上报之前先问一句：**它依赖的资源，会不会正是出问题的那个？**
//
// ⚠️⚠️ 最重要的一条设计：**`unknown` 是合法结果，且必须原样保留 raw。**
//   关键词表**一定会漏**（今天这张表就是从零件里现攒的）。漏掉的时候，
//   正确的退化是「**未知 + 原文**」，**绝不能退化成某个看起来像答案的业务分类**。
//   "我不知道原因" 比 "原因是超时" 有用得多 —— 后者会把人引向错误的修法。

export const PLATFORM_PATTERNS: { kind: string; re: RegExp }[] = [
  // 实证来源：2026-07-28 生产 cron 原话
  //   "Too many subrequests by single Worker invocation. To configure this limit, refer to …"
  { kind: "subrequest-limit", re: /too many subrequests/i },
  { kind: "cpu-limit",        re: /exceeded cpu|cpu time limit|script exceeded time/i },
  // Workers Free 每日 10 万请求 → Error 1027
  { kind: "daily-limit",      re: /daily (request )?limit|error 1027/i },
  { kind: "rate-limit",       re: /rate.?limit|too many requests/i },
  // 实证来源：2026-07-28 Serper 原话 {"message":"Not enough credits","statusCode":400}
  { kind: "quota",            re: /not enough credits|quota exceeded|insufficient (credit|quota|balance)/i },
];

export interface FailKind {
  /** platform:<x> = 平台/额度层；timeout = 我们自己的 AbortController 掐的；unknown = **表没覆盖到** */
  kind: string;
  name: string;
  /** 运行时/服务商**原话**。永远保留，**不做归一化** —— 归一化会抹掉最有信息量的那部分。 */
  raw: string;
}

export function classifyError(e: unknown): FailKind {
  const name = String((e as any)?.name || "");
  const raw = String((e as any)?.message || e || "");
  const hit = PLATFORM_PATTERNS.find((p) => p.re.test(raw));
  if (hit) return { kind: `platform:${hit.kind}`, name, raw };
  // AbortError = 我们自己的超时控制器触发的，那才是**真超时**（可以靠调 TIMEOUT 解决）
  if (name === "AbortError") return { kind: "timeout", name, raw };
  return { kind: "unknown", name, raw };   // ⚠️ 不猜。原文照带。
}

/** 落库用的一行字符串：`kind | name: 原话`。截长度但**不改措辞**。 */
export function failText(f: FailKind, max = 500): string {
  return `${f.kind} | ${f.name ? f.name + ": " : ""}${f.raw}`.slice(0, max);
}

/**
 * 安全读响应体 —— **读失败时绝不返回空串**。
 *
 * 病史（2026-07-28）：`send.ts` 里是 `await res.text().catch(() => "")`。
 *   读体失败时 `t` 变成空串，于是错误落成 `"Resend 500: "` ——
 *   **字段有值、格式正确、内容为零。**
 *   ⚠️ 这比"没有 error 字段"更坏：没有字段时你知道自己不知道；
 *      **有一个空字段时，你会以为原文就是空的，而不会想到是读取失败。**
 *   一个为了"别在这里崩"加的 `.catch`，**把"我没读到原因"变成了"原因是空的"**。
 */
export async function readBodySafe(res: Response): Promise<string> {
  try {
    const t = await res.text();
    return t === "" ? "<body empty>" : t;      // 真空 body 也要说出来，别和读失败混
  } catch (e: any) {
    return `<body unreadable: ${String(e?.message || e)}>`;
  }
}
