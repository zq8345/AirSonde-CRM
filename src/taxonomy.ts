// 规范客户分类：把 AI 自由生成的 customer_type（很碎、中英文混杂）归一到固定几类，
// 用于列表徽章 + 多维筛选。AI 的细分描述仍保留在 customer_type，用于详情展示。

// ══ C5-13：AirSonde 客户分类体系（Joe 委托总调度重设计）══
//
// 🔴 换掉的原因不是"分得不够细"，是**整套桶是上游 Wanew 的行业**：
//    船舶/海事 · 房车/RV · 离网/偏远 —— 那是 Starlink 生意的分法。
//    AirSonde 的线索是暖通/空气质量公司，**这套桶里没有它们的位置** ⇒ 全掉进「其他」。
//    生产实测（2026-09-01，重刷前）：其他 103 / 137 = **75%**。
//    而 AI 生成的 `customer_type` 是一句一句的长句（137 条里几乎条条不同），
//    关键词归一表**根本接不住** —— 所以病根有两层，两层都要治。
//
// ⇒ 新做法：**让 AI 直接从固定枚举里选**（英文 slug 存库），不再自由生成后靠正则去猜。
//    自由描述仍保留在 `customer_type`（详情页展示用），但**分类以 slug 为准**。
//
// 6 个目标类 + 2 个非目标类。每类带一句"写信从什么角度切" —— 写信 prompt 直接用它，
// 免得同一件事在打分侧和写信侧各写一遍（那是必然会漂开的两处）。
export const CUSTOMER_TYPES = [
  { slug: "brand",                 label: "品牌方",     target: true,
    desc: "想贴牌卖 IAQ 产品的品牌方",
    angle: "white-label / private-label manufacturing: we build it, they put their brand on it" },
  { slug: "distributor",           label: "经销/批发",  target: true,
    desc: "仪器 / 暖通 / 环境设备的经销批发商",
    angle: "trade price list, dealer margin, and order quantities" },
  { slug: "integrator",            label: "安装/集成",  target: true,
    desc: "HVAC 安装、智能楼宇 / BMS、企业 IT 集成",
    angle: "supplying hardware into their projects, and customising it to the spec a project needs" },
  { slug: "monitoring-service",    label: "监测服务商", target: true,
    desc: "空气检测 / 环境咨询 / 监测运营",
    angle: "hardware to go with the service they already sell, plus data interfaces to their platform" },
  { slug: "manufacturer-2nd-source", label: "同行代工", target: true,
    desc: "有自有产品的制造商，找第二供应源或消化溢出产能",
    angle: "acting as their second source / overflow capacity, not competing with their own line" },
  { slug: "end-buyer",             label: "终端大客户", target: true,
    desc: "学校 / 物业 / 工厂，自用批量采购",
    angle: "buying in volume for their own sites" },
  { slug: "excluded",              label: "非目标",     target: false,
    desc: "有自厂的竞争品牌、政府、媒体、协会",
    angle: "" },
  { slug: "unclear",               label: "资料不足",   target: false,
    desc: "官网信息不足，判不出属于哪一类",
    angle: "" },
] as const;

export type CustomerTypeSlug = typeof CUSTOMER_TYPES[number]["slug"];
export const CUSTOMER_TYPE_SLUGS = CUSTOMER_TYPES.map((t) => t.slug) as readonly string[];
/** slug → 中文标签（前端徽章/筛选用）。认不出的一律归 unclear，绝不显示空白。 */
export const CUSTOMER_TYPE_LABEL: Record<string, string> =
  Object.fromEntries(CUSTOMER_TYPES.map((t) => [t.slug, t.label]));

/**
 * slug → 中文标签，**给人看的那一面**。
 *
 * ⚠️ 认不出就**原样返回**，不归 unclear：重刷前库里 137 条还是旧中文桶（"经销/零售"等），
 *    把它们显示成「看不清」等于**在屏幕上谎报分类**——它们的真实状态是"按旧体系分过的"，
 *    不是"判不出"。归一只在**写库**时做（normalizeCustomerType），显示层不替真源做决定。
 *
 * ⚠️ 标签只在**服务端**拼：taxonomy 住在这里，前端再抄一份就是两处口径，
 *    而这一单本身就是在治"分类口径分两处写"的病，别边治边犯。
 */
