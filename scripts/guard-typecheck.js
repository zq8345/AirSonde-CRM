// 部署闸的**前置闸**：先证明"类型检查这道闸存在"，再让它跑。
//
// ⭐ 为什么需要它（这是一条原则的直接推论，不是一个取舍）：
//   "部署闸不能依赖我的自觉" —— 而**一道只有 node_modules 装对了才存在的闸，
//    就是在依赖某人记得 npm ci**。那跟依赖自觉是同一种东西，只是换了个载体。
//
// 2026-07-17 一晚上撞了三次「绿灯骗人」，形状完全一样 ——
//   ① `wrangler deploy --dry-run` 对 `export const` 亮绿，而生产拒绝启动
//   ② `npx tsc` 亮绿，因为它跑到了系统上另一个叫 tsc 的东西（tsconfig 一直在、
//      workers-types 一直在、**唯独 typescript 本身没装**，我们却一直以为有类型检查）
//   ③ 部署 worktree 的 node_modules 里没有 typescript
// 共同点不是"有人不细心"，是 **"防线的存在与否，本身从来没有被检查过"**。这个文件就是去检查它。
//
// ⚠️ 实测澄清一件事（别把理由记错）：没装 typescript 时 `npm run typecheck` **不会**静默通过，
//    它退出码 1，闸是**拦得住**的。但它吐的是 `node:internal/modules/cjs/loader:1503` 这种天书 ——
//    **真正的问题不是"它会放过去"，是"它失败的理由没人读得懂"。而看不懂的失败，人是会去绕过的。**
//    所以这道检查的价值是**说人话**，不是堵一个会漏的洞。理由要记准，不然下次会防错东西。
//
// ⚠️ 为什么查文件而不是 `npx tsc --version`：
//    **npx 找不到会去网上下一个** —— 那正是第 ② 种骗法的来源。查文件不会。
//    node 是必然存在的（npm 就是它跑起来的），所以这一句不引入任何新依赖。

const fs = require("fs");
const path = require("path");

const pkg = path.join(process.cwd(), "node_modules", "typescript", "package.json");

if (!fs.existsSync(pkg)) {
  console.error(`
❌ [部署闸] typescript 没装 —— **类型检查这道闸此刻不存在**。

   先跑：  npm ci

   为什么硬拦而不是跳过：
   一道"只有 node_modules 装对了才存在"的闸，等于在依赖某人记得 npm ci。
   而它恰恰要防的那类 bug（漏 import、只在 scheduled() 里跑的代码），
   boot 200 + 0 Uncaught 全是绿的，**只有类型检查抓得到**。
   闸不在的时候亮绿灯，比没有闸更危险。
`);
  process.exit(1);
}

// 版本也报一下：让"这道闸用的是哪一版"这件事**可见**，而不是又一个默认成立的假设。
try {
  const v = JSON.parse(fs.readFileSync(pkg, "utf8")).version;
  console.log(`[部署闸] typescript ${v} ✓ 类型检查可用`);
} catch {
  console.log("[部署闸] typescript ✓（版本号读不出，不影响）");
}
