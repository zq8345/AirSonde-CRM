// P5 自动找客户：关键词 → 搜索 API → 提取公司官网 → 去重入库
import type { Env } from "./index";
import { realReplySql, notTestSql } from "./noise";

// 默认关键词池 —— **Joe 定版（C4-A，2026-08-31）**。此清单是唯一真源。
// ⚠️ 改这里**不会**改变生产：`keywords` 表里已有旧词，且播种是 `ON CONFLICT DO NOTHING`（只增不删）。
//    要让生产对齐，必须走 `POST /api/admin/reset-keywords`（清表重灌）。
//    ——「改了默认值以为就生效了」正是这一行注释要挡的那种错。
export const DEFAULT_KEYWORDS = [
  // ── 渠道型 × IAQ ──
  "air quality monitor distributor",
  "air quality monitor wholesale",
  "IAQ monitor supplier",
  "air quality sensor distributor",
  "environmental monitoring equipment distributor",
  // ── 品牌方 / 白牌 ──
  "air quality monitor private label",
  "air quality monitor OEM",
  "smart home device brand",                              // C4-A 新增：白牌智能家居品牌方
  // ── 垂直集成 / 安装 ──
  "HVAC controls integrator",
  "building automation systems integrator",
  "BMS integrator air quality",
  "indoor air quality services company",
  "ventilation systems installer",
  "smart building solutions provider",
  // ── 相邻品类 分销 / 批发 ──
  "HVAC parts wholesale distributor",
  "test and measurement instruments distributor",
  // ── C4-A 新增：气体检测 / 职安健（与 IAQ 同一批买家、同一条渠道）──
  "breathalyzer distributor",
  "alcohol tester wholesale",
  "carbon monoxide detector distributor",
  "gas detection equipment distributor",
  "safety equipment distributor",
  "occupational health and safety equipment supplier",
  "workplace safety compliance solutions",
  // ── 场景意图 ──
  "school air quality monitoring provider",
  "office air quality compliance",
  "CO2 monitor bulk supplier",
];

// E2：每条搜索追加的排除串（滤掉中国铺货平台）。
// ⚠️ 实测：Serper/Google 的 `-site:*.cn`/`-site:.cn`（TLD 级 -site）会把结果清零（Google 语法怪癖），故不用；
// 中文站/.cn 改由结果侧 domain.endsWith('.cn') 兜底过滤（见 runDiscovery）。词级 -term 实测正常生效。
export const EXCLUDE_QUERY = "-alibaba -aliexpress -made-in-china -dhgate -temu";

interface SearchResult { title: string; url: string; }

// ⭐ 目标市场（gl 代码 → 中文名）—— Joe 定版（C4-A，2026-08-31）：27 国
//    → **Joe 扩容（C5-47，2026-09-03）：51 国**（补全欧盟 +11 / 中东 +7 / 南美 +6）
//    → **Joe 再扩（C5-50，2026-09-04）：60 国**（新兴市场 +9；点名 10 个，hk 因黑名单未加，见下）
//
// 上游那份是按另一条产品线的市场覆盖收录的（100+ 国，含大量微市场），对 AirSonde 不成立：
//   IAQ 检测仪的买家高度集中在**法规趋严 + 采购力强**的欧美与发达亚太，
//   而多录 80 个国家不是"多一点机会"，是**把每天有限的搜索预算摊薄到搜不出东西的市场里**。
//
// 分级只表达优先级，不是硬门槛（都在同一张表里，搜索面由 settings.search_countries 决定）：
//   一级 15：核心英语区 + 西欧北欧 —— 法规成熟、进口商密集、英文冷邮件不违和
//   二级 45：EU 其余成员国 / 发达亚太 / 中东 / 南美 / 新兴市场 —— 有量但渠道更分散，作第二梯队
//            ⚠️ 其中 33 国是 2026-09-03（24）与 09-04（9）新扩的**待验证市场**，
//               一条真实数据都没有（见下面两段注释）
//
// ⚠️ 这是 UI 下拉 + 国家名显示 + cron 搜索面的**唯一真源**（前端 countryName 从 /api/stats
//    的 allCountries 动态填，不再各写一份）。
// ⚠️ Serper/Google 的 gl 参数接受所有 ISO 3166-1 alpha-2 码 → 没有"gl 不支持"的市场。
export const COUNTRIES: Record<string, string> = {
  // ── 一级市场（15）──
  us: "美国", ca: "加拿大", gb: "英国", ie: "爱尔兰", de: "德国", fr: "法国",
  nl: "荷兰", be: "比利时", at: "奥地利", ch: "瑞士", se: "瑞典", no: "挪威",
  dk: "丹麦", fi: "芬兰", au: "澳大利亚",
  // ── 二级市场（12）──
  nz: "新西兰", it: "意大利", es: "西班牙", pt: "葡萄牙", pl: "波兰", cz: "捷克",
  jp: "日本", kr: "韩国", sg: "新加坡", ae: "阿联酋", lu: "卢森堡", gr: "希腊",

  // ══ C5-47 扩容（Joe 2026-09-03：「补全欧盟，中东，南美」）：+24，二级市场 12 → 36 ══
  //
  // 🔴 **这 24 国是投石问路，不是已验证的好市场** —— 报告里别写成"扩了 24 个优质市场"。
  //    中东和南美我们**一条真实数据都没有**；唯一的中东样本是阿联酋（合格率 54%，但只有 11 家，
  //    样本刚够线）。而日本 3.4% 已经证明「发达市场 ≠ 合格率高」。
  //    ⇒ 一轮扫完之后按合格率回看该收窄谁。
  //
  // ⚠️ 为什么值得扩：瓶颈**不是搜得慢，是搜索面搜干了** —— 09-03 搜索量翻到 4 倍
  //    （461 → 1867），新线索反而从 588 掉到 115，因为 discovery 游标绕回来重搜老组合。
  //    加预算换不来线索，**加国家/关键词才能**。组合数 702 → 1326。

  // ── 补全欧盟（+11）：加完 COUNTRIES 覆盖 EU27 全员（原有 16 + 这 11）──
  //    ⭐ 三块里最硬的一块：EU 的 IAQ/通风法规是全欧统一的，法规利好对新成员国同样成立。
  bg: "保加利亚", hr: "克罗地亚", cy: "塞浦路斯", ee: "爱沙尼亚", hu: "匈牙利",
  lv: "拉脱维亚", lt: "立陶宛", mt: "马耳他", ro: "罗马尼亚", sk: "斯洛伐克", si: "斯洛文尼亚",

  // ── 中东（+7）；阿联酋 ae 已在上面 ──
  //    ⛔ 叙利亚 sy / 伊朗 ir 不加（在 BLACKLIST_GL 里）。
  //    ⚠️ tr 土耳其是欧亚交界，按 EMEA 商务习惯归在这批；若判定不该算，单独去掉它不影响其余。
  sa: "沙特阿拉伯", qa: "卡塔尔", kw: "科威特", bh: "巴林", om: "阿曼", il: "以色列", tr: "土耳其",

  // ── 南美（+6）──
  //    ⛔ 委内瑞拉 ve 不加：制裁风险，性质同 BLACKLIST_GL 那批。要加需 Joe 明确点名。
  //    ⭐ CCTLD_MAP 已含 .com.br/.br/.com.ar/.ar/.cl/.com.co/.com.pe/.pe ⇒ 这批的国家推断天然就通。
  br: "巴西", ar: "阿根廷", cl: "智利", co: "哥伦比亚", pe: "秘鲁", uy: "乌拉圭",

  // ══ C5-50 扩容（Joe 2026-09-04：「重新把目标国家继续扩大」）：+9，二级市场 36 → 45 ══
  //
  // 🔴 **同 C5-47 那批：投石问路，不是已验证的好市场。** 这 9 国一条真实数据都没有，
  //    报告里别写成"扩了 9 个优质市场"。一轮扫完按合格率回看该收窄谁。
  // ⚠️ Joe 点名的是 10 个，这里只有 9 —— **中国香港 hk 没加**，它在 BLACKLIST_GL 里，
  //    加进来会变成一个「界面能勾、机器永远不搜」的假选项（getSearchConfig 和 runDiscovery
  //    各滤一道黑名单）。要加得先由 Joe 决定动不动那张黑名单，⛔ 不在本次范围内。
  // ⛔ Joe 没批孟加拉 / 巴基斯坦 / 尼日利亚，别顺手补。
  //
  // ⚠️ 国家推断天然就通，不需要动 CCTLD_MAP：discover.ts:639 是
  //    `inferCountryFromWebsite(website) || gl.toUpperCase()` —— ccTLD 推不出就落 gl。
  //    （.com.mx/.mx、.com.vn/.vn、.co.id/.id、.com.ph/.ph、.co.za/.za 本来就在表里；
  //     .in/.th/.my/.eg 不在，但走 gl 兜底一样填得对。）
  mx: "墨西哥", in: "印度", th: "泰国", vn: "越南", my: "马来西亚",
  id: "印度尼西亚", ph: "菲律宾", za: "南非", eg: "埃及",
};

/** 一级市场（优先级用，不是过滤器）—— 供 UI 分组显示。 */
export const TIER1_COUNTRIES = ["us","ca","gb","ie","de","fr","nl","be","at","ch","se","no","dk","fi","au"] as const;

// ⭐ 永不搜的市场：runDiscovery 里硬挡，双保险。
//   名单沿用上游，理由与产品线无关：制裁 / 出口管制 / 冷邮件合规雷区。
//   af by cn hk mo kp ru sy cu ir
//   ⚠️ 现在的 COUNTRIES（51 国）本来就不含这些 —— 这道硬挡是**第二层**：
//      将来有人往表里加国家时它仍然拦得住。闸不能只有一层。
export const BLACKLIST_GL = new Set(["af", "by", "cn", "hk", "mo", "kp", "ru", "sy", "cu", "ir"]);

