// P3 发信：解析 AI 开发信 → 加退订/地址页脚 → 调 Resend → 状态回写 D1 → 每日限量
import type { Env } from "./index";
import { writeFollowup, writeWarmFollowup } from "./openrouter";
import { getProfile, ensureDraft } from "./service";
import { pool, RoundBudget } from "./pool";
import { classifyError, failText, readBodySafe, type FailKind } from "./failkind";

const RESEND_URL = "https://api.resend.com/emails";

/** CAN-SPAM 页脚必填的实体地址 —— **单一真源**（index.ts 的设置端点也从这里取，别两处各写一份）。
 *  值取自官网已公开的联系地址（airsonde-web/src/data/site-content.json → contact.address），
 *  两处保持一致：页脚地址与官网对不上，收件人第一反应是"这封信是假的"。
 *  ⚠️ Joe 在后台「发信设置」填了就以库里的为准；这里只是**没配时的正确默认**，不是硬编码兜底。 */
export const DEFAULT_COMPANY_ADDRESS =
  "AirSonde, No. 62, Baotian 1st Road, Xixiang Street, Bao'an District, Shenzhen, Guangdong, China";

// ---- 通用 settings 读写 ----
/**
 * 幂等补列 `emails.error` —— 存**服务商/运行时原话**，不存我们的措辞。
 * 沿用本仓既有先例（reply-inbox.ts:ensureReplyColumns），**不需要人工跑 DDL**。
 * ⚠️ **老数据不回填**：89 条历史失败保持 NULL = "未知"。
 *    **"未知"比"猜的"诚实 —— 回填等于伪造证据。**
 * ⚠️ 每次发送尝试都是 `INSERT ... 'queued'` **新开一行**（send.ts 已核实，且数据交叉验证：
 *    67 家的 failed 行与 sent 行并存）→ **每行拥有自己的 error，不存在单槽覆盖**。
 */
let emailColsEnsured = false;
export async function ensureEmailColumns(env: Env): Promise<void> {
  if (emailColsEnsured) return;
  try { await env.DB.prepare("ALTER TABLE emails ADD COLUMN error TEXT").run(); } catch { /* 已存在=正常 */ }
  emailColsEnsured = true;
}

export async function getSetting(env: Env, key: string, def = ""): Promise<string> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? def;
}
export async function setSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).bind(key, value).run();
}

// ---- 两个自动化开关：**单一真源** -------------------------------------------
// 🔴 C6/R1（审计 2026-08-31）：默认值 "1" → **"0"**。
//   全仓纪律都是 fail-closed（无 key 不发信、空名单拒绝全部、DEV_BYPASS 误配即停服），
//   唯独**最不可逆的那个动作**（给真人发冷邮件）默认是开的。
//   实况佐证：钥匙落地那天生产 settings 里**根本没有这一行** ⇒ 全靠代码默认 ⇒ 自动发信当时是**开着的**，
//   只差一条已批准线索就会真发出去（当时靠抢写一行显式 0 拦住）。
//   ⚠️ 而这仓刚刚经历过一次清库 —— **一行可删的数据不是安全边界。**
//
// ⚠️ 为什么做成函数而不是改那 10 个字面量：改 9 处漏 1 处，漏的那处照样会自动发信，
//   **而且没有任何东西会报错**。这仓已为"多处各读各的"付过两次学费
//   （daily_send_limit 静默砍到 10 封/天；模型 id 的 10 处兜底）。
//   "默认开还是默认关"是**一个事实**，就该只有一个地方说了算。
export async function autoSendEnabled(env: Env): Promise<boolean> {
  return (await getSetting(env, "auto_send_enabled", "0")) === "1";
}
export async function autoApproveEnabled(env: Env): Promise<boolean> {
  return (await getSetting(env, "auto_approve_enabled", "0")) === "1";
}

/**
 * 起草阶段（AI 写信）失败时**建一行失败记录**。
 *
 * 为什么必须建行而不是只返回错误：发送路径上的失败分两段 ——
 *   · `deliverEmail` **之后**失败：行已经建好了，只要 UPDATE 就有痕迹（已有逻辑）
 *   · `deliverEmail` **之前**失败（AI 写信抛错）：**根本没有行可以 UPDATE** ⇒ 完全无痕
 * 生产实证（2026-08-01）：跟进连续 4 天全军覆没，`emails` 表 07-28 之后 0 行。
 *
 * ⚠️⚠️ **记录这条路必须能在"它所记录的那种故障"下存活。**
 *   这里只用 D1，不发任何 fetch —— 而子请求上限只掐 fetch（`/api/diag/d1-subrequest-probe`
 *   在生产实测过 D1 不吃那 50）。所以哪怕整轮 cron 已经越线、每个 fetch 都在抛错，
 *   这一行**照样写得进去**。如果记录本身要发 fetch，它就会和被记录的故障同归于尽。
 *
 * ⚠️ 不吃发信配额：所有配额/触达/熔断口径都限定 `status='sent'`（已逐条核对
 *   coldSentToday / autoSentToday / sentToday / touched / 熔断窗口），
 *   幂等与去重是 `IN ('sent','queued')` ⇒ **failed 行不挡下一轮重试**，正是我们要的。
 */
async function recordDraftFailure(env: Env, leadId: number, kind: "initial" | "followup", e: unknown): Promise<FailKind> {
  const f = classifyError(e);
  try {
    await ensureEmailColumns(env);
    await env.DB.prepare(
      "INSERT INTO emails (lead_id, kind, status, subject, error) VALUES (?, ?, 'failed', ?, ?)"
    ).bind(leadId, kind, `（未生成：${f.kind}）`, failText(f)).run();
  } catch (err) {
    // 记录失败不能反过来拖垮发送本身；但**必须出声**，否则又是一层静默
    console.error(`recordDraftFailure #${leadId} 落库失败:`, err, "| 原始失败:", failText(f, 200));
  }
  return f;
}

/**
 * 今天**失败**的发信行（与 `sentTodayBreakdown` 配对：一个数发出去的，一个数没发出去的）。
 * ⚠️ 看板上任何"今天发了什么"的说法都必须由这两个数派生 ——
 *    写死的说明文字会在系统坏掉时继续说"一切正常"。
 */
