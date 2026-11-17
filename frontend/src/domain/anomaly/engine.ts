/**
 * 异常检测窗口引擎（纯函数，不碰 localStorage，不依赖 DOM）。
 *
 * 关键不变量：
 * 1. 窗口推进只处理「当前水位之后」的增量采样，绝不按采样点回头扫描已关闭窗口；
 * 2. 已关闭窗口 archived=true，证据字段冻结，补报命中只留 backfillSkips，不覆盖原基线证据；
 * 3. 检测周期调整 = 规则版本切换：旧未关闭窗口截断归档，只按新周期局部重算未关闭窗口，
 *    重算游标只登记未关闭窗口，中断后续做时已关闭窗口自动剔除；
 * 4. 所有编号由业务键确定性生成，并发/重试产出同号对象，结果数据集始终只有一份依据；
 * 5. 跨日尾段/首段窗口共享 overlapTag：边界依据双窗口保留，通知按去重键只计一次，
 *    两种冲突做法都保留候选结论。
 */
import type {
  AnomalyDatasetRecord,
  AnomalyDatasetState,
  AnomalyNotification,
  BackfillSkip,
  ConflictRecord,
  ConflictStrategy,
  DetectionWindow,
  EngineOptions,
  RuleVersion,
  SamplePoint,
  WindowEvidence,
} from './types'
import {
  boundaryTag,
  buildConflictId,
  buildDatasetId,
  buildNotificationId,
  buildWindowId,
  dayStart,
  parseTs,
  toTs,
  windowBounds,
} from './time'

const DEFAULT_STRATEGY: ConflictStrategy = 'combined-window'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function createInitialState(now: string): AnomalyDatasetState {
  return {
    schemaVersion: 1,
    ruleVersions: [],
    samples: [],
    windows: [],
    records: [],
    notifications: [],
    conflicts: [],
    cursors: {},
    backfillSkips: [],
    ingestedSampleIds: [],
    appliedStepIds: [],
    conflictStrategy: {},
    updatedAt: now,
  }
}

function ruleVersionsOf(state: AnomalyDatasetState, ruleCode: string): RuleVersion[] {
  return state.ruleVersions
    .filter((version) => version.ruleCode === ruleCode)
    .sort((a, b) => a.version - b.version)
}

/** 采样时刻生效的规则版本：按生效区间归档，事后不可改判。 */
export function ruleVersionAt(state: AnomalyDatasetState, ruleCode: string, ts: string): RuleVersion | null {
  const point = parseTs(ts)
  const hit = ruleVersionsOf(state, ruleCode).find((version) => {
    const from = parseTs(version.effectiveFrom)
    const until = version.effectiveUntil === null ? null : parseTs(version.effectiveUntil)
    return point >= from && (until === null || point < until)
  })
  return hit ?? null
}

function currentVersion(state: AnomalyDatasetState, ruleCode: string): RuleVersion | null {
  const open = ruleVersionsOf(state, ruleCode).filter((version) => version.effectiveUntil === null)
  return open.length ? open[open.length - 1] : null
}

function findWindow(state: AnomalyDatasetState, windowId: string): DetectionWindow | undefined {
  return state.windows.find((window) => window.windowId === windowId)
}

function windowsOf(state: AnomalyDatasetState, ruleCode: string): DetectionWindow[] {
  return state.windows
    .filter((window) => window.ruleCode === ruleCode)
    .sort((a, b) => parseTs(a.startTs) - parseTs(b.startTs))
}

/**
 * 局部重算：只读取入参窗口覆盖区间内的采样点，不扫描全量历史。
 * 已关闭（归档）窗口直接拒绝，返回 false，由调用方留痕。
 */
function recomputeEvidence(
  state: AnomalyDatasetState,
  window: DetectionWindow,
  now: string,
): boolean {
  if (window.archived || window.state === 'closed') {
    return false
  }
  const start = parseTs(window.startTs)
  const end = parseTs(window.endTs)
  const points = state.samples.filter((sample) => {
    if (sample.ruleCode !== window.ruleCode) {
      return false
    }
    const point = parseTs(sample.ts)
    return point >= start && point < end
  })
  window.evidence = summarize(points, window, now)
  window.verdict = judge(window)
  window.recalcCount += 1
  window.updatedAt = now
  return true
}

