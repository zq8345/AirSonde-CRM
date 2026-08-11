// Access JWT 验签自测 —— 这道闸翻错的代价是**所有人 403，包括 Joe**，
// 所以它不能靠"读代码觉得对"上线。
//
// ⭐ 本文件的判据纪律（本仓老教训，写在这里免得下一个人放宽它）：
//   ① **仪器先自证**：在断言任何"它能报红"之前，先证明它**能出绿** ——
//      一个永远报红的测试和一个永远报绿的测试一样没用，而前者更容易被当成"很严格"。
//   ② **反向自证要用真实存在过的缺陷形状**，不是我随手植入的假缺陷。
//      这里最关键的一条是 case ③「改载荷、保留原签名」—— 那正是"只读 header 不验签"
//      今天真实敞开的那个洞：claims 照样解析得出来，**只有签名会注意到**。
//   ③ **比真源，不比字面量**：断言 `verified === false`，不断言 reason 文案长什么样。
//      文案会改，判据不会。
//
// 跑法：node scripts/accessjwt-selftest.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "accessjwt-"));
const OUT = path.join(TMP, "accessjwt.mjs");
// src 是 TypeScript，Node 直接 import 不了 → 用仓里已有的 esbuild 打成 ESM。
// ⚠️ 打包**的是 src/accessjwt.ts 本身**，不是它的副本 —— 测的必须是将要上线的那份。
execFileSync("npx", ["esbuild", "src/accessjwt.ts", "--bundle", "--format=esm", `--outfile=${OUT}`], {
  stdio: ["ignore", "ignore", "inherit"], shell: process.platform === "win32",
});
const { observeAccessJwt, safeLogLine, KNOWN_TENANTS, DEFAULT_ACCESS_AUD } = await import("file://" + OUT.replace(/\\/g, "/"));

// ---------- 工具 ----------
const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const enc = new TextEncoder();