// ⭐ 批㉑：默认搜索面 = **COUNTRIES 全量**（减去拉黑）。
//   Joe 要"系统全包国家"，所以不再是"勾选子集"。配置缺失 = 全量（见 getSearchConfig），不是零。
export const DEFAULT_COUNTRIES = Object.keys(COUNTRIES).filter((c) => !BLACKLIST_GL.has(c));

// ══⭐ C5-50②：关键词的**语言**决定它跑哪些国家（Joe 2026-09-04 批的多语言试水）══
//
// 为什么要绑：一个德语词在巴西搜没有意义，还白烧一次 Serper 额度。
// ⚠️ 映射**做成数据**，⛔ 不散在代码里 —— 散开的话"某个语言跑哪几国"就会有第二个家。
// ⚠️ `"ALL"` 是显式值，⛔ 不用"空数组=全部"这种约定：空数组在别处天然表示"一个都没有"，
//    让同一个形状承担两种相反的含义，就是下一次静默停搜的来源。
export const LANG_COUNTRIES: Record<string, string[] | "ALL"> = {
  en: "ALL",                                            // 英文 = 全部国家（现状不变）
  de: ["de", "at", "ch"],                               // 德奥瑞
  es: ["es", "mx", "co", "pe", "cl", "ar", "uy"],       // 西班牙 + 墨哥秘智阿乌（mx 是 C5-50① 才加进目录的）
  fr: ["fr", "be", "ch"],                               // 法比瑞
  it: ["it", "ch"],                                     // 意瑞
};

/**
 * 这个语言在**本轮实际可搜的国家**里能跑哪几个。
 *
 * ⚠️ 一定是与 `available`（已选国家 ∩ 未拉黑）取交集，不是直接返回语言组 ——
 *    Joe 把德国取消勾选之后，德语词就该只剩奥地利和瑞士，⛔ 不能绕过他的选择。
 * ⚠️ 认不出的语言 **回落 "ALL" 并吼一声**，⛔ 不回落空数组：
 *    空数组 = 这个词从此静默不搜，而这正是本仓反复栽的那类病（没搜和搜不到长得一样）。
 */
export function countriesForLang(lang: string, available: string[]): string[] {
  const g = LANG_COUNTRIES[String(lang || "en").trim().toLowerCase()];
  if (g === undefined) {
    console.log(`discovery: 关键词语言 "${lang}" 不在 LANG_COUNTRIES 里 —— 按全部国家跑（请补映射）`);
    return available.slice();
  }
  if (g === "ALL") return available.slice();
  const set = new Set(available);
  return g.filter((gl) => set.has(gl));
}

// 遗留数据国家推断：按官网 ccTLD 后缀映射（最佳努力）。
// 通用后缀（.com/.net/.org 等）+ 被当"通用短域名"卖的伪 ccTLD（.co/.io/.ai/.me/.tv/.cc，
//   如 .co=哥伦比亚但大量美国公司在用）一律不当国家信号 → 返回 ""（保持 NULL，不猜、不默认美国）。
// 只保留明确 ccTLD：多级更稳（.com.au/.co.nz/.com.br/.com.co/.co.uk/.co.za）+ 真国别单级（.us/.ca/.mx/.nz/.au/.ng/.ke/.cl/.pe/.ar 等）。
//   （.us 是真 ccTLD，非美企基本不用；命中率低但命中即可靠，不违"绝不瞎猜"。）
// 按后缀长度降序匹配（下方 .sort 保证），使 .co.za/.co.ke 等长后缀先于短后缀命中，避免误判。
const CCTLD_MAP: [string, string][] = ([
  [".com.au", "AU"], [".net.au", "AU"], [".org.au", "AU"], [".au", "AU"],
  [".co.nz", "NZ"], [".net.nz", "NZ"], [".nz", "NZ"],
  [".co.uk", "GB"], [".org.uk", "GB"], [".uk", "GB"],
  [".com.br", "BR"], [".br", "BR"],
  [".com.mx", "MX"], [".mx", "MX"],
  [".com.ar", "AR"], [".ar", "AR"],
  [".cl", "CL"], [".com.co", "CO"], [".com.pe", "PE"], [".pe", "PE"],
  [".ca", "CA"], [".us", "US"],
  [".co.za", "ZA"], [".za", "ZA"],
  [".com.ng", "NG"], [".ng", "NG"], [".co.ke", "KE"], [".ke", "KE"], [".co.zw", "ZW"], [".zw", "ZW"],
  [".com.vn", "VN"], [".vn", "VN"], [".co.id", "ID"], [".id", "ID"], [".lk", "LK"],
  [".com.sg", "SG"], [".sg", "SG"], [".com.ph", "PH"], [".ph", "PH"],
  [".de", "DE"], [".fr", "FR"], [".nl", "NL"], [".es", "ES"], [".it", "IT"], [".ae", "AE"],
] as [string, string][]).sort((a, b) => b[0].length - a[0].length);
export function inferCountryFromWebsite(website: string): string {
  let host = "";
  try { host = new URL(website).hostname.toLowerCase(); }
  catch { host = (website || "").toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""); }
  host = host.replace(/^www\./, "");
  if (!host) return "";
  for (const [suffix, cc] of CCTLD_MAP) {   // 已按后缀长度降序：最特异的先匹配
    if (host.endsWith(suffix)) return cc;
  }
  return ""; // 通用后缀无法判定 → 保持 NULL（不猜、不默认美国）
}

// 搜索提供商（可插拔）：默认 Serper（Google 搜索 API，便宜，有免费额度）
// gl = 国家定向（如 us/au/ca）；hl = 界面语言（如 de/es）
//
// 🔴 C5-50②：**只设 gl 不设 hl，Google 仍然偏向英文结果，多语言方案会白做。**
// ⚠️ 但 `hl` 对**英文词一律不发**（下面 searchSerper 里只在 hl 非空时才加这个键）——
//    判据是"英文词行为零变化，改动前后请求逐字相同"。多发一个 `hl:"en"` 即使语义等价，
//    也已经不是"逐字相同"了，而我**没有实测过** Serper 的 hl 缺省值就是 en。
//    ⇒ 不知道的事就别改它。
export async function searchCompanies(env: Env, query: string, num = 10, gl = "us", hl = ""): Promise<SearchResult[]> {
  const provider = (env.SEARCH_PROVIDER || "serper").toLowerCase();
  if (provider === "serper") return searchSerper(env, query, num, gl, hl);
  throw new Error(`未知搜索提供商: ${provider}（目前支持 serper）`);
}