function summarize(points: SamplePoint[], window: DetectionWindow, now: string): WindowEvidence {
  const values = points.map((point) => point.value)
  const pointCount = values.length
  const actualMean = pointCount ? values.reduce((sum, value) => sum + value, 0) / pointCount : 0
  const denominator = window.stdDev * window.deviationMultiple
  return {
    sampleIds: points.map((point) => point.sampleId),
    pointCount,
    actualMean: round(actualMean),
    actualMax: pointCount ? Math.max(...values) : 0,
    actualMin: pointCount ? Math.min(...values) : 0,
    deviationRatio: denominator > 0 && pointCount ? round(Math.abs(actualMean - window.baselineMean) / denominator) : null,
    backfillOnly: pointCount > 0 && points.every((point) => point.backfill),
  }
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000
}

function judge(window: DetectionWindow): 'normal' | 'anomaly' | 'pending' {
  if (window.evidence.pointCount === 0) {
    return 'pending'
  }
  return window.evidence.deviationRatio !== null && window.evidence.deviationRatio >= 1
    ? 'anomaly'
    : 'normal'
}

function emptyEvidence(now: string): WindowEvidence {
  return {
    sampleIds: [],
    pointCount: 0,
    actualMean: 0,
    actualMax: 0,
    actualMin: 0,
    deviationRatio: null,
    backfillOnly: false,
  }
}

function decorateBoundary(window: DetectionWindow): void {
  const start = parseTs(window.startTs)
  const end = parseTs(window.endTs)
  const tag = boundaryTag(start, end)
  if (!tag) {
    window.crossesDayBoundary = false
    window.overlapTag = null
    window.boundaryBasis = null
    return
  }
  window.crossesDayBoundary = true
  window.overlapTag = tag.tag
  const isTail = end === dayStart(end)
  window.boundaryBasis = isTail
    ? `跨日尾段窗口：收口于 ${tag.day} 00:00（旧周期末段），窗口内实际指标全部留痕，首段窗口按同一 overlapTag=${tag.tag} 关联`
    : `跨日首段窗口：起算于 ${tag.day} 00:00（新周期首段），窗口内实际指标全部留痕，尾段窗口按同一 overlapTag=${tag.tag} 关联`
}

function buildWindow(version: RuleVersion, startMinutes: number, now: string): DetectionWindow {
  const endMinutes = startMinutes + version.periodMinutes
  const window: DetectionWindow = {
    windowId: buildWindowId(version.ruleCode, startMinutes, version.periodMinutes),
    ruleCode: version.ruleCode,
    ruleVersion: version.version,
    periodMinutes: version.periodMinutes,
    startTs: toTs(startMinutes),
    endTs: toTs(endMinutes),
    state: 'open',
    crossesDayBoundary: false,
    overlapTag: null,
    boundaryBasis: null,
    evidence: emptyEvidence(now),
    verdict: 'pending',
    baselineMean: version.baselineMean,
    stdDev: version.stdDev,
    deviationMultiple: version.deviationMultiple,
    archived: false,
    truncated: false,
    recalcCount: 0,
    updatedAt: now,
  }
  decorateBoundary(window)
  return window
}

/**
 * 窗口推进 + 采样入库。
 * - 新采样按所属规则版本的周期定位窗口，命中未关闭窗口才做局部重算；
 * - 命中已关闭窗口（含补报）只记 backfillSkips，历史证据不动；
 * - 水位推进只关闭到点窗口，不回扫任何历史窗口。
 */
