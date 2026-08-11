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

// 从 wrangler.jsonc 里读真实 cron（容忍注释：只取 "crons" 那一行的数组）
const m = wrangler.match(/"crons"\s*:\s*\[\s*"([^"]+)"/);
if (!m) { console.error("❌ [班次守卫] wrangler.jsonc 里读不出 crons —— 格式变了？"); process.exit(1); }
const cron = m[1];

// 这是**上一次人工核对过**的组合。cron 一变，或界面上「每 6 小时」的处数一变，就得重新核。
const EXPECT_CRON = "0 * * * *";
// 方案A 之后只剩 **2 处**说 6 小时，且都已人工核对为真：
//   · 飞书简报（DIGEST_MIN_GAP_MS = 6h，与 cron 无关）
//   · 免费目录刷新（isDirectoryRound = hourUtc % 6 —— 爬别人的站，守 Crawl-delay，**故意不提频**）
// 原来的第 3 处「每 6 小时自动搜索」已改成「每小时」：付费搜索走 isSearchRound（每轮都跑，480 次/天）。
// ⚠️ 搜索和目录刷新**已经拆成两个布尔**，别再把它们当同一个节奏。
const EXPECT_6H_MENTIONS = 2;

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
if (bad) process.exit(1);
console.log(`[班次守卫] cron="${cron}" · 界面「每 6 小时」${mentions} 处（均已人工核对为真）✓`);
