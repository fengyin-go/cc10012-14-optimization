import test from 'node:test'
import assert from 'node:assert/strict'

// node 环境无 localStorage：用内存 Map 打桩，验证存储层的单实例与回读行为。
const memory = new Map<string, string>()
const localStorageStub = {
  getItem: (key: string) => (memory.has(key) ? memory.get(key)! : null),
  setItem: (key: string, value: string) => void memory.set(key, value),
  removeItem: (key: string) => void memory.delete(key),
}
;(globalThis as { window?: unknown }).window = { localStorage: localStorageStub }

const {
  ANOMALY_DATASET_STORAGE_KEY,
  readAnomalyDataset,
  writeAnomalyDataset,
  clearAnomalyDataset,
} = await import('../src/data/anomaly-dataset-store')
const { buildScenarioThrough } = await import('../src/domain/anomaly/scenario')
const {
  DATASET_EXPORT_COLUMNS,
  exportAnomalyDatasetCsv,
  exportAnomalyNotificationsCsv,
  getAnomalyOverview,
  listDatasetRecords,
  runNextScenarioStep,
  runResumeRecalc,
  resetAnomalyScenario,
} = await import('../src/api/anomaly-service')

test('数据集单实例：写入后刷新读取逐字段一致，且与业务条目存储隔离', () => {
  clearAnomalyDataset()
  const state = buildScenarioThrough('step-11')
  writeAnomalyDataset(state)

  const raw = memory.get(ANOMALY_DATASET_STORAGE_KEY)
  assert.ok(raw)
  assert.ok(!raw.includes('data-explore-studio:entries'))

  const reread = readAnomalyDataset()!
  assert.equal(JSON.stringify(reread), JSON.stringify(state))
  assert.equal(reread.schemaVersion, 1)
  // 归档记录回读后证据字段不变
  for (const record of reread.records.filter((item) => item.archived)) {
    const current = state.records.find((item) => item.datasetId === record.datasetId)!
    assert.equal(JSON.stringify(record), JSON.stringify(current))
  }
})

test('回放服务幂等：逐步执行与整段播种产出同一份数据集', () => {
  clearAnomalyDataset()
  let guard = 0
  while (getAnomalyOverview().nextStep && guard < 50) {
    const result = runNextScenarioStep()
    assert.equal(result.ok, true)
    guard += 1
  }
  const viaService = readAnomalyDataset()!
  const viaScenario = buildScenarioThrough('step-16')
  assert.equal(JSON.stringify(viaService), JSON.stringify(viaScenario))

  // 再点一次下一步：被拒绝且不产生新数据
  const again = runNextScenarioStep()
  assert.equal(again.ok, false)
  assert.equal(readAnomalyDataset()!.samples.length, viaService.samples.length)
})

test('并发重试只保留一份依据：窗口/结果/通知编号唯一', () => {
  const state = readAnomalyDataset()!
  const unique = <T,>(list: T[], key: (item: T) => string): boolean =>
    new Set(list.map(key)).size === list.length
  assert.ok(unique(state.windows, (item) => item.windowId))
  assert.ok(unique(state.records, (item) => item.datasetId))
  assert.ok(unique(state.notifications, (item) => item.notificationId))
  assert.ok(unique(state.samples, (item) => item.sampleId))
})

test('续算服务：无游标时拒绝重开已关闭窗口', () => {
  // ANOM-9999 从未登记，不存在任何未关闭窗口与游标
  const result = runResumeRecalc('ANOM-9999')
  assert.equal(result.ok, false)
  assert.match(result.message, /已关闭窗口|待续算/)
})

test('导出：结果数据集与通知写出下游 CSV，字段与取值可检查', () => {
  const datasetCsv = exportAnomalyDatasetCsv()
  assert.equal(datasetCsv.filename, '异常检测结果数据集.csv')
  const lines = datasetCsv.content.replace(/^\uFEFF/, '').split('\n')
  assert.equal(lines[0], DATASET_EXPORT_COLUMNS.join(','))
  assert.equal(lines.length - 1, listDatasetRecords().length)
  for (const line of lines.slice(1)) {
    assert.ok(line.startsWith('AD|'))
  }

  const notificationCsv = exportAnomalyNotificationsCsv()
  assert.equal(notificationCsv.filename, '异常预警通知明细.csv')
  assert.ok(notificationCsv.content.includes('NTF|'))
})

test('回读兼容：缺失字段的旧结构被补齐而不是抛错', () => {
  const legacy = JSON.stringify({ schemaVersion: 1, ruleVersions: [], windows: [] })
  memory.set(ANOMALY_DATASET_STORAGE_KEY, legacy)
  const migrated = readAnomalyDataset()!
  assert.deepEqual(migrated.records, [])
  assert.deepEqual(migrated.conflicts, [])
  assert.deepEqual(migrated.backfillSkips, [])
  assert.equal(typeof migrated.conflictStrategy, 'object')
  clearAnomalyDataset()
})
