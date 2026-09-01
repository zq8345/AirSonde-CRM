import { Hono } from "hono";
import { pool, RoundBudget, SEND_CONCURRENCY, estimateDailyCapacity } from "./pool";
import { REPLY_CRON_TIMEOUT_MS, isTransientImapError } from "./imap";
import { installDevEgressGuard, BUILD_MARKER, devGuardOn, assertEgressAllowed } from "./devguard";
import { connect } from "cloudflare:sockets";
import { basicAuth } from "hono/basic-auth";
import { parseCsv, mapRowToLead } from "./csv";
import { analyzeLead, getProfile, DEFAULT_PROFILE, ensureDraft } from "./service";
import { writeReplyDraft, writeWarmFollowup, DEFAULT_SELLING_POINTS, translateToChinese, isTrustedDirectorySource, getAiUsage } from "./openrouter";
import { scrapeSite } from "./scrape";
import { sendLead, sendApprovedBatch, sendFollowupBatch, sendWarmFollowupNow, unsubscribeByToken, getSetting, setSetting, addSuppressedEmail, isEmailSuppressed, autoSentToday, sentToday, sentTodayBreakdown, failedTodayBreakdown, getBreakerStatus, BREAKER_WINDOW, BREAKER_THRESHOLD, deliverEmail, brandForLead, senderSentToday, SENDER_PRIMARY, SENDER_LEGACY, DEFAULT_COMPANY_ADDRESS, autoSendEnabled, autoApproveEnabled, systemDailySendLimit, coldSentToday, SYSTEM_LIMIT_DEFAULT, RAMP_FLOOR, RAMP_FACTOR, autoSendDailyLimit , automationEnabled, autoSendBlockedReason, numSetting} from "./send";

// 系统发信上限可设的最大值。Joe 拍板 1000 → 老的 500 clamp 会静默截断，故放宽到 2000 留余量。
// （不设无穷：手滑多打一个 0 就把域名烧了，这类不可逆代价才值得一个上限。）
const LIMIT_MAX = 2000;
import { runDiscovery, getKeywords, seedDefaultKeywords, getSearchConfig, COUNTRIES, DEFAULT_COUNTRIES, recomputeKeywordStats, inferCountryFromWebsite, getSerperUsage, runNmeaDiscovery, runLinkHarvest, runDirectoryRefresh, RVWITHTITO_URL, RVWITHTITO_BLACKLIST, SERPER_DAILY_BUDGET_DEFAULT, findDuplicateLead } from "./discover";
import { findLeadEmail, diagnoseSite, type PageProbe } from "./findemail";
import { ingestReplies, matchReplyToLead } from "./replies";
import { ensureReplyColumns, stripQuoted, previewOf, isNoiseReply, tabOf, type InboxTab } from "./reply-inbox";
import { installFetchMeter, meteredDB, mark as subMark, reset as subReset, summary as subSummary } from "./subreq";
import { normalizeCustomerType, customerTypeLabel, classifyKillReason, KILL_REASONS } from "./taxonomy";

/**
 * ⭐⭐ C5-14：**一条线索一行数据长什么样，只在这里说一次。**
 *
 * 🔴 治的是这个根因（不是"详情页少了几个字段"，是两条路各查各的）：
 *   详情页 `/api/leads/:id` 走 `SELECT * FROM leads`，而 `match_score` / `has_open` /
 *   `has_click` / `has_followup` / `latest_reply_cat` **一个都不是 leads 表的列** —— 它们全是
 *   列表查询里现算的派生量。于是详情页读到 `undefined`，而 `undefined == null` 为真，
 *   `stageOf()` 就把**每一条已打分的 analyzed 线索**判成 unscored ⇒ 头部恒挂
 *   「🆕 待分析 · 官网抓不到」，哪怕它 88 分正躺在待审批里。
 *
 *   同一个根还打死了另外四处（读的都是 undefined，页面上一点异常都看不出来）：
 *     · isViewed 恒 false ⇒「🔥 趁热跟进」主按钮永不出现
 *     · 打开/点击/已跟进三个徽章（批④ 声称"补上了"）全是死代码
 *     · 「趁热跟进」整块永不渲染
 *   ⇒ 逐个补字段是修症状。真源只有一份，两条路就必须查同一份。
 *
 * ⚠️ 用它的查询必须保持 `leads l LEFT JOIN lead_analysis a ON a.lead_id = l.id` 这两个别名。
 */
const LEAD_ROW_COLS =
  "l.id, l.company_name, l.website, l.email, l.country, l.source, l.keyword, l.status, l.created_at, l.channels, " +
  "l.next_action, l.next_action_date, l.last_engaged_at, " +
  // 批⑲：这两列**只读**，给「待分析」分组页用 —— 组B 要显示官网抓不到的**具体原因**
  // （批⑰ 已把超时/403/TLS/DNS 分开落库），组A 要显示「重试中 n/3」让 Joe 知道机器在干活。
  // ⚠️ 只加列，**不动任何 WHERE**（口径一个字没变）。
  "l.fetch_fail_count AS fetch_fail_count, a.reason AS reason, " +
  "a.match_score AS match_score, a.customer_type AS customer_type, a.customer_category AS customer_category, " +
  // 跟进中派生标志：已发(sent)线索中，存在已发出的 followup 邮件
  "EXISTS (SELECT 1 FROM emails e WHERE e.lead_id = l.id AND e.kind='followup' AND e.status='sent') AS has_followup, " +
  // 参与度（冲刺1a）：是否有邮件被打开/点击
  "EXISTS (SELECT 1 FROM emails e WHERE e.lead_id = l.id AND e.opened_at IS NOT NULL) AS has_open, " +
  "EXISTS (SELECT 1 FROM emails e WHERE e.lead_id = l.id AND e.clicked_at IS NOT NULL) AS has_click, " +
  // 阶段派生：最新一条回复的类别，用于判「洽谈中/已婉拒」
  "(SELECT r.category FROM replies r WHERE r.lead_id = l.id ORDER BY r.id DESC LIMIT 1) AS latest_reply_cat, " +
  // 批③追加2：回复箱并入「已回复」页——每行一个线索 + 最新回复摘要/id（页面数据源仍是 /api/leads，不用 /api/replies）
  "(SELECT r.summary FROM replies r WHERE r.lead_id = l.id ORDER BY r.id DESC LIMIT 1) AS latest_reply_summary, " +
  "(SELECT r.id FROM replies r WHERE r.lead_id = l.id ORDER BY r.id DESC LIMIT 1) AS latest_reply_id";

/**
 * C5-13：给一行分析数据补上分类的中文标签，**不改机器值**。
 * 一个函数供所有出口用（列表 / 详情 / 筛选 / 看板），免得每个出口各拼各的。
 */
function withCategoryLabel<T extends { customer_category?: string | null }>(r: T): T & { customer_category_label: string } {
  return { ...r, customer_category_label: customerTypeLabel(r.customer_category) };
}
import { larkConfigured, larkUrlShape, larkSend, digestCard, testCard, inboundCard } from "./notify";
import { catalogHtml } from "./landing";
import { isIgnited, ignitionReport, notIgnitedReason, normalizeEnv, dirtySecretKeys } from "./ignition";
import { handleResendEvent, verifyResendSignature } from "./webhook";
import { larkAppConfigured, sendAppCard, syncLeadsToBitable, verifyLarkCallback, doneCard, testAppCard, bitableFieldsCheck, replyDoneCardV2, patchCardMessage, replyWorkbenchCard } from "./lark-app";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  OPENROUTER_API_KEY: string;
  SCORE_MODEL: string;
  EMAIL_MODEL: string;
  SITE_URL: string;
  RESEND_API_KEY: string;
  SENDER_EMAIL: string;
  SENDER_NAME: string;
  APP_URL: string;
  API_HOST?: string;        // #53 公开 API 正门主机名（AirSonde 未配=该分支不激活，全部留在 Access 门后）
  PUBLIC_API_URL?: string;  // #53 新邮件退订链接 base（send.ts 优先于 APP_URL 用它）
  ADMIN_HOST: string;   // 团队后台自定义域名（受 Cloudflare Access 保护）
  ADMIN_URL: string;    // 后台完整地址，用于飞书“打开后台”按钮
  SEARCH_PROVIDER: string;
  SEARCH_API_KEY: string;
  EMAIL_FINDER_API_KEY: string;
  ADMIN_USER: string;
  ADMIN_PASSWORD: string;
  LARK_IMAP_HOST: string;
  LARK_IMAP_PORT: string;
  LARK_IMAP_USER: string;
  LARK_IMAP_USER2?: string;   // 上游批㉘ 双收件箱第二账户（未配=单箱运行不报错；AirSonde 单箱）
  LARK_IMAP_PASS2?: string;
  LARK_IMAP_PASS: string;
  LARK_WEBHOOK_URL: string;      // 飞书群「自定义机器人」webhook（可选，配了才推送）
  // 官网询盘管道：官网 Pages Function 服务端转发时带 x-inbound-token。**未配 = 机器通道 fail-closed**
  //   （浏览器直投的老路径不受影响，见 /api/inbound 注释）。secret，绝不放 vars。
  INBOUND_TOKEN?: string;
  // ↓ dev 出站闸门用。**只存在于 .dev.vars**（wrangler dev 才读），生产 secrets 里没有 → 生产零影响。
  DEV_LOCAL?: string;            // "1" = 本地进程，装出站闸门（只准出 localhost）
  DEV_EGRESS_ALLOW?: string;     // 逗号分隔：逐个点名放行的真实主机（点名 = 明知故犯，会打横幅）
  LARK_WEBHOOK_SECRET: string;   // 飞书机器人签名密钥（可选，开了签名校验才需要）
  RESEND_WEBHOOK_SECRET: string; // Resend webhook 签名密钥（whsec_...，可选但强烈建议配）
  DEV_BYPASS_AUTH?: string;      // 仅本地 .dev.vars：跳过登录鉴权（生产无此变量）
  // 上游批㉔ Lark 应用（AirSonde 需另建自己的 Lark 应用，绝不复用 Wanew 的；国际版 open.larksuite.com）：多维表格镜像 + 应用机器人卡片。
  LARK_APP_ID?: string;              // cli_...（secret + .dev.vars）
  LARK_APP_SECRET?: string;          // 应用密钥（secret + .dev.vars）
  LARK_VERIFICATION_TOKEN?: string;  // 事件订阅 Verification Token（卡片回调校验，fail-closed：没配=拒收）
}

const app = new Hono<{ Bindings: Env }>();

// ---- 登录保护 ----
// - /u/ 退订页：对收件人公开（任何域名都不拦，合规必须）
// - localhost：本地开发免登录
// - 团队域名（crm.airsonde.com）：走 Cloudflare Access（每人邮箱验证码登录）。
//   Access 在边缘拦截未登录请求，只有登录后的请求才到 Worker，并带 Cf-Access-Authenticated-User-Email。
// - 其余（workers.dev）：保留 Basic Auth 作为应急/管理入口
app.use("*", async (c, next) => {
  if (c.req.path.startsWith("/u/")) return next();          // 退订页对收件人公开
  if (c.req.path.startsWith("/api/webhooks/")) return next(); // webhook 需公开（自带签名校验）
  if (c.req.path === "/api/inbound") return next();          // 询盘写端点：公开（官网 Function 转发；带 token 鉴权）
  // ⛔ C2-F：`/catalog` **从公开豁免里撤掉了**。公开面按总工定的只有三件：退订 · Resend webhook · 官网询盘转发。
  //   落地页不在其中，而它现在挂的是**未经 Joe 审的 IAQ 占位文案**（见 landing.ts 头部注释）——
  //   一个公网可达的页面替公司说没人审过的话，是 claims 纪律里最不该开的口子。
  //   页面本身**留着**（还能从后台看），要公开时把它加回这一行即可。
  // ⚠️ 批㉔ 修正顺序：DEV_BYPASS 必须在 301 **之前**。
  //   上游㉕a 第二刀曾把旧域 301 放最前（理由"本地能测 301"）——被实测证伪：wrangler dev 把**所有**本地请求的
  //   Host 钉成 routes 第一条 custom_domain，于是本地一切后台 API 全被 301 打去生产，
  //   本地开发直接瘫痪；而那个"本地 301 测试"因为 host-pin 本来就证明不了 host 分支（它对谁都 301）。
  //   （AirSonde 无旧域，301 块已随迁移删除；此教训保留——host-pin 语义不变。）
  //   DEV_BYPASS 只存在于 .dev.vars → 生产此行恒为假，语义零变化。
  // ⭐ H13（安全审计）：这一条以前是 **fail-open** —— `DEV_BYPASS_AUTH` 一旦被误设进生产，
  //   整个后台**静悄悄地全面免登录**，而且没有任何迹象。
  //   **一个被误配的后门，应该让服务停，而不是让服务安静地敞着。**
  //
  //   改法：放行需要**两个只存在于 .dev.vars 的变量同时成立**（DEV_BYPASS_AUTH=1 且 DEV_LOCAL=1）；
  //   只要这个变量**存在**却不满足该条件 → **503 停服**，不是忽略它继续跑。
  //   ⚠️ 为什么不是"检测生产环境"：那要依赖某个平台信号（cf-ray / request.cf），
  //      而那类信号我**只能在本地测一半**（生产那半要发版才测得到）—— 半截实测的平台假设
  //      正是今天栽过的形状。这里改用**纯配置逻辑**，本地就能完整验证。
  //   ⚠️ 想临时关掉本地免登录：**删掉这个变量**，不要设成 0 —— 设成 0 会 503（故意的，
  //      "存在但不生效"这种模糊状态本身就是这条漏洞的温床）。
  if (c.env.DEV_BYPASS_AUTH !== undefined) {
    if (c.env.DEV_BYPASS_AUTH === "1" && devGuardOn(c.env)) return next();   // 本地开发：两个 dev 变量齐备
    return c.text(
      "🚨 服务已停止：检测到免登录后门变量 DEV_BYPASS_AUTH，但它未满足本地开发条件。\n" +
      "  放行条件 = DEV_BYPASS_AUTH=1 **且** DEV_LOCAL=1，两者缺一不可。\n" +
      // ⚠️ 只报"哪个条件没满足"，**不回显变量值** —— 这是个未鉴权就能看到的页面，
      //   回显配置值和 M13 回显 webhook 前缀是同一个毛病。
      `  当前：DEV_BYPASS_AUTH=1 ? ${c.env.DEV_BYPASS_AUTH === "1" ? "是" : "否"} · DEV_LOCAL=1 ? ${devGuardOn(c.env) ? "是" : "否"}\n` +
      "如果这是生产：**删除** DEV_BYPASS_AUTH 后重新部署 —— 它是配置事故，不是功能。\n" +
      "如果这是本地：把两个变量都写进 .dev.vars（想临时关闭免登录请**删掉**变量，不要设成 0）。",
      503
    );
  }
  const host = (c.req.header("host") || "").split(":")[0].toLowerCase();
  // （上游此处有旧域 301 迁移块；AirSonde 无旧域，随迁移删除。）
  // ⛔ H12（安全审计）：这里原来是 `if (host === "localhost" || host === "127.0.0.1") return next();`
  //   —— **一律免登录**。它的安全性完全押在一个平台语义上：「Cloudflare 不会把 `Host: localhost`
  //   路由进 Worker」。**那条从来没被测过**，而我们不控制它。
  //
  //   ✅ 2026-07-29 上游实测（生产，三台主机）：
  //        crm 域  裸请求 → 302（Access 登录）  ·  加 `Host: localhost` → **403（Cloudflare 边缘）**
  //        workers.dev 裸请求 → 401（Basic）·  加 `Host: localhost` → **403**
  //      → 今天**不是可利用的洞**；请求根本到不了 Worker。
  //   ❌ 但这不构成保留它的理由：**把认证押在一个我们不控制、且今天才第一次测的边缘行为上**，
  //      等于给自己留一个只要平台行为变化就立刻敞开的门。
  //
  //   删掉而不是加开关（方案 B）的依据是**代码本身**，不是偏好：
  //     · 本地开发走的是上面那条 `DEV_BYPASS_AUTH`（它在**这一行之前**短路）；
  //     · 且 `wrangler dev` 把本地请求的 Host **钉成 routes 第一条 custom_domain**（crm.airsonde.com），
  //       所以这一行在本地**根本不会命中**。
  //   ⇒ 它对本地开发是**死代码**，只对生产是风险面。留着两条并行放行路径，迟早会漂。

  // #53 公开 API 正门：公开端点（/u · /api/webhooks/* · /api/inbound —— C2-F 起 /catalog 不在其中）
  //   已在本函数最前的路径豁免里 return next()、与域名无关 → 能走到这里的、API_HOST 上的都是**非公开路径**。
  //   在公开正门上一律 404，绝不把 admin API/后台面暴露出去（这台主机没有 Access/Basic 保护）。
  //   API_HOST 未配 = 分支惰性（AirSonde C1 未配 → 无公开面）。真 Host 分支只在生产生效
  //   （本地 wrangler dev 把 Host 钉成 routes 第一条 + DEV_BYPASS 已在前短路，测不到）。
  const apiHost = (c.env.API_HOST || "").trim().toLowerCase();
  if (apiHost && host === apiHost) return c.notFound();

  // ADMIN_HOST 逗号分隔多值 → 列表判断（上游迁域并行的机制保留；AirSonde 单值 crm.airsonde.com），
  //   每个都要求 cf-access-authenticated-user-email（Access 头）。
  const adminHosts = (c.env.ADMIN_HOST || "crm.airsonde.com")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (adminHosts.includes(host)) {
    const email = c.req.header("cf-access-authenticated-user-email");
    if (email) return next(); // 已通过 Access 登录
    // 该域名尚未在 Cloudflare Access 启用（否则请求到不了这里）
    return c.text(`此后台需通过 Cloudflare Access 登录。若刚绑定域名，请先在 Zero Trust 后台为 ${host} 配置 Access 应用。`, 403);
  }

  // L1：未配置 ADMIN_PASSWORD 时 fail-closed（拒绝），绝不用占位弱口令放行
  if (!c.env.ADMIN_PASSWORD) {
    return c.text("后台密码未配置（ADMIN_PASSWORD）。请管理员设置 secret 后再访问。", 503);
  }
  return basicAuth({
    username: c.env.ADMIN_USER || "airsonde",
    password: c.env.ADMIN_PASSWORD,
  })(c, next);
});

// ---- 当前登录用户（Access 注入的邮箱；workers.dev/Basic Auth 下为 null）----
app.get("/api/me", (c) => {
  const email = c.req.header("cf-access-authenticated-user-email") || null;
  return c.json({ email, mode: email ? "access" : "basic" });
});

// ---- 后台可见的状态分组 ----
const STATUS_GROUPS: Record<string, string[]> = {
  all: [],
  pending: ["new", "analyzed", "pending"], // 兼容旧调用
  // ⚠️ 批⑭②：只列 status，加不了 match_score 条件 → 待分析真口径在 UNSCORED_SHOW_WHERE（group=unscored 分支）。
  //    这里保留 ["new"] 只为兼容旧调用；真口径已不止 new。
  unscored: ["new"],
  // ⚠️ 这个表**只能列 status，加不了 match_score 条件** → 「待审批」的真口径不在这里，在 REVIEW_WHERE。
  //    改口径要**四处一起**：REVIEW_WHERE + /api/stats 的 reviewScored + 前端 map + facets。
  //    我在 `group==='sent'` 那次就是只改了看得见的两处、SQL 里那半没改，直接翻车。
  review: ["analyzed", "pending"],          // 仅 status 维度；真口径见 REVIEW_WHERE
  approved: ["approved", "queued", "sent"], // 兼容旧调用（含已发）
  ready: ["approved", "queued"],            // 左栏「待发送」：已批准未发（排除已发）
  sent: ["sent"],                           // 左栏「已发送」：已发出
  replied: ["replied"],
  won: ["won"],
  ignored: ["ignored"],
  blacklisted: ["blacklisted", "unsubscribed", "bounced"],
};

// ⭐⭐ 批⑬①：「待审批」的**唯一真口径** —— AI 判完了（有分数）且等人拍板。
//
// Joe 实测撞出来的："没有分数的 79 条信息在待审批里面合适吗？" —— 不合适，**格子在说谎**。
// 那 79 条是**连续 3-4 次抓不到官网、AI 根本没判成**的 —— 它们不是"等你拍板"，是**一个故障**。
// 而且它们**卡死了**：cron 只捡 `status='new'`，这些已经是 'analyzed' → 永远不会被重扫、
// 永远批不了，就躺在那儿占位置。→ 它们进「待办事项」的系统警报（见 /api/today 的 alerts.noScore）。
//
// ⚠️ **口径散在四处、没有真源**，正是"待审批 194 vs 真值 115"能长期存在的原因。
//    用它的地方：/api/leads 的 group=review、/api/leads/facets、/api/stats 的 reviewScored。
const REVIEW_WHERE = "l.status IN ('analyzed','pending') AND a.match_score IS NOT NULL";

// ⚠️⚠️ C5-8：「这封回信还需要 Joe 出手吗」——**唯一口径**，两个消费方共用这一份。
//   缺陷原文：/api/today 的 hotReplies **不看 handled_at** ⇒ Joe 在工作台点过「已处理」，
//   待办上那条**永远不消失**，直到线索转成交/忽略为止。
//   ⇒ 提成常量而不是两处各写一遍 —— 这次的缺陷正是"两处手写不同步"造成的，
//     修成"两处此刻碰巧一致"不算修（总调度原话，同意）。
//   ⚠️ 生产库已确认有 `handled_at` 列（2026-08-31 PRAGMA 实查，不是从 schema.sql 推断），
//     所以这里直接引用它，不需要 COALESCE 兜底，也不必让 /api/today 去补列。
const UNHANDLED_HOT_REPLY_WHERE =
  "r.category IN ('interested','inquiry') AND r.handled_at IS NULL " +
  "AND (l.status IS NULL OR l.status NOT IN ('won','ignored','blacklisted'))";
/** status 是 analyzed/pending 但**没分数**的那些 —— 抓不到官网、AI 判不了。
 *  ⚠️ 批⑭ 改了对它们的定性：**不是"故障"，是"信息不全"**（Joe 定的）——
 *     工具没够着 ≠ 线索不合格。它们回「待分析」，跟 status='new' 的一起等处理，不再进 off-funnel 桶。 */
const NO_SCORE_WHERE = "l.status IN ('analyzed','pending') AND a.match_score IS NULL";

// ⭐⭐ 批⑭②：「待分析」的**展示口径** = 还没打分的全体（无论卡在哪个 status）。
//   = status='new'（cron 会捡去打分）+ analyzed/pending 但无分（抓不到官网、等人工介入）。
//   Joe 定的："每条线索都必须在某个格子里、算进总数 —— 全部恒等于左栏各格之和。off-funnel 隐藏桶不许存在。"
//   批⑬② 我把 analyzed-无分 塞进了「系统警报」的隐藏桶（off-funnel）→ 那正是这条要撤的。
//
// ⚠️⚠️ **这只是展示口径，不是 cron 处理口径**。cron 打分永远只捡 `status='new'`
//   （见下面 analyze 那步的 SQL，一个字没动）—— analyzed-无分的**不会**被 cron 反复重抓，
//   不会有 fetch_fail_count 风暴。展示口径和处理口径是两条独立的 SQL，这是 Joe 明确要的分离。
const UNSCORED_SHOW_WHERE = "(l.status='new' OR (l.status IN ('analyzed','pending') AND a.match_score IS NULL))";


const ALLOWED_STATUS = new Set([
  "new", "analyzed", "pending", "approved", "queued", "sent",
  "replied", "unsubscribed", "bounced", "ignored", "blacklisted", "won",
  // A3：no_reply 已移除——孤儿状态，全局无任何写入方（仅 2 处纯展示查表且都有兜底）
]);

// 批④ 找客户「积压刹车条」：进货前先看管道里堵了多少。
// 瓶颈往往不是线索不够，是 199 家没打分 / 296 家缺邮箱堵在中间 —— 这时再抓 1300 家只会堵得更死。
async function getBacklog(env: Env): Promise<{ unscored: number; noEmail: number; sendable: number }> {
  const db = env.DB;
  const q = async (sql: string) => (await db.prepare(sql).first<{ n: number }>())?.n || 0;
  return {
    // 没打分：进来了还没过 AI（cron 会慢慢消化，但堆太多就是堵）
    // 批⑭②：待分析 = new + analyzed无分。⚠️ 用 LEFT JOIN —— 连 analysis 行都没有的（从没分析过）
    //   也是"没分数"，INNER JOIN 会漏掉它们（那正是要找的那批，抓不到官网可能压根没建 analysis 行）。
    unscored: await q("SELECT COUNT(*) AS n FROM leads l LEFT JOIN lead_analysis a ON a.lead_id=l.id WHERE (l.status='new' OR (l.status IN ('analyzed','pending') AND a.match_score IS NULL))"),
    // 缺邮箱：打了分但没邮箱 → 发不出去，卡在待审批
    noEmail: await q("SELECT COUNT(*) AS n FROM leads l JOIN lead_analysis a ON a.lead_id=l.id WHERE (l.email IS NULL OR l.email='') AND l.status IN ('analyzed','pending','approved','queued')"),
    // 能发没发：真能发出去却还躺着（与待办事项 sendable 同一口径）
    sendable: await q(
      `SELECT COUNT(*) AS n FROM leads l JOIN lead_analysis a ON a.lead_id=l.id
        WHERE l.status='approved' AND a.match_score >= ${APPROVE_MIN_SCORE}
          AND l.email IS NOT NULL AND l.email!=''
          AND lower(l.email) NOT IN (SELECT email FROM suppressed_emails)`),
  };
}

// A1 待发送准入门槛（单一真源，bulk-status 与单条 status 共用）：
// 置 approved 必须 有邮箱 且 已打分 且 ≥60（与发送端 sendApprovedBatch 的 ≥60 门槛一致）。
// 返回 null=可批准；否则返回拒绝原因。
// 注意：index.ts 是 Worker 入口模块，顶层 export 的非函数值会被运行时当成 handler 校验并报
// "Incorrect type for map entry"（dry-run 查不出、只有真启动才报）→ 这里必须是模块内常量，不能 export。
const APPROVE_MIN_SCORE = 60;
// ⭐ 两档制（Joe 拍板）：**60 是全系统唯一的决策线**。
//   ≥60 有邮箱 → 机器自动发；<60 → 进「翻牌堆」由 Joe 复核。60-69 的人工拍板区**已取消**。
//   道理：机器误发一封信成本低、可见、有熔断器兜底；机器误杀一个真客户损失一单、不可见、无兜底
//   （cayelectronics / 12volt / flarespace / seasucker 都是被埋过的实证）→ 人的火力对准「机器扔掉的堆」。
//   做成设置项不写死常量：门槛是运营参数，Joe 该能自己调（且 index.ts 顶层 export 非函数会让 Worker
//   起不来 —— 上次 `export const APPROVE_MIN_SCORE` 的教训，dry-run 还查不出来）。
const AUTO_APPROVE_MIN_DEFAULT = 60;
async function getAutoApproveMin(env: Env): Promise<number> {
  const v = Number(await getSetting(env, "auto_approve_min", String(AUTO_APPROVE_MIN_DEFAULT)));
  // 不许低于 APPROVE_MIN_SCORE：低了也没用，approveGateReason 那条护栏照样拦，只会造成"设了却不生效"的假象
  return Number.isFinite(v) ? Math.max(APPROVE_MIN_SCORE, Math.min(100, v)) : AUTO_APPROVE_MIN_DEFAULT;
}
/**
 * 「待发送」准入的**单一真源**。bulk-status / :id/status / 自动批准 全部走它。
 *
 * humanApproved：Joe 在翻牌堆里对**单条** <60 线索亲手按过「手动发这家」。
 *   · 只豁免**分数线**这一条 —— 邮箱仍然必须有（没邮箱根本发不了，豁免它没有意义）
 *   · 幂等/压制名单/每日上限/原子取批 全都不在这个函数里，一个也豁免不到
 *   · "未打分"也不豁免：未打分 ≠ 低分，它多半是官网抓不到（见 service.ts FETCH_FAIL_MAX），
 *     那种情况该去补网址重新分析，不是硬发一封基于空白信息写出来的信
 */
/**
 * 读 JSON body。解析失败（空 body / 坏 JSON）→ 返回 `{}`。
 *
 * ⭐ 为什么要这个 helper：原来 26 处都写成 `c.req.json<T>().catch(() => ({}))` ——
 *   `.catch` 里那个 `{}` 把返回类型撑成了 `T | {}`，于是访问 T 的任何字段都是类型错误。
 *   **这一个写法造出了 98 个类型错误里的 90 个**，也正是这个项目一直开不了类型检查的原因：
 *   错误太多 → tsc 永远返回 1 → 闸没法用 → 干脆没装 typescript →
 *   然后 `pool`/`imap` 漏 import 而 boot 亮绿灯这种事就没人抓得到。
 *
 * 返回 `Partial<T>` 是**诚实的**：body 解析失败时字段确实全都不在。
 * 各调用点本来就在自己校验（`if (!id) return 400` 那些），**运行时语义一个字没变**。
 */
// ⚠️ 这一行是**唯一**该调 c.req.json 的地方 —— 我批量替换时正则把它自己也改成了 `jsonBody<T>(c)`，
//    造出一个**调用自己的无限递归**（所有 POST 端点栈溢出）。别再把它"统一"掉。
async function jsonBody<T extends object>(c: { req: { json: <X>() => Promise<X> } }): Promise<Partial<T>> {
  return (await c.req.json<T>().catch(() => ({}))) as Partial<T>;
}

// ⭐⭐ 批⑨①：**闸分两条。这个函数守的是「批准触达」，不是「批准发邮件」。**
//
// Joe 的原话：「**邮箱和社媒都只是手段**……哪些邮箱发过邮件，就做一个标识，
//   而不是把邮箱和社媒当成两套独立的系统。」
//
// 所以「缺邮箱不能批准」那条**删掉了**。它把"手段"混进了"该不该碰这家公司"的判断里：
//   生产实测 96 家 ≥60 分、有社媒能碰、只是没邮箱 —— 它们被这条闸永远钉在待审批格，
//   界面上没有任何出口。这不是"批准"该管的事。
//
// ⚠️ 这不是把闸放松，是**还原 `approved` 本来的含义**（总工拍板：不新造 `ready` 这个词）——
//    approved = **值得碰**；能不能发邮件是**发送那一刻**的事，由 sendApprovedBatch 的
//    `l.email IS NOT NULL` 守（批⑨① 同批加的，见 send.ts）。**两条闸，各守各的。**
//
// ⚠️⚠️ 顺序死钉：send.ts 那条 email 过滤**必须先于或同批于**这里的放宽。
//    中间哪怕只隔一轮 cron，96 家无邮箱线索就会挤进发送池、占满配额槽、
//    取出来发不掉又回滚 → **真实发信量趋近 0 且全程静默**。两处在同一个 commit 里。
function approveGateReason(email: string | null, score: number | null, humanApproved = false): string | null {
  // ⭐⭐ 批⑭①：`&& !humanApproved` —— 给"必须有分数"这句开一道**人工豁免**，跟下面那句对分数线的
  //   豁免**完全同构**。Joe 定的："缺数据（没分/没官网/没邮箱）是'信息不全'，永远不是'不合格'"
  //   —— 抓不到官网的线索，Joe 要能**凭公司名+国家+邮箱人工判、不等 AI 给分**就批准去联系。
  //
  //   ⚠️ 这**不是绕过它，是加一个和现有豁免同结构的口子**：
  //     · 自动通道（cron auto-approve / bulk 审批，**不传 humanApproved**）→ 照样要求有分数，一个字没松
  //     · **只有 Joe 亲手点** /leads/:id/human-approve（传 true）→ 才能越过"没分数"
  //   邮箱那条**不在这个函数管**：human-approve 端点里的 M3 合规终态（unsubscribed/blacklisted/bounced）
  //   照拦——那是红线里的红线，人工豁免碰不到它。
  if (score == null && !humanApproved) return "未打分，不能批准（先 AI 分析，或人工放行）";
  // score != null 分支才有"分数线"可言。humanApproved=true 且无分数时直接放行（人工判过了，没有分数线可比）。
  if (score != null && score < APPROVE_MIN_SCORE && !humanApproved) return `${score} 分 < ${APPROVE_MIN_SCORE} 分门槛，不能批准`;
  return null;
}

// ---- 统计：按状态计数 ----
app.get("/api/stats", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT status, COUNT(*) AS n FROM leads GROUP BY status"
  ).all();
  const byStatus: Record<string, number> = {};
  let total = 0;
  for (const r of rows.results as any[]) {
    byStatus[r.status] = r.n;
    total += r.n;
  }
  // ⭐⭐ 批⑬①：左栏「待审批」的真值。**前端算不出来** —— 它拿的是 byStatus（按 status 分组累加），
  //   而"有没有分数"是 lead_analysis 上的维度，status 里没有这个信息。
  //   不给这两个数，左栏就会继续显示 194（含 79 条 AI 根本没判成的）—— **格子继续说谎**。
  //   这是"连根拔"的第三根：**后端 SQL 改了、列表对了，左栏还是错的**。
  const reviewScored = (await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM leads l JOIN lead_analysis a ON a.lead_id=l.id WHERE ${REVIEW_WHERE}`
  ).first<{ n: number }>())?.n || 0;
  // ⭐⭐ 批⑭②：左栏「待分析」真值。**前端算不出来** —— 它的 map 按 status 累加，只数到 status='new'，
  //   漏掉 analyzed-无分 的（"有没有分数"是 lead_analysis 维度，status 里没有）。
  //   不给这个数，左栏显示 1（只 new），而列表返回 6 —— 批⑬① 那次漏了这第三根，这次又踩一次，实测才露。
  //   LEFT JOIN：连 analysis 行都没有的也算没分数。
  const unscoredShow = (await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM leads l LEFT JOIN lead_analysis a ON a.lead_id=l.id WHERE ${UNSCORED_SHOW_WHERE}`
  ).first<{ n: number }>())?.n || 0;

  // #39 已查看：status=sent 且有点击（与「已发送」互斥，供左栏漏斗把 sent 拆成 已发送/已查看）
  const vr = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM leads l WHERE l.status='sent' AND EXISTS (SELECT 1 FROM emails e WHERE e.lead_id=l.id AND e.clicked_at IS NOT NULL)"
  ).first<{ n: number }>();
  // reviewScored：左栏「待审批」的真值（批⑬①）—— 前端算不出来（byStatus 只有 status 维度）
  // 批㉑：把国家名目录一起带出去 —— 前端 countryName 用它填（单源=后端 COUNTRIES），
  //   列表页在没打开「找客户」时也能把新市场（vg/pg…）显示成中文名，不是裸 gl 码。
  return c.json({ total, byStatus, viewed: vr?.n || 0, reviewScored, unscoredShow, allCountries: COUNTRIES });
});

// #47 行动建议引擎（数据看板 + 今日待办共用同一份逻辑）：按规则算出当前最该做的事，按紧急度取前 4 条。
// cta.action 由前端 dashAction() 映射到对应页面/分组/操作。
async function buildActionSuggestions(env: Env): Promise<{
  actions: { text: string; cta: { label: string; action: string } | null }[];
  highNoEmail: number; readyCount: number; reviewCount: number;
}> {
  const db = env.DB;
  const statusRows = await db.prepare("SELECT status, COUNT(*) AS n FROM leads GROUP BY status").all();
  const f: Record<string, number> = {}; let total = 0;
  for (const r of statusRows.results as any[]) { f[r.status] = r.n; total += r.n; }
  const F = (s: string) => f[s] || 0;
  const sentLeads = (await db.prepare("SELECT COUNT(DISTINCT lead_id) AS n FROM emails WHERE status='sent'").first<{ n: number }>())?.n || 0;
  const viewed = (await db.prepare("SELECT COUNT(*) AS n FROM leads l WHERE l.status='sent' AND EXISTS (SELECT 1 FROM emails e WHERE e.lead_id=l.id AND e.clicked_at IS NOT NULL)").first<{ n: number }>())?.n || 0;
  // ⭐ 两档制：≥60 无邮箱 = 触达工作台的队列（机器发不了、只能 Joe 用社媒/电话手动碰）——这是真人工活，留着。
  //    门槛从 80 对齐到 60：80 那条线不对应任何决策，纯装饰。
  const highNoEmail = (await db.prepare(`SELECT COUNT(*) AS n FROM leads l JOIN lead_analysis a ON a.lead_id=l.id WHERE a.match_score>=${APPROVE_MIN_SCORE} AND (l.email IS NULL OR l.email='') AND l.status NOT IN ('blacklisted','unsubscribed','bounced')`).first<{ n: number }>())?.n || 0;
  const replied = F("replied"), bounced = F("bounced"), unsub = F("unsubscribed");
  const readyCount = F("approved") + F("queued");
  const reviewCount = F("analyzed") + F("pending");
  const rate = (x: number) => (sentLeads > 0 ? x / sentLeads : 0);
  // 累计漏斗（同 #43 口径）求最狠掉点
  const wonC = F("won"), replyC = F("replied") + wonC;
  const viewC = Math.min(F("sent"), viewed) + F("replied") + wonC;
  const sentC = sentLeads, approveC = F("approved") + F("queued") + sentC;
  const poolC = Math.max(total - (F("blacklisted") + F("unsubscribed") + F("bounced")), approveC);
  const lv = [{ l: "已入池", n: poolC }, { l: "已批准", n: approveC }, { l: "已发送", n: sentC }, { l: "已查看", n: viewC }, { l: "已回复", n: replyC }, { l: "成交", n: wonC }];
  let worstJump: { from: string; to: string; conv: number } | null = null;
  for (let i = 1; i < lv.length; i++) {
    if (lv[i - 1].n <= 0) continue;
    const conv = Math.min(100, Math.round((lv[i].n / lv[i - 1].n) * 100));
    if (!worstJump || conv < worstJump.conv) worstJump = { from: lv[i - 1].l, to: lv[i].l, conv };
  }
  const bounceRate = rate(bounced), unsubRate = rate(unsub);
  const acts: { text: string; cta: { label: string; action: string } | null; pri: number }[] = [];
  if (replied > 0) acts.push({ pri: 100, text: `${replied} 条回复待跟进`, cta: { label: "去回复箱", action: "replies" } });
  // ⭐ 两档制删掉的三张卡（它们都在喊 Joe 去干机器的活，违反"能批量化的 AI 做"）：
  //  · 「N 家待发送，今天群发」/「≥80 没发开发信」→ ≥60 有邮箱现在**自动发**。没发出去只会是
  //    每日上限（设计如此）或熔断（有自己的横幅+告警卡）——都不需要 Joe 去点群发。
  //  · 「≥70 家高分可批准」→ 自动批准干了。
  // 留下的 highNoEmail：≥60 无邮箱＝机器碰不到，只能 Joe 手动触达 → 真人工活（C/D 的工作台队列）。
  if (reviewCount > 0) acts.push({ pri: 76, text: `${reviewCount} 家已打分待审批`, cta: { label: "去审核", action: "group:review" } });
  if (highNoEmail > 0) acts.push({ pri: 70, text: `${highNoEmail} 家 ≥${APPROVE_MIN_SCORE} 分没邮箱，机器发不了`, cta: { label: "去补邮箱", action: "findmail" } });
  if (bounceRate > 0.03) acts.push({ pri: 60, text: `退信率 ${(bounceRate * 100).toFixed(1)}% 偏高，邮箱质量差，建议收紧补邮箱来源`, cta: { label: "看退信/黑名单", action: "group:blacklisted" } });
  if (unsubRate > 0.05) acts.push({ pri: 50, text: `退订率 ${(unsubRate * 100).toFixed(1)}% 偏高，检查发信频率/相关性`, cta: null });
  if (worstJump && worstJump.conv < 50) acts.push({ pri: 40, text: `『${worstJump.from}→${worstJump.to}』转化仅 ${worstJump.conv}%，建议优化开发信/跟进`, cta: null });
  if (sentLeads >= 10 && replied === 0) acts.push({ pri: 30, text: `已发 ${sentLeads} 封暂无回复，主题待优化或量还小`, cta: null });
  acts.sort((a, b) => b.pri - a.pri);
  const actions = acts.slice(0, 4).map(({ pri, ...rest }) => rest);
  return { actions, highNoEmail, readyCount, reviewCount };
}

