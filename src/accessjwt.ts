// Cloudflare Access JWT 验证 —— **只此一处**，不许散在各个路由里。
//
// ⭐⭐ 为什么做这件事（Joe 的原话）：
//   「我在 Cloudflare Access 里加的账号就是我认为该登录的账号，为什么还要第二道闸门？
//     **万一哪天你们公司把我封号了我不就完犊子了嘛**」
//
// ⚠️⚠️ **这不是第二道闸，它是在核验第一道闸的签名。**
//   —— 这句话是这个文件存在的全部理由，也是它**不会重演** Joe 抱怨的那件事的原因：
//   我们不判断"谁该进"（那永远归 Access 策略），我们只判断"这张票是不是 Access 真发的"。
//   Access 放进来的人，票据必然验得过；**唯一的锁人场景是我们自己写错，那该回滚，不该留后门。**
//   ⛔ 所以这里**没有任何运行时旁路开关** —— 那等于再造一个 `DEV_BYPASS_AUTH`
//      （上一批刚把它从 fail-open 改成 fail-closed，理由是「被误配的后门应该让服务停」）。
//
// 现状（2026-08-02 实测）：`crm.wanew.com` 上代码只做 `if (header exists) return next()` ——
//   **不看它是谁、也不看它是不是真的**。今天不可利用（伪造头直打：crm 302 / workers.dev 401 /
//   api.wanew.com 404，Access 在边缘就挡了），但**安全性 100% 押在一个我们不控制的边缘行为上**
//   —— 和 H12（`Host: localhost` 免登录）是同一个形状，那条已经判过不能这么干。

/** 已知租户白名单。⚠️⚠️ **绝不能用 token 自称的 iss 去决定抓哪个 URL**：
 *  那等于让攻击者用一个 `iss: https://evil.cloudflareaccess.com` 的伪票，
 *  指挥我们的 Worker 去他的服务器取"公钥"—— 既是 SSRF，也让验签变成走过场。
 *  claimed iss **只用来决定先试哪一个**，永远不用来扩大这个集合。
 *
 *  ⚠️ **`wanewgroup` 出现在 airsonde 仓里不是串味，是对的** —— 别"顺手修正"它。
 *  2026-09-02 实测：`crm.airsonde.com` 的 Access 登录跳转指向
 *  `wanewgroup.cloudflareaccess.com/cdn-cgi/access/login/crm.airsonde.com`
 *  ⇒ 两个站**同一个 Cloudflare 账号、同一个团队域**，只是各自是一个独立的 Access 应用。
 *  ⭐ 团队域相同 ≠ AUD 相同：**AUD 是每个应用一个**（这正是上面那行曾经错掉的地方）。 */
export const KNOWN_TENANTS = ["wanewgroup", "wanew"] as const;
export type Tenant = typeof KNOWN_TENANTS[number];

/** `crm.airsonde.com` 这个 Access 应用的 AUD（非机密；在登录跳转 URL 的 kid= 参数里公开可见）。
 *
 *  🔴 **这一行曾经是 wanew-crm 的 AUD**（`9a9ae044…`）—— 整个文件是从 wanew-crm 整体复制过来的，
 *     而 **AUD 是"每个 Access 应用一个"**，不是每个账号一个 ⇒ 复制过来必然是错的。
 *     它没炸只是因为**这个模块还没接线**（全仓没有任何 src 文件 import 它，只有自测脚本）。
 *     ⚠️ 接线那天才会发现的话，症状是**所有人 403，包括 Joe** —— 正是这个文件开头那句话要避免的事。
 *
 *  ⭐ **别照抄下面这个值，自己量一遍**（照抄正是它出错的原因）。匿名请求即可，不需要登录：
 *     ```
 *     curl -sI https://crm.airsonde.com/ | grep -i ^location:
 *     ```
 *     `Location` 里的 **`kid=` 参数就是 AUD**；同一条 URL 的 `meta=` 是一个 JWT，
 *     其 payload 的 `aud` 必须与 `kid=` **完全相同** —— 两个独立字段对得上才可采信（2026-09-02 已如此核过）。
 *     顺带那条 URL 的主机名就是团队域 ⇒ 见下面 KNOWN_TENANTS 的注释。 */
export const DEFAULT_ACCESS_AUD = "b7c3296b15d1012a18800aee72f009e9d5a2910133715eb90958b0b947291233";

const JWKS_TTL_MS = 60 * 60 * 1000;   // 1 小时。Access 的签名密钥轮换很慢，遇到未知 kid 会强制回源。

interface Jwk { kid?: string; kty?: string; n?: string; e?: string; alg?: string; [k: string]: unknown }
interface CachedJwks { keys: Jwk[]; at: number }

