-- AirSonde-CRM D1 表结构 —— 单一真源（fork 自 Wanew-CRM；上游 #45 已合并 14 个 schema_*.sql 迁移）
--
-- 这个文件现在**自足**：全新库跑 `npm run db:init:local` / `:remote` 一次即得完整结构，
-- 不再需要再手动补跑各 schema_*.sql（旧的 db:init 只跑 base、会漏掉全部迁移列 = 结构不全的坑）。
-- 全部 CREATE ... IF NOT EXISTS，**幂等**，重复执行安全。
--
-- 合并时消解的两处历史不一致（留档）：
--   1) 旧 base 与 schema_cat.sql 都建 lead_analysis.customer_category → "base+全部迁移按序跑" 会 duplicate column。
--      本文件只声明一次。
--   2) lark_bitable_map（批㉔ Lark 镜像）历史上**只由代码运行时建**（lark-app.ts CREATE TABLE IF NOT EXISTS），
--      无对应 schema 文件；这里一并纳入求完整（与运行时创建同为 IF NOT EXISTS，不冲突）。
-- 保留的 schema_*.sql 仅作历史/给"已存在的旧库"增量补列之用；新库一律以本文件为准。

-- ============ 线索主表：客户生命周期的核心 ============
-- status: new(新导入) → analyzed(AI已打分) → pending(待审核)
--        → approved(批准) → queued(待发) → sent(已发)
--            → replied / unsubscribed / bounced
--        → ignored(忽略) / blacklisted(黑名单) / won(已成交)
CREATE TABLE IF NOT EXISTS leads (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  company_name       TEXT,
  website            TEXT,
  email              TEXT,
  country            TEXT,
  source             TEXT,              -- csv / search / directory / expo ...
  keyword            TEXT,              -- 命中的关键词
  status             TEXT NOT NULL DEFAULT 'new',
  notes              TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
  channels           TEXT,              -- 社媒/IM/电话渠道 JSON（qw）
  next_action        TEXT,              -- 轻CRM 下一步动作（qw）
  next_action_date   TEXT,              -- 下一步日期 YYYY-MM-DD（qw）
  last_engaged_at    TEXT,              -- 最近打开/点击时间，冗余便于排序（sprint1）
  fetch_fail_count   INTEGER NOT NULL DEFAULT 0,   -- 连续抓站失败计数（fetchfail）
  analyzing_at       TEXT,                          -- 分析认领戳（10 分钟过期）。fastTick 与手动批量分析
                                                    -- 并发时用它抢占，避免同一条线索被两边各烧一次 AI。
  human_approved     INTEGER NOT NULL DEFAULT 0,   -- Joe 手动放行 <60（humanapprove，唯一豁免分数线的口子）
  bench_queued       INTEGER NOT NULL DEFAULT 0,   -- 转触达工作台（humanapprove）
  bench_contacted_at TEXT,              -- 工作台「已联系」时间（humanapprove）
  bench_channel      TEXT               -- 工作台「已联系」渠道（humanapprove）
);
CREATE INDEX IF NOT EXISTS idx_leads_status           ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_email            ON leads(email);
CREATE INDEX IF NOT EXISTS idx_leads_website          ON leads(website);
CREATE INDEX IF NOT EXISTS idx_leads_human_approved   ON leads(human_approved, status);
CREATE INDEX IF NOT EXISTS idx_leads_bench            ON leads(bench_queued, bench_contacted_at);
CREATE INDEX IF NOT EXISTS idx_leads_next_action_date ON leads(next_action_date);
CREATE INDEX IF NOT EXISTS idx_leads_last_engaged     ON leads(last_engaged_at);

-- ============ AI 分析结果（与 leads 一对一）============
CREATE TABLE IF NOT EXISTS lead_analysis (
  lead_id           INTEGER PRIMARY KEY REFERENCES leads(id) ON DELETE CASCADE,
  customer_type     TEXT,          -- AI 自由描述细分（详情展示）
  match_score       INTEGER,       -- 匹配分数 0-100
  needed_products   TEXT,          -- 可能需求产品
  reason            TEXT,          -- 判断理由
  recommended_email TEXT,          -- 推荐开发信草稿
  model             TEXT,          -- 所用模型
  analyzed_at       TEXT NOT NULL DEFAULT (datetime('now')),
  customer_category TEXT,          -- 规范分类固定枚举（列表徽章/筛选，见 taxonomy.ts）（cat）
  drafted_at        TEXT           -- 真调 AI 写信的时刻（AI 用量统计，draftedat）
);
CREATE INDEX IF NOT EXISTS idx_analysis_category        ON lead_analysis(customer_category);
CREATE INDEX IF NOT EXISTS idx_lead_analysis_drafted_at ON lead_analysis(drafted_at);

