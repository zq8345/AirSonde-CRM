// 子请求计量器 —— **只数数，不改行为**。
//
// 起因（2026-07-28）：生产 cron 报 `Too many subrequests by single Worker invocation`，
//   而我们**不知道那 50 个额度到底被谁吃掉了**。之前两轮排查都栽在同一件事上：
//   拿"数代码里的 fetch 调用点"当测量 —— 那是**估算**，会漏掉库内部发的请求。
//
// ⚠️ 所以这里**包全局 fetch**，而不是在各调用点埋点：
//   只有包住出口，才能把"我们没写在代码里但确实发出去了"的那些也数进来。
//   ⚠️ 包装只 `count++` 然后原样转发 —— **不改参数、不改返回、不吞异常**。
//
// 🔴🔴 **这把尺子有两处系统性偏差，读数之前必须先读这一段。**（2026-07-29 被生产数据打脸后补）
//
// **偏差一：越线之前少数（漏重定向跳数）。**
//   我原先在这里写过"包住 fetch 就能把重定向每一跳都数到" —— **那句话是错的，是我写的。**
//   `redirect:"follow"` 的一次 fetch()，无论跳几次，包装器**只被调用一次**；
//   而平台侧**每一跳单独计数**（官方 Limits 页明写）。
//   实测（12 家真站 96 个页面的 finalUrl 对照）：**54% 的页面发生了重定向**，
//   6/12 家是 8 条路径全跳 —— 对这些站，抓 8 页的真实消耗 ≥16，尺子只显示 8。
//   → **表上越线之前的数字是下限，不是真值；真实越线点比表上早。**
//
// **偏差二：越线之后多数（把注定失败的尝试也算进去）。**
//   `ext++` 发生在调用真 fetch **之前**。越过上限后每次 fetch 立即抛错，
//   但计数照加。所以越线之后那些步骤的数字是**尝试数，不是消耗数** ——
//   它们实际上一个请求都没发出去（也就是说：那些步骤那一轮**根本没干成事**）。
//
// ⚠️ 合起来：`ext` 既不是消耗量也不是发出量，它是**"我们调用了几次 fetch"**。
//   拿它当预算账本会同时高估和低估，方向还相反。要真消耗量只能另想办法。
//
// ⚠️ 这个文件**只出数字，不做任何优化**。构成表出来之前不动任何限流逻辑
//   （今天已经有两次按错假说动手的教训）。

/** 一步的计量结果。ext=对外 fetch；d1=D1 绑定调用（**两者是否共用同一个 50，正是要测的**）。 */
/** 一步的计量结果。
 *  ⚠️ C5-51：`ext` 与 `extFail` **必须成对读**，⛔ 别只看 ext ——
 *     `ext` 是"我们调了几次"，`extFail` 是"其中几次根本没发出去"。见 installFetchMeter 的注释。 */
export interface StepCount { step: string; ext: number; extFail: number; d1: number; sock: number; extCum: number; extFailCum: number; d1Cum: number; sockCum: number }

let curStep = "(init)";
let ext = 0;
let extFail = 0;   // C5-51：**失败**的 fetch 次数（catch 里累加）—— 见 installFetchMeter 那段
let d1 = 0;
let sock = 0;
const marks: StepCount[] = [];
let wrapped = false;

/**
 * 包住全局 fetch。幂等：同一 isolate 只包一次，避免重复计数。
 *
 * ⭐⭐ C5-51：加 `extFail` —— **数结果，不只数意图**。
 *
 * 🔴 为什么必须加，一句话说完（2026-09-03 真实案例）：
 *   `补邮箱` 一个满批 = **20 家 × 8 条路径 = 160** 次 fetch。而：
 *     · **健康**的满批 = `ext 160`（20×8 全部发出去了）
 *     · **被饿死**的满批 = `ext 160`（20×8 全部立即抛错，因为 `ext++` 在真 fetch 之前）
 *   ⇒ **这两种情况的 `ext` 一模一样，靠 `ext` 分辨不出来。**
 *   2026-09-01 13:00 那次真事故的账本上，`补邮箱` 也正好是 160、发信 54，
 *   18 条有邮箱的待联系一封没发；而 2026-09-03 08:02 那轮同样是 160，却是健康的。
 *   当时只能靠**产出**（那天真填上了 66 个邮箱 vs 事故那天 0 个）去反推 —— 每个人都得反推一次。
 *
 * ⇒ `extFail` 让账本自己回答：`ext 160 / extFail 0` = 健康，`ext 160 / extFail 160` = 全军覆没。
 *
 * ⚠️ **必须在 catch 里 ++，⛔ 不能在调用前** —— 调用前那个位置数的是意图，
 *   而"有没有被饿死"恰恰是个**结果**问题。这是本仓写过多次的那条：
 *   计数点相对副作用的位置，决定了它数的是意图还是结果。
 * ⚠️ 只数**同步抛出/Promise 拒绝**的那些。⛔ 不看 HTTP 状态码：
 *   404/500 是对方的回答，**请求是真的发出去了**，那不叫失败额度。
 */
