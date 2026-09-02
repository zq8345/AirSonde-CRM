// 版本戳：把"这个部署对应哪个 commit"写进 public/build.json，页面角落显示。
//
// ⭐ 为什么值得（2026-09-02，这一天栽了三次）：Joe 三次撞"部署了但看到旧页面"，
//   我们每次都要重新取证才能分清"是没部署"还是"是缓存"。有了这个戳，
//   **"我看到的是不是新版"从一个没法证伪的抱怨变成一眼可查的事实。**
//   （同一条纪律：断言产出，不断言产生它的东西 —— push 成功 / 部署返回 200
//     都不等于屏幕上是新的，只有屏幕上那个 sha 才算。）
// ⚠️ 生成物不进 git（.gitignore）：它每次部署都变，进 git 只会让每个 diff 都带一行噪音。
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const run = (cmd) => { try { return execSync(cmd, { cwd: root }).toString().trim(); } catch { return ""; } };

// 🔴 2026-09-02 降级：这个 sha **不再是版本戳的真源**。
//   真源改成了 Cloudflare 的 version id（见 /api/version 与 wrangler.jsonc 的 version_metadata）。
//   原因：部署流程是"先 deploy 后 commit" ⇒ 这里读到的 HEAD 永远落后一个 commit，
//   而戳的全部价值就是回答"生产跑的是哪一版"——**给一个误导性的答案比不给更坏**。
//   ⇒ 它现在只作为 `buildSha` 出现在悬浮里做**相关性对照**，并且明确标注"可能落后一个 commit"。
// ⚠️ `+dirty` 保留且更重要了：它是"部署内容与这个 sha 不一致"的唯一提示。
const sha = run("git rev-parse --short HEAD") || "unknown";
const dirty = run("git status --porcelain") ? "+dirty" : "";
const at = new Date().toISOString().replace("T", " ").slice(0, 16) + "Z";
const out = { sha: sha + dirty, at };
fs.writeFileSync(path.join(root, "public", "build.json"), JSON.stringify(out));
console.log(`[版本戳] ${out.sha} @ ${out.at}`);
