#!/usr/bin/env node
/**
 * 设计宪法闸（docs/CRM-DESIGN.md 铁律二）—— 字数预算 + 禁词表，**错了自己会红**。
 *
 * ⚠️ 判据口径与宪法逐字一致，**冻结在这里**：
 *   · 零数据态测量（leads=0/replies=0）—— 预算管的是"页面自己说的话"，不是客户名字
 *   · 取该页根容器 innerText，\s+ 归一为单空格后计字符数
 *   · 折叠块收起时的内容、(?) 提示内容不计
 *
 * ⚠️ 这道闸打的是**渲染后的产出**，不是源码里的字符串 ——
 *    源码里搜不到"熔断"不代表页面上没有（模板拼接、变量注入都会绕过源码搜索）。
 *
 * 跑法（需要一个已起的 dev；⚠️ 先证进程身份再量）：
 *   node scripts/guard-design.mjs                 # 默认 http://127.0.0.1:8791
 *   BASE=http://127.0.0.1:8791 node scripts/guard-design.mjs
 *
 * ⚠️ 本闸**需要浏览器**才能量渲染结果，node 单跑只能做静态部分。
 *    完整版由窗口在 Browser 里执行 checkPage() 那段（见文件末尾导出）。
 */
export const BUDGET = { today: 400, customers: 500, settings: 900 };   // 机器房不设上限
export const BANNED = ["熔断", "爬坡", "子请求", "轮转", "组合", "阈值", "翻牌堆", "Serper", "窗口", "算式", "subreq"];

/**
 * 🔴 每页的容器**不是同一个**。设置页渲染在 `#v-settings`，而 `#v-page` 此时是
 *    `display:none` 的空壳 —— 拿默认选择器去量设置页会得到 **chars:0**，
 *    再被 `0 <= 900` 判成"合宪"。**这就是一次假绿**：闸没量到东西，却报了通过。
 *    ⇒ 选择器必须逐页写死，并且**由浏览器实测过**（2026-08-31 量过：
 *      today=#v-page 286 · settings=#v-settings 707 · machine=#v-page 1163）。
 *
 * 🔴 C5-14（2026-09-01）补一条同型缺陷：`customers` 原本也写着 `#v-page`，**但客户页渲染在
 *    `#v-list`**。上面那份"实测过"的清单里**恰恰没有 customers 这一行** —— 也就是说
 *    客户页的字数预算从立闸那天起**一次都没真正量过**，闸每次都在报"没量到"或量了别的页。
 *    教训跟上一条一模一样：**冻结的常量表也要有人真去撞一次**，写下来不等于量过。
 *    ⇒ 这次逐页实测并把数记在这里（零数据态）：
 *      today=#v-page 214 · customers=#v-list 356 · settings=#v-settings 764 · machine=#v-page 690
 */
export const PAGE_SELECTOR = {
  today: "#v-page",
  customers: "#v-list",
  settings: "#v-settings",
  machine: "#v-page",
};

/** 在浏览器里对某一页取数（返回 {chars, banned[]}）。不传 selector 时按 PAGE_SELECTOR 取。 */
export function measure(doc, selector = "#v-page") {
  const el = doc.querySelector(selector);
  if (!el) return { chars: -1, banned: [], error: `找不到 ${selector}` };
  // ⛔ 藏着的容器不算量到 —— 隐藏元素的 innerText 是空串，会伪装成"这页很干净"。
  const view = doc.defaultView;
  if (view && view.getComputedStyle(el).display === "none") {
    return { chars: -1, banned: [], error: `${selector} 是隐藏的（display:none）—— 没量到，不是"很短"` };
  }
  // 折叠块收起时不计：<details> 未 open 的内容、以及 display:none 的节点
  const clone = el.cloneNode(true);
  clone.querySelectorAll("details:not([open])").forEach((d) => {
    const s = d.querySelector("summary");
    d.replaceChildren(s ? s.cloneNode(true) : doc.createTextNode(""));
  });
  // ⭐⭐ 冻结口径：从字数里剔除什么、为什么剔除。**这段就是"字数"的定义，改它等于改判据。**
  //
  //   · [data-help] / .help-pop  —— 悬浮解释。它不占版面、Joe 不主动看就不存在。
  //   · [hidden]                 —— 没渲染的东西不算"页面说的话"。
  //   · [data-user-content]      —— **Joe 自己配置的数据**（2026-09-02 加）。
  //
  // 🔴 第三条的依据是本文件开头那句原话：「预算管的是"页面自己说的话"，不是客户名字」。
  //   26 个关键词 chip 上的文字是 **Joe 填进去的内容**，与客户名字同类 —— 页面只是把它显示出来。
  //   预算存在的理由是"别让机器对 Joe 唠叨"，而他自己填的词不是唠叨。
  //
  // ⛔⛔ 这是一个**豁免**，而豁免天然是漏洞的入口：任何人只要给一坨解释文案挂上
  //   `data-user-content`，就能让它凭空从预算里消失。所以下面的自检里配了**反向样本**：
  //   「页面自己的话超预算时必须仍然报红」。那条自检红不了，这个豁免就已经变成漏洞了。
  //   ⇒ 加 `data-user-content` 的判据只有一条：**这段文字的作者是 Joe，不是我们。**
  clone.querySelectorAll("[data-help], .help-pop, [hidden], [data-user-content]").forEach((n) => n.remove());
  const text = (clone.innerText || clone.textContent || "").replace(/\s+/g, " ").trim();
  return { chars: text.length, banned: BANNED.filter((w) => text.includes(w)), text };
}