export function installFetchMeter(): void {
  if (wrapped) return;
  wrapped = true;
  const real = globalThis.fetch;
  // ⚠️ 只加计数，其余原样转发。**失败也要原样抛出去（不吞）** —— 计量器不许改行为。
  globalThis.fetch = ((input: any, init?: any) => {
    ext++;
    try {
      return real(input, init).catch((e: any) => { extFail++; throw e; });
    } catch (e) {
      extFail++;      // 同步就抛的情况（越线时平台可能同步抛）
      throw e;
    }
  }) as typeof fetch;
}

/** D1 计数：在调用点手动 +1（D1 是绑定不是 fetch，包不住，只能在包装器里数）。 */
export function countD1(n = 1): void { d1 += n; }

/**
 * TCP socket 计数（`cloudflare:sockets` 的 `connect()`）。
 *
 * ⚠️⚠️ **这一格和 ext 不是同一种证据，别混着读。**
 *   `ext` 是**包住出口**数出来的 —— 库内部发的、重定向每一跳，都躲不掉。
 *   `sock` 是**在调用点数的** —— 也就是我们自己承认的那几次 `connect()`。
 *   `connect()` 不经过 `fetch`，全局包装器**看不见它**；在没有这一格之前，
 *   收回复那一步在表上是 `ext+0` —— 那个 0 的意思是「**看不见**」，不是「**没有**」。
 *   一张把这两种 0 混在一起的表，比没有表危险。
 *
 * ⚠️ 数出来的这个数**只说明我们打了几次 connect**，不说明它算不算那 50 个额度 ——
 *    后者是平台行为，只能实测（/api/diag/socket-subrequest-probe）。
 */
export function countSocket(n = 1): void { sock += n; }

/**
 * 包一层 D1，让每次 prepare().run()/first()/all() 自动计数。
 * ⚠️ 只在**计量路径**上用，不改 env.DB 本身 —— 免得计量器本身成为行为变量。
 */
export function meteredDB(db: D1Database): D1Database {
  return new Proxy(db, {
    get(t: any, p: any) {
      const v = t[p];
      if (p === "prepare") {
        return (sql: string) => {
          const stmt: any = v.call(t, sql);
          return new Proxy(stmt, {
            get(st: any, sp: any) {
              const sv = st[sp];
              if (sp === "run" || sp === "first" || sp === "all" || sp === "raw") {
                return (...a: any[]) => { countD1(); return sv.apply(st, a); };
              }
              if (sp === "bind") return (...a: any[]) => meteredStmt(sv.apply(st, a));
              return typeof sv === "function" ? sv.bind(st) : sv;
            },
          });
        };
      }
      if (p === "batch") return (...a: any[]) => { countD1(); return v.apply(t, a); };
      return typeof v === "function" ? v.bind(t) : v;
    },
  }) as D1Database;
}
function meteredStmt(stmt: any): any {
  return new Proxy(stmt, {
    get(st: any, sp: any) {
      const sv = st[sp];
      if (sp === "run" || sp === "first" || sp === "all" || sp === "raw") {
        return (...a: any[]) => { countD1(); return sv.apply(st, a); };
      }
      if (sp === "bind") return (...a: any[]) => meteredStmt(sv.apply(st, a));
      return typeof sv === "function" ? sv.bind(st) : sv;
    },
  });
}

/** 开始新一步：把上一步的增量结账。 */
export function mark(step: string): void {
  const prevExt = marks.reduce((s, m) => s + m.ext, 0);
  const prevExtFail = marks.reduce((s, m) => s + m.extFail, 0);   // C5-51
  const prevD1 = marks.reduce((s, m) => s + m.d1, 0);
  const prevSock = marks.reduce((s, m) => s + m.sock, 0);
  // ⚠️ C5-51：`extFail` 与 `ext` **每一步都成对给**，⛔ 不能只在总计里给 ——
  //   总计里的 extFail>0 只说明"这一轮有失败"，说不出**哪一步**开始垮的，
  //   而"从哪一步开始全失败"正是分辨"某步没活干"与"从这里起全被饿死"的唯一线索。
  marks.push({ step: curStep, ext: ext - prevExt, extFail: extFail - prevExtFail,
               d1: d1 - prevD1, sock: sock - prevSock,
               extCum: ext, extFailCum: extFail, d1Cum: d1, sockCum: sock });
  curStep = step;
}

