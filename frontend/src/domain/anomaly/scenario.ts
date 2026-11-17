/**
 * 异常检测验收场景（演示 + 测试夹具）。
 *
 * 场景时间线全部使用固定墙面时间，过程可复现：
 * - ANOM-0003：检测周期 5 分钟 -> 15 分钟，切换点 2026-11-16T10:00；
 *   10:00 前窗口关闭归档，补报命中已关闭窗口只留痕不覆盖；
 *   跨日 23:55 尾段与 00:05 首段共享 overlapTag，通知只计一次。
 * - ANOM-0002：周期在跨日 00:00 由 60 分钟切 240 分钟，
 *   combined-window 与 segmented-baseline 两种做法结论冲突，冲突记录保留双依据。
 */
import {
  changeDetectionPeriod,
  createInitialState,
  ingestSamples,
  markScenarioStep,
  registerRuleVersion,
  resumeRecalc,
  setConflictStrategy,
} from './engine'
import type {
  AnomalyDatasetState,
  ConflictStrategy,
  RuleVersion,
  SamplePoint,
} from './types'

export type ScenarioStepKind =
  | 'register'
  | 'ingest'
  | 'period-change'
  | 'resume'
  | 'strategy'

export type ScenarioStep = {
  id: string
  title: string
  kind: ScenarioStepKind
  ruleCode: string
  /** register 步骤可一次登记多条规则的初始版本。 */
  ruleCodes?: string[]
  watermark: string
  samples?: SamplePoint[]
  newPeriodMinutes?: number
  reason?: string
  strategy?: ConflictStrategy
  batchSize?: number
}

const point = (
  sampleId: string,
  ruleCode: string,
  metric: string,
  ts: string,
  value: number,
  backfill = false,
): SamplePoint => ({ sampleId, ruleCode, metric, ts, value, backfill, ruleVersion: null })

