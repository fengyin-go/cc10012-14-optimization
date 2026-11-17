<template>
  <section class="page" data-module="anomaly">
    <header class="page-head">
      <div>
        <h2>异常检测管理</h2>
        <p class="page-desc">维护异常检测规则与检测窗口推进，结果按窗口归档为唯一一份异常检测结果数据集，刷新后可回读核对。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记检测规则</button>
        <button class="btn" type="button" @click="exportRows">导出异常检测清单</button>
        <button class="btn" type="button" @click="exportDataset">导出结果数据集</button>
        <button class="btn" type="button" @click="exportNotifications">导出预警通知</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <section class="panel">
      <h3 class="panel-title">验收时间线（窗口推进 / 周期调整 / 局部重算）</h3>
      <p class="panel-tip">
        每步只推进当前水位：已关闭窗口不回扫；周期调整只局部重算未关闭窗口；重复点击为幂等重试，数据集只保留一份依据。
      </p>
      <div class="panel-actions">
        <button class="btn primary" type="button" :disabled="!overview.nextStep" @click="runNext">
          {{ overview.nextStep ? `回放下一步：${overview.nextStep.title}` : '时间线已走完' }}
        </button>
        <button class="btn" type="button" @click="runResume">续算未关闭窗口</button>
        <button class="btn ghost" type="button" @click="resetScenario">重置结果数据集</button>
      </div>
      <ol class="step-list">
        <li v-for="step in overview.steps" :key="step.id" class="step-item" :class="{ done: step.applied }">
          <span class="step-flag">{{ step.applied ? '✓' : '·' }}</span>
          <span class="step-id">{{ step.id }}</span>
          <span>{{ step.title }}</span>
        </li>
      </ol>
    </section>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无异常检测数据，可先登记检测规则</td>
        </tr>
      </tbody>
    </table>

    <section class="panel">
      <h3 class="panel-title">检测窗口（窗口状态 / 历史证据 / 重算范围可核对）</h3>
      <table class="data-table compact">
        <thead>
          <tr>
            <th>窗口编号</th>
            <th>规则</th>
            <th>版本</th>
            <th>周期(分)</th>
            <th>窗口区间</th>
            <th>状态</th>
            <th>采样数</th>
            <th>实际均值</th>
            <th>偏离比</th>
            <th>判定</th>
            <th>重算次数</th>
            <th>截断/归档</th>
            <th>跨日边界依据</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="window in windows" :key="window.windowId">
            <td class="mono">{{ shortId(window.windowId) }}</td>
            <td>{{ window.ruleCode }}</td>
            <td>v{{ window.ruleVersion }}</td>
            <td>{{ window.periodMinutes }}</td>
            <td class="mono">{{ window.startTs }} ~ {{ window.endTs }}</td>
            <td><span class="badge" :class="window.state">{{ stateLabel(window.state) }}</span></td>
            <td>{{ window.evidence.pointCount }}</td>
            <td>{{ window.evidence.actualMean }}</td>
            <td>{{ window.evidence.deviationRatio ?? '—' }}</td>
            <td><span class="badge" :class="verdictClass(window.verdict)">{{ verdictLabel(window.verdict) }}</span></td>
            <td>{{ window.recalcCount }}</td>
            <td>{{ window.truncated ? '截断' : '' }}{{ window.archived ? '已归档' : '' }}</td>
            <td class="basis-cell">{{ window.boundaryBasis ?? '—' }}</td>
          </tr>
          <tr v-if="!windows.length">
            <td colspan="13" class="empty-state">尚未生成检测窗口，请先回放验收时间线</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="panel">
      <h3 class="panel-title">异常检测结果数据集（异常明细读取检测窗口形成，规则与偏离倍数随结果归档）</h3>
      <table class="data-table compact">
        <thead>
          <tr>
            <th>数据集编号</th>
            <th>规则</th>
            <th>窗口区间</th>
            <th>窗口状态</th>
            <th>规则版本</th>
            <th>基线均值</th>
            <th>标准差</th>
            <th>偏离倍数</th>
            <th>实际均值</th>
            <th>偏离比</th>
            <th>判定</th>
            <th>跨日</th>
            <th>冲突/通知</th>
            <th>归档</th>
            <th>重算次数</th>
            <th>计算时间</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="record in records" :key="record.datasetId">
            <td class="mono">{{ shortId(record.datasetId) }}</td>
            <td>{{ record.ruleCode }}</td>
            <td class="mono">{{ record.windowStart }} ~ {{ record.windowEnd }}</td>
            <td><span class="badge" :class="record.windowState">{{ stateLabel(record.windowState) }}</span></td>
            <td>v{{ record.ruleVersion }}</td>
            <td>{{ record.baselineMean }}</td>
            <td>{{ record.stdDev }}</td>
            <td>{{ record.deviationMultiple }}</td>
            <td>{{ record.actualMean }}</td>
            <td>{{ record.deviationRatio ?? '—' }}</td>
            <td><span class="badge" :class="verdictClass(record.verdict)">{{ verdictLabel(record.verdict) }}</span></td>
            <td>{{ record.crossesDayBoundary ? record.overlapTag : '—' }}</td>
            <td class="basis-cell">{{ record.conflictId ?? '—' }}<br />{{ record.notificationId ?? '—' }}</td>
            <td>{{ record.archived ? '是' : '否' }}</td>
            <td>{{ record.recalcCount }}</td>
            <td class="mono">{{ record.computedAt }}</td>
          </tr>
          <tr v-if="!records.length">
            <td colspan="16" class="empty-state">结果数据集为空，窗口推进后在此生成并持久化</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="panel">
      <h3 class="panel-title">预警通知（跨日重叠时段按去重键只计一次）</h3>
      <table class="data-table compact">
        <thead>
          <tr>
            <th>通知编号</th>
            <th>去重键</th>
            <th>规则</th>
            <th>归属窗口</th>
            <th>跨日组</th>
            <th>状态</th>
            <th>通知依据</th>
            <th>生成时间</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="notification in notifications" :key="notification.notificationId">
            <td class="mono">{{ shortId(notification.notificationId) }}</td>
            <td class="mono">{{ shortId(notification.dedupKey) }}</td>
            <td>{{ notification.ruleCode }}</td>
            <td class="mono">{{ shortId(notification.windowId) }}</td>
            <td>{{ notification.overlapTag ?? '—' }}</td>
            <td><span class="badge" :class="notification.status === '已抑制' ? 'suppressed' : 'open'">{{ notification.status }}</span></td>
            <td class="basis-cell">{{ notification.basis }}</td>
            <td class="mono">{{ notification.createdAt }}</td>
          </tr>
          <tr v-if="!notifications.length">
            <td colspan="8" class="empty-state">暂无预警通知</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="panel">
      <h3 class="panel-title">跨日冲突判定（两种做法都可评估，依据保留）</h3>
      <table class="data-table compact">
        <thead>
          <tr>
            <th>冲突编号</th>
            <th>跨日组</th>
            <th>规则</th>
            <th>合并窗口结论</th>
            <th>分段基线结论</th>
            <th>当前采用</th>
            <th>判定依据</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="conflict in conflicts" :key="conflict.conflictId">
            <td class="mono">{{ shortId(conflict.conflictId) }}</td>
            <td>{{ conflict.overlapTag }}</td>
            <td>{{ conflict.ruleCode }}</td>
            <td>
              <span class="badge" :class="verdictClass(conflict.candidates[0].verdict)">{{ verdictLabel(conflict.candidates[0].verdict) }}</span>
              ratio={{ conflict.candidates[0].deviationRatio ?? '—' }}
            </td>
            <td>
              <span class="badge" :class="verdictClass(conflict.candidates[1].verdict)">{{ verdictLabel(conflict.candidates[1].verdict) }}</span>
              ratio={{ conflict.candidates[1].deviationRatio ?? '—' }}
            </td>
            <td>{{ conflict.chosen === 'combined-window' ? '合并为一套新窗口' : '分段保留原基线' }}</td>
            <td class="basis-cell">
              <div>合并：{{ conflict.candidates[0].basis }}</div>
              <div>分段：{{ conflict.candidates[1].basis }}</div>
              <div>{{ conflict.basis }}</div>
            </td>
            <td class="row-actions">
              <button class="link" type="button" @click="switchStrategy(conflict.ruleCode, 'combined-window')">采用合并</button>
              <button class="link" type="button" @click="switchStrategy(conflict.ruleCode, 'segmented-baseline')">采用分段</button>
            </td>
          </tr>
          <tr v-if="!conflicts.length">
            <td colspan="8" class="empty-state">暂无跨日冲突（两种做法结论一致时不产生冲突记录）</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="panel">
      <h3 class="panel-title">核对区：规则版本 / 重算游标 / 补报留痕</h3>
      <div class="check-grid">
        <div>
          <h4>规则版本归档</h4>
          <table class="data-table compact">
            <thead>
              <tr><th>规则</th><th>版本</th><th>周期</th><th>基线</th><th>偏离倍数</th><th>生效区间</th><th>变更原因</th></tr>
            </thead>
            <tbody>
              <tr v-for="version in versions" :key="`${version.ruleCode}-${version.version}`">
                <td>{{ version.ruleCode }}</td>
                <td>v{{ version.version }}</td>
                <td>{{ version.periodMinutes }}分钟</td>
                <td>{{ version.baselineMean }}</td>
                <td>{{ version.deviationMultiple }}</td>
                <td class="mono">{{ version.effectiveFrom }} ~ {{ version.effectiveUntil ?? '至今' }}</td>
                <td class="basis-cell">{{ version.changeReason }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div>
          <h4>重算游标（只登记未关闭窗口）</h4>
          <table class="data-table compact">
            <thead><tr><th>规则</th><th>待重算窗口</th><th>已完成</th><th>更新时间</th></tr></thead>
            <tbody>
              <tr v-for="cursor in cursors" :key="cursor.ruleCode">
                <td>{{ cursor.ruleCode }}</td>
                <td class="basis-cell">{{ cursor.openWindowIds.map(shortId).join('、') || '—' }}</td>
                <td>{{ cursor.doneWindowIds.length }}</td>
                <td class="mono">{{ cursor.updatedAt }}</td>
              </tr>
              <tr v-if="!cursors.length"><td colspan="4" class="empty-state">无遗留游标</td></tr>
            </tbody>
          </table>
        </div>
        <div>
          <h4>补报命中留痕（历史证据未覆盖）</h4>
          <table class="data-table compact">
            <thead><tr><th>采样点</th><th>窗口</th><th>原因</th><th>时间</th></tr></thead>
            <tbody>
              <tr v-for="item in backfillSkips" :key="`${item.sampleId}-${item.ts}`">
                <td>{{ item.sampleId }}</td>
                <td class="mono">{{ item.windowId === '—' ? '—' : shortId(item.windowId) }}</td>
                <td class="basis-cell">{{ item.reason }}</td>
                <td class="mono">{{ item.ts }}</td>
              </tr>
              <tr v-if="!backfillSkips.length"><td colspan="4" class="empty-state">无补报跳过记录</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条异常检测规则，结果数据集 {{ records.length }} 条记录（localStorage 持久化，刷新可回看）</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  exportAnomalyDatasetCsv,
  exportAnomalyNotificationsCsv,
  getAnomalyOverview,
  listDatasetRecords,
  listDetectionWindows,
  listNotifications,
  resetAnomalyScenario,
  runNextScenarioStep,
  runResumeRecalc,
  updateConflictStrategy,
  type AnomalyOverview,
} from '@/api/anomaly-service'
import type {
  AnomalyDatasetRecord,
  AnomalyNotification,
  BackfillSkip,
  ConflictRecord,
  DetectionWindow,
  RecalcCursor,
  RuleVersion,
} from '@/domain/anomaly/types'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('anomaly')
const columns = ['规则编号', '监控指标', '基线均值', '标准差倍数', '检测周期', '告警级别', '静默窗口分钟', '通知渠道']
const actions = ['提交校验', '启用检测', '停用检测']
const statuses = ['草稿', '待校验', '已启用', '已停用']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const overview = ref<AnomalyOverview>({ state: null, steps: [], nextStep: null })
const windows = ref<DetectionWindow[]>([])
const records = ref<AnomalyDatasetRecord[]>([])
const notifications = ref<AnomalyNotification[]>([])
const conflicts = ref<ConflictRecord[]>([])
const versions = ref<RuleVersion[]>([])
const cursors = ref<RecalcCursor[]>([])
const backfillSkips = ref<BackfillSkip[]>([])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const stats = computed(() => {
  const state = overview.value.state
  return [
    { label: '检测窗口总数', value: windows.value.length },
    { label: '已关闭归档窗口', value: windows.value.filter((item) => item.state === 'closed').length },
    { label: '结果数据集记录', value: records.value.length },
    { label: '预警通知(含抑制)', value: notifications.value.length },
    { label: '跨日冲突', value: conflicts.value.length },
    { label: '补报留痕', value: state?.backfillSkips.length ?? 0 },
  ]
})

