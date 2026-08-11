// 批㉔：Lark 应用机器人（AirSonde CRM）—— 多维表格镜像同步 + 带操作按钮的卡片 + 回调校验。
// 与 notify.ts（自定义机器人 webhook）**并行不替代**：老 webhook 通知照发，这里是应用能力层。
// 国际版 Lark：所有 API 走 open.larksuite.com（本地联调需 DEV_EGRESS_ALLOW=open.larksuite.com）。
import type { Env } from "./index";
import { getSetting, setSetting } from "./send";
import { larkConfigured, larkSend } from "./notify";
// 批㉗：Base「国家」列中文化。COUNTRIES(discover.ts) 本身就是 码→中文 的 133 国全集单真源——
// 直接 import,不新建复制件（能 import 绝不复刻;前端 COUNTRY_NAMES 也是运行时从它合并的）。
import { COUNTRIES } from "./discover";

const LARK_BASE = "https://open.larksuite.com";

// ---- L1-B3：Basic API 月用量自计数（免费版 1万/月硬顶,超限 429/99991403）----
// 单一咽喉=larkApi()：所有 tenant-token 调用都从这走（出站闸门一个口子的同一条原则）。
// token 接口有 2h 缓存不计（~12次/天,且鉴权类大概率不计量——宁可少算的部分用 8000 阈值的余量兜）。
// 计数/提醒失败绝不拖垮业务调用；提醒走**自定义机器人 webhook**（不计量通道,不吃配额也无重入）。
async function bumpApiUsage(env: Env): Promise<void> {
  try {
    const month = new Date().toISOString().slice(0, 7);
    const key = `lark_api_used_${month}`;
    const n = (Number(await getSetting(env, key, "0")) || 0) + 1;
    await setSetting(env, key, String(n));
    if (n >= 8000 && (await getSetting(env, "lark_api_alert_month", "")) !== month) {
      await setSetting(env, "lark_api_alert_month", month);   // 先记再吼：吼失败也不重复吼
      if (larkConfigured(env)) await larkSend(env, { msg_type: "text", content: { text:
        `AIRSONDE ⚠️ Lark 开放平台 API 本月已用 ${n}/10000 次（免费版硬顶）\n` +
        `超限后镜像同步/卡片按钮会 429。省法：等下月额度、或减少同步频率、或升级套餐。\n（本提醒每月最多一次）` } });
    }
  } catch (e) { console.error("bumpApiUsage:", e); }
}

export function larkAppConfigured(env: Env): boolean {
  return !!(env.LARK_APP_ID && env.LARK_APP_SECRET);
}

