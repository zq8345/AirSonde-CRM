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
export interface StepCount { step: string; ext: number; d1: number; sock: number; extCum: number; d1Cum: number; sockCum: number }

let curStep = "(init)";
let ext = 0;
let d1 = 0;
let sock = 0;
const marks: StepCount[] = [];
let wrapped = false;

/** 包住全局 fetch。幂等：同一 isolate 只包一次，避免重复计数。 */
export function installFetchMeter(): void {
  if (wrapped) return;
  wrapped = true;
  const real = globalThis.fetch;
  // ⚠️ 只加一行 count，其余原样转发。失败也要转发出去（不吞）。
  globalThis.fetch = ((input: any, init?: any) => { ext++; return real(input, init); }) as typeof fetch;
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
  const prevD1 = marks.reduce((s, m) => s + m.d1, 0);
  const prevSock = marks.reduce((s, m) => s + m.sock, 0);
  marks.push({ step: curStep, ext: ext - prevExt, d1: d1 - prevD1, sock: sock - prevSock, extCum: ext, d1Cum: d1, sockCum: sock });
  curStep = step;
}

/**
 * 收尾并导出。**同时报出"在第几步越过 50"** —— 那才是我们真正要回答的问题。
 *
 * `meterCoverage` 是给读表的人看的：**哪些数字是量出来的，哪些是量不到的**。
 * 不写这一句，读表的人会把"仪器不覆盖"当成"没有发生"。
 */
export function summary(): {
  marks: StepCount[]; ext: number; d1: number; sock: number; crossedAt: string | null; meterCoverage: Record<string, string>;
} {
  mark("(end)");
  const crossed = marks.find((m) => m.extCum > 50);
  return {
    marks: marks.filter((m) => m.step !== "(init)"), ext, d1, sock,
    crossedAt: crossed ? crossed.step : null,
    meterCoverage: {
      ext: "包住全局 fetch 数的 = **fetch 调用次数**。⚠️ 不等于平台消耗：redirect:follow 的一次调用只算 1，平台按每跳算（实测 54% 页面有跳转）→ **越线前偏小**",
      "ext（越线后）": "⚠️ ext++ 在真 fetch 之前，越线后每次立即抛错但照样计数 → 越线后的数字是**尝试数**，那些步骤实际一个请求都没发出去",
      d1: "包住 D1 绑定数的——prepare/bind/run/first/all/raw/batch（可信）",
      sock: "在 connect() 调用点数的——**不是包出口**；connect 不经 fetch，包不住。它是否占那 50 = **未测量**（见 /api/diag/socket-subrequest-probe）",
      "未覆盖": "任何绕开 fetch/D1/connect 的出站都数不到 → 表上会显示 0，那是「看不见」不是「没有」",
      "怎么读": "ext 是「我们调了几次 fetch」，既不是消耗量也不是发出量。crossed_50_at 是**下限位置**，真实越线只会更早。",
    },
  };
}

/** 每轮开头复位（Workers isolate 会复用，不复位会把上一轮的数累进来）。 */
export function reset(): void { curStep = "(init)"; ext = 0; d1 = 0; sock = 0; marks.length = 0; }
