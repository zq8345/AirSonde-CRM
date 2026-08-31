// ============================================================================
// 点火状态（ignition）—— 「从未配置」与「配了但坏了」是两件事
// ============================================================================
//
// ⭐ 这个文件解决的是 Joe 看到的那个现象：后台把**从没点过火**的能力，
//   报成**故障**。实际发生过的两句：
//     · 「收客户回复失败（已连续 465 轮）」—— 其实 LARK_IMAP_PASS 从来没配过
//     · 「⚠️ AI 用量读取失败」        —— 其实 OPENROUTER_API_KEY 从来没配过
//   一台还没插电的机器，不该在仪表盘上报"引擎故障"。这不是文案问题：
//   **它让真故障失去了意义** —— 天天都红的灯，红的那天没人会看。
//
// ⭐ 一条规则，不是十个特例（这仓的老纪律：遇边界加 if = 病，往上找统一原则）：
//     未点火（钥匙从没配过）⇒ **不是故障**：不计失败轮数、不推告警、面板显示「未点火 · 差这把钥匙」
//     已点火（钥匙配了）而失败 ⇒ **是故障**：照旧计数、照旧吼
//
// ⚠️ 判据只问「钥匙在不在」，**不问它对不对**：一把错的 key 属于"配了但坏了"，
//    那是真故障，本来就该吼。这里绝不试图替它判断有效性 —— 那需要真发一次请求，
//    而"为了判断要不要告警先去打人家一次"是本末倒置。
// ⚠️ 本文件**只读 env、不写库、不发任何请求**：它被告警路径调用，
//    而报故障的路不能与故障共享资源（上游教训：告警走 fetch，而故障正是 fetch 耗尽）。

import type { Env } from "./index";

// ============================================================================
// 密钥值清洗 —— BOM / 空白 / 引号
// ============================================================================
//
// 🔴 真事（2026-08-31，`wrangler tail` 抓到的生产日志原话）：
//   `A header value for "authorization" contains non-ASCII characters:
//    "Bearer ﻿sk-or-v1-465…" (raw bytes: …\x20\xef\xbb\xbf\x73\x6b…)`
//   `\xef\xbb\xbf` = **UTF-8 BOM**，粘在了密钥的最前面。
//
// 怎么来的：密钥先落进一个 .txt，而 PowerShell 的 `Out-File`/`>` 默认写 **UTF-8 with BOM**；
//   从文件头部复制第一行时，那三个不可见字节跟着一起进了 `wrangler secret put`。
//   **屏幕上完全看不出来** —— 值看着一模一样。
//
// 后果按钥匙不同，症状各不相同、且都不指向真因：
//   · OPENROUTER：authorization 头非法 ⇒ AI 打分/写信全挂，看着像"额度问题"
//   · LARK_WEBHOOK_URL：BOM 开头 ⇒ 过不了 `/^https?:\/\//` ⇒ 界面说"**还没配**"，而人明明刚配过
//   · LARK_WEBHOOK_SECRET：签名用错串 ⇒ 飞书回 19021，看着像"密钥错了"
//   · RESEND / SERPER：同理
//
// ⚠️ 修法上的取舍：**洗干净它，但绝不假装没发生过**。
//   只洗不报 = 下一次换钥匙又中招且更难查；只报不洗 = 让一个不可见字符继续瘫痪整套系统。
//   所以：`cleanSecret` 负责洗，`dirtySecretKeys` 负责让它在点火面板上现形。
const SECRET_LIKE_KEYS = [
  "OPENROUTER_API_KEY", "RESEND_API_KEY", "SEARCH_API_KEY", "EMAIL_FINDER_API_KEY",
  "LARK_IMAP_PASS", "LARK_IMAP_PASS2", "LARK_WEBHOOK_URL", "LARK_WEBHOOK_SECRET",
  "RESEND_WEBHOOK_SECRET", "LARK_APP_ID", "LARK_APP_SECRET", "LARK_VERIFICATION_TOKEN",
  "INBOUND_TOKEN", "ADMIN_PASSWORD", "ACCESS_AUD",
] as const;