// --- ANOM-0003：v1 基线 100，标准差 10，偏离倍数 2 -> 阈值带 [80,120]，周期 5 分钟 ---
const ANOM0003_V1: RuleVersion = {
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

// --- ANOM-0002：v1 基线 100，标准差 10，偏离倍数 2，周期 60 分钟（跨日冲突演示） ---
const ANOM0002_V1: RuleVersion = {
  ruleCode: 'ANOM-0002',
  version: 1,
  baselineMean: 100,
  stdDev: 10,
  deviationMultiple: 2,
  periodMinutes: 60,
  effectiveFrom: '2026-11-16T22:00',
  effectiveUntil: null,
  changeReason: '初始登记',
  createdAt: '2026-11-16T22:00',
}

export const SCENARIO_STEPS: ScenarioStep[] = [
  {
    id: 'step-01',
    title: '登记 ANOM-0003 / ANOM-0002 规则版本（v1）',
    kind: 'register',
    ruleCode: 'ANOM-0003',
    ruleCodes: ['ANOM-0003', 'ANOM-0002'],
    watermark: '2026-11-16T09:00',
  },
  // ---- ANOM-0003：5 分钟周期，10:00 前窗口全部关闭归档 ----
  {
    id: 'step-02',
    title: 'ANOM-0003 09:55 采样：正常点 98，09:55 窗口保持未关闭',
    kind: 'ingest',
    ruleCode: 'ANOM-0003',
    watermark: '2026-11-16T09:58',
    samples: [point('S0301', 'ANOM-0003', '订单成功率', '2026-11-16T09:55', 98)],
  },
  {
    id: 'step-03',
    title: 'ANOM-0003 09:56 补报 09:51 正常点：先建立 09:50 窗口，水位到 09:56 后该窗口关闭归档',
    kind: 'ingest',
    ruleCode: 'ANOM-0003',
    watermark: '2026-11-16T09:56',
    samples: [point('S0300', 'ANOM-0003', '订单成功率', '2026-11-16T09:51', 101, true)],
  },
  {
    id: 'step-04',
    title: 'ANOM-0003 09:58 补报命中已关闭 09:50 窗口：只留痕，证据不动',
    kind: 'ingest',
    ruleCode: 'ANOM-0003',
    watermark: '2026-11-16T09:59',
    samples: [point('S0302', 'ANOM-0003', '订单成功率', '2026-11-16T09:52', 200, true)],
  },
  {
    id: 'step-05',
    title: 'ANOM-0003 采样 170：09:55 窗口均值偏离阈值，判定异常并预警',
    kind: 'ingest',
    ruleCode: 'ANOM-0003',
    watermark: '2026-11-16T09:59',
    samples: [point('S0303', 'ANOM-0003', '订单成功率', '2026-11-16T09:57', 170)],
  },
  {
    id: 'step-06',
    title: 'ANOM-0003 周期调整：5 分钟改 15 分钟，旧未关闭窗口截断归档，只重算未关闭窗口',
    kind: 'period-change',
    ruleCode: 'ANOM-0003',
    watermark: '2026-11-16T10:00',
    newPeriodMinutes: 15,
    reason: 'ANOM-0003 检测周期由 5 分钟调整为 15 分钟',
    strategy: 'combined-window',
  },
  {
    id: 'step-07',
    title: 'ANOM-0003 10:17 补报命中未关闭 10:15 窗口：局部重算（不扫历史）',
    kind: 'ingest',
    ruleCode: 'ANOM-0003',
    watermark: '2026-11-16T10:18',
    samples: [point('S0304', 'ANOM-0003', '订单成功率', '2026-11-16T10:16', 88, true)],
  },
  {
    id: 'step-08',
    title: 'ANOM-0003 10:20 采样：窗口重算计数累加，结果数据集只更新当前窗口',
    kind: 'ingest',
    ruleCode: 'ANOM-0003',
    watermark: '2026-11-16T10:21',
    samples: [point('S0305', 'ANOM-0003', '订单成功率', '2026-11-16T10:20', 95)],
  },
  {
    id: 'step-09',
    title: 'ANOM-0003 重算中断后续做：游标只剩未关闭窗口，已关闭窗口不参与',
    kind: 'resume',
    ruleCode: 'ANOM-0003',
    watermark: '2026-11-16T10:22',
    batchSize: 1,
  },
  {
    id: 'step-10',
    title: 'ANOM-0003 23:56 采样：落入跨日尾段 23:45-00:00（新周期首套窗口边界依据）',
    kind: 'ingest',
    ruleCode: 'ANOM-0003',
    watermark: '2026-11-16T23:57',
    samples: [point('S0306', 'ANOM-0003', '订单成功率', '2026-11-16T23:56', 150)],
  },
  {
    id: 'step-11',
    title: 'ANOM-0003 00:06 采样：落入跨日首段 00:00-00:15，两段窗口都有实际指标',
    kind: 'ingest',
    ruleCode: 'ANOM-0003',
    watermark: '2026-11-17T00:08',
    samples: [point('S0307', 'ANOM-0003', '订单成功率', '2026-11-17T00:06', 140)],
  },
  {
    id: 'step-12',
    title: 'ANOM-0003 切换分段保留基线做法：冲突依据不变，通知归属调整且仍只一条',
    kind: 'strategy',
    ruleCode: 'ANOM-0003',
    watermark: '2026-11-17T00:09',
    strategy: 'segmented-baseline',
  },
  // ---- ANOM-0002：跨日周期切换，两种做法结论冲突 ----
  {
    id: 'step-13',
    title: 'ANOM-0002 23:05/23:40 采样：尾段 23:00-00:00 均值 112.5，未达异常阈值',
    kind: 'ingest',
    ruleCode: 'ANOM-0002',
    watermark: '2026-11-16T23:42',
    samples: [
      point('S0201', 'ANOM-0002', '接口延迟', '2026-11-16T23:05', 105),
      point('S0202', 'ANOM-0002', '接口延迟', '2026-11-16T23:40', 120),
    ],
  },
  {
    id: 'step-14',
    title: 'ANOM-0002 跨日 00:00 周期切换：60 分钟改 240 分钟，尾段截断、首段按新周期起算',
    kind: 'period-change',
    ruleCode: 'ANOM-0002',
    watermark: '2026-11-17T00:00',
    newPeriodMinutes: 240,
    reason: 'ANOM-0002 检测周期由 60 分钟调整为 240 分钟',
    strategy: 'combined-window',
  },
  {
    id: 'step-15',
    title: 'ANOM-0002 00:10 采样：首段 00:00-04:00 均值 132 异常；三段合并均值 119 正常，产生冲突记录',
    kind: 'ingest',
    ruleCode: 'ANOM-0002',
    watermark: '2026-11-17T00:12',
    samples: [point('S0203', 'ANOM-0002', '接口延迟', '2026-11-17T00:10', 132)],
  },
  {
    id: 'step-16',
    title: 'ANOM-0002 切换分段基线做法：通知归尾段发出，合并/分段两份依据都保留',
    kind: 'strategy',
    ruleCode: 'ANOM-0002',
    watermark: '2026-11-17T00:13',
    strategy: 'segmented-baseline',
  },
]

const REGISTER_VERSIONS: Record<string, RuleVersion[]> = {
  'ANOM-0003': [ANOM0003_V1],
  'ANOM-0002': [ANOM0002_V1],
}

/** 按场景步骤推进一次；每一步都是确定性纯函数调用，重复点按幂等处理。 */
export function applyScenarioStep(
  state: AnomalyDatasetState,
  step: ScenarioStep,
): AnomalyDatasetState {
  switch (step.kind) {
    case 'register': {
      let next = state
      for (const code of step.ruleCodes ?? [step.ruleCode]) {
        for (const version of REGISTER_VERSIONS[code] ?? []) {
          if (!next.ruleVersions.some((item) => item.ruleCode === version.ruleCode && item.version === version.version)) {
            next = registerRuleVersion(next, version, step.watermark)
          }
        }
      }
      return next
    }
    case 'ingest':
      return ingestSamples(state, step.ruleCode, step.samples ?? [], step.watermark)
    case 'period-change':
      return changeDetectionPeriod(
        state,
        {
          ruleCode: step.ruleCode,
          newPeriodMinutes: step.newPeriodMinutes!,
          reason: step.reason ?? '检测周期调整',
        },
        { now: step.watermark, strategy: step.strategy },
      )
    case 'resume':
      return resumeRecalc(state, step.ruleCode, {
        now: step.watermark,
        batchSize: step.batchSize,
      }).state
    case 'strategy':
      return setConflictStrategy(state, step.ruleCode, step.strategy!, step.watermark)
    default:
      return state
  }
}

/** 从空数据集播种到指定步骤（含），测试与页面回放共用。 */
export function buildScenarioThrough(throughStepId: string): AnomalyDatasetState {
  let state = createInitialState(SCENARIO_STEPS[0].watermark)
  for (const step of SCENARIO_STEPS) {
    state = markScenarioStep(applyScenarioStep(state, step), step.id, step.watermark)
    if (step.id === throughStepId) {
      break
    }
  }
  return state
}
