// #37 回复箱：降噪 + 剥引用 + 处理状态。
//
// 这个文件里的每条规则都来自**生产 15 封真回复**，不是设想出来的：
//   · #13 正文 1105 字符，真实内容只有 "Yes, I would be interested."，其余全是
//     "On Sat, Jul 25, 2026 at 5:01 AM Tejoy <hello@tejoy.net> wrote: > Hi team, > ..."
//     —— 不剥引用，列表里全是我们自己发出去的信。
//   · #10 长度 **4000**（撞上入库截断上限），真内容一句 "number 8 we would be interested in."
//   · #1/#2 是 veritasvans 的自动回执，**同一封重复两次**；#15 是 gorgias 满意度调查机器人。
//     15 封里 4 封机器噪音 + 2 封测试数据 → **真正要人处理的只有 9 封**。降噪是回复箱的第一职责。
import type { Env } from "./index";

/**
 * 排版字符归一化 —— **所有文本规则匹配前统一走这里**。
 * 真数据教的：veritasvans 的自动回执正文是 `We’ve received your message`，用的是
 * **弯撇号 U+2019**，而规则写的是直撇号 `'` → 一个字符之差，两封自动回执全部漏判。
 * ⚠️ 修法是**在入口归一化一次**，不是给每条规则加一个"或弯撇号"的特例 ——
 *    加特例的话，下一个来的是弯引号/长破折号/不换行空格，会一直加下去。
 */
function normalizeText(s: string): string {
  return String(s || "")
    .replace(/[‘’ʼ]/g, "'")     // 弯撇号 → '
    .replace(/[“”]/g, '"')           // 弯双引号 → "
    .replace(/[–—]/g, "-")           // – — → -
    .replace(/ /g, " ")                   // 不换行空格 → 普通空格
    // ⚠️ 真数据里出现的是 `\r\r\n`（双 CR，转发链路产生的畸形换行）——只写 /\r\n/ 会在每行末尾
    //    留下一个孤立 `\r`，导致后面所有**按行锚点的正则（签名/引用标记）全部失配**。一次收干净。
    .replace(/\r\n|\r/g, "\n");
}

/** 引用分隔线：英文/中文客户端常见写法。命中即认为**从这一行起都是被引用的旧内容**。 */
const QUOTE_MARKERS: RegExp[] = [
  /^\s*On .{4,120}\bwrote:\s*$/im,               // Gmail: On <date> <who> wrote:
  /^\s*On .{4,160}$/im,                          // Gmail 换行折断版（下一行是 wrote:），见下方兜底
  /^\s*-{2,}\s*Original Message\s*-{2,}/im,
  /^\s*_{5,}\s*$/m,                              // Outlook 分隔横线
  /^\s*From:\s.+$/im,                            // Outlook: From: xxx
  /^\s*(?:在|於)\s?.{4,80}(?:写道|寫道)\s*[:：]?\s*$/im,
  /^\s*发件人\s*[:：]/im,
];
/** 签名起始：`--` 是 RFC 3676 标准；但真数据里 campervanbuilders(#7/#10) 用的是**独占一行的破折号**
 *  （原文是 em dash，已被上面的归一化统一成 `-`）。两种都认。
 *  ⚠️ 取舍写明：独占一行的短横**有极小概率是正文的一部分**，切错会丢客户真话；
 *     但实测 #7/#10 全靠它才剥得掉签名，且切点之后清一色是联系方式。若日后发现误切，先看这里。 */
const SIG_MARKER = /^\s*(?:--|-)\s*$/m;

/**
 * 剥掉引用与签名，只留客户**这次真正写的话**。
 * ⚠️ 保守策略：**只从最早命中的标记处截断**，绝不做逐行猜测式清理 ——
 *    切多了会把客户真话切掉（那比留点噪音糟得多），所以宁可留一点尾巴。
 */