export function customerTypeLabel(v?: string | null): string {
  const s = String(v || "").trim();
  if (!s) return "";
  return CUSTOMER_TYPE_LABEL[s.toLowerCase()] || s;
}

// ⚠️ 过渡映射：存量 137 条的 `customer_category` 还是旧中文桶。重刷前它们要能正常显示，
//    所以给一张**只读的**旧→新表。重刷之后这张表自然失效，但**不删** ——
//    删了它，任何一条没被重刷到的老数据就会在界面上显示成空白。
const LEGACY_CATEGORY_MAP: Record<string, CustomerTypeSlug> = {
  "安装/集成": "integrator",
  "经销/零售": "distributor",
  "企业/IT": "integrator",     // 旧桶把楼宇/IT 集成混在一起，都是 integrator
  "船舶/海事": "unclear",       // 上游行业，AirSonde 无对应含义
  "房车/RV": "unclear",
  "离网/偏远": "unclear",
  "其他": "unclear",
};

/**
 * 归一到新 slug。**优先认 AI 直接给的 slug**（新链路），认不出再走旧中文桶（存量），
 * 都不认就 unclear —— 不猜。
 */
export function normalizeCustomerType(raw?: string | null): CustomerTypeSlug {
  const s = String(raw || "").trim();
  if (!s) return "unclear";
  const lower = s.toLowerCase();
  if ((CUSTOMER_TYPE_SLUGS as string[]).includes(lower)) return lower as CustomerTypeSlug;
  if (LEGACY_CATEGORY_MAP[s]) return LEGACY_CATEGORY_MAP[s];
  return "unclear";
}
/** 筛选 ?category=<slug> 时要同时命中的**库里原值**：slug 本身 + 映到它的旧中文桶（同一张 LEGACY 表，⛔ 别手写第二份）。
 *  库里存量还有「安装/集成」「其他」这类旧值原样存着（不改数据），筛 integrator 必须把它们一起捞出来，
 *  否则菜单按归一后标签显示 114 条、点进去只剩 108。 */
export function categoryValuesFor(slug: string): string[] {
  const s = String(slug || "").trim().toLowerCase();
  if (!s) return [];
  return [s, ...Object.keys(LEGACY_CATEGORY_MAP).filter((k) => LEGACY_CATEGORY_MAP[k] === s)];
}

/** 打分 prompt 用的枚举清单（slug + 中文说明），单源，别在 prompt 里再抄一遍。 */
export function customerTypeMenu(): string {
  return CUSTOMER_TYPES.map((t) => `· ${t.slug} —— ${t.label}：${t.desc}`).join("\n");
}
/** 写信 prompt 用：这一类该从什么角度切。 */
export function angleFor(slug?: string | null): string {
  const t = CUSTOMER_TYPES.find((x) => x.slug === normalizeCustomerType(slug));
  return t?.angle || "";
}

