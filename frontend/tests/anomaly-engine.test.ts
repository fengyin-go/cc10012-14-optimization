import test from 'node:test'
import assert from 'node:assert/strict'

import {
  changeDetectionPeriod,
  createInitialState,
  evaluateConflictCandidates,
  ingestSamples,
  registerRuleVersion,
  resumeRecalc,
  setConflictStrategy,
} from '../src/domain/anomaly/engine'
import type {
  AnomalyDatasetState,
  RuleVersion,
  SamplePoint,
} from '../src/domain/anomaly/types'
import { parseTs, toTs } from '../src/domain/anomaly/time'

const V1: RuleVersion = {
  ruleCode: 'ANOM-0003',
  version: 1,
  baselineMean: 100,
  stdDev: 10,
  deviationMultiple: 2,
  periodMinutes: 5,
  effectiveFrom: '2026-11-16T09:00',
  effectiveUntil: null,
  changeReason: '初始登记',
  createdAt: '2026-11-16T09:00',
}

function sample(
  sampleId: string,
  ts: string,
  value: number,
  backfill = false,
): SamplePoint {
  return { sampleId, ruleCode: 'ANOM-0003', metric: '订单成功率', ts, value, backfill, ruleVersion: null }
}

function seeded(now = '2026-11-16T09:00'): AnomalyDatasetState {
  return registerRuleVersion(createInitialState(now), V1, now)
}

function windowOf(state: AnomalyDatasetState, startTs: string, period = 5) {
  const window = state.windows.find(
    (item) => item.startTs === startTs && item.periodMinutes === period,
  )
  assert.ok(window, `应存在窗口 ${startTs} / P${period}`)
  return window
}

test('窗口推进：到点关闭并归档，未关闭窗口才会随新采样局部重算', () => {
  let state = seeded()
  state = ingestSamples(state, 'ANOM-0003', [sample('S1', '2026-11-16T09:01', 100)], '2026-11-16T09:02')
  const open = windowOf(state, '2026-11-16T09:00')
  assert.equal(open.state, 'open')
  assert.equal(open.evidence.pointCount, 1)

  // 水位越过窗口结束点 -> 关闭归档
  state = ingestSamples(state, 'ANOM-0003', [sample('S2', '2026-11-16T09:06', 101)], '2026-11-16T09:07')
  const closed = windowOf(state, '2026-11-16T09:00')
  assert.equal(closed.state, 'closed')
  assert.equal(closed.archived, true)
  assert.equal(closed.evidence.pointCount, 1)

  // 已关闭窗口的结果记录存在且为归档态
  const record = state.records.find((item) => item.windowId === closed.windowId)
  assert.ok(record)
  assert.equal(record.archived, true)
  assert.equal(record.ruleVersion, 1)
  assert.equal(record.deviationMultiple, 2)
})

test('补报命中已关闭窗口：只留 backfillSkips，原基线证据与结果记录不被覆盖', () => {
  let state = seeded()
  state = ingestSamples(state, 'ANOM-0003', [sample('S1', '2026-11-16T09:01', 100)], '2026-11-16T09:07')
  const closed = windowOf(state, '2026-11-16T09:00')
  const snapshotEvidence = JSON.stringify(closed.evidence)
  const recordBefore = JSON.stringify(state.records.find((item) => item.windowId === closed.windowId))

  // 规则版本切换 + 补报同时发生
  state = changeDetectionPeriod(
    state,
    { ruleCode: 'ANOM-0003', newPeriodMinutes: 15, reason: '周期调整' },
    { now: '2026-11-16T09:10' },
  )
  state = ingestSamples(
    state,
    'ANOM-0003',
    [sample('S-BF', '2026-11-16T09:02', 999, true)],
    '2026-11-16T09:11',
  )

  const stillClosed = windowOf(state, '2026-11-16T09:00')
  assert.equal(stillClosed.archived, true)
  assert.equal(JSON.stringify(stillClosed.evidence), snapshotEvidence)
  assert.equal(
    JSON.stringify(state.records.find((item) => item.windowId === closed.windowId)),
    recordBefore,
  )
  const skip = state.backfillSkips.find((item) => item.sampleId === 'S-BF')
  assert.ok(skip)
  assert.match(skip.reason, /已关闭窗口/)
})