export function ingestSamples(
  input: AnomalyDatasetState,
  ruleCode: string,
  incoming: SamplePoint[],
  now: string,
): AnomalyDatasetState {
  const state = clone(input)
  state.updatedAt = now
  const watermark = parseTs(now)

  for (const raw of [...incoming].sort((a, b) => parseTs(a.ts) - parseTs(b.ts))) {
    if (state.ingestedSampleIds.includes(raw.sampleId)) {
      // 并发重试：同编号采样直接幂等跳过，结果数据集不会被写第二份。
      continue
    }
    const version = ruleVersionAt(state, ruleCode, raw.ts)
    const sample: SamplePoint = { ...raw, ruleCode, ruleVersion: version ? version.version : null }
    state.samples.push(sample)
    state.ingestedSampleIds.push(sample.sampleId)

    if (!version) {
      state.backfillSkips.push(skip(sample, null, '采样时刻没有生效中的规则版本，未挂检测窗口', now))
      continue
    }

    const point = parseTs(sample.ts)
    const [start, end] = windowBounds(point, version.periodMinutes)
    const windowId = buildWindowId(ruleCode, start, version.periodMinutes)
    const existing = findWindow(state, windowId)

    if (existing) {
      if (existing.archived || existing.state === 'closed') {
        state.backfillSkips.push(
          skip(sample, existing.windowId, '命中已关闭窗口，原基线证据归档保留，禁止重算覆盖', now),
        )
        continue
      }
      recomputeEvidence(state, existing, now)
      continue
    }

    const window = buildWindow(version, start, now)
    state.windows.push(window)
    recomputeEvidence(state, window, now)
    // 补报新建的历史窗口在本轮水位下直接收口归档，证据按当时版本基线一次性冻结。
    if (end <= watermark) {
      closeWindow(window, now)
    }
  }

  // 增量推进：只检查到点的未关闭窗口，已关闭窗口不参与任何扫描。
  for (const window of windowsOf(state, ruleCode)) {
    if (window.state === 'open' && parseTs(window.endTs) <= watermark) {
      closeWindow(window, now)
    }
  }

  refreshCursor(state, ruleCode, now)
  syncOutputs(state, ruleCode, now)
  return state
}

function closeWindow(window: DetectionWindow, now: string): void {
  window.state = 'closed'
  window.archived = true
  window.updatedAt = now
}

function skip(sample: SamplePoint, windowId: string | null, reason: string, now: string): BackfillSkip {
  return { sampleId: sample.sampleId, windowId: windowId ?? '—', reason, ts: now }
}

export type PeriodChangeInput = {
  ruleCode: string
  newPeriodMinutes: number
  reason: string
  baselineMean?: number
  stdDev?: number
  deviationMultiple?: number
}

/**
 * 检测周期调整（规则版本切换）。
 * 旧版本打 effectiveUntil；旧未关闭窗口截断归档、证据冻结；
 * 按新周期从生效时刻规划新窗口并只对未关闭窗口建立重算游标；
 * 已关闭窗口（含与补报同时到达的场景）一律不动。
 */
export function changeDetectionPeriod(
  input: AnomalyDatasetState,
  change: PeriodChangeInput,
  options: EngineOptions,
): AnomalyDatasetState {
  const state = clone(input)
  const now = options.now
  state.updatedAt = now
  const previous = currentVersion(state, change.ruleCode)
  if (!previous) {
    throw new Error(`规则 ${change.ruleCode} 尚未登记初始版本，无法调整检测周期`)
  }

  previous.effectiveUntil = now
  const nextVersion: RuleVersion = {
    ruleCode: change.ruleCode,
    version: previous.version + 1,
    baselineMean: change.baselineMean ?? previous.baselineMean,
    stdDev: change.stdDev ?? previous.stdDev,
    deviationMultiple: change.deviationMultiple ?? previous.deviationMultiple,
    periodMinutes: change.newPeriodMinutes,
    effectiveFrom: now,
    effectiveUntil: null,
    changeReason: change.reason,
    createdAt: now,
  }
  state.ruleVersions.push(nextVersion)
  if (options.strategy) {
    state.conflictStrategy[change.ruleCode] = options.strategy
  }

  // 旧周期未关闭窗口：截断并冻结，不进入重算范围。
  for (const window of windowsOf(state, change.ruleCode)) {
    if (window.state === 'open' && window.ruleVersion === previous.version) {
      window.truncated = true
      closeWindow(window, now)
      window.boundaryBasis =
        (window.boundaryBasis ? `${window.boundaryBasis}；` : '') +
        `检测周期于 ${now} 由 ${previous.periodMinutes} 分钟调整为 ${change.newPeriodMinutes} 分钟，未关闭窗口截断归档，截断证据保持原基线`
    }
  }

  planNewPeriodWindows(state, nextVersion, now)
  refreshCursor(state, change.ruleCode, now)
  syncOutputs(state, change.ruleCode, now)
  return state
}

