// ⭐⭐ 「什么不算业绩」的**唯一定义处**。
//
// 这个文件回答一个问题：**哪些行不该被计进 Joe 的成绩单。**
// 目前两族，将来还会有第三族 —— 都进这里，⛔ 别在调用处手写谓词（手写一次就是第二份真源）。
//
//   ① 自动回执（`replies.is_auto`）—— 机器发的"我们收到了"不代表这家公司回应了你。
//   ② 测试数据（`leads.is_test`）—— 我们自己造的点火/冒烟数据不是战绩。
//
// ⛔⛔ 两族共用同一条处理哲学，别搞混：
//   **只从"计数"里排除，绝不从"展示"里抹掉。**
//   收件箱要看得见那封自动回执，线索列表要看得见那条测试线索 —— 它们真实存在过。
//   把它们从界面上也抹掉，是用一个错换另一个错（而且会让人怀疑数据丢了）。
//
// ⚠️ 事故来历（2026-09-02，Joe 亲自指认）：关键词战绩显示
//   「indoor air quality services company 发7·回1·14%」——那个"回1"是 Conditionedair 的
//   自动回执。当时我已经修了 stage 推进和飞书推卡，**但按表聚合的口径一处都没改** ——
//   因为那时判定只活在 JS 里，SQL 够不着它。教训：**一个判断只要要参与计数，就必须能被 SQL 表达。**

/**
 * 真回信 = **排除自动回执** ∧ **确实是收进来的一封信**（`source='imap'`）。用于**计数**，不用于展示。
 *
 * 🔴 2026-09-04 加第二个条件的来历：库里 16 行 replies，看板顶上写「15 本周回信」，
 *   而**真人写来的信是 0 封**。混在里面的有一行是 Joe 在界面上打的「他回了」标记 ——
 *   它 `is_auto=0`、`category='interested'`，**在所有参与计数的列上与真回信完全同形**。
 *   ⇒ 左栏「已回复」那个 1 就是它：**一个人工标记正被当成一封收到的信在数**。
 *
 * ⚠️ 判据是**声明**（写入方显式给 `source`），⛔ 不是推断（比如"`from_email` 里有没有 `@`"）——
 *   推断型判据坏掉时没有人会发现，它只会安静地把某一类算错。
 * ⚠️ **`source IS NULL` 不算真回信，但也⛔ 不许默默扔掉** —— 见 UNKNOWN_SOURCE_SQL：
 *   多算一封的代价是 Joe 以为有客户在回他（据此做错决定），少算一封的代价是他晚看到一封信。
 *   两种错的代价不对称 ⇒ 不确定的一律**单独显示**，不并进任何一边。
 *
 * 🔴 2026-09-05 加入 `'inbound'`（官网询盘，总工/Joe 定）：**它比回信更强** ——
 *   对方不是被我们敲了门才回话，是自己找上门来。⇒ 计数上**算**"收到的回信"。
 * ⚠️ 但**标注上不许混进"真收到的信"** —— `reply_evidence` 里它有自己的名字「官网询盘」。
 *   计数口径与标注口径是两件事：前者回答"有多少人回应了我们"，后者回答"这一条是怎么来的"。
 * ⚠️ 改这条谓词就是改一个量的定义 ⇒ **消费方已逐个点过**（14 处，全部经由本文件这两个导出，
 *   ⛔ 没有一处手写 `source='imap'`）—— 所以改这里一处就够，这正是当初把它收进单一真源的理由。
 */
export const REAL_REPLY_SQL = "COALESCE(is_auto,0)=0 AND source IN ('imap','inbound')";
/** 带表别名的版本（`FROM replies r` 这种）。 */
export const realReplySql = (alias: string) =>
  `COALESCE(${alias}.is_auto,0)=0 AND ${alias}.source IN ('imap','inbound')`;