// ---- 发信健康度（只读）----
//
// 为什么单开：退订率/退信率/回复率这些数以前只活在**分析报告里**，Joe 在后台一个都看不到。
// 2026-07-28 就是这么栽的：出信量被砍到 10 封/天，连续三天没人发现。
//
// ⚠️ 这个端点的每个数都必须**说清自己的口径**，否则就是下一个"数字没错但骗人"：
//   · 分母一律是「**真被发过信的线索**」，不是 leads 全表。
//     （实测差别巨大：leads 里 status='bounced' 有 6 条，但其中只有 1 条真被发过信 →
//       拿 6 当分子会把退信率高估 6 倍。）
//   · 退订要分「首触退的」vs「跟进退的」——82% 发生在首触，混在一起会让人去调跟进节奏，修错地方。
//   · **疑似机器误退订单列**：企业安全网关抓链接会触发 GET 退订（已修，但历史数据里有）。
//     判别法=退订时刻距最后一封发信 <120 秒（实测最快 5 秒且无开信记录，人做不到）。
//     ⚠️ 这是**近似**：用 leads.updated_at 当退订时刻（没有专门的退订时间戳），前端必须标注。
//   · **开信率不给**：Apple 隐私预取/安全网关会伪造开信，55-70% 的冷发开信率不是真的。
//     宁可不显示，也不给一个会让人做错决定的数。
app.get("/api/health/sending", async (c) => {
  const db = c.env.DB;
  const sys = await systemDailySendLimit(c.env);
  const auto = await autoSendDailyLimit(c.env, sys.effective);

  // 分母：真被发过冷发信的线索数
  const base = await db.prepare(
    `SELECT COUNT(DISTINCT lead_id) AS touched FROM emails
      WHERE status='sent' AND COALESCE(kind,'initial') IN ('initial','followup')`
  ).first<{ touched: number }>();
  const touched = base?.touched ?? 0;
  // ⚠️ 老看板的「已触达(家)」数的是**所有** status='sent' 的信（含询盘确认/回信），
  //    我这里只数冷发 —— 两个数**今天相等（生产实测 143=143），但一旦确认信开始发就会分叉**。
  //    同一页出现两个"触达"数字而不解释 = 这个代码库反复警告过的"口径打架"。
  //    所以把差额算出来显式说明，而不是偷偷用不同分母、也不去改老看板的既有语义。
  const anySent = await db.prepare(
    "SELECT COUNT(DISTINCT lead_id) AS n FROM emails WHERE status='sent'"
  ).first<{ n: number }>();
  const transactionalOnly = Math.max(0, (anySent?.n ?? 0) - touched);

  // 退订：总数 / 疑似机器(<120s) / 首触退 vs 跟进退
  const u = await db.prepare(
    `WITH u AS (
       SELECT l.id, l.updated_at AS ua,
              (SELECT MAX(e.sent_at) FROM emails e WHERE e.lead_id=l.id AND e.status='sent') AS sa,
              (SELECT COUNT(*) FROM emails e WHERE e.lead_id=l.id AND e.status='sent') AS cnt
         FROM leads l WHERE l.status='unsubscribed'
          AND EXISTS(SELECT 1 FROM emails e WHERE e.lead_id=l.id AND e.status='sent'))
     SELECT COUNT(*) AS total,
            -- ⚠️ 必须限定在 [0,120)：**负差值不是机器**，它意味着"退订时刻早于最后一封发信"
            --    （本地造数时撞出来的：只写 "小于 120" 会把负数一并算进去 → 把人退订误报成机器误退订，
            --      而这个数是要拿来给退订率"扣分"的 → 会让真实退订率被系统性低估）。
            SUM(CASE WHEN sa IS NOT NULL
                      AND (julianday(ua)-julianday(sa))*86400 >= 0
                      AND (julianday(ua)-julianday(sa))*86400 < 120 THEN 1 ELSE 0 END) AS machine_like,
            SUM(CASE WHEN cnt <= 1 THEN 1 ELSE 0 END) AS after_initial,
            SUM(CASE WHEN cnt > 1 THEN 1 ELSE 0 END) AS after_followup
       FROM u`
  ).first<{ total: number; machine_like: number; after_initial: number; after_followup: number }>();

  // 退信：只算真被发过信的（见上面注释里那个 6 vs 1 的坑）
  const b = await db.prepare(
    `SELECT COUNT(*) AS n FROM leads l WHERE l.status='bounced'
       AND EXISTS(SELECT 1 FROM emails e WHERE e.lead_id=l.id AND e.status='sent')`
  ).first<{ n: number }>();

  // 回复：按**线索**算（一个线索回多封只算一次），并给出热回复数
  const r = await db.prepare(
    `SELECT COUNT(DISTINCT lead_id) AS leads_replied FROM replies WHERE lead_id IS NOT NULL`
  ).first<{ leads_replied: number }>();
  const hot = await db.prepare(
    `SELECT COUNT(*) AS n FROM replies WHERE category IN ('interested','inquiry')`
  ).first<{ n: number }>();

  const total = u?.total ?? 0, machine = u?.machine_like ?? 0;
  const pct = (n: number) => (touched ? Math.round((n / touched) * 1000) / 10 : 0);
  return c.json({
    touched, transactional_only: transactionalOnly,
    unsub: {
      total, machine_like: machine, human_like: Math.max(0, total - machine),
      after_initial: u?.after_initial ?? 0, after_followup: u?.after_followup ?? 0,
      pct_total: pct(total), pct_human: pct(Math.max(0, total - machine)),
    },
    bounced: { n: b?.n ?? 0, pct: pct(b?.n ?? 0) },
    replied: { leads: r?.leads_replied ?? 0, pct: pct(r?.leads_replied ?? 0), hot: hot?.n ?? 0 },
    // ⭐ `sent` / `failed`：看板上"今天到底发出去了什么"必须**由这两个数派生**。
    //   起因（2026-08-01）：那段横幅写死了一句"今天发出的是「无回复自动跟进」"，
    //   而实测跟进已经连续 4 天一封没发出去 —— **界面在报告一件没有发生的事**。
    //   写死的说明文字会在系统坏掉时继续说"一切正常"，这是最贵的一类假绿灯。
    today: {
      cold_sent: await coldSentToday(c.env), effective: sys.effective, ceiling: sys.limit,
      sent: await sentTodayBreakdown(c.env),      // 今天真发出去的（status='sent'）
      failed: await failedTodayBreakdown(c.env),  // 今天真失败的（status='failed'，含起草阶段就挂的）
    },
    ramp: { enabled: sys.rampEnabled, cap: sys.rampCap, yesterday_cold: sys.yesterdayCold },
    auto: {
      enabled: await autoSendEnabled(c.env),
      limit: auto.limit, source: auto.source,
      sent_today: await autoSentToday(c.env),
    },
    limit_source: sys.source,
    // ⭐ 可发池 = 已批准**且有邮箱**。这是真正决定"机器今天还能发几封"的数 ——
    //   2026-07-28 诊断时它只有 25，而日上限设的是 1000：**上限从来不是瓶颈**。
    //   把 stuck（已批准但没邮箱）并排显示，否则"可发 25"看着像池子小，
    //   而真相是"有 119 家在门口卡着，只差一个邮箱地址"。
    pool: {
      sendable: (await c.env.DB.prepare(
        "SELECT COUNT(*) AS n FROM leads WHERE status='approved' AND email IS NOT NULL AND email<>''"
      ).first<{ n: number }>())?.n ?? 0,
      stuck_no_email: (await c.env.DB.prepare(
        "SELECT COUNT(*) AS n FROM leads WHERE status='approved' AND (email IS NULL OR email='')"
      ).first<{ n: number }>())?.n ?? 0,
      find_email_enabled: (await getSetting(c.env, "find_email_enabled", "1")) === "1",
      find_email_last: await getSetting(c.env, "find_email_last", ""),
      // ⭐ 每轮无条件写的那条记录（含 outcome/attempted/found/失败分类）——
      //   `find_email_last` 只在补到时才写，**"没跑"和"跑了0命中"分不开**；这一条才分得开。
      find_email_run: await getSetting(c.env, "find_email_run", ""),
    },
  });
});

// ---- 数据看板：获客漏斗 + 关键指标聚合（走鉴权，非公开）----
// 全部为静态 SQL（无用户输入），天然无注入风险；日期用 SQLite date() 以 UTC 对齐前端。
app.get("/api/dashboard", async (c) => {
  const db = c.env.DB;

  // 1) 漏斗各状态计数
  const statusRows = await db.prepare("SELECT status, COUNT(*) AS n FROM leads GROUP BY status").all();
  const funnel: Record<string, number> = {};
  let total = 0;
  for (const r of statusRows.results as any[]) { funnel[r.status] = r.n; total += r.n; }
  const F = (s: string) => funnel[s] || 0;

  // 2) 发送总量 + 关键率（分母 = 去重后已发送到的线索数，因回复后 lead 状态不再是 sent）
  const emailsSentRow = await db.prepare("SELECT COUNT(*) AS n FROM emails WHERE status='sent'").first<{ n: number }>();
  const sentLeadsRow = await db.prepare("SELECT COUNT(DISTINCT lead_id) AS n FROM emails WHERE status='sent'").first<{ n: number }>();
  const emailsSent = emailsSentRow?.n || 0;
  const sentLeads = sentLeadsRow?.n || 0;
  const replied = F("replied"), bounced = F("bounced"), unsubscribed = F("unsubscribed");
  const rate = (x: number) => (sentLeads > 0 ? x / sentLeads : 0);

  // 3) 维度切片：国家 / 分类 / 关键词 —— **发信 → 回信 对比**（C5-7 块2）
  //
  // ⚠️ C5-7 前的形状是 `{v, n}`，n = **线索数**。那个数回答不了"力气该花哪儿"：
  //    某个国家线索多，只说明它好搜，不说明它回信。改成三列：
  //      n           = 线索数（保留，做基数与样本量锁的分母）
  //      sentLeads   = 这一维里**真发出过信**的线索数（DISTINCT，一家发三封只算一家）
  //      repliedLeads= 这一维里**真回过信**的线索数
  //    回信率 = repliedLeads / sentLeads，由前端在 n >= N_MIN 时才算（沿用既有样本量锁）。
  // ⚠️ 就地改形而非并排加列：改形前 grep 过全仓，`byCountry`/`byCategory` 的消费方
  //    **只有看板那两行**（index.html 4072/4073），而本单正在重建它。
  //    并排加一套就成了"同一个事实两个字段"，正是这仓一路在修的病。
  const dimSlice = (label: string, from: string, group: string) => db.prepare(
    `SELECT ${group} AS v, COUNT(DISTINCT l.id) AS n,
            COUNT(DISTINCT CASE WHEN EXISTS (SELECT 1 FROM emails e WHERE e.lead_id=l.id AND e.status='sent')
                                THEN l.id END) AS sentLeads,
            COUNT(DISTINCT CASE WHEN EXISTS (SELECT 1 FROM replies r WHERE r.lead_id=l.id)
                                THEN l.id END) AS repliedLeads
     FROM ${from}
     WHERE ${group} IS NOT NULL AND ${group} != ''
     GROUP BY ${group} ORDER BY n DESC`
  );
  const byCountry = (await dimSlice("country", "leads l", "UPPER(l.country)").all()).results;
  // C5-13：看板切片按 slug 分组（机器值），出门时补中文标签 —— 屏幕上别出现 monitoring-service。
  const byCategory = ((await dimSlice("category", "leads l JOIN lead_analysis a ON a.lead_id = l.id", "a.customer_category").all()).results as any[])
    .map((r) => ({ ...r, v: customerTypeLabel(r.v) }));
  // 关键词维度**此前完全没有** —— 而"哪个词带来回信"正是方向盘上唯一能直接动的杆。
  const byKeyword = (await dimSlice("keyword", "leads l", "l.keyword").all()).results;

  // 批④：按「收件箱类型」切片（通用箱 info@/support@ · 销售箱 sales@/team@ · 个人箱）
  // 只给 发送(唯一线索)/退订/互动 三个**计数**；比率交前端在 n>=50 时才算（与主比率同一把样本量锁）。
  const byInbox = (await db.prepare(
    `SELECT CASE
        WHEN lower(substr(l.email,1,instr(l.email,'@')-1)) IN
          ('info','support','contact','hello','admin','office','enquiries','enquiry','inquiry','inquiries','mail','general','reception','service')
          THEN 'generic'
        WHEN lower(substr(l.email,1,instr(l.email,'@')-1)) IN
          ('sales','team','biz','business','partners','partner','wholesale','orders','order','marketing','purchasing','procurement')
          THEN 'sales'
        ELSE 'personal' END AS box,
       COUNT(DISTINCT l.id) AS sent,
       SUM(CASE WHEN l.status='unsubscribed' THEN 1 ELSE 0 END) AS unsub,
       SUM(CASE WHEN l.status IN ('replied','won')
                  OR EXISTS (SELECT 1 FROM emails e2 WHERE e2.lead_id=l.id AND e2.clicked_at IS NOT NULL)
                THEN 1 ELSE 0 END) AS engaged
       FROM leads l
      WHERE l.email IS NOT NULL AND l.email!='' AND instr(l.email,'@')>1
        AND EXISTS (SELECT 1 FROM emails e WHERE e.lead_id=l.id AND e.status='sent')
      GROUP BY box ORDER BY sent DESC`
  ).all()).results;

  // 4) 近 14 天每日发送 / 回复
  const sentDaily = (await db.prepare(
    "SELECT date(sent_at) AS d, COUNT(*) AS n FROM emails WHERE status='sent' AND sent_at IS NOT NULL AND date(sent_at) >= date('now','-13 days') GROUP BY date(sent_at)"
  ).all()).results as any[];
  const repliedDaily = (await db.prepare(
    "SELECT date(received_at) AS d, COUNT(*) AS n FROM replies WHERE received_at IS NOT NULL AND date(received_at) >= date('now','-13 days') GROUP BY date(received_at)"
  ).all()).results as any[];
  const newDaily = (await db.prepare(
    "SELECT date(created_at) AS d, COUNT(*) AS n FROM leads WHERE created_at IS NOT NULL AND date(created_at) >= date('now','-13 days') GROUP BY date(created_at)"
  ).all()).results as any[];
  const sentMap: Record<string, number> = {}; for (const r of sentDaily) sentMap[r.d] = r.n;
  const repMap: Record<string, number> = {}; for (const r of repliedDaily) repMap[r.d] = r.n;
  const newMap: Record<string, number> = {}; for (const r of newDaily) newMap[r.d] = r.n;
  const daily: { date: string; neu: number; sent: number; replied: number }[] = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    daily.push({ date: d, neu: newMap[d] || 0, sent: sentMap[d] || 0, replied: repMap[d] || 0 });
  }

  // 4b) 周粒度（C5-7 块1 与北极星）——**另加字段，不动 daily**：
  //     daily 的 -13 days 窗口可能还有别的消费方，改它是替别人做决定。
  //     总工已批：daily 保留；重建后若真无人再读，留着无害，也别顺手删。
  //
  // ⚠️ **口径（写清楚，免得将来有人拿它当精确归因）**：
  //    rate = 当周回信数 / 当周发信数，是个**近似** —— 回信天然滞后于发信，
  //    跨周会错配（周一发的信周四回，周三发的信下周回）。
  //    在当前量级这个近似完全够用，⛔ **不为它做归因工程**（那要按 email 逐封串起来，
  //    成本远大于它能带来的判断力）。要的是"这周比上周好还是坏"，不是精确归因。
  const WEEKS_BACK = 12;
  const weekKey = "strftime('%Y-%W', {col})";
  const sentWeekly = (await db.prepare(
    `SELECT ${weekKey.replace("{col}", "sent_at")} AS w, COUNT(*) AS n FROM emails
      WHERE status='sent' AND sent_at IS NOT NULL AND date(sent_at) >= date('now','-${WEEKS_BACK * 7} days')
      GROUP BY w`
  ).all()).results as any[];
  const repWeekly = (await db.prepare(
    `SELECT ${weekKey.replace("{col}", "received_at")} AS w, COUNT(*) AS n FROM replies
      WHERE received_at IS NOT NULL AND date(received_at) >= date('now','-${WEEKS_BACK * 7} days')
      GROUP BY w`
  ).all()).results as any[];
  const sw: Record<string, number> = {}; for (const r of sentWeekly) sw[r.w] = r.n;
  const rw: Record<string, number> = {}; for (const r of repWeekly) rw[r.w] = r.n;
  // 周键必须**由日期推出**而不是从查询结果里取 —— 否则没有数据的那几周会整周消失，
  // 折线就会把"那周没发信"画成"那周不存在"（两件事，图上必须分得开）。
  const weekly: { week: string; sent: number; replied: number }[] = [];
  for (let i = WEEKS_BACK - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 7 * 86400000);
    // 与 SQLite 的 %W 对齐：周一为一周之始，年内第几周（补零两位）
    const y = d.getUTCFullYear();
    const jan1 = Date.UTC(y, 0, 1);
    const days = Math.floor((Date.UTC(y, d.getUTCMonth(), d.getUTCDate()) - jan1) / 86400000);
    const wk = String(Math.floor((days + ((new Date(jan1).getUTCDay() + 6) % 7)) / 7)).padStart(2, "0");
    const key = `${y}-${wk}`;
    weekly.push({ week: key, sent: sw[key] || 0, replied: rw[key] || 0 });
  }

  // 5) 评分分桶 + 缺邮箱 + 已分析数
  // ⭐ 两档制：原 5 档直方图（b0/b40/b60/b70/b80）删除 —— 前端只读了 b80 一个（其余 4 个是死查询），
  //    而「高分线索(≥80)」这个 KPI 在自动通道下没有意义：它只会随着找到的线索变多而变大，
  //    既不是健康度也不对应任何动作（机器已经把信发出去了）。
  //    换成**翻牌堆待复核**：机器扔掉、Joe 还没看过的家数 —— 这是唯一映射到"还剩多少你的活"的数。
  const buckets = await db.prepare(
    `SELECT
       SUM(CASE WHEN a.match_score >= ${APPROVE_MIN_SCORE} THEN 1 ELSE 0 END) AS bAuto,
       SUM(CASE WHEN a.match_score IS NOT NULL AND a.match_score < ${APPROVE_MIN_SCORE}
                 AND l.status IN ('analyzed','pending') THEN 1 ELSE 0 END) AS bFlipPending
     FROM lead_analysis a JOIN leads l ON l.id = a.lead_id`
  ).first<any>();
  const noEmailRow = await db.prepare("SELECT COUNT(*) AS n FROM leads WHERE email IS NULL OR email=''").first<{ n: number }>();
  const analyzedRow = await db.prepare("SELECT COUNT(*) AS n FROM lead_analysis WHERE match_score IS NOT NULL").first<{ n: number }>();
  const viewedRow = await db.prepare("SELECT COUNT(*) AS n FROM leads l WHERE l.status='sent' AND EXISTS (SELECT 1 FROM emails e WHERE e.lead_id=l.id AND e.clicked_at IS NOT NULL)").first<{ n: number }>();
  const weekRow = await db.prepare("SELECT COUNT(*) AS n FROM leads WHERE created_at >= date('now','-6 days')").first<{ n: number }>();

  // #43 转化漏斗（累计口径：每级=到达该阶段「及以后」的线索数，单调递减，转化%≤100）
  //  - 状态是互斥快照，故按「已达到的最远阶段」累计：won⊂replied阶段之后、replied、已查看(sent+点击)、已发送(唯一线索)、已批准、待分析
  //  - 基数=已入池=总线索排除黑名单/退订/退信（出局线索）
  const outLeads = F("blacklisted") + F("unsubscribed") + F("bounced");
  const wonC = F("won");
  const replyC = F("replied") + wonC;
  const viewC = Math.min(F("sent"), viewedRow?.n || 0) + F("replied") + wonC;
  const sentC = sentLeads;                                    // 唯一已发送线索（去重，含已回复/成交）
  const approveC = F("approved") + F("queued") + sentC;       // 已批准及以后 = 当前待发送 + 已发送及以后
  const poolC = Math.max(total - outLeads, approveC);         // 已入池（顶端基数）；clamp 兜底单调
  const rawLevels = [
    { key: "pool", label: "已入池", n: poolC },
    { key: "approve", label: "已批准", n: approveC },
    { key: "sent", label: "已发送", n: sentC },
    { key: "view", label: "已查看", n: viewC },
    { key: "reply", label: "已回复", n: replyC },
    { key: "won", label: "成交", n: wonC },
  ];
  const funnelLevels = rawLevels.map((lv, i) => {
    const prev = i > 0 ? rawLevels[i - 1].n : 0;
    const conv = i > 0 && prev > 0 ? Math.min(100, Math.round((lv.n / prev) * 100)) : null;
    return { ...lv, conv };
  });

  const sug = await buildActionSuggestions(c.env);   // #47 行动建议（与今日待办共用引擎）

  // 6) 账本（C5-7 块3）——**复用现成取数，不新开查询也不新开端点**：
  //    · AI 花费走 getAiUsage（自带 10 分钟缓存，且拿不到时绝不返回 0 冒充"没花钱"）
  //    · Serper 走 getSerperUsage（就是机器房那个唯一展示位读的同一个计数器）
  //    前端拿它算「每封回信成本」；⚠️ 回信数为 0 时**不做除法**（0 做分母要说人话）。
  const [aiCost, serperUse] = await Promise.all([
    getAiUsage(c.env, (k, d) => getSetting(c.env, k, d), (k, v) => setSetting(c.env, k, v)),
    getSerperUsage(c.env),
  ]);

  return c.json({
    total,
    funnel,
    funnelLevels,   // #43 累计口径漏斗（前端直接渲染）
    weekly,         // C5-7：12 周 {week,sent,replied}（口径注释见上方定义处）
    byKeyword,      // C5-7：关键词维度（此前完全没有）
    cost: { ai: aiCost, serper: serperUse },   // C5-7 账本
    actions: sug.actions,                                              // #47 行动建议（已按紧急度排序，最多 4 条）
    highNoEmail: sug.highNoEmail,                                      // #47 指标（备用）
    readyCount: sug.readyCount, reviewCount: sug.reviewCount,
    emailsSent,
    sentLeads,
    counts: { replied, bounced, unsubscribed },
    rates: { reply: rate(replied), bounce: rate(bounced), unsub: rate(unsubscribed) },
    byCountry,
    byCategory,
    byInbox,        // 批④：按收件箱类型切片（受 n<50 样本量锁）
    daily,
    scoreBuckets: {
      bAuto: buckets?.bAuto || 0,                 // ≥60：机器的自动通道
      bFlipPending: buckets?.bFlipPending || 0,   // <60 且还没被人工处理 = 翻牌堆待复核
      min: APPROVE_MIN_SCORE,
    },
    noEmailCount: noEmailRow?.n || 0,
    analyzedCount: analyzedRow?.n || 0,
    viewed: viewedRow?.n || 0,     // #40 数据看板：已查看（sent+点击）
    thisWeek: weekRow?.n || 0,     // 本周新增
  });
});

// ---- 线索列表（多维筛选：状态组 / 国家 / 客户类型 / 有无邮箱 / 最低分 / 关键词）----
app.get("/api/leads", async (c) => {
  const group = c.req.query("group") || "all";
  const q = (c.req.query("q") || "").trim();
  const country = (c.req.query("country") || "").trim().toUpperCase();
  const category = (c.req.query("category") || "").trim();
  const hasEmail = (c.req.query("hasEmail") || "").trim();   // "yes" | "no" | ""
  const minScore = Number(c.req.query("minScore") || "");    // 兼容旧参数（≥minScore）
  const scoreMinQ = c.req.query("scoreMin");                 // 区间下界（含），缺省=不过滤
  const scoreMaxQ = c.req.query("scoreMax");                 // 区间上界（不含），缺省=不过滤
  const scoreMin = scoreMinQ != null && scoreMinQ !== "" ? Number(scoreMinQ) : NaN;
  const scoreMax = scoreMaxQ != null && scoreMaxQ !== "" ? Number(scoreMaxQ) : NaN;
  const due = c.req.query("due") === "1";                    // 快赢③：只看"该跟进了"(下一步日期已到/过期)
  const stage = (c.req.query("stage") || "").trim();         // B：按销售漏斗阶段筛（派生，见下映射）
  const hasChannel = (c.req.query("hasChannel") || "").trim().toLowerCase(); // B：按渠道存在筛
  const statuses = STATUS_GROUPS[group] ?? [];

  let sql = `SELECT ${LEAD_ROW_COLS} FROM leads l LEFT JOIN lead_analysis a ON a.lead_id = l.id`;
  const where: string[] = [];
  const binds: any[] = [];

  const CLICKED = "EXISTS (SELECT 1 FROM emails e WHERE e.lead_id = l.id AND e.clicked_at IS NOT NULL)";
  // ⭐ 批⑨③：「已查看」格已删 → **这里的互斥必须一起拔掉**。
  //   原来：viewed = sent 且点过；sent = sent 且**没**点过（两格互斥，靠 `NOT CLICKED` 实现）。
  //   格子删了而这句不改的话，「已联系」会**看不到所有点过链接的那批** —— 而那批恰恰最该看（🔥 强意向）。
  //   ⚠️ 实测就是这么翻车的：我先改了前端和排序，以为够了；造的 ClickedLow-65（点过链接）
  //      **直接不出现在列表里** —— 因为过滤在 SQL 这一层。删格子必须连根拔，不能只拔看得见的那半。
  //   现在「已联系」= sent **全体**，点过的靠 ORDER BY 置顶（见下面 group === "sent" 的排序分支）。
  //   `viewed` 这个 group 保留只为兼容可能残留的老链接/书签，左栏已不再有它。
  if (group === "viewed") {          // 兼容旧入口：仍返回"已发送且点过"
    where.push(`l.status='sent' AND ${CLICKED}`);
  } else if (group === "sent") {     // 「已联系」= 已发出的全体（不再排除点过的）
    where.push(`l.status='sent'`);
  } else if (group === "unscored") {
    // ⭐⭐ 批⑭②：「待分析」= 还没打分的全体 = status='new'（cron 会打分）+ analyzed/pending 无分（等人）。
    //   批⑬② 我把 analyzed-无分 塞进了 off-funnel 的 `noscore` 桶 —— Joe 定"不许有隐藏桶"，撤回，回这里。
    where.push(UNSCORED_SHOW_WHERE);
  } else if (group === "noscore") {
    // ⚠️ 批⑭②：`noscore` 这个 group 名**保留**，但它不再是 off-funnel 桶 ——
    //   它现在只是「待分析」里"analyzed-无分"那个**子筛选**（Joe 从待分析格里点"只看抓不到官网的"时用）。
    //   保留它的理由：批⑬② 的改网址/重分析工具栏是挂在这个 group 上的，那些能力**对**、要留
    //   （"别把能力跟着入口一起删掉"）。撤掉的是"它是个独立警报桶"这件事，不是它的能力。
    where.push(NO_SCORE_WHERE);
  } else if (group === "review") {
    // ⭐⭐ 批⑬①：「待审批」= **AI 判完了、等你拍板** → 必须有分数（Joe 实测撞出来的"格子在说谎"）。
    // ⚠️ 我第一次改错了地方：改的是 `STAGE_SQL`（`?stage=` 另一条路），而 `group=review` 走这里。
    //    typecheck 绿、stats 数也对，唯独列表还返回没分数的 —— 造数据真撞才露的馅。
    where.push(REVIEW_WHERE);
  } else if (statuses.length) {
    where.push(`l.status IN (${statuses.map(() => "?").join(",")})`);
    binds.push(...statuses);
  }
  if (q) {
    where.push("(l.company_name LIKE ? OR l.website LIKE ? OR l.email LIKE ? OR l.country LIKE ?)");
    const like = `%${q}%`;
    binds.push(like, like, like, like);
  }
  if (country) { where.push("UPPER(l.country) = ?"); binds.push(country); }
  if (category) { where.push("a.customer_category = ?"); binds.push(category); }
  if (hasEmail === "yes") where.push("(l.email IS NOT NULL AND l.email != '')");
  if (hasEmail === "no") where.push("(l.email IS NULL OR l.email = '')");
  if (Number.isFinite(minScore) && minScore > 0) { where.push("a.match_score >= ?"); binds.push(minScore); }
  // 评分区间筛选（分桶）：scoreMin 含、scoreMax 不含；NULL 分数自然被排除
  if (Number.isFinite(scoreMin)) { where.push("a.match_score >= ?"); binds.push(scoreMin); }
  if (Number.isFinite(scoreMax)) { where.push("a.match_score < ?"); binds.push(scoreMax); }
  // 「未打分」是特殊态，不是区间：分数区间表达不了 IS NULL。
  // 这批人现在有真实来源了——抓站失败归档的「官网抓不到·无法判断」就是 match_score NULL，
  // 它们既不在自动通道也不在翻牌堆，必须能单独捞出来看。
  if ((c.req.query("scored") || "") === "no") where.push("a.match_score IS NULL");
  if (due) where.push("(l.next_action_date IS NOT NULL AND l.next_action_date != '' AND date(l.next_action_date) <= date('now') AND l.status NOT IN ('unsubscribed','blacklisted','bounced','won','ignored'))");
  // B：阶段筛选（与前端 stageOf 派生一致；映射到 SQL）
  const ENGAGED = "EXISTS (SELECT 1 FROM emails e WHERE e.lead_id=l.id AND (e.opened_at IS NOT NULL OR e.clicked_at IS NOT NULL))";
  const LAST_CAT = "(SELECT r.category FROM replies r WHERE r.lead_id=l.id ORDER BY r.id DESC LIMIT 1)";
  const STAGE_SQL: Record<string, string> = {
    // ⭐ 待分析(new) 与 待审核(analyzed/pending) 必须分开：这是阶段列筛选下拉的数据源，
    //   以前一个 'new' 键把三个状态揉在一起 → 用户按「待审核」筛会筛出一堆还没打分的，
    //   跟前端 stageOf 的徽章对不上。key 必须与前端 STAGE_OPTS 一致。
    unscored: UNSCORED_SHOW_WHERE,   // 批⑭②：待分析 = new + analyzed无分（展示口径，非 cron 口径）
    review: REVIEW_WHERE,          // 批⑬①：只放"AI 判完了的" —— 真口径见 REVIEW_WHERE 定义
    // ⭐ 批⑱：key 与左栏八格对齐（ready / replied / ignored / blacklisted 是这次补齐的，
    //    其中「已忽略」以前**下拉里根本筛不出来**）。approved / dead 保留为旧 URL 的兼容别名。
    ready: "l.status IN ('approved','queued')",
    approved: "l.status IN ('approved','queued')",   // 兼容旧链接
    // ⚠️⚠️ 批⑱：这里**放开了原来的 `AND NOT ENGAGED`**。
    //   原因：下拉主项的 label 已经统一成八格的「已联系」，那它筛出来的就**必须等于
    //   左栏「已联系」格的那批人（sent 全体）**；再挂个 NOT ENGAGED 就是"名改了 WHERE 没改"，
    //   等于把名实不符换个地方重生。参与度**一点没丢** —— 它降级成下面的子项 engaged。
    sent: "l.status='sent'",
    engaged: `l.status='sent' AND ${ENGAGED}`,        // 子项：已联系 · 🔥已参与
    replied: "l.status='replied'",
    talking: `l.status='replied' AND COALESCE(${LAST_CAT},'') != 'not_interested'`,   // 子项
    declined: `l.status='replied' AND ${LAST_CAT} = 'not_interested'`,                // 子项
    won: "l.status='won'",
    ignored: "l.status='ignored'",
    blacklisted: "l.status IN ('blacklisted','unsubscribed','bounced')",
    dead: "l.status IN ('blacklisted','unsubscribed','bounced')",   // 兼容旧链接
  };
  if (stage && STAGE_SQL[stage]) where.push(`(${STAGE_SQL[stage]})`);
  // B：渠道存在筛选（channels JSON 含该键；键来自白名单，用 json_extract 精确判断）
  const CH_KEYS = new Set(["linkedin", "whatsapp", "facebook", "instagram", "phone", "telegram", "youtube"]);
  if (CH_KEYS.has(hasChannel)) where.push(`json_extract(l.channels, '$.${hasChannel}') IS NOT NULL`);

  if (where.length) sql += " WHERE " + where.join(" AND ");
  // 排序：待跟进→下一步日期升序；最近参与→last_engaged_at 降序(NULL 垫底)；否则 id 倒序
  const sort = c.req.query("sort") || "";
  if (due) sql += " ORDER BY l.next_action_date ASC LIMIT 300";
  else if (sort === "engaged") sql += " ORDER BY (l.last_engaged_at IS NULL), l.last_engaged_at DESC, l.id DESC LIMIT 300";
  else if (sort === "score_asc") sql += " ORDER BY (a.match_score IS NULL), a.match_score ASC, l.id DESC LIMIT 300";
  // ⭐ 批⑨③：「已联系」格 —— 点过链接的（🔥 强意向）置顶。
  //   「已查看」格删掉了（总工："他点了链接但没回你，关系一步没动，不配单开房间"），
  //   但那批人**仍然是这一格里最该先看的** → 降级成排序，而不是让他们混在 300 条里沉底。
  //   ⚠️ **只对这一格生效**：别的格没有"点过链接"这个语义（待审批的连信都没发过），
  //      在那些格上按 CLICKED 排序纯属噪音。
  else if (group === "sent") sql += ` ORDER BY (${CLICKED}) DESC, (a.match_score IS NULL), a.match_score DESC, l.id DESC LIMIT 300`;
  // A1 默认按价值：有分的按分降序、无分垫底
  else sql += " ORDER BY (a.match_score IS NULL), a.match_score DESC, l.id DESC LIMIT 300";

  const rows = await c.env.DB.prepare(sql).bind(...binds).all();
  // C5-13：分类的**机器值仍是 customer_category（slug）**，筛选/统计都用它；
  //   额外给一个 `_label` 给屏幕用。标签只在服务端拼（taxonomy 住这儿），前端不抄第二份。
  return c.json({ leads: (rows.results as any[]).map(withCategoryLabel) });
});

// ---- 筛选维度可选值（国家 / 规范客户分类），供前端下拉动态生成 ----
// ---- 翻牌堆：<60 被机器扔掉的，按"被杀原因"分组给 Joe 复核 ----
// 为什么值得做这个视图：机器**误杀**一个真客户 = 损失一单、不可见、无兜底。
// Joe 扫组名就能整组略过（"这 30 家全是攻略站" → 跳过），只在可疑的组里下钻。
app.get("/api/leads/flip-pile", async (c) => {
  const rows = (await c.env.DB.prepare(
    `SELECT l.id, l.company_name, l.website, l.email, l.country, l.channels, l.human_approved,
            a.match_score, a.customer_type, a.reason
       FROM leads l JOIN lead_analysis a ON a.lead_id = l.id
      WHERE l.status IN ('analyzed','pending')
        AND a.match_score IS NOT NULL AND a.match_score < ${APPROVE_MIN_SCORE}
      ORDER BY a.match_score DESC, l.id ASC LIMIT 500`
  ).all()).results as any[];

  const groups: Record<string, any[]> = {};
  for (const r of rows) {
    // 分类看 buyer_type 前缀 + reason 正文（老数据没有前缀，见 taxonomy.classifyKillReason 的注释）
    const key = classifyKillReason(`${r.customer_type || ""} ${r.reason || ""}`);
    (groups[key] ||= []).push({
      id: r.id, company_name: r.company_name, website: r.website, email: r.email,
      country: r.country, channels: r.channels, human_approved: r.human_approved,
      match_score: r.match_score, customer_type: r.customer_type,
      // 证据摘要：Joe 要"一行看懂为什么被杀"，长的截断（详情页能看全文）
      evidence: String(r.reason || "").replace(/^【[^】]*】\s*/, "").slice(0, 120),
    });
  }
  // 组内已按分数降序（SQL 的 ORDER BY 带过来），组间按 KILL_REASONS 的固定顺序 —— 位置稳定，Joe 能形成肌肉记忆
  const out = KILL_REASONS.filter((g) => groups[g.key]?.length).map((g) => ({
    key: g.key, label: g.label, hint: g.hint, count: groups[g.key].length, leads: groups[g.key],
  }));
  return c.json({ total: rows.length, groups: out });
});

app.get("/api/leads/facets", async (c) => {
  const countries = await c.env.DB.prepare(
    "SELECT UPPER(country) AS v, COUNT(*) AS n FROM leads WHERE country IS NOT NULL AND country != '' GROUP BY UPPER(country) ORDER BY n DESC"
  ).all();
  const categoriesRaw = await c.env.DB.prepare(
    "SELECT a.customer_category AS v, COUNT(*) AS n FROM lead_analysis a WHERE a.customer_category IS NOT NULL AND a.customer_category != '' GROUP BY a.customer_category ORDER BY n DESC"
  ).all();
  // C5-13：下拉项**值仍是 slug**（要原样回传给 ?category= 做筛选），只是显示成中文。
  // ⚠️ 显示名和筛选值必须分开：混成一个，中文桶名一改，所有存下来的筛选就全失效。
  const categories = (categoriesRaw.results as any[]).map((r) => ({ ...r, label: customerTypeLabel(r.v) }));
  const noEmail = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM leads WHERE (email IS NULL OR email = '')"
  ).first<{ n: number }>();
  const withEmail = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM leads WHERE (email IS NOT NULL AND email != '')"
  ).first<{ n: number }>();
  const totalRow = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM leads").first<{ n: number }>();
  // 评分分桶计数（边界统一：0-40含0不含40 / 40-70含40不含70 / 70-100含70含100，不重叠不漏）
  // ⭐ 两档制：0-40 / 40-70 / 70-100 老三档已删 —— 40 和 70 这两条线不对应任何决策。
  //    现在只有 60 一条线：≥60 走自动通道、<60 进翻牌堆、未打分是特殊态（多为官网抓不到）。
  const sb = await c.env.DB.prepare(
    `SELECT
       SUM(CASE WHEN match_score >= ${APPROVE_MIN_SCORE} THEN 1 ELSE 0 END) AS bAuto,
       SUM(CASE WHEN match_score IS NOT NULL AND match_score < ${APPROVE_MIN_SCORE} THEN 1 ELSE 0 END) AS bFlip,
       SUM(CASE WHEN match_score IS NULL THEN 1 ELSE 0 END) AS bNone
     FROM lead_analysis`
  ).first<any>();
  return c.json({
    countries: countries.results,
    allCountries: COUNTRIES,            // 全部目标国家，供筛选下拉始终列全
    categories,
    noEmailCount: noEmail?.n || 0,
    withEmailCount: withEmail?.n || 0,
    total: totalRow?.n || 0,
    scoreBuckets: { bAuto: sb?.bAuto || 0, bFlip: sb?.bFlip || 0, bNone: sb?.bNone || 0, min: APPROVE_MIN_SCORE },
  });
});

