// 四个引擎的**真实状态** —— 顶栏/机器房/任何解释面共用的**唯一口径**。
//
// ⭐⭐ 起因（Joe 2026-09-03 指认）：今日搜索 2500/2500 已经用满、**找客户彻底停了**，
//   而顶栏还在显示「● 自动·运行中」，**一个字都没说**。
//   ⇒ 它说了**一半真话**：总开关确实开着、发信确实还在跑，但四个引擎里有一个已经停了。
//   这就是本仓一路在治的那类病：**界面显示的和机器实际在做的不一致。**
//
// ⚠️⚠️ 为什么写在后端而不是前端拼：
//   `autoSendBlockedReason` 的注释早就写死了这条规矩 ——
//   「别让每个面各自拼一句：三处各拼各的，改了两处剩下那处就开始骗人」。
//   ⇒ 找客户/分析/收信这三个也走同一模式：**后端算，前端只显示**。
//   ⛔ 前端不许自己判断"预算用满了没"——那就是第二个真源。
//
// ⚠️ 判据纪律（今天刚栽过 `crossed_50_at`）：
//   🔴 **正常运行时不许有任何警告。** 一个正常运行时必定触发的告警等于没有告警，
//     而且比没有更坏 —— 它会消耗真实的排查成本（我们为它查了一整轮不存在的故障）。
//   ⇒ 每一条 `stopped` 都必须由**真值**推出，⛔ 不许写死文案、⛔ 不许"保险起见先报警"。

import { getSetting } from "./send";
import { COUNTRIES, BLACKLIST_GL, DEFAULT_COUNTRIES, getSerperUsage } from "./discover";
import type { Env } from "./index";

export interface EngineStatus {
  id: "discover" | "send" | "analyze" | "reply";
  label: string;
  /** true = 这个环节此刻**不在工作**。⚠️ 不含"总开关关着"——那是全局状态，另外说。 */
  stopped: boolean;
  /** 为什么停。⚠️ **每一条都注明取自哪个字段**（见各分支注释）。stopped=false 时为 null。 */
  reason: string | null;
  /** 这个环节是否**跟随总开关**。收信不跟随（Joe 定的语义：关的是嘴和手，不关耳朵）。 */
  followsMasterSwitch: boolean;
}

/**
 * 四个引擎此刻的真实状态。
 *
 * ⚠️ 只读：**不写任何设置、不发对外请求**（纯 D1 + 已有计数器）。
 *   这一条不是洁癖：状态函数一旦有副作用，"看一眼状态"就会改变被看的东西。
 */