// ⚠️ 模块级缓存 = **isolate 级**，不是全局；冷启动时每个 isolate 最多回源一次。
//   这么做的原因：JWKS 抓取是**外部子请求**，而这个仓刚为子请求预算打过一周（#83/#84）。
const jwksCache = new Map<Tenant, CachedJwks>();

export interface AccessObservation {
  /** 票据从哪来。⚠️ 这正是步骤①最不可替代的观测点：**押错的代价是所有人 403，包括 Joe。** */
  hasHeader: boolean; headerLen: number;
  hasCookie: boolean; cookieLen: number;
  tokenSource: "header" | "cookie" | "none";
  /** 校验结论 */
  verified: boolean;
  /** ⭐ **谁的钥匙真的签了它** —— 不是"它说它是谁签的"。未验签之前 iss 只是 token 的自称。 */
  signedBy: Tenant | null;
  claimedIss: string | null;
  audMatch: boolean | null;
  expOk: boolean | null;
  /** JWT 的 email claim（这是要落库/展示的身份来源；②之后取代那个头） */
  jwtEmail: string | null;
  /** 旧头里的 email —— ②要换数据源，**换之前必须先证明两者一致** */
  headerEmail: string | null;
  emailAgrees: boolean | null;
  /** 本次鉴权真的发了几次 fetch。⚠️ **调用点计数，不是包出口计数**（本仓老教训：标清楚它数的是什么）。
   *  缓存命中应为 0。 */
  authSubreq: number;
  /** 失败原因**原话**，不做归一化 —— 归一化会把最有信息量的那部分抹掉。 */
  reason: string;
}

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64urlToJson(s: string): any {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));
}