// ---- A3 高分待发：数量 + 批量批准 Top N（≥门槛·已打分·有邮箱·未压制；不自动发信）----
// 未压制 = status∈(analyzed,pending)(已排除各终态) 且 邮箱不在持久压制名单。
// ⭐ 两档制：门槛对齐到 APPROVE_MIN_SCORE(60)，不再私设 70 —— 全系统只有 60 这一条决策线。
//    自动批准开着时这批本来就会被自动收走；这个按钮是自动批准关掉时的手动入口，口径必须一致。
// ⭐ 批⑨①：email 条件已删 —— 这个按钮是**自动批准关掉时的手动入口**，口径必须和自动通道一致。
//   不改它就会出现两套口径：自动批准收走 96 家无邮箱线索，而手动按钮看不见它们。
// ⚠️ 压制名单那条**保留且不能删**（M3 合规红线）：`lower(l.email) NOT IN (...)` 对无邮箱的行，
//   `lower(NULL) IN (...)` 结果是 NULL → NOT NULL 还是 NULL → **整行被 WHERE 判假、悄悄排除**。
//   所以要显式放行"没有邮箱"这种情况：没邮箱就无从压制，它不该因此被挡在批准之外。
const HIGH_SCORE_READY_WHERE =
  `a.match_score >= ${APPROVE_MIN_SCORE} AND l.status IN ('analyzed','pending') ` +
  "AND (l.email IS NULL OR l.email = '' OR lower(l.email) NOT IN (SELECT email FROM suppressed_emails))";
app.get("/api/high-score-ready", async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM leads l JOIN lead_analysis a ON a.lead_id = l.id WHERE ${HIGH_SCORE_READY_WHERE}`
  ).first<{ n: number }>();
  return c.json({ count: row?.n || 0 });
});
// ---- B1 批量改状态（复用 M3b 护栏；逐条 try/catch；越权跳过不整批失败）----
app.post("/api/leads/bulk-status", async (c) => {
  const b = await jsonBody<{ ids?: number[]; status?: string }>(c);
  const status = b.status;
  if (!status || !ALLOWED_STATUS.has(status)) return c.json({ error: "invalid status" }, 400);
  const ids = Array.isArray(b.ids) ? [...new Set(b.ids.map(Number).filter(Number.isFinite))].slice(0, 500) : [];
  if (!ids.length) return c.json({ error: "no ids" }, 400);
  const PROTECTED = new Set(["unsubscribed", "blacklisted", "bounced"]);
  const PROTECTED_ALLOWED = new Set(["unsubscribed", "blacklisted", "bounced", "ignored"]);
  let updated = 0;
  const skipped: { id: number; reason: string }[] = [];
  for (const id of ids) {
    try {
      const cur = await c.env.DB.prepare(
        "SELECT l.status, l.email, a.match_score FROM leads l LEFT JOIN lead_analysis a ON a.lead_id = l.id WHERE l.id = ?"
      ).bind(id).first<{ status: string; email: string; match_score: number | null }>();
      if (!cur) { skipped.push({ id, reason: "not found" }); continue; }
      // M3b 合规护栏：退订/黑名单/退信 只能在彼此或→ignored，不能复发
      if (PROTECTED.has(cur.status) && !PROTECTED_ALLOWED.has(status)) {
        skipped.push({ id, reason: `「${cur.status}」不可转「${status}」` }); continue;
      }
      // A1 待发送护栏（服务端强制）：置 approved 必须 有邮箱 且 已打分≥60——
      // 防"没打分/缺邮箱/低分"线索再漏进待发送（根因：199条没打分、269条缺邮箱、12条<60）
      const gate = approveGateReason(cur.email, cur.match_score);
      if (status === "approved" && gate) { skipped.push({ id, reason: gate }); continue; }
      await c.env.DB.prepare("UPDATE leads SET status = ?, updated_at = datetime('now') WHERE id = ?").bind(status, id).run();
      if (status === "unsubscribed" || status === "blacklisted" || status === "bounced") {
        await addSuppressedEmail(c.env, cur.email, `bulk:${status}`);
      }
      updated++;
    } catch (e: any) { skipped.push({ id, reason: e.message || String(e) }); }
  }
  return c.json({ updated, skipped });
});
app.post("/api/high-score-ready/approve", async (c) => {
  // 按分从高到低把符合条件的置 approved（上限 500 防误伤海量）；不自动发信——发送仍走「发送已批准」按每日上限。
  const res = await c.env.DB.prepare(
    "UPDATE leads SET status='approved', updated_at=datetime('now') WHERE id IN (" +
    `SELECT l.id FROM leads l JOIN lead_analysis a ON a.lead_id = l.id WHERE ${HIGH_SCORE_READY_WHERE} ORDER BY a.match_score DESC LIMIT 500)`
  ).run();
  return c.json({ approved: res.meta.changes || 0 });
});

// ---- 一次性回填：把已有 lead_analysis 的 customer_type 归一到 customer_category（幂等）----
app.post("/api/admin/recategorize", async (c) => {
  const rows = await c.env.DB.prepare("SELECT lead_id, customer_type FROM lead_analysis").all();
  let updated = 0;
  for (const r of rows.results as any[]) {
    const cat = normalizeCustomerType(r.customer_type);
    await c.env.DB.prepare("UPDATE lead_analysis SET customer_category=? WHERE lead_id=?").bind(cat, r.lead_id).run();
    updated++;
  }
  return c.json({ updated });
});

// ══ C5-13：按新分类体系**只刷分数与分类**的重刷 ══
//
// ⛔ **不能用现成的 /api/rescan/start**：它 `DELETE lead_analysis` + 把 status 打回 new
//    + 把 human_approved 清零 —— 那三样正是本单明令不许碰的。重扫是"旧标准全部作废"的场景，
//    这次不是：分数标准没变，变的只是分类枚举，人已经做过的判断必须原样留着。
//
// 本端点的写入面（逐条核对过，不是"应该不会"）：
//   ✅ 改：lead_analysis 的 customer_type / customer_category / match_score / needed_products / reason / model
//   ✅ 附带：抓站成功时 fetch_fail_count 清零（>0 才写）、country 为空时回填
//   ⛔ 不改：leads.status（analyzeLead 那句 UPDATE 带 `AND status='new'` 守卫）、
//            human_approved、recommended_email（upsert 用 COALESCE 保留已发出的信）、emails 表
//
// 进度用**冻结时间戳**推进（照搬 rescan 的做法，不新发明）：只取 analyzed_at < 起点的行，
// 刷完 analyzed_at=now 自然出集合 ⇒ 幂等、可断点续、并发重复调用也不会重复烧钱。
const RESCORE_SKIP_STATUSES = ["sent", "replied", "won", "blacklisted"];
app.post("/api/admin/rescore-taxonomy", async (c) => {
  // 🔴 安全闸（与 /api/rescan/start 同一条，不是新发明）：分数是 **批准→发信** 那条链的输入。
  //   生产实测 2026-09-01：auto_approve_enabled=1 且 auto_send_enabled=1，整点 cron 是
  //   `打分 → ≥60 自动批准 → sendApprovedBatch` 一条直路，日上限 100。
  //   ⇒ 在这个状态下重刷 = 把一批线索推过 60 分线 = **真的往陌生公司发冷邮件**。
  //   "只刷分数不发信"这个说法只在自动发送关着时才成立；开着时它就是错的。
  if (await autoSendEnabled(c.env)) {
    return c.json({
      error: "请先关闭「自动发送」再重刷分类 —— 重刷会改分数，而分数是「自动批准 → 自动发送」的入口，" +
             "开着重刷等于让机器边刷边把线索发出去（发出去的信收不回来）。刷完再开回来。",
    }, 409);
  }
  const b = await jsonBody<{ limit?: number; restart?: boolean }>(c);
  const limit = Math.min(Math.max(Number(b.limit) || 8, 1), 20);
  let startedAt = (await getSetting(c.env, "taxonomy_rescore_started_at", "")).trim();
  if (b.restart || !startedAt) {
    startedAt = new Date().toISOString().replace("T", " ").slice(0, 19);
    await setSetting(c.env, "taxonomy_rescore_started_at", startedAt);
  }
  // ⛔ 跳过已进入发信环节的线索：它们的 reason/分数是人当时据以决策的记录，事后改写等于**篡改依据**。
  const marks = RESCORE_SKIP_STATUSES.map(() => "?").join(",");
  const pickSql =
    `SELECT l.* FROM leads l JOIN lead_analysis a ON a.lead_id = l.id
      WHERE a.analyzed_at < ? AND l.status NOT IN (${marks})
      ORDER BY l.id LIMIT ?`;
  const rows = await c.env.DB.prepare(pickSql).bind(startedAt, ...RESCORE_SKIP_STATUSES, limit).all();
  const leads = rows.results as any[];

  let ok = 0; const errors: string[] = [];
  for (const lead of leads) {
    try {
      const r = await analyzeLead(c.env, lead, { scoreOnly: true });
      if (r.ok) ok++; else errors.push(`#${lead.id} ${r.error || "未成功"}`);
    } catch (e) { errors.push(`#${lead.id} ${String(e).slice(0, 120)}`); }
  }
  const left = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM leads l JOIN lead_analysis a ON a.lead_id = l.id
      WHERE a.analyzed_at < ? AND l.status NOT IN (${marks})`
  ).bind(startedAt, ...RESCORE_SKIP_STATUSES).first<{ n: number }>();
  return c.json({ startedAt, processed: leads.length, ok, remaining: left?.n || 0, errors: errors.slice(0, 5) });
});

/**
 * C5-26：找客户「搜索中」的**真实进度**（第 N/M 个关键词 · 已入库几家）。只读。
 *
 * ⚠️ 它**只用于显示，绝不用于判完成**。今天刚栽过这个：用"total 有增量"推断"搜索完成了"，
 *   三次里两次是错的 —— **增量只证明在跑，不证明跑完了**。完成的唯一信号是
 *   `POST /api/discover` 这个请求自己返回。
 * ⚠️ 没有进行中的轮次时返回 running:false，**不是返回一个看起来像 0% 的进度**
 *   —— 那两者在界面上必须长得不一样。
 */
app.get("/api/discover/progress", async (c) => {
  const raw = (await getSetting(c.env, "discover_progress", "")).trim();
  if (!raw) return c.json({ running: false });
  try {
    const p = JSON.parse(raw);
    return c.json({ running: true, ...p });
  } catch {
    // 解析不了要**说出来**，不要当成"没在跑"——那正是把故障伪装成正常状态。
    return c.json({ running: false, parseError: true, raw: raw.slice(0, 120) });
  }
});

/** C5-13 验收用：分类分布（重刷前后各拉一次，做对比表）。只读。 */
app.get("/api/admin/category-distribution", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT COALESCE(NULLIF(a.customer_category,''),'(空)') AS slug, COUNT(*) AS n
       FROM lead_analysis a GROUP BY 1 ORDER BY n DESC`
  ).all();
  const items = (rows.results as any[]).map((r) => ({ ...r, label: customerTypeLabel(r.slug) }));
  return c.json({ total: items.reduce((s, r) => s + r.n, 0), items });
});

// ---- 一次性回填：给缺 country 的遗留线索按官网 ccTLD 推断国家（幂等，只动 NULL/空）----
// ⚠️ 这是对遗留数据的最佳努力推断：ccTLD 命中则回填，.com/.net 等通用后缀无法判定 → 保持 NULL（不猜、不默认美国）。
//    新线索入库已带准确 country，不受影响。
app.post("/api/admin/backfill-country", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT id, website FROM leads WHERE (country IS NULL OR country='') AND website IS NOT NULL AND website != ''"
  ).all();
  const breakdown: Record<string, number> = {};
  let updated = 0;
  for (const r of rows.results as any[]) {
    const cc = inferCountryFromWebsite(r.website);
    if (!cc) continue;
    await c.env.DB.prepare("UPDATE leads SET country=?, updated_at=datetime('now') WHERE id=?").bind(cc, r.id).run();
    breakdown[cc] = (breakdown[cc] || 0) + 1;
    updated++;
  }
  return c.json({ updated, breakdown });
});

// ---- 一次性：国家字段规整（英文全名/大写码 → 小写 ISO-2 码），幂等 ----
const COUNTRY_NAME_TO_CODE: Record<string, string> = {
  "united states": "us", "philippines": "ph", "canada": "ca", "australia": "au",
  "south africa": "za", "new zealand": "nz", "turkey": "tr", "nigeria": "ng",
  "mexico": "mx", "malta": "mt", "greece": "gr", "british virgin islands": "vg",
};
app.post("/api/admin/normalize-countries", async (c) => {
  // M2 归一化回填（幂等）：① 优先按官网 ccTLD 推真实所在国（纠正 gl 标错，如 Dubai 站被标 FR）；
  //   ② 否则把现有值规整为 **大写 ISO-2 码**（英文全名→码、任意大小写码→大写），统一大小写、消除看板 Top10 同国重复。
  const rows = await c.env.DB.prepare("SELECT id, country, website FROM leads WHERE country IS NOT NULL AND country != ''").all();
  let updated = 0;
  const breakdown: Record<string, number> = {};
  for (const r of rows.results as any[]) {
    const raw = String(r.country).trim();
    let code = inferCountryFromWebsite(r.website || "");   // ccTLD 命中 → 大写两位码；否则 ""
    if (!code) {
      const lower = raw.toLowerCase();
      if (COUNTRY_NAME_TO_CODE[lower]) code = COUNTRY_NAME_TO_CODE[lower].toUpperCase();   // 英文全名 → 大写码
      else if (/^[a-z]{2}$/i.test(raw)) code = raw.toUpperCase();                          // 两位码(任意大小写) → 大写
    }
    if (code && code !== raw) {                                              // 仅在有变化时更新（幂等）
      await c.env.DB.prepare("UPDATE leads SET country=?, updated_at=datetime('now') WHERE id=?").bind(code, r.id).run();
      updated++;
      breakdown[code] = (breakdown[code] || 0) + 1;
    }
  }
  return c.json({ updated, breakdown });
});

// ---- 线索详情（含 AI 分析）----
app.get("/api/leads/:id", async (c) => {
  const id = Number(c.req.param("id"));
  // 🔴 C5-14 根治：这里原来**手抄了一份**列表的派生列（has_open/has_click/has_followup/latest_reply_cat）。
  //   抄一份就会漂，而它已经漂了：**`match_score` 抄漏了**（它在 lead_analysis 里，这条查询压根没 join）。
  //   后果不是"少一个字段"：`stageOf()` 里 `l.match_score == null` 遇上 `undefined` 判真
  //   ⇒ 每一条已打分的 analyzed 线索在详情页头部都被判成 unscored、恒挂「🆕 待分析 · 官网抓不到」，
  //     哪怕它 88 分正躺在待审批里。**列表对、详情错，两块屏幕上写着互相矛盾的话。**
  //   ⇒ 不补字段，改成和列表查同一份 LEAD_ROW_COLS：口径只有一处，下次也没得漂。
  const lead = await c.env.DB.prepare(
    `SELECT ${LEAD_ROW_COLS}, l.notes, l.updated_at, l.human_approved, l.bench_queued, l.bench_contacted_at, l.bench_channel
       FROM leads l LEFT JOIN lead_analysis a ON a.lead_id = l.id WHERE l.id = ?`
  ).bind(id).first();
  if (!lead) return c.json({ error: "not found" }, 404);
  const analysis = await c.env.DB.prepare("SELECT * FROM lead_analysis WHERE lead_id = ?").bind(id).first<any>();
  // C5-13：详情页的分类徽章走同一个标签函数（列表也是它）——两个面一个口径。
  return c.json({ lead, analysis: analysis ? withCategoryLabel(analysis) : analysis });
});

// ---- 改状态（批准 / 忽略 / 黑名单 等）----
// ⭐ 批㉔：状态变更的护栏核心抽成共享函数 —— HTTP 路由和飞书卡片回调走**同一条护栏路径**
//   （M3 合规终态 + A1 approved 闸 + 压制名单联动，一条不绕、一份不抄）。行为与原端点逐字等价。
export async function setLeadStatusGuarded(env: Env, id: number, status: string): Promise<{ ok?: true; id?: number; status?: string; error?: string; code: number }> {
  if (!status || !ALLOWED_STATUS.has(status)) return { error: "invalid status", code: 400 };
  // M3 合规保护：退订/黑名单/退信是合规终态，只能在彼此间或转到 ignored，
  // 禁止转到任何其它状态（含 pending/analyzed 等中间态）—— 堵"两跳洗白"绕过。
  const PROTECTED = new Set(["unsubscribed", "blacklisted", "bounced"]);
  const PROTECTED_ALLOWED_TARGETS = new Set(["unsubscribed", "blacklisted", "bounced", "ignored"]);
  const cur = await env.DB.prepare(
    "SELECT l.status, l.email, l.human_approved, a.match_score FROM leads l LEFT JOIN lead_analysis a ON a.lead_id = l.id WHERE l.id = ?"
  ).bind(id).first<{ status: string; email: string; human_approved: number; match_score: number | null }>();
  if (!cur) return { error: "not found", code: 404 };
  if (PROTECTED.has(cur.status) && !PROTECTED_ALLOWED_TARGETS.has(status)) {
    return { error: `「${cur.status}」是合规终态，只能转到 黑名单/退订/退信/已忽略，不能转到「${status}」（防复发绕过）`, code: 409 };
  }
  // A1 待发送护栏（服务端强制，与 bulk-status 同一真源）：置 approved 必须 有邮箱 且 已打分≥60。
  // 单条路径认 human_approved（Joe 亲手按过「手动发这家」）→ 只豁免分数线。
  // 批⑨①：邮箱不再是批准条件（闸分两条）；能不能发邮件由 send.ts 的 email 过滤守。
  {
    const gate = approveGateReason(cur.email, cur.match_score, cur.human_approved === 1);
    if (status === "approved" && gate) return { error: gate, code: 409 };
  }
  const res = await env.DB.prepare(
    "UPDATE leads SET status = ?, updated_at = datetime('now') WHERE id = ?"
  ).bind(status, id).run();
  if (!res.meta.changes) return { error: "not found", code: 404 };
  // 手动改成压制态：把该 lead 邮箱写入持久压制名单（终极闸，重导入/两跳也拦得住）
  if (status === "unsubscribed" || status === "blacklisted" || status === "bounced") {
    await addSuppressedEmail(env, cur.email, `manual:${status}`);
  }
  return { ok: true, id, status, code: 200 };
}
app.post("/api/leads/:id/status", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await jsonBody<{ status?: string }>(c);
  const r = await setLeadStatusGuarded(c.env, id, body.status || "");
  const { code, ...rest } = r;
  return c.json(rest as any, code as any);
});

// ---- 翻牌堆 human override：「手动发这家」（Joe 亲手对单条 <60 线索按下）----
// ⭐ 这是**唯一能让 <60 的信发出去的口子**。设计约束（对应的实测在 commit message 里）：
//   · 只接受**单条 id**（路径参数）—— 没有 ids[] 数组、没有批量版本、没有任何自动路径调它
//   · 只豁免**分数线**：M3 终态照样拦。（批⑨①：邮箱已不再是批准条件；发邮件的闸在 send.ts）
//   · 幂等/压制名单/每日上限/原子取批 一个都不豁免（那些在 sendApprovedBatch / deliverEmail 里，
//     这个端点根本碰不到它们）
//   · 不发信，只置 approved —— 发送仍走 sendApprovedBatch 那条唯一的发送路径
// 存在的理由：机器误杀一个真客户 = 损失一单、不可见、无兜底。Joe 在翻牌堆里认出来的，得有路发出去。
app.post("/api/leads/:id/human-approve", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "invalid id" }, 400);
  const cur = await c.env.DB.prepare(
    "SELECT l.status, l.email, a.match_score FROM leads l LEFT JOIN lead_analysis a ON a.lead_id = l.id WHERE l.id = ?"
  ).bind(id).first<{ status: string; email: string; match_score: number | null }>();
  if (!cur) return c.json({ error: "not found" }, 404);
  // M3 合规终态照拦：human override 只越过分数线，不越过合规
  const PROTECTED = new Set(["unsubscribed", "blacklisted", "bounced"]);
  if (PROTECTED.has(cur.status)) {
    return c.json({ error: `「${cur.status}」是合规终态，不能手动发（这条线是合规红线，不是分数线）` }, 409);
  }
  // 走同一条护栏，humanApproved=true 让它跳过**分数线**和**"必须有分数"**两项（批⑭①：人工豁免）。
  //   批⑨①：缺邮箱不再拦 —— Joe 亲手按「手动碰这家」时，他要碰的可能就是社媒。
  //   批⑭①：未打分也不再拦 —— 抓不到官网的线索，Joe 凭公司名+国家人工判就能批准去联系。
  //   M3 合规终态在上面已单独拦（人工豁免碰不到它）。
  const gate = approveGateReason(cur.email, cur.match_score, true);
  if (gate) return c.json({ error: gate }, 409);
  await c.env.DB.prepare(
    "UPDATE leads SET human_approved=1, status='approved', updated_at=datetime('now') WHERE id=?"
  ).bind(id).run();
  return c.json({ ok: true, id, score: cur.match_score, note: "已加入待发送（人工放行）。发送仍受每日上限/压制名单/幂等约束。" });
});

// ---- 翻牌堆 →「转工作台」：<60 但有社媒渠道的，进 D 的手动触达队列 ----
// 工作台里没有任何自动发送，全是 Joe 的手 → 这个标记不像 human_approved 那样敏感，
// 但同样只接受单条 id、只由这个端点写。
app.post("/api/leads/:id/to-bench", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "invalid id" }, 400);
  const cur = await c.env.DB.prepare("SELECT status, channels FROM leads WHERE id=?").bind(id)
    .first<{ status: string; channels: string | null }>();
  if (!cur) return c.json({ error: "not found" }, 404);
  if (["unsubscribed", "blacklisted", "bounced"].includes(cur.status)) {
    return c.json({ error: `「${cur.status}」是合规终态，不能再联系（换渠道也不行）` }, 409);
  }
  let n = 0; try { n = Object.keys(JSON.parse(cur.channels || "{}")).length; } catch { /* 坏 JSON 当没渠道 */ }
  if (!n) return c.json({ error: "这家没有任何社媒/电话渠道，碰不到（工作台也没辙）" }, 409);
  await c.env.DB.prepare("UPDATE leads SET bench_queued=1, updated_at=datetime('now') WHERE id=?").bind(id).run();
  return c.json({ ok: true, id });
});

// ---- 批⑦A：详情页「现在生成」开发信 ----
// 草稿默认在**发送那一刻**才生成（写信占了账单 93%，不能给永远发不出去的线索白写）。
// 但 Joe 有"想先看看信写成什么样、想先改一版"的场景 → 给他一个手动触发。
// 复用 ensureDraft：已有草稿直接返回不重复烧钱；生成逻辑与发送路径**是同一份**，不会漂。
app.post("/api/leads/:id/draft", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "invalid id" }, 400);
  const lead = await c.env.DB.prepare("SELECT id, company_name, website FROM leads WHERE id=?").bind(id).first<any>();
  if (!lead) return c.json({ error: "not found" }, 404);
  const d = await ensureDraft(c.env, lead);
  if (!d.ok) return c.json({ error: d.error }, 409);
  return c.json({ ok: true, draft: d.draft, generated: !!d.generated });
});

// ---- 批⑥C「他回了」：任何渠道客户回话了 → 置 replied + 写时间线 ----
//
// ⭐ 命名与归属遵循 Joe 定的原则："**邮箱和社媒都只是手段**……哪些邮箱发过邮件，就做一个标识，
//    而不是把邮箱和社媒当成两套独立的系统。"
//    所以这是 `/api/leads/:id/channel-reply`（线索身上的一个动作），**不是** `/api/bench/*`
//    —— 工作台不是独立系统，渠道只是标识。
//
// 为什么需要它：邮件回复能靠 IMAP 自动收；**WhatsApp/LinkedIn/电话的回复机器看不见**。
// Joe 在手机上收到回复，得有个地方一键告诉系统 —— 否则这条线索会一直躺在"等回复"里，
// 跟进逻辑还会继续追一个已经在聊的人。
const CHANNEL_LABELS: Record<string, string> = {
  whatsapp: "WhatsApp", linkedin: "LinkedIn", facebook: "Facebook",
  instagram: "Instagram", telegram: "Telegram", phone: "电话", email: "邮件", other: "其它渠道",
};
app.post("/api/leads/:id/channel-reply", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "invalid id" }, 400);
  const b = await jsonBody<{ channel?: string; note?: string }>(c);
  const key = String(b.channel || "other").trim().toLowerCase();
  const label = CHANNEL_LABELS[key] || CHANNEL_LABELS.other;
  const note = String(b.note || "").trim().slice(0, 500);

  const cur = await c.env.DB.prepare("SELECT status FROM leads WHERE id=?").bind(id).first<{ status: string }>();
  if (!cur) return c.json({ error: "not found" }, 404);
  // M3 合规终态照拦：退订/黑名单/退信的人"回话了"也不能把他拉回联系流程 —— 那是合规红线
  if (["unsubscribed", "blacklisted", "bounced"].includes(cur.status)) {
    return c.json({ error: `「${cur.status}」是合规终态，不能改成已回复` }, 409);
  }

  await c.env.DB.prepare("UPDATE leads SET status='replied', updated_at=datetime('now') WHERE id=?").bind(id).run();
  // 落一条 replies 记录 → 时间线自动显示（timeline 端点就是从 replies 读的），
  // 且收件箱/已回复页的口径能认出它 —— **渠道回复跟邮件回复一样是"有人回你了"**。
  // ⚠️ 列名是 content 不是 body（schema.sql 里 replies 的真实定义，上批踩过）。
  await c.env.DB.prepare(
    `INSERT INTO replies (lead_id, from_email, subject, content, category, summary, received_at)
     VALUES (?, ?, ?, ?, 'interested', ?, datetime('now'))`
  ).bind(id, `(${label})`, `${label}回复`, note || `（在 ${label} 上回复了，由人工标记）`,
         note ? `${label}：${note.slice(0, 60)}` : `${label}上回复了`).run();
  // ⚠️ **不写 bench_channel / bench_contacted_at**（第一版我写了，实测证明是错的）：
  //   · 语义反了：那两个字段的意思是"**我们**在哪个渠道碰过他、什么时候"（我们发出去的），
  //     而「他回了」是他碰我们（进来的）。写进去会自相矛盾 —— 实测撞到过：
  //     时间线说"LinkedIn上回复了"、字段却是 whatsapp（我用 COALESCE 保了首值，换渠道再回就对不上）。
  //   · 也没必要：回复渠道已经准确记在这条 replies 里（时间线读的就是它）；
  //     而"别给正在聊的人发冷邮件"这件事 **status='replied' 本身就挡死了** ——
  //     自动批准只取 analyzed、发送只取 approved、重扫不碰 replied。
  //   真正的"每个渠道碰过/没碰过"标识由 D 统一设计（Joe：渠道是线索身上的标识，不是分组）。
  return c.json({ ok: true, id, channel: key, label });
});

// ---- 快赢③：设置线索"下一步动作 + 日期"（轻CRM）----
app.post("/api/leads/:id/next-action", async (c) => {
  const id = Number(c.req.param("id"));
  const b = await jsonBody<{ next_action?: string; next_action_date?: string }>(c);
  const action = (b.next_action ?? "").trim().slice(0, 500);
  let date = (b.next_action_date ?? "").trim();
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ error: "日期格式须为 YYYY-MM-DD" }, 400);
  const res = await c.env.DB.prepare(
    "UPDATE leads SET next_action=?, next_action_date=?, updated_at=datetime('now') WHERE id=?"
  ).bind(action || null, date || null, id).run();
  if (!res.meta.changes) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true, id, next_action: action || null, next_action_date: date || null });
});

// ---- 快赢③：线索时间线（从 leads/lead_analysis/emails/replies 聚合关键事件，按时间排序）----
app.get("/api/leads/:id/timeline", async (c) => {
  const id = Number(c.req.param("id"));
  const lead = await c.env.DB.prepare("SELECT created_at, source, keyword FROM leads WHERE id=?").bind(id).first<any>();
  if (!lead) return c.json({ error: "not found" }, 404);
  const events: { time: string; type: string; label: string }[] = [];
  events.push({ time: lead.created_at, type: "discovered", label: `线索录入${lead.source ? `（来源 ${lead.source}${lead.keyword ? ` · ${lead.keyword}` : ""}）` : ""}` });

  const a = await c.env.DB.prepare("SELECT analyzed_at, match_score FROM lead_analysis WHERE lead_id=?").bind(id).first<any>();
  if (a?.analyzed_at) events.push({ time: a.analyzed_at, type: "analyzed", label: `AI 分析打分 ${a.match_score ?? "—"}` });

  const emails = await c.env.DB.prepare(
    "SELECT kind, status, subject, sent_at, created_at FROM emails WHERE lead_id=? ORDER BY id ASC"
  ).bind(id).all();
  for (const e of emails.results as any[]) {
    const t = e.sent_at || e.created_at;
    const kindLabel = e.kind === "followup" ? "跟进信" : "开发信";
    const stLabel = e.status === "sent" ? "已发送" : e.status === "bounced" ? "退信" : e.status === "failed" ? "发送失败" : "待发";
    events.push({ time: t, type: `email_${e.status}`, label: `${kindLabel}${stLabel}${e.subject ? `：${e.subject}` : ""}` });
  }

  const replies = await c.env.DB.prepare(
    "SELECT category, summary, received_at FROM replies WHERE lead_id=? ORDER BY id ASC"
  ).bind(id).all();
  for (const r of replies.results as any[]) {
    events.push({ time: r.received_at, type: "reply", label: `收到回复（${r.category || "?"}）${r.summary ? `：${r.summary}` : ""}` });
  }

  // 按时间升序；无时间的排最后
  events.sort((x, y) => String(x.time || "").localeCompare(String(y.time || "")));
  return c.json({ events });
});

// ---- 冲刺1a：今日待办作战台（聚合 该跟进 / 未处理热回复 / 今日参与）----
app.get("/api/today", async (c) => {
  const db = c.env.DB;
  // ① 今天该跟进（next_action_date 已到，排除已成交/忽略/压制态）
  const dueFollowups = (await db.prepare(
    "SELECT l.id, l.company_name, l.website, l.next_action, l.next_action_date FROM leads l " +
    "WHERE l.next_action_date IS NOT NULL AND l.next_action_date != '' AND date(l.next_action_date) <= date('now') " +
    "AND l.status NOT IN ('won','ignored','blacklisted','unsubscribed','bounced') ORDER BY l.next_action_date ASC LIMIT 50"
  ).all()).results;
  // ② 未处理热回复（interested/inquiry，且线索未成交/忽略/黑名单）
  const hotReplies = (await db.prepare(
    "SELECT r.id, r.lead_id, r.from_email, r.category, r.summary, r.received_at, l.company_name FROM replies r " +
    "LEFT JOIN leads l ON l.id = r.lead_id WHERE " + UNHANDLED_HOT_REPLY_WHERE + " ORDER BY r.id DESC LIMIT 50"
  ).all()).results;
  // ③ 今天有参与（打开/点击）的线索
  const engagedToday = (await db.prepare(
    "SELECT l.id, l.company_name, l.website, l.last_engaged_at, " +
    "EXISTS (SELECT 1 FROM emails e WHERE e.lead_id = l.id AND e.clicked_at IS NOT NULL) AS has_click " +
    "FROM leads l WHERE l.last_engaged_at IS NOT NULL AND date(l.last_engaged_at) = date('now') ORDER BY l.last_engaged_at DESC LIMIT 50"
  ).all()).results;
  // ④「新高分线索」查询已删（两档制）：批④-1 早就把前端那个列表删了、没人读它 = 死查询；
  //    而且自动通道时代"新出现一家 85 分"没有动作含义 —— 发生的事就是机器已经把信发出去了。
  const sug = await buildActionSuggestions(c.env);   // #47 今日待办顶部「现在就能推进」复用同一引擎
  // 批④ 待办事项=分诊台：这里只给"每类还剩几件"的真实计数，页面按紧急度排、0 的不显示、只跳转不做动作。
  // ⭐「X 家能发」必须是真能发的口径 = approved 且 有邮箱 且 ≥60分（与 sendApprovedBatch 的取批条件一致）。
  //    旧版直接拿 approved 总数当"待发送"→ 显示 322 而真值 41，是用户最恼火的那个谎。
  const sendable = (await db.prepare(
    `SELECT COUNT(*) AS n FROM leads l JOIN lead_analysis a ON a.lead_id = l.id
      WHERE l.status='approved' AND a.match_score >= ${APPROVE_MIN_SCORE}
        AND l.email IS NOT NULL AND l.email != ''
        AND lower(l.email) NOT IN (SELECT email FROM suppressed_emails)`
  ).first<{ n: number }>())?.n || 0;
  const serper = await getSerperUsage(c.env);
  // ⭐ 批⑪B：系统警报补两条 —— **它们今天都真发生过，而待办里根本没有它们**。
  //   总工说第②类是"熔断了 / IMAP 断了 / Serper 到顶"，而代码里只有第三个。
  //   · 熔断：05:01 真跳闸了（8 封退订 = 16.7%）→ 自动发送停了。**不看设置页就不知道。**
  //   · 收回复失败：此刻正在发生（Michael 那封卡着）→ **客户回信收不到，这是最贵的故障**。
  //   两个都是"机器停摆"：不理它，它不会自己好，而且一直在损失。这正是待办该说的那种事。
  //   数据源都在 settings 里，**没新建表**。
  const alerts = {
    breakerTrippedAt: await getSetting(c.env, "auto_send_tripped_at", ""),
    breakerReason: await getSetting(c.env, "auto_send_trip_reason", ""),
    replyFailLast: await getSetting(c.env, "reply_fail_last", ""),
    // IMAP 小修②：横幅判据=连败轮数（≥2 才亮），replyFailLast 降级为横幅的证据文本。
    // ⭐ C2-C：**未点火时恒报 0** —— 未点火不是故障，横幅不该亮。
    //   这里不只是"前端别显示"：数字本身就不该带着未点火期间的旧账出门
    //   （否则 Joe 配上钥匙的第一天，会看到一条"已连续 465 轮失败"的欢迎横幅）。
    replyFailStreak: isIgnited(c.env, "reply")
      ? (Number(await getSetting(c.env, "reply_fail_streak", "0")) || 0)
      : 0,
    // 批⑭②：alerts.noScore 撤了 —— 「抓不到官网」不再当系统警报（它是"信息不全"不是"故障"）。
    //   那批线索在「待分析」格里正常处理，不在待办里叫。
  };
  // ⭐ C2-D：首页三句话要的两块数据，**一次请求拿全**（首页多打一次接口 = 多一次能失败的地方）。
  //   · sentToday：今天发了几封 —— 首页第一句。用与设置页同一个 sentTodayBreakdown，
  //     ⛔ 不在这里另写一条 SQL：同一个数在两处各算各的，迟早对不上（这仓的老病）。
  //   · ignition：机器点火了没 —— 决定首句是"发了 N 封"还是"还没点火"。
  return c.json({
    dueFollowups, hotReplies, engagedToday, actions: sug.actions,
    sendable,                       // 批④：真能发的家数（approved+有邮箱+≥60+未压制）
    reviewCount: sug.reviewCount,   // 待审批
    serper,                         // ⚠️系统警报：Serper 预算
    alerts,                         // ⚠️系统警报：熔断 / 收回复失败（批⑪B）
    sentToday: await sentTodayBreakdown(c.env),   // C2-D 首页第一句
    ignition: ignitionReport(c.env),              // C2-D 首页第三句 + 机器房
    // C5-8 第④层「机器汇报行」：今天机器干了什么。**加字段不加端点**（总调度口径）。
    //   ⚠️ 数字为 0 也照实给 —— 前端那一行"发了 0 · 收了 0 · 新增 0"是有信息的
    //     （"机器在跑但今天没产出" ≠ "机器没在跑"），不许因为是 0 就不显示。
    todayWork: {
      replies: (await db.prepare(
        "SELECT COUNT(*) AS n FROM replies WHERE received_at IS NOT NULL AND date(received_at) = date('now')"
      ).first<{ n: number }>())?.n || 0,
      newLeads: (await db.prepare(
        "SELECT COUNT(*) AS n FROM leads WHERE created_at IS NOT NULL AND date(created_at) = date('now')"
      ).first<{ n: number }>())?.n || 0,
    },
  });
});

// ---- CSV 导入（去重）----
app.post("/api/leads/import", async (c) => {
  const body = await jsonBody<{ csv?: string; source?: string }>(c);
  const csv = body.csv || "";
  // ⚠️ source 由请求体控制 → 绝不允许自称可信目录来源（nmea/rvwithtito）。
  //    否则导一份 CSV 写 source=nmea，每条都能白拿 NMEA 强背书 = 打分器的新骗分通道。
  //    可信目录背书只能由我们自己的抓取管道（runNmeaDiscovery / runLinkHarvest）写入。
  const rawSource = String(body.source || "").trim();
  const source = (!rawSource || isTrustedDirectorySource(rawSource)) ? "csv" : rawSource.slice(0, 40);
  if (!csv.trim()) return c.json({ error: "empty csv" }, 400);

  const rows = parseCsv(csv);
  if (rows.length < 2) return c.json({ error: "csv 至少需要表头 + 1 行数据" }, 400);

  const header = rows[0].map((h) => h.trim().toLowerCase());
  let inserted = 0, skipped = 0;
  const errors: string[] = [];

  for (let i = 1; i < rows.length; i++) {
    const lead = mapRowToLead(header, rows[i]);
    if (!lead) { skipped++; continue; }
    if (!lead.company_name && !lead.website && !lead.email) { skipped++; continue; }

    // ⭐⭐ 批⑮：去重改走**全库唯一那条规则** `findDuplicateLead`（网址归一化 + 邮箱两把钥匙）。
    //
    // 原来这里是**原文比对**（`email = ?` / `website = ?`）—— 两个真问题：
    //   ① 网址：`https://x.com` 和 `http://www.X.com/` 是两条不同的字符串 → 判不出重。
    //      批⑮ 那 15 组重复正是这么进来的（同一家公司、两种网址写法）。
    //      三条 discover 管道早就改用 normalizeHost 了，**只有 CSV 这条还在裸比**（盘点时发现的）。
    //   ② 邮箱：大小写/前后空格不同就判不出（`A@X.com` vs `a@x.com `）。
    // 现在四条录入路径（search / nmea / rvtito / CSV）共用同一个函数，改判重口径只需改一处。
    const dup = await findDuplicateLead(c.env, { website: lead.website, email: lead.email });
    if (dup) { skipped++; continue; }

    try {
      // ⭐批④：CSV 里的两位国家码统一大写落库（英文全名等非两位值原样留给 /api/admin/normalize-countries 规整）
      const csvCC = String(lead.country || "").trim();
      const csvCountry = /^[a-z]{2}$/i.test(csvCC) ? csvCC.toUpperCase() : (csvCC || null);
      await c.env.DB.prepare(
        "INSERT INTO leads (company_name, website, email, country, source, keyword, status) VALUES (?, ?, ?, ?, ?, ?, 'new')"
      ).bind(lead.company_name, lead.website, lead.email, csvCountry, source, lead.keyword).run();
      inserted++;
    } catch (e: any) {
      errors.push(`第 ${i + 1} 行: ${e.message}`);
    }
  }

  return c.json({ inserted, skipped, errors: errors.slice(0, 10) });
});

