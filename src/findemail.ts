// 邮箱发现：深挖联系页 + 反混淆；可选 Hunter.io 兜底。给缺邮箱的真实客户补上可发地址。
import type { Env } from "./index";
import { htmlToText } from "./scrape";

const UA = "Mozilla/5.0 (compatible; AirSondeBot/0.1; +https://airsonde.com)";
// ⚠️ 6000 → 15000。2026-07-28 抽样实测（12 家「已批准但无邮箱」的真线索）：
//   **8/12 家的联系页响应超过 6 秒**（7.1 / 7.3 / 8.4 / 11.3 / 11.5 / 12.0s …），
//   全部在我们看到页面之前就被自己的超时掐断 → 报"没找到"，而页面上其实有邮箱
//   （手动验证：boemarine.com/contact 上就有 sales@boemarine.com）。
//   排除过的干扰项（**都实测过，不是推测**）：UA 不是原因（AirSondeBot 与浏览器 UA 均返 200）、
//   跳转不是原因（fetchPage 已 redirect:"follow"）、本地出站闸门不是原因（拦截 0 次）。
//   ⚠️ 生产实测同一批 12 家命中率同样是 2/12 —— 与本机一致，说明**不是我这边网络慢**，
//      是这批 B2B 小站本身慢。8 个路径是**并行**抓的，放宽超时不会让单轮耗时线性增长。
//
// 🔴 **上面那段推理后来被 A/B 推翻了，这个 15000 的实际收益 ≈ 0 —— 别以为它是调优过的值。**
//   部署后用同一批 12 家做前后对照：**2/12 → 2/12，零改善**；而生产端耗时分布是
//   1.3 / 1.7 / 1.8 / 1.9 / 2.1 / 2.2 / 2.2 / 2.3 / 3.1 / 5.3 / 5.4 / 8.6 秒 ——
//   **6 秒的旧阈值在生产上几乎从没被触发过**，我在本机测到的 7–12 秒是**我这边的网络**。
//   当时"本机与生产命中率都是 2/12"被我读成"两边同样在超时"，其实是**两个不同的原因
//   产生了同一个数字**（本机=超时在咬；生产=根本没到超时、页面上就抓不到）。
//   ⚠️ 教训：**看到数字相同就推断机制相同是无效推理。** 是 A/B 拆开的，不是想明白的。
//   保留 15000 的理由只有一个：无坏处（并行不叠加）且确实接住了那个 8.6s 的案例。
//   真正的漏抓原因**尚未查清** → 用 diagnoseSite() 只读诊断，别再凭猜改常量。
const TIMEOUT = 15000;
// 高命中率联系页路径（含 Shopify /pages/ 结构）；并行抓取，速度≈单页
const PATHS = [
  "", "/contact", "/contact-us", "/contactus",
  "/about", "/about-us", "/pages/contact", "/pages/contact-us",
];

const JUNK = /(example\.|test@|your-?email|name@|email@|sentry\.|wixpress|\.png|\.jpg|\.jpeg|\.gif|\.webp|\.svg|@2x|domain\.com|yourdomain|godaddy|sentry|wordpress\.|w3\.org|schema\.org|@example)/i;

export interface FindResult { email: string | null; source: string; candidates: string[] }

