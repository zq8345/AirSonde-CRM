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

/** 真回信（排除自动回执）。用于**计数**，不用于展示。 */
export const REAL_REPLY_SQL = "COALESCE(is_auto,0)=0";
/** 带表别名的版本（`FROM replies r` 这种）。 */
export const realReplySql = (alias: string) => `COALESCE(${alias}.is_auto,0)=0`;

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
