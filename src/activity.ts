// ══ C5-28：机器"现在在干什么"的**唯一真源** ══
//
// 为什么要单独建这层，而不是让状态栏各自去问各的：
//   状态栏要显示 4 种徽章态 × 7 种动作小字。如果每种都由前端自己拼（查一下待分析数、
//   查一下今日发了几封、猜一猜有没有在跑），那就是**七处口径**——而这一单本身就是来
//   收编双真源的（顶栏小牌 + an-chip），边收编边新造六处是自相矛盾的。
//
// ⚠️ 设计上的三条硬规矩，都是从今天踩的坑里来的：
//
//   1. **"在跑"必须由干活的人主动声明，不能靠推断。**
//      今天刚栽过两次"用增量推断状态"：用 total 有增量推断"搜索完成了"（错，增量只证明在跑）、
//      用 last_analysis 变了推断"快 tick 在分析"（错，那是 Joe 手点的）。
//      ⇒ 谁在干活谁写一条 activity，干完自己清掉。**不猜。**
//
//   2. **必须会过期。** 进程崩了没来得及清，状态栏会永远显示"分析中"——那就是又一个
//      "永远转圈"（C5-26 刚治过的病）。所以每条都带时间戳，超过 STALE_MS 一律当成没在跑。
//      ⚠️ 过期不是"假装它没发生"：它确实无从得知了，而**说"不知道"好过说一个假的"在跑"**。
//
//   3. **发起方要落在服务端。** Joe 的"你交办的："前缀如果靠前端记自己点没点过，
//      刷新一次就丢，换个标签页就错。发起方是**事实**，事实归服务端。
//
// ⚠️ 一种活一个键（不是共用一个键）：快 tick 在发信的同时 Joe 可能正在搜索，
//    共用一个键会互相覆盖，屏幕上就会看到活动"闪来闪去"。

import type { Env } from "./index";

export type ActivityKind = "search" | "analyze" | "findmail" | "send" | "inbox";
/** 谁发起的。auto = 机器自己；user = Joe 点的（状态栏要加「你交办的：」前缀）。 */
export type Initiator = "auto" | "user";

export interface Activity {
  kind: ActivityKind;
  by: Initiator;
  done?: number;
  total?: number;
  note?: string;
  at: number;          // epoch ms，用于判过期
}

/** 超过这个时间没更新就当它没在跑。⚠️ 比最长的单步耗时留足余量：一封信实测 31-43s。 */
export const ACTIVITY_STALE_MS = 3 * 60 * 1000;

const KEY = (k: ActivityKind) => `activity_${k}`;

async function getS(env: Env, key: string): Promise<string> {
  try {
    const r = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
    return r?.value ?? "";
  } catch { return ""; }
}
async function setS(env: Env, key: string, value: string): Promise<void> {
  try {
    await env.DB.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
    ).bind(key, value).run();
  } catch { /* 记状态失败**绝不能**拖垮正在干的活 —— 它只是个显示 */ }
}

/** 声明"我正在干这件事"。反复调用即更新进度（同时刷新过期时间）。 */
export async function setActivity(
  env: Env, kind: ActivityKind, by: Initiator, fields: { done?: number; total?: number; note?: string } = {},
): Promise<void> {
  await setS(env, KEY(kind), JSON.stringify({ kind, by, at: Date.now(), ...fields } satisfies Activity));
}

/** 干完了。⚠️ 一定要清：不清就只能等过期，那段时间状态栏在说假话。 */
export async function clearActivity(env: Env, kind: ActivityKind): Promise<void> {
  await setS(env, KEY(kind), "");
}

/** 读一条；过期或读不出一律返回 null（**"不知道"好过一个假的"在跑"**）。 */
export async function readActivity(env: Env, kind: ActivityKind): Promise<Activity | null> {
  const raw = (await getS(env, KEY(kind))).trim();
  if (!raw) return null;
  try {
    const a = JSON.parse(raw) as Activity;
    if (!a || typeof a.at !== "number") return null;
    if (Date.now() - a.at > ACTIVITY_STALE_MS) return null;
    return a;
  } catch { return null; }
}

/**
 * 当前该显示哪一条活动。
 * ⚠️ 优先级不是随便排的，按**Joe 最想知道哪件事**排：
 *   发信 > 搜索 > 分析 > 补邮箱 > 收信。
 *   发信排第一是因为它是唯一不可撤的对外动作 —— 别的都还能反悔。
 */
export const ACTIVITY_PRIORITY: ActivityKind[] = ["send", "search", "analyze", "findmail", "inbox"];

export async function currentActivity(env: Env): Promise<Activity | null> {
  for (const k of ACTIVITY_PRIORITY) {
    const a = await readActivity(env, k);
    if (a) return a;
  }
  return null;
}