-- ============ 发信记录 ============
CREATE TABLE IF NOT EXISTS emails (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id           INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  subject           TEXT,
  body              TEXT,
  status            TEXT NOT NULL DEFAULT 'queued',  -- queued/sent/failed/bounced
  provider_id       TEXT,          -- Resend 返回 id
  unsubscribe_token TEXT,          -- 退订 token
  sent_at           TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  kind              TEXT DEFAULT 'initial',        -- initial/followup/confirmation/reply（followup）
  opened_at         TEXT,                          -- 首次打开（sprint1）
  open_count        INTEGER NOT NULL DEFAULT 0,
  clicked_at        TEXT,                          -- 首次点击（sprint1）
  click_count       INTEGER NOT NULL DEFAULT 0,
  auto_sent         INTEGER NOT NULL DEFAULT 0,    -- 是否自动发（autosend，熔断器窗口用）
  message_id        TEXT,                          -- 我们发出那封的 Message-ID（replymatch，精确认领回复）
  sender_email      TEXT                           -- 实际发件人（sender，发件域切换地基）
);
CREATE INDEX IF NOT EXISTS idx_emails_lead        ON emails(lead_id);
CREATE INDEX IF NOT EXISTS idx_emails_status      ON emails(status);
CREATE INDEX IF NOT EXISTS idx_emails_auto_window ON emails(auto_sent, kind, status, sent_at);
CREATE INDEX IF NOT EXISTS idx_emails_kind        ON emails(kind);
CREATE INDEX IF NOT EXISTS idx_emails_message_id  ON emails(message_id);

-- ============ 回复记录 ============
CREATE TABLE IF NOT EXISTS replies (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id      INTEGER REFERENCES leads(id) ON DELETE CASCADE,
  category     TEXT,               -- interested/inquiry/not_interested/complaint/other
  content      TEXT,
  received_at  TEXT NOT NULL DEFAULT (datetime('now')),
  from_email   TEXT,               -- 回复发件邮箱（p4）
  subject      TEXT,               -- 回复主题（p4）
  summary      TEXT,               -- AI 一句话摘要（p4）
  message_id   TEXT,               -- 去重键（p4）
  raw_headers  TEXT,               -- 原始头，供日后判自动回复（replyheaders，只观察不判断）
  -- #37 回复箱：handled_at=人已处理（消灭"去邮箱里发完再回来补打卡"）；draft=人工编辑过的回信草稿。
  -- 旧库由 reply-inbox.ts:ensureReplyColumns 运行时幂等补列；这里是新库的真源。
  -- ⚠️ 没有 is_noise 列是**故意的**：噪音判定读取时计算（见 reply-inbox.ts），
  --    存下来等于把今天只有 15 封样本的判断烤死，且会让人误以为它是事实。
  handled_at   TEXT,
  draft        TEXT
);
CREATE INDEX IF NOT EXISTS idx_replies_lead         ON replies(lead_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_replies_msgid ON replies(message_id);
CREATE INDEX IF NOT EXISTS idx_replies_orphan       ON replies(lead_id, received_at);

-- ============ 关键词库（优化引擎）============
CREATE TABLE IF NOT EXISTS keywords (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword     TEXT UNIQUE NOT NULL,
  weight      REAL NOT NULL DEFAULT 1.0,
  sent_count  INTEGER NOT NULL DEFAULT 0,
  reply_count INTEGER NOT NULL DEFAULT 0,
  -- C5-29③：软删标记。**"从轮转移除" ≠ "删除这一行"** ——
  --   战绩（sent_count / reply_count）就存在这一行上，硬删会把它一起销毁，
  --   而派单明确要求"历史战绩数据保留在库不清"。所以下架用标记，不用 DELETE。
  archived    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============ 全局配置（客户画像/发信上限/BCC存档/飞书等）============
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- ============ 持久压制名单（M3：不依赖可变 status，防"两跳洗白"+重导入复发）============
CREATE TABLE IF NOT EXISTS suppressed_emails (
  email      TEXT PRIMARY KEY,   -- 小写邮箱
  reason     TEXT,               -- unsubscribe / bounced / complaint / manual:<status>
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============ Landing 落地页公开表单频率限制（landing）============
CREATE TABLE IF NOT EXISTS inbound_throttle (
  k       TEXT PRIMARY KEY,       -- "ip:<CF-Connecting-IP>" 或 "email:<lower>"
  last_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============ Lark 多维表格镜像映射（批㉔）============
-- 历史上仅由 lark-app.ts 运行时 CREATE IF NOT EXISTS；此处一并声明求完整（幂等，不冲突）。
CREATE TABLE IF NOT EXISTS lark_bitable_map (
  lead_id   INTEGER PRIMARY KEY,
  record_id TEXT NOT NULL,
  synced_at TEXT
);