// ---- AI 分析：单条 ----
app.post("/api/leads/:id/analyze", async (c) => {
  const id = Number(c.req.param("id"));
  const lead = await c.env.DB.prepare("SELECT * FROM leads WHERE id = ?").bind(id).first();
  if (!lead) return c.json({ error: "not found" }, 404);
  const out = await analyzeLead(c.env, lead);
  return c.json(out, out.ok ? 200 : 500);
});

// ---- AI 分析：批量（默认处理 5 条 new 线索）----
// C5-11 B4：一轮找客户跑完 → 推飞书。**幂等做在服务端**，不靠前端记状态。
//   为什么不由前端判重：弹窗可关、页面可刷新、cron 也可能接手 —— 前端的"我推过了"随时会丢，
//   丢了就重推。⇒ 判据放库里：`discover_round_id`（每次 /api/discover 开跑时写）
//   与 `discover_round_notified` 不相等、且 status='new' 已清零，才推，推完把 id 记上。
//   照 rescan 收尾的 larkSend 先例（index.ts ~2903），不新发明。
app.post("/api/discover/round-complete", async (c) => {
  const roundId = (await getSetting(c.env, "discover_round_id", "")).trim();
  if (!roundId) return c.json({ pushed: false, why: "本轮没有记录（可能不是从找客户发起的）" });
  const notified = (await getSetting(c.env, "discover_round_notified", "")).trim();
  if (notified === roundId) return c.json({ pushed: false, why: "本轮已推过" });   // 幂等
  const left = (await c.env.DB.prepare("SELECT COUNT(*) AS n FROM leads WHERE status='new'")
    .first<{ n: number }>())?.n || 0;
  if (left > 0) return c.json({ pushed: false, why: `还剩 ${left} 家没分析完`, remaining: left });

  // 本轮统计：以 discover_round_at 之后入库的线索为一轮（真值派生，不靠前端传数字）
  const since = (await getSetting(c.env, "discover_round_at", "")).trim() || "1970-01-01";
  const row = await c.env.DB.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN a.match_score >= ? THEN 1 ELSE 0 END) AS hi,
            SUM(CASE WHEN l.email IS NULL OR l.email = '' THEN 1 ELSE 0 END) AS noEmail,
            SUM(CASE WHEN a.lead_id IS NULL OR a.match_score IS NULL THEN 1 ELSE 0 END) AS nil
       FROM leads l LEFT JOIN lead_analysis a ON a.lead_id = l.id
      WHERE l.created_at >= ?`
  ).bind(APPROVE_MIN_SCORE, since).first<any>();
  const total = Number(row?.total || 0), hi = Number(row?.hi || 0);
  const noEmail = Number(row?.noEmail || 0), nil = Number(row?.nil || 0);

  await setSetting(c.env, "discover_round_notified", roundId);   // 先记再推：推失败也不重推刷屏
  try {
    if (larkConfigured(c.env)) {
      await larkSend(c.env, { msg_type: "text", content: { text:
        `AIRSONDE ✅ 本轮找客户完成
` +
        `· 本轮共分析 ${total} 家
` +
        `· ${hi} 家 ≥${APPROVE_MIN_SCORE} 分
` +
        `· ${noEmail} 家 缺邮箱
` +
        `· ${nil} 家 官网抓不到（未打分，不是不合格）` } });
    }
  } catch (e) { console.error("round-complete digest:", e); }
  return c.json({ pushed: true, stats: { total, hi, noEmail, nil } });
});

// C5-11：待分析 id 清单（**只读，纯增量**）——给前端做"不相交分块"用。
//   ⚠️ 为什么需要它：`/api/analyze/batch` 的选行是 `WHERE status='new' ORDER BY id LIMIT n`，
//     **没有认领机制**。前端要并行发 K 个批次提速，如果每个都让服务端自己选，K 个调用会抓到
//     **同一批行** ⇒ 同一条线索被分析多次 = **重复烧 AI 的钱**。
//     所以由前端先取一次全量 id、切成 K 份**互不相交**的块，各自用既有的 `ids` 参数发出去。
//   ⚠️ 没有加 `status='analyzing'` 这类认领列：请求中途死掉会留下**永远解不开的悬挂状态**，
//     而 id 分块方案天然幂等 —— 失败的那块线索仍是 'new'，cron 会兜底捡回去。
//   ⚠️ 老客户端不调它，只增不改：Joe 浏览器里可能还开着旧页面在跑老循环。
app.get("/api/analyze/pending-ids", async (c) => {
  const cap = Math.min(Math.max(Number(c.req.query("limit")) || 500, 1), 2000);
  const rows = (await c.env.DB.prepare(
    "SELECT id FROM leads WHERE status = 'new' ORDER BY id ASC LIMIT ?"
  ).bind(cap).all()).results as any[];
  return c.json({ ids: rows.map((r) => Number(r.id)), capped: rows.length >= cap });
});

app.post("/api/analyze/batch", async (c) => {
  const body = await jsonBody<{ limit?: number; ids?: number[] }>(c);
  const limit = Math.min(Math.max(Number(body.limit) || 5, 1), 20);
  // A2：传 ids 只处理选中的（仍受原有 status='new' 过滤 + limit 上限）；不传维持原行为
  const ids = Array.isArray(body.ids) ? [...new Set(body.ids.map(Number).filter(Number.isFinite))].slice(0, 500) : [];
  const rows = ids.length
    ? await c.env.DB.prepare(
        `SELECT * FROM leads WHERE status = 'new' AND id IN (${ids.map(() => "?").join(",")}) ORDER BY id ASC LIMIT ?`
      ).bind(...ids, limit).all()
    : await c.env.DB.prepare(
        "SELECT * FROM leads WHERE status = 'new' ORDER BY id ASC LIMIT ?"
      ).bind(limit).all();
  const leads = rows.results as any[];

  // 批⑦B：3 条并发（为什么是 3 见 ANALYZE_CONCURRENCY）。每条自己 try/catch，一条炸了不带走整批。
  const results = await pool(leads, ANALYZE_CONCURRENCY, async (lead) => {
    try { return await analyzeLead(c.env, lead); }
    catch (e) { console.error("analyze:", lead.id, e); return { ok: false, id: lead.id, error: String(e) }; }
  });
  const ok = results.filter((r) => r.ok).length;
  return c.json({ processed: results.length, ok, failed: results.length - ok, results });
});

// ---- 客户画像设置 ----
app.get("/api/settings/profile", async (c) => {
  const profile = await getProfile(c.env);
  const row = await c.env.DB.prepare("SELECT value FROM settings WHERE key='customer_profile'").first();
  return c.json({ profile, isDefault: !row });
});
app.post("/api/settings/profile", async (c) => {
  const body = await jsonBody<{ profile?: string }>(c);
  const profile = (body.profile || "").trim();
  if (!profile) return c.json({ error: "profile 不能为空" }, 400);
  await c.env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES ('customer_profile', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).bind(profile).run();
  return c.json({ ok: true });
});
// 一次性：把生效画像重置为当前 DEFAULT_PROFILE（经销/电商卖家 ICP），覆盖已有自定义。
app.post("/api/admin/reset-profile", async (c) => {
  await c.env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES ('customer_profile', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).bind(DEFAULT_PROFILE).run();
  return c.json({ ok: true, length: DEFAULT_PROFILE.length });
});
// E2 一次性：清空关键词池并重灌新版 DEFAULT_KEYWORDS + 默认搜索国家设为 22 国。
// （生产 keywords 表已有旧词，仅改 DEFAULT_KEYWORDS 不生效，故用此端点覆盖。）
app.post("/api/admin/reset-keywords", async (c) => {
  await c.env.DB.prepare("DELETE FROM keywords").run();
  await seedDefaultKeywords(c.env);
  await setSetting(c.env, "search_countries", DEFAULT_COUNTRIES.join(","));
  const kws = await getKeywords(c.env);
  return c.json({ ok: true, keywords: kws.length, countries: DEFAULT_COUNTRIES.length });
});

// ---- 调试：查看抓取效果（内部工具，验证网站抓取用）----
// ⛔ M12（安全审计）：受限 SSRF —— 这个端点让**服务端去请求调用方给的任意 URL**。
//   它确实在 Access 后面，所以外部不可达；但**"在 Access 后面"不该是保留一个 SSRF 的理由** ——
//   那是把安全押在另一层上（和 H12 押在边缘 Host 行为上，是同一个形状）。
//   改成**只在本地开发挂载**：调试价值一点没少（本地就是用它调的），生产面归零。
app.get("/api/debug/scrape", async (c) => {
  if (!devGuardOn(c.env)) return c.notFound();   // 生产：当它不存在
  const url = c.req.query("url") || "";
  if (!url) return c.json({ error: "缺少 url 参数" }, 400);
  const r = await scrapeSite(url);
  return c.json({ ok: r.ok, error: r.error, pages: r.pages, chars: r.text.length, sample: r.text.slice(0, 600) });
});

// ---- P3 发信：单条（要求已批准 approved）----
app.post("/api/leads/:id/send", async (c) => {
  const id = Number(c.req.param("id"));
  const lead = await c.env.DB.prepare("SELECT * FROM leads WHERE id=?").bind(id).first();
  if (!lead) return c.json({ error: "not found" }, 404);
  const out = await sendLead(c.env, lead);
  return c.json(out, out.ok ? 200 : 500);
});

// ---- 详情弹窗：保存（人工编辑过的）推荐开发信 ----
// ⭐ 批⑬②：改网址 —— 「AI 没判成」那批的**出口之一**。
//   那 79 条全是"连续 3-4 次抓不到官网"：**官网地址可能就是错的/过期的**（换域名、写错、加了 www）。
//   给 Joe 一个改网址的地方 + 手动重新分析 → 捞回真客户。
//   ⭐ 里面藏着真客户：Redington Group（官网标题写着 "Starlink Authorized Distributor"）、
//     EET Group（"Distributor of more than 7 Starlink products"）、Zimmerman Marine…
//   **这跟"抓站失败=不合格"是同一类病换了个地方**：那次埋了 15 个真客户在"不合格"里。
app.post("/api/leads/:id/website", async (c) => {
  const id = Number(c.req.param("id"));
  const b = await jsonBody<{ website?: string }>(c);
  let url = String(b.website ?? "").trim();
  if (!url) return c.json({ error: "网址不能为空" }, 400);
  if (url.length > 300) return c.json({ error: "网址过长" }, 400);
  // 容错：Joe 多半会直接粘 "example.com"，补上协议再存 —— 不因为少个 https 就让他改两遍
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  try { new URL(url); } catch { return c.json({ error: "网址格式不对" }, 400); }
  // ⚠️ 改了网址就把 fetch_fail_count 清零 + 状态退回 new —— 否则它**还是卡死的**：
  //    cron 只捡 status='new'，而 fetch_fail_count 到上限的会被跳过。
  //    改网址的**意图**就是"这次能抓到了，再试一次" —— 不清零等于改了个寂寞。
  const res = await c.env.DB.prepare(
    "UPDATE leads SET website=?, fetch_fail_count=0, status='new', updated_at=datetime('now') WHERE id=? AND status IN ('analyzed','pending','new')"
  ).bind(url, id).run();
  if (!res.meta.changes) return c.json({ error: "没找到这条线索，或它已经不在待处理状态" }, 404);
  return c.json({ ok: true, website: url, note: "已退回「待分析」，下一班 cron 会重抓；也可以点「立即分析选中」马上试" });
});

app.post("/api/leads/:id/email", async (c) => {
  const id = Number(c.req.param("id"));
  const b = await jsonBody<{ recommended_email?: string }>(c);
  const em = (b.recommended_email ?? "").slice(0, 8000);
  const res = await c.env.DB.prepare("UPDATE lead_analysis SET recommended_email=? WHERE lead_id=?").bind(em, id).run();
  return c.json({ ok: !!res.meta.changes });
});

// #44 推荐开发信一键翻译成中文（纯展示；传入文本仅当数据翻译，不改动实际发送的英文原文）
app.post("/api/translate", async (c) => {
  const b = await jsonBody<{ text?: string }>(c);
  const text = String(b.text ?? "").trim();
  if (!text) return c.json({ error: "空文本" }, 400);
  if (text.length > 8000) return c.json({ error: "文本过长（上限 8000 字）" }, 400);
  try {
    const translation = await translateToChinese(c.env, text);
    return c.json({ translation });
  } catch (e: any) {
    return c.json({ error: String(e?.message || e) }, 500);
  }
});

// ---- 详情弹窗：手动填「联系邮箱」到 leads.email（用户自己在官网找到的；区别于上面存草稿的 :id/email）----
app.post("/api/leads/:id/contact-email", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "无效 id" }, 400);
  const b = await jsonBody<{ email?: string }>(c);
  const email = String(b.email ?? "").trim();
  if (!email || email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ error: "邮箱格式不正确" }, 400);
  }
  // 合规红线：退订/退信/黑名单邮箱不能作为发信地址（与发信同一道 isEmailSuppressed 闸）
  if (await isEmailSuppressed(c.env, email)) {
    return c.json({ error: "该邮箱已退订/退信/黑名单，不能作为发信地址" }, 409);
  }
  const res = await c.env.DB.prepare("UPDATE leads SET email=?, updated_at=datetime('now') WHERE id=?").bind(email, id).run();
  if (!res.meta.changes) return c.json({ error: "线索不存在" }, 404);
  return c.json({ ok: true, email });
});

// ---- engaged「趁热跟进」：起草暖跟进（不发送，返回可编辑全文供人工审）----
app.post("/api/leads/:id/warm-followup", async (c) => {
  const id = Number(c.req.param("id"));
  const lead = await c.env.DB.prepare("SELECT * FROM leads WHERE id=?").bind(id).first<any>();
  if (!lead) return c.json({ error: "not found" }, 404);
  const a = await c.env.DB.prepare("SELECT recommended_email FROM lead_analysis WHERE lead_id=?").bind(id).first<{ recommended_email: string }>();
  try {
    const text = await writeWarmFollowup(c.env, await brandForLead(c.env, lead, "followup"), lead.company_name || "", await getProfile(c.env), a?.recommended_email || "");
    return c.json({ ok: true, text });
  } catch (e: any) {
    return c.json({ error: "起草失败: " + (e.message || String(e)) }, 500);
  }
});
// ---- engaged「趁热跟进」：发送用户审过（可能已编辑）的暖跟进（走 deliverEmail 压制闸）----
app.post("/api/leads/:id/warm-followup/send", async (c) => {
  const id = Number(c.req.param("id"));
  const lead = await c.env.DB.prepare("SELECT * FROM leads WHERE id=?").bind(id).first<any>();
  if (!lead) return c.json({ error: "not found" }, 404);
  const b = await jsonBody<{ text?: string }>(c);
  const out = await sendWarmFollowupNow(c.env, lead, b.text || "");
  if (out.skipped) return c.json({ skipped: out.skipped }, 200);
  return c.json(out, out.ok ? 200 : 500);
});

// ---- P3 发信：批量已批准（按分数从高到低 + 每日上限）----
app.post("/api/send/batch", async (c) => {
  const body = await jsonBody<{ limit?: number; ids?: number[] }>(c);
  const limit = Math.min(Math.max(Number(body.limit) || 10, 1), 50);
  // A2：传 ids 只发选中的（仍走同一条 sendApprovedBatch —— status='approved' + ≥60分门槛 +
  // 每日上限 + 原子取批 + deliverEmail 幂等 + 压制名单，一个都不绕过）；不传维持原行为
  const ids = Array.isArray(body.ids) ? [...new Set(body.ids.map(Number).filter(Number.isFinite))].slice(0, 500) : [];
  const out = await sendApprovedBatch(c.env, limit, ids.length ? ids : undefined);
  // 批㉒：把"今天这 N 封都是谁"一起带回去（总闸不变，只是让弹窗能说清构成）
  return c.json({ ...out, breakdown: await sentTodayBreakdown(c.env) });
});

// ---- 无回复自动跟进设置 ----
app.get("/api/settings/followup", async (c) => {
  return c.json({
    enabled: (await getSetting(c.env, "followup_enabled", "0")) === "1",
    delay_days: Number(await getSetting(c.env, "followup_delay_days", "4")) || 4,
    engaged_delay_days: Number(await getSetting(c.env, "engaged_follow_up_delay_days", "2")) || 2,
    max_followups: Number(await getSetting(c.env, "followup_max", "1")) || 1,
    // 顺带修①：跟进发满后再等几天没回应就归档。**做成设置不写死** —— 这是发信节奏参数，是 Joe 的旋钮。
    no_reply_days: Number(await getSetting(c.env, "no_reply_days", "7")) || 7,
  });
});
app.post("/api/settings/followup", async (c) => {
  const b = await jsonBody<{ enabled?: boolean; delay_days?: number; engaged_delay_days?: number; max_followups?: number; no_reply_days?: number }>(c);
  if (b.enabled != null) await setSetting(c.env, "followup_enabled", b.enabled ? "1" : "0");
  if (b.delay_days != null) await setSetting(c.env, "followup_delay_days", String(Math.max(1, Math.min(60, Number(b.delay_days) || 4))));
  if (b.engaged_delay_days != null) await setSetting(c.env, "engaged_follow_up_delay_days", String(Math.max(1, Math.min(60, Number(b.engaged_delay_days) || 2))));
  if (b.max_followups != null) await setSetting(c.env, "followup_max", String(Math.max(1, Math.min(5, Number(b.max_followups) || 1))));
  if (b.no_reply_days != null) await setSetting(c.env, "no_reply_days", String(Math.max(1, Math.min(90, Number(b.no_reply_days) || 7))));
  return c.json({ ok: true });
});
// ---- 无回复跟进：手动跑一批 ----
app.post("/api/followup/run", async (c) => {
  const body = await jsonBody<{ limit?: number; ids?: number[] }>(c);
  const limit = Math.min(Math.max(Number(body.limit) || 10, 1), 50);
  // 批③C：传 ids 只跟进选中的（走同一条 sendFollowupBatch —— 开关/冷却/次数/每日上限/幂等/压制一个不绕；
  // engaged 的自动用「趁热」暖变体，所以「跟进选中」与「趁热跟进选中」共用本端点）
  const ids = Array.isArray(body.ids) ? [...new Set(body.ids.map(Number).filter(Number.isFinite))].slice(0, 500) : [];
  const out = await sendFollowupBatch(c.env, limit, ids.length ? ids : undefined);
  return c.json(out);
});

// 一键开聊默认话术（英文，{company} 占位；渲染时替换为公司名）
// ⚠️ AirSonde 话术占位草稿（C1），待 Joe 审定
const DEFAULT_CHAT_SCRIPT =
  "Hi {company} team — AirSonde builds air quality monitors (CO2, PM2.5, TVOC) factory-direct, with OEM/private-label options for brands, distributors & HVAC integrators. May I send you our trade price list?";

// ---- 发信设置（每日上限 + 公司名 + 合规地址 + 卖点 + 一键开聊话术）----
app.get("/api/settings/sending", async (c) => {
  const br = await getBreakerStatus(c.env);
  const sysLimit = await systemDailySendLimit(c.env);
  const autoLimit = await autoSendDailyLimit(c.env, sysLimit.effective);
  return c.json({
    // ⭐ 系统级发信上限：走唯一咽喉点 systemDailySendLimit（**不要**在这里自己 getSetting，
    //   那正是"多处各读各的"演化成 -90% 静默事故的写法）。source 供 UI 挂"未配置"徽标。
    daily_send_limit: sysLimit.limit,
    daily_send_limit_source: sysLimit.source,          // configured | legacy | default
    daily_send_limit_default: SYSTEM_LIMIT_DEFAULT,
    daily_send_limit_max: LIMIT_MAX,                   // 可设的最大值（前端要能说清"为什么没存成你输的数"）
    // 新域爬坡保护：批量通道真正生效的是 effective，**必须带给前端**——
    //   否则又变成"界面显示 1000、后端按 45 发"，就是我们刚修完的那种说谎。
    send_ramp_enabled: sysLimit.rampEnabled,
    send_ramp_cap: sysLimit.rampCap,
    // C5-22 上限面板：**生效值 + 来源**一起给。
    // ⚠️ 只给数字不给来源，Joe 分不清"这是我设的"还是"没配置回落的"——那正是铁律三禁的
    //   "显示一个看起来正常的默认值"。source: configured = 他设过；default = 代码常量兜的。
    send_ramp_floor: await numSetting(c.env, "send_ramp_floor", RAMP_FLOOR, 1, 5000),
    send_ramp_floor_source: (await getSetting(c.env, "send_ramp_floor", "")).trim() ? "configured" : "default",
    send_ramp_factor: await numSetting(c.env, "send_ramp_factor", RAMP_FACTOR, 1, 10),
    send_ramp_factor_source: (await getSetting(c.env, "send_ramp_factor", "")).trim() ? "configured" : "default",
    send_interval_seconds: await numSetting(c.env, "send_interval_seconds", SEND_INTERVAL_DEFAULT, 0, 3600),
    send_interval_source: (await getSetting(c.env, "send_interval_seconds", "")).trim() ? "configured" : "default",
    breaker_window_eff: Math.floor(await numSetting(c.env, "breaker_window", BREAKER_WINDOW, 5, 1000)),
    breaker_threshold_eff: await numSetting(c.env, "breaker_threshold", BREAKER_THRESHOLD, 0.01, 0.9),
    breaker_source: ((await getSetting(c.env, "breaker_window", "")).trim() || (await getSetting(c.env, "breaker_threshold", "")).trim()) ? "configured" : "default",
    yesterday_cold: sysLimit.yesterdayCold,
    effective_send_limit: sysLimit.effective,
    // 系统闸只卡冷发(initial+followup)；事务信(确认/回真人)豁免但在用量里显示，见 send.ts coldSentToday
    cold_sent_today: await coldSentToday(c.env),
    company_name: await getSetting(c.env, "company_name", "AirSonde"),
    company_address: await getSetting(c.env, "company_address", DEFAULT_COMPANY_ADDRESS),
    company_website: await getSetting(c.env, "company_website", c.env.SITE_URL || "https://airsonde.com"),
    selling_points: await getSetting(c.env, "selling_points", DEFAULT_SELLING_POINTS),
    chat_script: await getSetting(c.env, "chat_script", DEFAULT_CHAT_SCRIPT),
    // L4(#54)：BCC 存档地址（空=关）。填 outbox 公共邮箱（域待定）后所有外发自动密送。
    bcc_archive: await getSetting(c.env, "bcc_archive", ""),
    // `wanew_daily_limit` 已退役（按发件域命名/计数=Joe 否掉的设计），字段不再返回。
    // 各发件域今日发量仍带出——纯**观察**用（看发件域切换是否干净），不再是任何闸。
    // （键名随 fork 改为 primary/legacy_sent_today——上游按新旧发件域命名，index.html 同步改）
    primary_sent_today: await senderSentToday(c.env, SENDER_PRIMARY),
    legacy_sent_today: await senderSentToday(c.env, SENDER_LEGACY),
    // 自动化三开关 + 熔断状态（前端要能看能关；熔断后必须显眼告诉 Joe 为什么停了）
    auto_approve_enabled: await autoApproveEnabled(c.env),
    auto_send_enabled: await autoSendEnabled(c.env),
    // C5-22：总开关 + "现在为什么不自动发信"的**唯一**理由来源（顶栏徽章/设置页/机器房共用它，别各拼各的）
    automation_enabled: await automationEnabled(c.env),
    // "今日还可发几封"：**服务端算**，用的就是发送路径自己那两个函数（systemDailySendLimit + coldSentToday）。
    // ⚠️ 不让前端拿 limit 和 sent 自己减 —— 那就是第二处口径，早晚跟真闸对不上（铁律五）。
    // 🔴 C5-22 补漏：**生效值 + 被谁卡住**。
    //   生产实况 2026-09-01：Joe 设了 1000 封/天，而新域保护今天算出来的上限是 30
    //   ⇒ 机器发满 30 就停。而设置页当时**一个字都没说** —— 他看到的是"我设了 1000"，
    //   机器发了 30，只能得出"机器坏了"这个结论。
    //   这就是铁律三那条"不许显示一个看起来正常的默认值"的同一种病：
    //   **显示一个他设的、但此刻并不生效的数，比不显示更误导。**
    //   ⚠️ 上一段我给新旋钮做了"生效值+来源"，却漏了真正卡住他的这一个 —— 派单原话是"全部"。
    send_limit_effective: await (async () => { const { effective } = await systemDailySendLimit(c.env); return effective; })(),
    send_limit_capped_by: await (async () => {
      const info = await systemDailySendLimit(c.env);
      if (info.effective >= info.limit) return null;                 // 没被压低，你填的数就是生效数
      return info.rampEnabled ? "ramp" : "other";                    // 被新域保护压低
    })(),
    send_room_today: await (async () => {
      const { effective } = await systemDailySendLimit(c.env);
      return Math.max(0, effective - (await coldSentToday(c.env)));
    })(),
    automation_changed_at: await getSetting(c.env, "automation_changed_at", ""),
    auto_send_blocked_reason: await autoSendBlockedReason(c.env),
    // 自动闸默认跟随系统闸（走 resolver，不在这里自己 getSetting）——老写法的硬默认 15/生产 200
    // 就是把"系统闸 1000"悄悄压成 200 的那个隐形瓶颈。source: system=跟随 · configured=Joe 单独设过。
    auto_send_daily_limit: autoLimit.limit,
    auto_send_daily_limit_source: autoLimit.source,
    auto_approve_min: await getAutoApproveMin(c.env),
    auto_sent_today: await autoSentToday(c.env),
    // 批⑩B：发送确认弹窗要说清"今日上限还剩几封"。复用本端点加一个字段，不新开端点。
    sent_today: await sentToday(c.env),
    sent_today_breakdown: await sentTodayBreakdown(c.env),   // 批㉒：首触/跟进/自动 拆分（总数不变）
    // ⭐ 批⑪C：今日 AI 用量 —— 让 Joe **自己看见**批⑦ 省下的钱，不用来问总工。
    //   他今晚亲眼看着重扫烧了 3 小时 + ~$10，问"是不是 ≥60 才写信就能省"。
    //   批⑦ 比那个更彻底：**发送那一刻才写** → 434 家里真发出去的只有 48 封 → 只写 48 封。
    //   ⚠️ 口径要准，否则就是又一个假数字：
    //     · 分析 = lead_analysis.analyzed_at 当天（打分那次真调了 AI）
    //     · 写信 = lead_analysis.drafted_at 当天（**不是数 emails 行** —— 草稿生成后还可能被
    //       压制/幂等跳过、不建 emails 行，那样 AI 钱烧了却不计数 = 少报）
    // ⭐ 批⑪C：AI **花了多少钱** —— 问 OpenRouter 要真数，不猜单价。
    //   它一条同时答 Joe 的两个问题："最近用这么多正常吗"（daily/monthly）+ "是不是设了限额"（limit）。
    //   带 10 分钟缓存（settings），别每次开页面都打人家一次。拿不到时**绝不返回 0**（见 getAiUsage）。
    ai_cost: await getAiUsage(c.env, (k, d) => getSetting(c.env, k, d), (k, v) => setSetting(c.env, k, v)),
    ai_today: {
      analyzed: (await c.env.DB.prepare(
        "SELECT COUNT(*) AS n FROM lead_analysis WHERE date(analyzed_at)=date('now')").first<{ n: number }>())?.n || 0,
      drafted: (await c.env.DB.prepare(
        "SELECT COUNT(*) AS n FROM lead_analysis WHERE date(drafted_at)=date('now')").first<{ n: number }>())?.n || 0,
    },
    // ⭐ P0-1：产能估算 —— 让设置页当场告诉 Joe"你填的数能不能达到"。
    //   这**不是上限**（他填多少是多少），是"做不到就当场说"，绝不悄悄砍。
    capacity: estimateDailyCapacity(),
    breaker: {
      window: br.window, unsubs: br.unsubs,
      rate: Math.round(br.rate * 1000) / 10,          // 百分数，一位小数
      enoughSample: br.enoughSample,
      windowSize: BREAKER_WINDOW,
      thresholdPct: BREAKER_THRESHOLD * 100,
      trippedAt: await getSetting(c.env, "auto_send_tripped_at", ""),
      tripReason: await getSetting(c.env, "auto_send_trip_reason", ""),
    },
  });
});
app.post("/api/settings/sending", async (c) => {
  const b = await jsonBody<{ daily_send_limit?: number; company_name?: string; company_address?: string; company_website?: string; selling_points?: string; chat_script?: string; auto_approve_enabled?: boolean; auto_send_enabled?: boolean; auto_send_daily_limit?: number; auto_approve_min?: number; bcc_archive?: string; send_ramp_enabled?: boolean; automation_enabled?: boolean }>(c);
  // ⭐ 系统级发信上限（唯一真源）。写成功即把 source 从 legacy/default 变成 configured →
  //   守卫随之闭嘴，"Joe 手点一次"就是他要的那个「一键设置」。
  //   同时**清掉退役的 `wanew_daily_limit` 残行** —— 留着它 legacy 兜底会一直遮住真值，
  //   也让"迁移到底完没完"永远说不清。收尾要干净，不留两套。
  //
  // ⚠️ clamp 上限 500 → LIMIT_MAX：Joe 拍板 1000 时，老的 `Math.min(500,…)` **把 1000 静默截成 500
  //    还照样返回 ok:true** —— 接受了请求、存了另一个数、什么都不说，正是本项目一路在修的那类病。
  //    现在两件事一起改：① 上限放到 LIMIT_MAX ② **被截断必须说出来**（响应带回真正存进去的值 +
  //    clamped 标记），调用方/UI 才可能发现"我输的不是我得到的"。
  let limitSaved: number | undefined, limitClamped = false;
  if (b.daily_send_limit != null) {
    const asked = Math.floor(Number(b.daily_send_limit) || SYSTEM_LIMIT_DEFAULT);
    limitSaved = Math.max(1, Math.min(LIMIT_MAX, asked));
    limitClamped = limitSaved !== asked;
    await setSetting(c.env, "daily_send_limit", String(limitSaved));
    await c.env.DB.prepare("DELETE FROM settings WHERE key='wanew_daily_limit'").run();
  }
  // 爬坡保护开关（Joe 觉得碍事可一键关掉，直接用天花板）
  if (b.send_ramp_enabled != null) await setSetting(c.env, "send_ramp_enabled", b.send_ramp_enabled ? "1" : "0");
  if (b.auto_approve_enabled != null) await setSetting(c.env, "auto_approve_enabled", b.auto_approve_enabled ? "1" : "0");

  // ══ C5-22：「自动模式」总开关（Joe 的意图，唯一真源）══
  // ⚠️ 换挡要**推一次飞书**，因为今天出的事正是"被误触打开且无人察觉"。
  //   幂等靠"与当前值不同才动作"：页面刷新、重复 PUT 同一个值都不会重推。
  // ══ C5-22 上限面板：Joe 的旋钮。清空 = **回落到代码默认**（删行），不是"设成 0" ══
  // ⚠️ 这个区别不是细节：把"我不想管这个"和"我要它等于 0"混成一个输入，
  //   就等于再造一次那个被拔掉的魔法值（旧的"填 0 = 跟随"）。空字符串删行、有值才写。
  const numKnob = async (key: string, v: any) => {
    if (v == null) return;
    const raw = String(v).trim();
    if (raw === "") { await c.env.DB.prepare("DELETE FROM settings WHERE key=?").bind(key).run(); return; }
    const n = Number(raw);
    if (Number.isFinite(n)) await setSetting(c.env, key, String(n));
  };
  await numKnob("send_interval_seconds", (b as any).send_interval_seconds);
  await numKnob("send_ramp_floor",      (b as any).send_ramp_floor);
  await numKnob("send_ramp_factor",     (b as any).send_ramp_factor);
  await numKnob("breaker_window",       (b as any).breaker_window);
  await numKnob("breaker_threshold",    (b as any).breaker_threshold);

  if (b.automation_enabled != null) {
    const want = !!b.automation_enabled;
    const was = await automationEnabled(c.env);
    await setSetting(c.env, "automation_enabled", want ? "1" : "0");
    if (want !== was) {
      await setSetting(c.env, "automation_changed_at", new Date().toISOString().replace("T", " ").slice(0, 19));
      try {
        if (larkConfigured(c.env)) {
          // 数字取**真值**，不写死：Joe 要在通知里看到"今天还能发几封"才知道这一开意味着什么。
          const { effective } = await systemDailySendLimit(c.env);
          const room = Math.max(0, effective - (await coldSentToday(c.env)));
          await larkSend(c.env, { msg_type: "text", content: { text: want
            ? `AIRSONDE 自动模式已【开启】（来源：后台设置）
机器会连续地找客户、分析、批准、写信发信，不等整点。
今日还可发 ${room} 封（上限 ${effective}/天）。`
            : `AIRSONDE 自动模式已【关闭】（来源：后台设置）
搜索/分析/批准/发送/跟进全部停止；收信、分类与本通知照常在线。` } });
        }
      } catch (e) { console.error("automation-notify:", e); }   // 通知失败不影响换挡本身
    }
  }
  // 下限钉死在 APPROVE_MIN_SCORE：设更低也不生效（approveGateReason 照样拦），不给"设了却没用"的假象
  if (b.auto_approve_min != null) await setSetting(c.env, "auto_approve_min", String(Math.max(APPROVE_MIN_SCORE, Math.min(100, Number(b.auto_approve_min) || AUTO_APPROVE_MIN_DEFAULT))));
  // 自动闸：0/空 = **跟随系统闸**（删行，回到"不卡人"的默认）；>0 = Joe 想让自动少发，按他的值。
  // ⚠️ 老的 `Math.min(200,…)` 一并去掉 —— 它会把 Joe 想设的 1000 又静默截成 200，同一种病。
  if (b.auto_send_daily_limit != null) {
    const v = Math.floor(Number(b.auto_send_daily_limit) || 0);
    if (v <= 0) await c.env.DB.prepare("DELETE FROM settings WHERE key='auto_send_daily_limit'").run();
    else await setSetting(c.env, "auto_send_daily_limit", String(Math.min(LIMIT_MAX, v)));
  }
  if (b.auto_send_enabled != null) {
    const was = await autoSendEnabled(c.env);
    await setSetting(c.env, "auto_send_enabled", b.auto_send_enabled ? "1" : "0");
    // 手动重开 = Joe 说"我查过了、改过了" → 清熔断印记 + **把熔断窗口的起点挪到此刻**。
    // ⚠️ 不挪起点的话熔断**不可恢复**：停了之后窗口再也不进新数据、永远卡在那个超标率，
    //    Joe 一重开，下一轮 cron 立刻拿同一批老数据再熔断一次，一封新信都发不出去。
    //    挪起点 ≠ 自动恢复（总工禁止的那个）：没有 Joe 手动点这一下，永远不会重开；
    //    重开之后窗口从 0 开始攒，攒够 30 封新的再判 —— 拿改之后的数据判，不拿旧账再判一次。
    if (b.auto_send_enabled && !was) {
      await setSetting(c.env, "auto_send_resumed_at", new Date().toISOString().replace("T", " ").slice(0, 19));
      await setSetting(c.env, "auto_send_tripped_at", "");
      await setSetting(c.env, "auto_send_trip_reason", "");
    }
  }
  // L4(#54)：BCC 存档地址。空串=关；非空必须是合法邮箱格式（防手滑存进乱字符导致 Resend 全线报错）。
  if (b.bcc_archive != null) {
    const v = String(b.bcc_archive).trim();
    if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return c.json({ error: "BCC 存档地址格式不对" }, 400);
    await setSetting(c.env, "bcc_archive", v);
  }
  if (b.company_name != null) await setSetting(c.env, "company_name", b.company_name.trim());
  if (b.company_address != null) await setSetting(c.env, "company_address", b.company_address.trim());
  if (b.company_website != null) await setSetting(c.env, "company_website", b.company_website.trim());
  if (b.selling_points != null) await setSetting(c.env, "selling_points", b.selling_points.trim());
  if (b.chat_script != null) await setSetting(c.env, "chat_script", b.chat_script.trim());
  // 把**真正存进去的值**带回去。`ok:true` 而值被悄悄改小，是这条链上刚咬过我们一次的病。
  return c.json({ ok: true, daily_send_limit: limitSaved, daily_send_limit_clamped: limitClamped, daily_send_limit_max: LIMIT_MAX });
});

// ---- 退订：一键退订(POST, RFC 8058) + 页面(GET) ----
app.post("/u/:token", async (c) => {
  const token = c.req.param("token");
  await unsubscribeByToken(c.env, token);
  // redirect=1 只有**确认页上那个按钮**会带 —— 人点完要看到一句人话，而不是裸文本。
  // ⚠️ 邮件客户端的 RFC 8058 一键退订**不带这个参数**，走原路返回 200 纯文本，行为一个字没变。
  if (c.req.query("redirect") === "1") {
    const lang = (c.req.query("lang") || "").slice(0, 5);
    return c.redirect(`/u/${encodeURIComponent(token)}?done=1${lang ? `&lang=${encodeURIComponent(lang)}` : ""}`, 303);
  }
  return c.text("Unsubscribed", 200);
});

// 退订页四语 —— 上游按官网语言集配的（en/es/pt/zh）；AirSonde 官网纯英文，多语退订页无害保留（客户可见页面，多语只多不少）。
// ⚠️ 开发信目前是**纯英文**，但收信人所在地未必；退订页是**客户可见**页面，
//    让人看不懂的退订页 = 变相刁难。文案一律直给：一句说明 + 一个按钮 + 一句"误点可关"。
//    绝不做"确定要走吗/再想想"这类挽留话术 —— 想退订的人多受一道刁难，换来的是投诉而不是留存。
const UNSUB_I18N: Record<string, { lead: string; btn: string; oops: string; done: string }> = {
  en: {
    lead: "Click below to unsubscribe from our emails.",
    btn: "Unsubscribe",
    oops: "If you opened this page by accident, you can simply close it — nothing has changed.",
    done: "You have been unsubscribed. You will not receive further emails from us.",
  },
  pt: {
    lead: "Clique abaixo para cancelar a inscrição em nossos e-mails.",
    btn: "Cancelar inscrição",
    oops: "Se você abriu esta página por engano, basta fechá-la — nada foi alterado.",
    done: "Sua inscrição foi cancelada. Você não receberá mais e-mails nossos.",
  },
  es: {
    lead: "Haz clic abajo para darte de baja de nuestros correos.",
    btn: "Darse de baja",
    oops: "Si abriste esta página por error, simplemente ciérrala: no se ha cambiado nada.",
    done: "Te has dado de baja. No recibirás más correos nuestros.",
  },
  zh: {
    lead: "点击下方按钮，取消订阅我们的邮件。",
    btn: "取消订阅",
    oops: "如果您是误打开本页，直接关闭即可 —— 没有任何变更。",
    done: "已取消订阅，我们不会再向您发送邮件。",
  },
};
/** 选语言：?lang= 显式优先（用户自己点的），否则读 Accept-Language，都不认就 en。 */
function pickUnsubLang(explicit: string, acceptLanguage: string): string {
  const norm = (s: string) => s.trim().toLowerCase().split("-")[0];
  if (explicit && UNSUB_I18N[norm(explicit)]) return norm(explicit);
  // Accept-Language 形如 "pt-BR,pt;q=0.9,en;q=0.8" —— 按 q 权重顺序取第一个我们支持的
  for (const part of (acceptLanguage || "").split(",")) {
    const code = norm(part.split(";")[0]);
    if (UNSUB_I18N[code]) return code;
  }
  return "en";
}
// ⭐⭐ GET 不再"打开即退订" —— 它必须只是一个**确认页**，真正的退订由页面上的按钮走 POST。
//
// 2026-07-28 生产实证（退订率归因）：33 条退订里 **13 条发生在发信后 <2 分钟**
//   （最快 5 秒，另有 18/23/24/27 秒），且**全部没有开信记录**。
//   人不可能 5 秒内收信、读完、点退订；没开信却"点"了链接 =
//   **企业邮件安全网关抓取正文里每个链接**（Defender Safe Links / Proofpoint /
//   Mimecast / Barracuda 都这么干）的典型指纹。
//
// 后果不是"指标难看"，而是：**从没表达过拒绝的真潜客，被他们公司的网关退订了，
//   然后进了我们的永久压制名单——我们再也不会联系他们。这是在静默丢管道。**
//
// 合规不受影响（这点必须写清楚，免得以后有人以为我们在绕退订）：
//   · RFC 8058 一键退订走的是 **POST /u/:token**（上面那条路由）+ 邮件头
//     `List-Unsubscribe-Post: List-Unsubscribe=One-Click`（send.ts）——
//     Gmail/Outlook 顶部那个"退订"按钮用的正是它，**扫描器不会 POST**，照常秒退。
//   · 邮件正文里的链接现在指向确认页，人点一下按钮即退订。这是行业标准做法。
app.get("/u/:token", async (c) => {
  const token = c.req.param("token");
  const brand = (await getSetting(c.env, "company_name", "AirSonde"))
    .replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[ch]!));
  // token 只回填进 form action，转义防注入（它来自 URL，一律当不可信输入）
  const safeToken = encodeURIComponent(token);
  const done = c.req.query("done") === "1";
  const lang = pickUnsubLang(c.req.query("lang") || "", c.req.header("accept-language") || "");
  const t = UNSUB_I18N[lang];
  // 自动识别可能猜错（企业邮箱常年 en 头）→ 给一排语言链接，让人自己切，别把人锁在看不懂的页面上
  const switcher = Object.keys(UNSUB_I18N)
    .map((k) => k === lang
      ? `<span style="color:#bbb">${k.toUpperCase()}</span>`
      : `<a href="/u/${safeToken}?lang=${k}${done ? "&done=1" : ""}" style="color:#999;text-decoration:none">${k.toUpperCase()}</a>`)
    .join(`<span style="color:#ddd">·</span>`);
  const body = done
    ? `<p style="font-size:16px;color:#444">${t.done}</p>`
    : `<p style="font-size:16px;color:#444">${t.lead}</p>
       <form method="POST" action="/u/${safeToken}?redirect=1&amp;lang=${lang}">
         <button type="submit" style="font:16px Arial,sans-serif;padding:10px 22px;border:0;border-radius:6px;background:#222;color:#fff;cursor:pointer">${t.btn}</button>
       </form>
       <p style="font-size:13px;color:#888;margin-top:18px">${t.oops}</p>`;
  return c.html(
    `<!doctype html><html lang="${lang}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
     <meta name="robots" content="noindex">
     <title>${brand}</title>
     <div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:80px auto;text-align:center;color:#222">
     <h2 style="font-size:20px;letter-spacing:.5px;margin:0 0 22px">${brand}</h2>${body}
     <div style="margin-top:34px;font-size:12px;display:flex;gap:8px;justify-content:center">${switcher}</div>
     </div></html>`
  );
});

// ---- P5 自动找客户：搜索发现 ----
app.post("/api/discover", async (c) => {
  const body = await jsonBody<{ keywords?: string[]; perKeyword?: number; countries?: string[] }>(c);
  try {
    // C5-11 B4：给这一轮打个标记，供 /api/discover/round-complete 判重与统计。
    //   ⚠️ **在 runDiscovery 之前写**：搜索途中若被预算闸提前停止，那些已入库的线索也算这一轮。
    //   ⚠️ round_at 用 datetime('now')（UTC，与 leads.created_at 同一口径）——
    //      拿 toISOString() 会带 T 和毫秒，和 created_at 的格式比大小会出错。
    const roundAt = (await c.env.DB.prepare("SELECT datetime('now') AS t").first<{ t: string }>())?.t || "";
    await setSetting(c.env, "discover_round_id", `${roundAt}#${Math.floor(Math.random() * 1e6)}`);
    await setSetting(c.env, "discover_round_at", roundAt);
    const out = await runDiscovery(c.env, body);
    return c.json(out);
  } catch (e: any) {
    return c.json({ error: e.message || String(e) }, 500);
  }
});