async function searchSerper(env: Env, query: string, num: number, gl: string, hl = ""): Promise<SearchResult[]> {
  if (!env.SEARCH_API_KEY) throw new Error("缺少 SEARCH_API_KEY（去 serper.dev 生成，免费额度即可）");
  const q = `${query} ${EXCLUDE_QUERY}`.trim(); // E2：追加排除串，滤中国铺货平台/中文站
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "X-API-KEY": env.SEARCH_API_KEY, "content-type": "application/json" },
    // ⚠️ `hl` **只在非空时才进 body** —— 英文词走的是与改动前**逐字相同**的请求体
    //    `{q, num, gl}`。这不是省事，是判据：英文词行为零变化要能被"抓一条请求逐字对照"验到。
    body: JSON.stringify(hl ? { q, num, gl, hl } : { q, num, gl }),
  });
  if (!res.ok) throw new Error(`Serper ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const data: any = await res.json();
  return (data.organic || [])
    .map((o: any) => ({ title: o.title || "", url: o.link || "" }))
    .filter((r: SearchResult) => r.url);
}

/**
 * 每日 Serper 搜索次数的**默认**上限（settings.serper_daily_budget 没设时用它）。
 *
 * ⚠️ 它是**封顶**，不是油门。别指望调高它就能多搜 —— 真正决定每天搜多少次的是另外两个：
 *   · `maxCombos`（cron 每轮只跑 20 个 keyword×country 组合，见 index.ts 的 runDiscovery 调用）
 *   · `isDiscoveryRound`（hourUtc % 6 === 0 → 一天只有 4 轮）
 *   → 4 轮 × 20 = **80 次/天**，生产实测正是 70-80/天，从来没撞到过 200 这个封顶。
 * 所以 200→1000 只是把天花板抬高留出余量；要真的多找客户，得动 maxCombos / 轮次 / 词×国。
 * 单一真源：discover.ts 和 index.ts 的兜底都引用这个常量，别再各写各的字面量。
 */
export const SERPER_DAILY_BUDGET_DEFAULT = 1000;

// 找客户配置：目标国家 + 每关键词每国家取几条
//
// 🔴 **C5-47 改回来了：这里重新读 `search_countries`。**（下面那段旧注释是它的来历，别删）
//   旧注释说「不再读它们」—— **那个决定在当时是对的，但已经过期，而没人回来改它**：
//   当时勾选墙被删掉了，没有任何 UI 写这个 key，所以读它只会读到存量旧清单、把搜索面悄悄缩窄。
//   ⚠️ 但 C5-44 把国家勾选 UI **加回来了**（`index.ts:2575` 一直在写这个 key）
//   ⇒ 写的一侧接回来了、读的一侧还是没人 ⇒ **控件能点、能存、能忠实回显，机器完全不看。**
//   Joe 取消勾选任何国家都毫无效果，而界面上那行「一个国家都没选，机器不会再找新客户」
//   **是假的** —— 一个让人放心的假告警，比没有告警更坏。
//   （站内那一族：「我以为在控制的」≠「真正在控制的」。判据要落在产出，不落在源码。）
//
// ⚠️ 上线顺序有依赖，不能反：**必须先把生产里那条存量 `search_countries` 删掉，再上这段读逻辑。**
//   反了的话，上线那一刻 cron 会立刻按存量（27 码）缩窄，而当时目录已经是 51。
//   2026-09-03 已执行：删前存档原值 = us,ca,gb,ie,de,fr,nl,be,at,ch,se,no,dk,fi,au,nz,it,es,pt,pl,cz,jp,kr,sg,ae,lu,gr
//   删除是**零可见变化**（该值与当时的 DEFAULT_COUNTRIES 双向差集为空、顺序一致，已逐个核对）。
//   ⭐ 为什么删存量而不是把它改写成 51 码：改写只修这一次，下次再加国家同一个 bug 原样复发；
//      删掉恢复的是「未设 = 全量」这条**自维持的不变式**。修根不修症状。
//
//   单国定向不走这里（它是 runDiscovery 的 opts.countries 一次性覆盖，不写配置）。
//
// ── 下面是批㉑当时的原话，保留作来历 ──
// ⭐⭐ 批㉑：cron 搜索面**永远是全量**（Joe 要"系统全包国家"）。
//   旧的 `search_countries` / `country_list`（勾选墙写的）已**作废**：勾选墙删了，没人再写它们；
//   这里也**不再读它们** —— 否则存量里那份 26 国旧清单会把新的全量搜索面**悄悄缩回 26**
//   （正是总工提醒的"别让读不到/读到旧配置变成搜索面变窄"）。
export async function getSearchConfig(env: Env): Promise<{ countries: string[]; perKeyword: number }> {
  const pRow = await env.DB.prepare("SELECT value FROM settings WHERE key='search_per_keyword'").first<{ value: string }>();
  const perKeyword = Math.min(Math.max(Number(pRow?.value) || 8, 1), 100);   // #45 放开到 100，尊重滑块

  // ⚠️ **三态，不是两态** —— 必须与 index.ts:2519 的回显读法同构，否则界面和机器又会各说各的：
  //   · 行不存在（从未设过）→ 全量。这是默认，也是删掉存量之后恢复的那条不变式。
  //   · 有值            → 就按这几个国家（Joe 主动收窄）。
  //   · 空串            → **真的一个都不选**，不是"读不到就全量"。
  //     🔴 这一条最容易写错：把空串兜底成全量，等于把 Joe 明确的"全不选"悄悄改成"全搜"，
  //        而界面上那行红字还在说"机器不会再找新客户" —— 又是一个说谎的告警。
  //     ⚠️ 所以判据是**行在不在**（`row === null`），不是 `!value`。
  const cRow = await env.DB.prepare("SELECT value FROM settings WHERE key='search_countries'").first<{ value: string }>();
  if (!cRow) return { countries: DEFAULT_COUNTRIES.slice(), perKeyword };   // 从未设过 = 全量（已减去拉黑）

  // 存量清洗：小写去空白 + 丢掉不在 COUNTRIES 里的死码（目录删过的国家）+ 再过一道黑名单。
  // ⛔ 黑名单这层不能省 —— runDiscovery 里虽然还会再滤一次，但闸不能只有一层（见 BLACKLIST_GL 注释）。
  const picked = String(cRow.value || "")
    .split(",").map((s) => s.trim().toLowerCase())
    .filter((x) => COUNTRIES[x] && !BLACKLIST_GL.has(x));
  return { countries: picked, perKeyword };
}

function domainOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; }
}

// 过滤平台/目录/社媒/比价/大ISP/招聘/媒体等非目标公司域名
const JUNK_DOMAINS = [
  // 平台/社媒
  "google.", "facebook.", "youtube.", "yelp.", "reddit.", "amazon.", "ebay.",
  "wikipedia.", "linkedin.", "instagram.", "twitter.", "x.com", "tiktok.",
  // ⚠️ starlink.com / spacex.com 是**上游垃圾域名黑名单**的遗留项。留着无害（AirSonde 的搜索
  //    根本命中不到它们），删掉也无收益 —— 但**不能**把它们当成"星链文案残留"顺手清掉：
  //    这一行是过滤器数据，不是给人看的文案。C4-A 要清的是 UI 文案，不是黑名单。
  "pinterest.", "starlink.com", "spacex.com", "maps.google", "bbb.org",
  "quora.", "medium.com", "apple.com", "play.google", "wa.me", "t.me",
  "fandom.", "craigslist.",
  // 政府/学术机构域（C5-17）。生产实测存量 22 条全是这一族（EPA / CDC / NIST / OSHA /
  //   各国环保署 / 大学）—— 它们发布标准和数据，不采购检测仪；**没有一条是误伤的真公司**。
  //   用**后缀片段**而不是逐个域名：新的政府站每周都会冒出来（schoolinfrastructure.nsw.gov.au
  //   这种），逐个拉黑永远追不上。
  //   ⚠️ 写 ".gov"（带前导点）而不是 "gov"：后者会误杀 govan-engineering.com 这类真公司。
  ".gov", ".edu", "ncbi.nlm.nih", "pubmed.",
  // 招聘站
  "indeed.", "glassdoor.", "ziprecruiter.", "simplyhired.", "monster.", "snagajob.",
  // 比价/评测/聚合站（非采购方）
  "broadbandsearch.", "highspeedinternet.", "satelliteinternet.", "broadbandnow.",
  "whistleout.", "allconnect.", "comparitech.", "cnet.", "pcmag.", "tomsguide.",
  "reviews.org", "broadbandmap.", "techradar.", "forbes.", "usnews.",
  // 大 ISP / 卫星 ISP（非目标客户/竞争对手）
  "spectrum.", "earthlink.", "xfinity.", "verizon.", "att.com", "t-mobile.",
  "viasat.", "hughesnet.", "centurylink.", "frontier.com",
  // 媒体/市场/大牌零售/文档/论坛
  "yachtworld.", "boattrader.", "boats.com", "tripadvisor.",
  "bestbuy.", "westmarine.", "readme.io", "inmyarea.", "irv2.",
  "roadslesstraveled.", "walmart.", "homedepot.", "target.com",
  // E2：中国铺货平台/批发站（避开价格战红海；-site:*.cn 之外的结果侧兜底）
  "alibaba.", "aliexpress.", "made-in-china.", "dhgate.", "temu.", "1688.com", "globalsources.",
  // ── 2026-09-02 补漏：全部来自**生产真实数据**（53 条 403 里逐条肉眼过），不是设想 ──
  //   来历：查"无官网"那一桶时发现，相当比例根本不该进库 —— 它们抓不到是因为
  //   跑企业级 bot 防护，而它们**本来就不是采购方**，抓到了也没用。
  // ⚠️ 只收**明确不采购**的实体。像 atlascopco / belimo / draeger / phoenixcontact / fondriest
  //    这些同样 403 的**一条都没加** —— 它们是制造商或仪器分销商，是真目标，不是垃圾。
  // B2B 目录/名录/数据商（它们卖名单，不买仪器）
  "indiamart.", "justdial.", "directindustry.", "globalspec.", "globaltradeplaza.",
  "industrystock.", "thomasnet.", "tradewheel.", "zoominfo.", "buyersguide.",
  // 学术出版/论文库
  "mdpi.", "sciencedirect.", "tandfonline.", "researchgate.", "onlinelibrary.",
  "springer.", "jstor.",
  // 词典/百科/参考站
  "britannica.", "merriam-webster.", "niche.com",
  // 议会/政府间组织/人道组织（.gov 之外的那一族）
  ".parliament.uk", "ilo.org", "redcross.org",
  // ⛔ 想加而**故意没加**的：
  //   · `.org` —— 实测库里 34 条 .org 中有 `airscan.org`，≥60 分**且已经发过信**。加了就误杀真客户。
  //   · `.int` —— TLD 本身干净，但这里是 `includes` 子串匹配：`www.interco.com` 含 ".int"，会误杀。
  //     （与上面 `.gov` vs `gov` 是同一条教训：**宽规则要先想它会顺手打死谁**。）
];
function isJunkDomain(d: string): boolean {
  return !d || JUNK_DOMAINS.some((j) => d.includes(j));
}

function cleanTitle(t: string): string {
  return (t || "").split(/\s*[|–—]\s*|\s+-\s+/)[0].trim().slice(0, 120) || "(unknown)";
}

// M1 公司名：优先用域名主标签推公司名（比搜索标题碎片可靠：域名一定是这家公司的站）。
// betamarineusa.com → "Betamarineusa"；foo-bar.co.uk → "Foo Bar"。返回 "" 时调用方回落 cleanTitle。
export function companyFromDomain(domain: string): string {
  const host = (domain || "").replace(/^www\./, "").toLowerCase();
  if (!host) return "";
  const parts = host.split(".").filter(Boolean);
  if (parts.length < 2) return "";
  // 主标签 = TLD 前一段；若命中 co/com/net/org/gov/edu/ac（如 .com.au/.co.uk）再往前取一段
  let label = parts[parts.length - 2];
  if (parts.length >= 3 && ["co", "com", "net", "org", "gov", "edu", "ac"].includes(label)) label = parts[parts.length - 3];
  label = label.replace(/[-_]+/g, " ").trim();
  if (!label) return "";
  return label.split(" ").map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ").slice(0, 80);
}

// ⭐ 顺带修③ 入库去重：以前三处都写 `WHERE website=? OR website=?`（原文比对 + 一个 www 变体）——
//   **同一个缺陷复制了三份**，而且都漏：协议不同、大小写不同、尾部斜杠都能骗过它。
//   生产实证（只读查出来的）：
//     #163 https://2csyachtoutfitters.com   vs  #238 http://www.2CsYachtOutfitters.com  ← 同一个站，录了两次
//     #165 https://alliancenav.com          vs  #241 http://www.alliancenav.com
//   后果不只是列表里多几行：两行的**邮箱是同一个**，而发信幂等按 lead_id 判 → 同一个地址会收到两封冷邮件。
//   （发信那一层我也加了按邮箱地址的兜底，见 send.ts；这里是堵源头。）
//
/** 规范化域名：去协议、去 www、转小写、去尾斜杠和路径 → 用它比对才认得出"同一个站" */
export function normalizeHost(url: string): string {
  const s = String(url || "").trim().toLowerCase();
  if (!s) return "";
  const noProto = s.replace(/^https?:\/\//, "");
  const host = noProto.split("/")[0].split("?")[0].split("#")[0];
  return host.replace(/^www\./, "").replace(/\.$/, "");
}

/** 这个网址是否已在库里（按规范化域名比对，认得出 http/https、www、大小写、尾斜杠的差异） */
export async function findLeadByHost(env: Env, url: string): Promise<{ id: number } | null> {
  const host = normalizeHost(url);
  if (!host) return null;
  // SQLite 没有正则；用 lower(...) + 四种常见前缀形态覆盖（比原来的两种全，且认大小写）
  const row = await env.DB.prepare(
    `SELECT id FROM leads
      WHERE lower(replace(replace(replace(rtrim(website,'/'),'https://',''),'http://',''),'www.','')) = ?
      LIMIT 1`
  ).bind(host).first<{ id: number }>();
  return row || null;
}

/**
 * 邮箱规范化：去空白 + 转小写。
 * （RFC 上邮箱本地部分是大小写敏感的，但现实里没有服务商这么用；
 *   而"同一个人被当成两条线索、被发两封开发信"的代价，远大于这点理论正确性。）
 */
export function normalizeEmail(email: string | null | undefined): string {
  return String(email || "").trim().toLowerCase();
}

/**
 * 这个邮箱是否已在库里。
 * ⚠️ **空邮箱绝不参与判重** —— 否则"所有没邮箱的线索"会彼此命中，一条都进不来。
 *   这是批⑮ 派单里特意点名的那条（`email IS NOT NULL AND email != ''`）。
 */
export async function findLeadByEmail(env: Env, email: string | null | undefined): Promise<{ id: number } | null> {
  const e = normalizeEmail(email);
  if (!e) return null;
  const row = await env.DB.prepare(
    `SELECT id FROM leads WHERE email IS NOT NULL AND email != '' AND lower(trim(email)) = ? LIMIT 1`
  ).bind(e).first<{ id: number }>();
  return row || null;
}

/**
 * ⭐⭐ 批⑮：**统一的"这条线索是不是已经在库里"** —— 三条 discover 管道 + CSV 导入共用这一个。
 *
 * 起因：Joe 点「发邮件」，16 家里 14 家被跳过，理由是"邮箱已收过开发信（同一家被重复录入）"。
 * 发送闸是对的（同一个邮箱不发第二封），错在**录入时没判重**：同一家公司被 NMEA 又录了一遍，
 * 因为两次的网址文本不同（`https://x.com` vs `http://www.X.com`），而当时只做原文比对。
 *
 * 为什么必须收敛成一个函数（不是各管道各写一份）：
 *   盘点时发现网址归一化三条管道都调了 `findLeadByHost`，但**CSV 导入那条是原文比对**，
 *   而且**四条路没有一条按邮箱判重**。各写各的 = 补一处漏三处，正是"连根拔"要防的。
 *
 * ⚠️ **不按状态过滤**（和既有的 findLeadByHost 保持一致）。派单原话是"非终态才判重"，
 *   我做成了**全状态**，理由两条：
 *   ① 安全不对称：一个 `unsubscribed` 的邮箱若能重新录进来，就等于给"再发一次"开了口子；
 *      漏判的代价（合规）远大于误判的代价。
 *   ② **判重不会丢掉这家公司** —— 它本来就还在库里（只是在已忽略/已退订格），
 *      Joe 随时能「恢复到待审批」。所以全状态判重**没有任何机会成本**。
 */
export async function findDuplicateLead(
  env: Env, lead: { website?: string | null; email?: string | null }
): Promise<{ id: number; by: "website" | "email" } | null> {
  if (lead.website) {
    const hit = await findLeadByHost(env, lead.website);
    if (hit) return { id: hit.id, by: "website" };
  }
  if (normalizeEmail(lead.email)) {
    const hit = await findLeadByEmail(env, lead.email);
    if (hit) return { id: hit.id, by: "email" };
  }
  return null;
}

/**
 * 跨域名疑似同一家（总工点名的 SPACETEK .com.au/.co.nz 那类）：域名主体相同即疑似。
 * **标记不合并** —— 它们可能真是同一家的多个区域站（生产实测：seasucker.com/.eu/.de、
 * spacetek.com.au/.co.nz、datalake.ph/.id），也可能只是撞名。
 * **合并是不可逆的，标记是可逆的**；由人决定。
 */
export async function findSiblingByRoot(env: Env, url: string): Promise<{ id: number; company_name: string; website: string } | null> {
  const host = normalizeHost(url);
  const label = companyFromDomain(host).toLowerCase().replace(/\s+/g, "");
  if (!label || label.length < 4) return null;   // 太短的主体（如 abc）撞名概率高，不报疑似
  const rows = (await env.DB.prepare(
    "SELECT id, company_name, website FROM leads WHERE website IS NOT NULL AND website != '' LIMIT 2000"
  ).all()).results as any[];
  for (const r of rows) {
    const h = normalizeHost(r.website);
    if (h === host) continue;                     // 同一个站是"重复"不是"疑似同一家"，归 findLeadByHost 管
    if (companyFromDomain(h).toLowerCase().replace(/\s+/g, "") === label) return r;
  }
  return null;
}

/**
 * 入库后给"疑似同一家"打标记（写 notes，详情页可见）。
 * 用 notes 而不是新加一列：不需要迁移，而且**这是给人看的提示不是机器的判据** ——
 * 机器不该据此自动合并/跳过，它只是在 Joe 打开这条时告诉他"隔壁还有一个长得像的"。
 */
/**
 * C5-26：把"写标记"这一步单独拿出来 —— 谁是 sibling 由调用方决定（找客户那条管道用预载索引，
 * 别的调用方仍走 findSiblingByRoot 现查）。**判断和写入分开，两个调用方共用写入这一半。**
 */
export async function markSiblingPair(env: Env, leadId: number, sibId: number): Promise<void> {
  if (!leadId || !sibId) return;
  try {
    const sib = await env.DB.prepare("SELECT id, website FROM leads WHERE id=?").bind(sibId).first<any>();
    if (!sib) return;
    await env.DB.prepare(
      `UPDATE leads SET notes = substr(COALESCE(notes,'') || char(10) || '[' || datetime('now') || '] 疑似与 #' || ?
              || '（' || ? || '）是同一家：域名主体相同、站点不同。**没有自动合并** —— 可能真是同一家的多个区域站，也可能只是撞名，你来判断。', -4000)
        WHERE id = ?`
    ).bind(sib.id, sib.website, leadId).run();
  } catch (e) { console.error("markSiblingPair:", e); }
}

export async function markSibling(env: Env, leadId: number, website: string): Promise<void> {
  if (!leadId) return;
  try {
    const sib = await findSiblingByRoot(env, website);
    if (!sib) return;
    await env.DB.prepare(
      `UPDATE leads SET notes = substr(COALESCE(notes,'') || char(10) || '[' || datetime('now') || '] 疑似与 #' || ?
              || '（' || ? || '）是同一家：域名主体相同、站点不同。**没有自动合并** —— 可能真是同一家的多个区域站，也可能只是撞名，你来判断。', -4000)
        WHERE id = ?`
    ).bind(sib.id, sib.website, leadId).run();
  } catch (e) { console.error("markSibling:", e); }   // 打标记失败不该拖垮入库
}

// 快赢②：识别"文章/攻略/资讯页"而非真实经营的公司/买家，入库前过滤掉最明显的噪音。
// 保守起见：URL 路径出现博客/攻略段，或标题呈明显文章句式，才判为内容页。
const ARTICLE_URL_RE = /\/(blog|blogs|guide|guides|article|articles|news|wiki|resources?|how-?to|tutorials?|tips|diy|learn|magazine|stories|faq|glossary)(\/|$|\?)|\/20\d\d\//i;
// 标题句式：how to / guide / tutorial / step-by-step / DIY / tips / best…20xx / listicle 等 → 内容页
const ARTICLE_TITLE_RE = /^(what is|why |when to|where to|top \d+|best \d+|\d+ best|the \d+ )|\bhow[\s-]?to\b|step[\s-]?by[\s-]?step|\bguide\b|\btutorial\b|\bdiy\b|\btips\b|\bvs\.?\b|\bexplained\b|\breview:|\bcheat sheet\b|\bchecklist\b|\bbest\b.{0,25}\b20\d\d\b/i;
export function isLikelyArticle(title: string, url: string): boolean {
  const u = (url || "").toLowerCase();
  if (ARTICLE_URL_RE.test(u)) return true;
  if (ARTICLE_TITLE_RE.test((title || "").trim())) return true;
  return false;
}

export interface DiscoverResult {
  keywords: number;
  searched: number;
  inserted: number;
  skipped: number;
  contentSkipped: number; // 快赢②：被判为文章/攻略页而过滤掉的数量
  errors: string[];
  budgetStopped?: boolean;    // P0-c：本轮因触及今日 Serper 预算上限而提前停
  cancelled?: boolean;        // 预算锁死修法：Joe 点了芯片 ✕（discover_cancel 命中本轮 roundId）
  serperUsedToday?: number;   // P0-c：今日累计 Serper 搜索次数
  serperBudget?: number;      // P0-c：今日 Serper 预算上限
  searchFailed?: number;      // 本轮有几次搜索直接失败（额度用尽/4xx）；原话记在 settings.serper_fail_last
  // C5-26 耗时分解（只量不改行为）：msSearch = Serper 往返；msDb = 判重/入库/标记/记账
  msTotal?: number;
  msSearch?: number;
  msDb?: number;
}

// 主流程：对每个关键词 × 每个目标国家搜索 → 提取公司域名 → 去重 → 入库(status=new)
// 预算锁死修法（Joe 批，09-03）：
//   · opts.by = 发起方（/api/discover 传 'user'，每分钟 tick 传 'auto'，缺省 'auto'）。
//     🔴 根因就在这：publishProgress 原来把 by 写死 "user"（注释声称"这条管道只有人点得动"），
//     而 tick-discover 后来也走了 runDiscovery ⇒ **cron 每分钟把「你交办的」芯片重新点亮一次**，
//     3 分钟过期形同虚设，预算满后它还每分钟灌一条 0/25 —— Joe 看到的正是这个。
//   · opts.roundId = 这一轮的 discover_round_id（只有 /api/discover 传）。取消：settings.discover_cancel
//     写成该 roundId，循环每个组合开头查一次，命中就 break（tick 不传 roundId ⇒ 查不中，不受影响）。
//   · 预算满 ⇒ **最前面直接返回**：不预载全表判重索引、不写 activity/progress（原来这两样在循环前无条件跑）。
export async function runDiscovery(env: Env, opts: { keywords?: string[]; perKeyword?: number; countries?: string[]; maxCombos?: number; by?: "user" | "auto"; roundId?: string } = {}): Promise<DiscoverResult> {
  // ── 预算闸最先查：满了就什么都不做（不建进度、不写活动、不预载索引）──
  {
    const braw0 = Number(await getS(env, "serper_daily_budget", String(SERPER_DAILY_BUDGET_DEFAULT)));
    const budget0 = Math.max(0, Number.isFinite(braw0) ? braw0 : SERPER_DAILY_BUDGET_DEFAULT);
    const used0 = Number(await getS(env, `serper_used_${new Date().toISOString().slice(0, 10)}`, "0")) || 0;
    if (used0 >= budget0) {
      return { keywords: 0, searched: 0, inserted: 0, skipped: 0, contentSkipped: 0, errors: [],
               budgetStopped: true, serperUsedToday: used0, serperBudget: budget0, searchFailed: 0, msTotal: 0, msSearch: 0, msDb: 0 };
    }
  }
  const keywords = opts.keywords?.length ? opts.keywords : await getKeywords(env);
  const cfg = await getSearchConfig(env);
  const perKeyword = Math.min(Math.max(opts.perKeyword || cfg.perKeyword, 1), 100);   // #45 放开到 100，尊重滑块
  // ⭐ 批㉑：拉黑 8 国**硬挡**（即使有人手动传进来/塞进配置也搜不了）。双保险，不只靠 COUNTRIES 不含它们。
  const countries = (opts.countries?.length ? opts.countries : cfg.countries).filter((gl) => !BLACKLIST_GL.has(gl));

  // 展平所有 keyword×country 组合（每组合 = 1 次 Serper 搜索）
  //
  // ⭐ C5-50②：国家不再是"每个词都跑全部"，而是**由这个词的语言决定**（见 LANG_COUNTRIES）。
  //   英文词 = 全部国家（与改动前完全一致）；德语词只在德奥瑞，等等。
  const langs = await getKeywordLangs(env);
  let combos: { kw: string; gl: string; hl: string }[] = [];
  const starvedByLang: string[] = [];
  for (const kw of keywords) {
    const lang = langs.get(kw) || "en";
    const allowed = countriesForLang(lang, countries);
    // ⚠️ 交集为空 ⇒ 这个词本轮**一次都不会搜**。这必须吼出来：
    //   静默跳过会让"这个词没找到客户"和"这个词根本没跑过"长得一模一样。
    if (!allowed.length) { starvedByLang.push(`${kw}(${lang})`); continue; }
    // hl 只给非英文词发（保证英文词请求体逐字不变，见 searchSerper 上方注释）
    const hl = lang === "en" ? "" : lang;
    for (const gl of allowed) combos.push({ kw, gl, hl });
  }
  if (starvedByLang.length) {
    console.log(`discovery: 本轮无国家可跑的词（语言组 ∩ 已选国家 = 空）：${starvedByLang.join(", ")}`);
  }

  // ⭐ 批㉑：国家从 27 → 全量那一刻，combos 总数变了 → 旧 discovery_cursor 指向的 (kw,gl)
  //   会错位（游标是 combos 的**平铺下标**）。上线首日一次性把游标归零，让轮转从头开始，
  //   别从随机位置跳格。一次性：靠 settings 标记，之后不再动。
  if ((await getS(env, "discovery_cursor_reset_batch21", "")) !== "1") {
    await setS(env, "discovery_cursor", "0");
    await setS(env, "discovery_cursor_reset_batch21", "1");
  }

  // P0-b 轮转窗口：cron 传 maxCombos 时，只跑一小批，用 discovery_cursor 环绕，下轮接着跑（别每轮全量 572）
  if (opts.maxCombos && opts.maxCombos < combos.length) {
    const totalC = combos.length;

    // ⭐⭐ C5-50②：**游标错位的根治，取代"每次改动加一个一次性标记"。**
    //
    // 病：`discovery_cursor` 是 combos 的**平铺下标**。只要 combos 的**长度或顺序**变了
    //     （加/停关键词、加/减国家、词绑语言……），旧游标就指向了另一个 (kw,gl)。
    //     ⚠️ 错位**从外面完全看不出来**：不报错、照常搜、照常入库，只是轮转公平性没了。
    // 🔴 batch㉑ 当时的处理是"上线首日一次性归零 + 一个标记"。那修的是那一次，
    //     **而这个 bug 会在每一次改动上原样复发** —— 我自己差点又踩：如果这次也只放一个
    //     一次性标记，它会在**部署那一刻**用掉（那时还没有小语种词、combos 根本没变），
    //     等 4 个小语种词真正入库、combos 从 900 变 1155 时，标记已经消费完了。
    // ⇒ 改成**记住上一轮的 combos 总数，一变就归零**。自维持，不需要有人记得加标记。
    // ⚠️ 只在"按配置跑"的轮次里判：`opts.countries` 是单国定向的一次性覆盖，
    //    它天然会算出另一个 totalC，拿它去比会**每次都误判成漂移**。
    if (!opts.countries?.length) {
      const lastN = Number(await getS(env, "discovery_combos_n", "")) || 0;
      if (lastN !== totalC) {
        await setS(env, "discovery_cursor", "0");
        await setS(env, "discovery_combos_n", String(totalC));
        console.log(`discovery: 组合总数 ${lastN || "(未记录)"} → ${totalC}，游标归零（平铺下标已失效）`);
      }
    }

    let cursor = Number(await getS(env, "discovery_cursor", "0")) || 0;
    cursor = ((cursor % totalC) + totalC) % totalC;
    const window: { kw: string; gl: string; hl: string }[] = [];
    for (let i = 0; i < opts.maxCombos; i++) window.push(combos[(cursor + i) % totalC]);
    const next = (cursor + opts.maxCombos) % totalC;
    await setS(env, "discovery_cursor", String(next));
    // 批㉑：轮转推进日志（游标是 combos 的平铺下标，"接着上次往下走"，环绕）——公平性实测靠它取证。
    console.log(`discovery rotation: cursor ${cursor} → ${next}（共 ${totalC} 个 kw×国 组合，本轮取 ${opts.maxCombos} 个）`);
    // ⭐ C5-50②：**把这一轮实际取到的组合逐个打出来。** 归零之后"游标有没有跳格"
    //   只能靠看真正取到了什么来判 —— ⛔ 不许拿"没报错"当证据。
    console.log(`discovery window: ${window.map((c) => `${c.kw}@${c.gl}${c.hl ? "/" + c.hl : ""}`).join(" | ")}`);
    combos = window;
  }

  // P0-c Serper 积分：今日计数 + 硬预算上限（到顶自动停，别再失控烧免费额度）。注意用 isFinite 判定，允许预算=0（完全暂停）
  const braw = Number(await getS(env, "serper_daily_budget", String(SERPER_DAILY_BUDGET_DEFAULT)));
  const budget = Math.max(0, Number.isFinite(braw) ? braw : SERPER_DAILY_BUDGET_DEFAULT);
  const usedKey = `serper_used_${new Date().toISOString().slice(0, 10)}`;
  let usedToday = Number(await getS(env, usedKey, "0")) || 0;

  let inserted = 0, skipped = 0, searched = 0, contentSkipped = 0, budgetStopped = false, searchFailed = 0;
  const errors: string[] = [];
  const seenThisRun = new Set<string>();

  // ⭐⭐ C5-26：**每轮预载一次判重索引**，取代"每条结果一次全表扫"。
  //
  // 为什么慢是可以从代码判定的，不用猜：
  //   · `findLeadByHost` 的 WHERE 是 `lower(replace(replace(replace(rtrim(website,'/'),…))) = ?`
  //     —— SQLite 没有正则、这种现算表达式**走不了任何索引** ⇒ 每次都是全表扫。
  //     它**每条搜索结果调一次**：26 关键词 × 8 条 ≈ 208 次。
  //   · `markSibling → findSiblingByRoot` 更贵：`SELECT … LIMIT 2000` 的全表扫，**每插入一条调一次**。
  //   两者加起来就是"Serper 只要 ~30 秒、整轮却要几分钟"里的那一大块。
  //
  // ⚠️ 判重**规则一个字没改**：仍然用 normalizeHost / companyFromDomain 这两个同样的函数算键，
  //   只是把"算一次比一行"换成"算一次比全部"。规则若要改，改的是那两个函数，不是这里。
  // ⚠️ 本轮新插入的也要进索引 —— 否则同一轮里的重复会漏（旧写法靠"插完下次查得到"覆盖了这一点）。
  const hostIndex = new Map<string, number>();     // 规范化域名 → lead id
  const rootIndex = new Map<string, { id: number; company_name: string; website: string }>();  // 域名主体 → 一条既有线索
  {
    const rows = (await env.DB.prepare(
      "SELECT id, company_name, website FROM leads WHERE website IS NOT NULL AND website != ''"
    ).all()).results as any[];
    for (const r of rows) {
      const h = normalizeHost(r.website);
      if (!h) continue;
      if (!hostIndex.has(h)) hostIndex.set(h, Number(r.id));
      const label = companyFromDomain(h).toLowerCase().replace(/\s+/g, "");
      if (label.length >= 4 && !rootIndex.has(label)) rootIndex.set(label, r);
    }
  }

  // C5-26：耗时分解。⚠️ 只量不改行为；**报出来是为了让"慢在哪"有答案，不是为了好看**。
  const t0 = Date.now(); let msSearch = 0, msDb = 0; const tick = () => Date.now();
  let comboDone = 0;
  const publishProgress = async () => {
    // ⚠️ 进度**只用于显示**。完成与否**不看它**（那是"用增量推断完成"，今天刚栽过）——
    //   完成的唯一信号是这个函数返回、也就是 /api/discover 这个请求 resolve。
    try {
      await setS(env, "discover_progress", JSON.stringify({
        at: new Date().toISOString().slice(0, 19).replace("T", " "),
        done: comboDone, total: combos.length, inserted, skipped, searched,
      }));
      // C5-28：同一份进度也喂给状态栏的活动真源（一处产出、两处消费，不是两份数据）。
      //   🔴 发起方来自调用方（opts.by）：原来写死 "user"，而每分钟 tick 也走这条 ⇒ cron 冒充 Joe 点灯（预算锁死那单的根因）。
      await setS(env, "activity_search", JSON.stringify({
        kind: "search", by: opts.by || "auto", at: Date.now(),
        done: comboDone, total: combos.length, note: `已入库 ${inserted}`,
      }));
    } catch { /* 发布进度失败不能拖垮找客户本身 */ }
  };
  await publishProgress();

  // ⭐ 2026-09-05：建表**每轮一次**（⛔ 不是每搜一次）。写者这一路自愈，读者那一路在体检表端点里另有一次。
  // ⚠️ 连建表本身也 best-effort：建不出来就是没有记账，⛔ 但绝不能因此让找客户跑不了。
  try { await ensureDiscoveryLog(env); }
  catch (e) { console.error("discovery-log: 建表失败，本轮不记账（找客户照常）:", e); }

  let cancelled = false;
  for (const { kw, gl, hl } of combos) {
    if (usedToday >= budget) { budgetStopped = true; break; }   // 触及今日预算 → 停
    // 取消（只对带 roundId 的人工整轮生效）：Joe 点了芯片上的 ✕ ⇒ discover_cancel = 本轮 id
    if (opts.roundId && (await getS(env, "discover_cancel", "")).trim() === opts.roundId) { cancelled = true; break; }
    let results: SearchResult[];
    // ⭐ 2026-09-05：本组合入库了几条 = 循环后的 `inserted` 减去这里的快照。
    //   （`inserted` 是整轮累加的，没有 per-combo 计数器；⛔ 不新造一个平行计数器 —— 那就是第二个真源。）
    const insBefore = inserted;
    try {
      const _ts = tick();
      results = await searchCompanies(env, kw, perKeyword, gl, hl);
      msSearch += tick() - _ts;
      searched++; usedToday++;
      await setS(env, usedKey, String(usedToday));   // 每搜一次即记账，进程中断也不丢
    } catch (e: any) {
      const why = `${kw}/${gl}: ${e?.message || e}`;
      errors.push(why);
      searchFailed++;
      // ⭐ **每次都记原话**（不去重、不等阈值、不看 streak）。
      //   免费额度烧完那天 Serper 会开始返 4xx，而这条链路是"每次搜索各自 catch + continue"
      //   —— 好处是砸不掉整轮 cron，坏处是**它会安安静静地一条线索都不产出，没人知道**。
      //   「记录证据 ≠ 报告结论」：要不要吼是另一回事，先把服务器原话原样留下来。
      try {
        await setS(env, "serper_fail_last",
          `${new Date().toISOString().slice(0, 19).replace("T", " ")} ${why}`.slice(0, 500));
      } catch { /* 记录失败不能反过来拖垮找客户本身 */ }
      continue;
    }
    for (const r of results) {
      const domain = domainOf(r.url);
      if (isJunkDomain(domain) || seenThisRun.has(domain)) { skipped++; continue; }
      // E2：结果侧兜底滤中国站（.cn / .com.cn），以防 -site:*.cn 未完全生效
      if (domain.endsWith(".cn")) { skipped++; continue; }
      // 快赢②：明显的文章/攻略/资讯页不入库（非真实买家）
      if (isLikelyArticle(r.title, r.url)) { contentSkipped++; continue; }
      seenThisRun.add(domain);
      const website = "https://" + domain;
      // 按规范化域名去重（认得出 http/https、www、大小写、尾斜杠 —— 原来的原文比对全漏，见 normalizeHost 注释）
      // 批⑮：统一走 findDuplicateLead（网址归一化 + 邮箱两把钥匙，全库唯一一条判重规则）。
      // 这条管道插入时没有邮箱（邮箱是 analyzeLead 抓站时才回填的）→ 实际只有网址那把生效；
      // 用共用函数是为了**以后谁给这条路加上邮箱时，判重自动跟上**，不用再想起来补一次。
      // 判重走预载索引（规则同 findDuplicateLead 的网址那把钥匙；这条管道插入时没有邮箱，
      // 邮箱那把本来就不生效 —— 见下方原注释）。
      if (hostIndex.has(domain)) { skipped++; continue; }
      // 🔴 总工裁定（2026-09-03，生产 10 组同网址重复、全部 search+search 相隔 15–60 分钟）：
      //   预载的 hostIndex 是**这一轮开始时**的快照；手动整轮（/api/discover）与每分钟 tick 小批并行时，各拿一份过期快照
      //   ⇒ 同一网址各插一条。插入前再真查一次库（findDuplicateLead，与 nmea/directory 两条路径同款）——多一次 D1 读，换入库正确。
      //   索引仍留着：它挡住同一轮里的重复，且让绝大多数结果不用打到库。
      { const dup = await findDuplicateLead(env, { website }); if (dup) { hostIndex.set(domain, dup.id); skipped++; continue; } }
      const company = companyFromDomain(domain) || cleanTitle(r.title);   // M1 域名推名优先，回落标题
      const country = inferCountryFromWebsite(website) || gl.toUpperCase(); // M2 ccTLD 推真实所在国优先，gl 仅兜底；统一大写
      const ins = await env.DB.prepare(
        "INSERT INTO leads (company_name, website, country, source, keyword, status) VALUES (?, ?, ?, 'search', ?, 'new')"
      ).bind(company, website, country, kw).run();
      const newId = Number(ins.meta.last_row_id);
      hostIndex.set(domain, newId);                                    // 本轮内的重复也要挡住
      // 跨域名疑似同一家 → 打标记，不合并（**标记可逆、合并不可逆，由人决定**）。走预载索引。
      {
        const label = companyFromDomain(domain).toLowerCase().replace(/\s+/g, "");
        if (label.length >= 4) {
          const sib = rootIndex.get(label);
          if (sib && normalizeHost(sib.website) !== domain) await markSiblingPair(env, newId, sib.id);
          else if (!sib) rootIndex.set(label, { id: newId, company_name: company, website });
        }
      }
      inserted++;
    }
    // ⭐ 2026-09-05 搜索记账：**这一次搜索**用了哪个词、投的哪个国、返回几条、真入库几条。
    //   ⚠️ 只在**搜索成功**这条路上记（失败那支上面已 `continue`）—— 记一条 results=0 的假成功，
    //     会让体检页把"搜索坏了"读成"这个词没货"，那是两件完全不同的事。
    await logDiscoverySearch(env, { keyword: kw, gl, results: results.length, inserted: inserted - insBefore });
    comboDone++;
    await publishProgress();   // 每个关键词跑完发布一次：Joe 要看见"第 N/26"，不是一个空转的圈
  }
  msDb = Date.now() - t0 - msSearch;   // 非搜索时间 = 判重/入库/标记/记账
  // 全军覆没（跑了但一次都没成功）多半是额度用尽/密钥失效 —— 这种最该在日志里一眼看见。
  if (searchFailed && !searched) console.error(`discovery: ${searchFailed} 次搜索全部失败（额度用尽/密钥失效？）最近一条见 settings.serper_fail_last`);
  console.log(`discovery 耗时分解：总 ${Math.round((Date.now() - t0) / 1000)}s = 搜索 ${Math.round(msSearch / 1000)}s + 其余(判重/入库/标记) ${Math.round(msDb / 1000)}s · ${searched} 次搜索 / ${inserted} 入库`);
  try { await setS(env, "discover_progress", ""); } catch { /* 清进度失败无所谓 */ }
  return { keywords: keywords.length, searched, inserted, skipped, contentSkipped, errors: errors.slice(0, 10), budgetStopped, cancelled, serperUsedToday: usedToday, serperBudget: budget, searchFailed,
           msTotal: Date.now() - t0, msSearch, msDb };
}

// P0-c：读今日 Serper 用量 + 预算（供后台展示）
/**
 * ⭐⭐ 2026-09-05：搜索记账（投放体检表的地基）。
 *
 * 在它之前，"这条线索是在哪个投放国、用哪个词搜到的"**库里没有任何地方记着**：
 *   · Serper 用量只有全局日计数 `serper_used_YYYY-MM-DD`；
 *   · `leads.country` 是**公司自己在哪国**（ccTLD 推断，`gl` 仅兜底）——不是投放国。
 * ⇒ 「每词成本」与「投放国漏斗」当时算不出来。**这张表就是为了从现在起把账记对。**
 *
 * ⚠️ 建表放在**读者与写者两条路上各一次**（本函数 + 体检表端点）：
 *   本仓栽过一次「迁移只挂在稀有写路径上 ⇒ 列一直没被创建 ⇒ 读的那头恒 500」（keywords.archived，
 *   见 index.ts 那段注释）。判据是"**第一个读它的人来时表在不在**"，不是"我写了迁移"。
 * ⚠️ 每轮只建一次（runDiscovery 开头调），⛔ 不要每搜一次就 CREATE 一遍。
 */
export async function ensureDiscoveryLog(env: Env): Promise<void> {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS discovery_log (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       keyword TEXT NOT NULL, gl TEXT NOT NULL,
       searched_at TEXT NOT NULL DEFAULT (datetime('now')),
       results INTEGER NOT NULL DEFAULT 0, inserted INTEGER NOT NULL DEFAULT 0)`
  ).run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_discovery_log_kw ON discovery_log(keyword, gl)").run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_discovery_log_at ON discovery_log(searched_at)").run();
}

/**
 * 记一次搜索。**best-effort**：失败只留结构化日志，⛔ 绝不把异常抛回找客户那条链。
 * ⚠️ 记账的重要性**低于产出** —— 与上面 `serper_fail_last` 那处同一条处置原则。
 */
async function logDiscoverySearch(
  env: Env, row: { keyword: string; gl: string; results: number; inserted: number },
): Promise<void> {
  try {
    await env.DB.prepare(
      "INSERT INTO discovery_log (keyword, gl, results, inserted) VALUES (?, ?, ?, ?)"
    ).bind(row.keyword, row.gl, row.results, row.inserted).run();
  } catch (e) {
    // ⚠️ 说出来：静默失败会让体检页的"自 X 日起统计"变成一句无法证伪的话。
    console.error(`discovery-log: ${row.keyword}/${row.gl} 记账失败（找客户不受影响）:`, e);
  }
}

export async function getSerperUsage(env: Env): Promise<{ usedToday: number; budget: number }> {
  const usedKey = `serper_used_${new Date().toISOString().slice(0, 10)}`;
  const usedToday = Number(await getS(env, usedKey, "0")) || 0;
  const braw = Number(await getS(env, "serper_daily_budget", String(SERPER_DAILY_BUDGET_DEFAULT)));
  const budget = Math.max(0, Number.isFinite(braw) ? braw : SERPER_DAILY_BUDGET_DEFAULT);
  return { usedToday, budget };
}

// ===== 免费目录发现源（批B）：零 Serper 搜索费，抓公开会员目录入库，走现有去重+分析管道 =====
/** ⛔ 已启用的目录源注册表 —— **现在是空的**（C2-A，2026-08-31）。
 *
 *  为什么空：上游那两个源（NMEA 船舶电子经销商目录 / rvwithtito 房车太阳能安装商名录）是
 *  **Wanew 的垂直**，对 AirSonde（IAQ 空气检测仪）是错行业。它们曾被 cron 每 6 小时灌进生产库
 *  261 条无关线索，同时反复爬第三方站；C2-A 已备份后清空。
 *
 *  ⚠️ 管道与**来源背书逻辑一行未拆**（openrouter.ts 的 SOURCE_ENDORSEMENT 照旧）：
 *     C3 研究单找到属于 IAQ 的行业目录后，**在这里加一条**即可复用整条管道，
 *     而不是把某个开关再翻回去 —— 加数据比翻开关更难错。
 *
 *  ⚠️ 闸装在三个抓取函数**自己**身上（见下），不是装在调用点：
 *     调用点今天有 3 个，明天可能有第 4 个；守函数才守得住没想到的那一个。
 *     这是 devguard.ts 那条「往上收敛，只守出站口子」的同一条纪律。 */
/* ⚠️ C5-3（2026-08-31）补记：**前端那两个按钮的 JS 实现已连壳删除**
 *   （`runNmeaHarvest` / `runRvHarvest` 随「找客户」整页解散一并删掉）。
 *   所以将来接 IAQ 行业目录时，不是"把按钮翻回来"，而是两步：
 *     ① 在下面这个注册表里加一条来源
 *     ② 在前端重新写一个入口（建议进「➕ 补货」弹窗，与"自动搜一轮/导入 CSV"并列）
 *   后端管道（三个抓取函数 + SOURCE_ENDORSEMENT 背书）**一行未拆**，仍可直接复用。 */
export const ENABLED_DIRECTORY_SOURCES: readonly string[] = [];
export function directorySourcesEnabled(): boolean { return ENABLED_DIRECTORY_SOURCES.length > 0; }
/** 统一的"没有已启用目录源"空结果 —— 不抛错：调用方（cron/后台按钮）该看到"没跑"，不是"炸了"。 */
function noDirectorySources(affcode?: string): DirectoryResult {
  console.log("directory harvest skipped: ENABLED_DIRECTORY_SOURCES 为空（C2-A：AirSonde 尚无自有 IAQ 目录源）");
  return { affcode, fetched: 0, inserted: 0, skipped: 0, noSite: 0, social: 0,
           errors: ["未启用任何目录源：AirSonde 还没有属于自己的 IAQ 行业目录（C3 研究单在找）"] };
}

export interface DirectoryResult {
  affcode?: string; fetched: number; inserted: number; skipped: number; noSite: number; social: number; errors: string[];
}
// NMEA 会员目录：Learn More(slug+listingID) 与 Visit Site(官网) 相邻成对；一条正则配对抽取
const NMEA_LISTING_RE = /\/Directory-Listing\/([^"]+?)-(\d+)"[^>]*>\s*Learn More\s*<\/a>\s*<\/span>\s*<span class="ListingResults_Level3_VISITSITE">\s*\|\s*<a href="([^"]+)"/g;
const NMEA_AFFCODES = ["Dealer", "International"];   // Manufacturer(多为厂商非买家)默认不抓

// 抓 NMEA 船舶电子经销商目录的**单个 affcode**（前端逐个调、间隔 10s 遵守 Crawl-delay），入库 source='nmea'
export async function runNmeaDiscovery(env: Env, affcode: string): Promise<DirectoryResult> {
  if (!directorySourcesEnabled()) return noDirectorySources(affcode);   // C2-A 闸
  const aff = NMEA_AFFCODES.includes(affcode) ? affcode : "Dealer";
  const out: DirectoryResult = { affcode: aff, fetched: 0, inserted: 0, skipped: 0, noSite: 0, social: 0, errors: [] };
  let html = "";
  try {
    const res = await fetch(`https://web.nmea.org/directory/results/results.aspx?affcode=${encodeURIComponent(aff)}&ysort=true`, {
      headers: { "user-agent": "AirSondeBot/1.0 (+https://airsonde.com; contact sales@airsonde.com)" },
    });
    if (!res.ok) { out.errors.push(`HTTP ${res.status}`); return out; }
    html = await res.text();
  } catch (e: any) { out.errors.push(String(e?.message || e)); return out; }

  const seen = new Set<string>();
  NMEA_LISTING_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NMEA_LISTING_RE.exec(html))) {
    out.fetched++;
    // ⚠️ 这个名字来自 URL slug，**里面是 URL 编码的**。不解码的话 Joe 在后台看到的是
    //    `Philbrook%27s Boatyard`（`%27` = 撇号）—— 生产实测就有这么一条（#410，nmea 管道，07-14）。
    //    decodeURIComponent 遇到坏序列（比如孤零零一个 `%`）会抛 URIError，所以兜一下：
    //    解不开就用原文 —— **绝不因为一个名字没解码就把整家公司丢掉**。
    let slug = m[1];
    try { slug = decodeURIComponent(slug); } catch { /* 坏编码 → 用原文，名字丑总比丢线索强 */ }
    const rawName = slug.replace(/-/g, " ").replace(/\s+/g, " ").trim();
    const href = (m[3] || "").trim();
    if (/^https?:\/\/NA\/?$/i.test(href)) { out.noSite++; continue; }                 // 占位无站
    const low = href.toLowerCase();
    if (low.includes("facebook.com") || low.includes("instagram.com")) { out.social++; continue; }  // 社媒不当官网
    const domain = domainOf(href);
    if (!domain || isJunkDomain(domain) || seen.has(domain)) { out.skipped++; continue; }
    seen.add(domain);
    const website = href.startsWith("http") ? href.replace(/\/+$/, "") : "https://" + domain;
    const dup = await findDuplicateLead(env, { website });   // 批⑮：统一判重（网址归一化 + 邮箱）
    if (dup) { out.skipped++; continue; }
    const company = rawName || companyFromDomain(domain) || "(unknown)";
    const country = inferCountryFromWebsite(website) || null;   // ccTLD 能推则填，否则留空由 AI 分析回填
    // ⭐ 存 affcode（Dealer / International）到 keyword：以前只写 source='nmea'，把这条丢了 →
    //    入库后再也分不清哪条来自哪个分支，来源背书也就没法分级、没法追溯。
    //    （存量那 196 条的 keyword 全是 NULL，无法回溯，统一按泛称 "NMEA 目录" 处理。）
    const ins = await env.DB.prepare("INSERT INTO leads (company_name, website, country, source, keyword, status) VALUES (?, ?, ?, 'nmea', ?, 'new')").bind(company, website, country, aff).run();
    await markSibling(env, Number(ins.meta.last_row_id), website);   // 跨域名疑似同一家 → 打标记，不合并
    out.inserted++;
  }
  return out;
}