/** 新周期窗口规划：覆盖生效时刻到最新采样时刻，跨日首段窗口在此打上边界标记。 */
function planNewPeriodWindows(state: AnomalyDatasetState, version: RuleVersion, now: string): void {
  const watermark = parseTs(now)
  const latestSample = state.samples
    .filter((sample) => sample.ruleCode === version.ruleCode && parseTs(sample.ts) >= watermark)
    .map((sample) => parseTs(sample.ts))
    .reduce((max, point) => Math.max(max, point), watermark)

  let cursor = watermark - (watermark % version.periodMinutes)
  const horizon = latestSample + version.periodMinutes
  while (cursor < horizon) {
    const windowId = buildWindowId(version.ruleCode, cursor, version.periodMinutes)
    if (!findWindow(state, windowId)) {
      const window = buildWindow(version, cursor, now)
      state.windows.push(window)
      recomputeEvidence(state, window, now)
      if (parseTs(window.endTs) <= watermark) {
        closeWindow(window, now)
      }
    }
    cursor += version.periodMinutes
  }
}

/** 重算游标只保留未关闭窗口；调用时机：入库、周期切换后续做。 */
function refreshCursor(state: AnomalyDatasetState, ruleCode: string, now: string): void {
  const openIds = windowsOf(state, ruleCode)
    .filter((window) => window.state === 'open')
    .map((window) => window.windowId)
  if (openIds.length === 0) {
    delete state.cursors[ruleCode]
    return
  }
  const previous = state.cursors[ruleCode]
  state.cursors[ruleCode] = {
    ruleCode,
    openWindowIds: openIds,
    doneWindowIds: previous ? previous.doneWindowIds.filter((id) => openIds.includes(id)) : [],
    updatedAt: now,
  }
}

/**
 * 中断续算：只续做未关闭窗口。游标中若有窗口已关闭（周期切换/水位收口），
 * 直接剔除，绝不重开已归档证据。batchSize 模拟中断，默认一次做完。
 */
export function resumeRecalc(
  input: AnomalyDatasetState,
  ruleCode: string,
  options: EngineOptions,
): { state: AnomalyDatasetState; remaining: number; processed: string[] } {
  const state = clone(input)
  const now = options.now
  const cursor = state.cursors[ruleCode]
  if (!cursor) {
    return { state, remaining: 0, processed: [] }
  }

  // 已关闭窗口从重算范围剔除，保证历史通知与证据不被新结果覆盖。
  const eligible = cursor.openWindowIds
    .map((id) => findWindow(state, id))
    .filter((window): window is DetectionWindow => window !== undefined && window.state === 'open')

  const batchSize = options.batchSize ?? eligible.length
  const processed: string[] = []
  for (const window of eligible.slice(0, Math.max(batchSize, 0))) {
    recomputeEvidence(state, window, now)
    processed.push(window.windowId)
  }

  const remainingOpen = eligible.slice(processed.length).map((window) => window.windowId)
  const done = [...new Set([...cursor.doneWindowIds, ...processed])]
  if (remainingOpen.length === 0) {
    delete state.cursors[ruleCode]
  } else {
    state.cursors[ruleCode] = {
      ruleCode,
      openWindowIds: remainingOpen,
      doneWindowIds: done,
      updatedAt: now,
    }
  }
  syncOutputs(state, ruleCode, now)
  state.updatedAt = now
  return { state, remaining: remainingOpen.length, processed }
}

// ---------------------------------------------------------------------------
// 结果数据集 / 跨日冲突 / 预警通知同步
// ---------------------------------------------------------------------------