// ---- tenant_access_token（缓存进 settings，token 有效 2h，提前 5 分钟刷新）----
export async function getTenantToken(env: Env): Promise<string> {
  const cached = await getSetting(env, "lark_tenant_token", "");
  if (cached) {
    try {
      const { token, exp } = JSON.parse(cached);
      if (token && exp - 300 > Date.now() / 1000) return token;
    } catch { /* 缓存坏了就重取 */ }
  }
  const res = await fetch(`${LARK_BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app_id: env.LARK_APP_ID, app_secret: env.LARK_APP_SECRET }),
  });
  const data: any = await res.json().catch(() => ({}));
  if (data.code !== 0 || !data.tenant_access_token) {
    throw new Error(`lark token 获取失败: code=${data.code} ${data.msg || ""}`);
  }
  await setSetting(env, "lark_tenant_token", JSON.stringify({
    token: data.tenant_access_token,
    exp: Math.floor(Date.now() / 1000) + (data.expire || 7200),
  }));
  return data.tenant_access_token;
}

async function larkApi(env: Env, method: string, path: string, body?: any): Promise<any> {
  const token = await getTenantToken(env);
  await bumpApiUsage(env);   // 计请求数（含失败的——限额按请求算,宁多算不少算）
  const res = await fetch(`${LARK_BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data: any = await res.json().catch(() => ({}));
  if (data.code !== 0) throw new Error(`lark api ${path} 失败: code=${data.code} ${data.msg || ""}`);
  return data;
}

// ---- chat_id 自动发现（总工定的路）：settings 为空时调 /im/v1/chats（机器人所在群）并写回。
//   需要 im:chat 只读权限（Joe 在补开）；权限没到 API 会报错 → 保持未配置态不炸，权限一到即通。
//   机器人恰在 1 个群 → 直接用；多个群 → 不猜，log 列出来等人工选（写错群=打扰别人）。
export async function discoverChatId(env: Env): Promise<string> {
  const existing = await getSetting(env, "lark_chat_id", "");
  if (existing) return existing;
  if (!larkAppConfigured(env)) return "";
  try {
    const resp = await larkApi(env, "GET", `/open-apis/im/v1/chats?page_size=20`);
    const items: any[] = resp.data?.items || [];
    if (items.length === 1) {
      const cid = items[0].chat_id;
      await setSetting(env, "lark_chat_id", cid);
      console.log(`lark chat_id 自动发现并写回: ${cid}（群「${items[0].name || "?"}」）`);
      return cid;
    }
    if (items.length > 1) console.log(`lark chat_id 发现 ${items.length} 个群，不自动选（防写错群）: ${items.map((i) => `${i.name}=${i.chat_id}`).join(" | ")}`);
    return "";
  } catch (e: any) {
    console.log(`lark chat_id 自动发现失败（多半是 im:chat 权限未开，开了即通）: ${e.message || e}`);
    return "";
  }
}

// ---- 应用机器人发卡（chat_id 配置化：settings lark_chat_id；为空时先走自动发现）----
export async function sendAppCard(env: Env, card: any): Promise<{ ok: boolean; error?: string }> {
  if (!larkAppConfigured(env)) return { ok: false, error: "未配置 LARK_APP_ID/SECRET" };
  const chatId = (await getSetting(env, "lark_chat_id", "")) || (await discoverChatId(env));
  if (!chatId) return { ok: false, error: "未配置 lark_chat_id（自动发现也没拿到——多半等 im:chat 权限）" };
  try {
    await larkApi(env, "POST", `/open-apis/im/v1/messages?receive_id_type=chat_id`, {
      receive_id: chatId,
      msg_type: "interactive",
      content: JSON.stringify(card),
    });
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e.message || String(e) };
  }
}

// ---- 带操作按钮的热回复卡（应用机器人版；老 webhook 版在 notify.ts 照发不动）----
// 按钮动作走 /api/webhooks/lark-card 回调 → 现有内部函数（护栏一条不绕）。
// ⚠️ 发送类动作不上卡片（发邮件必须回后台确认）。
export function actionReplyCard(r: { leadId: number; company?: string; from?: string; category?: string; summary?: string; snippet?: string; appUrl?: string }) {
  const CAT: Record<string, string> = { interested: "🔥 有意向", inquiry: "💬 询价", complaint: "⚠️ 投诉", not_interested: "无兴趣", other: "其他" };
  const elements: any[] = [
    { tag: "div", fields: [
      { is_short: true, text: { tag: "lark_md", content: `**公司**\n${r.company || "(未知)"}` } },
      { is_short: true, text: { tag: "lark_md", content: `**来自**\n${r.from || "-"}` } },
    ] },
  ];
  if (r.summary) elements.push({ tag: "div", text: { tag: "lark_md", content: `**AI 摘要**\n${r.summary}` } });
  if (r.snippet) elements.push({ tag: "div", text: { tag: "plain_text", content: r.snippet.replace(/\n+/g, " ").slice(0, 160) } });
  const actions: any[] = [
    { tag: "button", text: { tag: "plain_text", content: "✅ 标记洽谈中" }, type: "primary", value: { a: "talk", id: r.leadId } },
    { tag: "button", text: { tag: "plain_text", content: "📅 安排跟进(明天)" }, type: "default", value: { a: "follow", id: r.leadId } },
  ];
  if (r.appUrl) actions.push({ tag: "button", text: { tag: "plain_text", content: "打开详情" }, type: "default", url: `${r.appUrl}/?lead=${r.leadId}` });
  elements.push({ tag: "action", actions });
  return {
    config: { wide_screen_mode: true },
    header: {
      template: r.category === "complaint" ? "red" : "green",
      title: { tag: "plain_text", content: `AIRSONDE 新回复 · ${CAT[r.category || "other"] || r.category}` },
    },
    elements,
  };
}

// ---- L2 回复工作台卡（批㉙ 按官方 Card JSON 2.0 规范整卡重建）----
// 200671 复盘：旧卡混入自创可选字段+按钮顺排,客户端在表单提交派发阶段崩(tail 实证零 invocation)。
// 重建原则=**最小惊喜**:逐字段对照 open.feishu.cn 表单容器/输入框/折叠面板官方文档,
// 官方示例没有的可选字段一律不写;按钮进 column_set(官方示例形态);input/form 带版本 fallback。
// 3 秒窗铁律不变:LLM 起草只在推卡时(draft 字段),回调里绝不起草。
export function replyWorkbenchCard(r: { leadId: number; replyId: number; company?: string; from?: string;
  category?: string; summary?: string; snippet?: string; draft?: string; appUrl?: string }) {
  const CAT: Record<string, string> = { interested: "🔥 有意向", inquiry: "💬 询价", other: "其他" };
  const catLabel = CAT[r.category || "other"] || String(r.category || "");
  const company = r.company || "(未知)";
  // 原文首行预览：词边界截断+省略号（禁止拦腰断词——英文在最后一个空格处收,中文按字符收）
  const flat = String(r.snippet || "").replace(/\s+/g, " ").trim();
  let preview = flat;
  if (flat.length > 42) {
    const cut = flat.slice(0, 42);
    const sp = cut.lastIndexOf(" ");
    preview = (sp > 20 ? cut.slice(0, sp) : cut) + "…";
  }
  const btn = (name: string, content: string, type: string, a: string) => ({
    tag: "column", width: "auto", elements: [{
      tag: "button", name, type, text: { tag: "plain_text", content },
      form_action_type: "submit", value: { a, id: r.leadId, rid: r.replyId },
    }],
  });
  const elements: any[] = [
    // 信息区两列：公司｜来自 并排（规格②）
    { tag: "column_set", horizontal_spacing: "8px", columns: [
      { tag: "column", width: "weighted", weight: 1,
        elements: [{ tag: "markdown", content: `**公司**
${company}` }] },
      { tag: "column", width: "weighted", weight: 1,
        elements: [{ tag: "markdown", content: `**来自**
${r.from || "-"}` }] },
    ] },
  ];
  if (r.summary) elements.push({ tag: "markdown", content: `**AI 摘要** ${r.summary}` });
  if (flat) elements.push({
    // 客户原文折叠面板：默认收起,标题=首行预览（规格③）。面板不许内嵌 form——原文只装 markdown。
    tag: "collapsible_panel", expanded: false, background_color: "grey",
    header: { title: { tag: "markdown", content: `**客户原文** ${preview}` } },
    elements: [{ tag: "markdown", content: flat.slice(0, 1500) }],
  });
  elements.push({ tag: "hr" });
  elements.push({ tag: "markdown", content: "✍️ **AI 草稿 · 可直接修改后发送**" });
  elements.push({
    tag: "form", name: "reply_form",
    elements: [
      { tag: "input", name: "reply_body", required: true, width: "fill",
        input_type: "multiline_text", rows: 6, auto_resize: true, max_rows: 12,
        default_value: r.draft || "",
        placeholder: { tag: "plain_text", content: "AI 草稿已预填，可直接编辑后发送" },
        fallback: { tag: "fallback_text", text: { tag: "plain_text", content: "输入框需 Lark V6.8+，低版本请到后台处理" } } },
      // 三按钮横排一行（规格⑤,官方示例的 column_set 形态）
      { tag: "column_set", horizontal_spacing: "8px", columns: [
        btn("b_send", "📧 发送回信", "primary", "rsend"),
        btn("b_ignore", "忽略", "default", "rignore"),
        btn("b_black", "🚫 转黑名单", "danger", "rblack"),
      ] },
    ],
    fallback: { tag: "fallback_text", text: { tag: "plain_text", content: "表单需 Lark V6.6+，低版本请到后台处理" } },
  });
  if (r.appUrl) elements.push({ tag: "markdown", content: `[打开后台详情](${r.appUrl}/?lead=${r.leadId})` });
  return {
    schema: "2.0",
    // 标题带公司名（规格①）：「💬 询价 · XX公司」式绿头
    header: { template: "green", title: { tag: "plain_text", content: `${catLabel} · ${company}` } },
    body: { elements },
  };
}

// v2 结果卡（回调响应/消息 PATCH 用——v2 卡必须用 v2 更新,不混 v1 结构）
export function replyDoneCardV2(title: string, detail: string, template: "green" | "red" | "grey" = "grey") {
  return {
    schema: "2.0",
    header: { template, title: { tag: "plain_text", content: title } },
    body: { elements: [{ tag: "markdown", content: detail }] },
  };
}

// 消息 PATCH（发送这类可能超 3 秒窗的动作：回调先回 toast「发送中」,后台完成后拿
// open_message_id 把卡片更新成结果卡——规格③指定路径）
export async function patchCardMessage(env: Env, messageId: string, card: any): Promise<{ ok: boolean; error?: string }> {
  if (!messageId) return { ok: false, error: "no message_id" };
  try {
    await larkApi(env, "PATCH", `/open-apis/im/v1/messages/${messageId}`, { content: JSON.stringify(card) });
    return { ok: true };
  } catch (e: any) { return { ok: false, error: e.message || String(e) }; }
}

// 动作完成后的替换卡（回调响应里原地更新；不重建原卡，给一张明确的结果卡）
export function doneCard(txt: { title: string; company?: string; detail: string; appUrl?: string; leadId?: number }) {
  const elements: any[] = [
    { tag: "div", text: { tag: "lark_md", content: `**${txt.company || ""}**\n${txt.detail}` } },
  ];
  if (txt.appUrl && txt.leadId) {
    elements.push({ tag: "action", actions: [{ tag: "button", text: { tag: "plain_text", content: "打开详情" }, type: "default", url: `${txt.appUrl}/?lead=${txt.leadId}` }] });
  }
  return {
    config: { wide_screen_mode: true },
    header: { template: "grey", title: { tag: "plain_text", content: txt.title } },
    elements,
  };
}

// 测试卡（应用机器人版，带一颗真按钮打到回调 → 端到端验收用；lead id=0 是哨兵，回调側拒绝执行真动作）
export function testAppCard(appUrl?: string) {
  return {
    config: { wide_screen_mode: true },
    header: { template: "turquoise", title: { tag: "plain_text", content: "AIRSONDE 应用机器人 · 测试 ✅" } },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: "这张卡来自**应用机器人**（非 webhook）。按钮回调链路可用下面的测试按钮验证——它不会碰任何真实线索。" } },
      { tag: "action", actions: [
        { tag: "button", text: { tag: "plain_text", content: "🧪 测试按钮回调" }, type: "default", value: { a: "ping", id: 0 } },
        ...(appUrl ? [{ tag: "button", text: { tag: "plain_text", content: "打开后台" }, type: "primary" as const, url: appUrl }] : []),
      ] },
    ],
  };
}