export async function engineStatuses(env: Env): Promise<EngineStatus[]> {
  const autoOn = (await getSetting(env, "automation_enabled", "0")) === "1";

  // ── ① 找客户 ──
  //   真值来源：
  //     · 预算：getSerperUsage(env) → { usedToday, budget }（与 runDiscovery 里 `usedToday >= budget` 同一判据）
  //     · 国家：settings.search_countries（未设 = 全量，见 getSearchConfig 的三态）
  //     · 关键词：settings.active_keywords（未设 = 全部启用）
  let discover: { stopped: boolean; reason: string | null } = { stopped: false, reason: null };
  if (!autoOn) {
    discover = { stopped: true, reason: "自动模式是关的" };
  } else {
    const u = await getSerperUsage(env);
    if (u.usedToday >= u.budget) {
      // ⚠️ 与 discover.ts:573 `if (usedToday >= budget) { budgetStopped = true; break; }` **同一个判据**。
      //   ⛔ 别在这里另写一个阈值——那就是第二个真源。
      discover = { stopped: true, reason: `今日搜索预算用满（${u.usedToday}/${u.budget}），明天恢复` };
    } else {
      const ccRow = await env.DB.prepare("SELECT value FROM settings WHERE key='search_countries'").first<{ value: string }>();
      // ⚠️ 三态：行不存在 = 未设 = 全量；有值 = 按值；空串 = **真的一个都不选**。
      //   与 getSearchConfig 逐字同构 —— 那里改了这里也要改（⛔ 两处不许漂）。
      const picked = ccRow == null ? DEFAULT_COUNTRIES
        : String(ccRow.value || "").split(",").map((s) => s.trim().toLowerCase()).filter((x) => COUNTRIES[x] && !BLACKLIST_GL.has(x));
      if (picked.length === 0) {
        discover = { stopped: true, reason: "一个国家都没选" };
      } else {
        const kwEnabled = (await env.DB.prepare("SELECT COUNT(*) AS n FROM keywords WHERE COALESCE(archived,0)=0").first<{ n: number }>())?.n || 0;
        const akRow = await env.DB.prepare("SELECT value FROM settings WHERE key='active_keywords'").first<{ value: string }>();
        // 未设 = 全部启用（自维持不变式，见 C5-50）；有值 = 按值。
        const activeN = akRow == null ? kwEnabled
          : String(akRow.value || "").split("\n").map((s) => s.trim()).filter(Boolean).length;
        if (kwEnabled === 0 || activeN === 0) discover = { stopped: true, reason: "一个关键词都没勾" };
      }
    }
  }

  // ── ② 发信 ──
  //   ⚠️ 阻塞原因**复用后端既有的唯一来源** `autoSendBlockedReason`（熔断/单独关掉/总开关）。
  //     ⛔ 不在这里重写那三条判断。这里只**补上它不管的那一条**：今日额度用满。
  const { autoSendBlockedReason } = await import("./send");
  let sendReason = await autoSendBlockedReason(env);
  if (!sendReason && autoOn) {
    const lim = Number(await getSetting(env, "daily_send_limit", "0")) || 0;
    if (lim > 0) {
      const sentToday = (await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM emails WHERE status='sent' AND date(created_at)=date('now')"
      ).first<{ n: number }>())?.n || 0;
      if (sentToday >= lim) sendReason = `今日发信额度用满（${sentToday}/${lim}），明天恢复`;
    }
  }

  // ── ③ 分析打分 ──
  //   ⚠️ **队列为空不算"停了"** —— 那是"没活干"，不是故障。今天刚为"0 的两种含义"查过一整轮，
  //     ⛔ 别把"暂时没有待分析的线索"报成一个需要 Joe 处理的警告。
  //   ⇒ 只在**钥匙缺失**时报停（那才是他能处理、且不处理就永远不动的事）。
  const aiKeyMissing = !env.OPENROUTER_API_KEY;
  const analyze = !autoOn ? { stopped: true, reason: "自动模式是关的" }
    : aiKeyMissing ? { stopped: true, reason: "AI 钥匙没配（OPENROUTER_API_KEY）" }
    : { stopped: false, reason: null };

  // ── ④ 收信 ──
  //   ⚠️ 它**不跟随总开关**（Joe 定的语义：关的是机器的嘴和手，不关它的耳朵）。
  //     ⇒ 判断它时**绝不能**看 automation_enabled —— 那会让"关了自动模式"被报成"收信停了"，
  //       而那正是 Joe 最容易误解的地方。
  const imapKeyMissing = !env.LARK_IMAP_PASS;
  const replyFail = (await getSetting(env, "reply_fail_last", "")).trim();
  const reply = imapKeyMissing ? { stopped: true, reason: "收信钥匙没配（LARK_IMAP_PASS）" }
    : replyFail ? { stopped: true, reason: `上次收信失败：${replyFail.slice(0, 40)}` }
    : { stopped: false, reason: null };

  return [
    { id: "discover", label: "找客户", stopped: discover.stopped, reason: discover.reason, followsMasterSwitch: true },
    { id: "send", label: "发信", stopped: !!sendReason, reason: sendReason, followsMasterSwitch: true },
    { id: "analyze", label: "分析打分", stopped: analyze.stopped, reason: analyze.reason, followsMasterSwitch: true },
    { id: "reply", label: "收信", stopped: reply.stopped, reason: reply.reason, followsMasterSwitch: false },
  ];
}