test('ANOM-0003 5 分钟改 15 分钟：10:00 前窗口不动，旧未关闭窗口截断归档，新周期只重算未关闭窗口', () => {
  let state = seeded()
  // 09:55 窗口有采样且在 10:00 时仍未关闭
  state = ingestSamples(state, 'ANOM-0003', [sample('S1', '2026-11-16T09:56', 98)], '2026-11-16T09:58')
  // 更早的窗口已关闭
  state = ingestSamples(state, 'ANOM-0003', [sample('S2', '2026-11-16T09:31', 97)], '2026-11-16T09:59')

  const beforeClosed = state.windows.filter((window) => window.state === 'closed')
  assert.ok(beforeClosed.length >= 1)
  const closedSnapshots = beforeClosed.map((window) => [window.windowId, JSON.stringify(window.evidence)] as const)

  state = changeDetectionPeriod(
    state,
    { ruleCode: 'ANOM-0003', newPeriodMinutes: 15, reason: 'ANOM-0003 由 5 分钟改 15 分钟' },
    { now: '2026-11-16T10:00' },
  )

  // 规则版本归档
  const versions = state.ruleVersions
  assert.equal(versions.length, 2)
  assert.equal(versions[0].effectiveUntil, '2026-11-16T10:00')
  assert.equal(versions[1].periodMinutes, 15)
  assert.equal(versions[1].version, 2)

  // 10:00 前已关闭窗口证据完全不动
  for (const [id, snapshot] of closedSnapshots) {
    const current = state.windows.find((window) => window.windowId === id)!
    assert.equal(JSON.stringify(current.evidence), snapshot)
    assert.equal(current.archived, true)
  }

  // 旧 09:55 未关闭窗口被截断归档
  const truncated = windowOf(state, '2026-11-16T09:55')
  assert.equal(truncated.state, 'closed')
  assert.equal(truncated.truncated, true)
  assert.equal(truncated.archived, true)

  // 新周期窗口从 10:00 起按 15 分钟网格规划
  const newWindows = state.windows.filter((window) => window.ruleVersion === 2)
  assert.ok(newWindows.some((window) => window.startTs === '2026-11-16T10:00' && window.periodMinutes === 15))

  // 重算游标只登记未关闭窗口
  const cursor = state.cursors['ANOM-0003']
  assert.ok(cursor)
  for (const id of cursor.openWindowIds) {
    const window = state.windows.find((item) => item.windowId === id)!
    assert.equal(window.state, 'open')
  }
  assert.ok(!cursor.openWindowIds.includes(truncated.windowId))
})

test('局部重算只更新当前窗口：重算计数累加，其他窗口与已归档记录不变', () => {
  let state = seeded()
  state = ingestSamples(state, 'ANOM-0003', [sample('S1', '2026-11-16T09:01', 100)], '2026-11-16T09:02')
  state = ingestSamples(state, 'ANOM-0003', [sample('S2', '2026-11-16T09:03', 104)], '2026-11-16T09:04')
  const target = windowOf(state, '2026-11-16T09:00')
  assert.equal(target.evidence.pointCount, 2)
  assert.equal(target.recalcCount, 2)
  assert.equal(target.evidence.actualMean, 102)
})

test('重算中断续做：只续做未关闭窗口，已关闭窗口从重算范围剔除且证据不被覆盖', () => {
  let state = seeded()
  // 先造一个 09:00 已关闭窗口，作为中断残留剔除的样本
  state = ingestSamples(state, 'ANOM-0003', [sample('S0', '2026-11-16T09:01', 99)], '2026-11-16T09:07')
  state = changeDetectionPeriod(
    state,
    { ruleCode: 'ANOM-0003', newPeriodMinutes: 15, reason: '周期调整' },
    { now: '2026-11-16T10:00' },
  )
  // 第一笔采样水位 10:03：10:00 窗口未关闭
  state = ingestSamples(state, 'ANOM-0003', [sample('S1', '2026-11-16T10:02', 100)], '2026-11-16T10:03')
  // 第二笔是未来时刻 10:17 的采样、水位仍在 10:04：10:00 与 10:15 两个窗口同时未关闭
  state = ingestSamples(state, 'ANOM-0003', [sample('S2', '2026-11-16T10:17', 101)], '2026-11-16T10:04')
  const cursorBefore = state.cursors['ANOM-0003']
  assert.ok(cursorBefore.openWindowIds.length >= 2)
  for (const id of cursorBefore.openWindowIds) {
    assert.equal(state.windows.find((item) => item.windowId === id)!.state, 'open')
  }

  // 模拟中断残留：把一个已关闭窗口编号混进游标，续算时必须剔除而不是重开
  const closedWindow = state.windows.find((window) => window.state === 'closed')!
  state.cursors['ANOM-0003'] = {
    ...cursorBefore,
    openWindowIds: [...cursorBefore.openWindowIds, closedWindow.windowId],
  }
  const closedSnapshot = JSON.stringify(closedWindow.evidence)

  // 第一批只做 1 个，模拟中断
  const first = resumeRecalc(state, 'ANOM-0003', { now: '2026-11-16T10:19', batchSize: 1 })
  assert.equal(first.remaining, cursorBefore.openWindowIds.length - 1)
  assert.equal(first.processed.length, 1)
  assert.ok(first.state.cursors['ANOM-0003'])
  // 已关闭窗口没有被重开、证据没有变化
  const stillClosed = first.state.windows.find((window) => window.windowId === closedWindow.windowId)!
  assert.equal(stillClosed.state, 'closed')
  assert.equal(JSON.stringify(stillClosed.evidence), closedSnapshot)
  assert.ok(!first.state.cursors['ANOM-0003'].openWindowIds.includes(closedWindow.windowId))

  // 续做完成
  const second = resumeRecalc(first.state, 'ANOM-0003', { now: '2026-11-16T10:20' })
  assert.equal(second.remaining, 0)
  assert.equal(second.state.cursors['ANOM-0003'], undefined)

  // 已关闭窗口不在任何游标里
  const closedIds = second.state.windows.filter((window) => window.state === 'closed').map((window) => window.windowId)
  for (const id of closedIds) {
    assert.ok(!(second.state.cursors['ANOM-0003']?.openWindowIds ?? []).includes(id))
  }
})