// ---- 回调校验（M4 标准：fail-closed；照 webhook.ts 的 Resend 套路）----
// ① 未配置 LARK_VERIFICATION_TOKEN → 绝不放行（503 由路由层给）；
// ② encrypt 模式不支持 → 明确拒绝（应用后台请用明文+token 校验），绝不盲解析；
// ③ token 比对常量时间。
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
export function verifyLarkCallback(env: Env, body: any): { ok: boolean; status: number; error?: string } {
  const secret = env.LARK_VERIFICATION_TOKEN;
  if (!secret) return { ok: false, status: 503, error: "未配置 LARK_VERIFICATION_TOKEN（fail-closed）" };
  if (body && body.encrypt) return { ok: false, status: 400, error: "encrypt 模式未支持：应用后台事件请配明文 + Verification Token" };
  const token = String(body?.token || body?.header?.token || "");
  if (!token || !timingSafeEqual(token, secret)) return { ok: false, status: 401, error: "verification token 不符" };
  return { ok: true, status: 200 };
}

// ================= 多维表格镜像同步 =================
// 单向只写（绝不读回表格内容）；行 key = lead id，本地映射表 lark_bitable_map 记 record_id。
// 配置：settings lark_bitable_app_token / lark_bitable_table_id（Joe 发表格链接后由总工写入）。
// 增量水位：lark_bitable_last_sync（>= 边界重复 upsert 幂等，不丢行）。

