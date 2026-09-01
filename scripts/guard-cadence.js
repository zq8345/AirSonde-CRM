// 班次文案守卫：cron 频率一改，界面上说"每 X 小时"的地方必须跟着对。
//
// ⭐ 为什么需要它（这是一次真事故）：
//   P0-1 我把 cron 从 `0 */6 * * *` 提到 `0 * * * *`，**界面上 9 处「每 6 小时」一处没改** ——
//   Joe 读到的是一个不存在的系统。总工发现时他正在拿那个页面做决定（重开自动发送）。
//   而且不止文案：**简报那段代码也一个字没动**，于是"每班有动静就推"从 4 条/天 变成 24 条/天。
//
// ⚠️ 总工建议"把班次说明抽成常量，别在 9 个地方各写一遍字符串"。
//   我没那么做，理由：**那 9 处里有 3 处说的是不同的东西**——
//     · discovery / 目录刷新 → **真的**只在 0/6/12/18 跑（isDiscoveryRound，Serper 烧钱的硬约束）
//     · 飞书简报 → **真的**是 6 小时一条（有自己的 DIGEST_MIN_GAP_MS 节流）
//     · 其余 6 处 → 每小时
//   **抽成一个常量会把这三种节奏混成一个** —— 那是把"碰巧相等"固化成"必须相等"，
//   正是这次出事的根源（简报的节奏和 cron 的节奏本来就是两件事，只是以前碰巧相等）。
//
// 所以改成：**允许它们不一样，但一改 cron 就强制人来看一眼。**
// 这道守卫不判断文案对不对（它判断不了），它只保证 **cron 变了没人能装作不知道**。

const fs = require("fs");
const path = require("path");

const root = process.cwd();
const wrangler = fs.readFileSync(path.join(root, "wrangler.jsonc"), "utf8");
const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");