// useHunter：是否允许调用 Hunter 兜底（消耗付费/免费额度）。默认 false，只做免费官网抓取，避免自动花钱。
export async function findLeadEmail(env: Env, website: string, useHunter = false, outProbes?: PageProbe[]): Promise<FindResult> {
  const base = normalize(website);
  if (!base) return { email: null, source: "no-url", candidates: [] };
  const origin = new URL(base).origin;
  const emails = new Set<string>();

  // ⭐ `outProbes`：把**这一次已经抓到的**每页结果带出去，供调用方分类失败原因。
  //   起因（2026-07-28 生产实测）：原来失败后再跑一次 `diagnoseSite` 来分类，
  //   而那是**又一整轮 8 个请求** —— 生产构成表显示补邮箱一轮烧 **320 = 160 + 160**，
  //   **一半是这个"为了看清失败"的诊断自己烧的**，且它在**已经越过子请求上限之后还在继续发**。
  //   ⚠️ 一个只在失败时启动、且随失败量放大的东西，等于**在系统崩溃时踩油门**。
  //   现在改成：抓的时候顺手把 probe 记下来 → **分类零额外请求**，诊断能力一点没丢。
  const probes: PageProbe[] = PATHS.map((p) => ({
    path: p || "/", status: null, bytes: 0, finalUrl: origin + p, contentType: "", ms: 0, why: "network-error", emails: [],
  }));
  // 并行抓所有候选联系页（总耗时≈最慢的单页，而非累加）—— 免费，不花额度
  const htmls = await Promise.all(PATHS.map((p, i) => fetchPage(origin + p, probes[i])));
  htmls.forEach((html, i) => {
    if (html) {
      const found = extractEmailsDeep(html);
      probes[i].emails = found;
      found.forEach((e) => emails.add(e));
    }
  });
  if (outProbes) outProbes.push(...probes);

  const ranked = rank([...emails], origin);
  if (ranked.length) return { email: ranked[0], source: "scrape", candidates: ranked };

  // 兜底：Hunter.io（需 EMAIL_FINDER_API_KEY + 明确 useHunter=true。每次查 1 家=1 积分）
  if (useHunter && env.EMAIL_FINDER_API_KEY) {
    try {
      const h = await hunterDomainSearch(env, new URL(base).hostname.replace(/^www\./, ""));
      if (h.length) return { email: h[0], source: "hunter", candidates: h };
    } catch { /* 忽略兜底失败 */ }
  }
  return { email: null, source: "none", candidates: [] };
}

// ══⭐ C5-36：Hunter 积分的**月度闸**（Joe 拍板：免费档 25 次/月，自然月重置）══
//
// 成本量级决定了它必须有闸：Hunter 单次约 ¥0.7，而一条线索其余全部成本（搜索+打分+抓站）只有几分钱
// —— **贵一个数量级**。所以它只配用在已验证的高价值缺口上。
//
// ⚠️ 计数与拦截放在**真正花钱的这一个函数里**，不放调用方：
//   放调用方就得每加一个入口记得抄一遍，而"漏抄一处"的代价是真金白银。
//   （同 send.ts 把日限放进 sendApprovedBatch 而不是各个按钮里，是同一条纪律。）
// ⚠️ 自然月键 `hunter_used_YYYY-MM` —— 月份变了自然从 0 开始，不需要任何定时清零任务
//   （需要有人记得跑的重置，就是迟早忘记的重置）。
export const HUNTER_MONTHLY_DEFAULT = 25;
export async function hunterUsage(env: Env): Promise<{ used: number; limit: number; key: string }> {
  const key = `hunter_used_${new Date().toISOString().slice(0, 7)}`;
  const get = async (k: string, d: string) => {
    try { const r = await env.DB.prepare("SELECT value FROM settings WHERE key=?").bind(k).first<{ value: string }>(); return r?.value ?? d; }
    catch { return d; }
  };
  const used = Number(await get(key, "0")) || 0;
  const raw = (await get("hunter_monthly_limit", "")).trim();
  const n = Number(raw);
  const limit = raw !== "" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : HUNTER_MONTHLY_DEFAULT;
  return { used, limit, key };
}