export async function failedTodayBreakdown(env: Env): Promise<{ total: number; initial: number; followup: number }> {
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN COALESCE(kind,'initial')='initial' THEN 1 ELSE 0 END) AS initial,
            SUM(CASE WHEN kind='followup' THEN 1 ELSE 0 END) AS followup
       FROM emails WHERE status='failed' AND date(created_at)=date('now')`
  ).first<{ total: number; initial: number; followup: number }>();
  return { total: r?.total ?? 0, initial: r?.initial ?? 0, followup: r?.followup ?? 0 };
}

export interface SendOutcome {
  ok: boolean;
  id: number;
  error?: string;
  skipped?: string;
}

// M3 合规红线：这些状态的线索绝不发信（退订/黑名单/退信/已忽略/已成交）。发送入口硬校验（第一道）。
// won（已成交）纳入压制：成交客户不再自动冷发/跟进。
const SUPPRESSED_STATUSES = new Set(["unsubscribed", "blacklisted", "bounced", "ignored", "won"]);

// M3 终极闸：持久压制名单（suppressed_emails 表），不依赖可变 status，堵"两跳洗白"+同邮箱重导入复发。
export async function addSuppressedEmail(env: Env, email: string | null | undefined, reason: string): Promise<void> {
  const e = (email || "").toLowerCase().trim();
  if (!e) return;
  try {
    await env.DB.prepare("INSERT OR IGNORE INTO suppressed_emails (email, reason) VALUES (?, ?)").bind(e, reason).run();
  } catch (err) { console.error("addSuppressedEmail:", err); } // 记压制失败不阻断主流程
}
export async function isEmailSuppressed(env: Env, email: string | null | undefined): Promise<boolean> {
  const e = (email || "").toLowerCase().trim();
  if (!e) return false;
  try {
    const row = await env.DB.prepare("SELECT 1 AS x FROM suppressed_emails WHERE email = ?").bind(e).first();
    return !!row;
  } catch (err) { console.error("isEmailSuppressed:", err); return false; } // 迁移未就绪时退回 status 闸兜底
}

// 把 "Subject: xxx\n\n正文" 拆成 {subject, body}
function parseEmail(recommended: string): { subject: string; body: string } {
  const text = (recommended || "").trim();
  const m = text.match(/^subject:\s*(.+)$/im);
  if (m) {
    const subject = m[1].trim();
    const body = text.slice(text.indexOf(m[0]) + m[0].length).replace(/^\s+/, "");
    return { subject, body };
  }
  return { subject: "Hello from AirSonde", body: text };
}

function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
}

function bodyToHtml(body: string): string {
  return body
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px">${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function hostOf(u: string): string {
  try { return new URL(u).host.replace(/^www\./, ""); } catch { return u.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, ""); }
}

function buildHtml(body: string, unsubUrl: string, company: string, address: string, website: string): string {
  const siteLine = website
    ? `Website: <a href="${esc(website)}" style="color:#6a6a6a">${esc(hostOf(website))}</a><br>`
    : "";
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#222;line-height:1.6;max-width:600px">
${bodyToHtml(body)}
<hr style="border:none;border-top:1px solid #e2e2e2;margin:26px 0 12px">
<div style="font-size:12px;color:#8a8a8a;line-height:1.5">
${esc(company)}${address ? " · " + esc(address) : ""}<br>
${siteLine}If you'd prefer not to receive these emails, <a href="${unsubUrl}" style="color:#8a8a8a">unsubscribe here</a>.
</div>
</div>`;
}

function buildText(body: string, unsubUrl: string, company: string, address: string, website: string): string {
  return `${body}\n\n---\n${company}${address ? " · " + address : ""}${website ? "\nWebsite: " + website : ""}\nUnsubscribe: ${unsubUrl}`;
}

// 今日已发送数量（UTC 日期）
export async function sentToday(env: Env): Promise<number> {
  const r = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM emails WHERE status='sent' AND date(sent_at)=date('now')"
  ).first<{ n: number }>();
  return r?.n ?? 0;
}

/**
 * 批㉒：今天这些信**都是谁**。总闸 `sentToday()` 一个字没动 —— 这里只是把同一个总数拆开给人看。
 *
 * 起因：Joe 看到「今日上限 200，还剩 106」问"我没发 94 封吧"。94 里 86 封是**跟进**，
 * 他只记得自己手点了几封 —— 一个不解释的总数把他吓着了。
 * 数字没错，错在**它没说自己是由什么构成的**。
 */
export async function sentTodayBreakdown(env: Env): Promise<{ total: number; initial: number; followup: number; auto: number; cold: number; transactional: number }> {
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN COALESCE(kind,'initial') = 'initial' THEN 1 ELSE 0 END) AS initial,
            SUM(CASE WHEN kind = 'followup' THEN 1 ELSE 0 END) AS followup,
            SUM(CASE WHEN COALESCE(kind,'initial') IN ('initial','followup') THEN 0 ELSE 1 END) AS transactional,
            SUM(CASE WHEN auto_sent = 1 THEN 1 ELSE 0 END) AS auto
       FROM emails WHERE status='sent' AND date(sent_at)=date('now')`
  ).first<{ total: number; initial: number; followup: number; transactional: number; auto: number }>();
  const initial = r?.initial ?? 0, followup = r?.followup ?? 0;
  // ⚠️ `initial` 口径已收紧为**严格 kind='initial'（含历史 NULL）**。原来写的是 `!= 'followup'`，
  //    那会把 confirmation/reply 一起算进"首触" —— 上游确认信随官网产品询盘上线后，
  //    再不改，Joe 看到的"首触 N 封"里会混进事务信，又是一个**数字没错但没说自己由什么构成**的坑。
  return { total: r?.total ?? 0, initial, followup, auto: r?.auto ?? 0,
           cold: initial + followup, transactional: r?.transactional ?? 0 };
}

// ⭐⭐ 系统级发信限额（Joe 定调：「不针对某一个发信邮箱，而是针对整套系统」）----------------
//
// 病史（上游 2026-07-28 实测挖出）：闸曾是 `wanew_daily_limit` + 按单一发件地址计数
//   —— **把限额绑死在一个发件地址上**。上游旧发件域退役后它成了唯一真闸，而生产从没设过该 key →
//   静默落到默认 10 → 出信量从 ~85-100/天 砍到 **精确 10/天，连续三天没人发现**。
//   没人发现的原因不是没人看：设置页那个写着「全部共用这个总闸」的框绑的是 `daily_send_limit`(25)，
//   **早已不起作用** —— 界面在说谎。
//
// 修法的关键**不是改 key 名，是改计数口径**：只要还按 sender_email 数，
//   明天加第二个发件域照样裂成两半、照样漏配。所以系统闸按 **全发件人** 计数。
//
// 真源唯一 = `daily_send_limit`（这名字本来就与域名无关，UI label 也早就写着"总闸"——
//   本次是让那句话重新成真）。`wanew_daily_limit` 已退役，仅作一次性 legacy 兜底读，
//   **避免上线瞬间又静默掉回默认值**。
export const SYSTEM_LIMIT_DEFAULT = 100;
export type LimitSource = "configured" | "legacy" | "default";

// ---- 新域爬坡保护（ramp guard）------------------------------------------------
// 为什么需要：天花板（Joe 设的 1000）**不是日均目标**，是上限。真实发量受"已批准线索数"约束，
//   平时根本到不了。风险只在**某天批量批准几百家**时一次性喷出去 —— 对刚起步的发件域
//   （AirSonde 的更是零信誉），一天从 10 封跳到 500 封是最典型的"被判垃圾发信"路径，域名声誉一旦烧掉
//   要几个月养回来，比"少发几天"贵得多。
// 机制（取最简那种）：批量通道的生效上限 = min(天花板, max(地板, 昨日冷发 × 系数))。
//   地板保证起得来（昨天 0 封也允许今天发 30），系数保证每天最多涨 50%。
//   10 → 30 → 45 → 67 → 101 → … 约十天爬到 1000，天花板始终是 Joe 的。
// ⚠️ 只约束**批量**通道。手动单条(sendLead)本就不过任何日限 —— 豁免是结构性的，
//    不需要为它加特例判断（加 if 才是病）。
export const RAMP_FLOOR = 30;      // 地板：昨天发 0 也允许今天 30，否则一停就永远起不来
export const RAMP_FACTOR = 1.5;    // 每天最多涨 50%

export interface SendLimitInfo {
  limit: number;            // 天花板（Joe 设的值）
  source: LimitSource;
  rampEnabled: boolean;
  rampCap: number | null;   // 爬坡算出的上限；关闭时 null
  effective: number;        // 批量通道**真正生效**的上限 = min(limit, rampCap)
  yesterdayCold: number;
}

/** 某天的冷发量（dayExpr 用 SQLite 修饰符，如 "-1 day"；"0 day"=今天）。 */
export async function coldSentOnDay(env: Env, dayExpr: string): Promise<number> {
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM emails
      WHERE status='sent' AND date(sent_at)=date('now', ?)
        AND COALESCE(kind,'initial') IN ('initial','followup')`
  ).bind(dayExpr).first<{ n: number }>();
  return r?.n ?? 0;
}