// ---- 批B 免费目录源：零 Serper 费。NMEA 单个 affcode（前端逐个调、间隔 10s 遵守 Crawl-delay）----
app.post("/api/discover/nmea", async (c) => {
  const b = await jsonBody<{ affcode?: string }>(c);
  try {
    const out = await runNmeaDiscovery(c.env, b.affcode || "Dealer");
    return c.json(out);
  } catch (e: any) {
    return c.json({ error: e.message || String(e) }, 500);
  }
});
// rvwithtito RV 离网/太阳能安装商名单（网页外链采集，黑名单第三方域）
app.post("/api/discover/rvwithtito", async (c) => {
  try {
    const out = await runLinkHarvest(c.env, RVWITHTITO_URL, "rvwithtito", RVWITHTITO_BLACKLIST);   // URL+黑名单单一真源，与 cron 自动刷新共用
    return c.json(out);
  } catch (e: any) {
    return c.json({ error: e.message || String(e) }, 500);
  }
});

// ---- 找客户配置：目标国家 + 每关键词条数（含可选国家清单 + 关键词，供前端一次拿全）----
app.get("/api/settings/search", async (c) => {
  const cfg = await getSearchConfig(c.env);
  const keywords = await getKeywords(c.env);
  // 已勾选国家：读原始 setting（区分"从未设过"=默认 vs "设为空"=全不选），保证 UI 忠实回显
  const scRaw = await getSetting(c.env, "search_countries", "__UNSET__");
  const countries = scRaw === "__UNSET__"
    ? DEFAULT_COUNTRIES.slice()
    : scRaw.split(",").map((s) => s.trim().toLowerCase()).filter((x) => COUNTRIES[x]);
  // 国家清单（显示为 chips，可增删）：未定制过 → 展示全部目录
  const clRaw = await getSetting(c.env, "country_list", "");
  let countryList = clRaw.split(",").map((s) => s.trim().toLowerCase()).filter((x) => COUNTRIES[x]);
  if (!countryList.length) countryList = Object.keys(COUNTRIES);
  for (const cc of countries) if (!countryList.includes(cc)) countryList.push(cc);  // 勾选项必在清单
  // 关键词勾选态（#45）：null=未定制→全部启用
  const akRaw = await getSetting(c.env, "active_keywords", "__UNSET__");
  const activeKeywords = akRaw === "__UNSET__" ? null
    : akRaw.split("\n").map((s) => s.trim()).filter(Boolean);
  return c.json({
    countries,                         // 已勾选国家（gl 代码）
    countryList,                       // #45 国家清单（chips）
    perKeyword: cfg.perKeyword,
    allCountries: COUNTRIES,           // { gl: 中文名 } 全目录（供"添加国家"下拉）
    keywords,                          // 生效关键词（用于透明度预估）
    activeKeywords,                    // #45 已勾选关键词（null=全部）
    discoveryEnabled: (await getSetting(c.env, "discovery_enabled", "0")) === "1",   // #S1 后台每6h自动搜索开关（默认关）
    // 批⑳ 机器状态卡：轮转游标（只读）。前端算分母 = keywords × allCountries（后台轮转恒用全量），
    //   与 discover.ts runDiscovery 的 totalC=combos.length 同口径。裸值即可，别在这里算 total（口径单源在轮转逻辑）。
    discoveryCursor: Number(await getSetting(c.env, "discovery_cursor", "0")) || 0,
    serper: await getSerperUsage(c.env),   // P0-c 今日 Serper 用量 + 预算
    backlog: await getBacklog(c.env),      // 批④：积压刹车条 —— 瓶颈不是线索不够，是管道里堵着
    // 队列⑦ 免费目录源每周自动刷新（零 Serper，默认开）
    dirAutoRefresh: (await getSetting(c.env, "directory_autorefresh_enabled", "1")) === "1",
    dirLastRefresh: await getSetting(c.env, "directory_last_refresh", ""),
  });
});
app.post("/api/settings/search", async (c) => {
  const b = await jsonBody<{ countries?: string[]; countryList?: string[]; activeKeywords?: string[] | null; perKeyword?: number; discoveryEnabled?: boolean; serperBudget?: number; dirAutoRefresh?: boolean }>(c);
  if (typeof b.discoveryEnabled === "boolean") {
    await setSetting(c.env, "discovery_enabled", b.discoveryEnabled ? "1" : "0");   // #S1 Joe 后台开关
  }
  if (typeof b.dirAutoRefresh === "boolean") {
    await setSetting(c.env, "directory_autorefresh_enabled", b.dirAutoRefresh ? "1" : "0");   // 队列⑦ 每周自动刷新目录（零 Serper，默认开）
  }
  if (b.serperBudget != null) {
    const bn = Number(b.serperBudget);   // 允许 0（完全暂停）；非法值回落到默认值
    await setSetting(c.env, "serper_daily_budget", String(Math.max(0, Math.min(2500, Number.isFinite(bn) ? bn : SERPER_DAILY_BUDGET_DEFAULT))));   // P0-c 今日 Serper 预算上限
  }
  if (Array.isArray(b.countryList)) {
    const validL = b.countryList.map((x: string) => String(x).trim().toLowerCase()).filter((x: string) => COUNTRIES[x]);
    await setSetting(c.env, "country_list", validL.join(","));    // #45 持久化国家清单（允许为空）
  }
  if (Array.isArray(b.countries)) {
    const valid = b.countries.map((x: string) => String(x).trim().toLowerCase()).filter((x: string) => COUNTRIES[x]);
    await setSetting(c.env, "search_countries", valid.join(","));  // 允许空（全不选）；cron 侧 getSearchConfig 仍有默认兜底
  }
  if (Array.isArray(b.activeKeywords)) {
    await setSetting(c.env, "active_keywords", b.activeKeywords.map((s) => String(s).trim()).filter(Boolean).join("\n"));  // #45 持久化关键词勾选态
  }
  if (b.perKeyword != null) {
    await setSetting(c.env, "search_per_keyword", String(Math.max(1, Math.min(100, Number(b.perKeyword) || 8))));   // #45 放开到 100
  }
  return c.json({ ok: true });
});

// ---- 关键词池管理 ----
app.get("/api/keywords", async (c) => {
  const rows = await c.env.DB.prepare("SELECT id, keyword, weight, sent_count, reply_count FROM keywords ORDER BY weight DESC, id ASC").all();
  const keywords = (rows.results as any[]).map((k) => ({
    ...k,
    reply_rate: k.sent_count > 0 ? k.reply_count / k.sent_count : null,  // 无发送则为 null（新词，无数据）
  }));
  return c.json({ keywords, effective: await getKeywords(c.env) });
});
// 手动重算关键词权重（回复率加权），供调试/立即优化
app.post("/api/keywords/recompute", async (c) => {
  const out = await recomputeKeywordStats(c.env);
  return c.json(out);
});
app.post("/api/keywords", async (c) => {
  const b = await jsonBody<{ keyword?: string; seedDefaults?: boolean }>(c);
  if (b.seedDefaults) { await seedDefaultKeywords(c.env); return c.json({ ok: true }); }
  const kw = (b.keyword || "").trim();
  if (!kw) return c.json({ error: "keyword 不能为空" }, 400);
  await c.env.DB.prepare("INSERT INTO keywords (keyword) VALUES (?) ON CONFLICT(keyword) DO NOTHING").bind(kw).run();
  return c.json({ ok: true });
});
app.delete("/api/keywords/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM keywords WHERE id=?").bind(Number(c.req.param("id"))).run();
  return c.json({ ok: true });
});

// ---- 邮箱发现：单条（useHunter=true 才允许调 Hunter 花积分，默认免费抓取）----
// 🔬 只读诊断：这个站的 8 个联系页路径**各自**发生了什么（HTTP 状态/字节/最终URL/耗时/有无邮箱）。
// 起因见 findemail.ts TIMEOUT 上方那段：A/B 证明放宽超时零改善，UA/跳转/提取逻辑也都排除了，
// 剩下的假设（站点拦截 CF Worker 数据中心 IP）**必须拿到每个路径的状态码才能证伪或坐实**。
// ⚠️ **只读**：不写库、不改 lead、不消耗任何付费额度（不碰 Hunter）。
// 🔬 决定性实验：**D1 调用到底吃不吃那 50 个子请求额度？**
//
// 为什么必须实测而不是信文档：文档说 Free 是「50 external + 1,000 to Cloudflare services」，
//   听起来 D1 走后者。**但那是文档，不是观测。** 而这个答案直接决定修法方向 ——
//   若 D1 也吃 50，那我们预算里最大的一块根本不是搜索/抓站，而是**数据库查询**，
//   那就是完全不同的一套改法。今天已经有两次按错假说动手的教训。
//
// 实验设计：**只发 D1、零对外 fetch**，跑 n 次（默认 60 > 50）。
//   · 跑完 → D1 **不吃** 那 50（与文档一致）
//   · 抛 `Too many subrequests` → D1 **吃**（文档口径与实际不符，以实际为准）
// ⚠️ 只读 SELECT，不写任何数据。
app.get("/api/diag/d1-subrequest-probe", async (c) => {
  const n = Math.max(1, Math.min(300, Number(c.req.query("n")) || 60));
  // ⚠️⚠️ C5-22 补：这道守卫原本**只有 socket 探针有，D1 探针没有** —— 于是它在本地也会
  //   一本正经地返回「D1 不吃那 50 个额度」。本地 miniflare **根本不执行子请求上限**
  //   （同 D1 绑定变量 100 上限那次：裸 SQLite 永不复现），跑满多少次都不证明任何事。
  //   这条结论已经在窗口之间被引用过一次 —— **一盏假绿灯比没有探针更危险**，因为它会
  //   被当成证据带进下一个架构决策。两个探针必须同一副判据。
  const localD1 = devGuardOn(c.env);
  const canFailD1 = !localD1 && n > 50;
  const noVerdictD1 = localD1
    ? "❌ 本地环境无效：miniflare 不执行子请求上限，跑满多少次都不证明任何事。**必须在生产上跑。**"
    : `❌ n=${n} ≤ 50，到不了那条线，跑满不证明任何事。用 n>50（默认 60）。`;
  let done = 0;
  try {
    for (let i = 0; i < n; i++) {
      await c.env.DB.prepare("SELECT 1 AS x").first();   // 最便宜的只读查询
      done++;
    }
    return c.json({
      requested: n, completed: done, threw: false,
      environment: localD1 ? "local(dev guard on)" : "production",
      verdict: !canFailD1 ? noVerdictD1
        : `跑满 ${n} 次未报错 → **D1 不吃那 50 个外部子请求额度**`,
    });
  } catch (e: any) {
    const msg = String(e?.message || e);
    return c.json({
      requested: n, completed: done, threw: true,
      errName: String(e?.name || ""), errMessage: msg.slice(0, 300),   // 原文，不转述
      verdict: /too many subrequests/i.test(msg)
        ? `第 ${done + 1} 次 D1 调用即撞上限 → **D1 也吃那个额度**`
        : "抛了别的错，见 errMessage（不是子请求上限）",
    });
  }
});

// 🔬 决定性实验：**TCP socket（cloudflare:sockets 的 connect()）吃不吃那 50 个子请求额度？**
//
// 为什么必须实测：官方文档把子请求定义成「Fetch API 发的 + 发给 R2/KV/D1 等 Cloudflare 服务的」，
//   而 `connect()` **只出现在「同时 6 个连接」那一节，没出现在子请求定义里**。
//   ——「文档没提」不等于「不算」。**从"没写"推出"没有"，是最容易翻车的一类推理。**
//   这个答案直接决定构成表上「收回复」那一格该填什么：
//     · 不吃 → IMAP 完全不参与那 50，那一格填 0 是**真的 0**
//     · 吃   → 每轮收回复先扣掉 N 个额度，后面的抓站预算要按这个重算
//
// 实验设计：**只开 socket、零 fetch、零 D1**，顺序连 n 次（默认 60 > 50），每次立刻关。
//   · 跑满 → socket **不吃**那 50
//   · 抛 `Too many subrequests` → **吃**，且能看出在第几次撞上
// ⚠️ 顺序连（不并发）—— 并发会先撞上「同时 6 个连接」那条限制，测成另一回事。
// ⚠️ 只建连接、不发任何数据、不读任何东西。默认目标是随便一个大站的 443，
//    **不要指向我们自己的 IMAP 服务器**：60 次连击可能触发对方风控，代价是收不到客户回信。
app.get("/api/diag/socket-subrequest-probe", async (c) => {
  const n = Math.max(1, Math.min(200, Number(c.req.query("n")) || 60));
  const host = (c.req.query("host") || "example.com").trim();
  const port = Math.max(1, Math.min(65535, Number(c.req.query("port")) || 443));
  // 本地会被出站闸门挡下（只准 localhost）——那是对的：这个实验**只有在生产上跑才算数**。
  try { assertEgressAllowed(c.env, host, "socket subrequest probe"); }
  catch (e: any) { return c.json({ blocked_by_dev_guard: true, note: "本地出站闸门挡下了，这个实验必须在生产上跑", errMessage: String(e?.message || e) }, 400); }

  // ⚠️⚠️ **不可能失败的环境里跑出的"通过"，不是证据。**
  //   本地 miniflare **根本不执行子请求上限**（同 D1 绑定变量 100 上限那次：裸 SQLite 永不复现）；
  //   n 小于 50 时也压根到不了那条线。这两种情况下必须**拒绝输出结论**，
  //   否则这个端点自己就成了一盏假绿灯 —— 那比没有探针更危险。
  const local = devGuardOn(c.env);
  const canFail = !local && n > 50;
  const noVerdict = local
    ? "❌ 本地环境无效：miniflare 不执行子请求上限，跑满多少次都不证明任何事。**必须在生产上跑。**"
    : `❌ n=${n} ≤ 50，到不了那条线，跑满不证明任何事。用 n>50（默认 60）。`;

  let done = 0;
  const t0 = Date.now();
  try {
    for (let i = 0; i < n; i++) {
      const s = connect({ hostname: host, port }, { secureTransport: "off", allowHalfOpen: false });
      await s.opened;          // 等真的连上，否则数的是"发起"不是"连接"
      await s.close();
      done++;
    }
    return c.json({
      target: `${host}:${port}`, requested: n, completed: done, threw: false, ms: Date.now() - t0,
      environment: local ? "local(dev guard on)" : "production",
      verdict: !canFail ? noVerdict
        : `顺序连满 ${n} 次未报错 → **TCP socket 不吃那 50 个外部子请求额度**（与文档口径一致）`,
    });
  } catch (e: any) {
    const msg = String(e?.message || e);
    return c.json({
      target: `${host}:${port}`, requested: n, completed: done, threw: true, ms: Date.now() - t0,
      environment: local ? "local(dev guard on)" : "production",
      errName: String(e?.name || ""), errMessage: msg.slice(0, 300),   // 原文，不转述
      verdict: /too many subrequests/i.test(msg)
        ? `第 ${done + 1} 次 connect 撞上限 → **socket 也吃那个额度**，收回复那一步必须计入预算`
        : "抛了别的错，见 errMessage（**不是**子请求上限 —— 可能是目标不可达/被拒，换 host 再试）",
    });
  }
});

// 🔬 决定性实验：**一次调用到底允许多少个对外 fetch？**
//
// 为什么非量不可：C5-22（每分钟 tick 的持续流水线）整套节奏 —— 每 tick 分析几条、发几封 ——
//   全部建在这一个数上。而目前手上唯一的依据是 `cron_subreq_last` 里的 `crossed_50_at≈53`，
//   那是**从计量器推出来的下限，不是那条线本身**：计量器自己写着
//   「redirect:follow 的一次调用只算 1，平台按每跳算 → 越线前偏小」。
//   ⇒ 真实额度只会 ≤53，不会 >53。**把架构押在一个推出来的数上，就是把它押在运气上。**
//
// 实验设计：顺序发 n 个**不跳转**的对外请求（`redirect:"manual"` 保证一次调用=一跳），
//   零 D1、零 socket，撞上限即停并报第几次撞的。
// ⚠️ 目标默认用 Cloudflare 自家的 `cdn-cgi/trace`（就是给诊断用的、几十字节），
//    不去连累任何第三方站点；顺序发不并发，避免撞上"同时 6 个连接"那条别的限制。
app.get("/api/diag/fetch-subrequest-probe", async (c) => {
  const n = Math.max(1, Math.min(200, Number(c.req.query("n")) || 80));
  const url = (c.req.query("url") || "https://cloudflare.com/cdn-cgi/trace").trim();
  let host = "";
  try { host = new URL(url).hostname; } catch { return c.json({ error: "url 不合法" }, 400); }
  try { assertEgressAllowed(c.env, host, "fetch subrequest probe"); }
  catch (e: any) { return c.json({ blocked_by_dev_guard: true, note: "本地出站闸门挡下了，这个实验必须在生产上跑", errMessage: String(e?.message || e) }, 400); }

  // 与另两个探针同一副判据：**不可能失败的环境里跑出的"通过"不是证据。**
  const local = devGuardOn(c.env);
  const canFail = !local && n > 50;
  const noVerdict = local
    ? "❌ 本地环境无效：miniflare 不执行子请求上限，跑满多少次都不证明任何事。**必须在生产上跑。**"
    : `❌ n=${n} ≤ 50，到不了那条线，跑满不证明任何事。用 n>50（默认 80）。`;

  let done = 0, statuses: number[] = [];
  const t0 = Date.now();
  try {
    for (let i = 0; i < n; i++) {
      // redirect:"manual" —— 不跟跳转，保证「我数的 1 次」就是「平台算的 1 次」。
      //   跟跳转的话平台按每跳计费，我数出来的就会比真实消耗少（那正是 crossed_50_at 偏小的原因）。
      const r = await fetch(url, { redirect: "manual", cf: { cacheTtl: 0 } as any });
      if (statuses.length < 3) statuses.push(r.status);
      done++;
    }
    return c.json({
      target: url, requested: n, completed: done, threw: false, ms: Date.now() - t0,
      environment: local ? "local(dev guard on)" : "production", sampleStatuses: statuses,
      verdict: !canFail ? noVerdict
        : `顺序发满 ${n} 次未报错 → **对外 fetch 额度 ≥ ${n}**（不是 50 档；再加大 n 继续逼近）`,
    });
  } catch (e: any) {
    const msg = String(e?.message || e);
    return c.json({
      target: url, requested: n, completed: done, threw: true, ms: Date.now() - t0,
      environment: local ? "local(dev guard on)" : "production", sampleStatuses: statuses,
      errName: String(e?.name || ""), errMessage: msg.slice(0, 300),   // 原文，不转述
      verdict: /too many subrequests/i.test(msg)
        ? `**第 ${done + 1} 次对外 fetch 撞上限 ⇒ 一次调用的对外额度 = ${done} 个。** 这是量出来的，不是推出来的。`
        : "抛了别的错，见 errMessage（**不是**子请求上限 —— 可能是目标不可达，换 url 再试）",
    });
  }
});

app.get("/api/leads/:id/find-email-diag", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "invalid id" }, 400);
  const lead = await c.env.DB.prepare("SELECT id, company_name, website, email FROM leads WHERE id=?")
    .bind(id).first<any>();
  if (!lead) return c.json({ error: "not found" }, 404);
  if (!lead.website) return c.json({ error: "该线索没有官网，无从抓起" }, 400);
  const d = await diagnoseSite(lead.website);
  const hit = d.probes.filter((p) => p.emails.length);
  return c.json({
    id, company_name: lead.company_name, website: lead.website, has_email: !!lead.email,
    origin: d.origin,
    // 一眼看清：8 个路径里几个 200、几个 4xx/5xx、几个连响应都没拿到
    summary: {
      ok: d.probes.filter((p) => p.why === "ok").length,
      http_not_ok: d.probes.filter((p) => p.why === "http-not-ok").length,
      // 与 cron 的分类**同一口径**：真超时(AbortError) 与 其它网络错 分开报
      timeout: d.probes.filter((p) => p.why === "timeout").length,
      network_error: d.probes.filter((p) => p.why === "network-error").length,
      not_html: d.probes.filter((p) => p.why === "not-html").length,
      pages_with_email: hit.length,
    },
    probes: d.probes,
  });
});

app.post("/api/leads/:id/find-email", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await jsonBody<{ useHunter?: boolean }>(c);
  const lead = await c.env.DB.prepare("SELECT * FROM leads WHERE id=?").bind(id).first<any>();
  if (!lead) return c.json({ error: "not found" }, 404);
  const r = await findLeadEmail(c.env, lead.website || "", !!body.useHunter);
  if (r.email) {
    await c.env.DB.prepare("UPDATE leads SET email=?, updated_at=datetime('now') WHERE id=?").bind(r.email, id).run();
  }
  return c.json({ id, ...r });
});

// ---- 邮箱发现：批量（给已分析但无邮箱的线索补邮箱）。默认免费抓取；useHunter=true 才对抓不到的走 Hunter ----
app.post("/api/emails/find-batch", async (c) => {
  const body = await jsonBody<{ limit?: number; useHunter?: boolean; ids?: number[] }>(c);
  const limit = Math.min(Math.max(Number(body.limit) || 10, 1), 30);
  const useHunter = !!body.useHunter;
  // A2：传 ids 只处理选中的（仍受原有 status='analyzed' + 缺邮箱 + 有官网 过滤 + limit 上限）；不传维持原行为
  const ids = Array.isArray(body.ids) ? [...new Set(body.ids.map(Number).filter(Number.isFinite))].slice(0, 500) : [];
  // ⚠️⚠️ 批⑲：这里原来只认 `status='analyzed'`。而「批量补邮箱」这次挪到了**待联系**格，
  //   那格的线索是 `approved`/`queued` —— 实测 `processed:0`，**按钮摆在那儿是个静默空操作**。
  //   （最讽刺的是：`approved` 且没邮箱的，正是**最该补邮箱**的一批 —— 已经决定要联系了却没联系方式。）
  //   → 放开到"在漏斗里、还没联系上"的那几个状态。这是本批**唯一动的 WHERE**，单独标出来不夹带。
  const base = "SELECT id, website FROM leads WHERE status IN ('analyzed','pending','approved','queued') AND (email IS NULL OR email='') AND website IS NOT NULL AND website!=''";
  const rows = ids.length
    ? await c.env.DB.prepare(`${base} AND id IN (${ids.map(() => "?").join(",")}) ORDER BY id ASC LIMIT ?`).bind(...ids, limit).all()
    : await c.env.DB.prepare(`${base} ORDER BY id ASC LIMIT ?`).bind(limit).all();
  const leads = rows.results as any[];
  const results = [];
  for (const lead of leads) {
    const r = await findLeadEmail(c.env, lead.website, useHunter);
    if (r.email) {
      await c.env.DB.prepare("UPDATE leads SET email=?, updated_at=datetime('now') WHERE id=?").bind(r.email, lead.id).run();
    }
    results.push({ id: lead.id, website: lead.website, email: r.email, source: r.source });
  }
  const found = results.filter((r) => r.email).length;
  const hunterUsed = results.filter((r) => r.source === "hunter").length;  // 实际花掉的 Hunter 积分数
  return c.json({ processed: results.length, found, hunterUsed, results });
});

// ---- Hunter 状态：是否启用 + 剩余额度 + 待补邮箱线索数（account 接口不耗额度）----
app.get("/api/hunter/status", async (c) => {
  const targetRow = await c.env.DB.prepare(
    // ⚠️ 必须和 find-batch 的 base WHERE **逐字一致**，否则「待补邮箱 N 条」和实际能补的条数
    //    会是两个数（两个真源 = 下一次"格子在说谎"）。批⑲ 一起放开到 approved/queued。
    "SELECT COUNT(*) AS n FROM leads WHERE status IN ('analyzed','pending','approved','queued') AND (email IS NULL OR email='') AND website IS NOT NULL AND website!=''"
  ).first<{ n: number }>();
  const targets = targetRow?.n || 0;
  if (!c.env.EMAIL_FINDER_API_KEY) return c.json({ enabled: false, targets });
  try {
    // #45：key 走 Authorization 头、不进 query（防 key 落进 URL 访问日志）
    const res = await fetch(`https://api.hunter.io/v2/account`, { headers: { authorization: `Bearer ${c.env.EMAIL_FINDER_API_KEY}` } });
    const d: any = await res.json();
    const s = d?.data?.requests?.searches || {};
    return c.json({ enabled: true, targets, used: s.used ?? null, available: s.available ?? null });
  } catch (e: any) {
    return c.json({ enabled: true, targets, error: e.message || String(e) });
  }
});

// ---- 飞书通知设置 ----
app.get("/api/settings/notify", async (c) => {
  // notify_high_score_min 已删（两档制）：它只喂简报的「高分客户」清单，而那个清单已经删了 ——
  // 自动通道下"新出现一家 85 分"＝机器已经把信发出去了，列给 Joe 看没有动作含义。
  return c.json({
    configured: larkConfigured(c.env),        // 是否已配 webhook（**唯一真源 = env secret**，全仓没有 settings 源）
    // ⭐ 形状诊断：区分「根本没配」与「配了但值粘歪了」。只报布尔，**绝不报值**。
    urlShape: larkUrlShape(c.env),
    hasSecret: !!c.env.LARK_WEBHOOK_SECRET,
    enabled: (await getSetting(c.env, "notify_enabled", "1")) !== "0",
  });
});
app.post("/api/settings/notify", async (c) => {
  const b = await jsonBody<{ enabled?: boolean }>(c);
  if (b.enabled != null) await setSetting(c.env, "notify_enabled", b.enabled ? "1" : "0");
  return c.json({ ok: true });
});
// ---- 飞书通知：发测试卡片 ----
// ⛔ M13（安全审计）：原来这里回显 `LARK_WEBHOOK_URL` 的前 32 字符 —— **一个 webhook URL 的前缀
//   足以定位到具体应用**。已删除。
//   ⚠️ 但那个字段有个真实用途：确认"本地进程指向的是 sink 不是 Joe 的真群"（③ 号事故就是这么发生的）。
//   所以换成**一个布尔**：只回答"是不是指向本地 sink"，信息量从 32 字符降到 1 bit，
//   既留住那个安全用途，又不泄露任何可定位的东西。
// ---- 点火状态：这台机器插上电没有 ----------------------------------------
// ⭐ C2-C：一处真源（ignition.ts）供三方共用 —— 告警要不要吼、面板怎么显示、_whoami 报什么。
//   ⚠️ 只报**钥匙名**，绝不报值（`_whoami` 类端点的老规矩）。
app.get("/api/ignition", (c) => c.json(ignitionReport(c.env)));

// C6/Y5：每个 isolate 启动时生成一次的短 id。
// ⚠️ 它回答的是一个**别的字段都答不了**的问题：「我现在打到的，是不是我刚部署的那个进程？」
//   这台机器上真发生过：8788 端口答话的是**另一个窗**的 worker，而仓名字段"看着也对"。
//   boot id 变了 = 换进程了；没变 = 还是老的那个。
// 🔴 必须**惰性生成**：Workers 禁止在全局作用域产生随机值
//   （`Disallowed operation called within global scope … generating random values`）。
//   我第一版写成模块顶层的 `const BOOT_ID = crypto.randomUUID()` ⇒ **worker 整个起不来**，
//   而 `tsc` 与 `wrangler deploy --dry-run` **都是绿的** —— 这正是本仓那条铁律的由来：
//   **动完 .ts 必须真起一次 dev 确认 boot，不认 dry-run 的绿灯。**
let _bootId = "";
function bootId(): string {
  if (!_bootId) _bootId = crypto.randomUUID().slice(0, 8);   // 首次请求时才生成 = 在 handler 里
  return _bootId;
}

app.get("/api/_whoami", (c) => c.json({
  // C1 进程身份（验收判据）：repo/db 与 wrangler.jsonc 同一次部署单元，改绑定必改这里。
  repo: "airsonde-crm",
  db: "airsonde_crm",
  bootId: bootId(),
  marker: BUILD_MARKER,
  guard: devGuardOn(c.env),
  // 能力面全部只报有无（布尔），绝不报值。C1 锁死态：以下应全为 false。
  canSend: !!c.env.RESEND_API_KEY,
  canNotifyWebhook: !!c.env.LARK_WEBHOOK_URL,
  canNotifyAppBot: !!(c.env.LARK_APP_ID && c.env.LARK_APP_SECRET),
  canImap: !!c.env.LARK_IMAP_PASS,
  canSearch: !!c.env.SEARCH_API_KEY,
  canAi: !!c.env.OPENROUTER_API_KEY,
  // 官网询盘机器通道：false = 带 token 来的一律 503（fail-closed），浏览器直投路径不受影响
  canAcceptWebInquiry: !!c.env.INBOUND_TOKEN,
  larkIsLocalSink: /^https?:\/\/(localhost|127\.0\.0\.1)\b/i.test(String(c.env.LARK_WEBHOOK_URL || "")),
}));

app.post("/api/notify/test", async (c) => {
  // 批㉔：双发 —— 老 webhook 照发（并行不删）；应用机器人配好后加发一张**带回调测试按钮**的卡。
  const appUrl = c.env.ADMIN_URL || c.env.APP_URL;
  const webhook = larkConfigured(c.env)
    ? await larkSend(c.env, testCard(appUrl))
    : { ok: false, error: "未配置 LARK_WEBHOOK_URL" };
  const appBot = await sendAppCard(c.env, testAppCard(appUrl));
  const ok = webhook.ok || appBot.ok;
  // ⭐ 顶层 `error` 是补的：原来只返回 {ok, webhook, appBot}，而前端读 `res.error` ⇒
  //   永远显示「失败:」后面空白。**原因一直在响应里，只是没人读得到** ——
  //   任何失败都必须给得出人话原因，这是服务端这一侧的保证，不能只靠前端会不会挖。
  //   ⚠️ 「未配置」不进 error（C2-C 点火语义：没点火不是故障）。
  const reasons = [
    !webhook.ok && webhook.error && !/未配置/.test(webhook.error) ? `群机器人 webhook：${webhook.error}` : null,
    !appBot.ok && appBot.error && !/未配置/.test(appBot.error) ? `应用机器人：${appBot.error}` : null,
  ].filter(Boolean);
  const notIgnited = [
    !webhook.ok && /未配置/.test(String(webhook.error || "")) ? "LARK_WEBHOOK_URL" : null,
    !appBot.ok && /未配置/.test(String(appBot.error || "")) ? "LARK_APP_ID/SECRET" : null,
  ].filter(Boolean);
  // ⭐ 「配了但用不了」必须与「没配」分开报：secret 存在却不匹配 http(s):// ⇒ 多半是粘贴时带了
  //   空白/引号/换行。这种情况报"还没配"会把人送去重配一遍一模一样的值。
  const shape = larkUrlShape(c.env);
  const shapeHint = (!webhook.ok && shape.present && !shape.usable)
    ? `LARK_WEBHOOK_URL 已配置但**不是一个可用的 http(s) 地址**（scheme=${shape.scheme}）—— 多半是粘贴时带了空格/引号/换行，请重新 wrangler secret put 一次`
    : undefined;
  return c.json({
    ok, webhook, appBot, urlShape: shape,
    error: ok ? undefined : ([shapeHint, ...reasons].filter(Boolean).join("；") || undefined),
    notIgnited: ok ? undefined : (notIgnited.length ? notIgnited : undefined),
  }, ok ? 200 : 500);
});

// ---- Resend 退信/投诉 webhook（公开，Svix 签名校验）----
app.post("/api/webhooks/resend", async (c) => {
  const raw = await c.req.text();
  const ok = await verifyResendSignature(c.env, c.req.raw, raw);
  if (!ok) return c.json({ error: "invalid signature" }, 401);
  let event: any;
  try { event = JSON.parse(raw); } catch { return c.json({ error: "bad json" }, 400); }
  const r = await handleResendEvent(c.env, event);
  return c.json(r);
});

