/**
 * 异常检测结果数据集存储。
 *
 * 与业务条目存储（local-store.ts）分离，使用独立 localStorage key：
 * - 全量状态是一个对象，任何写操作都是整体覆盖，浏览器单线程下并发重试只会落到同一份依据；
 * - 确定性编号 + 入库采样去重，重复执行 produce 不会产生第二条窗口/结果/通知；
 * - 读不到时返回 null，由场景层决定是否播种，避免把演示数据误当成生产结果。
 */
import { createInitialState } from '@/domain/anomaly/engine'
import type { AnomalyDatasetState, RuleVersion, SamplePoint } from '@/domain/anomaly/types'

export const ANOMALY_DATASET_STORAGE_KEY = 'data-explore-studio:anomaly-dataset'
export const ANOMALY_DATASET_SCHEMA_VERSION = 1

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function readAnomalyDataset(): AnomalyDatasetState | null {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null
  }
  const raw = window.localStorage.getItem(ANOMALY_DATASET_STORAGE_KEY)
  if (!raw) {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as AnomalyDatasetState
    return migrateIfNeeded(parsed)
  } catch {
    // 数据集损坏不允许静默吞掉业务条目，返回 null 并由调用方提示重新播种。
    return null
  }
}

export function writeAnomalyDataset(state: AnomalyDatasetState): AnomalyDatasetState {
  const next = { ...clone(state), schemaVersion: ANOMALY_DATASET_SCHEMA_VERSION }
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(ANOMALY_DATASET_STORAGE_KEY, JSON.stringify(next))
  }
  return next
}

export function clearAnomalyDataset(): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.removeItem(ANOMALY_DATASET_STORAGE_KEY)
  }
}

/**
 * 上线回读迁移：目前只有 v1；后续升版时在这里做字段补齐，
 * 已归档（archived）记录任何迁移都不允许改证据字段。
 */
function migrateIfNeeded(state: AnomalyDatasetState): AnomalyDatasetState {
  const migrated = clone(state)
  if (typeof migrated.schemaVersion !== 'number') {
    migrated.schemaVersion = 1
  }
  migrated.ruleVersions ??= []
  migrated.samples ??= []
  migrated.windows ??= []
  migrated.records ??= []
  migrated.notifications ??= []
  migrated.conflicts ??= []
  migrated.cursors ??= {}
  migrated.backfillSkips ??= []
  migrated.ingestedSampleIds ??= []
  migrated.appliedStepIds ??= []
  migrated.conflictStrategy ??= {}
  return migrated
}

export function emptyDataset(now: string): AnomalyDatasetState {
  return createInitialState(now)
}

export type { AnomalyDatasetState, RuleVersion, SamplePoint }