/**
 * **口径未知**的回信行：`source` 没值（回填之前的历史行，或某个写入方漏给了值）。
 * ⚠️ 回填之后这个数应当恰好是 **0**；🔴 **但"它是 0"这件事得有人看得见** ——
 *   它是 0 才有资格不显示，⛔ 不是"因为它是 0 所以不用算"。所以 API **恒返回**这个数。
 */
export const UNKNOWN_SOURCE_SQL = "source IS NULL";
export const unknownSourceSql = (alias: string) => `${alias}.source IS NULL`;

/**
 * 🔴 **直接在 `replies` 上数"真回信"时，必须再挂这一条**：那封信所属的线索**不是测试线索**。
 *
 * 事故（2026-09-04，回填之后当场现形）：`replies` #1 是 `joe@airsonde.com` 发给自己的点火测试，
 * 它 `is_auto=0`；回填把它标成 `source='imap'` ⇒ 它**同时满足了 REAL_REPLY_SQL 的两个条件**，
 * 于是「收到的回信」从**正确的 0 变成了错误的 1**。
 * ⚠️ 本文件开头就写着"两族：自动回执 + 测试数据"，而那些**直接查 replies 表**的计数
 *   只挂了第一族 —— 从 `leads` 出发的查询天然带 `NOT_TEST_SQL`，从 `replies` 出发的**没有人替它挂**。
 * ⇒ 凡是 `FROM replies` 的战绩计数，一律再加这一条。⛔ 别指望调用处记得。
 */
export const replyNotTestSql = (alias: string) =>
  `EXISTS (SELECT 1 FROM leads l_nt WHERE l_nt.id = ${alias}.lead_id AND ${notTestSql("l_nt")})`;

/**
 * 非测试线索（排除我们自己造的数据）。用于**计数**，不用于展示。
 *
 * ⚠️ 定义本身**不在这里，而在 `leads.is_test` 这个生成列的 DDL 里**（见下方 LEADS_IS_TEST_DDL）。
 *   为什么用生成列而不是"插入时打标"：插入线索的地方不止一处（发现/CSV导入/入站表单/手工），
 *   **打标漏一处就静默失效**，而且新增插入点的人不会知道要打标。
 *   生成列让数据库自己算 ⇒ 定义只有一处、所有插入天然正确、也不需要回填。
 *   （对照 `is_auto`：那个必须靠代码打标，因为判定依赖 JS 正则，SQL 表达不出来。）
 */
export const NOT_TEST_SQL = "COALESCE(is_test,0)=0";
/** 带表别名的版本（`FROM leads l` 这种）。 */
export const notTestSql = (alias: string) => `COALESCE(${alias}.is_test,0)=0`;

/**
 * `leads.is_test` 生成列的 DDL —— **测试数据的定义就是这段 SQL**（总调度 2026-09-02 定案）。
 * 命中任一即为测试数据：
 *   a) email 或 website 落在 airsonde.com / airsonde.net
 *   b) source 含 ignition / test 标记
 *   c) keyword = 'ignition-test'
 *
 * ⚠️ 边界已实测（6 例，含两条必须判 0 的反向对照）：
 *   公司名里带 "test" 但字段干净 ⇒ **判 0**（我们认字段，不认公司名 —— 真有公司叫 "Testo SE"，
 *   那是德国做测量仪器的真客户，按公司名判会把它误杀）。
 */
export const LEADS_IS_TEST_DDL =
  "ALTER TABLE leads ADD COLUMN is_test INTEGER GENERATED ALWAYS AS (" +
  "CASE WHEN LOWER(COALESCE(email,'')) LIKE '%@airsonde.com' OR LOWER(COALESCE(email,'')) LIKE '%@airsonde.net'" +
  " OR LOWER(COALESCE(website,'')) LIKE '%airsonde.com%' OR LOWER(COALESCE(website,'')) LIKE '%airsonde.net%'" +
  " OR LOWER(COALESCE(source,'')) LIKE '%ignition%' OR LOWER(COALESCE(source,'')) LIKE '%test%'" +
  " OR LOWER(COALESCE(keyword,''))='ignition-test' THEN 1 ELSE 0 END) VIRTUAL";
