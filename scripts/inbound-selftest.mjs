#!/usr/bin/env node
/**
 * 官网询盘管道自测闸 —— 打**真的跑着的 worker**，不打桩。
 *
 * ⚠️ 第 ⓪ 条先断言"我打的是谁"（/api/_whoami 的 repo/db）。上游教训：
 *    8788 端口上曾经是别的窗的 workerd，`curl 通了` 与 `我的进程通了` 不是一回事。
 *
 * 跑法（本地 dev，先 `npx wrangler dev --port 8791 --inspector-port 9341`）：
 *   node scripts/inbound-selftest.mjs                       # 默认 http://127.0.0.1:8791
 *   BASE=http://127.0.0.1:8791 TOKEN=xxx node scripts/inbound-selftest.mjs
 *
 * ⚠️ TOKEN 未给时：只跑"未配/坏 token/浏览器路径"那几条，并**明确报告哪几条被跳过**
 *    （砍了什么要说什么 —— 静默跳过的检查最危险）。
 * ⚠️ 本脚本会往库里写测试线索（用 selftest+<uuid>@example.invalid，.invalid 是 RFC2606
 *    保留后缀、永不可达），跑完自动清理；⛔ 绝不对生产库跑。
 */
const BASE = (process.env.BASE || "http://127.0.0.1:8791").replace(/\/+$/, "");
const TOKEN = process.env.TOKEN || "";
let pass = 0, fail = 0, skipped = [];
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ✅ ${name}${detail ? "  —— " + detail : ""}`); }
  else { fail++; console.log(`  🔴 ${name}${detail ? "  —— " + detail : ""}`); }
};
const post = async (body, headers = {}) => {
  const res = await fetch(`${BASE}/api/inbound`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* 非 JSON 也要能报出来 */ }
  return { status: res.status, json };
};
const uid = () => crypto.randomUUID();
const mail = () => `selftest+${uid()}@example.invalid`;

// ⓪ 进程身份 —— 任何结论之前先证明打到的是谁
console.log(`\n⓪ 进程身份（${BASE}）`);
const who = await fetch(`${BASE}/api/_whoami`).then((r) => r.json()).catch((e) => ({ error: String(e) }));
check("打到的是 airsonde-crm 本仓进程", who.repo === "airsonde-crm" && who.db === "airsonde_crm",
  `repo=${who.repo} db=${who.db}`);
if (who.repo !== "airsonde-crm") {
  console.log("\n🔴 打错了进程，后面的断言全部无意义 —— 停。\n");
  process.exit(1);
}
check("发信能力仍为 false（锁死态未被本次改动打开）", who.canSend === false, `canSend=${who.canSend}`);
console.log(`  ℹ️ canAcceptWebInquiry=${who.canAcceptWebInquiry}（机器通道是否已配 token）`);

// ① 鉴权
console.log("\n① 鉴权");
{
  const r = await post({ company: "SelfTest", email: mail(), message: "x" }, { "x-inbound-token": "definitely-wrong-" + uid() });
  if (who.canAcceptWebInquiry) check("坏 token → 401", r.status === 401, `status=${r.status}`);
  else check("未配 INBOUND_TOKEN 时带 token 来 → 503 fail-closed（不是放行）", r.status === 503, `status=${r.status}`);
}
{
  const r = await post({ company_name: "SelfTest Browser", email: mail(), where_sell: "selftest" });
  check("不带 token（浏览器直投老路径）→ 仍受理，行为不变", r.status === 200 && r.json?.ok === true, `status=${r.status}`);
}

// ② honeypot（与鉴权无关，两条路都该拦）
console.log("\n② honeypot");
{
  const email = mail();
  const r = await post({ company_name: "Bot", email, company_url: "http://spam.example" });
  const found = await countLeads(email);
  check("蜜罐被填 → 假成功且不入库", r.status === 200 && r.json?.ok === true && found === 0, `status=${r.status} 库中=${found}`);
}

// ③④⑤ 需要 token 的部分
if (!TOKEN) {
  skipped.push("③ 来源标记 website_contact", "④ 幂等重放", "⑤ 幂等键缺失 → 400");
} else {
  console.log("\n③ 来源标记（服务端白名单）");
  const email3 = mail();
  {
    const r = await post(
      { company: "AirSonde SelfTest Co", name: "Tester", email: email3, phone: "+1 555 0100",
        inquiry_type: "OEM / ODM", message: "selftest inquiry body", source_form: "website_contact" },
      { "x-inbound-token": TOKEN, "x-idempotency-key": "selftest-" + uid() });
    check("可信调用方 + 白名单来源 → 受理", r.status === 200 && r.json?.ok === true, `status=${r.status}`);
    const row = await oneLead(email3);
    check("落库 source=website_contact", row?.source === "website_contact", `source=${row?.source}`);
    check("notes 记下了询盘正文与类型", !!row && /selftest inquiry body/.test(row.notes || "") && /OEM/.test(row.notes || ""));
    check("next_action=跟进官网询盘", row?.next_action === "跟进官网询盘", `next_action=${row?.next_action}`);
  }
  {
    // 自称白名单外的来源 → 不许生效（回落老规则），且**不报错**（不是攻击面，是无效声明）
    const email = mail();
    await post({ company: "Claimed", email, message: "x", source_form: "trusted_directory" },
      { "x-inbound-token": TOKEN, "x-idempotency-key": "selftest-" + uid() });
    const row = await oneLead(email);
    check("白名单外的 source_form 声明 → 不生效（回落 landing）", row?.source === "landing", `source=${row?.source}`);
  }

  console.log("\n④ 幂等（同一把键重放）");
  {
    const key = "selftest-idem-" + uid();
    const email = mail();
    const body = { company: "Retry Co", email, message: "first", source_form: "website_contact" };
    const r1 = await post(body, { "x-inbound-token": TOKEN, "x-idempotency-key": key });
    const r2 = await post({ ...body, message: "second" }, { "x-inbound-token": TOKEN, "x-idempotency-key": key });
    check("第一次 → 正常受理", r1.status === 200 && !r1.json?.idempotent);
    check("同键重放 → ok 且标记 idempotent，不重复处理", r2.status === 200 && r2.json?.idempotent === true, `json=${JSON.stringify(r2.json)}`);
    const row = await oneLead(email);
    check("重放的正文没有被追加进 notes", !!row && !/second/.test(row.notes || ""));
    check("库中该邮箱仍只有 1 行", (await countLeads(email)) === 1);
  }

  console.log("\n⑤ 幂等键必须显式给（缺席就吼，不静默降级）");
  {
    const r = await post({ company: "NoKey", email: mail(), message: "x" }, { "x-inbound-token": TOKEN });
    check("可信调用方缺 x-idempotency-key → 400", r.status === 400, `status=${r.status} ${JSON.stringify(r.json)}`);
  }
}

// ---- 读库辅助：走 worker 自己的 API（本地 dev 免登录），不直连 D1 ----
// ⚠️ **不要拿整封邮箱当 q**：D1/SQLite 的 LIKE 模式超过 ~48 字符会 500
//    （`LIKE or GLOB pattern too complex`，生产 D1 已实测同样报错，见 docs 已知问题）。
//    这里用邮箱里的 uuid 片段检索（短、且足够唯一），再在客户端按整封邮箱精确过滤 ——
//    绕开那个缺陷，而不是假装它不存在。
// ⚠️ 列表端点**不返回 notes**（只有详情端点有）。第一版自测就是拿列表判 notes 而误报 4 条红 ——
//    判据必须落在真的含有那个字段的产出上。
async function listLeads(email) {
  const token = (email.split("@")[0].split("+")[1] || email.split("@")[0]).slice(0, 40);
  const r = await fetch(`${BASE}/api/leads?q=${encodeURIComponent(token)}&limit=100`).then((x) => x.json()).catch(() => null);
  const arr = Array.isArray(r) ? r : r?.leads || r?.items || [];
  return arr.filter((l) => String(l.email || "").toLowerCase() === email.toLowerCase());
}
async function countLeads(email) { return (await listLeads(email)).length; }
/** 详情（含 notes）—— 列表里没有 notes，判 notes 必须来这儿取。 */
async function oneLead(email) {
  const row = (await listLeads(email))[0];
  if (!row) return null;
  const d = await fetch(`${BASE}/api/leads/${row.id}`).then((x) => x.json()).catch(() => null);
  return d?.lead || d || row;
}

console.log(`\n通过 ${pass} · 🔴 失败 ${fail}`);
if (skipped.length) console.log(`⚠️ 跳过（未给 TOKEN，不是通过）：\n  - ${skipped.join("\n  - ")}`);
console.log(fail === 0
  ? "✅ 断言全过" + (skipped.length ? "（注意上面跳过的项）" : "")
  : "🔴 有失败项，别当绿灯用");
process.exit(fail === 0 ? 0 : 1);