/**
 * 收尾并导出。
 *
 * ⭐⭐ C5-51 定位调整：**真告警只看 `extFail`，⛔ 不再靠阈值猜上限。**
 *
 * 🔴 旧的 `crossed_50_at` 是一个**在正常运行时必定触发**的告警：
 *   它照的是**免费档的 50**，而这个账号早已是付费档（实测 ≥200，见 index.ts:4155/4202）；
 *   而 `补邮箱` 一个正常满批就是 20 家 × 8 条路径 = **160** ⇒ **只要机器正常干活，它必响。**
 *   2026-09-03 我们为它查了一整轮**根本不存在的故障**，还把假警报当成事实报了出去。
 *   ⇒ **一个正常运行时必定触发的告警，等于没有告警，而且比没有更坏 —— 它会消耗真实的排查成本。**
 *
 * 🔴 而"改成 200"并不是修复，只是**把一个错的猜测换成没那么错的猜测**：
 *   实测记录写的是「付费档 **≥200**」——那是个**下界，不是已知常数**，平台哪天改了我们又错。
 *   ⇒ **停止猜上限，改成测真实失败**：`extFail > 0` 是**事实**，不是推测。
 *
 * ⇒ 字段定位：
 *   · `extFail`      → **唯一的真告警**（>0 = 真的有请求没发出去）
 *   · `ext_gt_50_at` → 降级为**信息性标记**：它只表示"累计超过 50"，**不表示越线**。
 *
 * `meterCoverage` 是给读表的人看的：**哪些数字是量出来的，哪些是量不到的**。
 * 不写这一句，读表的人会把"仪器不覆盖"当成"没有发生"。
 */
export function summary(): {
  marks: StepCount[]; ext: number; extFail: number; d1: number; sock: number;
  extGt50At: string | null; meterCoverage: Record<string, string>;
} {
  mark("(end)");
  const gt50 = marks.find((m) => m.extCum > 50);
  return {
    marks: marks.filter((m) => m.step !== "(init)"), ext, extFail, d1, sock,
    extGt50At: gt50 ? gt50.step : null,
    meterCoverage: {
      ext: "包住全局 fetch 数的 = **fetch 调用次数**（意图）。⚠️ 不等于平台消耗：redirect:follow 的一次调用只算 1，平台按每跳算（实测 54% 页面有跳转）→ **偏小**",
      extFail: "⭐ **真告警看这个**：fetch 真的抛错的次数（在 catch 里数 = 结果）。0 = 全发出去了；等于 ext = 一个都没发出去。⛔ 不含 404/500（那是对方的回答，请求发出去了）",
      "ext vs extFail": "🔴 2026-09-03 实证：`补邮箱` 满批**健康**是 ext 160，**被饿死**也是 ext 160（20 家 × 8 路径，越线后照常计数）——**靠 ext 分辨不出**，只能看 extFail。",
      d1: "包住 D1 绑定数的——prepare/bind/run/first/all/raw/batch（可信）。⚠️ D1 不占子请求额度",
      sock: "在 connect() 调用点数的——**不是包出口**；connect 不经 fetch，包不住。它是否占额度 = **未测量**（见 /api/diag/socket-subrequest-probe）",
      "未覆盖": "任何绕开 fetch/D1/connect 的出站都数不到 → 表上会显示 0，那是「看不见」不是「没有」",
      ext_gt_50_at: "⚠️ **只是信息性标记**（累计 >50 的那一步），⛔ **不是越线告警** —— 50 是免费档的数，本账号是付费档（实测 ≥200）。真越线看 extFail。",
      // ⚠️ 值里**只能用全角引号或「」** —— 半角双引号会把字符串提前闭合（刚才就栽了一次，tsc 当场红）。
      "怎么读": "某一步 ext=0 ⇒ **它根本没调用 fetch**（不可能是「调了被挡」，因为 ext++ 在真 fetch 之前）⇒ 那一步是「没活干」。某一步 extFail>0 ⇒ 那一步真的有请求没发出去。",
    },
  };
}

/** 每轮开头复位（Workers isolate 会复用，不复位会把上一轮的数累进来）。 */
export function reset(): void { curStep = "(init)"; ext = 0; extFail = 0; d1 = 0; sock = 0; marks.length = 0; }