/** 禁词只管 **Joe 视线区**三页；机器房是排查页，术语正是它该说的话。 */
export const BANNED_PAGES = ["today", "customers", "settings"];

/** 判定一页是否合宪。 */
export function judge(page, m) {
  const cap = BUDGET[page];
  const overs = [];
  // 🔴 **没量到 ≠ 合格。** 量出 0 字或报错时必须判红：
  //    一个渲染失败的页面会得到 chars:0，而 `0 <= 预算` 恒真 —— 那是最坏的一种绿灯，
  //    它长得跟"这页写得很克制"一模一样。(2026-08-31 设置页真的这样绿过一次。)
  if (m.error) return { ok: false, reasons: [`没量到：${m.error}`], chars: m.chars };
  if (!(m.chars > 0)) return { ok: false, reasons: [`没量到：字数为 ${m.chars}（页面没渲染？选择器错了？）`], chars: m.chars };
  if (cap != null && m.chars > cap) overs.push(`字数 ${m.chars} > 预算 ${cap}`);
  // ⚠️ 第一版这里漏了页面豁免，把机器房也判成不合宪 —— **是自检的第 4 个用例抓出来的**。
  //    教训照旧：闸自己也必须被一个"已知该绿/该红"的样本量过，否则它只是看起来在工作。
  if (BANNED_PAGES.includes(page) && m.banned.length) overs.push(`出现禁词：${m.banned.join(" / ")}`);
  return { ok: overs.length === 0, reasons: overs, chars: m.chars };
}

