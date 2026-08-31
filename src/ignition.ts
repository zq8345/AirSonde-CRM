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
  };
}

/** 未点火时给日志/接口用的一句人话（**说清差什么**，不说"失败"）。 */
export function notIgnitedReason(env: Env, id: Capability["id"]): string {
  const cap = byId.get(id);
  const miss = missingKeys(env, id);
  return `未点火：「${cap?.label ?? id}」还差 ${miss.join(" / ")}（从未配置，不是故障）`;
}