// ---- 批㉔：飞书卡片按钮回调（card.action.trigger）----
// 公开路径（/api/webhooks/ 已在 auth 豁免清单），校验照 Resend M4 标准 fail-closed：
//   未配 LARK_VERIFICATION_TOKEN → 503 拒收；encrypt 模式 → 400 明确拒绝；token 不符 → 401。
// 动作只有两个 + 测试哨兵，全部走现有内部函数（护栏一条不绕）：
//   talk   → setLeadStatusGuarded(id,'replied')（=后台「标记洽谈中/他回了」同一条路，M3 终态照拦）
//   follow → 写 next_action/next_action_date（=后台「下一步」端点同一逻辑），跟进日=明天
//   ping   → 测试按钮（id=0 哨兵，不碰任何线索）
// ⚠️ 批㉖L2 修订：发送类动作**上卡了**（Joe 拍板卡内完成回信）——但双闸一条不少：状态闸+isEmailSuppressed。
app.post("/api/webhooks/lark-card", async (c) => {
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: "bad json" }, 400); }
  const v = verifyLarkCallback(c.env, body);
  if (!v.ok) return c.json({ error: v.error }, v.status as any);
  // 事件订阅地址校验（url_verification）：token 已验过才回 challenge
  if (body.type === "url_verification") return c.json({ challenge: body.challenge });

  // 兼容 v2 事件封装（body.event.action）与旧版卡片回调（body.action）
  const action = body?.event?.action || body?.action || {};
  const val = typeof action.value === "string" ? (() => { try { return JSON.parse(action.value); } catch { return {}; } })() : (action.value || {});
  const a = String(val.a || "");
  const id = Number(val.id);
  const operator = String(body?.event?.operator?.open_id || body?.open_id || "").slice(-6);
  const now = new Date().toISOString().slice(0, 16).replace("T", " ");
  const appUrl = c.env.ADMIN_URL || c.env.APP_URL;
  const respond = (title: string, company: string, detail: string, leadId?: number) =>
    c.json({ toast: { type: "success", content: "已处理" }, card: { type: "raw", data: doneCard({ title, company, detail, appUrl, leadId }) } });

  if (a === "ping") {
    return respond("🧪 回调链路测试通过", "", `✅ 已处理 · ${now} UTC · 操作人 …${operator || "?"}\n（测试按钮，未触碰任何线索）`);
  }
  if (!Number.isFinite(id) || id <= 0) return c.json({ error: "bad lead id" }, 400);
  const lead = await c.env.DB.prepare("SELECT company_name FROM leads WHERE id=?").bind(id).first<{ company_name: string }>();
  if (!lead) return c.json({ error: "lead not found" }, 404);

  if (a === "talk") {
    const r = await setLeadStatusGuarded(c.env, id, "replied");
    if (r.error) return c.json({ toast: { type: "error", content: r.error.slice(0, 60) } });
    return respond("✅ 已标记洽谈中", lead.company_name || `#${id}`, `✅ 已处理 · ${now} UTC · 操作人 …${operator || "?"}`, id);
  }
  if (a === "follow") {
    // 与 /api/leads/:id/next-action 同逻辑：明天跟进（卡片上没有日期选择器，固定 +1 天；要改日期去后台）
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    await c.env.DB.prepare(
      "UPDATE leads SET next_action=?, next_action_date=?, updated_at=datetime('now') WHERE id=?"
    ).bind("飞书卡片：安排跟进", tomorrow, id).run();
    return respond("📅 已安排跟进", lead.company_name || `#${id}`, `跟进日 ${tomorrow}\n✅ 已处理 · ${now} UTC · 操作人 …${operator || "?"}`, id);
  }

  // ---- L2 回复工作台三动作（rsend/rignore/rblack）。发送类上卡=Joe 拍板,推翻批㉔旧规——
  //      双闸照过：①状态闸（压制/终态拦） ②deliverEmail 内 isEmailSuppressed 终极闸。 ----
  if (a === "rsend" || a === "rignore" || a === "rblack") {
    const rid = Number(val.rid);
    const reply = Number.isFinite(rid) && rid > 0
      ? await c.env.DB.prepare("SELECT id, lead_id, from_email, subject FROM replies WHERE id=?").bind(rid).first<any>()
      : null;
    if (!reply || Number(reply.lead_id) !== id) return c.json({ toast: { type: "error", content: "回复记录不存在或与线索不匹配" } });
    const v2respond = (title: string, detail: string, tpl: "green" | "red" | "grey" = "grey") =>
      c.json({ toast: { type: "success", content: "已处理" }, card: { type: "raw", data: replyDoneCardV2(title, detail, tpl) } });

    if (a === "rignore") {
      const r = await setLeadStatusGuarded(c.env, id, "ignored");
      if (r.error) return c.json({ toast: { type: "error", content: r.error.slice(0, 60) } });
      return v2respond("已忽略", `**${lead.company_name || `#${id}`}**\n该回复已忽略,线索转「已忽略」。\n✅ ${now} UTC · 操作人 …${operator || "?"}`);
    }
    if (a === "rblack") {
      const r = await setLeadStatusGuarded(c.env, id, "blacklisted");   // 内部会把 lead.email 写入压制名单
      if (r.error) return c.json({ toast: { type: "error", content: r.error.slice(0, 60) } });
      await addSuppressedEmail(c.env, reply.from_email, "card:rblack");  // 回信地址可能≠lead.email,双双压制
      return v2respond("🚫 已转黑名单", `**${lead.company_name || `#${id}`}**\n线索与回信地址均已进压制名单,永不再发。\n✅ ${now} UTC · 操作人 …${operator || "?"}`, "red");
    }

    // a === "rsend" —— 发送回信
    const leadFull = await c.env.DB.prepare("SELECT * FROM leads WHERE id=?").bind(id).first<any>();
    if (!leadFull) return c.json({ toast: { type: "error", content: "线索不存在" } });
    // 双闸①状态闸（后台 /api/leads/:id/email 同口径的压制/终态集合）
    if (["unsubscribed", "blacklisted", "bounced", "ignored"].includes(String(leadFull.status)))
      return c.json({ toast: { type: "error", content: `线索处于「${leadFull.status}」压制/终态,已拦下不发` } });
    if (await isEmailSuppressed(c.env, reply.from_email))
      return c.json({ toast: { type: "error", content: "该邮箱在压制名单,已拦下不发" } });
    // 批㉙③：2.0 表单真实回传形状防御——读不到 form_value 时把 action 原样吼进日志（生产第一条即校准）
    const formVal = (action.form_value || (action as any).form_data || {}) as Record<string, string>;
    if (!("reply_body" in formVal)) console.error("rsend form_value 缺失,action 形状:", JSON.stringify(action).slice(0, 400));
    const bodyText = String(formVal.reply_body || "").trim();
    if (!bodyText) return c.json({ toast: { type: "error", content: "回信正文是空的" } });
    if (bodyText.length > 8000) return c.json({ toast: { type: "error", content: "正文超 8000 字上限,请精简" } });
    // 3 秒窗铁律：Resend 发送可能超窗 → 先回 toast「发送中」,后台发完 PATCH 卡片为结果卡（规格③）。
    const msgId = String(body?.event?.context?.open_message_id || body?.open_message_id || "");
    const company = lead.company_name || `#${id}`;
    c.executionCtx.waitUntil((async () => {
      try {
        const subj0 = String(reply.subject || "").trim();
        const subject = subj0 ? (/^re\s*:/i.test(subj0) ? subj0 : `Re: ${subj0}`) : "Re: your inquiry";
        // 收件人=回复的 from_email（可能≠lead.email）→ 覆写后交 deliverEmail,内部终极闸照过
        const out = await deliverEmail(c.env, { ...leadFull, email: reply.from_email }, subject, bodyText, "reply");
        const ok = !!out.ok;
        const detail = ok
          ? `**${company}**\n回信已经 Resend 发出 → ${reply.from_email}\n✅ ${now} UTC · 操作人 …${operator || "?"}`
          : `**${company}**\n发送被拦/失败：${out.skipped || out.error || "未知原因"}\n（正文没丢,去后台该线索重试）`;
        await patchCardMessage(c.env, msgId, replyDoneCardV2(ok ? "✅ 回信已发送" : "❌ 回信未发出", detail, ok ? "green" : "red"));
      } catch (e: any) {
        console.error("rsend async:", e?.message || e);
        await patchCardMessage(c.env, msgId, replyDoneCardV2("❌ 回信未发出", `**${company}**\n发送异常：${String(e?.message || e).slice(0, 200)}\n（正文没丢,去后台该线索重试）`, "red"));
      }
    })());
    return c.json({ toast: { type: "info", content: "发送中…结果会更新在这张卡片上" } });
  }
  return c.json({ error: "unknown action" }, 400);
});

// 批㉔ Lark 应用配置（chat_id / 多维表格 token；受登录保护的常规路径）
app.get("/api/settings/lark", async (c) => {
  return c.json({
    appConfigured: larkAppConfigured(c.env),
    chatId: await getSetting(c.env, "lark_chat_id", ""),
    bitableAppToken: await getSetting(c.env, "lark_bitable_app_token", ""),
    bitableTableId: await getSetting(c.env, "lark_bitable_table_id", ""),
    lastSync: await getSetting(c.env, "lark_bitable_last_sync", ""),
  });
});
app.post("/api/settings/lark", async (c) => {
  const b = await jsonBody<{ chatId?: string; bitableAppToken?: string; bitableTableId?: string }>(c);
  if (typeof b.chatId === "string") await setSetting(c.env, "lark_chat_id", b.chatId.trim());
  if (typeof b.bitableAppToken === "string") await setSetting(c.env, "lark_bitable_app_token", b.bitableAppToken.trim());
  if (typeof b.bitableTableId === "string") await setSetting(c.env, "lark_bitable_table_id", b.bitableTableId.trim());
  return c.json({ ok: true });
});
// 手动触发一次镜像同步（联调/追平用；cron 每小时也会跑）
app.post("/api/lark/sync-now", async (c) => c.json(await syncLeadsToBitable(c.env)));
// 批㉙：工作台卡结构预览（dry,不推送）——总工过 JSON 形状/排版复核用,replyId 取真回复拼真卡。
app.get("/api/lark/workbench-preview/:replyId", async (c) => {
  const rid = Number(c.req.param("replyId"));
  const reply = await c.env.DB.prepare(
    `SELECT r.id, r.lead_id, r.from_email, r.subject, r.content, r.summary, r.category, l.company_name
       FROM replies r LEFT JOIN leads l ON l.id = r.lead_id WHERE r.id = ?`).bind(rid).first<any>();
  if (!reply) return c.json({ error: "reply not found" }, 404);
  return c.json(replyWorkbenchCard({
    leadId: Number(reply.lead_id) || 0, replyId: reply.id, company: reply.company_name || reply.from_email,
    from: reply.from_email, category: reply.category, summary: reply.summary,
    snippet: reply.content || "", draft: "(预览占位——真卡此处为 AI 草稿)", appUrl: c.env.ADMIN_URL || c.env.APP_URL,
  }));
});
// L1-B3：Basic API 月用量（免费版 1万/月；≥8000 飞书吼一次/月）。计数在 larkApi 单一咽喉自增。
app.get("/api/lark/usage", async (c) => {
  const month = new Date().toISOString().slice(0, 7);
  const used = Number(await getSetting(c.env, `lark_api_used_${month}`, "0")) || 0;
  return c.json({ month, used, threshold: 8000, limit: 10000,
    alerted: (await getSetting(c.env, "lark_api_alert_month", "")) === month });
});
// 列名对账器（联调第一步必跑；上线后可随时复核）——读表 schema 非数据，不违反单向只写
app.get("/api/lark/bitable-fields", async (c) => {
  try { return c.json(await bitableFieldsCheck(c.env)); }
  catch (e: any) { return c.json({ error: e.message || String(e) }, 500); }
});

// ---- 批⑧：回复匹配自测（不碰 IMAP）----
// 匹配逻辑是这条链上最容易悄悄坏掉的一环（坏了的表现就是"什么都没发生"，跟"没人回信"长得一样）。
// 给它一个不依赖真邮箱、可反复跑的入口：传 from/inReplyTo，看它匹到谁、走的哪一层。
app.post("/api/replies/match-test", async (c) => {
  const b = await jsonBody<{ from?: string; inReplyTo?: string; references?: string[] }>(c);
  const m = await matchReplyToLead(
    c.env, String(b.from || "").toLowerCase().trim(),
    String(b.inReplyTo || ""), Array.isArray(b.references) ? b.references : [],
  );
  return c.json(m);
});

// ---- P4 回复处理：手动拉取新回复 ----
app.post("/api/replies/fetch", async (c) => {
  const out = await ingestReplies(c.env);
  return c.json(out, out.error ? 500 : 200);
});

// ---- 阶段三.2 给某条回复 AI 起草回复（供人工审核后发送）----
app.post("/api/replies/:id/draft", async (c) => {
  const id = Number(c.req.param("id"));
  const reply = await c.env.DB.prepare(
    `SELECT r.id, r.lead_id, r.from_email, r.subject, r.content, l.company_name
       FROM replies r LEFT JOIN leads l ON l.id = r.lead_id WHERE r.id = ?`
  ).bind(id).first<any>();
  if (!reply) return c.json({ error: "not found" }, 404);
  // ⭐ C5-1 发现并修：AI 未点火时这里原来抛进 catch → **500 + 红色"起草失败"**。
  //   那违反 C2-C 那条规则（未配置 ≠ 故障），而回信详情现在**内嵌在「今天」页**里 ——
  //   等于每天在 Joe 的主页面上摆一条永远治不好的红字。**200 + 说清差什么**，让前端用中性文案。
  if (!isIgnited(c.env, "ai")) {
    return c.json({ ok: false, notIgnited: true, error: notIgnitedReason(c.env, "ai") });
  }
  const profile = await getProfile(c.env);
  let original = "";
  if (reply.lead_id) {
    const a = await c.env.DB.prepare("SELECT recommended_email FROM lead_analysis WHERE lead_id = ?").bind(reply.lead_id).first<{ recommended_email: string }>();
    original = a?.recommended_email || "";
  }
  try {
    const brand = reply.lead_id ? await brandForLead(c.env, { id: reply.lead_id }, "reply") : "AirSonde";
    const draft = await writeReplyDraft(c.env, brand, reply.company_name || reply.from_email || "", profile, original, reply.content || "");
    return c.json({ ok: true, draft });
  } catch (e: any) {
    return c.json({ error: e.message || String(e) }, 500);
  }
});

// ---- 回复列表 ----
app.get("/api/replies", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT r.id, r.lead_id, r.from_email, r.subject, r.summary, r.category, r.content, r.received_at,
            l.company_name, l.website
     FROM replies r LEFT JOIN leads l ON l.id = r.lead_id
     ORDER BY r.id DESC LIMIT 200`
  ).all();
  return c.json({ replies: rows.results });
});

// ============ #37 回复箱 ============
// 病根（库里的铁证，不是推测）：`replies` 里 #4/#5 两条的正文原文就是
//   「（在 邮件 上回复了，由人工标记）」—— **Joe 已经在自己邮箱里回信、回来打卡记账**。
//   系统在整条链上最值钱的一环（回复）事实上已被绕过。
// 原因：旧「已回复」页是**线索列表**（一行一个公司、只挂一条最新摘要），回一封信要 9 步、
//   第 8 步离开系统去邮箱粘贴；而且弹窗只给 AI 摘要，**看不到客户原话、更看不到我们上一封发了什么**
//   （#10 客户原话是 "number 8 we would be interested in." —— 没有原信根本读不懂）。
//
// ---- 列表：一行一封回复（不是一行一个线索）+ 四分组 ----
app.get("/api/replies/inbox", async (c) => {
  await ensureReplyColumns(c.env);
  const want = String(c.req.query("tab") || "pending") as InboxTab;
  // 一次取回全量（当前生产 15 封，200 上限有充足余量），分组在服务端算 ——
  // 分组要用到 raw_headers（噪音判定），不适合让前端拿着全量头自己判。
  const rows = (await c.env.DB.prepare(
    `SELECT r.id, r.lead_id, r.category, r.content, r.summary, r.from_email, r.subject,
            r.received_at, r.raw_headers, r.handled_at, l.company_name
       FROM replies r LEFT JOIN leads l ON l.id = r.lead_id
      ORDER BY r.id DESC LIMIT 200`
  ).all()).results as any[];

  const counts: Record<string, number> = { pending: 0, declined: 0, noise: 0, orphan: 0 };
  const items: any[] = [];
  // ⚠️⚠️ C5-8：**一个谓词，两处共用**。
  //   缺陷原文：`counts` 排除了已处理的（`!(tab==="pending" && r.handled_at)`），
  //   而 `items.push` 只判了 `tab !== want` —— 于是已处理的回信**仍出现在待处理列表里**，
  //   角标数字却不算它：列表和数字对不上，而两边单看都"合理"。
  //   ⇒ 抽成一个函数，两处都调它。写成两份、靠人去同步，正是这次缺陷的成因；
  //     "改完此刻碰巧一致"不算修好。
  const stillNeedsYou = (r: any, tab: string) => !(tab === "pending" && r.handled_at);
  for (const r of rows) {
    const tab = tabOf(r);
    if (stillNeedsYou(r, tab)) counts[tab]++;
    if (tab !== want || !stillNeedsYou(r, tab)) continue;
    items.push({
      id: r.id, lead_id: r.lead_id, company_name: r.company_name,
      category: r.category, from_email: r.from_email, subject: r.subject,
      received_at: r.received_at, handled_at: r.handled_at,
      summary: r.summary,
      // ⚠️ 预览必须**先剥引用再截断**：直接截原文会截出我们自己发出去的信（#13 正文 1105 字符
      //    里真内容只有 "Yes, I would be interested."）。
      preview: previewOf(r.content || ""),
    });
  }
  return c.json({ tab: want, counts, items });
});

// ---- 详情：客户原话（剥引用）+ **我们上一封发出去的原信** ----
// 后者是 #10 那类回复的唯一解读依据（"number 8 we would be interested in."）。
app.get("/api/replies/:id/context", async (c) => {
  await ensureReplyColumns(c.env);
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "invalid id" }, 400);
  const r = await c.env.DB.prepare(
    `SELECT r.*, l.company_name, l.website, l.status AS lead_status
       FROM replies r LEFT JOIN leads l ON l.id = r.lead_id WHERE r.id = ?`
  ).bind(id).first<any>();
  if (!r) return c.json({ error: "回复不存在" }, 404);
  // 我们发给这个线索的最后一封（回复正是对它的回应）
  const ours = r.lead_id ? await c.env.DB.prepare(
    `SELECT subject, body, sent_at, kind FROM emails
      WHERE lead_id = ? AND status='sent' ORDER BY id DESC LIMIT 1`
  ).bind(r.lead_id).first<any>() : null;
  return c.json({
    id: r.id, lead_id: r.lead_id, company_name: r.company_name, lead_status: r.lead_status,
    category: r.category, summary: r.summary, from_email: r.from_email, subject: r.subject,
    received_at: r.received_at, handled_at: r.handled_at, draft: r.draft || "",
    clean: stripQuoted(r.content || ""),     // 客户这次真正写的话
    raw: r.content || "",                     // 全文（含引用），前端折叠给"展开看全文"
    is_noise: isNoiseReply(r),
    ours: ours ? { subject: ours.subject, body: ours.body, sent_at: ours.sent_at, kind: ours.kind } : null,
  });
});

// ---- 存草稿（人工编辑后）----
// 旧行为：AI 草稿只在弹窗里出现一次，关掉即丢，下次要再等 10-20 秒重烧。
app.post("/api/replies/:id/draft-save", async (c) => {
  await ensureReplyColumns(c.env);
  const id = Number(c.req.param("id"));
  const b = await jsonBody<{ draft?: string }>(c);
  if (!Number.isFinite(id)) return c.json({ error: "invalid id" }, 400);
  await c.env.DB.prepare("UPDATE replies SET draft=? WHERE id=?")
    .bind(String(b.draft || "").slice(0, 8000), id).run();
  return c.json({ ok: true });
});

// ---- 标记已处理 ----
// 这是这版的**核心价值**：把"复制草稿"和"记录已回复"合成一步，直接消灭
// #4/#5 那种「去邮箱发完 → 回来手工补一条『（在邮件上回复了，由人工标记）』」。
// ⚠️ 不碰跟进逻辑：实测已确认"客户回信后我们不会再催"（回信入库即把 lead 推成 replied，
//    而 sendFollowupBatch 要求 status='sent' → 结构上已排除；生产查证：回信后再发过信的线索 = 0 条）。
app.post("/api/replies/:id/handled", async (c) => {
  await ensureReplyColumns(c.env);
  const id = Number(c.req.param("id"));
  const b = await jsonBody<{ undo?: boolean }>(c);
  if (!Number.isFinite(id)) return c.json({ error: "invalid id" }, 400);
  await c.env.DB.prepare(
    b.undo ? "UPDATE replies SET handled_at=NULL WHERE id=?"
           : "UPDATE replies SET handled_at=datetime('now') WHERE id=?"
  ).bind(id).run();
  return c.json({ ok: true, handled: !b.undo });
});

// ---- 批⑧ Bug2 第三条：孤儿回复（匹配不上任何线索）----
// 为什么必须单开一个接口：「已回复」页的数据源是 `/api/leads?group=replied`，**每行一个线索**。
// 孤儿回复根本没有线索 → 它在那个页面上**永远不可能出现**。这就是"入库就沉底"的机制。
app.get("/api/replies/orphans", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT id, from_email, subject, summary, category, content, received_at
       FROM replies WHERE lead_id IS NULL ORDER BY id DESC LIMIT 50`
  ).all();
  return c.json({ orphans: rows.results });
});

// 人工把一条孤儿回复挂到某条线索上 —— 三层匹配也有兜不住的时候（换域名回、私人邮箱回），
// 那时得有人能一键接上，而不是只能干看着。
app.post("/api/replies/:id/link", async (c) => {
  const id = Number(c.req.param("id"));
  const b = await jsonBody<{ lead_id?: number }>(c);
  const leadId = Number(b.lead_id);
  if (!id || !leadId) return c.json({ error: "缺少 reply id 或 lead_id" }, 400);
  const lead = await c.env.DB.prepare("SELECT id, company_name, status FROM leads WHERE id = ?")
    .bind(leadId).first<{ id: number; company_name: string; status: string }>();
  if (!lead) return c.json({ error: `线索 #${leadId} 不存在` }, 404);
  const reply = await c.env.DB.prepare("SELECT id, lead_id, from_email, category FROM replies WHERE id = ?")
    .bind(id).first<{ id: number; lead_id: number | null; from_email: string; category: string }>();
  if (!reply) return c.json({ error: "回复不存在" }, 404);
  if (reply.lead_id) return c.json({ error: `这条回复已经挂在线索 #${reply.lead_id} 上了` }, 400);

  await c.env.DB.prepare("UPDATE replies SET lead_id = ? WHERE id = ?").bind(leadId, id).run();
  // 推进状态用**和自动匹配完全一样的那两行**（replies.ts:199-200 照抄，含投诉→黑名单这条分支）——
  // 人工救回来的和自动匹配上的必须长得一样，否则会出现"两套语义"。
  const newStatus = reply.category === "complaint" ? "blacklisted" : "replied";
  await c.env.DB.prepare("UPDATE leads SET status=?, updated_at=datetime('now') WHERE id=?")
    .bind(newStatus, leadId).run();
  return c.json({ ok: true, lead_id: leadId, company_name: lead.company_name, status: newStatus });
});

// ---- Landing 落地页（公开）----
app.get("/catalog", (c) => c.html(catalogHtml()));

// ---- Landing 询盘写端点（公开）：honeypot + 频率限制 + 校验 + 去重 upsert + 推飞书 + 确认邮件 ----
// #inbound CORS：官网产品详情页跨源 POST 询盘（airsonde.com 与公开 API 域不同源）。
//   allowlist 回显 origin（不开 `*`）：airsonde.com / www + *.pages.dev(Pages 预览)。CORS 只管浏览器同源策略，
//   非浏览器客户端本就不受限——真正的防刷仍是下面的 throttle + honeypot + 压制名单。
function inboundCorsOrigin(origin: string): string | null {
  const o = (origin || "").trim();
  if (o === "https://airsonde.com" || o === "https://www.airsonde.com") return o;
  if (/^https:\/\/[a-z0-9-]+\.pages\.dev$/i.test(o)) return o;   // Pages 预览
  return null;
}
function setInboundCors(c: any): void {
  const allow = inboundCorsOrigin(c.req.header("origin") || "");
  if (!allow) return;
  c.header("Access-Control-Allow-Origin", allow);
  c.header("Access-Control-Allow-Methods", "POST, OPTIONS");
  c.header("Access-Control-Allow-Headers", "content-type");
  c.header("Access-Control-Max-Age", "86400");
  c.header("Vary", "Origin");
}
app.options("/api/inbound", (c) => { setInboundCors(c); return c.body(null, 204); });

// ---- 机器调用方（官网 Pages Function 服务端转发）的鉴权 ----------------------
// ⭐ 为什么用共享密钥而不是"信 Origin/来源字段"：Origin 与 body 里的 source 都是**调用方自称**，
//   任何人都能发。密钥是唯一能回答"这真是我们自己的官网后端吗"的东西 —— 与 openrouter.ts 那条
//   「背书只认服务端白名单、不认正文自称」是同一条纪律。
// ⚠️ 未配 INBOUND_TOKEN = 机器通道 **fail-closed**（带 token 来一律 503），不是"没闸放行"。
// ⚠️ 浏览器直投路径（本 worker 自带的 /catalog 落地页）**行为一字不变**：不带 token → trusted=false，
//   仍走 honeypot + 每 IP 限流 + 压制名单那套（上游原样）。两条路各判各的，不互相削弱。
type InboundAuth = { trusted: boolean; deny?: { msg: string; code: 401 | 503 } };
function authInbound(c: any): InboundAuth {
  const tok = String(c.req.header("x-inbound-token") || "");
  if (!tok) return { trusted: false };                       // 浏览器路径：老行为
  const want = String(c.env.INBOUND_TOKEN || "");
  if (!want) return { trusted: false, deny: { msg: "inbound channel not configured", code: 503 } };
  // 定长比较：先比长度再逐字符累积异或，避免"第几位不同"从耗时上漏出去
  let diff = tok.length ^ want.length;
  for (let i = 0; i < Math.max(tok.length, want.length); i++) diff |= tok.charCodeAt(i % tok.length || 0) ^ want.charCodeAt(i % want.length || 0);
  if (diff !== 0) return { trusted: false, deny: { msg: "bad inbound token", code: 401 } };
  return { trusted: true };
}
/** 可信调用方才能声明的表单来源（**服务端白名单**，不收自由文本 —— 否则谁都能给自己贴"官网询盘"）。 */
const INBOUND_SOURCE_FORMS = new Set(["website_contact"]);

app.post("/api/inbound", async (c) => {
  setInboundCors(c);
  const auth = authInbound(c);
  if (auth.deny) {
    console.log(JSON.stringify({ evt: "inbound_auth_denied", code: auth.deny.code }));   // 不回显 token，也不回显期望值
    return c.json({ error: auth.deny.msg }, auth.deny.code);
  }
  const b = await jsonBody<{ company_name?: string; company?: string; email?: string; country?: string; where_sell?: string; monthly_volume?: string; company_url?: string;
    name?: string; phone?: string; message?: string; inquiry_type?: string; source_form?: string; product_id?: string; product_title?: string; product_category?: string; product_url?: string; locale?: string }>(c);
  // honeypot：隐藏字段被填 → 判定 bot，假成功、不入库
  if ((b.company_url || "").trim()) return c.json({ ok: true });

  const email = (b.email || "").trim().toLowerCase();
  const person = (b.name || "").trim().slice(0, 200);
  // company_name（本 worker 落地页）与 company（官网表单）是同一字段的两个名字；产品询盘常只有个人名 → 用 name 兜底
  const company = ((b.company_name || "").trim() || (b.company || "").trim() || person).slice(0, 200);
  if (!company) return c.json({ error: "Name or company is required" }, 400);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 200) return c.json({ error: "A valid email is required" }, 400);
  // country 白名单：非法 → null（别信任意 POST 值）。cc 保持小写做白名单/展示查表；
  // ⭐批④：落库一律大写（countryDb），别再制造 US/us 分裂
  const cc = (b.country || "").trim().toLowerCase();
  const country = COUNTRIES[cc] ? cc : null;
  const countryDb = country ? country.toUpperCase() : null;
  const whereSell = (b.where_sell || "").trim().slice(0, 300);
  const volume = (b.monthly_volume || "").trim().slice(0, 100);
  // 产品询盘上下文（官网产品详情页表单）——product_title 或 product_id 有值即判为产品询盘
  const productTitle = (b.product_title || "").trim().slice(0, 200);
  const productCategory = (b.product_category || "").trim().slice(0, 100);
  const productUrl = (b.product_url || "").trim().slice(0, 500);
  const productId = (b.product_id || "").trim().slice(0, 100);
  const phone = (b.phone || "").trim().slice(0, 50);
  const message = (b.message || "").trim().slice(0, 2000);
  const locale = (b.locale || "").trim().slice(0, 10);
  const isProduct = !!(productTitle || productId);
  // 来源标记：**可信调用方**才可声明 source_form（白名单内）；其余一律按老规则自行判定。
  //   → 后台「来源」列因此能区分：website_contact（官网联系表单）/ product_inquiry / landing / search / csv…
  const claimedForm = (b.source_form || "").trim().toLowerCase();
  const trustedForm = auth.trusted && INBOUND_SOURCE_FORMS.has(claimedForm) ? claimedForm : "";
  const source = trustedForm || (isProduct ? "product_inquiry" : "landing");
  // 询盘类型（官网表单的 OEM/ODM · White-label · General）：只作展示，落进 notes，不进 source
  const inquiryType = (b.inquiry_type || "").trim().slice(0, 60);

  // ---- 幂等（**只对可信调用方，且强制**）----------------------------------
  // 为什么强制而不是"给了就用"：官网 Function 转发失败重试是常态（网络抖动/超时），
  //   没有幂等键的重试会给同一封询盘反复追加 notes、反复推飞书。而"可以缺席而不出声的输入，
  //   迟早缺席"（规则 §3.4）—— 所以缺了直接 400 吼出来，不做静默降级。
  // 实现：复用 inbound_throttle（k 是 TEXT PRIMARY KEY）→ INSERT OR IGNORE 拿**原子**判定，
  //   changes=0 即"这键已处理过"。⛔ 不新建表：这张表的语义（短期去重标记 + Cron 清理）正好就是它。
  // ⚠️ 抢先占键（在任何写入之前）：先做事后占键的话，两个并发重试会双双看到"没占过"。
  let idempotent = false;
  if (auth.trusted) {
    const rawKey = String(c.req.header("x-idempotency-key") || "").trim();
    if (!rawKey) return c.json({ error: "x-idempotency-key required for authenticated callers" }, 400);
    const key = rawKey.replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 80);
    if (!key) return c.json({ error: "x-idempotency-key invalid" }, 400);
    const ins = await c.env.DB.prepare(
      "INSERT OR IGNORE INTO inbound_throttle (k, last_at) VALUES (?, datetime('now'))"
    ).bind(`idem:${key}`).run();
    idempotent = (ins.meta?.changes ?? 0) === 0;
    if (idempotent) {
      console.log(JSON.stringify({ evt: "inbound_idempotent_replay", key: key.slice(0, 16) }));
      return c.json({ ok: true, idempotent: true });   // 已处理过：不写库、不推飞书
    }
  }

  // 🔒 合规终极闸（复审加固）：命中持久压制名单(退订/退信/投诉) → 静默 ok，绝不入库/改状态/推飞书。
  // 不依赖可变 leads.status（那条会被"重复邮箱行 / 无 leads 行的压制条目"绕过），用与发信同一道 isEmailSuppressed。
  if (await isEmailSuppressed(c.env, email)) return c.json({ ok: true });

  // 限流（原则：正常量绝不丢真单；限流按 IP、只惩罚那个刷的 IP，不波及别人——全局桶会让一个刷子 DoS 所有人）。
  // 计数 = 该 IP 近 1h 在 throttle 表的 req 行数（标记 key = req:<ip>:<uuid>；Cron 清理 >1 天旧记录）。
  //
  // 🔴 **可信调用方豁免每 IP 限流** —— 不是开特例，是这把尺子在服务端转发下量错了东西：
  //   官网所有询盘都经同一个 Pages Function 出口，对 CRM 而言是**同一个 IP**。
  //   照原规则，官网询盘一旦到 10 封/小时就开始**静默不推飞书**、30 封直接 429 丢单，
  //   而 Joe 那边的现象是"没收到通知"、系统却一切正常 —— 正是最贵的那种故障。
  //   可信调用方已由共享密钥认证，且官网侧自带 honeypot + Origin 校验，防刷在那一层做。
  //   浏览器直投路径的限流**一字未动**。
  let overSoftCap = false;
  if (!auth.trusted) {
    const ipRaw = c.req.header("cf-connecting-ip") || "0.0.0.0";
    const ip = (ipRaw.replace(/[^0-9a-fA-F:.]/g, "").slice(0, 45)) || "0.0.0.0"; // 清洗，防 LIKE 通配(%/_)注入
    const ipHourCount = (await c.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM inbound_throttle WHERE k LIKE ? AND last_at > datetime('now','-1 hour')"
    ).bind(`req:${ip}:%`).first<{ n: number }>())?.n || 0;
    // 硬背底：同 IP ≥30/hr → 该 IP 429 不入库（单 IP flood 本地化；30 远高于真买家，同 NAT 下几个买家也够不到）。
    if (ipHourCount >= 30) return c.json({ error: "too many requests" }, 429);
    // 软限：同 IP ≥10/hr → 该 IP 后续跳过飞书 inboundCard（仍入库、返 ok）；别的 IP 真询盘照常推。
    // IP 轮换仍能绕(已知残留)→ 靠 Turnstile 根治(用户推广前配)；现无流量，per-IP + honeypot 先够。
    overSoftCap = ipHourCount >= 10;
    await c.env.DB.prepare("INSERT OR IGNORE INTO inbound_throttle (k, last_at) VALUES (?, datetime('now'))").bind(`req:${ip}:${crypto.randomUUID()}`).run();
  }

  // 按邮箱去重 upsert。合规：退订/黑名单/退信/已成交/已忽略 的线索，绝不改 next_action/notes、也不作为"新询盘"推送
  // （否则知道邮箱即可 POST 把已退订/黑名单的人捞回"待跟进"，诱导销售联系→合规雷）。
  const SUPPRESSED_INBOUND = new Set(["unsubscribed", "blacklisted", "bounced", "won", "ignored"]);
  const isWebsiteContact = source === "website_contact";
  const nextAction = isWebsiteContact ? "跟进官网询盘" : isProduct ? "跟进产品询盘" : "跟进落地页询盘";
  const note = isWebsiteContact
    // 官网联系表单：字段与 airsonde-web/functions/api/contact.ts 一一对应（契约见 docs/官网询盘接入契约）
    ? `官网询盘 | 姓名: ${person || "-"} | 电话: ${phone || "-"}${inquiryType ? " | 类型: " + inquiryType : ""}${locale ? " | " + locale : ""} | 留言: ${message || "-"}`
    : isProduct
    ? `产品询盘 | 产品: ${productTitle || "-"}${productCategory ? " [" + productCategory + "]" : ""}${productId ? " #" + productId : ""}` +
      `${productUrl ? " | " + productUrl : ""} | 姓名: ${person || "-"} | 电话: ${phone || "-"}${locale ? " | " + locale : ""} | 留言: ${message || "-"}`
    : `落地页询盘 | 在哪卖: ${whereSell || "-"} | 月走量: ${volume || "-"}`;
  // 去重取行：邮箱无 UNIQUE 约束、可能有重复行 → 压制态行优先返回，确保下方状态守卫命中（won/ignored 也拦）
  const existing = await c.env.DB.prepare(
    "SELECT id, status FROM leads WHERE lower(email)=? " +
    "ORDER BY CASE WHEN status IN ('unsubscribed','blacklisted','bounced','won','ignored') THEN 0 ELSE 1 END, id LIMIT 1"
  ).bind(email).first<{ id: number; status: string }>();
  let notify = !overSoftCap;   // 超软限：线索照常入库，只是不推飞书（防刷屏）
  if (existing) {
    if (SUPPRESSED_INBOUND.has(existing.status)) {
      notify = false; // 压制态：不改字段、不通知，静默返回 ok（不泄露状态）
    } else {
      await c.env.DB.prepare(
        "UPDATE leads SET next_action=?, next_action_date=date('now'), " +
        // notes 追加加长度上限（保留最近 4000 字符，防无限膨胀）
        "notes = substr(COALESCE(notes,'') || char(10) || '[' || datetime('now') || '] ' || ?, -4000), updated_at=datetime('now') WHERE id=?"
      ).bind(nextAction, note, existing.id).run();
    }
  } else {
    await c.env.DB.prepare(
      "INSERT INTO leads (company_name, email, country, source, status, notes, next_action, next_action_date) " +
      "VALUES (?, ?, ?, ?, 'new', ?, ?, date('now'))"
    ).bind(company, email, countryDb, source, note.slice(0, 3000), nextAction).run();
  }

  // 推飞书（压制态 / 超软限 时跳过；失败不影响入库）
  if (notify) {
    try {
      if (larkConfigured(c.env)) {
        await larkSend(c.env, inboundCard({ company, email, country: country ? COUNTRIES[country] : "-", whereSell, volume,
          isProduct, productTitle, productCategory, productUrl, message, phone, name: person,
          appUrl: c.env.ADMIN_URL || c.env.APP_URL }));
      }
    } catch { /* 通知失败不影响 */ }
  }
  // 🔒 安全：已删除自动确认邮件——公开端点自动发信会被滥用成垃圾邮件炮打死域名声誉。
  //    团队从后台人工回；未来要自动确认须做双重 opt-in（发验证链接、点了才发）。

  return c.json({ ok: true });
});

