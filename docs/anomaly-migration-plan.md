# 异常检测窗口推进与局部重算 — 迁移计划

## 1. 背景与改动范围

原有异常检测在每个采样点重复扫描已关闭窗口，检测周期调整后会重算全部历史异常证据，
存在三类风险：

1. 已关闭窗口的原基线证据被新结果覆盖，历史预警通知无法回溯；
2. 重算中断后续做会重开已关闭窗口，历史通知被覆盖；
3. 并发重试可能写出多份互相矛盾的检测结果。

本次改动把检测逻辑从页面组件下沉到纯函数领域引擎，并新增**唯一一份**
「异常检测结果数据集」（下称结果数据集）。涉及文件：

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 领域引擎 | `src/domain/anomaly/types.ts` | 结果数据集、窗口、规则版本、冲突、通知类型 |
| 领域引擎 | `src/domain/anomaly/time.ts` | 周期网格、跨日边界标记、确定性编号 |
| 领域引擎 | `src/domain/anomaly/engine.ts` | 窗口推进、周期切换、局部重算、冲突评估、通知去重 |
| 验收场景 | `src/domain/anomaly/scenario.ts` | 16 步可复现验收时间线（ANOM-0003 / ANOM-0002） |
| 数据存储 | `src/data/anomaly-dataset-store.ts` | 结果数据集单实例持久化与回读迁移 |
| 应用服务 | `src/api/anomaly-service.ts` | 页面调用链、CSV 导出、续算、做法切换 |
| 页面 | `src/views/anomaly/index.vue` | 时间线回放、窗口/数据集/通知/冲突/核对区 |
| 种子数据 | `src/data/seed.ts` | 异常规则字段改为可计算数值 |

## 2. 数据库依赖

本仓库为纯前端离线版，没有后端数据库；持久化依赖浏览器 `localStorage`。

| 存储键 | 内容 | 兼容性处理 |
| --- | --- | --- |
| `data-explore-studio:entries` | 既有业务条目（含异常检测规则） | 结构不变，保持原读写路径 |
| `data-explore-studio:anomaly-dataset` | 新增：异常检测结果数据集（单实例） | 独立键，与业务条目隔离，互不覆盖 |

迁移到带后端的全栈版本时，对应关系建议如下（当前代码不落地，仅约定契约）：

- 结果数据集整体对象映射为 `anomaly_detection_dataset` 主表 + 窗口/记录/通知/冲突子表，
  主键直接使用引擎生成的确定性编号（`windowId`、`datasetId=AD|...`、`notificationId=NTF|...`、`conflictId=CFL|...`），
  保证重试 upsert 幂等，只保留一份依据；
- `ingestedSampleIds` 对应采样入库唯一约束，重复采样直接拒绝；
- `ruleVersions` 为只追加表，`effectiveUntil` 一经写入不再修改；
- 已关闭窗口（`archived=true`）的证据列在数据库层面拒绝 UPDATE，仅允许 INSERT 审计留痕；
- 上线前需要一次性数据盘点：确认旧系统没有把已关闭窗口证据反复重算的存量结果，
  存量窗口按关闭时点的规则版本回填 `ruleVersion / baselineMean / deviationMultiple`。

回滚方案：结果数据集使用独立存储键，回滚前端版本不影响业务条目；
如需回滚，删除 `data-explore-studio:anomaly-dataset` 即可，业务规则列表不受影响。

## 3. 构建环境

- 运行时要求：Node.js >= 20（与 `frontend/Dockerfile` 的 `node:20-alpine` 一致）；
- 无新增第三方依赖：测试通过项目已有的 `esbuild` 打包，使用 Node 内置 `node:test` 执行；
- 新增脚本：`npm test`（见 `package.json`），CI 中按 `typecheck -> test -> build` 顺序执行；
- 构建产物验证：`npm run build` 成功，异常检测页 chunk 独立打包（`dist/assets/anomaly-*.js`）；
- Docker 镜像无需修改，`npm install` 会自动带上 esbuild（已在 devDependencies 间接存在）。

发布步骤：

1. 合并代码后在 CI 执行 `npm run typecheck && npm test && npm run build`，23 个用例必须全部通过；
2. 静态资源发布后，旧浏览器里没有新存储键，页面首次回放时自动播种，不需要手工迁移；
3. 灰度期间若发现结果数据集结构异常，存储层读取失败会返回 `null`，页面提示重新回放，
   不会污染业务条目数据。

## 4. 上线后的结果数据集回读

- 结果数据集带 `schemaVersion`（当前为 1），`readAnomalyDataset()` 内置 `migrateIfNeeded`：
  缺失字段按空集合补齐，**已归档记录的证据字段任何迁移都不允许改写**；
- 刷新页面后，页面通过 `getAnomalyOverview()` 从同一存储键回读，窗口状态、历史证据、
  重算游标、冲突依据、通知去重键逐字段恢复；
- 回读核对清单（页面「核对区」可直接检查）：
  - 窗口状态：`open/closed` 与 `archived/truncated` 标记；
  - 历史证据：已关闭窗口 `evidence` 与结果数据集记录字段一致且不再变化；
  - 重算范围：游标 `openWindowIds` 中不包含任何已关闭窗口；
  - 字段取值：每条结果记录都带 `ruleVersion`、`baselineMean`、`deviationMultiple`；
  - 通知去重：同一 `overlapTag` 只有一条非抑制通知；
  - 导出回读：「导出结果数据集 / 导出预警通知」CSV 表头与页面明细列完全一致。

## 5. 关键不变量与验收对照

| 需求条目 | 实现位置 | 对应用例 |
| --- | --- | --- |
| 不按采样点回扫已关闭窗口 | `engine.ingestSamples` 增量推进 + 归档拒绝 | 用例 1、2 |
| 周期调整只局部重算未关闭窗口 | `changeDetectionPeriod` 截断归档 + 游标 | 用例 3 |
| 重算中断只续做未关闭窗口 | `resumeRecalc` 剔除已关闭窗口 | 用例 5 |
| 并发重试只保留一份依据 | 确定性编号 + `ingestedSampleIds` 去重 | 用例 6、20 |
| 刷新后可回看 | 独立存储键 + schema 迁移 | 用例 18、23 |
| 跨日尾段/首段保留边界依据 | `boundaryTag` / `overlapTag` | 用例 8、13 |
| 重叠时段通知不重复计数 | 通知 `dedupKey` 去重 + 抑制记录 | 用例 8 |
| 两种冲突做法都可评估、依据保留 | `evaluateConflictCandidates` + `ConflictRecord` | 用例 9、14 |
| 规则与偏离倍数随结果归档 | `AnomalyDatasetRecord` 固化版本字段 | 用例 7、15 |
| 导出入口与业务列表明细一致、写出下游文件 | `anomaly-service` 两个 CSV 导出 | 用例 22 |
| ANOM-0003 5→15 分钟，10:00 前窗口不动 | 验收时间线 step-01 ~ step-06 | 用例 3、12 |
| 跨日重叠段只生成一套新窗口 | step-10 / step-11 跨日组 | 用例 13 |