export function stripQuoted(raw: string): string {
  let text = normalizeText(raw);
  let cut = text.length;
  for (const re of QUOTE_MARKERS) {
    const m = re.exec(text);
    if (m && m.index < cut) cut = m.index;
  }
  const sig = SIG_MARKER.exec(text);
  if (sig && sig.index < cut) cut = sig.index;
  text = text.slice(0, cut);
  // 逐行去掉 "> " 引用行（有些客户端不带分隔线，直接堆 > ）与图片/附件占位
  text = text
    .split("\n")
    .filter((l) => !/^\s*>/.test(l))
    .join("\n")
    .replace(/\[cid:[^\]]*\]/gi, " ")
    .replace(/\[image[^\]]*\]/gi, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text;
}

/** 列表里显示的一行预览（剥完引用再截断，而不是截断原文——否则截出来的全是引用）。 */
export function previewOf(raw: string, n = 140): string {
  const s = stripQuoted(raw).replace(/\n+/g, " ").trim();
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/**
 * 噪音判定 —— **读取时计算，不落库**。
 * 为什么不存：规则一定会改（现在只有 15 封样本），存下来等于把今天的判断烤死；
 * 而且"存了判定"会让人以为它是事实，其实只是当下的猜测。
 *
 * ⚠️ 三条保守纪律（宁可少降噪，也别误伤真客户）：
 *   1. **只认明确的机器特征**（RFC 3834 头、群发头、已知调查机器人链接）；
 *   2. **不把 `other` 整类当噪音** —— 现有 15 封里 other 三封恰好全是机器，但样本太小，
 *      不足以支撑"other = 噪音"这种推断；
 *   3. 结果只用于**折叠分组**，永不删除、永远可切回去看。
 */
export function isNoiseReply(r: { raw_headers?: string | null; content?: string | null; from_email?: string | null }): boolean {
  const h = normalizeText(r.raw_headers || "");
  // RFC 3834 / 群发头：自动回执、假期自动回复、邮件列表
  if (/^Auto-Submitted:\s*(?!no\b)/im.test(h)) return true;
  if (/^X-Auto(?:reply|-Response-Suppress|respond)\b/im.test(h)) return true;
  if (/^Precedence:\s*(bulk|auto_reply|junk)\b/im.test(h)) return true;
  if (/^List-(?:Id|Unsubscribe):/im.test(h)) return true;
  const body = normalizeText(r.content || "");
  // 已知的满意度调查机器人（#15 实例：trioflatmount.gorgias.com/satisfaction-survey）
  if (/satisfaction-survey|\/csat\b|rate (?:the help|your experience)/i.test(body)) return true;
  // 典型自动回执措辞 + 明确说"稍后有人处理"（#1/#2 实例）
  if (/we(?:'ve| have) received your (?:message|request|email)/i.test(body)
      && /(?:will (?:review|respond|get back)|support team)/i.test(body)) return true;
  return false;
}

/** 四个分组页签。noise 与 orphan 是"取向"而非分类：先判孤儿，再判噪音，再按 category 分。 */
export type InboxTab = "pending" | "declined" | "noise" | "orphan";

export function tabOf(r: { lead_id: number | null; category: string | null; raw_headers?: string | null; content?: string | null }): InboxTab {
  if (isNoiseReply(r)) return "noise";           // 噪音优先：机器信没有"待处理"的意义
  if (r.lead_id == null) return "orphan";        // 认不出主人（现有孤儿能力并进回复箱）
  const c = String(r.category || "other");
  if (c === "not_interested" || c === "complaint") return "declined";
  return "pending";                              // interested / inquiry / other 都留在待处理
}

/**
 * 幂等补列：`handled_at`（处理时刻）与 `draft`（人工编辑过的回信草稿）。
 * 本仓已有"运行时自愈"的先例（lark_bitable_map 无 schema 文件靠运行时建表）。
 * ⚠️ 只加列、绝不改既有列；ALTER 在列已存在时报错 → 吞掉即可（这就是幂等）。
 * 每个 isolate 只跑一次（模块级标志），不是每请求都跑。
 */
let columnsEnsured = false;
export async function ensureReplyColumns(env: Env): Promise<void> {
  if (columnsEnsured) return;
  for (const sql of [
    "ALTER TABLE replies ADD COLUMN handled_at TEXT",
    "ALTER TABLE replies ADD COLUMN draft TEXT",
  ]) {
    try { await env.DB.prepare(sql).run(); } catch { /* 列已存在 = 正常，不是错误 */ }
  }
  columnsEnsured = true;
}
