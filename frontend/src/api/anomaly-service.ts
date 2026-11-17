/**
 * 异常检测应用服务：页面只调这里，内部串联业务规则（local-store）与
 * 异常检测结果数据集（anomaly-dataset-store + domain 引擎）。
 *
 * 所有写操作都是「读当前数据集 -> 纯函数引擎 -> 整体写回单实例」，
 * 浏览器单线程 + 确定性编号保证并发重试只保留一份结果依据。
 */
import { listRows, saveRows } from '@/data/local-store'
import {
  clearAnomalyDataset,
  readAnomalyDataset,
  writeAnomalyDataset,
} from '@/data/anomaly-dataset-store'
import {
  changeDetectionPeriod,
  createInitialState,
  markScenarioStep,
  resumeRecalc,
  setConflictStrategy,
} from '@/domain/anomaly/engine'
import {
  applyScenarioStep,
  SCENARIO_STEPS,
  type ScenarioStep,
} from '@/domain/anomaly/scenario'
import type {
  AnomalyDatasetRecord,
  AnomalyDatasetState,
  AnomalyNotification,
  ConflictStrategy,
  DetectionWindow,
  RuleVersion,
  SamplePoint,
} from '@/domain/anomaly/types'
import { parseTs } from '@/domain/anomaly/time'

export type AnomalyOverview = {
  state: AnomalyDatasetState | null
  steps: { id: string; title: string; applied: boolean }[]
  /** 下一条待回放步骤，null 表示整条验收时间线已走完。 */
  nextStep: ScenarioStep | null
}

export function getAnomalyOverview(): AnomalyOverview {
  const state = readAnomalyDataset()
  const applied = new Set(state?.appliedStepIds ?? [])
  const steps = SCENARIO_STEPS.map((step) => ({ id: step.id, title: step.title, applied: applied.has(step.id) }))
  const nextStep = SCENARIO_STEPS.find((step) => !applied.has(step.id)) ?? null
  return { state, steps, nextStep }
}

/** 回放到验收时间线的下一步；重复点击不会产生重复数据（引擎幂等 + 采样去重）。 */
export function runNextScenarioStep(): { ok: boolean; message: string; step?: ScenarioStep } {
  const overview = getAnomalyOverview()
  const step = overview.nextStep
  if (!step) {
    return { ok: false, message: '验收时间线已全部执行完，可重置后重新回放' }
  }
  const base = overview.state ?? createInitialState(step.watermark)
  const next = markScenarioStep(applyScenarioStep(base, step), step.id, step.watermark)
  writeAnomalyDataset(next)
  return { ok: true, message: `已执行：${step.title}`, step }
}

export function resetAnomalyScenario(): void {
  clearAnomalyDataset()
}

/** 重算中断续做：只处理游标中的未关闭窗口。 */
export function runResumeRecalc(ruleCode: string, batchSize?: number): {
  ok: boolean
  message: string
  remaining: number
} {
  const state = readAnomalyDataset()
  if (!state) {
    return { ok: false, message: '异常检测结果数据集尚未生成，请先回放验收时间线', remaining: 0 }
  }
  if (!state.cursors[ruleCode]) {
    return { ok: false, message: '没有待续算的未关闭窗口（已关闭窗口不参与重算）', remaining: 0 }
  }
  const now = state.cursors[ruleCode].updatedAt
  const result = resumeRecalc(state, ruleCode, { now, batchSize })
  writeAnomalyDataset(result.state)
  return {
    ok: true,
    message:
      result.remaining === 0
        ? '未关闭窗口已全部局部重算完成，重算游标清空'
        : `已续算 ${result.processed.length} 个窗口，还剩 ${result.remaining} 个未关闭窗口`,
    remaining: result.remaining,
  }
}

export function updateConflictStrategy(ruleCode: string, strategy: ConflictStrategy): ActionLike {
  const state = readAnomalyDataset()
  if (!state) {
    return { ok: false, message: '异常检测结果数据集尚未生成' }
  }
  const now = state.updatedAt
  writeAnomalyDataset(setConflictStrategy(state, ruleCode, strategy, now))
  return { ok: true, message: `规则 ${ruleCode} 跨日冲突做法已切换为 ${strategy}，窗口证据不变，仅重判通知归属` }
}

type ActionLike = { ok: boolean; message: string }

/**
 * 检测周期调整入口（沿业务规则列表的动作链路）。
 * 同步更新业务规则行的「检测周期」字段，再驱动引擎版本切换与局部重算。
 */
