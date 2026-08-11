-- 批⑭③：删掉"确切不是公司"的 3 条（**总工跑，我不执行**）
--
-- 总工把 72 条名字-only 全看了，确切能删的**就这 3 条**。逐条精确匹配，**绝不用模式泛删**。
--
-- ⚠️⚠️ Joe 的死命令（我今天已在"装机型""大连锁"上栽过两次）：
--   **「不是公司」可删，「不是好客户」不许碰。**
--   · goo.gl / g.page = Google 短链/商家页服务，**不是一家公司的官网** → 可删
--   · "None" = 数据错误（website 字段就是字符串 "None"）→ 可删
--   · **平台/大零售一个都不删**：etsy / newegg / konga / jiji / bunnings / jbhifi / currys …
--     那是"体量大"不是"不是公司"。按 Joe"不管体量大小，有星链配件需求就是潜在客户" —— 留着。
--     （JB Hi-Fi 在货架上卖星链套装，正是我们给 Michael 写的"零售配货"打法的客户。）
--
-- 每条都用 **id + website 双条件**防呆：万一 id 在你跑之前变了，条件不满足就是 0 行，不会误删别家。
-- ⚠️ 跑前先核对这 3 个 id 对应的还是这 3 家（生产可能已变动）：
--   SELECT id, company_name, website FROM leads WHERE website IN ('http://None','https://g.page','https://goo.gl');

-- 先删可能存在的 lead_analysis 行（外键/孤儿），再删 leads
DELETE FROM lead_analysis WHERE lead_id IN (
  SELECT id FROM leads WHERE
    (company_name='DYNEXGEN NDSS' AND website='http://None') OR
    (company_name='G'  AND website='https://g.page') OR
    (company_name='Goo' AND website='https://goo.gl')
);

DELETE FROM leads WHERE
  (company_name='DYNEXGEN NDSS' AND website='http://None') OR
  (company_name='G'  AND website='https://g.page') OR
  (company_name='Goo' AND website='https://goo.gl');
-- 期望：删 3 行（各 1）。若少于 3，说明某条的 name/website 已变 —— **别强删，回来核对**。

-- 跑完自检：
-- SELECT COUNT(*) FROM leads WHERE website IN ('http://None','https://g.page','https://goo.gl');  -- 期望 0