// node 直跑时只做自检：证明这道闸**能在真实缺陷上报红**（不是只在健康样本上绿）
// ⚠️ 不用 `import.meta.url === file://${argv[1]}` 比较：Windows 盘符 + 中文路径会被百分号编码，
//    两边永远不相等 —— 自检会**一声不吭地不执行**（我第一版就这样，跑出来零输出）。
// ⚠️ `typeof process` 这层守卫不是多余的：本文件的说明书写着"完整版由窗口在 Browser 里执行"，
//    而浏览器里没有 `process` —— 顶层裸读它会让整个 import **直接抛错**，
//    也就是说这道闸**按它自己写的用法根本跑不起来**。（C5-14 真撞上了才发现。）
if (typeof process !== "undefined" && String(process.argv?.[1] || "").replace(/\\/g, "/").endsWith("guard-design.mjs")) {
  // text === null 模拟 measure() 找不到元素时的返回形态（chars:-1 + error）
  const fake = (text) => text === null
    ? { chars: -1, banned: [], error: "找不到 #v-settings" }
    : { chars: text.replace(/\s+/g, " ").trim().length, banned: BANNED.filter((w) => text.includes(w)) };
  const cases = [
    ["健康样本（短、无禁词）", "today", "今天发了 3 封开发信 · 1 个客户回了你", true],
    ["🔴 真实缺陷①：C2-D 我写过的那句页脚", "today", "想看机器内部（预算/熔断/爬坡/点火明细）→ 机器房", false],
    ["🔴 真实缺陷②：超预算", "today", "字".repeat(401), false],
    ["机器房豁免禁词（不在 BUDGET 里）", "machine", "熔断状态：正常；爬坡上限 30", true],
    // 🔴 真实缺陷③（2026-08-31）：设置页渲染在 #v-settings，闸却拿默认 #v-page 去量，
    //    量出 0 字，再被 `0 <= 900` 判成合宪 —— **一次假绿**。这一条是它的正对照。
    ["🔴 真实缺陷③：没量到却报合宪（0 字）", "settings", "", false],
  ];
  // 反向自证：measure 报错时也必须红（不能只在 chars=0 这一种形态上红）
  cases.push(["🔴 真实缺陷③变体：选择器找不到元素", "settings", null, false]);

  // ══ data-user-content 豁免的自检（2026-09-02 加）══
  //
  // ⚠️ 上面那些用例走的是 `fake()`，**根本不经过 measure()** —— 它们只在数字上做算术，
  //    测不到"剔除哪些节点"这段逻辑。而豁免的风险恰恰全在那一行选择器上。
  //    ⇒ 这里搭一个**最小 DOM 替身**，让判据真的走一遍 measure()。
  //    替身只实现 measure 用到的那几个方法；它故意**照着 measure 里那行选择器字符串**解析，
  //    所以谁把 `[data-user-content]` 从那行里删掉/写错，下面第一条就会红。
  const stubDoc = (nodes) => {
    const mk = () => ({
      _nodes: nodes.map((n) => ({ ...n, gone: false })),
      cloneNode() { return mk(); },
      querySelectorAll(sel) {
        const toks = sel.split(",").map((t) => t.trim().replace(/^\[|\]$/g, "").replace(/^\./, ""));
        const self = this;
        return self._nodes.filter((n) => !n.gone && n.attrs.some((a) => toks.includes(a)))
          .map((n) => ({ remove() { n.gone = true; }, querySelector: () => null, replaceChildren() {} }));
      },
      get textContent() { return this._nodes.filter((n) => !n.gone).map((n) => n.text).join(" "); },
      get innerText() { return this.textContent; },
    });
    const root = mk();
    return { querySelector: () => root, defaultView: { getComputedStyle: () => ({ display: "block" }) },
             createTextNode: (t) => ({ text: t, attrs: [] }) };
  };
  const own = (n) => ({ attrs: [], text: "字".repeat(n) });          // 页面自己说的话
  const user = (n) => ({ attrs: ["data-user-content"], text: "词".repeat(n) });  // Joe 配置的数据
  const help = (n) => ({ attrs: ["data-help"], text: "悬".repeat(n) });          // 悬浮解释

  let pass = 0, fail = 0;
  const pass2Inc = () => pass++, fail2Inc = () => fail++;
  const domCases = [
    // ✅ 正对照：页面自话 500 + Joe 的数据 800 + 悬浮 300 ⇒ 只算 500，合宪
    ["✅ 豁免生效：Joe 配的关键词不进预算", [own(500), user(800), help(300)], true],
    // 🔴🔴 **反向自证（这条最要紧）**：页面自话本身就超预算时，豁免绝不能把它救回来。
    //     这一条绿了 = 豁免已经变成漏洞，等于谁想超预算只要挂个 data-user-content。
    ["🔴 豁免不得成为漏洞：页面自话 1200 字仍必须报红", [own(1200), user(800)], false],
    // 🔴 边界：只有页面自话、没有任何豁免节点时，行为与从前完全一致
    ["🔴 无豁免节点时行为不变：1200 字报红", [own(1200)], false],
  ];
  for (const [name, nodes, wantOk] of domCases) {
    const m = measure(stubDoc(nodes), "#v-settings");
    const r = judge("settings", m);
    const ok = r.ok === wantOk;
    ok ? pass2Inc() : fail2Inc();
    console.log(`  ${ok ? "✅" : "🔴"} ${name} —— 量到 ${m.chars} 字，判定 ${r.ok ? "合宪" : "不合宪"}`);
  }
  for (const [name, page, text, wantOk] of cases) {
    const r = judge(page, fake(text));
    const ok = r.ok === wantOk;
    ok ? pass++ : fail++;
    console.log(`  ${ok ? "✅" : "🔴"} ${name} —— 判定 ${r.ok ? "合宪" : "不合宪"}${r.reasons.length ? "（" + r.reasons.join("；") + "）" : ""}`);
  }
  console.log(`\n通过 ${pass} · 失败 ${fail}`);
  console.log(fail === 0
    ? "✅ 闸自检通过：**在真实发生过的缺陷上会红**（案例①正是 C2-D 那次被它抓住的原句）"
    : "🔴 闸自身有问题");
  process.exit(fail ? 1 : 0);
}