test('并发重试幂等：重复入库同采样与重复推进不产生第二份窗口/结果/通知', () => {
  const state1 = seeded()
  const state2 = ingestSamples(state1, 'ANOM-0003', [sample('S1', '2026-11-16T09:01', 170)], '2026-11-16T09:02')
  const state3 = ingestSamples(state2, 'ANOM-0003', [sample('S1', '2026-11-16T09:01', 170)], '2026-11-16T09:03')

  assert.equal(state3.samples.length, 1)
  assert.equal(state3.windows.length, 1)
  assert.equal(state3.records.length, 1)
  assert.equal(state3.ingestedSampleIds.length, 1)

  // 再跑一遍同样的输入，结果完全一致（只保留一份依据）
  const state4 = ingestSamples(state1, 'ANOM-0003', [sample('S1', '2026-11-16T09:01', 170)], '2026-11-16T09:03')
  assert.deepEqual(
    state4.records.map((record) => record.datasetId).sort(),
    state3.records.map((record) => record.datasetId).sort(),
  )
  assert.equal(state4.notifications.length, state3.notifications.length)
})

test('判定与偏离倍数：均值偏离超过 2 倍标准差判异常并随结果归档', () => {
  let state = seeded()
  state = ingestSamples(state, 'ANOM-0003', [
    sample('S1', '2026-11-16T09:01', 100),
    sample('S2', '2026-11-16T09:02', 170),
  ], '2026-11-16T09:03')
  const window = windowOf(state, '2026-11-16T09:00')
  assert.equal(window.verdict, 'anomaly')
  // |135-100| / (10*2) = 1.75
  assert.equal(window.evidence.deviationRatio, 1.75)
  const record = state.records.find((item) => item.windowId === window.windowId)!
  assert.equal(record.verdict, 'anomaly')
  assert.equal(record.deviationMultiple, 2)
  assert.equal(record.baselineMean, 100)
  assert.equal(state.notifications.length, 1)
})

test('跨日采样：尾段/首段窗口都有实际指标并保留边界依据，重叠时段通知只计一次', () => {
  let state = seeded()
  state = changeDetectionPeriod(
    state,
    { ruleCode: 'ANOM-0003', newPeriodMinutes: 15, reason: '15 分钟周期' },
    { now: '2026-11-16T10:00', strategy: 'combined-window' },
  )
  // 尾段 23:45-00:00
  state = ingestSamples(state, 'ANOM-0003', [sample('S-D1', '2026-11-16T23:56', 150)], '2026-11-16T23:57')
  // 首段 00:00-00:15
  state = ingestSamples(state, 'ANOM-0003', [sample('S-D2', '2026-11-17T00:06', 140)], '2026-11-17T00:08')

  const tail = windowOf(state, '2026-11-16T23:45', 15)
  const head = windowOf(state, '2026-11-17T00:00', 15)
  assert.equal(tail.crossesDayBoundary, true)
  assert.equal(head.crossesDayBoundary, true)
  assert.equal(tail.overlapTag, head.overlapTag)
  assert.ok(tail.boundaryBasis?.includes('跨日尾段'))
  assert.ok(head.boundaryBasis?.includes('跨日首段'))
  assert.equal(tail.evidence.pointCount, 1)
  assert.equal(head.evidence.pointCount, 1)

  // 两段都异常，但跨日组只产生一条通知
  const groupNotifications = state.notifications.filter((item) => item.overlapTag === tail.overlapTag)
  assert.equal(groupNotifications.length, 1)
  // 合并做法归属首段窗口
  assert.equal(groupNotifications[0].windowId, head.windowId)
  assert.equal(groupNotifications[0].dedupKey, `ANOM-0003|${tail.overlapTag}`)

  // 切到分段做法：仍只有一条通知，归属切到尾段，窗口证据不变
  const tailEvidence = JSON.stringify(tail.evidence)
  const headEvidence = JSON.stringify(head.evidence)
  state = setConflictStrategy(state, 'ANOM-0003', 'segmented-baseline', '2026-11-17T00:09')
  assert.equal(
    JSON.stringify(state.windows.find((item) => item.windowId === tail.windowId)!.evidence),
    tailEvidence,
  )
  assert.equal(
    JSON.stringify(state.windows.find((item) => item.windowId === head.windowId)!.evidence),
    headEvidence,
  )
  const after = state.notifications.filter((item) => item.overlapTag === tail.overlapTag)
  assert.equal(after.length, 1)
  assert.equal(after[0].windowId, tail.windowId)
})