/** ⭐ 限额**唯一咽喉点**：所有读日限的地方只准走这里。
 *  （绝不在各处撒 `getSetting("daily_send_limit", ...)` —— 那种写法的第五个点必漏，
 *   这次的 -90% 正是"多处各读各的"演化出来的。）
 *  source：configured=Joe 设过 · legacy=还在吃退役 key 的值 · default=谁都没配，走代码默认。 */
export async function systemDailySendLimit(env: Env): Promise<SendLimitInfo> {
  const pick = (raw: string): number | null => {
    const n = Number(raw);
    return raw !== "" && Number.isFinite(n) && n >= 1 ? Math.floor(n) : null;
  };
  let limit = SYSTEM_LIMIT_DEFAULT, source: LimitSource = "default";
  const cur = pick(await getSetting(env, "daily_send_limit", ""));
  if (cur !== null) { limit = cur; source = "configured"; }
  else {
    const legacy = pick(await getSetting(env, "wanew_daily_limit", ""));
    if (legacy !== null) { limit = legacy; source = "legacy"; }
  }

  // ---- 新域爬坡保护（可关）----
  const rampEnabled = (await getSetting(env, "send_ramp_enabled", "1")) !== "0";
  if (!rampEnabled) return { limit, source, rampEnabled, rampCap: null, effective: limit, yesterdayCold: 0 };
  const yesterdayCold = await coldSentOnDay(env, "-1 day");
  const rampCap = Math.max(RAMP_FLOOR, Math.floor(yesterdayCold * RAMP_FACTOR));
  return { limit, source, rampEnabled, rampCap, effective: Math.min(limit, rampCap), yesterdayCold };
}

/** ⭐ 自动通道日限：**默认跟随系统闸**，不再是独立硬值。
 *
 *  Joe 定调「一个总闸说了算」。老写法 `getSetting("auto_send_daily_limit","15")` 有个硬默认，
 *  于是生产里躺着一个 200：系统闸提到 1000，自动通道**实际还是 200** ——
 *  又一个**没人说话的隐形瓶颈**，跟 wanew_daily_limit=10 那次一模一样的病。
 *
 *  现在：没显式设过 → 跟随系统闸（永远不卡人）；显式设过 → 用设的值
 *  （保留"我只想让自动少发一点"的能力）。source 供 UI 说清这个数打哪来。
 *  ⚠️ 无论哪种，最终都还会被 sendApprovedBatch 里的系统闸再 min 一次 → 不可能突破总闸。 */
export async function autoSendDailyLimit(env: Env, systemEffective: number): Promise<{ limit: number; source: "configured" | "system" }> {
  const raw = await getSetting(env, "auto_send_daily_limit", "");
  const n = Number(raw);
  if (raw !== "" && Number.isFinite(n) && n >= 1) return { limit: Math.floor(n), source: "configured" };
  return { limit: systemEffective, source: "system" };
}

/** 今日**冷发**已用量（initial + followup，全发件人）——系统闸数的就是它。
 *  ⚠️ 事务性邮件（confirmation 询盘确认 / reply 回真人）**不计入、也不受闸限制**：
 *     额度满了就不给刚询盘的真客户发确认信 = 拿获客命脉去省额度。它们在用量行里单独显示。 */