function shortId(id: string): string {
  const parts = id.split('|')
  return parts.length > 1 ? parts.slice(1).join('|') : id
}

function stateLabel(state: string): string {
  return state === 'closed' ? '已关闭' : state === 'open' ? '未关闭' : state
}

function verdictLabel(verdict: string): string {
  if (verdict === 'anomaly') {
    return '异常'
  }
  if (verdict === 'normal') {
    return '正常'
  }
  return '待采样'
}

function verdictClass(verdict: string): string {
  if (verdict === 'anomaly') {
    return 'anomaly'
  }
  if (verdict === 'normal') {
    return 'normal'
  }
  return 'pending-badge'
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function exportDataset() {
  downloadCsv(exportAnomalyDatasetCsv())
}

function exportNotifications() {
  downloadCsv(exportAnomalyNotificationsCsv())
}

function downloadCsv(payload: { filename: string; content: string }): void {
  const blob = new Blob([payload.content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = payload.filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

function openCreate() {
  errorMessage.value = '检测规则登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function runNext() {
  const result = runNextScenarioStep()
  errorMessage.value = result.ok ? '' : result.message
  reload()
}

function runResume() {
  const result = runResumeRecalc('ANOM-0003')
  errorMessage.value = result.ok ? '' : result.message
  reload()
}

function resetScenario() {
  resetAnomalyScenario()
  errorMessage.value = ''
  reload()
}

function switchStrategy(ruleCode: string, strategy: 'combined-window' | 'segmented-baseline') {
  const result = updateConflictStrategy(ruleCode, strategy)
  errorMessage.value = result.ok ? '' : result.message
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total

    overview.value = getAnomalyOverview()
    windows.value = listDetectionWindows()
    records.value = listDatasetRecords()
    notifications.value = listNotifications()
    conflicts.value = overview.value.state?.conflicts ?? []
    versions.value = overview.value.state?.ruleVersions ?? []
    cursors.value = Object.values(overview.value.state?.cursors ?? {})
    backfillSkips.value = overview.value.state?.backfillSkips ?? []
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '异常检测列表读取失败'
  }
}

onMounted(reload)
</script>
