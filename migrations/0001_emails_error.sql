-- 0001_emails_error.sql —— 给 emails 加 error 列（存**服务商/运行时原话**，不存我们的措辞）
--
-- ⚠️ 这个文件由开发窗写，**开发窗不执行**。由总工在部署时跑：
--     npx wrangler d1 execute tejoy_getke --remote --file=migrations/0001_emails_error.sql
--
-- 为什么不靠运行时 DDL：代码里确实有幂等的 ensureEmailColumns()，但它挂在 deliverEmail 上，
--   而 deliverEmail **连续 4 天一次都没被调用过**（发信开关关着 + 跟进死在它之前）
--   ⇒ 列一直没建。**"总会被触发"是个假设，2026-08-01 已被证伪。**
--   运行时那条保留作兜底（新增的 recordDraftFailure 也会先调它），但**真源是这个迁移**。
--
-- ⚠️ D1 的 SQLite 不支持 `ADD COLUMN IF NOT EXISTS`。若列已存在，这条会报
--     `duplicate column name: error` —— **那是幂等成功，不是失败**，可以直接忽略。
--     （先跑下面那句 PRAGMA 就能知道要不要跑。）
--
-- 老数据不回填：历史失败行保持 error IS NULL = "未知"。
--   **"未知"比"猜的"诚实 —— 回填等于伪造证据。**

-- 跑之前先看一眼（有 error 这一行就说明已经加过了，下面那句可以跳过）：
-- PRAGMA table_info(emails);

ALTER TABLE emails ADD COLUMN error TEXT;

-- 验收（跑完执行，应能看到 error 列）：
-- SELECT name FROM pragma_table_info('emails') WHERE name='error';