// 从 wrangler.jsonc 里读真实 cron。
// ⚠️ C5-22 起是**两条班次**，原来的正则只取第一条 —— 那样一来第二条改了它也不会红，
//   而这道闸的全部意义就是"节奏一变必须有人重新核"。所以改成读**整个数组**。
const mArr = wrangler.match(/"crons"\s*:\s*\[([\s\S]*?)\]/);
if (!mArr) { console.error("❌ [班次守卫] wrangler.jsonc 里读不出 crons —— 格式变了？"); process.exit(1); }
const crons = [...mArr[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
if (!crons.length) { console.error("❌ [班次守卫] crons 数组是空的"); process.exit(1); }
const cron = crons.join(" | ");

// 这是**上一次人工核对过**的组合。cron 一变，或界面上「每 6 小时」的处数一变，就得重新核。
// C5-22（2026-09-01）：改成**两条**班次，已人工核对：
//   · "* * * * *" 快 tick —— 只做增量出站（分析→批准→发信），**不含**找客户/目录/简报。
//     核过的点：① 它在 fastTick() 里，与 scheduled() 是两个函数，搜索预算不受影响；
//               ② 飞书简报在 scheduled() 的 step 4，且节流常量 DIGEST_MIN_GAP_MS=6h
//                  **与 cron 解耦**（上次提频时已显式化）⇒ 不会变成 1440 条/天。
//   · "0 * * * *" 整点班 —— 收回信/找客户/目录/跟进/简报，一如既往。
// ⚠️ 顺序有意义：这里比的是**拼起来的字符串**，改顺序也会红 —— 那是刻意的，
//    因为"哪条在前"在别处（wrangler dev 的 host 钉死）已经咬过人，节奏这里也不留侥幸。
const EXPECT_CRON = "* * * * * | 0 * * * *";
// C2-A（2026-08-31）之后只剩 **1 处**说 6 小时，已人工核对为真：
//   · 飞书简报（DIGEST_MIN_GAP_MS = 6h，与 cron 无关）—— 已比对 src/index.ts:3487，属实
// 少掉的那处是「免费目录刷新每 6h 检查一次」：C2-A 把目录源注册表清空（ENABLED_DIRECTORY_SOURCES=[]），
//   后台不再抓任何目录 ⇒ 那句话变成假话，界面文案与开关一并撤下。
//   ⚠️ **这道闸拦住了这次改动，是它该有的样子**：UI 上的节奏说法与代码真值必须一起动。
//   将来接上 IAQ 行业目录、把按钮加回来时，这个数要跟着回到 2，并重新核对那句文案。
// 另：「每 6 小时自动搜索」早已改成「每小时」——付费搜索走 isSearchRound（每轮都跑）。
// ⚠️ 搜索和目录刷新**是两个布尔**，别再把它们当同一个节奏。
// C5-2（2026-08-31）：**降到 0**。设置页重写后，界面上不再有任何"每 6 小时"的说法
//   —— 那句原本在飞书通知区（"每 6 小时来一条简报"）。代码真值仍是 6h（DIGEST_MIN_GAP_MS），
//   但**不提一个真事实不算说谎**，而按宪法铁律四 Joe 不需要这个数来做任何决定。
// ⚠️ 期望值 0 **不是把这道闸关掉**：它现在守的是反方向 ——
//   谁再往界面上写一句"每 6 小时"，这里就会红，逼他先去代码里核一遍那个数还对不对。
const EXPECT_6H_MENTIONS = 0;

const mentions = (html.match(/每 ?6 ?(h|小时)/g) || []).length;

let bad = false;
if (cron !== EXPECT_CRON) {
  console.error(`
❌ [班次守卫] cron 变了：预期 "${EXPECT_CRON}"，实际 "${cron}"

   **界面上有 ${mentions} 处在告诉 Joe 后台多久跑一次。改了 cron 就得逐处核对。**
   ⚠️ 别批量替换 —— 它们说的不是同一件事：
     · discovery / 目录刷新 → 只在 0/6/12/18 跑（isDiscoveryRound，Serper 硬约束）
     · 飞书简报 → 有自己的 DIGEST_MIN_GAP_MS 节流，跟 cron 无关
     · 其余 → 跟 cron 同步
   ⚠️ 而且**不止文案**：simple 的节流常量（DIGEST_MIN_GAP_MS）也要重新想 ——
      P0-1 那次就是只改了 cron，简报从 4 条/天 变成了 24 条/天。
   核完把这个文件里的 EXPECT_CRON / EXPECT_6H_MENTIONS 更新掉。
`);
  bad = true;
}
if (mentions !== EXPECT_6H_MENTIONS) {
  console.error(`
❌ [班次守卫] 界面上「每 6 小时」的处数变了：预期 ${EXPECT_6H_MENTIONS}，实际 ${mentions}

   预期的那 3 处是**故意保留**的（它们说 6 小时是对的）：
     · 飞书简报（DIGEST_MIN_GAP_MS = 6h）
     · 目录刷新 / 自动搜索（isDiscoveryRound：0/6/12/18）
   多出来的那处，要么是新写的假话，要么是这三处之一被改了。**去看一眼。**
   确认没问题就更新这个文件里的 EXPECT_6H_MENTIONS。
`);
  bad = true;
}
// ── 🔴 tick 预算 / 防重入锁 的不变式（2026-09-02 独立审计抓出的真缺陷）──
//   fastTick 原来用 RoundBudget 默认值（13 分钟），而锁只压 5 分钟 ⇒ 慢 tick 跑过自己的锁，
//   下一个 tick 判定"上一个死了"就进来 ⇒ **两个 tick 并发发信**。
//   ⚠️ 这个断言必须在**部署前**红，不能写成 src 里的顶层 throw ——
//      Workers 全局作用域抛错 = 整个 worker 起不来（零请求进得去），那比发不上去糟得多。
{
  const src = fs.readFileSync(path.join(root, "src", "index.ts"), "utf8");
  const num = (name) => {
    // ⚠️ 用 [\s\S] 之类的转义在这里被吃过一次（JS 单引号串里 '\s' 会退化成 's'），
    //    改成不依赖转义的切法：找到 'const <名字>' 之后到第一个 ';' 为止。
    const at = src.indexOf('const ' + name + ' =');
    const end = at < 0 ? -1 : src.indexOf(';', at);
    const expr = at < 0 || end < 0 ? null : src.slice(src.indexOf('=', at) + 1, end);
    const m = expr === null ? null : [null, expr];
    if (!m) { console.error(`
❌ [tick 闸] 找不到常量 ${name} —— 改名了？这个守卫就失效了，去修它。
`); bad = true; return null; }
    const v = Function(`"use strict";return (${m[1]})`)();
    if (!Number.isFinite(v)) { console.error(`
❌ [tick 闸] ${name} 求值不出数字：${m[1]}
`); bad = true; return null; }
    return v;
  };
  const budget = num('TICK_BUDGET_MS'), lock = num('TICK_LOCK_STALE_MS');
  if (budget !== null && lock !== null) {
    if (budget >= lock) {
      console.error(`
❌ [tick 闸] TICK_BUDGET_MS(${budget}) 必须 **严格小于** TICK_LOCK_STALE_MS(${lock})

   预算 ≥ 锁 = 一个慢 tick 能跑过自己的锁 = 下一个 tick 以为它死了就进来
   = **两个 tick 并发发信**（2026-09-02 审计抓出的原缺陷，别让它回来）。
`);
      bad = true;
    }
    // 另一头：预算也不能小到把各步的 budget.has(N) 全饿死（has 是严格大于）。
    const needs = [...src.matchAll(/budget\.has\((\d[\d_]*)\)/g)].map((m) => Number(m[1].replace(/_/g, '')));
    const maxNeed = needs.length ? Math.max(...needs) : 0;
    if (maxNeed && budget !== null && budget <= maxNeed) {
      console.error(`
❌ [tick 闸] TICK_BUDGET_MS(${budget}) ≤ 最大的 budget.has(${maxNeed})

   has() 是**严格大于**（remaining > need）⇒ 这一步**永远为假**，那条链会**静默死掉**：
   日志只显示"跳过"，不报任何错。发信正是卡在 has(50_000) 这一档上。
`);
      bad = true;
    }
    if (!bad) console.log(`[tick 闸] 预算 ${budget}ms < 锁 ${lock}ms，且 > 最大步需求 ${maxNeed}ms ✓`);
  }
}

if (bad) process.exit(1);
console.log(`[班次守卫] cron="${cron}" · 界面「每 6 小时」${mentions} 处（均已人工核对为真）✓`);