/** 只 upsert 未归档窗口对应记录；窗口关闭瞬间允许一次状态落账，之后记录冻结。 */
function syncOutputs(state: AnomalyDatasetState, ruleCode: string, now: string): void {
  for (const window of windowsOf(state, ruleCode)) {
    const existing = state.records.find((record) => record.windowId === window.windowId)
    if (window.archived && existing && existing.windowState === 'closed') {
      // 已关闭且已落账：历史证据冻结，任何重算都不得再改这条记录。
      continue
    }
    upsertRecord(state, window, now)
  }
  evaluateBoundaryGroups(state, ruleCode, now)
  syncNotifications(state, ruleCode, now)
}

function upsertRecord(state: AnomalyDatasetState, window: DetectionWindow, now: string): void {
  const record: AnomalyDatasetRecord = {
    datasetId: buildDatasetId(window.windowId),
    ruleCode: window.ruleCode,
    windowId: window.windowId,
    windowStart: window.startTs,
    windowEnd: window.endTs,
    windowState: window.state,
    ruleVersion: window.ruleVersion,
    baselineMean: window.baselineMean,
    stdDev: window.stdDev,
    deviationMultiple: window.deviationMultiple,
    actualMean: window.evidence.actualMean,
    actualMax: window.evidence.actualMax,
    actualMin: window.evidence.actualMin,
    deviationRatio: window.evidence.deviationRatio,
    verdict: window.verdict,
    pointCount: window.evidence.pointCount,
    crossesDayBoundary: window.crossesDayBoundary,
    overlapTag: window.overlapTag,
    conflictId: null,
    notificationId: null,
    archived: window.archived,
    recalcCount: window.recalcCount,
    computedAt: now,
  }
  const index = state.records.findIndex((item) => item.datasetId === record.datasetId)
  if (index >= 0) {
    // 保留既有冲突/通知链路字段，证据字段随未关闭窗口的局部重算更新。
    record.conflictId = state.records[index].conflictId
    record.notificationId = state.records[index].notificationId
    state.records[index] = record
  } else {
    state.records.push(record)
  }
}

type Candidate = ConflictRecord['candidates'][number]

/** 两种做法的无副作用评估，供页面/测试对照查看。 */
export function evaluateConflictCandidates(
  state: AnomalyDatasetState,
  ruleCode: string,
  overlapTag: string,
): { windows: DetectionWindow[]; combined: Candidate; segmented: Candidate } | null {
  const group = windowsOf(state, ruleCode).filter((window) => window.overlapTag === overlapTag)
  if (group.length < 2) {
    return null
  }
  const newestVersion = Math.max(...group.map((window) => window.ruleVersion))
  const head = group.find((window) => parseTs(window.startTs) === dayStart(parseTs(window.startTs)))!
  const headVersion = state.ruleVersions.find(
    (version) => version.ruleCode === ruleCode && version.version === head.ruleVersion,
  )!

  // 做法一 combined-window：合并为一套新窗口，按新周期版本口径统一评估。
  const allPoints = state.samples.filter((sample) =>
    group.some((window) => {
      const start = parseTs(window.startTs)
      const end = parseTs(window.endTs)
      const point = parseTs(sample.ts)
      return sample.ruleCode === ruleCode && point >= start && point < end
    }),
  )
  const denominator = headVersion.stdDev * headVersion.deviationMultiple
  const combinedMean = allPoints.length
    ? allPoints.reduce((sum, sample) => sum + sample.value, 0) / allPoints.length
    : 0
  const combinedRatio = denominator > 0 && allPoints.length
    ? round(Math.abs(combinedMean - headVersion.baselineMean) / denominator)
    : null
  const combined: Candidate = {
    strategy: 'combined-window',
    verdict: combinedRatio !== null && combinedRatio >= 1 ? 'anomaly' : 'normal',
    deviationRatio: combinedRatio,
    basis: `合并跨日尾段/首段共 ${allPoints.length} 个实际指标，按规则版本 v${newestVersion} 新周期基线 ${headVersion.baselineMean} 统一评估，合并均值 ${round(combinedMean)}`,
  }

  // 做法二 segmented-baseline：两段窗口各自保留原基线证据，任一异常即组异常。
  const segments = group.map((window) => ({
    windowId: window.windowId,
    ruleVersion: window.ruleVersion,
    verdict: window.verdict,
    deviationRatio: window.evidence.deviationRatio,
    baselineMean: window.baselineMean,
  }))
  const segmented: Candidate = {
    strategy: 'segmented-baseline',
    verdict: segments.some((segment) => segment.verdict === 'anomaly') ? 'anomaly' : 'normal',
    deviationRatio: segments.find((segment) => segment.verdict === 'anomaly')?.deviationRatio ?? null,
    basis: `尾段/首段分段保留原基线证据：${segments
      .map((segment) => `${segment.windowId.split('|')[1]}(v${segment.ruleVersion},${segment.verdict},ratio=${segment.deviationRatio ?? '—'})`)
      .join(' / ')}`,
  }

  return { windows: group, combined, segmented }
}