// rvwithtito RV 离网/太阳能安装商名单：URL + 黑名单单一真源（端点与 cron 自动刷新共用，避免两处漂移）
export const RVWITHTITO_URL = "https://rvwithtito.com/rv-solar-installers/";
export const RVWITHTITO_BLACKLIST = [
  "rvwithtito", "google", "facebook", "instagram", "surecart", "mailerlite", "youtube", "twitter", "amazon",
  "wp.com", "gravatar", "w.org", "gmpg.org", "w3.org", "schema.org", "googleapis", "gstatic", "jquery",
  "bootstrapcdn", "cloudflare", "wordpress.org",   // 滤 WP <head> 样板域
];

// 队列⑦：免费目录源「每周自动刷新」——零 Serper。cron 每 6h 调一次，内部判 >7 天才真跑。
// 遵守 robots：affcode 之间 + rvwithtito 之前各停 10s（Crawl-delay 10）、礼貌 UA（在各抓取函数里）。
// 抓到的新公司走现有去重 + 分析管道（cron 的 analyze 步骤会自动按 H3 打分）。
export async function runDirectoryRefresh(env: Env, opts: { force?: boolean } = {}): Promise<{
  ran: boolean; reason?: string; inserted: number; detail: Record<string, number>;
}> {
  const detail: Record<string, number> = {};
  // C2-A 闸：没有已启用的目录源 ⇒ 连"该不该刷新"都不必问。
  // ⚠️ 且**绝不碰 directory_last_refresh** —— 上游三次事故之一正是"清了这个游标 → 真去抓了一次 nmea.org"。
  if (!directorySourcesEnabled()) {
    return { ran: false, reason: "未启用任何目录源（C2-A：AirSonde 尚无自有 IAQ 目录源）", inserted: 0, detail };
  }
  if (!opts.force && (await getS(env, "directory_autorefresh_enabled", "1")) !== "1") {
    return { ran: false, reason: "autorefresh disabled", inserted: 0, detail };
  }
  const last = (await getS(env, "directory_last_refresh", "")).trim();
  if (!opts.force && last) {
    const ts = Date.parse(last);
    if (Number.isFinite(ts) && Date.now() - ts < 7 * 24 * 3600 * 1000) {
      return { ran: false, reason: `last refresh ${last}, <7d`, inserted: 0, detail };
    }
  }
  let inserted = 0;
  for (let i = 0; i < NMEA_AFFCODES.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 10000));   // Crawl-delay 10
    const r = await runNmeaDiscovery(env, NMEA_AFFCODES[i]);
    detail[`nmea:${NMEA_AFFCODES[i]}`] = r.inserted;
    inserted += r.inserted;
  }
  await new Promise((r) => setTimeout(r, 10000));                // 换站也停 10s
  const rv = await runLinkHarvest(env, RVWITHTITO_URL, "rvwithtito", RVWITHTITO_BLACKLIST);
  detail["rvwithtito"] = rv.inserted;
  inserted += rv.inserted;
  await setS(env, "directory_last_refresh", new Date().toISOString());
  return { ran: true, inserted, detail };
}

