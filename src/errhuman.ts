// ══ C5-24 第 5 条：把机器的错误串翻译成 Joe 能据以行动的一句话 ══
//
// Joe 不需要知道 `platform:subrequest-limit | Too many subrequests by single Worker invocation`
// 是什么意思，他需要知道的是**这属于哪一类、要不要他动手**。
//
// ⚠️ 三条设计约束：
//
//   1. **服务端唯一一份。** 状态栏的受阻小字来自 /api/activity（服务端），时间线的错误串
//      也源自服务端（emails.error）。放前端就会变成两份映射 —— 而这一族单子本身就是在治双真源。
//
//   2. **原话绝不丢。** 翻译是给人看的**第二层**，排查时要的永远是服务器原话
//      （"记录证据 ≠ 报告结论"）。所以每次都同时返回 human 与 raw，渲染方把 raw 放进 title。
//      ⛔ 不许用翻译去覆盖落库的原话 —— 落库那份是排查真源。
//
//   3. **认不出来时说"认不出"，不硬归类。** 硬塞一个类别会让 Joe 按错的方向去排查，
//      那比不翻译更贵（同 C5-13 里 unclear 的道理："塞错比说不知道更贵"）。
//
// 六类的排序 = **按 Joe 的处置动线**分的三组：钱 / 钥匙 / 保险丝。

export type ErrKind =
  | "breaker"     // 保险丝：退订太多，机器自己停了发信
  | "ai"          // 钥匙/供应：写信打分的模型不可用
  | "resend"      // 钥匙/供应：发信通道不可用
  | "secret"      // 钥匙：某个密钥失效
  | "serper"      // 钱：搜索额度用尽/欠费
  | "platform"    // 保险丝：平台额度（子请求/CPU）
  | "unknown";    // ⚠️ 认不出 —— 不硬归类

export interface ErrHuman {
  kind: ErrKind;
  /** 给 Joe 看的一句话：**说清发生了什么 + 要不要他动手**。 */
  human: string;
  /** 服务器原话，原样带出，渲染方放进 title 供排查。 */
  raw: string;
  /** 归到哪一组处置动线：钱 / 钥匙 / 保险丝 / 未知。 */
  group: "钱" | "钥匙" | "保险丝" | "未知";
}

/**
 * ⚠️ 匹配顺序有意义：**先认最具体的**。
 *   `platform:subrequest-limit` 这类带前缀的最先认，免得被后面宽泛的关键词（如 "limit"）抢走。
 */
export function errHuman(raw?: string | null): ErrHuman {
  const s = String(raw || "").trim();
  const low = s.toLowerCase();
  const mk = (kind: ErrKind, human: string, group: ErrHuman["group"]): ErrHuman => ({ kind, human, raw: s, group });

  if (!s) return mk("unknown", "没有记录到失败原因", "未知");

  // ── 保险丝 ──────────────────────────────────────────────
  if (low.includes("subrequest") || low.includes("too many subrequests"))
    return mk("platform", "平台单次额度用满了，这封没发出去；机器下一轮会自动重试，通常不用你动手", "保险丝");
  if (low.includes("exceeded cpu") || low.includes("script exceeded"))
    return mk("platform", "这一轮跑得太久被平台掐断了；剩下的会顺延到下一轮，不会丢", "保险丝");
  // ⚠️ 断路器落库的**真实原话**是「最近 30 封自动开发信里 6 封退订 = 20.0%」——
  //   里面**没有"熔断"二字**。只认那三个词会让它落进"未知"（单测用真串时抓出来的）。
  if (low.includes("熔断") || low.includes("tripped") || low.includes("breaker") || /退订.*=\s*[\d.]+\s*%/.test(s))
    return mk("breaker", "退订的人太多，机器自己停了自动发信。要恢复得你先看一眼信写得怎么样，再到机器房 · 机器开关里手动重开", "保险丝");

  // ── 钥匙 / 供应 ─────────────────────────────────────────
  // ⚠️ 顺序要紧：**"缺钥匙"必须排在"服务不可用"之前**。
  //   `缺少 RESEND_API_KEY` 里含 "resend"，先匹配到 resend 的话会给出
  //   "通道恢复就会发出去"这种**错的处置建议** —— 钥匙没配它不会自己恢复，得人去补。
  //   （单测用生产真串时抓出来的：翻译错方向比不翻译更贵。）
  if (low.includes("api_key") || low.includes("api key") || low.includes("缺少") ||
      low.includes("unauthorized") || low.includes(" 401") || low.includes(" 403"))
    return mk("secret", "某个密钥失效或没配上，机器进不去那个服务 —— 这个需要你去补钥匙", "钥匙");
  if (low.includes("openrouter") || low.includes("model") && low.includes("not found"))
    return mk("ai", "写信/打分用的 AI 服务这会儿用不了（可能是模型下架或余额问题）——它一恢复机器就会自己接着跑", "钥匙");
  if (low.includes("resend") || low.includes("smtp"))
    return mk("resend", "发信通道这会儿用不了；信还在队列里，通道恢复就会发出去", "钥匙");
  // ── 钱 ─────────────────────────────────────────────────
  if (low.includes("serper") || low.includes("quota") || low.includes("insufficient"))
    return mk("serper", "搜索额度用完了（找客户这一步会停，别的不受影响）—— 要继续找就得加额度或等明天", "钱");

  // ⚠️ 认不出就**说认不出**，并把原话带上让人自己看 —— 不硬塞一个类别。
  return mk("unknown", "机器报了一个还没归类的错误（原话见悬浮提示）", "未知");
}