function evaluateBoundaryGroups(state: AnomalyDatasetState, ruleCode: string, now: string): void {
  const tags = [...new Set(
    windowsOf(state, ruleCode)
      .map((window) => window.overlapTag)
      .filter((tag): tag is string => tag !== null),
  )]
  const strategy = state.conflictStrategy[ruleCode] ?? DEFAULT_STRATEGY

  for (const tag of tags) {
    const evaluation = evaluateConflictCandidates(state, ruleCode, tag)
    if (!evaluation) {
      continue
    }
    const { windows, combined, segmented } = evaluation
    const chosen = strategy
    const conflictId = buildConflictId(tag, ruleCode)
    const differ = combined.verdict !== segmented.verdict

    if (differ) {
      const record: ConflictRecord = {
        conflictId,
        overlapTag: tag,
        ruleCode,
        windowIds: windows.map((window) => window.windowId),
        candidates: [combined, segmented],
        chosen,
        basis: `两种做法结论不一致，保留双份依据；当前采用 ${chosen}，切换做法只改通知归属，不改窗口证据`,
        ts: now,
      }
      const index = state.conflicts.findIndex((item) => item.conflictId === conflictId)
      if (index >= 0) {
        state.conflicts[index] = record
      } else {
        state.conflicts.push(record)
      }
    }

    // 链路字段只挂到未归档记录；归档窗口的关联由冲突记录本身承载。
    for (const window of windows) {
      if (window.archived) {
        continue
      }
      const record = state.records.find((item) => item.windowId === window.windowId)
      if (record && differ) {
        record.conflictId = conflictId
      }
    }
  }
}

/** 切换跨日冲突做法：只重判通知归属，窗口证据与已归档数据集记录不动。 */
export function setConflictStrategy(
  input: AnomalyDatasetState,
  ruleCode: string,
  strategy: ConflictStrategy,
  now: string,
): AnomalyDatasetState {
  const state = clone(input)
  state.conflictStrategy[ruleCode] = strategy
  evaluateBoundaryGroups(state, ruleCode, now)
  syncNotifications(state, ruleCode, now)
  state.updatedAt = now
  return state
}

function syncNotifications(state: AnomalyDatasetState, ruleCode: string, now: string): void {
  const strategy = state.conflictStrategy[ruleCode] ?? DEFAULT_STRATEGY
  const groups = new Map<string, DetectionWindow[]>()
  const standalone: DetectionWindow[] = []

  for (const window of windowsOf(state, ruleCode)) {
    if (window.verdict !== 'anomaly') {
      continue
    }
    if (window.overlapTag) {
      const list = groups.get(window.overlapTag) ?? []
      list.push(window)
      groups.set(window.overlapTag, list)
    } else {
      standalone.push(window)
    }
  }

  const representatives: DetectionWindow[] = [...standalone]
  for (const [tag, group] of groups) {
    const sorted = [...group].sort((a, b) => parseTs(a.startTs) - parseTs(b.startTs))
    if (strategy === 'segmented-baseline') {
      // 分段做法：通知归属旧周期尾段（原基线证据所在窗口）。
      representatives.push(sorted[0])
    } else {
      // 合并做法：通知归属新周期首段窗口，跨日重叠段只生成一套新窗口通知。
      representatives.push(sorted[sorted.length - 1])
    }
    // 组内其余异常窗口抑制，重叠时段不重复计数。
    for (const window of sorted) {
      if (window === representatives[representatives.length - 1]) {
        continue
      }
      suppressNotification(state, window, tag, now)
    }
  }

  for (const window of representatives) {
    emitNotification(state, window, now)
  }
}