export async function coldSentToday(env: Env): Promise<number> {
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM emails
      WHERE status='sent' AND date(sent_at)=date('now')
        AND COALESCE(kind,'initial') IN ('initial','followup')`
  ).first<{ n: number }>();
  return r?.n ?? 0;
}

// ---- 发件域：所有出站一律主发件域（品牌统一，From/正文一致）----
// 上游病史：原批㉘"在途会话不换发件人"的续发分支让老在途线索继续用退役旧域发，
//   而正文/卖点/company_name 已全局换新品牌 → 造成"正文新品牌／发件人旧品牌"打架（Joe 在 outbox 存档看到）。
//   修法=续发分支已删，所有出站恒走 pickSender 单一真源。
// ⚠️ AirSonde：主发件域候选 airsonde.net，**待 Joe 确认注册**（下面是占位值）。
//   C1 发信结构性锁死（无 RESEND_API_KEY），此值不会产生任何真实出站。
//   SENDER_LEGACY 在 AirSonde 无旧域，置空 —— 它仅在 IMAP 收信端作 fallback，空=fail-closed。
export const SENDER_PRIMARY = "sales@airsonde.net";
export const SENDER_LEGACY = "";   // AirSonde 无退役旧域；仅收信端(IMAP 双箱)语义保留
export async function pickSender(_env: Env, _lead: any, _kind: string): Promise<string> {
  return SENDER_PRIMARY;   // initial/confirmation/followup/reply 全部主发件域
}
/** 短品牌名随发件域（与 From 显示名 send.ts:pickSender 分支同一套逻辑 = 唯一真源）：airsonde 域→"AirSonde"，否则→env.SENDER_NAME||"AirSonde"。 */
export function senderBrand(env: Env, senderEmail: string): string {
  return senderEmail.includes("airsonde") ? "AirSonde" : (env.SENDER_NAME || "AirSonde");
}
/** 某线索某类邮件的**正文品牌** = 它将用的发件人对应的短品牌（走 pickSender = 与 deliverEmail 同结果 → From/正文品牌一致，守"在途不换品牌"红线）。 */
export async function brandForLead(env: Env, lead: any, kind: string): Promise<string> {
  return senderBrand(env, await pickSender(env, lead, kind));
}
/** 某发件域今天已发几封（与 sentToday 同口径：status='sent' 按 sent_at 当日） */
export async function senderSentToday(env: Env, sender: string): Promise<number> {
  const r = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM emails WHERE sender_email=? AND status='sent' AND date(sent_at)=date('now')"
  ).bind(sender).first<{ n: number }>();
  return r?.n ?? 0;
}
// `wanewDailyLimit()` 已退役 —— 它按发件域命名/计数，正是 Joe 否掉的那种设计。
// 现由 systemDailySendLimit()（系统级、全发件人计数）取代；`wanew_daily_limit` 仅存 legacy 兜底读。

/** 今天**自动**发出去几封（供 auto_send_daily_limit 用；与全局 daily_send_limit 是"与"的关系） */
export async function autoSentToday(env: Env): Promise<number> {
  const r = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM emails WHERE status='sent' AND auto_sent=1 AND date(sent_at)=date('now')"
  ).first<{ n: number }>();
  return r?.n ?? 0;
}

// ⭐ 熔断器：自动发送的前提条件，不是附加功能。
// 实证（上游）：40 封手动 → 12 退订（30%）。手动时这个问题每天发生一次；自动之后 7×24 发生。
// 按 15/天自动发就是每天 ~4-5 个退订，Resend 会标记账号、收件方开始把发件域判垃圾。
export const BREAKER_WINDOW = 30;      // 窗口：最近 30 封**自动发出的初次开发信**
export const BREAKER_THRESHOLD = 0.15; // 退订占比 ≥15% 即熔断

export interface BreakerStatus {
  window: number;        // 窗口内实际有几封（<30 说明样本不足）
  unsubs: number;
  rate: number;          // 0~1
  enoughSample: boolean;
  shouldTrip: boolean;
}

/**
 * 只统计**自动发出的初次开发信**：
 *  · 手动发的不算 —— Joe 手动挑着发的那批退订率高低，跟"自动发送该不该停"是两回事
 *  · 跟进信不算 —— 窗口口径是初次触达
 * 退订判定用 **suppressed_emails(reason='unsubscribe')** 为主 + leads.status 兜底：
 *  按 M3 的原则，压制名单是持久记录、不依赖可变的 status（防"两跳洗白"后统计失真）。
 *
 * ⭐ 窗口从 `auto_send_resumed_at`（Joe 上次手动重开的时刻）之后算起 —— 这条不加的话熔断**不可恢复**：
 *    熔断后自动发送停了 → 窗口再也不进新数据 → 永远卡在那个 30% →
 *    Joe 一重开，下一轮 cron 立刻拿同一批老数据再熔断一次，一封新信都发不出去。
 *    重开＝Joe 说"我查过了、改过了"，那就该拿**改之后的新数据**重新判，而不是拿旧账再判他一次。
 *    这不是"自动恢复"（总工明确禁止的那个）：没有 Joe 手动点，永远不会重开。
 */
export async function getBreakerStatus(env: Env): Promise<BreakerStatus> {
  const since = await getSetting(env, "auto_send_resumed_at", "");
  // ⚠️⚠️ 下面那个 `e.status='sent'` 是**语义要件，不是顺手写的过滤条件。别删、别改成"尝试过的"。**
  //
  // 窗口的分母必须是「**真发出去的**信」，不是「尝试发的」——
  // 退订率衡量的是**收信人的反应**，而没发出去的信不可能招来任何反应。
  //
  // 现在 deliverEmail 的 8 个 skipped 场景（压制名单/幂等/同邮箱重复/无邮箱/无草稿/并发被取走）
  // **全部 return 在 `INSERT INTO emails` 之前**，连一行都不建 —— 所以它们天然进不了这个窗口。
  // 但那是**当前实现的巧合**，不是保障。哪天有人把 skipped 也落一行（很合理的需求：想看跳过统计），
  // 或者把这里改成数"尝试"，熔断器就会被**跟开发信质量毫无关系**的跳过拉偏：
  // 压制名单命中多 → 看起来"失败率高" → 熔断 → 自动发送停了，而信其实写得好好的。
  //
  // 2026-07-17 排查记录：总工一度以为 skipped 会污染这个窗口（"加了 email 过滤后就自动消失了"）——
  // 结论蒙对了但推理是错的。查源码才发现根本不建行。这句注释就是防下一个人重复那个错误模型。
  const row = await env.DB.prepare(
    `WITH w AS (
       SELECT e.lead_id FROM emails e
       WHERE e.auto_sent=1 AND e.kind='initial' AND e.status='sent' AND e.sent_at IS NOT NULL
         AND (? = '' OR e.sent_at > ?)
       ORDER BY e.sent_at DESC LIMIT ?
     )
     SELECT COUNT(*) AS n,
            SUM(CASE WHEN l.status='unsubscribed'
                       OR lower(COALESCE(l.email,'')) IN (SELECT email FROM suppressed_emails WHERE reason='unsubscribe')
                     THEN 1 ELSE 0 END) AS u
     FROM w JOIN leads l ON l.id = w.lead_id`
  ).bind(since, since, BREAKER_WINDOW).first<{ n: number; u: number }>();
  const window = row?.n ?? 0;
  const unsubs = row?.u ?? 0;
  const enoughSample = window >= BREAKER_WINDOW;
  const rate = window > 0 ? unsubs / window : 0;
  // ⚠️ 样本不足**不熔断**：这跟数据看板 n<50 只显示计数、不显示率是同一条原则，别在这儿破例。
  //    5 封里 2 封退订说明不了任何事，据此停掉自动发送只会变成随机噪声开关。
  return { window, unsubs, rate, enoughSample, shouldTrip: enoughSample && rate >= BREAKER_THRESHOLD };
}

// 发信核心：落 queued 记录 → 调 Resend → 回写 email 状态。不改 lead 状态（调用方决定）。
// L2：kind 增加 'reply'（卡内回信）。导出给回调用——回调侧先过状态闸,本函数内 isEmailSuppressed 终极闸照过（双闸）。
export async function deliverEmail(env: Env, lead: any, subject: string, body: string, kind: "initial" | "followup" | "confirmation" | "reply", autoSent = false): Promise<SendOutcome> {
  // M3 终极闸：持久压制名单命中即 skip（不依赖 status，两跳洗白/重导入也拦得住）
  if (await isEmailSuppressed(env, lead.email)) {
    return { ok: false, id: lead.id, skipped: "邮箱在压制名单，不发送" };
  }
  // S2 幂等：初次开发信只发一次——已有 initial 邮件(已发/排队中)则跳过，防并发/重叠导致同一 lead 重复发信
  if (kind === "initial") {
    const dup = await env.DB.prepare(
      "SELECT id FROM emails WHERE lead_id=? AND kind='initial' AND status IN ('sent','queued') LIMIT 1"
    ).bind(lead.id).first();
    if (dup) return { ok: false, id: lead.id, skipped: "已发过初次开发信（幂等跳过）" };

    // ⭐ 顺带修③ 的真正要害：**幂等必须按邮箱地址，不能只按 lead_id**。
    //
    // 生产实证（2026-07-16 只读查出来的，不是设想）：同一个网站被录成了两行 ——
    //   #163 2csyachtoutfitters.com  vs  #238 http://www.2CsYachtOutfitters.com
    // 入库去重只比对了 website 字符串原文，**协议不同 + www + 大小写不同就漏了**。
    // 两行的邮箱是同一个（2csyachtoutfitters@gmail.com），#163 已发信、#238 还躺在 new 里 →
    // 重扫后一旦重开自动发送，**同一个地址会收到第二封一模一样的冷邮件** →
    // 在收件人眼里就是垃圾邮件 → 退订/投诉。上面那条幂等按 lead_id 判，两行不同 id，**挡不住**。
    // alliancenav.com（#165 已发 / #241 待发）是同样的情况。
    //
    // 这条按地址判，等于给"重复线索"这一整类兜底 —— 不管重复是怎么进来的（入库漏判、
    // 人工导入、以后新的来源），同一个地址永远只会收到一封冷邮件。
    const dupAddr = await env.DB.prepare(
      `SELECT e.lead_id FROM emails e JOIN leads l2 ON l2.id = e.lead_id
        WHERE lower(l2.email) = lower(?) AND e.kind='initial' AND e.status IN ('sent','queued')
          AND e.lead_id != ? LIMIT 1`
    ).bind(lead.email, lead.id).first<{ lead_id: number }>();
    if (dupAddr) {
      return { ok: false, id: lead.id,
        skipped: `这个邮箱已经收过开发信了（线索 #${dupAddr.lead_id} —— 同一家被重复录入），不再发第二封` };
    }
  }
  // 上游批㉘：发件人按路由定（现恒走 pickSender 单一真源，红线=在途不换人）。
  // env.SENDER_EMAIL 不再直接当发件人;显示名沿用现有 SENDER_NAME 逻辑(规格点名)。
  const senderEmail = await pickSender(env, lead, kind);
  // ㉘b：显示名**随发件域**——防"正文品牌 A／发件人品牌 B"打架（上游真发生过，Joe 在 outbox 存档看到）。
  const senderName = senderBrand(env, senderEmail);
  // #53：新邮件退订链接优先用公开 API 正门（PUBLIC_API_URL）；未配则回退 APP_URL。
  //   ⚠️ AirSonde C1 两者都指不到公开面（无发信能力，无实害）；发信域单落地时必须给公开 host。
  const appUrl = (env.PUBLIC_API_URL || env.APP_URL || "http://localhost:8787").replace(/\/+$/, "");
  const company = await getSetting(env, "company_name", "AirSonde");
  const address = await getSetting(env, "company_address", DEFAULT_COMPANY_ADDRESS);
  const website = await getSetting(env, "company_website", env.SITE_URL || "https://airsonde.com");

  const token = crypto.randomUUID();
  const unsubUrl = `${appUrl}/u/${token}`;
  // ⭐ 批⑧ Bug2：**我们自己指定 Message-ID**，而不是去猜 Resend 生成成什么样。
  //   回信的 In-Reply-To 会指向它 → 这是唯一"与发件地址无关"的确定匹配手段
  //   （对方用任何地址回都认得出 —— 今天 Michael 用 michael@ 回我们发给 sales@ 的信就是这个情况）。
  //   域名用发件域，符合 RFC 5322 对 msg-id 的要求（右半边应是发信方的域）。
  const ourMessageId = `<${crypto.randomUUID()}@${(senderEmail.split("@")[1] || "airsonde.net")}>`;

  await ensureEmailColumns(env);   // 幂等补 error 列（每 isolate 只跑一次）
  const ins = await env.DB.prepare(
    "INSERT INTO emails (lead_id, subject, body, status, kind, unsubscribe_token, auto_sent, sender_email, created_at) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, datetime('now'))"
  ).bind(lead.id, subject, body, kind, token, autoSent ? 1 : 0, senderEmail).run();
  const emailId = ins.meta.last_row_id;

  // L4(#54)：BCC 存档——settings.bcc_archive 非空即对**所有外发**（开发信/跟进/回信/确认）密送。
  // 默认空=关；Joe 建好 outbox 公共邮箱（域待定）后在发信设置里填上即生效（代码先行）。
  const bccArchive = (await getSetting(env, "bcc_archive", "")).trim();
  try {
    const res = await fetch(RESEND_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: `${senderName} <${senderEmail}>`,
        to: [lead.email],
        ...(bccArchive ? { bcc: [bccArchive] } : {}),
        subject,
        html: buildHtml(body, unsubUrl, company, address, website),
        text: buildText(body, unsubUrl, company, address, website),
        reply_to: senderEmail,
        headers: {
          "List-Unsubscribe": `<${unsubUrl}>, <mailto:${senderEmail}?subject=unsubscribe>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          // ⭐ 批⑧ Bug2：自己指定 Message-ID → 回信的 In-Reply-To 会指向它 → 精确认领（与发件地址无关）
          "Message-ID": ourMessageId,
        },
      }),
    });
    if (!res.ok) {
      // ⭐ 原文**一直在手里**，以前写库那行把它扔了、只交给调用方打 console ——
      //   而 console 当时不可回溯（observability 是 2026-07-28 才开的）。
      //   于是 07-17 那 72 封失败，今天回头查只剩"失败了"三个字。
      //   ⚠️ `readBodySafe` 而不是 `.catch(() => "")`：读体失败必须留痕，
      //      **空串会把"我没读到原因"伪装成"原因是空的"**。
      const t = await readBodySafe(res);
      const f = classifyError(new Error(`Resend ${res.status}: ${t}`));
      await env.DB.prepare("UPDATE emails SET status='failed', error=? WHERE id=?")
        .bind(failText(f), emailId).run();
      return { ok: false, id: lead.id, error: `Resend ${res.status}: ${t.slice(0, 200)}` };
    }
    const data: any = await res.json();
    // ⭐ 批⑧ Bug2：存下这封信的 **Message-ID**，回信的 In-Reply-To 会指向它 → 精确认领。
    //   我们**自己指定** Message-ID（上面 headers 里传了），而不是去猜 Resend 生成的格式 ——
    //   猜错的话 layer① 会永远静默失效（匹配不上又不报错，跟这次的病一模一样）。
    //   ⚠️ 但"Resend 到底认不认我们指定的 Message-ID"**尚未在真信上验证过**（见 commit message）。
    //   所以这里存的是"我们要求的值"；万一 Resend 覆盖了它，layer① 失效但 layer②③ 照常兜底，
    //   不会比现在更差。真信验证一到手就能确认。
    await env.DB.prepare(
      "UPDATE emails SET status='sent', provider_id=?, message_id=?, sent_at=datetime('now') WHERE id=?"
    ).bind(data?.id ?? null, ourMessageId, emailId).run();
    return { ok: true, id: lead.id };
  } catch (e: any) {
    // 同上：把运行时原话一并落库。**这条路径正是 07-17 那 72 封走的那条**
    //   （若真是 `Too many subrequests`，新结构下会写成 platform:subrequest-limit + 原文）。
    const f = classifyError(e);
    await env.DB.prepare("UPDATE emails SET status='failed', error=? WHERE id=?")
      .bind(failText(f), emailId).run();
    return { ok: false, id: lead.id, error: e.message || String(e) };
  }
}

// 发送单条初次开发信（要求 lead 已 approved 且有 analysis.recommended_email）
export async function sendLead(env: Env, lead: any, autoSent = false): Promise<SendOutcome> {
  if (!env.RESEND_API_KEY) return { ok: false, id: lead.id, error: "缺少 RESEND_API_KEY（.dev.vars / wrangler secret）" };
  if (!lead.email) return { ok: false, id: lead.id, skipped: "无邮箱" };
  if (SUPPRESSED_STATUSES.has(lead.status)) return { ok: false, id: lead.id, skipped: `压制名单(${lead.status})，不发送` };

  // ⭐ 批⑦A：草稿**在这一刻才写**（没有就现生成）。sendLead 是所有发信路径的唯一必经点
  //   （sendApprovedBatch / 手动「发送」/ human-approve 之后的发送 全都走它）→ 一处覆盖全部。
  //   生成失败**只跳过这一条**：调用方（sendApprovedBatch）会把 status 从 queued 退回 approved，
  //   下一批自然重试 —— 不会卡死整批，也不会丢掉这个客户。
  const d = await ensureDraft(env, lead);
  if (!d.ok || !d.draft) {
    // ⚠️ 同一条规则，不给跟进开特例：**起草阶段真抛了异常 ⇒ 必须留一行**。
    //   `d.thrown` 存在 = 真出错（可能是平台错误）；不存在 = "还没打分"这种正常跳过，不该留失败记录。
    //   区分这两者正是加 `thrown` 字段的全部理由 —— 否则平台错误会伪装成业务状态。
    if (d.thrown !== undefined) {
      const f = await recordDraftFailure(env, lead.id, "initial", d.thrown);
      return { ok: false, id: lead.id, error: `开发信生成失败: ${failText(f, 200)}` };
    }
    return { ok: false, id: lead.id, skipped: d.error || "无 AI 开发信（先分析）" };
  }

  const { subject, body } = parseEmail(d.draft);
  const out = await deliverEmail(env, lead, subject, body, "initial", autoSent);
  if (out.ok) {
    await env.DB.prepare("UPDATE leads SET status='sent', updated_at=datetime('now') WHERE id=?").bind(lead.id).run();
  }
  return out;
}

// 发送单条跟进信（第二次触达，lead 保持 sent 状态）。warm=true 用「趁热跟进」暖变体（engaged 点击线索）。
export async function sendFollowup(env: Env, lead: any, warm = false): Promise<SendOutcome> {
  if (!env.RESEND_API_KEY) return { ok: false, id: lead.id, error: "缺少 RESEND_API_KEY" };
  if (!lead.email) return { ok: false, id: lead.id, skipped: "无邮箱" };
  if (SUPPRESSED_STATUSES.has(lead.status)) return { ok: false, id: lead.id, skipped: `压制名单(${lead.status})，不发送` };

  const analysis = await env.DB.prepare(
    "SELECT recommended_email FROM lead_analysis WHERE lead_id = ?"
  ).bind(lead.id).first<{ recommended_email: string }>();
  const original = analysis?.recommended_email || "";

  let subject: string, body: string;
  try {
    const brand = await brandForLead(env, lead, "followup");   // 正文品牌随发件人（pickSender 单一真源，恒 AirSonde）
    const raw = warm
      ? await writeWarmFollowup(env, brand, lead.company_name || "", await getProfile(env), original)
      : await writeFollowup(env, brand, lead.company_name || "", original);
    ({ subject, body } = parseEmail(raw));
  } catch (e: any) {
    // ⭐⭐ 这里就是"跟进信静默丢"的病灶本身（2026-08-01 生产实证）：
    //   原来只有 `return { ok:false, error: "写跟进信失败: …" }` —— **不抛、不落库**。
    //   于是每轮 24 条线索各烧掉 1 次 AI 调用、全部因 `Too many subrequests` 失败，
    //   而 `emails` 表**一行都不建**（失败发生在 deliverEmail 之前）⇒ 连续 4 天一封跟进没发出去，
    //   数据上完全无痕，看板还在说"今天发出的是无回复自动跟进"。
    //   ⚠️ **拆 cron 不解决静默，只是把静默换个地方。** 所以这一行必须先于拆分落地。
    const f = await recordDraftFailure(env, lead.id, "followup", e);
    return { ok: false, id: lead.id, error: `写跟进信失败: ${failText(f, 200)}` };
  }
  // 跟进信主题接原信更自然
  if (!/^re:/i.test(subject)) {
    const os = parseEmail(original).subject;
    if (os && os !== "Hello from AirSonde") subject = "Re: " + os;
  }
  return await deliverEmail(env, lead, subject, body, "followup");
}

// 详情弹窗「趁热跟进」半自动发送：用户审过（可能已编辑）的暖跟进全文 → 直接发 followup。
// 不重新生成、不改 lead 状态；走 deliverEmail（isEmailSuppressed 终极闸在其内）+ 同一道 SUPPRESSED_STATUSES 硬校验。
export async function sendWarmFollowupNow(env: Env, lead: any, fullText: string): Promise<SendOutcome> {
  if (!env.RESEND_API_KEY) return { ok: false, id: lead.id, error: "缺少 RESEND_API_KEY" };
  if (!lead.email) return { ok: false, id: lead.id, skipped: "无邮箱" };
  if (SUPPRESSED_STATUSES.has(lead.status)) return { ok: false, id: lead.id, skipped: `压制名单(${lead.status})，不发送` };
  const { subject, body } = parseEmail(fullText || "");
  if (!body.trim()) return { ok: false, id: lead.id, error: "跟进信内容为空" };
  return await deliverEmail(env, lead, subject, body, "followup");
}

// 批量跟进：对"已发但 N 天无回复"的线索发跟进信（需开关开启，遵守每日上限与最多跟进次数）
// ids 传入时只跟进这些选中的（仍受全部闸门：followup_enabled 开关 + status='sent' + 有邮箱 +
// 累计跟进 <= followup_max + 冷却天数未到不发 + 每日上限 + deliverEmail 幂等 + 压制名单）。
// engaged(点过链接)的会自动用「趁热」暖变体——所以「跟进选中」和「趁热跟进选中」共用这一条路径。
export async function sendFollowupBatch(env: Env, requested: number, ids?: number[]): Promise<{ processed: number; sent: number; results: SendOutcome[]; disabled?: boolean; capReached?: boolean; dailyLimit: number; sentToday: number }> {
  if ((await getSetting(env, "followup_enabled", "0")) !== "1") {
    return { processed: 0, sent: 0, results: [], disabled: true, dailyLimit: 0, sentToday: 0 };
  }
  const delayDays = Math.max(1, Number(await getSetting(env, "followup_delay_days", "4")) || 4);
  const engagedDelayDays = Math.max(1, Number(await getSetting(env, "engaged_follow_up_delay_days", "2")) || 2);
  const maxFollowups = Math.max(1, Number(await getSetting(env, "followup_max", "1")) || 1);
  // ⭐ 系统级日限（与 sendApprovedBatch 同一咽喉点 systemDailySendLimit + 同一计数 coldSentToday）
  //   → initial+followup 共享同一个闸、跨全部发件域，绝不叠加超发、也绝不因换发件域裂成两半。
  const { effective: dailyLimit } = await systemDailySendLimit(env);   // 批量通道走 effective（含爬坡）
  let coldUsed = await coldSentToday(env);
  const already = await sentToday(env);
  const take = Math.min(requested, Math.max(0, dailyLimit - coldUsed));
  if (take <= 0) return { processed: 0, sent: 0, results: [], capReached: true, dailyLimit, sentToday: already };

  // 两档跟进：
  //  · engaged（曾点击=有意向）→ 更短的 engagedDelayDays、从 last_engaged_at 起算、用「趁热」暖变体；
  //  · 非 engaged → 原 delayDays、从 last_sent 起算、用常规跟进。
  // 都要 status=sent、有邮箱、累计已发 <= maxFollowups。已回复/退订/黑名单/退信 因 status 非 sent 已自动排除。engaged 优先（趁热）。
  //
  // ⭐⭐ 批㉒ 修的真 bug：**engaged 那一支原来没有发送冷却**，只判 `last_engaged_at`。
  //   而"发一封跟进"**不会改变** `last_engaged_at`（那是"客户点了链接"的时间戳）——
  //   于是一条 engaged 线索一旦跨过 engagedDelayDays，就**每个整点都重新命中**，
  //   每小时发一封，一直发到 `sent_count` 撞上 maxFollowups 才停。
  //   生产实锤：lead 501 在 00:02 / 01:01 / 02:01 收到 3 封同标题跟进；另有 3 家被打满到 sent_count=4。
  //   ⚠️ 这个洞**只在 engaged 分支**：非 engaged 那支一直是按 `MAX(e.sent_at)` 起算的，本来就有冷却。
  //   → 修法：engaged 分支**同时**要求"距上次参与够久"**且**"距上次发信够久"（复用 engagedDelayDays，不新造旋钮）。
  //   教训形状：两个分支表达同一个意图（"别太密"），但只有一支真的实现了它。
  // 批③C：传了 ids 就只在同一条 WHERE 上再加 id IN (...) —— 开关/冷却/次数/上限/幂等/压制全部照旧，只是范围收窄到选中项
  const idList = Array.isArray(ids) ? ids.filter((n) => Number.isFinite(n)) : [];
  const idFilter = idList.length ? ` AND l.id IN (${idList.map(() => "?").join(",")})` : "";
  const sql =
    `SELECT l.*, COUNT(e.id) AS sent_count, MAX(e.sent_at) AS last_sent,
            MAX(CASE WHEN e.clicked_at IS NOT NULL THEN 1 ELSE 0 END) AS has_click
       FROM leads l JOIN emails e ON e.lead_id = l.id AND e.status='sent'
      WHERE l.status='sent' AND l.email IS NOT NULL AND l.email != ''${idFilter}
      GROUP BY l.id
     HAVING sent_count <= ?
        AND (
          (has_click = 1 AND l.last_engaged_at IS NOT NULL AND l.last_engaged_at <= datetime('now', ?)
                         AND MAX(e.sent_at) <= datetime('now', ?))
          OR
          (has_click = 0 AND MAX(e.sent_at) <= datetime('now', ?))
        )
      ORDER BY has_click DESC, last_sent ASC
      LIMIT ?`;
  const rows = await env.DB.prepare(sql)
    .bind(...idList, maxFollowups,
          `-${engagedDelayDays} days`,   // engaged：距上次「参与」够久
          `-${engagedDelayDays} days`,   // ⭐ 批㉒ 补的**发送冷却**：距上次发信也要够久
          `-${delayDays} days`, take).all();
  const leads = rows.results as any[];

  const results: SendOutcome[] = [];
  for (const lead of leads) {
    // 系统级日限：满则该轮不发（下轮 cron 继续，不丢线索）
    if (coldUsed >= dailyLimit) {
      results.push({ ok: false, id: lead.id, skipped: `今日发信上限已满(${coldUsed}/${dailyLimit})，该轮不发` });
      continue;
    }
    const out = await sendFollowup(env, lead, !!lead.has_click);   // engaged（有点击）→ 暖变体
    if (out.ok) coldUsed++;
    results.push(out);
  }
  const sent = results.filter((r) => r.ok).length;
  return { processed: results.length, sent, results, dailyLimit, sentToday: already + sent, capReached: already + sent >= dailyLimit };
}

// 批量发送已批准线索：按分数从高到低，遵守每日上限
// ids 传入时只发这些选中的（仍受下面全部闸门约束：status='approved' + match_score>=60 + 每日上限 +
// 原子取批 + deliverEmail 幂等 + isEmailSuppressed 压制名单）——"发送选中"复用同一条路径，绝不另开绕过口。
// autoSent=true：这一批算"自动发送"（标记进 emails.auto_sent，供每日上限与熔断器窗口统计）。
// ⭐ 每日上限怎么不打架（总工点名要说明的那条）：
//   · `daily_send_limit`（生产=50）是**全局总闸**：下面的 sentToday() 数的是**今天所有 status='sent' 的信**
//     （手动 + 自动 + 跟进 + 落地确认信，一个不落），room = 50 - already。
//     所以只要自动发送**也走这个函数**（总工的硬要求），手动+自动+跟进加起来**在结构上就不可能突破 50**——
//     不需要为自动单独扣减，共享计数本身就是闸。
//   · `auto_send_daily_limit`（默认 15）是**自动这条路自己的额外上限**，由调用方（cron）先算好
//     autoRoom = 15 - 今天已自动发的，再把 requested 传进来。两个上限是**与**的关系，取更紧的那个生效。
//   · 结果：自动 ≤15/天，且 全部 ≤50/天。自动跑在 cron 里会先占额度，手动还剩 ≥35 —— 这是有意的：
//     自动的东西要跑得慢、出事损失小一格。
export async function sendApprovedBatch(
  env: Env, requested: number, ids?: number[], autoSent = false,
  // ⭐ P0-1：并发 + 轮次时间闸。**默认值刻意保持原行为**（并发 1、无时间闸）——
  //   手动发送走的是同一个函数，不该被这次改动顺手改掉语义。只有 cron 会传这两个。
  opts: { concurrency?: number; budget?: RoundBudget } = {},
): Promise<{ processed: number; sent: number; results: SendOutcome[]; capReached?: boolean; dailyLimit: number; sentToday: number; truncatedByTime?: number }> {
  // ⭐ 系统级日限（唯一咽喉点，与 sendFollowupBatch 同闸同计数）：initial+followup 共享，
  //   跨全部发件域计数 —— 将来加/换发件域，闸恒定、无需改配置、无处可漏。
  const { effective: dailyLimit } = await systemDailySendLimit(env);   // 批量通道走 effective（含爬坡）
  const already = await coldSentToday(env);
  const room = Math.max(0, dailyLimit - already);
  const take = Math.min(requested, room);

  if (take <= 0) {
    return { processed: 0, sent: 0, results: [], capReached: true, dailyLimit, sentToday: already };
  }

  // S3 发送分数硬下限：只取 match_score >= 60 的（NULL/<60 即使被误批准也永不发，兜底防"一点群发就发垃圾"）
  // A2：传了 ids 就在同一条 WHERE 上再加 id IN (...) —— 门槛/上限/排序全部照旧，只是范围收窄到选中项
  //
  // ⭐ `OR l.human_approved=1`：翻牌堆里 Joe **亲手对单条**按过「手动发这家」的。
  //   这不是把闸放松 —— human_approved 只能由 /api/leads/:id/human-approve 单条端点写入
  //   （无批量版本、无自动路径），而那个端点自己也要过 approveGateReason（邮箱必须有）+ M3 终态。
  //   到了这里，其余的闸一个不少：status='approved' 仍要满足、每日上限（take）已经在上面算过、
  //   下面还有原子取批、deliverEmail 的幂等 + 压制名单。
  //   🔴 **这里原来写着"match_score NULL 的仍然发不出去 …… approveGateReason 的『未打分』那条不豁免"——
  //      那句话和实现是反的**（安全审计 M14；行号给错了，但确有其事）。
  //      实现在 `index.ts` 的 `approveGateReason`：
  //          if (score == null && !humanApproved) return "未打分，不能批准…";
  //      `&& !humanApproved` 就是**豁免**本身。批⑭① 是**故意**加的：Joe 定的
  //      「缺数据（没分/没官网/没邮箱）是『信息不全』，永远不是『不合格』」，
  //      他要能凭公司名+国家+邮箱人工判、不等 AI 给分就批准去联系。
  //   ⇒ **真实语义**：未打分的线索，只要 Joe 亲手点过 human-approve，`human_approved=1`
  //      就能过这条 OR、**是发得出去的**。这是设计，不是漏洞。
  //   ⚠️ 只改注释，**没动任何发信逻辑**（行为本来就是对的，说谎的是这段文字）。
  //      这条注释是在批⑭① 之前写的，加豁免时没回来改它 —— **代码建立在注释的断言上时，
  //      那句断言就是未经检验的前提**，改行为必须连它一起改。
  const idList = Array.isArray(ids) ? ids.filter((n) => Number.isFinite(n)) : [];
  // ⭐⭐ 批⑨①：**发送池只装能发邮件的**。这一条必须先于（或同批于）auto-approve 放宽无邮箱线索。
  //
  // 为什么这条独立正确，跟批⑨ 做不做无关：
  //   这个 SELECT 以前**完全没有 email 过滤** —— 它靠的是一个**隐含契约**："能进 approved 的必定有邮箱"，
  //   而那个契约由 approveGateReason 在别处守着。**契约不写在 SQL 里，就迟早会被下一个人（或下一个我）撕掉。**
  //   发送池就该只装能发的，不该依赖别处的护栏。
  //
  // 撕掉之后会发生什么（生产数据算过的，不是设想）：
  //   无邮箱 ≥60 有 96 家，最高分 90 = 有邮箱的最高分 90 → `ORDER BY match_score DESC` 让它们**交错在队首**
  //   → 每轮配额约一半的槽位被"取出来又发不掉"的占掉 → deliverEmail skip → 回滚 approved → 下轮继续占
  //   → 等有邮箱的发完，池子里只剩无邮箱的 → **发出量归零、永不自愈、全程静默**。
  //
  // ⚠️ 注意这里过滤的是"能不能发邮件"，**不是**"该不该联系"。批⑨ 之后 approved 的语义是**批准触达**，
  //    只有社媒的线索也理应在 approved 里等 Joe 手动碰 —— 它们只是不该进**邮件**发送池。
  const base =
    `SELECT l.*, a.match_score FROM leads l JOIN lead_analysis a ON a.lead_id=l.id
     WHERE l.status='approved' AND (a.match_score >= 60 OR l.human_approved = 1)
       AND l.email IS NOT NULL AND l.email != ''`;
  const tail = ` ORDER BY a.match_score DESC, l.id ASC LIMIT ?`;
  const rows = idList.length
    ? await env.DB.prepare(`${base} AND l.id IN (${idList.map(() => "?").join(",")})${tail}`).bind(...idList, take).all()
    : await env.DB.prepare(`${base}${tail}`).bind(take).all();
  const leads = rows.results as any[];

  // ⭐ P0-1：一封信 = 生成草稿(实测 31-43s) + 调 Resend。串行发 25 封要 15 分钟，贴死 cron 的 15 分钟墙。
  //   并发 3 压到 ~5 分钟。瓶颈在 AI 不在 Resend（Resend 默认 2 req/s，并发 3 × 37s ≈ 0.08 req/s，撞不到）。
  //   ⚠️ 上线后要看日志有没有 429，有就退到并发 2 —— 这条我没实测过，别当成已验证。
  const conc = Math.max(1, opts.concurrency || 1);
  let truncatedByTime = 0;

  const sendOne = async (lead: any): Promise<SendOutcome> => {
    // ⭐ 时间闸：预算见底就**不再开新的**（已经在飞的那几封让它们发完 —— 半路撕掉会留下 queued 孤儿）。
    //   这是**平台限制不是业务旋钮**：Cron Trigger 的墙是 15 分钟，撞墙会被拦腰砍断。
    //   预留 60s：一封信实测最慢 43s，剩不到一分钟就别再开新的了。
    if (opts.budget && !opts.budget.has(60_000)) { truncatedByTime++; return { ok: false, id: lead.id, skipped: "本轮时间预算用尽，下轮继续" }; }
    // S2 原子取批：approved→queued，仅当当前仍是 approved（并发下只有一方 changes===1 能取到，杜绝同一 lead 被两次群发/自动+手动重叠取走）
    const claim = await env.DB.prepare(
      "UPDATE leads SET status='queued', updated_at=datetime('now') WHERE id=? AND status='approved'"
    ).bind(lead.id).run();
    if (claim.meta.changes !== 1) return { ok: false, id: lead.id, skipped: "并发已被取走" };
    const out = await sendLead(env, { ...lead, status: "queued" }, autoSent);   // sendLead 成功时置 sent
    if (!out.ok) {
      // 未成功发送 → 退回 approved（保持与原语义一致：非成功线索留在待发送池，可重试）
      await env.DB.prepare("UPDATE leads SET status='approved' WHERE id=? AND status='queued'").bind(lead.id).run();
    }
    return out;
  };

  const results: SendOutcome[] = conc > 1 ? await pool(leads, conc, sendOne) : [];
  if (conc === 1) for (const lead of leads) results.push(await sendOne(lead));

  const sent = results.filter((r) => r.ok).length;
  // ⚠️ 被时间截断必须**说出来**。静默截断 = "看起来发完了"，而那正是我们一路在修的病。
  if (truncatedByTime) {
    console.log(`auto-send: 本轮时间预算用尽，${truncatedByTime} 封顺延到下轮（已发 ${sent} 封，耗时 ${Math.round((opts.budget?.elapsed() || 0) / 1000)}s）` +
      `。这是平台限制（Cron 15 分钟墙），**不是** Joe 的每日上限在拦。`);
  }
  return { processed: results.length, sent, results, dailyLimit, sentToday: already + sent, capReached: already + sent >= dailyLimit, truncatedByTime };
}

// Landing 落地页：给主动索取价单的询盘发确认邮件（不含具体价，走 deliverEmail → 压制名单/合规页脚自动生效）
export async function sendInboundConfirmation(env: Env, lead: { id: number; email: string; company_name?: string }): Promise<SendOutcome> {
  if (!env.RESEND_API_KEY) return { ok: false, id: lead.id, error: "缺少 RESEND_API_KEY" };
  if (!lead.email) return { ok: false, id: lead.id, skipped: "无邮箱" };
  // ⚠️ AirSonde 文案占位草稿（C1），待 Joe 审定。（C1 那句"无 key 发不出"已过期：2026-08-31 起 RESEND_API_KEY 已配）
  const subject = "Your AirSonde wholesale price list request";
  const body =
    "Hi there,\n\n" +
    "Thanks for requesting our wholesale price list for air quality monitors. We've received your request — our team will email you the catalog and trade pricing shortly.\n\n" +
    // C6-B/P2-4：删 "flexible MOQs" —— 与 Y2 同一处理（landing.ts / openrouter.ts 卖点默认值已删）。
    //   MOQ 是工厂问题清单三-9 **未答**的商务承诺，我们不知道真实数字。整句撤掉，不做保守暗示。
    //   ⚠️ 本函数其余文案仍是待 Joe 审的占位草稿，这次**只删这一句红线**，不重写全文。
    "AirSonde builds IAQ monitors factory-direct — OEM/ODM private-label and integration-ready hardware for brands, distributors, and HVAC integrators worldwide.\n\n" +
    "Talk soon,\nThe AirSonde Team";
  return await deliverEmail(env, lead, subject, body, "confirmation");
}

// 退订：按 token 找到邮件 → 标记 lead unsubscribed
export async function unsubscribeByToken(env: Env, token: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT lead_id FROM emails WHERE unsubscribe_token = ?").bind(token).first<{ lead_id: number }>();
  if (!row) return false;
  await env.DB.prepare("UPDATE leads SET status='unsubscribed', updated_at=datetime('now') WHERE id=?").bind(row.lead_id).run();
  // 记入持久压制名单（合规：退订永久生效，重导入也不再发）
  const lead = await env.DB.prepare("SELECT email FROM leads WHERE id=?").bind(row.lead_id).first<{ email: string }>();
  await addSuppressedEmail(env, lead?.email, "unsubscribe");
  return true;
}
