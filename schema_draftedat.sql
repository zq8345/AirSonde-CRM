-- 批⑪C：记下"这一次真的调了 AI 写信"的时刻（**总工跑，我不执行**）
--
-- 为什么非加这一列不可（现成表里算不出来）：
--   Joe 要看「今日 AI 用量：分析 N 家 · 写信 M 封」，好自己看见批⑦ 省下的钱。
--   · 数 `emails` 行 = 数**发送**，不是数 AI 调用 —— 草稿生成之后还可能被压制名单/幂等跳过
--     （deliverEmail 的 8 个 skip 全部 return 在 `INSERT INTO emails` 之前）
--     → **AI 的钱烧了，却不建行** → 少报
--   · `analyzed_at` 是**打分**的时间；批⑦ 之后 ensureDraft 只 UPDATE recommended_email，
--     根本不碰 analyzed_at → 它也不是"写信的时间"
--
-- 总工的要求是"别为这个新建表"—— 没建表，加一列。
-- 不加就只能给 Joe 一个假数字，而这一整晚我们修的全是"假数字/假绿灯"。
--
-- ⚠️ ensureDraft 里 `if (a?.recommended_email) return` 是幂等：有草稿就直接返回、**不调 AI**。
--    所以 drafted_at 只在真生成的那条路上写 = 它数的正是**真花钱的那些次**。
--
-- ⚠️ ALTER TABLE ADD COLUMN 在 SQLite 不支持 IF NOT EXISTS，**重复执行会报 duplicate column name**。
--    只跑一次；报这个错说明已经加过了，可安全忽略。
ALTER TABLE lead_analysis ADD COLUMN drafted_at TEXT;

-- 「今日写信 M 封」每次开设置页都要算一次，加索引。
CREATE INDEX IF NOT EXISTS idx_lead_analysis_drafted_at ON lead_analysis(drafted_at);

-- ---- 存量说明（不回填，故意的）----
-- 存量的 recommended_email 是**批⑦ 之前**分析时顺带写的，它们的 drafted_at 会是 NULL。
-- **不回填**：我们不知道那些草稿是什么时候生成的，编一个时间戳进去就是造假数据 ——
-- 而"今日用量"只关心今天，NULL 天然不计入，正好正确。
--
-- 跑完自检：
-- SELECT COUNT(*) AS total, SUM(CASE WHEN drafted_at IS NOT NULL THEN 1 ELSE 0 END) AS has_ts FROM lead_analysis;
-- 期望：has_ts = 0（这一列刚加，还没人写过）。之后每发一封新信，它 +1。