// ⭐ 字段映射唯一真源（24 列）。⚠️ 列名与 Joe 真表**逐字一致**（bitable 按字段名写，一字不合=静默丢列）。
//   已用 /api/lark/bitable-fields 对账器与真表核对（aligned=true）——改表结构后先跑对账器再改这里。
//   真表拉到的 24 列：ID/公司/网址/邮箱/阶段/评分/分类/客户类型/国家/来源/关键词/AI 判断理由(有空格)/
//   （2026-07-25 热修：Joe 在表内把「国家码」改名「国家」→ 映射跟随，FieldNameNotFound 生产实证后对齐）
//   LinkedIn/WhatsApp/Facebook/Instagram/电话/已发信数/回复数/下一步/下一步日期/最后参与时间/录入时间/原始状态
export function leadToBitableFields(l: any): Record<string, any> {
  let ch: Record<string, string> = {};
  try { ch = l.channels ? JSON.parse(l.channels) : {}; } catch { /* 坏 JSON 当无渠道 */ }
  const score = l.match_score == null ? null : Number(l.match_score);
  return {
    "ID": Number(l.id),   // ⚠️ Joe 表的 ID 列是数字字段（Excel 导入数字列自动成 Number）——传字符串会类型不匹配
    "公司": l.company_name || "",
    // ⚠️ 「网址」是**超链接字段**（type=15，总工真凭据实测定罪）：纯字符串会被拒，
    //    必须传 {link,text} 对象；空网址传 null（空字符串的 url 对象同样可能被拒）。
    "网址": l.website ? { link: l.website, text: l.website } : null,
    "邮箱": l.email || "",
    "阶段": stageCn(l.status, score),
    "评分": score,
    "分类": l.customer_category || "",
    "客户类型": l.customer_type || "",
    // 批㉗ Joe 需求：与后台一致显示中文。未知码回退原码、空值回空串（绝不 undefined）。
    "国家": (() => { const c = String(l.country || "").toLowerCase(); return c ? (COUNTRIES[c] || String(l.country)) : ""; })(),
    "来源": l.source || "",
    "关键词": l.keyword || "",
    "AI 判断理由": (l.reason || "").slice(0, 900),
    "LinkedIn": ch.linkedin || "",
    "WhatsApp": ch.whatsapp || "",
    "Facebook": ch.facebook || "",
    "Instagram": ch.instagram || "",
    "电话": ch.phone || "",
    "已发信数": Number(l.sent_count || 0),
    "回复数": Number(l.reply_count || 0),
    "下一步": l.next_action || "",
    "下一步日期": l.next_action_date || "",
    "最后参与时间": l.last_engaged_at || "",
    "录入时间": l.created_at || "",
    "原始状态": l.status || "",
  };
}