/** 洗掉 BOM(U+FEFF) / 前后空白 / 成对引号。⚠️ 只动两端，中间一个字节不碰。 */
export function cleanSecret(v: unknown): string {
  return String(v ?? "").replace(/^﻿+/, "").trim().replace(/^(['"])([\s\S]*)\1$/, "$2").trim();
}

/** 哪几把钥匙的值"脏"了（洗过之后不等于原值）——**只报名字，绝不报值**。 */
export function dirtySecretKeys(env: any): string[] {
  return SECRET_LIKE_KEYS.filter((k) => {
    const raw = env?.[k];
    return typeof raw === "string" && raw.length > 0 && cleanSecret(raw) !== raw;
  });
}

/** ⭐ **唯一咽喉点**：在 worker 入口把所有密钥类值洗一遍，下游一律拿干净值。
 *  ⛔ 不在 10 个消费点各写一次 `.trim()` —— 那种写法的第五个点必漏（这仓的老病）。
 *  bindings（DB / ASSETS）是对象引用，浅拷贝原样带过去。 */
export function normalizeEnv<T extends object>(env: T): T {
  const out: any = { ...env };
  // ⚠️ 脏名单必须**在洗之前**算：洗完再问"谁脏了"永远得到空集
  //    —— 那是拿被测物洗过之后的样子当证据，等于把自己的证据毁掉。
  const dirty = dirtySecretKeys(env);
  for (const k of SECRET_LIKE_KEYS) {
    if (typeof out[k] === "string") out[k] = cleanSecret(out[k]);
  }
  out.__dirtySecrets = dirty;                 // 只带名字，不带值
  if (dirty.length) console.warn(`⚠️ 密钥值带了 BOM/空白/引号（已自动清洗，但请重配以免下次再中）：${dirty.join(", ")}`);
  return out as T;
}

export interface Capability {
  /** 稳定 id（前端/日志/whoami 都用它，别改） */
  id: "send" | "reply" | "ai" | "search" | "notify" | "appbot" | "inbound" | "emailfinder";
  /** 面板上给人看的名字 */
  label: string;
  /** 需要的 env key —— **缺任意一把即未点火** */
  keys: (keyof Env)[];
  /** 点着之后机器能多做什么（写给人看，用来回答"少了它我损失什么"） */
  unlocks: string;
  /** 差它的时候，机器是不是就跑不成整条链（用来决定"零产出"算不算停摆） */
  core: boolean;
}

/** ⭐ 能力清单 = **单一真源**。加新能力只在这里加一条；
 *  ⛔ 别在别处再写一次 `if (!env.XXX_KEY)` 式的"配没配"判断 —— 那正是漂移的开始。 */
export const CAPABILITIES: Capability[] = [
  { id: "search", label: "自动找客户", keys: ["SEARCH_API_KEY"], core: true,
    unlocks: "按关键词搜出新公司（Serper）" },
  { id: "ai", label: "AI 打分与写信", keys: ["OPENROUTER_API_KEY"], core: true,
    unlocks: "给线索打分、起草开发信、AI 用量统计" },
  { id: "send", label: "发开发信", keys: ["RESEND_API_KEY"], core: true,
    unlocks: "真正把信发出去（Resend）" },
  { id: "reply", label: "收客户回复", keys: ["LARK_IMAP_PASS"], core: true,
    unlocks: "把客户回信收进来并分类（IMAP）" },
  { id: "notify", label: "飞书群通知", keys: ["LARK_WEBHOOK_URL"], core: false,
    unlocks: "热回复实时推群、每 6 小时简报、故障告警" },
  { id: "appbot", label: "飞书应用机器人", keys: ["LARK_APP_ID", "LARK_APP_SECRET"], core: false,
    unlocks: "带操作按钮的卡片、多维表格镜像" },
  { id: "inbound", label: "官网询盘接入", keys: ["INBOUND_TOKEN"], core: false,
    unlocks: "官网联系表单的询盘自动进 CRM" },
  { id: "emailfinder", label: "自动补邮箱", keys: ["EMAIL_FINDER_API_KEY"], core: false,
    unlocks: "官网找不到邮箱时用 Hunter 补" },
];

const byId = new Map(CAPABILITIES.map((c) => [c.id, c]));

/** 这把能力缺哪些钥匙（返回 env key 名，**只报名字不报值**）。 */
export function missingKeys(env: Env, id: Capability["id"]): string[] {
  const cap = byId.get(id);
  if (!cap) return [];
  return cap.keys.filter((k) => !String((env as any)[k] || "").trim());
}

/** 点着了吗 = 该配的钥匙一把不缺。 */
export function isIgnited(env: Env, id: Capability["id"]): boolean {
  return missingKeys(env, id).length === 0;
}

export interface CapabilityStatus {
  id: Capability["id"];
  label: string;
  ignited: boolean;
  /** 缺的钥匙名（未点火时非空）—— 直接就是 Joe 要配的那几个 secret 名 */
  missing: string[];
  unlocks: string;
  core: boolean;
}

/** 面板 / _whoami / 告警判断共用的一份状态。 */
export function ignitionReport(env: Env): {
  capabilities: CapabilityStatus[];
  ignitedCount: number;
  total: number;
  /** 核心链路是否整条点着（搜→打分→发→收）。false = 机器本来就跑不出产出。 */
  coreReady: boolean;
  /** 还差的钥匙名（去重，按 CAPABILITIES 顺序）—— 点火清单直接用它 */
  missingKeys: string[];
  /** ⚠️ 值带了 BOM/空白/引号的钥匙名（已在入口自动洗掉，但**必须让人看见**：
   *  下次换钥匙时同样的粘贴习惯会再中一次，而屏幕上看不出来） */
  dirtyKeys: string[];
} {
  const capabilities = CAPABILITIES.map<CapabilityStatus>((c) => {
    const missing = missingKeys(env, c.id);
    return { id: c.id, label: c.label, ignited: missing.length === 0, missing, unlocks: c.unlocks, core: c.core };
  });
  const missing = [...new Set(capabilities.flatMap((c) => c.missing))];
  return {
    capabilities,
    ignitedCount: capabilities.filter((c) => c.ignited).length,
    total: capabilities.length,
    coreReady: capabilities.filter((c) => c.core).every((c) => c.ignited),
    missingKeys: missing,
    // 入口洗之前记下来的那份（见 normalizeEnv）。直接问此刻的 env 只会得到空集。
    dirtyKeys: Array.isArray((env as any).__dirtySecrets) ? (env as any).__dirtySecrets : [],
  };
}

/** 未点火时给日志/接口用的一句人话（**说清差什么**，不说"失败"）。 */
export function notIgnitedReason(env: Env, id: Capability["id"]): string {
  const cap = byId.get(id);
  const miss = missingKeys(env, id);
  return `未点火：「${cap?.label ?? id}」还差 ${miss.join(" / ")}（从未配置，不是故障）`;
}
