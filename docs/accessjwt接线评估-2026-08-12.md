# accessjwt 接线评估（清单第 4 项 · 2026-08-12 · CRM 窗 · 一页纸）

## 结论先行

**必要，但不是现在——排进发信单同批，公开正门（api.airsonde.com）开通前完成强制。**
工作量约 **半天**（代码 1-2 小时 + 观察期收数）；观察模式（只记日志不拦人）可随时先上，属小改。

## 现状（已实测）

- 本仓 `src/accessjwt.ts`（fork 自上游 e2d0ad0）= 与 wanew-admin `access-jwt.ts` 同源的 observe 模块，
  **未接线**；离线自测闸 14/14 通过（C1 验收跑过）。
- 现行鉴权 = 「`cf-access-authenticated-user-email` 头存在即放行」——只问头在不在，不问真不真。
  今天不可利用（C1 已实测：匿名请求 302 在边缘被拦，到不了 worker；workers_dev=false，无第二路由），
  但安全性 100% 押在边缘行为上——wanew-admin 注释原话：与 H12 同形，判过不能这么干。
- **airsonde-crm 应用的 AUD 已到手**（C1 验收 curl 的登录跳转 `kid=` 参数，公开值，已实测）：
  `b7c3296b15d1012a18800aee72f009e9d5a2910133715eb90958b0b947291233`
- 参照物 wanew-admin 已生产验证的三段式中间件（index.ts:82-153）：
  ① DEV_BYPASS 宿主名校验（生产出现即 500）→ ② JWT 验签通过 ⇒ Access 策略即唯一名单 →
  ③ 回落 = 旧判据原样（过渡态，退役判据 = 生产日志 auth_fallback 归零，不是"过了几天"）。

## 为什么"不是现在"

| 触发条件 | 现状 | 变化点 |
|---|---|---|
| worker 持有写能力/密钥 | 零（全 fail-closed） | 发信单会配 RESEND key 等 |
| 库里有真实客户数据 | 零（空库+seed） | 开闸后 leads 进真数据 |
| 存在不经 Access 的路由 | 无（单路由+workers_dev off） | **发信单要开公开正门**——正是 wanew-admin 警告的"将来多一条不经 Access 的路由"场景 |

三个触发条件全部在发信单那一批同时到来 → 接线属于发信单的**前置**，单独提前做收益有限，
落后于发信单则是裸奔。

## 接线工作量拆解（届时执行清单）

1. `wrangler.jsonc` vars 加 `ACCESS_AUD=b7c3…1233`（非机密，与代码同一次部署——规则 §3.5）。
   ⚠️ 本仓模块的 DEFAULT_ACCESS_AUD 是上游 wanew-crm 应用的值，**不改代码默认值，用 env 覆盖**（保持 fork 干净）。
2. 中间件按 wanew-admin :82-153 三段式移植（⛔ 不从零写；CRM 无 ALLOWED_EMAILS 白名单，
   回落段 = 现行"头存在"判据原样，Joe 的"Access 策略即唯一名单"立场不变）。
3. 分两步上：**先观察模式**（只打 safeLogLine，不拦）跑几天 → 生产日志 auth_jwt_ok 稳定、
   无意外 fallback → 再开强制。上游方法论文档 docs/CRM-Access-JWT验证方案-2026-08-02.md 已随仓，照走。
4. 本地测试：离线 selftest 已覆盖验签逻辑；真 JWKS 抓取在 dev 会被出站闸拦，
   需要时 `.dev.vars` 点名 `DEV_EGRESS_ALLOW=wanewgroup.cloudflareaccess.com`（明写、打横幅，闸的设计本意）。
5. KNOWN_TENANTS（wanewgroup/wanew）**不动**——是 CF 账号真实租户名，AirSonde 应用同在此租户下
   （C1 验收 curl 的 Location 指向 wanewgroup.cloudflareaccess.com，已实测）。

## 风险与回滚

- 最大风险 = 把 Joe 锁外面。三段式的 ③ 回落原样保留 + 观察先行，正是上游为此设计的
  （08-03 事故：鉴权改动上线 7 分钟后 Joe 保存丢字段——同样的动作不能再来一次）。
- 回滚 = revert 中间件 commit；模块本身无状态、无旁路开关（造旁路 = 再造 DEV_BYPASS 后门，上游判过）。

## 砍了什么

- 未做观察模式的提前独立上线（收益=提前收数，代价=一次部署；总工若要，说一声即做，半小时）。
- 未复核 wanew-admin 三段式在其生产的 auth_fallback 是否已归零（那是他们仓的退役进度，不影响本仓评估）。