// 阶段中文（与左栏八格 label 同语义；status+有无分数派生，服务端版）
export function stageCn(status: string, score: number | null): string {
  switch (status) {
    case "new": return "待分析";
    case "analyzed": case "pending": return score == null ? "待分析" : "待审批";
    case "approved": case "queued": return "待联系";
    case "sent": return "已联系";
    case "replied": return "已回复";
    case "won": return "已成交";
    case "ignored": return "已忽略";
    case "unsubscribed": case "blacklisted": case "bounced": return "黑名单";
    default: return status;
  }
}

// 列名对账器：拉真表字段（schema，非数据——不违反"单向只写"）与 leadToBitableFields 的键逐字比对。
// bitable 按**字段名**写，一字不合就静默丢列 —— 联调第一步必跑，上线后也可随时复核。
export async function bitableFieldsCheck(env: Env): Promise<any> {
  const appToken = await getSetting(env, "lark_bitable_app_token", "");
  const tableId = await getSetting(env, "lark_bitable_table_id", "");
  if (!appToken || !tableId) return { error: "未配置 lark_bitable_app_token/table_id" };
  const resp = await larkApi(env, "GET", `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields?page_size=100`);
  const items: any[] = resp.data?.items || [];
  const tableFields: string[] = items.map((f: any) => f.field_name);
  // 类型也要对（两轮教训：①ID 是 Number 传 String 炸——名对上≠类型对上；②「网址」是超链接(15)
  //   传纯字符串也炸，要 {link,text} 对象——初版谓词只有 number/非number 二元判定，url 列漏判）。
  // bitable type: 1=多行文本 2=数字 3=单选 15=超链接 …。谓词：
  //   传 number → 表必须 2；传 object({link,text}) → 表必须 15；传 string → 表是 2 或 15 都算不匹配。
  const typeOf = new Map<string, number>(items.map((f: any) => [f.field_name, Number(f.type)]));
  const sample = leadToBitableFields({ id: 1, website: "https://x.com", channels: null });
  const mapped = Object.keys(sample);
  const typeMismatch = mapped
    .filter((k) => typeOf.has(k))
    .filter((k) => {
      const v = sample[k];
      const t = typeOf.get(k)!;
      if (v === null) return false;                             // null（空评分/空网址）各类型都收，放过
      if (typeof v === "number") return t !== 2;                // 数字 → 表必须数字列
      if (typeof v === "object") return t !== 15;               // {link,text} → 表必须超链接列
      return t === 2 || t === 15;                               // 字符串 → 撞数字列或超链接列都不行
    })
    .map((k) => ({ field: k, iSend: typeof sample[k], tableType: typeOf.get(k) }));
  return {
    tableFields,
    mapped,
    missingInTable: mapped.filter((k) => !tableFields.includes(k)),   // 我在写、表里没有 → 会被静默丢
    notMapped: tableFields.filter((k) => !mapped.includes(k)),        // 表里有、我没写 → 空列（可接受）
    typeMismatch,                                                     // 名对上但类型不对 → 整请求报错
    aligned: mapped.every((k) => tableFields.includes(k)) && typeMismatch.length === 0,
  };
}

