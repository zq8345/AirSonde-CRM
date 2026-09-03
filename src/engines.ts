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

/**
 * ⭐⭐ C5-55：**管线每个环节用了什么工具** —— Joe 的原话：
 *   「涉及到工具使用的都放在这里，**我好知道哪个环节使用了什么工具**」
 *
 * 🔴 它**不是**"钥匙清单"。原来那张卡只列了需要钥匙的 8 项，而管线里有几个环节
 *   **根本没出现在上面**（抓官网 / 补邮箱 / 目录源），于是留白让人以为漏了。
 *   ⇒ **"这一环不用外部工具"本身就是答案，必须写出来。**
 *
 * ⭐ 这张表直接回答了 Joe 专门问过的一个问题：**抓官网到底是不是 Serper？**
 *   实证：`service.ts` → `scrape.ts` 的 `scrapeSite()`，**自研 fetch，与 Serper 无关**。
 *
 * ⚠️ 排序按**管线真实流程**，⛔ 不按"有没有配钥匙"。
 * ⚠️ 结构是 `{环节, 工具, 状态}` 三段式，⛔ 不是"每行一个钥匙" ——
 *   补邮箱那单会加进 DeepSeek 提取，那时它是**同一环节的第二个工具**，这个结构容得下。
 */
export interface PipelineTool {
  /** 管线环节（按真实流程顺序） */
  step: string;
  /** 用的什么工具。自研的写「自研抓取」。 */
  tool: string;
  /** ok=在用 · none=不需要外部工具 · missing=缺钥匙 · idle=有实现但没启用 */
  state: "ok" | "none" | "missing" | "idle";
  /** 补充说明（缺的钥匙名 / 模型 id / 为什么 idle）。⛔ 不写单价——价格会过期，而过期的价格比没有更坏。 */
  note: string;
  /** 是否零成本（只标零成本的那几个，让他一眼看出哪些环节不花钱） */
  free: boolean;
}

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
 * 管线每个环节用了什么工具。**按真实流程顺序**（对着 fastTick / scheduled 的步骤点过一遍）：
 *   找客户 → 抓官网 → AI 评分 → AI 写信 → 补邮箱 → 发信 → 收信 → 通知 →（目录源）
 *
 * ⚠️ 全部从真源推：服务名取 `CAPABILITIES.service`、模型名取 `scoreModel/emailModel`、
 *   目录源取 `directorySourcesEnabled()`。⛔ 零写死。
 */
export async function pipelineTools(env: Env): Promise<PipelineTool[]> {
  const { CAPABILITIES, missingKeys } = await import("./ignition");
  const { scoreModel, emailModel } = await import("./openrouter");
  const { directorySourcesEnabled } = await import("./discover");
  const cap = (id: string) => CAPABILITIES.find((c) => c.id === id)!;
  // 一把钥匙的"配没配"—— 与点火面板同一判据，⛔ 不另写 `if (!env.XXX)`
  const okOf = (id: any) => missingKeys(env, id).length === 0;
  const missOf = (id: any) => missingKeys(env, id).join(" + ");

  const ext = (step: string, id: any, tool?: string, note = ""): PipelineTool =>
    okOf(id)
      ? { step, tool: tool || cap(id).service, state: "ok", note, free: false }
      : { step, tool: tool || cap(id).service, state: "missing", note: missOf(id), free: false };

  return [
    ext("找客户（搜公司）", "search"),
    // 🔴 Joe 专门问过这一条：**抓官网到底是不是 Serper？** 不是。
    //   实证链路：service.ts → scrape.ts 的 `scrapeSite()`，自研 fetch，零外部服务。
    { step: "抓官网（读网站内容）", tool: "自研抓取", state: "none", note: "直接读公司官网，不经过任何第三方", free: true },
    ext("AI 评分", "ai", undefined, scoreModel(env as any)),
    ext("AI 写开发信", "ai", undefined, emailModel(env as any)),
    // 补邮箱：Hunter 是**可选增强**，主路径是自研抓联系页 ⇒ 两个工具同属一个环节
    { step: "补邮箱（找联系方式）", tool: "自研抓取", state: "none", note: "抓 8 条常见联系页路径", free: true },
    okOf("emailfinder")
      ? { step: "补邮箱（兜底）", tool: cap("emailfinder").service, state: "ok" as const, note: "官网找不到时才用", free: false }
      : { step: "补邮箱（兜底）", tool: cap("emailfinder").service, state: "missing" as const, note: missOf("emailfinder"), free: false },
    ext("发开发信", "send"),
    ext("收客户回复", "reply"),
    ext("飞书群通知", "notify"),
    ext("飞书应用机器人", "appbot"),
    ext("官网询盘接入", "inbound"),
    // ⚠️ 判据是函数不是写死：`ENABLED_DIRECTORY_SOURCES` 现在是空数组 ⇒ 一个源都没有，从没抓过。
    directorySourcesEnabled()
      ? { step: "目录源采集", tool: "自研抓取", state: "ok" as const, note: "免费线索源", free: true }
      : { step: "目录源采集", tool: "自研抓取", state: "idle" as const, note: "未配置任何目录源，这一环从未运行", free: true },
  ];
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
  // 🔴 判据是 `reply_fail_streak`（**连败**），⛔ **不是 `reply_fail_last`**。
  //   我第一版用了 `reply_fail_last` —— 它**成功之后不会被清掉，只作证据保留**
  //   （`index.ts:4061` 原话：「成功后…才亮（reply_fail_last 保留为证据，横幅不再拿它当判据），
  //   成功一次即清零」）。⇒ 拿它当判据的后果是：**一次失败之后永远显示"收信已停"**，
  //   哪怕后面每一轮都成功。那正是我这一单要消灭的那种告警（正常运行时恒亮）。
  //   ⚠️ 生产上当场撞到了：`reply_fail_last` 停留在 06:00 的一条旧记录，而收信其实是好的。
  //   ⭐ 教训：**"最后一次失败"和"现在是不是坏的"是两个不同的量。** 同一个仓里已经有人
  //     踩过并写下了正确判据（streak），我没先去看它就自己选了字段。
  const failStreak = Number(await getSetting(env, "reply_fail_streak", "0")) || 0;
  const failLast = (await getSetting(env, "reply_fail_last", "")).trim();
  const reply = imapKeyMissing ? { stopped: true, reason: "收信钥匙没配（LARK_IMAP_PASS）" }
    // 总工裁定（2026-09-03）：阈值 ≥2 —— 与收信循环处「UI 横幅连败（≥2 才亮）」的注释一致，飞书告警仍 ≥3。
    //   生产实证：Lark IMAP 单次瞬时 NO internal server error 让 streak=1，顶栏就报「收信已停」—— 正常运行时会亮的告警等于没有告警。
    : failStreak >= 2 ? { stopped: true, reason: `连续 ${failStreak} 次收信失败${failLast ? `：${failLast.slice(0, 40)}` : ""}` }
    : { stopped: false, reason: null };

  return [
    { id: "discover", label: "找客户", stopped: discover.stopped, reason: discover.reason, followsMasterSwitch: true },
    { id: "send", label: "发信", stopped: !!sendReason, reason: sendReason, followsMasterSwitch: true },
    { id: "analyze", label: "分析打分", stopped: analyze.stopped, reason: analyze.reason, followsMasterSwitch: true },
    { id: "reply", label: "收信", stopped: reply.stopped, reason: reply.reason, followsMasterSwitch: false },
  ];
}