export function adjustDetectionPeriod(input: {
  ruleCode: string
  newPeriodMinutes: number
  reason: string
  now: string
}): ActionLike {
  const rows = listRows('anomaly')
  const index = rows.findIndex((row) => String(row['规则编号']) === input.ruleCode)
  if (index < 0) {
    return { ok: false, message: `业务规则列表中没有 ${input.ruleCode}` }
  }
  const state = readAnomalyDataset()
  if (!state) {
    return { ok: false, message: '异常检测结果数据集尚未生成，请先登记规则版本并回放采样' }
  }
  const next = changeDetectionPeriod(state, {
    ruleCode: input.ruleCode,
    newPeriodMinutes: input.newPeriodMinutes,
    reason: input.reason,
  }, { now: input.now })

  const updatedRows = [...rows]
  updatedRows[index] = {
    ...rows[index],
    检测周期: `${input.newPeriodMinutes}分钟`,
  }
  saveRows('anomaly', updatedRows)
  writeAnomalyDataset(next)
  return { ok: true, message: `${input.ruleCode} 检测周期已调整为 ${input.newPeriodMinutes} 分钟，仅未关闭窗口参与局部重算` }
}

// --- 数据集读取（异常明细读检测窗口后形成结果数据集） ---

export function listDatasetRecords(ruleCode?: string): AnomalyDatasetRecord[] {
  const state = readAnomalyDataset()
  if (!state) {
    return []
  }
  const records = ruleCode ? state.records.filter((record) => record.ruleCode === ruleCode) : state.records
  return [...records].sort((a, b) => parseTs(a.windowStart) - parseTs(b.windowStart))
}

export function listDetectionWindows(ruleCode?: string): DetectionWindow[] {
  const state = readAnomalyDataset()
  if (!state) {
    return []
  }
  const windows = ruleCode ? state.windows.filter((window) => window.ruleCode === ruleCode) : state.windows
  return [...windows].sort((a, b) => parseTs(a.startTs) - parseTs(b.startTs))
}

export function listNotifications(): AnomalyNotification[] {
  const state = readAnomalyDataset()
  if (!state) {
    return []
  }
  return [...state.notifications].sort((a, b) => parseTs(a.createdAt) - parseTs(b.createdAt))
}

export function listRuleVersions(ruleCode?: string): RuleVersion[] {
  const state = readAnomalyDataset()
  if (!state) {
    return []
  }
  return ruleCode ? state.ruleVersions.filter((version) => version.ruleCode === ruleCode) : state.ruleVersions
}

export function listSamples(ruleCode?: string): SamplePoint[] {
  const state = readAnomalyDataset()
  if (!state) {
    return []
  }
  return ruleCode ? state.samples.filter((sample) => sample.ruleCode === ruleCode) : state.samples
}

// --- 导出：异常检测结果数据集写出下游文件（CSV），入口与业务列表明细一致 ---

export const DATASET_EXPORT_COLUMNS = [
  'datasetId',
  'ruleCode',
  'windowId',
  'windowStart',
  'windowEnd',
  'windowState',
  'ruleVersion',
  'baselineMean',
  'stdDev',
  'deviationMultiple',
  'actualMean',
  'actualMax',
  'actualMin',
  'deviationRatio',
  'verdict',
  'pointCount',
  'crossesDayBoundary',
  'overlapTag',
  'conflictId',
  'notificationId',
  'archived',
  'recalcCount',
  'computedAt',
] as const

export function exportAnomalyDatasetCsv(): { filename: string; content: string } {
  const records = listDatasetRecords()
  const header = [...DATASET_EXPORT_COLUMNS]
  const lines = [header.join(',')]
  for (const record of records) {
    lines.push(header.map((column) => csvCell(record[column])).join(','))
  }
  return { filename: '异常检测结果数据集.csv', content: `\uFEFF${lines.join('\n')}` }
}

export const NOTIFICATION_EXPORT_COLUMNS = [
  'notificationId',
  'dedupKey',
  'ruleCode',
  'windowId',
  'datasetId',
  'level',
  'overlapTag',
  'status',
  'basis',
  'createdAt',
] as const

export function exportAnomalyNotificationsCsv(): { filename: string; content: string } {
  const notifications = listNotifications()
  const header = [...NOTIFICATION_EXPORT_COLUMNS]
  const lines = [header.join(',')]
  for (const notification of notifications) {
    lines.push(header.map((column) => csvCell(notification[column])).join(','))
  }
  return { filename: '异常预警通知明细.csv', content: `\uFEFF${lines.join('\n')}` }
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) {
    return ''
  }
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}
