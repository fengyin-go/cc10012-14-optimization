import test from 'node:test'
import assert from 'node:assert/strict'

import { SCENARIO_STEPS, applyScenarioStep, buildScenarioThrough } from '../src/domain/anomaly/scenario'
import { createInitialState, markScenarioStep } from '../src/domain/anomaly/engine'
import type { AnomalyDatasetState } from '../src/domain/anomaly/types'

function replayAll(): AnomalyDatasetState {
  let state = createInitialState(SCENARIO_STEPS[0].watermark)
  for (const step of SCENARIO_STEPS) {
    state = markScenarioStep(applyScenarioStep(state, step), step.id, step.watermark)
  }
  return state
}

test('完整时间线可复现：逐步推进与整段播种结果一致', () => {
  const full = replayAll()
  const through = buildScenarioThrough(SCENARIO_STEPS[SCENARIO_STEPS.length - 1].id)
  assert.equal(JSON.stringify(through), JSON.stringify(full))
})

test('ANOM-0003：10:00 前已关闭窗口在周期调整后证据不动', () => {
  const before = buildScenarioThrough('step-05')
  const closedBefore = before.windows
    .filter((window) => window.ruleCode === 'ANOM-0003' && parseBefore10(window.endTs))
    .map((window) => [window.windowId, JSON.stringify(window.evidence), window.archived] as const)
  assert.ok(closedBefore.length > 0)

  const after = buildScenarioThrough('step-06')
  for (const [id, evidence, archived] of closedBefore) {
    const current = after.windows.find((window) => window.windowId === id)!
    assert.equal(JSON.stringify(current.evidence), evidence)
    assert.equal(current.archived, archived)
  }
})

function parseBefore10(ts: string): boolean {
  return ts < '2026-11-16T10:00'
}

test('ANOM-0003：跨日重叠段只生成一套新窗口，通知不重复计数', () => {
  const state = buildScenarioThrough('step-11')
  const tag = 'boundary:2026-11-17'
  const pair = state.windows.filter((window) => window.overlapTag === tag && window.ruleCode === 'ANOM-0003')
  assert.equal(pair.length, 2)
  assert.ok(pair.every((window) => window.evidence.pointCount >= 1))
  const notifications = state.notifications.filter((item) => item.overlapTag === tag)
  assert.equal(notifications.length, 1)
  assert.equal(new Set(notifications.map((item) => item.dedupKey)).size, 1)
})

test('跨规则通知隔离：同一跨日边界下不同规则各自只计一次，去重键互不覆盖', () => {
  const state = replayAll()
  const tag = 'boundary:2026-11-17'
  const for0003 = state.notifications.filter((item) => item.ruleCode === 'ANOM-0003' && item.overlapTag === tag)
  const for0002 = state.notifications.filter((item) => item.ruleCode === 'ANOM-0002' && item.overlapTag === tag)
  assert.equal(for0003.length, 1)
  assert.equal(for0002.length, 1)
  assert.notEqual(for0003[0].dedupKey, for0002[0].dedupKey)
  // 每个规则的去重键在全量通知中只出现一次
  for (const key of [for0003[0].dedupKey, for0002[0].dedupKey]) {
    assert.equal(state.notifications.filter((item) => item.dedupKey === key).length, 1)
  }
})

test('ANOM-0002：冲突记录保留两种做法的完整依据', () => {
  const state = buildScenarioThrough('step-15')
  const conflict = state.conflicts.find((item) => item.ruleCode === 'ANOM-0002')
  assert.ok(conflict)
  assert.equal(conflict.candidates[0].strategy, 'combined-window')
  assert.equal(conflict.candidates[1].strategy, 'segmented-baseline')
  assert.notEqual(conflict.candidates[0].verdict, conflict.candidates[1].verdict)
  assert.ok(conflict.candidates.every((candidate) => candidate.basis.length > 0))
})

test('结果数据集字段与取值：规则版本、偏离倍数随每条记录归档', () => {
  const state = replayAll()
  assert.ok(state.records.length > 0)
  for (const record of state.records) {
    assert.ok(record.datasetId.startsWith('AD|'))
    assert.ok(record.windowId.includes(record.ruleCode))
    assert.equal(typeof record.ruleVersion, 'number')
    assert.equal(typeof record.deviationMultiple, 'number')
    assert.equal(typeof record.baselineMean, 'number')
    assert.ok(['open', 'closed'].includes(record.windowState))
    assert.ok(['normal', 'anomaly', 'pending'].includes(record.verdict))
    assert.equal(record.archived, record.windowState === 'closed')
  }
})

test('补报留痕：命中已关闭窗口的补报不进入窗口证据', () => {
  const state = replayAll()
  const skip = state.backfillSkips.find((item) => item.sampleId === 'S0302')
  assert.ok(skip)
  const window = state.windows.find((item) => item.windowId === skip.windowId)!
  assert.equal(window.archived, true)
  assert.ok(!window.evidence.sampleIds.includes('S0302'))
})

test('重算游标最终清空，且从未登记已关闭窗口', () => {
  const state = replayAll()
  for (const cursor of Object.values(state.cursors)) {
    for (const id of cursor.openWindowIds) {
      const window = state.windows.find((item) => item.windowId === id)!
      assert.equal(window.state, 'open')
    }
  }
})