// 通用「网页链接采集」免费源：抓一个页面正文里的外链域名，黑名单第三方域后入库（rvwithtito 等 RV 安装商名单用）
export async function runLinkHarvest(env: Env, url: string, source: string, blacklist: string[]): Promise<DirectoryResult> {
  if (!directorySourcesEnabled()) return noDirectorySources();          // C2-A 闸
  const out: DirectoryResult = { fetched: 0, inserted: 0, skipped: 0, noSite: 0, social: 0, errors: [] };
  let html = "";
  try {
    const res = await fetch(url, { headers: { "user-agent": "AirSondeBot/1.0 (+https://airsonde.com; contact sales@airsonde.com)" } });
    if (!res.ok) { out.errors.push(`HTTP ${res.status}`); return out; }
    html = await res.text();
  } catch (e: any) { out.errors.push(String(e?.message || e)); return out; }
  const seen = new Set<string>();
  const bl = blacklist.map((b) => b.toLowerCase());
  const re = /href="(https?:\/\/[^"]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    out.fetched++;
    const href = m[1].trim(); const low = href.toLowerCase();
    if (low.includes("facebook.com") || low.includes("instagram.com")) { out.social++; continue; }
    const domain = domainOf(href);
    if (!domain || isJunkDomain(domain) || bl.some((b) => domain.includes(b)) || seen.has(domain)) { out.skipped++; continue; }
    seen.add(domain);
    const website = "https://" + domain;
    const dup = await findDuplicateLead(env, { website });   // 批⑮：统一判重（网址归一化 + 邮箱）
    if (dup) { out.skipped++; continue; }
    const ins = await env.DB.prepare("INSERT INTO leads (company_name, website, country, source, status) VALUES (?, ?, ?, ?, 'new')").bind(companyFromDomain(domain) || "(unknown)", website, inferCountryFromWebsite(website) || null, source).run();
    await markSibling(env, Number(ins.meta.last_row_id), website);   // 跨域名疑似同一家 → 打标记，不合并
    out.inserted++;
  }
  return out;
}

