# 2026-09-05 关键词重新对齐 · 生产写操作存档

Joe 2026-09-04：「继续优化搜索的关键词」。总工定稿后执行。
表里**没有归档理由列**，所以理由存在这份文件里 —— ⛔ 别指望从 `keywords` 表读出"为什么下架"。

## 归档理由

| 批次 | 条数 | 理由 |
|---|---|---|
| 停用的 4 个 | 4 | `工程施工链，画像调整 2026-09-05` |
| 未勾选的工程链词 | 13 | `工程施工链，画像调整 2026-09-05` —— 删 `active_keywords` 后 `archived` 成唯一开关，不归档它们会全部复活开跑 |
| `smart building solutions provider` | 1 | 集成商语义，Joe 已把集成商降到第三优先 |

### 归档的 18 个（id / 关键词）
29 HVAC controls integrator · 30 building automation systems integrator · 33 ventilation systems installer ·
34 smart building solutions provider · 49 mechanical contractor supplier ·
85 HVAC wholesale distributor · 86 HVAC/R distributor · 87 refrigeration and HVAC supplier ·
88 air conditioning parts distributor · 89 heating and ventilation wholesaler · 90 ductwork and ventilation supplier ·
91 commercial ventilation equipment supplier · 92 air handling equipment distributor · 93 building services distributor ·
94 building management systems distributor · 95 building controls wholesaler · 96 fire and gas detection distributor ·
97 gas detection systems integrator

### 重新启用的 4 个 —— ⚠️ 是「恢复下架词」，⛔ 不是「新加」
21 air quality monitor distributor · 36 test and measurement instruments distributor ·
37 breathalyzer distributor · 41 safety equipment distributor
> 它们的历史 `sent_count` / `reply_count` 一直在这几行上，恢复后战绩延续。

### 新插入的 8 个
`weather station distributor` · `smart home devices distributor` · `consumer electronics importer` ·
`laboratory equipment supplier`（以上 en，id 98-101）
`Messtechnik Händler`(de,102) · `distribuidor de instrumentos de medición`(es,103) ·
`distributeur instrumentation de mesure`(fr,104) · `distributore strumenti di misura`(it,105)

⚠️ 非 ASCII **逐码点核对过**（⛔ 不是肉眼看渲染）：id 102 含 U+00E4 `ä`、id 103 含 U+00F3 `ó`，
长度与期望值逐字相同（`-ceq` 判定 YES）。乱码会表现为 195,164 这样的双字节，没有出现。

---

## `settings.active_keywords` 删除前的两个版本（逐字存档）

🔴 **这个 key 在本次操作期间被界面写过一次** —— 这正是"包含集"复发点的现场记录。

### 版本 A：本次操作开始前（33 条，len=1062）
```
alcohol tester wholesale
energy management systems provider
facility management solutions provider
indoor environmental quality consultant
radon mitigation contractor
building automation systems integrator
breathalyzer distributor
commercial HVAC wholesaler
mechanical contractor supplier
home inspection equipment supplier
laboratory instrument distributor
air quality monitor OEM
HVAC equipment supplier
air purification systems distributor
cleanroom monitoring equipment supplier
air quality monitor wholesale
air quality monitor private label
smart home device brand
building controls distributor
air quality monitor distributor
air quality sensor distributor
BMS integrator air quality
school air quality monitoring provider
CO2 monitor bulk supplier
smart building solutions provider
ventilation systems installer
test and measurement instruments distributor
IAQ monitor supplier
HVAC controls integrator
environmental monitoring equipment distributor
indoor air quality services company
gas detection equipment distributor
HVAC parts wholesale distributor
```

### 版本 B：删除前一刻（15 条，len=479）—— 界面把"当时显示为勾上的那 15 个"写了回来
```
building automation systems integrator
commercial HVAC wholesaler
building controls distributor
air purification systems distributor
HVAC equipment supplier
mechanical contractor supplier
cleanroom monitoring equipment supplier
CO2 monitor bulk supplier
smart building solutions provider
IAQ monitor supplier
HVAC controls integrator
environmental monitoring equipment distributor
ventilation systems installer
HVAC parts wholesale distributor
gas detection equipment distributor
```

> ⭐ 版本 B 恰好是**改动前实际在跑的那 15 个**。它把 12 个刚加/刚恢复的词全挡在外面：
> 删除前一刻实测 **未下架 22 ∩ 勾选 15 = 实际在跑 10**。
> ⇒ **"加了词"和"词在跑"是两件事**，而界面上看不出差别。这就是删掉这个 key 的理由。

---

## 执行与读回

| 步骤 | 结果 |
|---|---|
| 对齐 archived + 插入（单个 `--file`，一次事务） | `changes: 82` |
| 读回：未下架数 | **22** ✓（= 留 6 + 观察 4 + 重启 4 + 新英文 4 + 小语种 4） |
| 读回：`lang IS NULL` 的行 | **0** ✓ |
| 读回：18 个应归档的 | 全部 `archived=1` ✓ |
| 读回：4 个应启用的 | 全部 `archived=0` ✓ |
| `DELETE FROM settings WHERE key='active_keywords'` | `changes: 1` |
| 读回：该行 | 不存在 ✓ ⇒ `archived` 成为唯一开关 |

⚠️ **复发点仍在**：界面保存「找客户配置」会重新写出 `active_keywords`（和 `search_countries`）。
根治（存"排除集"而非"包含集"）在队列里，⛔ 本单没做。