function emitNotification(state: AnomalyDatasetState, window: DetectionWindow, now: string): void {
  const dedupKey = notificationDedupKey(window)
  const notificationId = buildNotificationId(dedupKey)
  const datasetId = buildDatasetId(window.windowId)
  const existing = state.notifications.find(
    (item) => item.dedupKey === dedupKey && item.ruleCode === window.ruleCode,
  )
  if (existing) {
    // 重算后仍异常：保留已发送状态，不重复发通知；归属窗口可能随做法切换调整。
    existing.windowId = window.windowId
    existing.datasetId = datasetId
    existing.basis = notificationBasis(window)
    return
  }
  state.notifications.push({
    notificationId,
    dedupKey,
    ruleCode: window.ruleCode,
    windowId: window.windowId,
    datasetId,
    level: `P${window.ruleVersion}`,
    overlapTag: window.overlapTag,
    status: '待发送',
    basis: notificationBasis(window),
    createdAt: now,
  })
  const record = state.records.find((item) => item.datasetId === datasetId)
  if (record) {
    record.notificationId = notificationId
  }
}

function suppressNotification(
  state: AnomalyDatasetState,
  window: DetectionWindow,
  tag: string,
  now: string,
): void {
  const dedupKey = `${window.ruleCode}|${tag}`
  const notificationId = buildNotificationId(dedupKey)
  const existing = state.notifications.find((item) => item.notificationId === notificationId)
  if (existing && existing.windowId === window.windowId) {
    return
  }
  if (!state.notifications.some((item) => item.notificationId === notificationId)) {
    state.notifications.push({
      notificationId,
      dedupKey,
      ruleCode: window.ruleCode,
      windowId: window.windowId,
      datasetId: buildDatasetId(window.windowId),
      level: `P${window.ruleVersion}`,
      overlapTag: tag,
      status: '已抑制',
      basis: `跨日重叠组 ${tag} 内只保留一条通知，本窗口证据保留但不重复计数`,
      createdAt: now,
    })
  }
}

/**
 * 通知去重键：跨日组按「规则 + overlapTag」隔离，不同规则同一跨日边界各自只计一次；
 * 普通窗口直接用窗口编号。预警通知据此保证重叠时段不重复计数。
 */
function notificationDedupKey(window: DetectionWindow): string {
  return window.overlapTag ? `${window.ruleCode}|${window.overlapTag}` : window.windowId
}

function notificationBasis(window: DetectionWindow): string {
  const ratio = window.evidence.deviationRatio ?? '—'
  const overlap = window.overlapTag ? `，跨日组 ${window.overlapTag} 去重后唯一通知` : ''
  return `规则版本 v${window.ruleVersion}，偏离倍数 ${window.deviationMultiple}，窗口均值 ${window.evidence.actualMean}，偏离比 ${ratio}${overlap}`
}

/** 登记规则版本（场景播种/后续接入审批流时使用）。 */
export function registerRuleVersion(
  input: AnomalyDatasetState,
  version: RuleVersion,
  now: string,
): AnomalyDatasetState {
  const state = clone(input)
  if (ruleVersionsOf(state, version.ruleCode).some((item) => item.version === version.version)) {
    return state
  }
  state.ruleVersions.push({ ...version, createdAt: now })
  state.updatedAt = now
  return state
}

/** 标记验收时间线步骤已应用；重复标记幂等，只影响回放进度不影响检测证据。 */
export function markScenarioStep(input: AnomalyDatasetState, stepId: string, now: string): AnomalyDatasetState {
  if (input.appliedStepIds.includes(stepId)) {
    return input
  }
  const state = clone(input)
  state.appliedStepIds.push(stepId)
  state.updatedAt = now
  return state
}

export { toTs, parseTs }