// ============ 翻牌堆：按"被杀原因"分组 ============
//
// Joe 要能"扫组名整组略过，只在杀错的地方下钻"。所以分组必须映射到**打分器的一票否决理由**，
// 而不是随便切几段分数。
//
// ⚠️ 必须同时吃两种 reason（生产实测发现的，只匹配前缀会让第一天的翻牌堆全是「其他」）：
//   1) H3-v2 打的分：reason 以 `【不合格·纯内容/攻略/评测/新闻/百科/论坛/博客站】…` 开头（scoreLead 拼的）
//   2) 老 prompt 打的分：**没有前缀**，是自由文本，例如"疑似教程/内容页，非真实买家"、
//      "该公司主要提供光纤互联网服务，未提及星链配件"
//   生产现存的 <60 绝大多数是第 2 种 → 只认前缀等于分类器当场失效。
// 关键词匹配即可，不上 AI（总工的要求，也确实够用）。
export const KILL_REASONS = [
  // ⚠️ stale 排最前：这组是**已经被推翻的规则**杀的，几乎必然有错杀 —— Joe 该先看它
  { key: "stale",     label: "⚠️ 被旧规则按体量杀的", hint: "H3-v1 的「巨头/规模太大」一票压低 —— Joe 已明确推翻这条规则（Speedcast 就是这么被埋的）。这组大概率全是错杀，优先复核" },
  { key: "content",   label: "📰 纯内容/攻略站",   hint: "只教怎么装、不卖硬件 —— 老 H3 病根，这类最会靠满篇行业词骗高分" },
  { key: "isp",       label: "📡 竞品运营商",       hint: "只卖自家服务、不碰硬件 —— 但做集成/安装的服务商是目标客户，这组最容易杀错" },
  { key: "oem",       label: "🏗️ 自有品牌设备厂商", hint: "造自己的产品、通过经销商卖，不采购第三方配件" },
  { key: "china",     label: "🏭 中国同行铺货",     hint: "同质低价铺货，压毛利" },
  { key: "nohw",      label: "🔍 看不出卖/装硬件",  hint: "官网信息含糊 —— ⚠️ 也可能只是爬虫没抓到产品页，杀错重灾区" },
  { key: "notreal",   label: "👻 非真实经营实体",   hint: "没有可核实的经营痕迹" },
  { key: "other",     label: "❓ 其他低分",         hint: "没落进上面任何一类" },
] as const;
export type KillReasonKey = typeof KILL_REASONS[number]["key"];

/**
 * 从 reason（含可能的 buyer_type 前缀）推断"它是被哪条规则杀的"。
 * 顺序敏感：越具体、越容易被别的关键词误吸的放前面。
 */
export function classifyKillReason(reason?: string | null): KillReasonKey {
  const s = (reason || "").toLowerCase();
  if (!s.trim()) return "other";
  const has = (re: RegExp) => re.test(s);

  // ⓪ 被 H3-v1 的「体量」规则杀的 —— **最先判**：Joe 已推翻这条规则，这组大概率全是错杀。
  //    实测生产里真有：Telespazio（卫星系统集成商，被判"航天/企业级卫星巨头"）、
    //  AireSpring / Techone（被判"全国性电信/ISP 巨头"）。它们是 H3-v1 的遗留判决，
  //    新 prompt 已经不会这么判了，但存量分数还挂着 —— 重扫前它们就躺在翻牌堆里。
  if (has(/巨头|规模庞大|全国性电信|全国性.*运营商|大型系统集成|连锁大卖场|体量/)) return "stale";
  // ① 纯内容/攻略站 —— 先判，避免"教你怎么装 Starlink"被下面的"装硬件"关键词吸走
  if (has(/内容站|攻略|评测|资讯|教程|新闻|百科|论坛|博客|blog|guide|tutorial|how.?to|step.?by.?step|review|媒体|个人网站|旅行博客|非真实买家/)) return "content";
  // ② 自有品牌设备厂商（上批加的一票否决类）—— 先于 ISP 判，"制造商"不该被"通信/网络"吸走
  if (has(/自有品牌|设备厂商|制造商|manufacturer|oem\b|生产自有/)) return "oem";
  // ③ 中国铺货 —— 也先于 ISP/硬件判，它有独有特征词
  if (has(/中国同行|铺货|低价卖家|亚马逊同质|@163|@qq|@foxmail|ships from china|阿里|alibaba|1688/)) return "china";
  // ③ 竞品运营商（卖自家网络的 ISP/电信/宽带）
  //    生产实测的老文案：光纤互联网服务 / 固定无线互联网服务 / 电信服务提供商 / 主营业务为…互联网
  if (has(/竞品|运营商|isp\b|电信|宽带|光纤|自家网络|互联网服务|internet service|broadband|fiber|wisp|telecom/)) return "isp";
  // ④ 非真实经营实体
  if (has(/非真实|不是真实|无法核实|空壳|停运|域名停放|parked/)) return "notreal";
  // ⑤ 看不出在卖/装硬件（含"官网信息含糊/只有联系表单"）
  if (has(/看不出|未提及|没有.*证据|信息含糊|信息不足|只有联系表单|未明确|无法判断|不明确|未显示|没有显示/)) return "nohw";
  return "other";
}