async function hunterDomainSearch(env: Env, domain: string): Promise<string[]> {
  // 🔴 月度额度闸：用尽就**静默停到下个月**（不是错误，是设计）——但日志要说出来，
  //   否则"没花钱"和"想花但被拦了"在数据上长得一样。
  const q = await hunterUsage(env);
  if (q.used >= q.limit) {
    console.log(`hunter: 本月额度已用尽（${q.used}/${q.limit}），跳过 —— 下月 1 号自动恢复`);
    return [];
  }
  // ⚠️ **先记账再调用**：调用成功但记账失败 = 花了钱没记上，下次还会花。
  //   记多一次的代价是少查一家；记少一次的代价是超支。两种错不对称，宁可先记。
  try {
    await env.DB.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
    ).bind(q.key, String(q.used + 1)).run();
  } catch (e) { console.error("hunter 记账失败，为安全起见不调用：", e); return []; }
  // #45：API key 走 Authorization 头、不进 query（防 key 落进 URL 访问日志）。Hunter v2 官方支持 Bearer/X-API-KEY 头。
  const url = `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&limit=10`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${env.EMAIL_FINDER_API_KEY}` } });
  if (!res.ok) return [];
  const data: any = await res.json();
  const emails: { value: string; conf: number }[] = (data?.data?.emails || [])
    .map((e: any) => ({ value: String(e.value || "").toLowerCase(), conf: Number(e.confidence) || 0 }))
    .filter((e: any) => valid(e.value));
  // 优先高置信度 + 角色/通用邮箱
  emails.sort((a, b) => b.conf - a.conf);
  return emails.map((e) => e.value);
}

function extractEmailsDeep(html: string): string[] {
  const out = new Set<string>();
  // 解码 HTML 实体（常见混淆手段：&#64; = @）
  let h = html
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&commat;/gi, "@").replace(/&period;/gi, ".");
  // mailto: 最可靠
  for (const m of h.matchAll(/mailto:([^"'?>\s]+)/gi)) {
    const e = safeDecode(m[1]).trim().toLowerCase();
    if (valid(e)) out.add(e);
  }

  // ⭐ Cloudflare 邮箱混淆（data-cfemail）：站点开了 Email Address Obfuscation 后，
  //   邮箱被换成 hex 串，靠 CF 的 JS 在浏览器里解。我们没有 JS，但算法是公开的：
  //   首字节是 key，其余每字节与 key 异或。boemarine.com/contact 上就有 1 处。
  for (const m of h.matchAll(/data-cfemail=["']([0-9a-fA-F]+)["']/g)) {
    try {
      const hex = m[1];
      const key = parseInt(hex.slice(0, 2), 16);
      let e = "";
      for (let i = 2; i < hex.length; i += 2) e += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
      e = e.trim().toLowerCase();
      if (valid(e)) out.add(e);
    } catch { /* 解不出就算了，不影响其它路径 */ }
  }

  // ⭐⭐ 属性里的邮箱 —— 2026-07-28 取证：`boemarine.com/contact` 我们**完整拿到了
  //   192493 字节的页面**，却提取出 0 个邮箱。原因是那个 sales@boemarine.com
  //   **不在 mailto: 里**（grep 计数 0），只出现在 HTML 属性中：
  //     data-values="{&#39;email_to&#39;: &#39;sales@boemarine.com&#39;}"
  //     <a href="http://sales@boemarine.com">   ← 站长把 mailto: 写成了 http://
  //   而下面那条纯文本正则跑在 **htmlToText() 之后**，属性在那一步就被剥光了 ——
  //   **两条路同时落空 → 报"没找到"**。
  //   ⚠️ 但在**原始 HTML** 上跑正则会把脚本/样式里的垃圾一起捞进来，所以这一路
  //      **额外过一道更严的过滤**（见 attrJunk）：只认长得像真业务邮箱的，宁可少捞。
  for (const m of h.match(/[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/gi) || []) {
    const e = m.trim().toLowerCase();
    if (valid(e) && !attrJunk(e)) out.add(e);
  }

  let text = htmlToText(h);
  // 反混淆：user [at] domain [dot] com / (at) / {at}
  text = text
    .replace(/\s*[\[({]\s*at\s*[\])}]\s*/gi, "@")
    .replace(/\s*[\[({]\s*dot\s*[\])}]\s*/gi, ".");
  // 重建空格分隔的邮箱：user @ domain . com
  text = text.replace(/([a-z0-9._%+\-]+)\s*@\s*([a-z0-9.\-]+)\s*\.\s*([a-z]{2,})/gi, "$1@$2.$3");
  for (const m of text.match(/[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/gi) || []) {
    const e = m.trim().toLowerCase();
    if (valid(e)) out.add(e);
  }
  return [...out];
}

/**
 * 属性/原始 HTML 那条路**专用**的额外过滤。
 *
 * 为什么单独一道：在渲染后的正文里出现的邮箱，基本都是站方想让人看到的；
 * 而**原始 HTML** 里还混着脚本、样式、第三方 SDK 配置、字体/图标声明 ——
 * 那里面的 "邮箱" 绝大多数不是这家公司的联系方式。
 * ⚠️ 宁可少捞：漏一个真邮箱只是这轮没补上（下轮还会再试），
 *    而捞错一个会**把开发信发到无关的人那里**，代价不对称。
 */
function attrJunk(e: string): boolean {
  const host = e.split("@")[1] || "";
  const local = e.split("@")[0] || "";
  // 建站平台 / CDN / 前端库 / 分析与营销 SDK 的域名：出现在页面源码里是技术依赖，不是联系方式
  if (/(shopify|myshopify|squarespace|wix\.|weebly|bigcommerce|woocommerce|cloudflare|cloudfront|googleapis|gstatic|google-analytics|googletagmanager|jquery|bootstrapcdn|jsdelivr|unpkg|fontawesome|typekit|hotjar|klaviyo|mailchimp|hubspot|intercom|zendesk|gorgias|recaptcha|stripe\.|paypalobjects|akamai|fastly|cdninstagram|fbcdn)/i.test(host)) return true;
  // 文件名/资源后缀混进来的
  if (/\.(js|css|woff2?|ttf|eot|map|json|xml|ico)$/i.test(e)) return true;
  // 一看就是哈希/占位的 local part（32 位以上纯十六进制、或全数字长串）
  if (/^[0-9a-f]{16,}$/i.test(local) || /^\d{8,}$/.test(local)) return true;
  return false;
}

function valid(e: string): boolean {
  if (!e || e.length > 100 || !e.includes("@")) return false;
  if (JUNK.test(e)) return false;
  // ⚠️ local part **必须含至少一个字母或数字**。
  //   起因：改成"也扫原始 HTML"后，chicagomarineelectronics.com 上捞出了
  //   `---@chicagomarineelectronics.com` —— 那是页面里的占位/分隔符，不是邮箱，
  //   但它完全符合下面那条格式正则（`-` 在允许字符集里）。
  //   这是通用清洗规则，不是给这一家开的特例：纯标点的 local part 不可能是真联系方式。
  const local = e.split("@")[0] || "";
  if (!/[a-z0-9]/i.test(local)) return false;
  return /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/.test(e);
}

function rank(emails: string[], origin: string): string[] {
  let domain = "";
  try { domain = new URL(origin).hostname.replace(/^www\./, ""); } catch {}
  const role = ["sales", "info", "contact", "hello", "support", "enquiries", "inquiries", "office", "admin", "orders"];
  const score = (e: string) => {
    let s = 0;
    const [local, host] = e.split("@");
    if (domain && host && host.replace(/^www\./, "").endsWith(domain)) s += 100;
    const i = role.indexOf(local);
    if (i !== -1) s += 50 - i * 2;
    if (/(noreply|no-reply|donotreply|postmaster|abuse|webmaster|privacy|legal)/.test(local)) s -= 100;
    return s;
  };
  return emails.sort((a, b) => score(b) - score(a));
}

function safeDecode(s: string): string { try { return decodeURIComponent(s); } catch { return s; } }

/** 单页抓取结果 —— 诊断用。`html` 为 null 表示这一页没被采用，`why` 说明原因。 */
export interface PageProbe {
  path: string;
  status: number | null;      // HTTP 状态；null = 根本没拿到响应（超时/连接失败）
  bytes: number;
  finalUrl: string;           // 跟随跳转后的最终 URL
  contentType: string;
  ms: number;
  // ⚠️ 原来这里是一个 `timeout-or-network` —— **把两件病因完全不同的事糊成了一类**：
  //   真超时（我们自己的 AbortController 掐的）该调超时值；而"其它网络错"
  //   （DNS/TLS/被拒/**子请求配额耗尽**）跟超时值一点关系没有。现在拆开。
  why: "ok" | "timeout" | "network-error" | "http-not-ok" | "not-html";
  /** ⚠️ **运行时的原话，不做归一化** —— 归一化会把最有信息量的那部分抹掉。
   *  Serper 那次就是靠原话（`Not enough credits`）一次终结争论的。
   *  若真是子请求配额耗尽，这里会直接出现 `Too many subrequests` 之类字样。 */
  errName?: string;
  errMessage?: string;
  emails: string[];           // 这一页上抓到的邮箱（诊断用，正式路径不看这个字段）
}

/**
 * 抓一页。`probe` 传入时，把这一页的**真实 HTTP 结果**记进去。
 * ⚠️ 诊断与正式路径**共用这一个函数**（同 UA、同 TIMEOUT、同 redirect 策略）——
 *    诊断若另起一套 fetch，测的就是另一回事，等于白测。
 */
async function fetchPage(url: string, probe?: PageProbe): Promise<string | null> {
  const t0 = Date.now();
  const fin = (why: PageProbe["why"], status: number | null, bytes = 0, ct = "", finalUrl = url, errName = "", errMessage = "") => {
    if (probe) {
      probe.status = status; probe.bytes = bytes; probe.contentType = ct; probe.finalUrl = finalUrl;
      probe.ms = Date.now() - t0; probe.why = why;
      if (errName) probe.errName = errName;
      if (errMessage) probe.errMessage = errMessage.slice(0, 200);   // 只截长度，**不改措辞**
    }
  };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT);
    const res = await fetch(url, { headers: { "user-agent": UA, accept: "text/html" }, signal: ctrl.signal, redirect: "follow" });
    clearTimeout(t);
    const ct = res.headers.get("content-type") || "";
    if (!res.ok) { fin("http-not-ok", res.status, 0, ct, res.url || url); return null; }
    if (!ct.includes("text/html") && !ct.includes("text/")) { fin("not-html", res.status, 0, ct, res.url || url); return null; }
    const html = await res.text();
    fin("ok", res.status, html.length, ct, res.url || url);
    return html;
  } catch (e: any) {
    // ⭐ **要运行时的原话，不要我们的转述。**
    //   2026-07-28：cron 里 20/20 全落 `timeout-or-network`，而同一批站单独用 HTTP 请求跑
    //   却全部成功 —— 唯一差别是执行环境。把原始 name/message 记下来才分得清到底是：
    //     · AbortError  = **我们自己的 AbortController 掐的**，那才是真超时（该调 TIMEOUT）
    //     · 其它        = DNS/TLS/被拒/**子请求配额耗尽**（`Too many subrequests`）——
    //                     这些跟超时值毫无关系，调超时是白费。
    //   ⚠️ message 只截长度、**不做归一化** —— 归一化会把最有信息量的那部分抹掉。
    const name = String(e?.name || "");
    const msg = String(e?.message || e || "");
    fin(name === "AbortError" ? "timeout" : "network-error", null, 0, "", url, name, msg);
    return null;
  }
}

/**
 * 🔬 只读诊断：把 8 个路径**逐一**的 HTTP 状态/字节数/最终 URL/耗时/是否抓到邮箱吐出来。
 *
 * 为什么需要它：2026-07-28 的 A/B 证明 TIMEOUT 6s→15s **零改善**（2/12→2/12），
 * 而 UA、跳转、提取逻辑也都实测排除了 —— 剩下的假设是"站点拒绝 Cloudflare Worker
 * 的数据中心 IP"，但**现有端点只返回 source/candidates，看不到每个路径发生了什么**。
 * 拿到状态码才分得清是 **403 被拦 / 超时 / 还是 200 但页面上真没有邮箱** ——
 * **不加诊断就改代码 = 又一次猜。**
 *
 * ⚠️ 只读：不写库、不改 lead。
 */
export async function diagnoseSite(website: string): Promise<{ origin: string; probes: PageProbe[] }> {
  const base = normalize(website);
  if (!base) return { origin: "", probes: [] };
  const origin = new URL(base).origin;
  const probes: PageProbe[] = PATHS.map((p) => ({
    path: p || "/", status: null, bytes: 0, finalUrl: origin + p, contentType: "", ms: 0, why: "network-error", emails: [],
  }));
  await Promise.all(PATHS.map(async (p, i) => {
    const html = await fetchPage(origin + p, probes[i]);
    if (html) probes[i].emails = extractEmailsDeep(html);
  }));
  return { origin, probes };
}

function normalize(u: string): string {
  const t = (u || "").trim();
  if (!t) return "";
  const withProto = /^https?:\/\//i.test(t) ? t : "https://" + t;
  try { const url = new URL(withProto); return url.origin + url.pathname.replace(/\/+$/, ""); } catch { return ""; }
}