/** 从 Cookie 头里取 CF_Authorization。⚠️ 只取值用于验签，**绝不记录它**。 */
function cookieValue(cookieHeader: string, name: string): string | null {
  for (const part of cookieHeader.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

async function getJwks(tenant: Tenant, counter: { n: number }, force = false): Promise<Jwk[]> {
  const hit = jwksCache.get(tenant);
  if (!force && hit && Date.now() - hit.at < JWKS_TTL_MS) return hit.keys;
  // ⚠️ **先计数再发** —— 失败的 fetch 在生产**照样消耗一个子请求**。
  //   计数写在动作之后 = 数的是"成功了几次"，而预算关心的是"发起了几次"，两者在失败密集时差一个量级。
  //   （本仓 subreq.ts 上写过同一条：计数点相对副作用的位置决定了它数的是意图还是结果。）
  counter.n++;
  const res = await fetch(`https://${tenant}.cloudflareaccess.com/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`JWKS ${tenant} HTTP ${res.status}`);
  const data: any = await res.json();
  const keys: Jwk[] = data?.keys || [];
  if (!keys.length) throw new Error(`JWKS ${tenant} 返回 0 个 key`);
  jwksCache.set(tenant, { keys, at: Date.now() });
  return keys;
}

async function verifyWith(tenant: Tenant, kid: string, signingInput: string, sig: Uint8Array, counter: { n: number }): Promise<boolean> {
  let keys = await getJwks(tenant, counter);
  let jwk = keys.find((k) => k.kid === kid);
  // ⚠️ 未知 kid 才强制回源：密钥轮换后旧缓存会一直认不出新票，而定时回源又白花子请求。
  if (!jwk) {
    keys = await getJwks(tenant, counter, true);
    jwk = keys.find((k) => k.kid === kid);
  }
  if (!jwk) return false;
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true } as JsonWebKey,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
  return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig as any, new TextEncoder().encode(signingInput));
}

/**
 * 观测 + 校验一次请求的 Access 票据。**本函数不做任何拦截决定**，只返回观测结果 ——
 * 步骤①（只观察不拦人）与步骤②（开强制）共用它，**同一段代码、同一套判据**：
 * 若诊断另起一套逻辑，①观测到的就不是②将要执行的那件事，等于白观测。
 */
export async function observeAccessJwt(env: any, req: Request): Promise<AccessObservation> {
  const counter = { n: 0 };
  const headerEmail = req.headers.get("cf-access-authenticated-user-email");
  const assertion = req.headers.get("cf-access-jwt-assertion");
  const cookieHeader = req.headers.get("cookie") || "";
  const cookieTok = cookieValue(cookieHeader, "CF_Authorization");

  const o: AccessObservation = {
    hasHeader: !!assertion, headerLen: assertion ? assertion.length : 0,
    hasCookie: !!cookieTok, cookieLen: cookieTok ? cookieTok.length : 0,
    tokenSource: assertion ? "header" : cookieTok ? "cookie" : "none",
    verified: false, signedBy: null, claimedIss: null, audMatch: null, expOk: null,
    jwtEmail: null, headerEmail: headerEmail || null, emailAgrees: null,
    authSubreq: 0, reason: "",
  };

  // ⚠️ 头优先、取不到读 cookie —— **两个都读，不押注在观测到的那一种上**：
  //   观测样本再多也只是样本，而押错的代价是"所有人 403，包括 Joe"。
  const token = assertion || cookieTok;
  if (!token) { o.reason = "无票据（头与 cookie 都没有）"; return o; }

  try {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error(`票据不是三段 JWT（${parts.length} 段）`);
    const head = b64urlToJson(parts[0]);
    const payload = b64urlToJson(parts[1]);
    const kid = String(head?.kid || "");
    o.claimedIss = payload?.iss ? String(payload.iss) : null;

    // ⭐ claimed iss **只用来排序**，不扩大候选集（见 KNOWN_TENANTS 上的注释：否则是 SSRF + 验签走过场）
    const claimedHost = (() => { try { return new URL(String(payload?.iss || "")).hostname.toLowerCase(); } catch { return ""; } })();
    const claimedTenant = KNOWN_TENANTS.find((t) => claimedHost === `${t}.cloudflareaccess.com`);
    const order: Tenant[] = claimedTenant
      ? [claimedTenant, ...KNOWN_TENANTS.filter((t) => t !== claimedTenant)]
      : [...KNOWN_TENANTS];

    const sig = b64urlToBytes(parts[2]);
    const signingInput = `${parts[0]}.${parts[1]}`;
    const errs: string[] = [];
    for (const t of order) {
      try {
        if (await verifyWith(t, kid, signingInput, sig, counter)) { o.signedBy = t; break; }
      } catch (e: any) { errs.push(`${t}: ${e?.message || String(e)}`); }
    }
    o.authSubreq = counter.n;

    if (!o.signedBy) {
      o.reason = `签名未通过任何已知租户${errs.length ? "（" + errs.join(" · ") + "）" : ""}`;
      return o;
    }

    // 只有签名过了，iss/aud/exp 才算证据（在此之前它们只是 token 的自称）
    const wantAud = String(env?.ACCESS_AUD || DEFAULT_ACCESS_AUD);
    const auds: string[] = Array.isArray(payload?.aud) ? payload.aud.map(String) : payload?.aud ? [String(payload.aud)] : [];
    o.audMatch = auds.includes(wantAud);
    const now = Math.floor(Date.now() / 1000);
    o.expOk = typeof payload?.exp === "number" ? payload.exp > now : false;
    const nbfOk = typeof payload?.nbf === "number" ? payload.nbf <= now + 60 : true;
    o.jwtEmail = payload?.email ? String(payload.email).toLowerCase() : null;
    o.emailAgrees = headerEmail ? o.jwtEmail === headerEmail.toLowerCase() : null;
    // iss 必须与**真正签名的那个租户**一致（不是与自称一致）
    const issOk = claimedHost === `${o.signedBy}.cloudflareaccess.com`;

    o.verified = !!(o.audMatch && o.expOk && nbfOk && issOk);
    if (!o.verified) {
      o.reason = [
        o.audMatch ? "" : `aud 不匹配（期望 ${wantAud.slice(0, 12)}…，票据里 ${auds.map((a) => a.slice(0, 12)).join(",") || "无"}）`,
        o.expOk ? "" : "已过期",
        nbfOk ? "" : "nbf 未到",
        issOk ? "" : `iss 与真正签名的租户不符（自称 ${claimedHost || "空"}，实签 ${o.signedBy}）`,
      ].filter(Boolean).join(" · ");
    } else o.reason = "ok";
  } catch (e: any) {
    o.authSubreq = counter.n;
    o.reason = `解析/校验异常：${e?.message || String(e)}`;   // 原话，不归一化
  }
  return o;
}

/**
 * 只记**能安全落日志**的字段。
 * 🔴 **绝不包含 token / cookie 值 / 签名本身** —— 日志是一个能拿去换身份的东西。
 *   长度可以记（它能区分"没带"和"带了个空的"），值不行。
 */
export function safeLogLine(path: string, o: AccessObservation): string {
  return `access-jwt-observe ${path} | src=${o.tokenSource} hdr=${o.hasHeader}(${o.headerLen}) ck=${o.hasCookie}(${o.cookieLen})`
    + ` verified=${o.verified} signedBy=${o.signedBy || "-"} claimedIss=${o.claimedIss || "-"}`
    + ` audMatch=${o.audMatch} expOk=${o.expOk} emailAgrees=${o.emailAgrees}`
    + ` jwtEmail=${o.jwtEmail || "-"} hdrEmail=${o.headerEmail || "-"} authSubreq=${o.authSubreq}`
    + ` reason=${o.reason}`;
}