// 本地 settings 读写（避免 discover→send 循环依赖）
async function getS(env: Env, key: string, def = ""): Promise<string> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key=?").bind(key).first<{ value: string }>();
  return row?.value ?? def;
}
async function setS(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(key, value).run();
}

// 关键词池：优先 keywords 表，空则用默认；P0-a 尊重面板勾选（active_keywords 非空则只用勾选的）
export async function getKeywords(env: Env): Promise<string[]> {
  // C5-29③：下架的关键词不进轮转。⚠️ COALESCE 兜住老库还没 ALTER 过的情况。
  const rows = await env.DB.prepare("SELECT keyword FROM keywords WHERE COALESCE(archived,0)=0 ORDER BY weight DESC, id ASC").all();
  const list = (rows.results as any[]).map((r) => r.keyword);
  if (!list.length) return DEFAULT_KEYWORDS;
  const akRaw = (await getS(env, "active_keywords", "")).trim();   // P0-a：面板"取消勾选"的关键词 cron 真的不跑
  if (akRaw) {
    const active = new Set(akRaw.split("\n").map((s) => s.trim()).filter(Boolean));
    const filtered = list.filter((k) => active.has(k));
    if (filtered.length) return filtered;   // 勾选集非空→只用勾选的；全没匹配上则回落全表（防误清空导致 0 词）
  }
  return list;
}