// ---- 重扫状态（前端进度条轮询它；也是"还没 arm"的判据）----
app.get("/api/rescan/status", async (c) => {
  const startedAt = (await getSetting(c.env, "rescan_started_at", "")).trim();
  const doneAt = (await getSetting(c.env, "rescan_done_at", "")).trim();
  const total = (await c.env.DB.prepare("SELECT COUNT(*) AS n FROM leads").first<{ n: number }>())?.n || 0;
  const remaining = startedAt ? await rescanRemaining(c.env, startedAt) : 0;
  // 两组的**真实**条数 —— 确认弹窗要用它说清"会发生什么"。**绝不能在前端写死**：
  // 写死的数字今天恰好对，线索涨到 800 之后那段文案就变成一句谎话。
  const marks = RESCAN_RESET_STATUSES.map(() => "?").join(",");
  const resetGroup = (await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM leads WHERE status IN (${marks})`)
    .bind(...RESCAN_RESET_STATUSES).first<{ n: number }>())?.n || 0;
  return c.json({
    armed: !!startedAt, startedAt, doneAt, total, remaining, done: total - remaining,
    resetGroup, refreshGroup: total - resetGroup,
    stats: await rescanStats(c.env),
  });
});

// ---- 开始重扫：重置 + 打时间戳（**这一步会动存量数据**）----
// ⚠️ 打时间戳必须和重置在同一个动作里、且戳在前：rescanTick 靠 `analyzed_at < rescan_started_at`
//    判断"谁还没扫"，戳晚于重置的话，中间被扫过的线索会被判成"已扫"而漏掉。
app.post("/api/rescan/start", async (c) => {
  // 安全闸：自动发送开着时不许开重扫 —— 重置会把 approved 打回 new，重扫过程中它们重新拿到 ≥60
  // 就会被立刻发出去，那正是"按刚被宣布作废的旧流程发信"。
  if (await autoSendEnabled(c.env)) {
    return c.json({ error: "请先关闭「自动发送」再开始重扫 —— 否则重扫过程中线索会边打分边被发出去（用的还是半新半旧的标准）" }, 409);
  }
  const startedAt = new Date().toISOString().replace("T", " ").slice(0, 19);
  await setSetting(c.env, "rescan_started_at", startedAt);
  await setSetting(c.env, "rescan_done_at", "");
  // 重置组 → 打回 new、清旧结论、清抓站失败计数（首页超时已从 8s 提到 18s，上次因超时判"抓不到"的这次可能抓得到）。
  // human_approved 一并归零：status 被打回 new = 批准已被撤销；留着 1 会让翻牌堆 UI 显示「已人工放行」
  // 并禁用按钮、反而让 Joe 按不了，而那次放行基于的正是这次要作废的旧证据。
  const marks = RESCAN_RESET_STATUSES.map(() => "?").join(",");
  await c.env.DB.prepare(
    `DELETE FROM lead_analysis WHERE lead_id IN (SELECT id FROM leads WHERE status IN (${marks}))`
  ).bind(...RESCAN_RESET_STATUSES).run();
  const r = await c.env.DB.prepare(
    `UPDATE leads SET status='new', fetch_fail_count=0, human_approved=0, updated_at=datetime('now')
      WHERE status IN (${marks})`
  ).bind(...RESCAN_RESET_STATUSES).run();
  const remaining = await rescanRemaining(c.env, startedAt);
  console.log(`rescan start: 重置 ${r.meta.changes} 条 → new；待重扫 ${remaining} 条`);
  return c.json({ ok: true, startedAt, reset: r.meta.changes || 0, remaining });
});

// ---- 重扫一批（前端自驱循环调它，直到 done）----
app.post("/api/rescan/batch", async (c) => {
  const b = await jsonBody<{ limit?: number }>(c);
  const limit = Math.min(Math.max(Number(b.limit) || 10, 1), RESCAN_MAX_PER_CALL);
  const startedAt = (await getSetting(c.env, "rescan_started_at", "")).trim();
  if (!startedAt) return c.json({ error: "还没开始重扫（先点「重扫全部」）" }, 409);

  const batch = (await c.env.DB.prepare(
    `SELECT l.* FROM leads l LEFT JOIN lead_analysis a ON a.lead_id = l.id
      WHERE (a.lead_id IS NULL OR a.analyzed_at IS NULL OR a.analyzed_at < ?)
      ORDER BY l.id ASC LIMIT ?`
  ).bind(startedAt, limit).all()).results as any[];

  if (!batch.length) {
    // 收尾：统计 + 推飞书 + 记完成（幂等：rescan_done_at 已写就不再推）
    const stats = await rescanStats(c.env);
    if (!(await getSetting(c.env, "rescan_done_at", "")).trim()) {
      await setSetting(c.env, "rescan_done_at", new Date().toISOString().replace("T", " ").slice(0, 19));
      console.log(`rescan done: ≥${APPROVE_MIN_SCORE}=${stats.hi} <${APPROVE_MIN_SCORE}=${stats.lo} 抓不到=${stats.nil}`);
      try {
        if (larkConfigured(c.env)) {
          await larkSend(c.env, { msg_type: "text", content: { text:
            `AIRSONDE ✅ 全量重扫完成\n` +
            `· ${stats.hi} 家 ≥${APPROVE_MIN_SCORE}（自动通道）\n` +
            `· ${stats.lo} 家 <${APPROVE_MIN_SCORE}（翻牌堆待复核）\n` +
            `· ${stats.nil} 家 官网抓不到（未打分，不是不合格）\n\n` +
            `全部按最终标准重打完毕。自动发送仍是关闭状态 —— 要不要重开由 Joe 决定。` } });
        }
      } catch (e) { console.error("rescan-digest:", e); }
    }
    return c.json({ done: true, processed: 0, remaining: 0, stats });
  }

  let ok = 0, fetchFail = 0, hardFail = 0;
  // 批⑦B：3 条并发（为什么是 3 见 ANALYZE_CONCURRENCY）。每条自己 try/catch —— 一条炸了不能带走整批。
  const outs = await pool(batch, ANALYZE_CONCURRENCY, async (lead) => {
    // 只刷新组：status 不在重置名单里（批⑦A 后两组行为已一样，这个标记只用于 model 字段的标注）
    const scoreOnly = !RESCAN_RESET_STATUSES.includes(String(lead.status));
    try {
      // rescan:true 让 recordFetchFailure 的"别抹掉真分数"守卫让路 —— 重扫时旧分数已被宣布作废，
      // 抓不到就该诚实记成「官网抓不到·无法判断」，而不是留个作废标准的分数；
      // 且不让路会导致这条线索每次被重取、重扫永不完成（见 service.ts 那段注释）。
      return await analyzeLead(c.env, lead, { scoreOnly, rescan: true });
    } catch (e) { console.error("rescan:", lead.id, e); return { ok: false, id: lead.id, error: String(e) }; }
  });
  for (const out of outs) {
    if (out.ok) ok++;
    else if ((out as any).fetchFailed) fetchFail++;
    else hardFail++;
  }
  const remaining = await rescanRemaining(c.env, startedAt);
  console.log(`rescan batch: ok=${ok} 抓不到=${fetchFail} 失败=${hardFail} 剩余=${remaining}`);
  return c.json({ done: false, processed: batch.length, ok, fetchFail, hardFail, remaining, stats: await rescanStats(c.env) });
});

// ============ 批⑯② 低分重打（scoped rescore）============
//
// 只重打 `status='analyzed' 且 match_score<=30` 的存量线索，**score-only**。
// 背景：打分 prompt 里那条"运营商=竞品→≤30"是个预设错误（Starlink 在很多国家正是**和当地运营商
// 合作落地**的），它把一批**真的在卖/装 Starlink 硬件**的经销商杀到了 30。生产实例：techone.nl
// 的打分理由自己写着"是 Starlink 授权经销商"，分数却是 30。prompt 已改，这条通道把存量捞回来。
//
// ⚠️ **别和 /api/rescan/* 混用**，两者不是一回事：
//   · rescan  = 全库重扫，会把 new/analyzed/approved/queued/pending **重置成 new**、删 analysis、
//               清 human_approved —— 批⑯ 明确**不要**（已发/已回复的没必要重算，还烧钱）
//   · 这一条 = 只挑低分，**不动 status、不动 human_approved、不写草稿、不发信**，只刷 analysis
//
// ⭐ 硬前提闸（这道闸是这条通道的核心，不是装饰）：
//   `auto_send_enabled` 或 `auto_approve_enabled` **任一为 1 就拒绝启动**。
//   因为重打会让一批线索升到 ≥APPROVE_MIN_SCORE，而 cron 每小时会「自动批准 analyzed≥60 → 自动发送」——
//   开着这两个开关跑重打，等于**升上来的当场被发出去，Joe 一眼都看不到**，
//   而 Joe 明确要的是"这批被误杀的亲眼过一遍"。把"必须先关开关"做成**结构约束**，不靠谁记得。
//   （同 devguard / 部署闸 一个家族：纪律做成结构。）
//
// ⭐ 抓不到官网的处理：调 analyzeLead 时**不传 rescan** —— 让 recordFetchFailure 里那条
//   `WHERE match_score IS NULL` 守卫**保持生效**，抓不到就**跳过、保留原分数**，
//   绝不把一个真分数抹成 NULL（这批线索本来就都有分数，抹掉是纯粹的数据损失）。
//
// ⭐ 进度用 **id 游标**而不是 analyzed_at：抓不到的线索那条守卫会挡掉整个 DO UPDATE，
//   连 analyzed_at 都不更新 → 用 analyzed_at 判"谁没扫"会**永远重取同一批、跑不完**
//   （rescan 就踩过这个坑，见 service.ts 的注释）。id 游标只进不退，保证收敛。
const RESCORE_LOW_MAX_SCORE = 30;
const RESCORE_LOW_MAX_PER_CALL = 20;

/** 两个自动开关任一开着 → 返回拒绝理由；都关着 → null（放行）。 */
async function rescoreLowGate(env: Env): Promise<string | null> {
  const on: string[] = [];
  if (await autoSendEnabled(env)) on.push("「自动发送」");
  if (await autoApproveEnabled(env)) on.push("「自动批准」");
  if (!on.length) return null;
  return `拒绝启动：${on.join(" 和 ")} 还开着。低分重打会让一批线索升到 ≥${APPROVE_MIN_SCORE} 分，` +
    `这两个开关开着的话 cron 下一个整点就会把它们自动批准并发出去 —— 而升上来的**必须停在「待审批」等人工过目**。` +
    `请先到设置里把这两个开关关掉，再来跑。`;
}

async function rescoreLowRemaining(env: Env, cursor: number): Promise<number> {
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM leads l JOIN lead_analysis a ON a.lead_id = l.id
      WHERE l.status='analyzed' AND a.match_score <= ? AND l.id > ?`
  ).bind(RESCORE_LOW_MAX_SCORE, cursor).first<{ n: number }>();
  return r?.n ?? 0;
}

app.get("/api/rescore-low/status", async (c) => {
  const cursor = Number(await getSetting(c.env, "rescore_low_cursor", "0")) || 0;
  const total = (await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM leads l JOIN lead_analysis a ON a.lead_id = l.id
      WHERE l.status='analyzed' AND a.match_score <= ?`
  ).bind(RESCORE_LOW_MAX_SCORE).first<{ n: number }>())?.n || 0;
  return c.json({
    gateBlocked: await rescoreLowGate(c.env),
    cursor, targetNow: total, remaining: await rescoreLowRemaining(c.env, cursor),
  });
});

/** 开始：只重置游标，**一行线索数据都不动**（跟 rescan/start 的重置完全不同）。 */
app.post("/api/rescore-low/start", async (c) => {
  const blocked = await rescoreLowGate(c.env);
  if (blocked) return c.json({ error: blocked }, 409);
  await setSetting(c.env, "rescore_low_cursor", "0");
  return c.json({ ok: true, target: await rescoreLowRemaining(c.env, 0) });
});

app.post("/api/rescore-low/batch", async (c) => {
  const blocked = await rescoreLowGate(c.env);
  if (blocked) return c.json({ error: blocked }, 409);   // 每批都查：跑到一半有人打开开关也立刻停
  const b = await jsonBody<{ limit?: number }>(c);
  const limit = Math.min(Math.max(Number(b.limit) || 10, 1), RESCORE_LOW_MAX_PER_CALL);
  const cursor = Number(await getSetting(c.env, "rescore_low_cursor", "0")) || 0;

  const batch = (await c.env.DB.prepare(
    `SELECT l.*, a.match_score AS old_score FROM leads l JOIN lead_analysis a ON a.lead_id = l.id
      WHERE l.status='analyzed' AND a.match_score <= ? AND l.id > ?
      ORDER BY l.id ASC LIMIT ?`
  ).bind(RESCORE_LOW_MAX_SCORE, cursor, limit).all()).results as any[];

  if (!batch.length) return c.json({ done: true, processed: 0, remaining: 0, cursor });

  const outs = await pool(batch, ANALYZE_CONCURRENCY, async (lead) => {
    try {
      // ⚠️ 只传 scoreOnly，**绝不传 rescan** —— 保住"抓不到不抹分数"那道守卫。
      const r = await analyzeLead(c.env, lead, { scoreOnly: true });
      return { id: lead.id, company: lead.company_name, website: lead.website,
               old: lead.old_score, new: r.ok ? r.score : null,
               skipped: !r.ok, why: r.ok ? undefined : r.error };
    } catch (e) {
      return { id: lead.id, company: lead.company_name, website: lead.website,
               old: lead.old_score, new: null, skipped: true, why: String(e) };
    }
  });

  // 游标只进不退：抓不到的也算"处理过"，否则会被永远重取。
  const nextCursor = Math.max(...batch.map((l) => Number(l.id)));
  await setSetting(c.env, "rescore_low_cursor", String(nextCursor));
  return c.json({
    done: false, processed: batch.length, cursor: nextCursor,
    remaining: await rescoreLowRemaining(c.env, nextCursor),
    rescored: outs.filter((o) => !o.skipped).length,
    skipped: outs.filter((o) => o.skipped).length,
    results: outs,
  });
});

// ---- 非 /api 请求交给静态资源（后台前端）----
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

// ============ 批⑥A 全量重扫 ============
//
// 背景：这几天标准被重定了（H3-v2 去掉体量闸 + 来源背书 + 首页 18s 超时 + 证据页优先），
// 库里 433 家的分数是新旧标准的混合物 —— 一个混合物做不了任何决策。Joe 要求全部按最终标准重打。
//
// ⭐ 设计的三个关键点：
//
// 1) **走交互式批量通道，不走 cron**（Joe 驳回了我第一版的 cron 方案）。
//    他的标准："如果每天只能分析30-50个信息，我压根都不需要用AI了。" ——
//    cron 的 12 条/班是**无人值守后台**的保守值，拿它跑一次性批量任务是思维惯性错误。
//    通道容量早已被证明：Joe 手点「批量分析」一小时扫了两百多条。
//    所以重扫复用同一条通道（后台按钮 + 前端自驱循环），428 条**当天跑完**。
//    批⑦B 起批内 3 条并发（为什么是 3 见 ANALYZE_CONCURRENCY 那段）。
//    → cron 那班一个字没动，Serper 烧钱速率自然也没动（重扫压根不经过 cron）。
//
// 2) **只刷新组安全的依据是 analyzeLead 的既有性质**，不是我新写的判断：
//    它推进 status 的那条 SQL 带 `AND status='new'` —— 一条 sent/replied/ignored 的线索走完
//    analyzeLead，analysis 换新、status 纹丝不动、更不可能触发发信（发信在 sendApprovedBatch 里，
//    这条路根本不经过它）。所以两组共用一个函数，只用 scoreOnly 区分要不要重写草稿。
//
// 3) **进度靠 DB 状态推导，不靠内存**：谁没扫 = `analysis 缺失 或 analyzed_at < rescan_started_at`。
//    这让整件事**天然可断点续跑** —— 浏览器关了/网断了/中途叫停，再点一次就从断点继续，
//    不需要任何"任务进度"表。
// ⭐ 批⑦B 批内并发池：分析一条线索里 95% 的时间在等（抓官网 + 等模型），CPU 几乎不干活 ——
//   串行跑等于把等待时间一条条加起来。3 条并行 ≈ 3 倍吞吐。
//
// **为什么是 3 不是更多**（这个数不能拍脑袋）：
//   · Workers 每次调用**同时最多 6 路出站连接**。每条线索的抓站本身是串行的（首页 → 子页，
//     一次 1 路），加上模型调用也是 1 路 → 单条线索任一时刻在飞 1-2 路。
//     3 条并行 × 1-2 路 = 3-6 路，**正好在上限内**。开到 4 就会顶到 6 路上限开始互相排队，
//     吞吐不再涨，还可能触发难查的超时。
//   · 总工也明确说了别开到 4 以上。
// ⚠️ 不能 export：index.ts 是 Worker 入口模块，顶层 export 的非函数值会被运行时当成 handler 校验并报
//    "Incorrect type for map entry"（dry-run 查不出、只有真启动才报）——跟 APPROVE_MIN_SCORE 同一个坑。
const ANALYZE_CONCURRENCY = 3;

/** 定长并发池：始终保持 n 个在飞，完一个补一个。保持输入顺序返回结果。 */

// 重置组：这些状态的线索会被打回 new 重新分档；其余状态只刷新 analysis、status 不动
const RESCAN_RESET_STATUSES = ["new", "analyzed", "approved", "queued", "pending"];
const RESCAN_MAX_PER_CALL = 20;   // 单次调用上限（与既有 /api/analyze/batch 的 20 一致 —— 那条通道 Joe 手点实测过）

/** 还有几条没重扫（analysis 缺失 或 analyzed_at 早于本轮重扫开始时间） */
async function rescanRemaining(env: Env, startedAt: string): Promise<number> {
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM leads l LEFT JOIN lead_analysis a ON a.lead_id = l.id
      WHERE a.lead_id IS NULL OR a.analyzed_at IS NULL OR a.analyzed_at < ?`
  ).bind(startedAt).first<{ n: number }>();
  return r?.n ?? 0;
}

/** 重扫的分档统计（完成播报 + 进度条都用它） */
async function rescanStats(env: Env): Promise<{ hi: number; lo: number; nil: number }> {
  const s = await env.DB.prepare(
    `SELECT SUM(CASE WHEN a.match_score >= ${APPROVE_MIN_SCORE} THEN 1 ELSE 0 END) AS hi,
            SUM(CASE WHEN a.match_score IS NOT NULL AND a.match_score < ${APPROVE_MIN_SCORE} THEN 1 ELSE 0 END) AS lo,
            SUM(CASE WHEN a.match_score IS NULL THEN 1 ELSE 0 END) AS nil
       FROM leads l JOIN lead_analysis a ON a.lead_id = l.id`
  ).first<{ hi: number; lo: number; nil: number }>();
  return { hi: s?.hi ?? 0, lo: s?.lo ?? 0, nil: s?.nil ?? 0 };
}

/**
 * 批⑧：收回复失败必须**响**，不能像以前那样悄无声息地断着。
 * 一天最多吵一次（IMAP 挂了通常是持续性的，每 6h 推一条会变成噪音，噪音久了 Joe 就不看了）。
 */
/**
 * ⭐⭐ 记录证据 ≠ 报告结论。**这两件事以前共用一个阈值，是个真 bug。**
 *
 * 原来 `reply_fail_last` 写在 alertReplyFailure 里、而且在"今天已经吵过就 return"**之后** ——
 * 于是：① 一天最多记一条 ② 被 streak/每日去重挡掉的失败**连原文都不留**。
 * 结果就是总工今早的处境：想看第 1 次失败到底报了什么，**看不到**，只能等 streak 走到 3。
 *
 * → **每次失败都记**（不去重、不看 streak）。要不要吵是另一件事，由调用方的 streak 逻辑决定。
 *   证据的价值在于"下一次不用等"。
 */
async function recordReplyFailure(env: Env, why: string): Promise<void> {
  try {
    const ts = new Date().toISOString().slice(0, 19).replace("T", " ");
    // 800 字符：要装得下服务器原话（b0 状态行 + 前几行响应）。300 会把最有用的那段截掉。
    await setSetting(env, "reply_fail_last", `${ts} ${why}`.slice(0, 800));
  } catch (e) { console.error("recordReplyFailure:", e); }   // 记录失败不能拖垮收回复本身
}

// ⭐ IMAP 小修②（已批）：UI 横幅的**连败**计数。原横幅条件=reply_fail_last 非空即亮，且成功后
//   永不清 —— 一次网络抖动就永久挂一条红横幅，Joe 学会无视它=横幅报废。改为：连续失败 ≥2 轮
//   才亮（reply_fail_last 保留为证据，横幅不再拿它当判据），成功一次即清零。
async function bumpReplyFailStreak(env: Env): Promise<void> {
  try {
    const n = (Number(await getSetting(env, "reply_fail_streak", "0")) || 0) + 1;
    await setSetting(env, "reply_fail_streak", String(n));
  } catch (e) { console.error("bumpReplyFailStreak:", e); }
}

async function alertReplyFailure(env: Env, why: string): Promise<void> {
  try {
    const today = new Date().toISOString().slice(0, 10);
    if ((await getSetting(env, "reply_fail_alert_date", "")) === today) return;   // 今天已经吵过
    await setSetting(env, "reply_fail_alert_date", today);
    if (!larkConfigured(env)) return;
    await larkSend(env, { msg_type: "text", content: { text:
      `AIRSONDE ⚠️ 收客户回复失败\n${why}\n\n` +
      `**这意味着现在客户回信我们可能收不到。**\n` +
      `已经收到的回复不受影响；但新回复要么延迟、要么丢。请尽快看一眼收信箱（LARK_IMAP_USER）的 IMAP。\n` +
      `（同样的错一天只提醒一次，免得刷屏）` } });
  } catch (e) { console.error("alertReplyFailure:", e); }   // 告警失败不能反过来拖垮 cron
}

/**
 * ⭐ 防复发守卫：发信上限**没被显式配置**时，每天吼一次。
 *
 * 起因就是这条链上刚发生的事故：真闸 key 生产从没设过 → 静默落到代码默认 10 →
 * 出信量砍 90%、**连续三天没有任何人任何地方知道**。
 * 那次的致命处不是"默认值小"，是**"用了默认值"这件事本身没有任何声音**。
 * → 所以守卫盯的不是数值大小（多少是 Joe 的商业判断，轮不到代码评价），
 *   而是 **"这个数到底是谁定的"**：不是 Joe 定的，就必须有人被告知。
 *
 * 只在 source != configured 时响；Joe 在设置页存一次 → source 变 configured → 自动闭嘴。
 */
async function alertSendLimitUnconfigured(env: Env, limit: number, source: string): Promise<void> {
  try {
    const today = new Date().toISOString().slice(0, 10);
    if ((await getSetting(env, "send_limit_warn_date", "")) === today) return;   // 一天一条，不刷屏
    await setSetting(env, "send_limit_warn_date", today);
    const why = source === "legacy"
      ? `正在沿用**已退役**的 \`wanew_daily_limit\` = **${limit} 封/天**`
      : `**谁都没配过**，正在用代码默认值 **${limit} 封/天**`;
    console.log(`send-limit guard: source=${source} limit=${limit}（未显式配置，已提醒）`);
    if (!larkConfigured(env)) return;
    await larkSend(env, { msg_type: "text", content: { text:
      `AIRSONDE ⚠️ 每日发信上限**未配置**\n${why}\n\n` +
      `上次就是因为这个没人知道，出信量被静默砍到 10 封/天、三天后才发现。\n` +
      `请去后台「发信设置」把每日上限设成你要的数值，存一次即可（存完这条提醒自动消失）。\n` +
      `（一天只提醒一次）` } });
  } catch (e) { console.error("alertSendLimitUnconfigured:", e); }   // 告警失败不能拖垮 cron
}

/**
 * 分析待分析线索 —— **整点班与每分钟快 tick 共用同一份**。
 * ⚠️ C5-22 之前这段长在 cron 里。抽出来不是为了好看：快 tick 也要分析，抄第二份就是两份逻辑，
 *    而这仓已经为"多处各写各的"付过好几次学费（详情页抄漏 match_score 那次就是最近的一回）。
 * @param max 本次最多分析几条。**这是平台限制不是业务旋钮**（业务旋钮在 settings，归 Joe）。
 */
async function analyzePending(env: Env, max: number, opts: { budget?: RoundBudget; concurrency?: number } = {}): Promise<{ ok: number; fetchSkipped: number; attempts: number }> {
  let attempts = 0, fetchSkipped = 0, analyzed = 0;
  // ⭐ 本轮已试过的 id 必须排除掉。抓站失败的线索**故意留在 status='new'**（等下一轮 cron 重试），
  //    而本 while 每批都按 `status='new' ORDER BY id ASC` 重取 —— 不排除的话同一批抓不到的线索
  //    会在**同一轮里**被反复取到，几个来回就把 fetch_fail_count 的 3 次上限烧穿，
  //    "留着下轮重试"直接变成"一轮内判死"，比不修还糟。
  const tried = new Set<number>();
  while (attempts < max) {
    if (opts.budget && !opts.budget.has(25_000)) break;   // C5-22：时间见底就把活留给下一次调用，不硬撑
    let batch: any[] = [];
    try {
      const take = Math.min(8, max - attempts);
      const skip = [...tried];
      const rows = await env.DB.prepare(
        skip.length
          ? `SELECT * FROM leads WHERE status='new' AND id NOT IN (${skip.map(() => "?").join(",")}) ORDER BY id ASC LIMIT ?`
          : "SELECT * FROM leads WHERE status='new' ORDER BY id ASC LIMIT ?"
      ).bind(...skip, take).all();
      batch = rows.results as any[];
    } catch (e) { console.error("analyze-fetch:", e); break; }
    if (!batch.length) break;
    let okThisBatch = 0, hardFail = 0;
    for (const lead of batch) {
      attempts++; tried.add(Number(lead.id));
      try {
        const out = await analyzeLead(env, lead);
        if (out.ok) {
          analyzed++; okThisBatch++;
        } else if (out.fetchFailed) {
          // 抓不到是**这个站**的问题（限流/挂了/拦 UA），不是模型挂了 → 跳过继续，别拖累整轮
          fetchSkipped++;
          console.log(`analyze skip(fetch): #${lead.id} ${lead.website || ""} ${out.error || ""}`);
        } else {
          hardFail++; // 模型/DB 失败 → 多半是持久问题（OpenRouter 挂、额度尽）
        }
      } catch (e) { hardFail++; console.error("analyze:", lead.id, e); }
    }
    // 只有「真失败」（模型/DB）且本批零成功才停 —— 那多半是 OpenRouter 挂了，继续只是空转烧子请求。
    // 全是抓站失败 → **继续下一批**：它们已进 tried 不会被重取，后面的正常线索不该被这几条卡死。
    if (okThisBatch === 0 && hardFail > 0) break;
  }
  if (fetchSkipped) console.log(`analyze: ${fetchSkipped} 条因官网抓不到跳过（未打分，等下轮重试）`);
  return { ok: analyzed, fetchSkipped, attempts };
}

/**
 * 自动批准一轮 —— **整点班与每分钟快 tick 共用同一份**（C5-19 的"打分完成即批"就靠它落地：
 * 触发时机从每小时变成每分钟，**闸一个没变**，走的仍是 approveGateReason 那条既有护栏）。
 * @returns 实际批准了几条
 */
async function autoApproveRound(env: Env): Promise<number> {
  let n = 0;
      const autoMin = await getAutoApproveMin(env);
      const cands = (await env.DB.prepare(
        // ⭐ 批⑨①：`AND l.email IS NOT NULL AND l.email != ''` 已删 —— 无邮箱但 ≥60 的
        //   （生产实测 96 家，其中 65 家有社媒能碰）现在也进 approved=「待联系」，等 Joe 手动碰。
        //   不放它们进来，批⑨ 整个白做：它的全部意义就是"96 家有社媒的公司要有家"。
        //   发邮件的闸在 sendApprovedBatch（同批加的 email 过滤），它们进不了邮件发送池。
        `SELECT l.id, l.email, a.match_score FROM leads l JOIN lead_analysis a ON a.lead_id=l.id
          WHERE l.status='analyzed' AND a.match_score >= ?
          ORDER BY a.match_score DESC, l.id ASC LIMIT 50`
      ).bind(autoMin).all()).results as any[];
      for (const c of cands) {
        // 同一条护栏：任何一项不过（未打分/<60）都不批准，理由照打。
        // 批⑨①：缺邮箱**不再是**不批准的理由 —— 它只决定能不能走邮件那条路，不决定值不值得碰。
        const why = approveGateReason(c.email, c.match_score ?? null);
        if (why) { console.log(`auto-approve skip #${c.id}: ${why}`); continue; }
        const r = await env.DB.prepare(
          "UPDATE leads SET status='approved', updated_at=datetime('now') WHERE id=? AND status='analyzed'"
        ).bind(c.id).run();
        if (r.meta.changes === 1) n++;
      }
      if (n) console.log(`auto-approve: ${n} 条 ≥${autoMin}分 → 待联系（含无邮箱的：它们等 Joe 手动碰社媒）`);
  return n;
}

// ══════════════ C5-22：快 tick（每分钟）══════════════
//
// Joe 的语义：自动模式开 = **所有环节就绪即执行**，不等整点。
//   整点班一次做完所有事的老结构有个致命性质：**前面的步骤有权把后面的饿死**，而且饿得毫无声响
//   —— 2026-09-01 13:00 那轮就是这样（分析把子请求预算吃光，补邮箱 160 次、发信 54 次全部
//   零请求发出却照常记数，18 条有邮箱的待联系一封没发）。摊到多次调用，每次各拿一份预算，
//   这个病才从结构上消失，而不是靠调顺序或加重试去躲。
//
// ⚠️ 每分钟真跑的东西，闸必须先于功能。这里有三道，缺一不可：
//   ① **总开关**：关着时**一件出站的事都不做**（只花一次 D1 读）——"关的是嘴和手"。
//   ② **防重入**：一个 tick 没跑完，下一个直接退。锁写在 settings 里带时间戳，
//      **过期自动失效**（不然一次崩溃会把自动模式永久卡死 —— 那比不加锁更糟）。
//   ③ **时间预算**：tick 之间只隔 60s，超时的活留给下一个 tick，不硬撑。
const TICK_LOCK_KEY = "tick_lock_at";
const TICK_LOCK_STALE_MS = 5 * 60 * 1000;   // 锁最多压 5 分钟；再久一律当成"上一个 tick 死了"

/**
 * 每 tick 的对外请求预算。
 * ⚠️ **1000 是假定值，不是实测值** —— 已实测的只有两条：免费档 = 50（第 51 次撞墙，
 *    2026-09-01 生产实测）、付费档 ≥200（探针自身上限只到 200，没往上逼近）。
 *    所以这个数**不许被当成量过的数引用**。留 20% 余量，且可被设置覆盖。
 */
const TICK_FETCH_BUDGET_ASSUMED = 800;

/** 快 tick 单次最多分析几条。**平台限制，不是业务旋钮** —— 每分钟一次，慢慢来反而更稳。 */
const TICK_ANALYZE_MAX = 3;
/** 快 tick 单次最多发几封。一封实测 31-43s、并发 3 ⇒ 3 封约 40s，装得进一分钟。
 *  ⚠️ 真正管"每天发多少"的是 Joe 在设置里的日限，这个数只管**一次 tick 别撑爆**。 */
const TICK_SEND_MAX = 3;
/** 每封开发信之间的最小间隔（秒）。**Joe 的旋钮**，settings 里 `send_interval_seconds` 覆盖；设 0 = 不限速。
 *  90s ≈ 40 封/小时 —— 对刚养起来的域名是温和的节奏，而"每天发多少"仍然由他的日限说了算。 */
const SEND_INTERVAL_DEFAULT = 90;

/** 快 tick：自动模式开着时做增量出站。**关着时零出站**。 */
async function fastTick(env: Env, ctx: ExecutionContext): Promise<void> {
  // ① 总开关。⚠️ 放在最前面且**先于任何 fetch** —— 关着时这个函数的代价就该只有一次 D1 读。
  if (!(await automationEnabled(env))) return;

  // ② 防重入。⚠️ 不用内存变量：isolate 会被回收/复用，跨调用根本不共享
  //    （这仓栽过一次同类：以为内存里的标志能跨请求生效）。真源必须落库。
  const now = Date.now();
  const lockRaw = (await getSetting(env, TICK_LOCK_KEY, "")).trim();
  const lockAt = Number(lockRaw) || 0;
  if (lockAt && now - lockAt < TICK_LOCK_STALE_MS) return;        // 上一个还在跑
  await setSetting(env, TICK_LOCK_KEY, String(now));

  const budget = new RoundBudget(now);
  let analyzed = 0, approved = 0, sent = 0, gapHold = false;
  try {
    // ③ 分析 → 批准 → 发送，**一个 tick 内级联**（这就是"就绪即执行"）。
    //    每一步都先看表：tick 间隔只有 60s，超了就把活留给下一个 tick，不硬撑。

    // 3a) 分析新到的线索
    if (budget.has(45_000)) {
      const r = await analyzePending(env, TICK_ANALYZE_MAX, { concurrency: ANALYZE_CONCURRENCY, budget });
      analyzed = r.ok || 0;
    }

    // 3b) 够分的立刻批准 —— **不等整点**（C5-19 的"打分完成即批"并入这里）。
    //     ⚠️ 走的仍是既有那条 approveGate SQL，一个闸都没豁免；这里只是把它的触发时机
    //        从"每小时一次"改成"每分钟一次"。**行为没变，节奏变了。**
    if (budget.has(20_000) && await autoApproveEnabled(env)) {
      approved = await autoApproveRound(env);
    }

    // 3c) 发就绪的。所有业务闸（日限/爬坡/熔断/压制/幂等）都在 sendApprovedBatch 里，一个不豁免。
    //
    // ⭐ 每封间隔（Joe 的旋钮，不是我们的强制）：没有它，提频到每分钟就等于
    //   "最多 3 封/分钟连发"—— 对一个刚养起来的域名，节奏变化太陡。
    //   ⚠️ 默认给温和值但**可清零**：设 0 就是不限速。这是给他的旋钮，不是我们替他做的决定。
    //   ⚠️ 判据用**真实发出时刻**（emails 表里最后一封 sent 的时间），不是我们自己记的流水账 ——
    //     自己记的那个会在崩溃/回滚后与事实脱节，而真源不会。
    if (budget.has(50_000) && await autoSendEnabled(env)) {
      const gapSec = Math.max(0, Number(await getSetting(env, "send_interval_seconds", String(SEND_INTERVAL_DEFAULT))) || 0);
      if (gapSec > 0) {
        const last = await env.DB.prepare(
          "SELECT MAX(sent_at) AS t FROM emails WHERE status='sent'"
        ).first<{ t: string | null }>();
        if (last?.t) {
          const lastMs = Date.parse(String(last.t).replace(" ", "T") + "Z");
          if (Number.isFinite(lastMs) && now - lastMs < gapSec * 1000) {
            // 还没到间隔 —— 这一 tick 不发。**不是错误，但必须说出来**：
            //   静默跳过会让"在等间隔"和"发信坏了"在日志上长得一模一样，
            //   而这仓已经为"没跑和跑了 0 命中数据上完全一样"付过学费。
            gapHold = true;
            console.log(`tick: 距上封 ${Math.round((now - lastMs) / 1000)}s < 间隔 ${gapSec}s，本轮不发（Joe 设的 send_interval_seconds）`);
          }
        }
      }
    }
    if (!gapHold && budget.has(50_000) && await autoSendEnabled(env)) {
      const { effective } = await systemDailySendLimit(env);
      const { limit: autoLimit } = await autoSendDailyLimit(env, effective);
      const room = Math.max(0, autoLimit - (await autoSentToday(env)));
      const take = Math.min(room, TICK_SEND_MAX);
      if (take > 0) {
        const r = await sendApprovedBatch(env, take, undefined, true, { concurrency: SEND_CONCURRENCY, budget });
        sent = r.sent || 0;
      }
    }
  } catch (e) {
    console.error("fastTick:", e);
  } finally {
    // ⚠️ 一定要放锁：不放的话下一个 tick 要等 5 分钟过期才动，自动模式变成"每 5 分钟一次"。
    await setSetting(env, TICK_LOCK_KEY, "").catch(() => {});
  }
  if (analyzed || approved || sent) {
    console.log(`tick: 分析 ${analyzed} · 批准 ${approved} · 发出 ${sent}（耗时 ${Math.round((Date.now() - now) / 1000)}s）`);
  }
}

// Cron 定时任务：自动找客户 + 自动分析新线索（7×24 运行）
async function scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
  // ⚠️ 全量重扫**不在这里** —— 它走交互式批量通道（/api/rescan/*，后台按钮驱动）。
  //    cron 这 12 条/班是**日常新增线索**的节奏；拿它跑一次性批量任务要 9 天，
  //    而 Joe 的标准是"428 条当天跑完"。两件事，两条通道，互不干扰。
  let inserted = 0, analyzed = 0, replies = 0, autoApproved = 0, autoSent = 0, emailsFound = 0;

  // ⭐⭐ P0-1：一轮 cron 的时间预算表。**这是平台限制（Cron Trigger 15 分钟墙），不是业务旋钮。**
  //    业务旋钮（每天发几封）在 settings 里，归 Joe。谁都不许拿这里的数去砍他的数。
  //    全轮共用一份预算 —— 收回复/discovery/分析/发信/跟进都从同一个 13 分钟里花，
  //    谁排前面谁先花。所以每一步都要看表，别让前面的把后面的饿死。
  const budget = new RoundBudget(Date.now());
  // ⭐ 子请求计量：**只数数不改行为**。包全局 fetch 才能连库内部发的、以及重定向每一跳都数到
  //   （数代码里的 fetch 调用点是估算，会漏这两类）。每轮开头复位——isolate 会复用。
  installFetchMeter(); subReset(); subMark("0-收回复");
  // D1 也要数：它走的是另一条额度（文档说 1,000），但**到底吃不吃那 50 要实测**
  //   （/api/diag/d1-subrequest-probe 是决定性实验）。这里先把量测出来备用。
  // ⚠️ 只在本轮把 env.DB 换成计量代理 —— **只 count 后原样转发**，不改任何行为。
  env = { ...env, DB: meteredDB(env.DB) } as Env;

  // ⭐ cron 已提频到**每小时**（0 * * * *）—— 因为 Joe 要 100 封/天，而一封信实测 31-43s，
  //    4 班怎么都装不下。24 班 × 每班能发多少 = 他填的数才有可能达到。
  //
  // ⚠️⚠️ 但 **discovery / directory 仍然只在 0/6/12/18 点跑** —— 这是硬约束：
  //    它们烧 Serper 积分，跟着提频 = **烧钱速度直接 ×6**。发信提频不该让找客户跟着提频，
  //    两件事的成本结构完全不同（发信几乎免费，搜索是真金白银）。
  const hourUtc = new Date(event.scheduledTime).getUTCHours();
  // ⭐ 方案A（Joe/总工 已拍）：**付费搜索改成每轮都跑**，目录抓取仍只在 0/6/12/18。
  //
  // ⚠️ 这两件事以前共用一个 `isDiscoveryRound` —— **必须拆开，不能一起提频**：
  //   · Serper 搜索 = 花**我们自己**的钱。80 → 480 次/天（在 Joe 批的 1000 日预算内），
  //     换来新线索 ~20 → ~120 条/天，完整 sweep 从 3.25 天缩到 ~13 小时。
  //   · 目录抓取（NMEA / rvwithtito）= **爬别人的站**，人家有 Crawl-delay 10。
  //     它零 Serper 成本，但"免费"不等于"可以随便跑" —— 每小时去敲一次门是骚扰。
  //     所以它**保持 0/6/12/18 不变**。
  //   把它俩绑在一个布尔上，就是"把碰巧相等固化成必须相等"（guard-cadence.js 里写过的那个坑）。
  const isSearchRound = true;                     // 付费搜索：每轮（cron = 每小时）
  const isDirectoryRound = hourUtc % 6 === 0;     // 目录抓取：仍然只在 0/6/12/18

  // ⭐ step 0）收客户回复 —— **排在最前面，这个顺序本身是修复的一部分**。
  //
  // 它以前排在第 3 步（找客户 → 分析 12 条 → 自动批准 → 自动发送 → **才轮到收回复**）。
  // 那个排序把这条链上**最值钱的一步**放在了最后：一个真客户回信，价值远大于分析 12 条新线索。
  // 排最后意味着前面任何一步慢了/挂了，它就轮不到 —— 而且没人会知道。
  // 今天的实证：Data Lake 的 Michael 昨天 19:06 就回信了（"Please send your catalog and pricing."），
  // 系统一无所知，Joe 是自己在邮箱里肉眼看见的。
  //
  // ⚠️ 而且**失败必须响**：ingestReplies 里 IMAP 失败时是 `return { error }` 而**不是 throw** ——
  //    以前调用方只读 `r.ingested`，`r.error` 根本没人看，连 console.error 都不会打。
  //    catch 是摆设（没东西抛给它）。这就是"静默断了不知道多久"的机制。
  try {
    if (!isIgnited(env, "reply")) {
      // ⭐ C2-C：**从未点火 ≠ 故障**。这里原来会 record + bump + alert，于是"IMAP 密码还没配"
      //   被累计成「收客户回复失败（已连续 465 轮）」，天天一条黄色告警。
      //   一台还没插电的机器不该报引擎故障 —— 更要命的是**它让真故障失去意义**：
      //   天天都红的灯，真红的那天没人会看。
      //   现在：只打一行日志，不计轮数、不推告警；面板由 /api/ignition 显示「未点火 · 差这把钥匙」。
      //   ⚠️ 钥匙一旦配上，下面 else 分支照旧：**配了而失败仍然是故障，仍然吼**。
      console.log(`replies skipped: ${notIgnitedReason(env, "reply")}`);
    } else {
      // ⭐ P0-1：cron 给它 25s 时间盒 —— 一轮总共 15 分钟，它排 step 0，慢一分半后面就少发两三封。
      //   实测批⑧ 改成整批 FETCH 后整个会话 7.9s，25s 有 3 倍余量。超了也不丢：游标可续，下班（1 小时后）接着收。
      let r = await ingestReplies(env, { timeoutMs: REPLY_CRON_TIMEOUT_MS });
      // ⭐ IMAP 小修①（已批）：**瞬时重试** —— 一次超时多半是网络抖动，立刻再试一次比等下一班
      //   （1 小时）便宜得多。先记第一次的原话（记录证据 ≠ 报告结论），重试成功就走成功分支。
      //   ⭐ 批（2026-07-27）：重试范围从"只超时"扩到**所有 transient**（超时 + Lark `NO internal server error`）——
      //     上游实测这类间歇错大概率二次就过（4× 手点仅偶发抖动），立即重试省一小时延迟。
      //     判定收在 isTransientImapError 一处；真故障（登录被拒/零正文/解析坏）仍不重试、照旧立刻吼。
      //   ⚠️ 重试**不碰游标**：失败不推进的零丢失底线在 replies.ts:310（仅成功批 setSetting），此处只多跑一次 fetch。
      if (r.error && isTransientImapError(r.error)) {
        await recordReplyFailure(env, `${r.error}（瞬时重试前的第 1 次）`);
        r = await ingestReplies(env, { timeoutMs: REPLY_CRON_TIMEOUT_MS });
      }
      replies = r.ingested || 0;
      // 批㉘ 双收件箱：失败降噪**按账户独立**（一箱挂不拖累另一箱的告警节奏）。
      // 记录证据≠报告结论（原文无条件先记）；偶发超时≥3 轮才吼、真故障立吼的家法逐账户执行。
      // UI 横幅 streak：任一箱失败即 bump，全部成功才清零（横幅是"收回复能力受损"的总信号）。
      const perAcct = r.perAccount || (r.error
        ? [{ account: "imap", ok: false, error: r.error }] : [{ account: "imap", ok: true }]);
      let anyFail = false;
      for (const acct of perAcct) {
        // 键名沿用 reply_timeout_streak（历史）；语义已扩为"所有 transient 连败计数"（超时+internal server error）。
        //   不改键名：改名会孤立生产现有计数、白白多一轮重置，无收益。
        const streakKey = `reply_timeout_streak@${acct.account}`;
        if (acct.ok) { await setSetting(env, streakKey, "0"); continue; }
        anyFail = true;
        const msg = `[${acct.account}] ${acct.error}`;
        console.error("replies:", msg);
        await recordReplyFailure(env, msg);
        // ⭐ 批（2026-07-27）：告警连败阈值从"只超时"扩到**所有 transient**（超时 + Lark `NO internal server error`）。
        //   起因：Lark Mail IMAP 后端间歇抖动，每小时对一次瞬时 NO 立即推红卡 = 误报噪音惊动 Joe。
        //   间歇错纳入 streak：连续 <3 轮只记录不吼；≥3 轮（≈3 小时真收不到）才推——真·持续宕仍然会吼，不被压掉。
        //   真故障（登录被拒/零正文/解析坏）不是 transient → 仍立即吼（重试无意义、拖不得）。
        const isTransient = isTransientImapError(acct.error);
        if (!isTransient) { await setSetting(env, streakKey, "0"); await alertReplyFailure(env, msg); }
        else {
          const streak = (Number(await getSetting(env, streakKey, "0")) || 0) + 1;
          await setSetting(env, streakKey, String(streak));
          console.log(`replies: ${acct.account} transient 失败第 ${streak} 轮连续（≥3 轮才推飞书，避免 Lark 抖动误报）`);
          if (streak >= 3) await alertReplyFailure(env, `收回复连续 ${streak} 轮失败（${acct.account}，≈${streak} 小时没收到）：${acct.error}`);
        }
      }
      if (anyFail) await bumpReplyFailStreak(env);   // IMAP 小修②：UI 横幅连败（≥2 才亮）
      else {
        await setSetting(env, "reply_fail_streak", "0");
        await setSetting(env, "reply_timeout_streak", "0");   // 旧全局键顺手清零退役（读者已迁按账户键）
      }
    }
  } catch (e: any) {
    console.error("replies:", e);
    await recordReplyFailure(env, e?.message || String(e));   // 先记原文，再吼
    await bumpReplyFailStreak(env);
    await alertReplyFailure(env, e?.message || String(e));
  }

  subMark("1-discovery");
  // 1) 搜索找新客户（每关键词 5 条，控制用量）—— #S1 受 discovery_enabled 开关控制（默认关，防 cron 每 6h 全量烧 Serper 积分）
  try {
    // 方案A：这一步**每轮都跑**（20 组合/轮 × 24 轮 = 480 次/天，在 1000 日预算内）。
    // 硬封顶仍在 runDiscovery 内部（serper_daily_budget），撞到就 budgetStopped 停，烧不穿。
    if (!isSearchRound) {
      console.log(`discovery skipped: 本轮 ${hourUtc}:00 不是搜索班次`);
    } else if ((await getSetting(env, "discovery_enabled", "0")) === "1") {
      const d = await runDiscovery(env, { perKeyword: 5, maxCombos: 20 });   // P0-b 每轮只跑 20 组合(轮转)，不再全量 572；P0-c 预算内
      inserted = d.inserted;
    } else { console.log("discovery skipped: discovery_enabled=0"); }
  } catch (e) { console.error("discover:", e); }
  subMark("1.5-目录源");
  // 1.5) 队列⑦ 免费目录源每周自动刷新（NMEA + rvwithtito）——**零 Serper**，与上面的付费搜索开关无关。
  //      内部自判 >7 天才真跑、遵守 Crawl-delay 10 与礼貌 UA；抓到的新公司走同一条去重+分析管道（下面第 2 步会打分）。
  try {
    // ⚠️ 同样只在 0/6/12/18 跑。它虽然零 Serper，但要**爬别人的站**（NMEA 有 Crawl-delay 10）——
    //    每小时去敲一次门是对人家站点的骚扰，哪怕内部有 >7 天的自判也不该每小时问一遍。
    //    "免费"不等于"可以随便跑"。
    if (!isDirectoryRound) {
      console.log(`directory refresh skipped: 本轮 ${hourUtc}:00 不是目录班次（只在 0/6/12/18，守 Crawl-delay 与礼貌节奏）`);
    } else {
      const dr = await runDirectoryRefresh(env);
      if (dr.ran) { inserted += dr.inserted; console.log(`directory refresh: +${dr.inserted}`, dr.detail); }
      else console.log("directory refresh skipped:", dr.reason);
    }
  } catch (e) { console.error("dir-refresh:", e); }
  subMark("2-分析");
  // 2) 分析未处理的新线索：循环分析到无 new 或达安全上限（Free 子请求预算保守，逐条 try/catch）。
  //    成功→status 转 analyzed→下批取到新的；本批全失败(多为持久问题:模型/网络)→停，别空转浪费子请求。
  // ⚠️ **这是平台限制，不是业务旋钮。业务旋钮在 settings 里，归 Joe。**
  //    它保护的是 Workers 的子请求/CPU 预算，跟"每天发几封"是两码事 —— 别把它当成可调的业务参数。
  //    （对照 P0-1 拔掉的那个 `Math.min(autoRoom,5)`：那个是**业务**常数，锁死了 Joe 的每日上限，已删。）
  const CRON_ANALYZE_MAX = 12; // 单轮最多分析条数（~8-12 安全区，别在一次 Cron 抽干 100+）
  // C5-22：抽成 analyzePending()，与每分钟快 tick 共用同一份实现。
  const _an = await analyzePending(env, CRON_ANALYZE_MAX, { budget });
  analyzed += _an.ok;

  subMark("2.5-自动批准");
  // 2.5) 自动批准：≥auto_approve_min（默认 60）且有邮箱 → approved。
  //  · 两档制：60 是唯一决策线，≥60 走自动通道、<60 进翻牌堆由 Joe 复核。60-69 拍板区已取消。
  //  · **走 approveGateReason 那条既有护栏**，不另开判断口子 —— 批⑨① 之后它管的是"已打分+≥60"，
  //    **不再管邮箱**（闸分两条：批准=值得碰；能不能发邮件是发送那一刻的事，见 send.ts）。
  //  · <60 → **不动**：进翻牌堆等 Joe 复核，绝不替他做销毁性决定。
  try {
    if (await autoApproveEnabled(env)) {
      // C5-22：抽成 autoApproveRound()，与每分钟快 tick 共用。
      autoApproved += await autoApproveRound(env);
    } else console.log("auto-approve skipped: auto_approve_enabled=0");
  } catch (e) { console.error("auto-approve:", e); }

  subMark("2.55-补邮箱");
  // 2.55) ⭐ 自动补邮箱 —— 补上漏斗中间**断掉的那一节**。
  //
  // 2026-07-28 诊断实测：全库 503 家里 **267 家没有邮箱，而这 267 家全都有官网**；
  //   其中 **119 家已经是 approved** —— 也就是说机器认可了、却永远发不出去。
  //   真能发的池子当时只有 **25 家**：日上限设 1000 也没用，发完 25 封就没米下锅。
  // 根因不是开关也不是阈值，是**这一步从来没有自动通道**：
  //   `findLeadEmail` 在 scheduled() 里出现 **0 次**，只挂在两个手动端点上。
  //   而 approveGateReason 又**故意不检查邮箱**（Joe 定的"缺数据=信息不全，不是不合格"）
  //   → 批准不要求邮箱 + 补邮箱只能手点 = **批完就永久卡住**。119 家就是这么攒出来的。
  //
  // ⚠️ 三条纪律：
  //   1. **只走免费路径**（抓公开联系页，零额度）。Hunter 是 1 家 1 积分的**花钱**通道，
  //      绝不放进 cron —— 要花钱的规模得 Joe 自己拍。
  //   2. **每轮限量 + 串行**：不是技术限制，是**礼貌**。一轮猛敲 119 个陌生站点
  //      跟我们自己被扫描器骚扰是同一回事（本仓 NMEA 抓取守 Crawl-delay 10 就是这个道理）。
  //   3. **可关**：find_email_enabled=0 即停。
  // ⭐⭐ 每轮**无条件**落一条 `find_email_run` —— 包括"跳过"和"跑了 0 命中"。
  //   这是补我自己挖的坑：原来只在 emailsFound>0 时写 find_email_last，
  //   于是 **「没跑」和「跑了但 0 命中」在数据上完全一样** —— 正是本项目反复栽的那个病
  //   （空结果和真结果长得一模一样）。第二天想回答"到底跑没跑"只能靠推断，那不算证据。
  //   记录里必须带 outcome，让这两件事**在数据层面就分得开**。
  let feOutcome = "unknown", feAttempted = 0;
  // ⚠️ `timeout` 与 `network_error` **必须分开**：前者是我们自己的 AbortController 掐的
  //   （该调 TIMEOUT），后者是 DNS/TLS/被拒/**子请求配额耗尽**（调超时毫无用处）。
  //   原来糊成一类的 `timeout-or-network` 让 13:00 那轮的 "20/20 超时" 看起来像超时问题，
  //   而同一批站单独用 HTTP 请求跑却全部成功 —— 分类名本身在误导。
  const feFail = { timeout: 0, network_error: 0, no_email_on_page: 0, rejected_by_valid: 0, rate_limited: 0, other: 0 };
  // ⭐ **运行时的原话**（最多留 3 条样本）。只有原话能告诉我们到底是
  //   `Too many subrequests` 还是别的 —— 分类是我们的判断，原话是事实。
  const feErrSamples: string[] = [];
  try {
    if ((await getSetting(env, "find_email_enabled", "1")) !== "1") {
      feOutcome = "skipped:disabled";
      console.log("auto-find-email skipped: find_email_enabled=0");
    } else if (!budget.has(60_000)) {
      // ⚠️ 这条路径以前是**完全静默**的：它跳过、不写任何东西，看起来和"跑了 0 命中"一样。
      feOutcome = "skipped:no-budget";
      console.log("auto-find-email skipped: 本轮时间预算不足（平台限制，非业务上限）");
    } else {
      const perRound = Math.max(1, Math.min(50, Number(await getSetting(env, "find_email_per_round", "20")) || 20));
      // 优先 approved（它们已经被认可、只差一个邮箱就能发），再轮到高分 analyzed
      const targets = (await env.DB.prepare(
        `SELECT l.id, l.website FROM leads l LEFT JOIN lead_analysis a ON a.lead_id=l.id
          WHERE (l.email IS NULL OR l.email='') AND l.website IS NOT NULL AND l.website<>''
            AND l.status IN ('approved','analyzed')
          ORDER BY (l.status='approved') DESC, COALESCE(a.match_score,0) DESC, l.id ASC
          LIMIT ?`
      ).bind(perRound).all()).results as any[];
      feOutcome = "ran";
      for (const t of targets) {
        if (!budget.has(20_000)) { feOutcome = "ran:truncated-by-budget"; console.log("auto-find-email: 时间预算见底，剩下的下轮继续"); break; }
        feAttempted++;
        try {
          // useHunter=false 是**硬编码不是默认值** —— 不给"配置一改就开始烧积分"的口子
          // probes：让这次抓取**顺手把每页结果带出来**，失败时直接分类，不再二次抓取
          const probes: PageProbe[] = [];
          const r = await findLeadEmail(env, t.website || "", false, probes);
          if (r.email) {
            const up = await env.DB.prepare(
              "UPDATE leads SET email=?, updated_at=datetime('now') WHERE id=? AND (email IS NULL OR email='')"
            ).bind(r.email, t.id).run();
            if (up.meta.changes === 1) emailsFound++;
          } else {
            // ⭐ 失败**按原因分类，但零额外请求** —— probe 来自刚才那次抓取本身（findLeadEmail 带出来的）。
            //   ⚠️ 原来这里再跑一次 `diagnoseSite`：**又一整轮 8 个请求**。
            //      生产构成表实测：补邮箱一轮烧 **320 = 160(抓) + 160(诊断)** —— **一半是诊断自己烧的**，
            //      而且它在**已经越过子请求上限之后还在继续发**：越失败发得越多。
            //      **一个只在失败时启动、且随失败量放大的东西，等于在系统崩溃时踩油门。**
            //   现在诊断能力一点没丢，代价从"每轮 160"变成 **0**。
            const anyOk = probes.some((p) => p.why === "ok");
            const any429 = probes.some((p) => p.status === 429);
            const anyMail = probes.some((p) => p.emails.length);
            // 把**原话**收进样本（不管落哪一类）——唯一能证伪平台层假设的东西
            for (const p of probes) {
              if (p.errMessage && feErrSamples.length < 3) {
                const line = `${p.path}: ${p.errName || "?"}: ${p.errMessage}`;
                if (!feErrSamples.includes(line)) feErrSamples.push(line);
              }
            }
            if (any429) feFail.rate_limited++;
            else if (!anyOk) {
              // 拆开：只有 AbortError（我们自己掐的）才算真超时
              const timedOut = probes.some((p) => p.why === "timeout");
              if (timedOut) feFail.timeout++; else feFail.network_error++;
            }
            else if (anyMail) feFail.rejected_by_valid++;   // 页面上有、却没被采纳 → 是我们的过滤在挡
            else feFail.no_email_on_page++;                 // 页面上真没有
          }
        } catch (e) { feFail.other++; console.error(`auto-find-email #${t.id}:`, e); }   // 单站失败不拖垮整轮
        await new Promise((res) => setTimeout(res, 1200));   // 礼貌间隔：别把人家站点打疼
      }
      console.log(`auto-find-email: 尝试 ${feAttempted}/${targets.length} 家 → 补到 ${emailsFound} 个（免费路径，未用 Hunter）· 失败分类 ${JSON.stringify(feFail)}`);
      if (emailsFound) await setSetting(env, "find_email_last", `${new Date().toISOString().slice(0, 16).replace("T", " ")} 补到 ${emailsFound} 个`);
    }
  } catch (e) { feOutcome = "error"; console.error("auto-find-email:", e); }
  // ⚠️ 无条件写：**这一行是"到底跑没跑"唯一可回溯的证据**。放在 try 之外，
  //    任何路径（关闭/没预算/跑了0命中/异常）都会留下痕迹。
  try {
    await setSetting(env, "find_email_run", JSON.stringify({
      at: new Date().toISOString().slice(0, 16).replace("T", " "),
      outcome: feOutcome, attempted: feAttempted, found: emailsFound, fail: feFail,
      // ⭐ 原话样本：分类是我们的判断，**这个才是事实**。若真是子请求配额耗尽，
      //   `Too many subrequests` 会原样出现在这里，一眼终结猜测（同 Serper 那次）。
      err: feErrSamples,
    }).slice(0, 1200));   // 500 装不下原话，放宽
  } catch (e) { console.error("find_email_run 记录失败:", e); }

  // 2.55) 发信上限配置守卫 —— 排在所有发信动作之前：**要吼就在开枪之前吼**。
  //   （放这里而不是塞进 systemDailySendLimit 内部：那个 resolver 会被 API/UI 高频调用，
  //     告警逻辑长在里面等于把"读一个数"变成有副作用的动作。守卫属于 cron，不属于读取器。）
  try {
    const sl = await systemDailySendLimit(env);
    if (sl.source !== "configured") await alertSendLimitUnconfigured(env, sl.limit, sl.source);
  } catch (e) { console.error("send-limit guard:", e); }

  subMark("2.6-自动发信");
  // 2.6) 熔断检查 → 自动发送。**熔断必须在发送之前**：先看伤口再决定要不要继续开枪。
  try {
    const br = await getBreakerStatus(env);
    if (br.shouldTrip && await autoSendEnabled(env)) {
      // 只熔断自动发送：auto_approve 继续跑、手动发送不受影响。熔断后**不自动恢复**，必须 Joe 手动开——
      // 自动恢复会退化成"烧一轮停一下再烧一轮"。
      // C5-22：断路器**只写自己那个格子**，不再去掀 `auto_send_enabled`。
      //   以前两件事共用一个变量 ⇒ Joe 下次开总开关就把熔断悄悄清了，而且界面上看不出熔断过。
      //   现在 autoSendEnabled() = 自动模式 ∧ 未熔断 ∧ 该步开关 ⇒ 熔断照样立刻停发，
      //   但"为什么不发信"这个问题永远答得出是三个原因里的哪一个。
      await setSetting(env, "auto_send_tripped_at", new Date().toISOString());
      await setSetting(env, "auto_send_trip_reason", `最近 ${br.window} 封自动开发信里 ${br.unsubs} 封退订 = ${(br.rate * 100).toFixed(1)}%`);
      console.error(`⚠️ 熔断：${br.unsubs}/${br.window} = ${(br.rate * 100).toFixed(1)}% ≥ 15% → 已置 auto_send_tripped_at（自动发信停，分析/批准不受影响）`);
      try {
        if (larkConfigured(env)) {
          await larkSend(env, { msg_type: "text", content: { text:
            `AIRSONDE ⚠️ 自动发送已熔断\n最近 ${br.window} 封自动开发信里 ${br.unsubs} 封退订 = ${(br.rate * 100).toFixed(1)}%（阈值 15%）。\n` +
            `已自动停止**自动发送**；自动批准与手动发送不受影响。\n请检查线索来源与开发信内容，确认后到后台手动重开（不会自动恢复）。` } });
        }
      } catch { /* 通知失败不影响熔断本身 */ }
    }
    const autoOn = await autoSendEnabled(env);
    if (!autoOn) {
      console.log("auto-send skipped: auto_send_enabled=0" + (br.shouldTrip ? "（本轮刚熔断）" : ""));
    } else {
      // 自动通道日限：**默认跟随系统闸**（没显式设过就不卡人），显式设过才用自己的值。
      // 系统闸仍在 sendApprovedBatch 内把守 → 两者取更紧的那个，结构上不可能突破总闸。
      const { effective: sysEff } = await systemDailySendLimit(env);
      const { limit: autoLimit } = await autoSendDailyLimit(env, sysEff);
      const autoRoom = Math.max(0, autoLimit - (await autoSentToday(env)));
      // ⭐⭐ P0-1：`Math.min(autoRoom, 5)` 已删。**那一行把 Joe 的旋钮锁死了** ——
      //    他设 auto_send_daily_limit=100，实际上限是 4 班 × 5 = **20 封/天**，他的设置根本没生效。
      //    Joe 原话："把每天发多少封的权限交给我，我会根据情况自己去调整。"
      //
      //    现在 `take = autoRoom`（当天剩余额度），**`auto_send_daily_limit` 是唯一的业务闸**。
      //    每轮发不完不要紧：cron 已提频到每小时（24 班），剩下的下一班继续。
      //
      //    ⚠️ 那个 `5` 的**原意是对的**（别一轮打光、摊到多班），但它不该是常数，更不该是**业务**常数。
      //       "别一轮打光"的真实约束是 **Cron 15 分钟墙**，那是**平台限制** ——
      //       所以它现在由 `budget`（看表）来管，不由一个我们自己拍的数字来管。
      const take = autoRoom;
      if (take > 0) {
        // 并发 3：一封信实测 31-43s（瓶颈是 AI 生成草稿，不是 Resend）。串行 25 封 = 15 分钟贴死墙，并发 3 ≈ 5 分钟。
        const r = await sendApprovedBatch(env, take, undefined, true, { concurrency: SEND_CONCURRENCY, budget });
        autoSent = r.sent;
        // ⚠️ 必须报**取了几条**，不只报发了几封 —— "取 6 发 0" 和 "取 0 发 0" 是完全不同的两件事：
        //   前者=有池子但全被跳过（压制/幂等/无草稿），后者=池子本来就空。只报 sent 会把这两者混成一句话，
        //   而今天查"20 小时没发信"时，正是因为分不清这两者才多绕了一圈。
        console.log(`auto-send: 取 ${r.processed} 条 → 发出 ${autoSent} 封（本轮额度 ${take}，Joe 设的自动上限 ${autoLimit}/天，全局 ${r.dailyLimit}，今日已发 ${r.sentToday}）`);
        if (r.processed && !autoSent && !r.truncatedByTime) {
          const why = r.results.filter((x) => !x.ok).map((x) => x.skipped || x.error).slice(0, 3).join(" / ");
          console.log(`auto-send: 有池子但一封没发出，前几条原因：${why}`);
        }
      } else console.log(`auto-send: 今日自动额度已用尽（${autoLimit}/天，这是 Joe 设的，正常）`);
    }
  } catch (e) { console.error("auto-send:", e); }

  // 3) 收回复已挪到 **step 0**（cron 最前面）—— 见那里的注释。这里只留个路标防止有人再排回来。
  subMark("3.5-跟进");
  // 3.5) 无回复自动跟进（仅当开关开启；遵守每日上限）
  // ⭐ P0-1：原来是 `sendFollowupBatch(env, 5)` —— **跟进也被锁在 20 封/天**（4班×5），同一个病。
  //   现在传当天剩余额度：`daily_send_limit` 是唯一的闸，它是 Joe 的旋钮。
  //   （sendFollowupBatch 内部还会再 min 一次 dailyLimit-already，传大了也不会突破。）
  // ⚠️ 时间预算见底就整段跳过 —— 跟进比初次触达低一档：真客户的第一封信优先于第二次催。
  //   跳过要说出来，别静默。
  try {
    // 走唯一咽喉点 + 冷发口径（与 sendFollowupBatch 内部同闸同计数 → 传进去的数不会再被"悄悄改小"）。
    const { effective: fuLimit } = await systemDailySendLimit(env);   // 跟进=批量通道，走 effective
    const fuRoom = Math.max(0, fuLimit - (await coldSentToday(env)));
    if (!budget.has(90_000)) console.log(`followup: 本轮时间预算只剩 ${Math.round(budget.remaining()/1000)}s，跳过跟进，下轮继续（平台限制，非 Joe 的上限）`);
    else if (fuRoom <= 0) console.log(`followup: 今日发信额度已用尽（${fuLimit}/天，Joe 设的）`);
    else await sendFollowupBatch(env, fuRoom);
  } catch (e) { console.error("followup:", e); }

  // 3.55) 顺带修①「没回音出口」：跟进次数用尽 + 又过了 X 天还是没回应 → 归档。
  //
  // 为什么需要：现在这批人**没有出口** —— 跟进发完 followup_max 次后，它们永远躺在「已发送」格里，
  // 既不会再被跟进（HAVING sent_count <= max 把它们排除了），也不会消失。格子只涨不消 =
  // Joe 打开就看到一堆早已没戏的线索，真正该看的被淹掉。
  //
  // 归档到既有的 `ignored`（＝归档桶），**不新开状态**：
  //   · `no_reply` 是我在批③A 删掉的孤儿状态，重新加它要动 ALLOWED_STATUS + 分组 + 徽章 + 左栏，
  //     那不叫"顺带修"；
  //   · 而且 D 正在重新设计状态（归档是个桶），新开一个 D 大概率要改名。
  //   原因写进 notes（详情页看得见），别让"机器放弃了"和"Joe 主动忽略"完全分不出来。
  //
  // ⚠️ 只碰 status='sent'：已回复/成交/退订/黑名单/退信 天然不在范围内。
  try {
    const noReplyDays = Math.max(1, Number(await getSetting(env, "no_reply_days", "7")) || 7);
    const maxFollowups = Math.max(1, Number(await getSetting(env, "followup_max", "3")) || 3);
    const r = await env.DB.prepare(
      `UPDATE leads SET status='ignored',
              notes = substr(COALESCE(notes,'') || char(10) || '[' || datetime('now') || '] 自动归档·没回音：跟进已发满且 '
                      || ? || ' 天无任何回应', -4000),
              updated_at = datetime('now')
        WHERE id IN (
          SELECT l.id FROM leads l JOIN emails e ON e.lead_id=l.id AND e.status='sent'
           WHERE l.status='sent'
           GROUP BY l.id
          HAVING COUNT(e.id) > ?                                   -- 跟进次数已用尽（初次信也算在 sent_count 里）
             AND MAX(e.sent_at) <= datetime('now', ?)              -- 最后一封发出后又过了 X 天
        )`
      // ⚠️ noReplyDays 绑成**字符串**：绑 JS number 时 SQLite 会渲染成 "7.0 天"，Joe 看到的就是这行字
    ).bind(String(noReplyDays), maxFollowups, `-${noReplyDays} days`).run();
    if (r.meta.changes) console.log(`no-reply archive: ${r.meta.changes} 条（跟进发满 + ${noReplyDays} 天无回应）→ 已归档`);
  } catch (e) { console.error("no-reply-archive:", e); }
  // 3.6) 关键词优化：按真实回复率重算权重（放发送/回复之后，让新数据参与本轮加权）
  try { await recomputeKeywordStats(env); } catch (e) { console.error("kwstats:", e); }
  // 3.7) 清理落地页频率限制表（>1 天的旧记录，防膨胀）
  try { await env.DB.prepare("DELETE FROM inbound_throttle WHERE last_at < datetime('now','-1 day')").run(); } catch (e) { console.error("throttle-cleanup:", e); }

  subMark("4-简报告警");
  // 4) 简报推飞书（配了 webhook + 未关闭 + 本轮有动静 + **距上次 ≥6 小时**）
  //    两档制：简报报"机器干了什么"（自动批准/自动发信）+"有没有需要你的事"（翻牌堆积压），
  //    不再列「高分客户」——那个清单在自动通道下没有动作含义。
  //
  // ⭐⭐ **这是我 P0-1 提频时埋的雷，不是文案问题，是行为真的变了。**
  //   原来 cron 每 6 小时一班，"每班有动静就推" == 一天最多 4 条。
  //   我把 cron 提到每小时（`0 * * * *`）之后，**这段一个字没动**，于是它变成
  //   **一天最多 24 条** —— Joe 的飞书群会被简报刷屏。
  //   而我自己在收回复告警那儿刚写过：**噪音会让 Joe 学会无视告警，那比不告警更糟。**
  //   简报刷屏的代价不是"烦"，是**他会开始不看飞书** —— 那样真警报（熔断 / 收回复失败）
  //   也跟着一起瞎了。
  //
  // ⚠️ 教训：**简报的节奏和 cron 的节奏本来就是两件事，只是以前碰巧相等，所以没人写出来。**
  //   提频把这个隐含耦合暴露了。现在显式化：**简报 6 小时一条，不管 cron 多久一班。**
  //   （这不是 Joe 的旋钮——通知节奏跟"每天发几封"不是一类。真要可配再说。）
  const DIGEST_MIN_GAP_MS = 6 * 60 * 60 * 1000;
  try {
    const hasNews = !!(inserted || analyzed || replies || autoApproved || autoSent);
    const lastDigest = Number(await getSetting(env, "digest_last_at", "0")) || 0;
    const digestDue = Date.now() - lastDigest >= DIGEST_MIN_GAP_MS;
    if (hasNews && !digestDue) {
      console.log(`digest: 本轮有动静，但距上次简报 ${Math.round((Date.now() - lastDigest) / 60000)} 分钟（<6h），跳过 —— 提频后不刷屏`);
    }
    // 批㉔：webhook 或应用机器人任一配了就推；两路**并行双发**（老 webhook 不删，应用版供 Joe 主用）
    if ((larkConfigured(env) || larkAppConfigured(env)) && (await getSetting(env, "notify_enabled", "1")) !== "0" && hasNews && digestDue) {
      let needYou = 0;
      try {
        needYou = (await env.DB.prepare(
          `SELECT COUNT(*) AS n FROM leads l JOIN lead_analysis a ON a.lead_id=l.id
            WHERE l.status IN ('analyzed','pending') AND a.match_score IS NOT NULL AND a.match_score < ${APPROVE_MIN_SCORE}`
        ).first<{ n: number }>())?.n || 0;
      } catch (e) { console.error("digest-needyou:", e); }
      const dc = digestCard({ inserted, analyzed, replies, autoApproved, autoSent, needYou, appUrl: env.ADMIN_URL || env.APP_URL });
      if (larkConfigured(env)) await larkSend(env, dc);
      try { const r = await sendAppCard(env, dc.card); if (!r.ok && !r.error?.includes("未配置")) console.error("digest-appbot:", r.error); } catch (e) { console.error("digest-appbot:", e); }
      // ⚠️ 推完才记时刻：推失败（飞书挂了）不该把这 6 小时的窗口白白吃掉。
      await setSetting(env, "digest_last_at", String(Date.now()));
    }
  } catch (e) { console.error("digest:", e); }

  // 4.5) ⭐⭐ 静默停摆告警 —— 机器不干活时**必须有人知道**。
  //
  // 2026-07-28 的事故：Serper 额度 **07-23 就耗尽**、找客户完全停摆，
  //   **132 轮 cron 全部空转、5 天没有任何人知道**。最后是 Joe 随口一问、
  //   我从一行日志里读出来的 —— 那不是机制，那是运气。
  //
  // 为什么原来一定会静默：上面那段简报的条件是 `hasNews && digestDue`，而
  //   `hasNews = inserted||analyzed||replies||autoApproved||autoSent`。
  //   **全 0 时简报整段跳过** —— 于是"在干活但没产出"和"根本没在干活"
  //   表现为**一模一样的沉默**。**系统越是彻底坏掉，它越安静。**
  //
  // ⚠️ 判据**量目标本身** = 连续多少轮**零产出**（这正是我们关心的东西），
  //    而不是去查某个计数器涨没涨 —— 计数器不涨也可能只是没数据可跑，那是替身不是目标。
  // ⚠️ 零产出**不等于**故障（半夜确实可能没活干）→ 连续 N 轮才吼；
  //    且告警里**必须带最近的失败原文**，让人一眼看到该查哪。只说"停了"等于没说。
  try {
    const stallRounds = Math.max(2, Number(await getSetting(env, "stall_alert_rounds", "6")) || 6);
    const produced = !!(inserted || analyzed || replies || autoApproved || autoSent || emailsFound);
    const ign = ignitionReport(env);
    if (!ign.coreReady) {
      // ⭐ C2-C：核心链路（搜→打分→发→收）还没点火时，**零产出是预期，不是停摆**。
      //   这道告警的本意是"机器在装样子跑"，而现在机器根本还没插电 —— 报"停摆"是假故障。
      //   ⚠️ 计数器也一并归零：留着它，钥匙配上的那天会**带着一串未点火期间的旧账**立刻触发告警。
      await setSetting(env, "stall_streak", "0");
      console.log(`stall-watch skipped: 核心链路未点火（还差 ${ign.missingKeys.join(" / ")}）—— 零产出属预期`);
    } else if (produced) {
      await setSetting(env, "stall_streak", "0");
    } else {
      const streak = (Number(await getSetting(env, "stall_streak", "0")) || 0) + 1;
      await setSetting(env, "stall_streak", String(streak));
      console.log(`stall-watch: 连续 ${streak} 轮零产出（≥${stallRounds} 轮才告警）`);
      const today = new Date().toISOString().slice(0, 10);
      if (streak >= stallRounds && (await getSetting(env, "stall_alert_date", "")) !== today) {
        await setSetting(env, "stall_alert_date", today);   // 一天一条，不刷屏
        const why = [
          await getSetting(env, "serper_fail_last", ""),
          await getSetting(env, "reply_fail_last", ""),
          await getSetting(env, "find_email_run", ""),
        ].filter(Boolean).map((s) => `· ${String(s).slice(0, 160)}`).join("\n")
          || "· （各通道都没记录到失败原文 —— 可能真的没活可干，也可能某一步静默跳过了）";
        const text =
          `AIRSONDE 🔴 获客机器连续 ${streak} 轮零产出（约 ${streak} 小时）\n` +
          `新线索 / 分析 / 回复 / 自动批准 / 自动发信 / 补邮箱 **全部为 0**。\n\n` +
          `最近记录到的原文：\n${why}\n\n` +
          `⚠️ 零产出未必等于故障（也可能确实没活可干），但连续 ${streak} 轮值得看一眼。\n` +
          `（同样的告警一天只发一次）`;
        // ⚠️ **把发送结果记下来**，别吞。"没抛异常"不等于"飞书收下了" ——
        //   larkSend 对 code!=0 是返回 {ok:false} 而不是抛错，吞掉的话
        //   **告警自己静默失败**，那就成了"用来防静默的东西自己静默了"。
        try {
          if (larkConfigured(env)) {
            const r = await larkSend(env, { msg_type: "text", content: { text } });
            console.log(`stall-alert webhook: ok=${r.ok}${r.error ? " err=" + r.error : ""}`);
          } else console.log("stall-alert webhook: 未配置 LARK_WEBHOOK_URL，跳过");
        } catch (e) { console.error("stall-alert webhook 异常:", e); }
        try {
          if (larkAppConfigured(env)) await sendAppCard(env, { config: { wide_screen_mode: true },
            header: { template: "red", title: { tag: "plain_text", content: "AIRSONDE 🔴 获客机器停摆" } },
            elements: [{ tag: "div", text: { tag: "lark_md", content: text } }] });
        } catch (e) { console.error("stall-alert appbot:", e); }
        console.error(`stall-watch: 已告警（连续 ${streak} 轮零产出）`);
      }
    }
  } catch (e) { console.error("stall-watch:", e); }

  // 5) 批㉔：多维表格镜像同步（每小时增量；未配置 = 静默跳过说原因；单向只写，绝不读回）
  try {
    const r = await syncLeadsToBitable(env);
    if (r.skipped) console.log(`bitable sync skipped: ${r.skipped}`);
    else if (!r.ok) console.error(`bitable sync error: ${r.error}（水位未推进，下轮重试）`);
  } catch (e) { console.error("bitable-sync:", e); }

  // ⭐ 子请求构成表落库 —— **无条件写**（同 find_email_run 那次的教训：只在有结果时写，
  //   等于"没跑"和"跑了没结果"在数据上同形）。这是回答"那 50 个额度被谁吃掉"的唯一依据。
  //   ⚠️ 本轮**只出数字，不据此做任何限流** —— 构成表出来之前不动逻辑。
  try {
    const s = subSummary();
    console.log(`subreq: ext=${s.ext} d1=${s.d1} sock=${s.sock} 越线于=${s.crossedAt || "(未越线)"} | `
      + s.marks.map((m) => `${m.step}:+${m.ext}`).join(" "));
    await setSetting(env, "cron_subreq_last", JSON.stringify({
      at: new Date().toISOString().slice(0, 16).replace("T", " "),
      ext_total: s.ext, d1_total: s.d1, sock_total: s.sock, crossed_50_at: s.crossedAt,
      // ⚠️ 读这张表前先看这一行：**哪些 0 是"没发生"，哪些 0 是"仪器看不见"**。
      //    ext/d1 是包出口数的（可信）；sock 是在 connect() 调用点数的（不是包出口）；
      //    绕开这三者的出站一律显示为 0 —— 那种 0 是"看不见"。
      meter: s.meterCoverage,
      steps: s.marks.map((m) => ({ s: m.step, ext: m.ext, d1: m.d1, sock: m.sock, cum: m.extCum })),
    }).slice(0, 2400));
  } catch (e) { console.error("subreq summary:", e); }
}

// ⚠️ 入口的形状必须保持"default 导出一个全是函数的对象" —— 顶层 export 非函数会让 Worker
//    拒绝启动（`Incorrect type for map entry`），且 dry-run 抓不到。改这里必须真起 8788。
// devguard：本地进程的出站闸门。装在入口 = fetch 和 scheduled(cron) **两条路都兜住**，
//    不是只兜 HTTP 那条（③ 号事故就是 cron 路径推的飞书）。生产 DEV_LOCAL 不存在 → 空操作。
// ⭐ normalizeEnv 也装在这个入口，理由与 devguard 完全相同：**fetch 和 scheduled 两条路都要兜住**。
//    它洗掉密钥值上的 BOM/空白/引号（2026-08-31 生产实证：OpenRouter key 头部粘了 UTF-8 BOM，
//    authorization 头非法；同一批钥匙里 LARK_WEBHOOK_URL 因此过不了 http 正则、界面报"还没配"）。
//    ⚠️ 洗归洗，**脏了的那几把会在点火面板上被点名**（dirtySecretKeys）——不掩盖。
export default {
  fetch: (req: Request, env: Env, ctx: ExecutionContext) => { const e = normalizeEnv(env); installDevEgressGuard(e); return app.fetch(req, e, ctx); },
  // ⭐ C5-22：两条班次分流。**判据是 event.cron 这个真值**，不是"看现在是不是整点"——
  //   后者会让每分钟的 tick 在整点那一分钟**同时跑成整点班**，于是每天多烧 24 次搜索预算；
  //   而且它是那种"平时看不出来、只在整点出错"的病。
  // ⚠️ 分流必须**穷尽**：cron 字符串对不上时走整点班（保守），不是静默什么都不做 ——
  //   静默不做会让"班次没配对"长得跟"没活干"一模一样。
  scheduled: (event: ScheduledController, env: Env, ctx: ExecutionContext) => {
    const e = normalizeEnv(env); installDevEgressGuard(e);
    if (event.cron === "* * * * *") return fastTick(e, ctx);
    return scheduled(event, e, ctx);
  },
};
