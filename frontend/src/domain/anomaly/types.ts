/**
 * 异常检测结果数据集领域类型。
 *
 * 设计约束（对应需求条目）：
 * - 窗口分「未关闭 open / 已关闭 closed」，已关闭窗口证据归档（archived），任何重算都不得覆盖；
 * - 规则版本独立归档，结果记录随窗口固化规则版本与偏离倍数；
 * - 跨日边界的尾段/首段窗口共享 overlapTag，预警通知按去重键只计一次；
 * - 全量状态落在一个数据集对象里，持久化只有一份依据，并发重试天然幂等。
 */

/** 窗口状态：未关闭可局部重算，已关闭只保留原基线证据。 */
export type WindowState = 'open' | 'closed'

/** 跨日重叠段的两种可评估做法。 */
export type ConflictStrategy =
  | 'combined-window' // 合并为一套新窗口评估（新周期口径，prefer-new）
  | 'segmented-baseline' // 尾段/首段分段保留原基线证据（prefer-baseline）

/** 采样点。backfill=true 表示补报数据。 */
export type SamplePoint = {
  sampleId: string
  ruleCode: string
  metric: string
  /** 墙面时间标签，分钟精度，格式 YYYY-MM-DDTHH:mm。 */
  ts: string
  value: number
  backfill: boolean
  /** 入库时命中的规则版本，补报也按采样时刻归档，不允许事后改判。 */
  ruleVersion: number | null
}

/** 规则版本快照。周期调整即切版本，老版本保留 effectiveUntil 作为历史依据。 */
export type RuleVersion = {
  ruleCode: string
  version: number
  baselineMean: number
  stdDev: number
  /** 偏离倍数（标准差倍数），随版本与结果一起归档。 */
  deviationMultiple: number
  periodMinutes: number
  effectiveFrom: string
  effectiveUntil: string | null
  changeReason: string
  createdAt: string
}

/** 窗口证据：只汇总落入本窗口的采样点，局部重算也只动这一份。 */
export type WindowEvidence = {
  sampleIds: string[]
  pointCount: number
  actualMean: number
  actualMax: number
  actualMin: number
  /** |实际均值-基线| / (偏离倍数*标准差)，>=1 即异常；无法计算时为 null。 */
  deviationRatio: number | null
  backfillOnly: boolean
}

/** 检测窗口。 */
export type DetectionWindow = {
  windowId: string
  ruleCode: string
  ruleVersion: number
  periodMinutes: number
  startTs: string
  endTs: string
  state: WindowState
  /** 窗口是否贴着跨日边界（尾段收口或首段起算）。 */
  crossesDayBoundary: boolean
  /** 同一跨日边界的尾段/首段窗口共享此标记。 */
  overlapTag: string | null
  /** 边界依据：说明尾段/首段各自承载了哪些实际指标。 */
  boundaryBasis: string | null
  evidence: WindowEvidence
  verdict: 'normal' | 'anomaly' | 'pending'
  /** 归档基线：窗口关闭时冻结的规则口径，重算不得修改。 */
  baselineMean: number
  stdDev: number
  deviationMultiple: number
  /** 已关闭窗口的证据归档标记，true 时引擎拒绝任何证据改写。 */
  archived: boolean
  /** 周期切换时被截断的未关闭窗口，截断证据冻结归档。 */
  truncated: boolean
  recalcCount: number
  updatedAt: string
}

/** 跨日冲突判定记录：两种做法的结论都留依据，最终只选一种驱动通知。 */
export type ConflictRecord = {
  conflictId: string
  overlapTag: string
  ruleCode: string
  /** 参与边界组的窗口编号（尾段在前、首段在后）。 */
  windowIds: string[]
  candidates: {
    strategy: ConflictStrategy
    verdict: 'normal' | 'anomaly'
    deviationRatio: number | null
    basis: string
  }[]
  chosen: ConflictStrategy
  basis: string
  ts: string
}

/** 异常检测结果数据集的一条记录：一个窗口对应一条，按 windowId upsert。 */
export type AnomalyDatasetRecord = {
  datasetId: string
  ruleCode: string
  windowId: string
  windowStart: string
  windowEnd: string
  windowState: WindowState
  ruleVersion: number
  baselineMean: number
  stdDev: number
  deviationMultiple: number
  actualMean: number
  actualMax: number
  actualMin: number
  deviationRatio: number | null
  verdict: 'normal' | 'anomaly' | 'pending'
  pointCount: number
  crossesDayBoundary: boolean
  overlapTag: string | null
  conflictId: string | null
  notificationId: string | null
  archived: boolean
  recalcCount: number
  computedAt: string
}

/** 预警通知：跨日重叠组共用一个去重键，保证不重复计数。 */
export type AnomalyNotification = {
  notificationId: string
  dedupKey: string
  ruleCode: string
  windowId: string
  datasetId: string
  level: string
  overlapTag: string | null
  status: '待发送' | '已发送' | '已抑制'
  basis: string
  createdAt: string
}

/** 重算游标：中断后续做只认未关闭窗口，已关闭窗口直接剔除。 */
export type RecalcCursor = {
  ruleCode: string
  openWindowIds: string[]
  doneWindowIds: string[]
  updatedAt: string
}

/** 补报落到已关闭窗口时的留痕，证明历史证据未被覆盖。 */
export type BackfillSkip = {
  sampleId: string
  windowId: string
  reason: string
  ts: string
}

/** 异常检测结果数据集（全量、单实例）。 */
export type AnomalyDatasetState = {
  /** 数据集结构版本，供上线后回读兼容与迁移判断。 */
  schemaVersion: number
  ruleVersions: RuleVersion[]
  samples: SamplePoint[]
  windows: DetectionWindow[]
  records: AnomalyDatasetRecord[]
  notifications: AnomalyNotification[]
  conflicts: ConflictRecord[]
  cursors: Record<string, RecalcCursor>
  backfillSkips: BackfillSkip[]
  /** 已入库采样点编号，重试时直接跳过，保证只写一份结果。 */
  ingestedSampleIds: string[]
  /** 已应用的验收时间线步骤编号，刷新后仍能判断回放进度（不参与检测计算）。 */
  appliedStepIds: string[]
  /** 每条规则当前采用的跨日冲突判定做法。 */
  conflictStrategy: Record<string, ConflictStrategy>
  updatedAt: string
}

/** 引擎入参：显式水位时间，保证过程可复现、可测试。 */
export type EngineOptions = {
  now: string
  strategy?: ConflictStrategy
  reason?: string
  /** 续算批量大小，模拟中断时传 1。 */
  batchSize?: number
}
