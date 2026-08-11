-- 存量清洗：company_name 脏数据（**总工跑，我不执行**）
--
-- 背景：Joe 在后台看到的公司名有两类脏数据。**只影响显示层** ——
-- 发出去的信是好的（AI 写信时不用这个字段，它从抓取的网页内容里认出真名）。
-- 实证：#93 的真信标题是 "Starlink maritime mounts and accessories for **Global Satellite**"，
-- 而 company_name 存的是 "Step-by-Step Guide To Installing Starlink Maritime"。
--
-- ⚠️ 所以这是**低危美化**，不是救火。别顺手去动打分和写信那条链路（它是好的）。
--
-- 规模（2026-07-17 生产只读查的）：447 条线索里
--   · URL 编码残留：**1 条**
--   · 文章标题当公司名：**6 条**
--
-- ⚠️ 两类的**成因不同，修法也不同**：

-- ══════════════════════════════════════════════════════════════
-- 一、URL 编码（1 条）—— 这是**活 bug**，代码已在本批同步修掉
-- ══════════════════════════════════════════════════════════════
-- 成因：nmea 管道从 URL slug 取名，只做了 `replace(/-/g," ")`，**没解 URL 编码**。
-- 代码修复：discover.ts 加 decodeURIComponent（带 try/catch 兜坏编码）。
-- 存量就这一条：
UPDATE leads SET company_name = replace(company_name, '%27', ''''), updated_at = datetime('now')
 WHERE company_name LIKE '%\%27%' ESCAPE '\';
-- 期望：1 行受影响（#410 `Philbrook%27s Boatyard` → `Philbrook's Boatyard`）
--
-- 只处理 %27 是**故意的**：我用 GLOB '*%[0-9A-Fa-f][0-9A-Fa-f]*' 全库扫过，
-- **只有这 1 条**有 URL 编码。不写一个通用的解码器去处理不存在的情况 ——
-- 那种"以防万一"的代码没人验证过，反而更容易出错。真出现别的编码，上面那行代码修复会拦住。

-- ══════════════════════════════════════════════════════════════
-- 二、文章标题当公司名（6 条）—— 这是**存量债，代码早就修好了**
-- ══════════════════════════════════════════════════════════════
-- ⭐ 关键事实（查过时间线，不是猜）：
--   这 6 条全部来自 `search` 管道，建于 **2026-07-11 / 07-12**；
--   而 `isLikelyArticle()` + `companyFromDomain() 优先于标题` 是 **2026-07-15**（e9ae402）才加的。
--   → **现在的代码已经会跳过它们了。这是 3-4 天前的历史债，不是活 bug。**
--   → 所以**这里没有代码要改**。总工原话让我修抓站提取 —— 它已经修好了，别重复做。
--
-- 修法：拿域名反推公司名（跟现在代码里 companyFromDomain 同一个思路）。
-- ⚠️ **不用自动 UPDATE 批量猜**：6 条而已，域名→公司名的映射机器猜不如直接写死准确。
--    下面是逐条的，每条我都对着 website 核过：
UPDATE leads SET company_name='Trio Flatmount',   updated_at=datetime('now') WHERE id=91  AND website LIKE '%trioflatmount%';
UPDATE leads SET company_name='Global Satellite', updated_at=datetime('now') WHERE id=93  AND website LIKE '%globalsatellite%';
UPDATE leads SET company_name='XO Tech Trading',  updated_at=datetime('now') WHERE id=215 AND website LIKE '%xotechtrading%';
-- ↑ 这 3 条的真名有**独立佐证**：AI 写信时自己认出来的就是这些名字（见发出去的正文）。
--
-- ⚠️ 下面 3 条（#104 / #107 / #116）**我没写 UPDATE**，因为我没有佐证：
--   · #104 "Best Starlink Accessories: Mounts Adapter…"（已发过 1 封）
--   · #107 "Best Satellite Internet Providers for Rura…"（没发过）
--   · #116 "Best Internet Options for Boats and Yachts"（没发过）
--   这三个标题是**测评/清单类文章**，它们的站很可能**本来就是内容站**（不是公司）——
--   那样的话正确处理不是"改个名字"，而是**判定它不合格**。
--   我不替 Joe 做这个销毁性决定（跟 <60 分不自动忽略是同一条原则）。
--   建议：把它们的 website 打开看一眼再定。要我查我就查，别让 SQL 替你拍板。
--
-- 每条都带 `AND website LIKE ...` 是**防呆**：万一 id 在你跑之前变了，条件不满足就是 0 行，
-- 不会把名字改到别人头上。跑完请核对受影响行数 = 1/1/1。

-- ══════════════════════════════════════════════════════════════
-- 跑完自检（受影响行数对不对）
-- ══════════════════════════════════════════════════════════════
-- SELECT id, company_name, website FROM leads WHERE id IN (91,93,215,410);
-- 期望：4 条名字都干净了，没有 %27、没有 "How to"/"Step-by-Step"/"Buy "