test('跨日冲突：两种做法结论不同时保留双候选依据，切换做法只改通知不改证据', () => {
  const ruleCode = 'ANOM-0002'
  const v1: RuleVersion = {
    ruleCode,
    version: 1,
    baselineMean: 100,
    stdDev: 10,
    deviationMultiple: 2,
    periodMinutes: 60,
    effectiveFrom: '2026-11-16T22:00',
    effectiveUntil: null,
    changeReason: '初始',
    createdAt: '2026-11-16T22:00',
  }
  let state = registerRuleVersion(createInitialState('2026-11-16T22:00'), v1, '2026-11-16T22:00')
  const p = (id: string, ts: string, value: number): SamplePoint => ({
    sampleId: id, ruleCode, metric: '接口延迟', ts, value, backfill: false, ruleVersion: null,
  })
  // 尾段 23:00-00:00 均值 112.5 -> 偏离比 0.625 正常
  state = ingestSamples(state, ruleCode, [p('A1', '2026-11-16T23:05', 105), p('A2', '2026-11-16T23:40', 120)], '2026-11-16T23:42')
  state = changeDetectionPeriod(
    state,
    { ruleCode, newPeriodMinutes: 240, reason: '60->240' },
    { now: '2026-11-17T00:00', strategy: 'combined-window' },
  )
  // 首段 00:00-04:00 单点 132 -> 偏离比 1.6 异常；合并均值 (105+120+132)/3=119 -> 0.95 正常
  state = ingestSamples(state, ruleCode, [p('A3', '2026-11-17T00:10', 132)], '2026-11-17T00:12')

  const tag = 'boundary:2026-11-17'
  const evaluation = evaluateConflictCandidates(state, ruleCode, tag)!
  assert.equal(evaluation.combined.verdict, 'normal')
  assert.equal(evaluation.combined.deviationRatio, 0.95)
  assert.equal(evaluation.segmented.verdict, 'anomaly')
  assert.equal(evaluation.segmented.deviationRatio, 1.6)

  const conflict = state.conflicts.find((item) => item.overlapTag === tag)
  assert.ok(conflict, '两种做法结论不一致时必须生成冲突记录并保留双依据')
  assert.equal(conflict.candidates.length, 2)
  assert.equal(conflict.chosen, 'combined-window')
  assert.equal(conflict.windowIds.length, 2)

  // 跨日重叠组始终只有一条通知，不重复计数
  assert.equal(state.notifications.filter((item) => item.overlapTag === tag).length, 1)

  // 切换做法只改通知归属/判定，窗口证据一律不动
  const before = state.windows.map((window) => [window.windowId, JSON.stringify(window.evidence)] as const)
  state = setConflictStrategy(state, ruleCode, 'segmented-baseline', '2026-11-17T00:13')
  for (const [id, evidence] of before) {
    assert.equal(JSON.stringify(state.windows.find((window) => window.windowId === id)!.evidence), evidence)
  }
  assert.equal(state.conflicts.find((item) => item.overlapTag === tag)!.chosen, 'segmented-baseline')
  assert.equal(state.notifications.filter((item) => item.overlapTag === tag).length, 1)
})

test('时间网格：窗口对齐周期、跨日标记在 00:00 两侧成对出现', () => {
  assert.equal(toTs(parseTs('2026-11-16T23:56') - (parseTs('2026-11-16T23:56') % 15)), '2026-11-16T23:45')
  assert.equal(toTs(parseTs('2026-11-17T00:06') - (parseTs('2026-11-17T00:06') % 15)), '2026-11-17T00:00')
})