/**
 * ⭐ C5-50②：关键词 → 语言。**单独一个函数，⛔ 不改 `getKeywords()` 的返回形状。**
 *
 * 为什么不把 lang 塞进 getKeywords：它返回 `string[]`，有 4 个消费方（两处直接把它当
 * 字符串数组丢给前端）。为了一个只有 runDiscovery 用得上的字段去改公共形状，
 * 是拿 4 处的风险换 1 处的方便。
 *
 * 🔴 **自愈补列挂在这里，因为「第一个读这一列的人」就是它。**
 *   判据不是"有没有把列写进 SELF_HEAL_COLUMNS"，而是**第一个读它的人来的时候列在不在**。
 *   （2026-09-04 刚栽过同形状的一次：`emails.delivered_at` 只加进整点班那张清单，
 *     而 webhook 抢在前面到，于是读一个不存在的列。）
 */
async function ensureKeywordLangColumn(env: Env): Promise<void> {
  try { await env.DB.prepare("ALTER TABLE keywords ADD COLUMN lang TEXT").run(); }
  catch { /* 已经有这一列 —— 正常，不是错误 */ }
}
export async function getKeywordLangs(env: Env): Promise<Map<string, string>> {
  await ensureKeywordLangColumn(env);
  const out = new Map<string, string>();
  try {
    const rows = await env.DB.prepare("SELECT keyword, lang FROM keywords").all();
    // ⚠️ NULL / 空 一律当 en：存量 51 个词就是这么落到 en 的，⛔ 不需要一次性 UPDATE 脚本。
    for (const r of (rows.results as any[])) out.set(r.keyword, String(r.lang || "en").trim().toLowerCase() || "en");
  } catch (e) { console.error("getKeywordLangs 读失败，全部按 en 处理：", e); }
  return out;
}

