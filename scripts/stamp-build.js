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

const sha = run("git rev-parse --short HEAD") || "unknown";
// 工作树脏 = 部署的内容与这个 sha **不完全一致**，必须说出来，否则戳本身会骗人。
const dirty = run("git status --porcelain") ? "+dirty" : "";
const at = new Date().toISOString().replace("T", " ").slice(0, 16) + "Z";
const out = { sha: sha + dirty, at };
fs.writeFileSync(path.join(root, "public", "build.json"), JSON.stringify(out));
console.log(`[版本戳] ${out.sha} @ ${out.at}`);