const SYNC_BATCH = 200;    // 每轮最多同步的线索数（cron 每小时一轮，追平后每轮只有增量）
const CHUNK = 100;         // bitable batch API 单次上限内的安全块

export async function syncLeadsToBitable(env: Env): Promise<{ ok: boolean; skipped?: string; created?: number; updated?: number; removed?: number; error?: string }> {
  if (!larkAppConfigured(env)) return { ok: false, skipped: "未配置 LARK_APP_ID/SECRET" };
  const appToken = await getSetting(env, "lark_bitable_app_token", "");
  const tableId = await getSetting(env, "lark_bitable_table_id", "");
  if (!appToken || !tableId) return { ok: false, skipped: "未配置 lark_bitable_app_token/table_id（Joe 发表格链接后写入）" };

  // 本地映射表（幂等建表；schema.sql 的清洁库问题在 #45 批，另案）
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS lark_bitable_map (lead_id INTEGER PRIMARY KEY, record_id TEXT NOT NULL, synced_at TEXT)"
  ).run();

  // ---- L1-B1/B2：活跃线索镜像 —— 排除态（黑名单/退订/已忽略）不进 Base，已在镜像里的清退。----
  // 存量清理与增量转出走**同一条对账路径**：凡"还挂着映射的排除态线索"→ Base batch_delete + 删映射。
  // 每轮自愈,不靠水位捕捉转态瞬间（转态时 updated_at 没动也逃不掉）。
  // 裁定"删除 vs 归档"选**删除**：真源在 D1 一条不丢（CRM 里黑名单/已忽略照常可查）,
  // 归档表=双倍写调用+第二张 2000 行倒计时,Base 只是驾驶舱视图——没有归档价值。
  // batch_delete 单次上限 500,沿用 CHUNK=100 分块（存量一次性多 1-2 个调用,换代码同构）。
  const EXCLUDED_SQL = "'blacklisted','unsubscribed','ignored'";
  let removed = 0;
  const exRows = (await env.DB.prepare(
    `SELECT m.lead_id, m.record_id FROM lark_bitable_map m JOIN leads l ON l.id = m.lead_id
     WHERE l.status IN (${EXCLUDED_SQL}) LIMIT 500`
  ).all()).results as any[];
  for (let i = 0; i < exRows.length; i += CHUNK) {
    const chunk = exRows.slice(i, i + CHUNK);
    let cleanable = chunk;   // 本 chunk 里"确认 Base 侧已不存在"、可以清映射的行
    try {
      await larkApi(env, "POST",
        `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_delete`,
        { records: chunk.map((r) => String(r.record_id)) });
    } catch (eb: any) {
      const batchErr = eb?.message || String(eb);
      console.error(`bitable batch_delete 原始失败: ${batchErr}`);
      if (/token 获取失败|code=99991|Unauthorized/i.test(batchErr)) return { ok: false, error: batchErr };
      // 降级逐条：行已被 Joe 手删（NotFound 类）＝目的已达成,照常清映射；真基础设施错→留映射下轮重试。
      // ⚠️ 收集式而非边遍历边 splice（后者会跳元素——e2e 前自查抓的）。
      cleanable = [];
      for (const r of chunk) {
        try {
          await larkApi(env, "DELETE",
            `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/${r.record_id}`);
          cleanable.push(r);
        } catch (e2: any) {
          const msg = e2?.message || String(e2);
          if (/NotFound|not exist|1254043|deleted/i.test(msg)) cleanable.push(r);   // 已不存在=达成
          else console.error(`bitable delete 单条失败(lead ${r.lead_id}),留映射下轮重试: ${msg}`);
        }
      }
    }
    if (cleanable.length) {
      const stmts = cleanable.map((r) => env.DB.prepare("DELETE FROM lark_bitable_map WHERE lead_id = ?").bind(r.lead_id));
      await env.DB.batch(stmts);
      removed += cleanable.length;
    }
  }
  if (removed) console.log(`bitable sync: 清退排除态镜像 ${removed} 行（黑名单/退订/已忽略）`);

  const watermark = await getSetting(env, "lark_bitable_last_sync", "1970-01-01 00:00:00");
  const allRows = (await env.DB.prepare(
    `SELECT l.*, a.match_score, a.customer_type, a.customer_category, a.reason,
            (SELECT COUNT(*) FROM emails e WHERE e.lead_id=l.id AND e.status='sent') AS sent_count,
            (SELECT COUNT(*) FROM replies r WHERE r.lead_id=l.id) AS reply_count
     FROM leads l LEFT JOIN lead_analysis a ON a.lead_id = l.id
     WHERE l.updated_at >= ? ORDER BY l.updated_at ASC LIMIT ${SYNC_BATCH}`
  ).bind(watermark).all()).results as any[];
  if (!allRows.length) return { ok: true, created: 0, updated: 0, removed };

  // L1-B1：排除态不进 create/update（新黑名单永不镜像;清退已由上面的对账路径负责）。
  // ⚠️ 水位仍按 allRows 全集推进——排除态扎堆的窗口不能卡住水位。
  const rows = allRows.filter((r) => !["blacklisted", "unsubscribed", "ignored"].includes(String(r.status)));

  // 已有映射的走 update，没有的走 create
  // ⚠️ D1 每查询绑定变量上限 100（生产实测炸出 D1_ERROR: too many SQL variables；
  //    本地 miniflare=裸 SQLite 上限 999 复现不了）→ IN 查询必须分块 ≤100。
  const ids = rows.map((r) => r.id);
  const recOf = new Map<number, string>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    const mapRows = (await env.DB.prepare(
      `SELECT lead_id, record_id FROM lark_bitable_map WHERE lead_id IN (${part.map(() => "?").join(",")})`
    ).bind(...part).all()).results as any[];
    for (const m of mapRows) recOf.set(Number(m.lead_id), String(m.record_id));
  }

  const toCreate = rows.filter((r) => !recOf.has(r.id));
  const toUpdate = rows.filter((r) => recOf.has(r.id));
  let created = 0, updated = 0;

  try {
    for (let i = 0; i < toCreate.length; i += CHUNK) {
      const chunk = toCreate.slice(i, i + CHUNK);
      try {
        const resp = await larkApi(env, "POST",
          `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_create`,
          { records: chunk.map((r) => ({ fields: leadToBitableFields(r) })) });
        const recs: any[] = resp.data?.records || [];
        // create 返回顺序与请求一致 → 按位记 record_id（唯一一次"读"，读的是我们刚写的行 id，不读内容）
        // ⚠️ 映射写入用 DB.batch（一次 D1 调用）：逐条 INSERT ×200 会吃 200 个 subrequest——
        //    与 IN 上限同根（单请求资源上限），一起修掉；免费计划 50/请求也能活。
        const stmts = [];
        for (let j = 0; j < chunk.length; j++) {
          const rid = recs[j]?.record_id;
          if (rid) stmts.push(env.DB.prepare(
            "INSERT OR REPLACE INTO lark_bitable_map (lead_id, record_id, synced_at) VALUES (?,?,datetime('now'))"
          ).bind(chunk[j].id, rid));
        }
        if (stmts.length) await env.DB.batch(stmts);
        created += chunk.length;
      } catch (eb: any) {
        // ⚠️ 原始批错误必须吼出来（生产实测教训：降级循环吞掉它后，response 只报"烧完 subrequest"
        //   这个**果**，真**因**（如 token 10003）只能再开 tail 挖）。
        const batchErr = eb?.message || String(eb);
        console.error(`bitable batch_create 原始失败: ${batchErr}`);
        // ⚠️ token/鉴权类失败 = infra，不是毒丸 —— 直接熔断，绝不进 per-record 降级
        //   （生产实测：token 10003 进降级 = 100 次同错重试，白烧光 subrequest 配额）。
        if (/token 获取失败|code=99991|Unauthorized/i.test(batchErr)) throw eb;
        // 降级（与 update 侧对称）：整批失败 → 逐条重试，把毒丸行揪出来。
        //   典型毒丸 = 单选字段撞新选项值（总工观察项：Bitable 可能自动建选项也可能报错）。
        //   单条也失败 → **大声吼 + 跳过该行，水位照常推进** —— 一行毒丸不准卡死整轮同步
        //   （该行下次 updated_at 变化会再被尝试；吼出的日志就是修复入口）。
        let chunkOk = 0; let lastErr = "";
        for (const r of chunk) {
          try {
            const cr = await larkApi(env, "POST",
              `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`,
              { fields: leadToBitableFields(r) });
            const rid = cr.data?.record?.record_id;
            if (rid) await env.DB.prepare(
              "INSERT OR REPLACE INTO lark_bitable_map (lead_id, record_id, synced_at) VALUES (?,?,datetime('now'))"
            ).bind(r.id, rid).run();
            created++; chunkOk++;
          } catch (e2: any) {
            lastErr = e2.message || String(e2);
            console.error(`bitable create 单条失败(lead ${r.id} ${r.company_name || ""})，服务器原话: ${lastErr}`);
          }
        }
        // ⚠️ 全军覆没 ≠ 毒丸，是基础设施故障（token 挂/权限/网络）——必须抛出去，
        //   让外层不推水位整轮重试；只有**部分成功**才是毒丸模式（跳过毒行、水位照推）。
        if (chunk.length > 0 && chunkOk === 0) throw new Error(`create 整 chunk 全失败（判基础设施故障，非毒丸）: ${lastErr}`);
      }
    }
    for (let i = 0; i < toUpdate.length; i += CHUNK) {
      const chunk = toUpdate.slice(i, i + CHUNK);
      try {
        await larkApi(env, "POST",
          `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_update`,
          { records: chunk.map((r) => ({ record_id: recOf.get(r.id), fields: leadToBitableFields(r) })) });
        updated += chunk.length;
      } catch (eb: any) {
        // 原始批错误先吼（同 create 侧教训）；token/鉴权类=infra 直接熔断不降级
        const batchErr = eb?.message || String(eb);
        console.error(`bitable batch_update 原始失败: ${batchErr}`);
        if (/token 获取失败|code=99991|Unauthorized/i.test(batchErr)) throw eb;
        // ⚠️ 降级：批更新失败常见原因 = Joe 在表里手动删了某行（record_id 失效）。
        //   若不降级，这个 chunk 每轮都失败 → 水位永远不推进 → 同步整体卡死。
        //   逐条重试：更新失败的 → 删本地映射 → 走 create 重建行（幂等，不丢数据）。
        for (const r of chunk) {
          try {
            await larkApi(env, "PUT",
              `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recOf.get(r.id)}`,
              { fields: leadToBitableFields(r) });
            updated++;
          } catch (e2: any) {
            console.log(`bitable update 单条失败(lead ${r.id})，按行已被删处理→重建: ${e2.message || e2}`);
            const cr = await larkApi(env, "POST",
              `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`,
              { fields: leadToBitableFields(r) });
            const rid = cr.data?.record?.record_id;
            if (rid) await env.DB.prepare(
              "INSERT OR REPLACE INTO lark_bitable_map (lead_id, record_id, synced_at) VALUES (?,?,datetime('now'))"
            ).bind(r.id, rid).run();
            created++;
          }
        }
      }
    }
  } catch (e: any) {
    // 任一批失败：不推进水位（下轮整批重试；>= 边界 + upsert 幂等 = 不丢不炸）
    console.error("bitable sync:", e.message || e);
    return { ok: false, created, updated, error: e.message || String(e) };
  }

  // 全部成功才推进水位（记录边界行 updated_at；>= 会重复 upsert 边界行，幂等无害）
  // ⚠️ L1：水位按 allRows（含排除态）推进 —— rows 过滤后可能为空,不能拿它当边界。
  const maxTs = allRows[allRows.length - 1].updated_at;
  await setSetting(env, "lark_bitable_last_sync", maxTs);
  console.log(`bitable sync: created=${created} updated=${updated} removed=${removed} watermark=${maxTs}`);
  return { ok: true, created, updated, removed };
}