export async function seedDefaultKeywords(env: Env): Promise<void> {
  for (const kw of DEFAULT_KEYWORDS) {
    await env.DB.prepare("INSERT INTO keywords (keyword) VALUES (?) ON CONFLICT(keyword) DO NOTHING").bind(kw).run();
  }
}

export interface KeywordStat { keyword: string; sent: number; replied: number; rate: number; weight: number; }

// 关键词优化引擎：按各关键词真实回复率重算权重，让高回报词被搜得更多、低效词自然降权。
// - sent    = 该 keyword 的 lead 中「有 status='sent' 邮件」的去重数
// - replied = 该 keyword 的 lead 中「status='replied' 或 replies 表有记录」的去重数
// - weight  = 拉普拉斯平滑：先验回复率 P0、伪计数 ALPHA，使 0 数据新词恰好落在默认 1.0（不惩罚），
//             有数据后好词上浮、发多零回的词下沉；clamp 到 [WMIN,WMAX] 避免小样本噪音。
// leads.keyword 可能为 NULL（CSV 导入的没有）——keyword=? 连接自然跳过。全部 SQL 参数化。
export async function recomputeKeywordStats(env: Env): Promise<{ updated: number; stats: KeywordStat[] }> {
  const P0 = 0.05, ALPHA = 10, K = 10, WMIN = 0.2, WMAX = 5;
  const rows = await env.DB.prepare("SELECT id, keyword FROM keywords").all();
  const kws = rows.results as { id: number; keyword: string }[];
  const stats: KeywordStat[] = [];
  let updated = 0;
  for (const { id, keyword } of kws) {
    if (!keyword) continue;
    const sentRow = await env.DB.prepare(
      `SELECT COUNT(DISTINCT l.id) AS n FROM leads l JOIN emails e ON e.lead_id = l.id WHERE l.keyword = ? AND e.status = 'sent' AND ${notTestSql('l')}`
    ).bind(keyword).first<{ n: number }>();
    const repRow = await env.DB.prepare(
      // 🔴 2026-09-02 Joe 指认：「indoor air quality services company 发7·回1·14%」那个"回1"
      //   是 Conditionedair 的自动回执。**机器发的"我们收到了"不算这家公司回应了你。**
      //   排除谓词单一真源在 reply-inbox.ts（REAL_REPLY_SQL），别在这儿手写 r.is_auto。
      `SELECT COUNT(DISTINCT l.id) AS n FROM leads l WHERE l.keyword = ? AND ${notTestSql('l')}
         AND (l.status = 'replied' OR EXISTS (SELECT 1 FROM replies r WHERE r.lead_id = l.id AND ${realReplySql('r')}))`
    ).bind(keyword).first<{ n: number }>();
    const sent = sentRow?.n || 0;
    const replied = repRow?.n || 0;
    let weight: number;
    if (sent === 0) {
      weight = 1.0; // 0 数据的新词：保持默认权重，不惩罚
    } else {
      const smoothed = (replied + ALPHA * P0) / (sent + ALPHA);
      weight = Math.max(WMIN, Math.min(WMAX, 1 + (smoothed - P0) * K));
      weight = Math.round(weight * 1000) / 1000;
    }
    await env.DB.prepare(
      "UPDATE keywords SET sent_count = ?, reply_count = ?, weight = ? WHERE id = ?"
    ).bind(sent, replied, weight, id).run();
    updated++;
    stats.push({ keyword, sent, replied, rate: sent > 0 ? replied / sent : 0, weight });
  }
  return { updated, stats };
}