async function makeKey(kid) {
  const kp = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"]
  );
  const jwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
  return { kid, priv: kp.privateKey, jwk: { kid, kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256" } };
}

async function sign(key, payload, headerOverride = {}) {
  const head = b64url(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT", kid: key.kid, ...headerOverride })));
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.priv, enc.encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(sig)}`;
}

const NOW = () => Math.floor(Date.now() / 1000);
const goodPayload = (over = {}) => ({
  iss: "https://wanewgroup.cloudflareaccess.com",
  aud: [DEFAULT_ACCESS_AUD],
  email: "joe@wanew.com",
  exp: NOW() + 3600,
  iat: NOW() - 10,
  ...over,
});

// ---------- fetch 桩：只认两个已知租户，并**记录每一次外呼** ----------
const fetched = [];
let KEYS = {};
globalThis.fetch = async (url) => {
  fetched.push(String(url));
  const m = /^https:\/\/([a-z0-9-]+)\.cloudflareaccess\.com\/cdn-cgi\/access\/certs$/.exec(String(url));
  if (!m || !KEYS[m[1]]) return new Response("not found", { status: 404 });
  return new Response(JSON.stringify({ keys: KEYS[m[1]].map((k) => k.jwk) }), {
    status: 200, headers: { "content-type": "application/json" },
  });
};

const reqWith = ({ header, cookie, email }) =>
  new Request("https://crm.wanew.com/api/leads", {
    headers: Object.fromEntries(Object.entries({
      "cf-access-jwt-assertion": header,
      cookie: cookie ? `foo=bar; CF_Authorization=${cookie}; baz=qux` : undefined,
      "cf-access-authenticated-user-email": email,
    }).filter(([, v]) => v !== undefined)),
  });

// ---------- 用例 ----------
const kGroup = await makeKey("kid-wanewgroup-1");   // 租户 wanewgroup 的签名密钥
const kWanew = await makeKey("kid-wanew-1");        // 租户 wanew 的签名密钥（另一个真实存在的租户）
const kEvil = await makeKey("kid-evil-1");          // 谁都不认识的密钥
KEYS = { wanewgroup: [kGroup], wanew: [kWanew] };

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail = "") {
  results.push(`  ${ok ? "✅" : "🔴"} ${name}${detail ? "  —— " + detail : ""}`);
  ok ? pass++ : fail++;
}

// ── ① 仪器自证：合法票必须验得过。这一条不过，下面所有"它报红了"都毫无意义 ──
const goodTok = await sign(kGroup, goodPayload());
const oGood = await observeAccessJwt({}, reqWith({ header: goodTok }));
check("① 正对照：合法票 verified=true", oGood.verified === true, `reason=${oGood.reason}`);
check("① 正对照：签名租户被正确识别为 wanewgroup", oGood.signedBy === "wanewgroup", `signedBy=${oGood.signedBy}`);
check("① 正对照：身份取自 JWT 而非头", oGood.jwtEmail === "joe@wanew.com", `jwtEmail=${oGood.jwtEmail}`);
if (!oGood.verified) {
  console.log(results.join("\n"));
  console.log("\n🔴 仪器无效：合法票都验不过，本次自测不构成任何证据。");
  process.exit(9);
}

// ── ② 篡改签名 ──
const tampSig = goodTok.slice(0, -6) + (goodTok.slice(-6) === "AAAAAA" ? "BBBBBB" : "AAAAAA");
check("② 签名被改一个片段 → 拒", (await observeAccessJwt({}, reqWith({ header: tampSig }))).verified === false);

// ── ③🔴 最关键：改载荷、保留原签名 —— 这正是"只读头不验签"今天敞开的那个洞 ──
{
  const [h, , s] = goodTok.split(".");
  const evilBody = b64url(enc.encode(JSON.stringify(goodPayload({ email: "attacker@evil.com" }))));
  const o = await observeAccessJwt({}, reqWith({ header: `${h}.${evilBody}.${s}` }));
  check("③ 换掉 email 但沿用原签名 → 拒（claims 照样解析得出，只有签名会注意到）", o.verified === false);
}

// ── ④ aud 不是本应用的（= 拿别的 Access 应用的票来串门）──
{
  const t = await sign(kGroup, goodPayload({ aud: ["9198c82bff0877ab614c0e4c4cda2d1ad1e4707185239e95bbb8b56056d19759"] }));
  const o = await observeAccessJwt({}, reqWith({ header: t }));
  check("④ 别的 Access 应用的票（aud 不符）→ 拒", o.verified === false && o.audMatch === false);
}

// ── ⑤ 过期 ──
{
  const o = await observeAccessJwt({}, reqWith({ header: await sign(kGroup, goodPayload({ exp: NOW() - 60 })) }));
  check("⑤ 已过期的票 → 拒", o.verified === false && o.expOk === false);
}

// ── ⑥ 谁都不认识的密钥签的 ──
{
  const o = await observeAccessJwt({}, reqWith({ header: await sign(kEvil, goodPayload()) }));
  check("⑥ 未知密钥签的票 → 拒", o.verified === false && o.signedBy === null);
}

// ── ⑦ iss 自称 A、实际由 B 的密钥签（跨租户混用）──
{
  const o = await observeAccessJwt({}, reqWith({ header: await sign(kWanew, goodPayload()) }));
  check("⑦ 自称 wanewgroup 却由 wanew 的密钥签 → 拒（iss 必须等于真正签名的那个租户）",
    o.verified === false && o.signedBy === "wanew");
}

// ── ⑧🔴 SSRF 反向自证：iss 指向攻击者的域，必须**一次都不去访问它** ──
{
  const before = fetched.length;
  await observeAccessJwt({}, reqWith({ header: await sign(kEvil, goodPayload({ iss: "https://evil.cloudflareaccess.com" })) }));
  const touched = fetched.slice(before).filter((u) => u.includes("evil."));
  check("⑧ iss 指向 evil.cloudflareaccess.com → 绝不对该域发起任何 fetch", touched.length === 0,
    touched.length ? `实际访问了 ${touched.join(",")}` : `本轮外呼 ${fetched.length - before} 次，均落在已知租户`);
}

// ── ⑨ cookie 承载的合法票（生产可能只给 cookie，不给头）──
{
  const o = await observeAccessJwt({}, reqWith({ cookie: await sign(kGroup, goodPayload()) }));
  check("⑨ 票只在 CF_Authorization cookie 里 → 照样验得过", o.verified === true && o.tokenSource === "cookie",
    `src=${o.tokenSource} reason=${o.reason}`);
}

// ── ⑩ 只有邮箱头、没有票（= 今天生产可能的样子）──
{
  const o = await observeAccessJwt({}, reqWith({ email: "joe@wanew.com" }));
  check("⑩ 只有 email 头、没有票 → verified=false 且头里的邮箱被如实记下",
    o.verified === false && o.headerEmail === "joe@wanew.com" && o.tokenSource === "none");
}

// ── ⑪🔴 日志绝不能含可换取身份的东西 ──
{
  const tok = await sign(kGroup, goodPayload());
  const o = await observeAccessJwt({}, reqWith({ header: tok, cookie: tok, email: "joe@wanew.com" }));
  const line = safeLogLine("/api/leads", o);
  const leaks = [
    line.includes("eyJ") ? "含 JWT 前缀 eyJ" : "",
    line.includes(tok) ? "含完整 token" : "",
    line.includes(tok.split(".")[2]) ? "含签名段" : "",
    line.includes("CF_Authorization") ? "含 cookie 名与值" : "",
  ].filter(Boolean);
  check("⑪ safeLogLine 不含 token / cookie / 签名", leaks.length === 0, leaks.join(" · ") || `长度 ${line.length}`);
}

// ── ⑫ 已知租户集合不会被 token 撑大 ──
check("⑫ KNOWN_TENANTS 仍是硬编码的两个", KNOWN_TENANTS.length === 2 && KNOWN_TENANTS.includes("wanewgroup"),
  KNOWN_TENANTS.join(","));

// ---------- 收尾 ----------
fs.rmSync(TMP, { recursive: true, force: true });
console.log("【Access JWT 验签自测】");
console.log(results.join("\n"));
console.log(`\n通过 ${pass} · 🔴 失败 ${fail}`);
if (fail) {
  console.log("\n🔴 不要上线：验签闸没达到它自称的判据。");
  process.exit(1);
}
console.log("✅ 全部通过 —— 合法票放行、六类坏票（含改载荷沿用原签名）全部拒绝、不外呼未知域、日志不含凭证。");
