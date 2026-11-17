/**
 * 时间网格工具：内部统一用「epoch 分钟数（UTC）」计算，边界再格式化成墙面时间串。
 * 检测周期都能整除一天（5、15、60…），因此窗口永远落在整 5 分钟网格上。
 */

const PAD = (value: number): string => String(value).padStart(2, '0')

/** YYYY-MM-DDTHH:mm -> epoch 分钟。 */
export function parseTs(ts: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(ts)
  if (!match) {
    throw new Error(`时间格式应为 YYYY-MM-DDTHH:mm，实际收到：${ts}`)
  }
  const [, y, mo, d, h, mi] = match.map(Number)
  return Math.floor(Date.UTC(y, mo - 1, d, h, mi) / 60000)
}

/** epoch 分钟 -> YYYY-MM-DDTHH:mm（墙面时间，不带时区后缀）。 */
export function toTs(minutes: number): string {
  const date = new Date(minutes * 60000)
  return (
    `${date.getUTCFullYear()}-${PAD(date.getUTCMonth() + 1)}-${PAD(date.getUTCDate())}` +
    `T${PAD(date.getUTCHours())}:${PAD(date.getUTCMinutes())}`
  )
}

export function addMinutes(ts: string, delta: number): string {
  return toTs(parseTs(ts) + delta)
}

/** 向下对齐到检测周期网格。 */
export function floorToGrid(minutes: number, periodMinutes: number): number {
  return minutes - (minutes % periodMinutes)
}

/** 给定采样时刻与周期，返回所属窗口 [start, end) 的分钟边界。 */
export function windowBounds(minutes: number, periodMinutes: number): [number, number] {
  const start = floorToGrid(minutes, periodMinutes)
  return [start, start + periodMinutes]
}

/** 某分钟数所在自然日的 00:00。 */
export function dayStart(minutes: number): number {
  return floorToGrid(minutes, 24 * 60)
}

/**
 * 跨日边界标记：
 * - 收口在 00:00 的尾段窗口 -> boundary:YYYY-MM-DD（新一天）/ role=tail
 * - 起算在 00:00 的首段窗口 -> boundary:YYYY-MM-DD / role=head
 * 同一自然日两侧的窗口共享 boundary 日期，据此做跨日组去重。
 */
export function boundaryTag(start: number, end: number): { tag: string; day: string } | null {
  const day = 24 * 60
  if (end % day === 0 && start !== end) {
    return { tag: `boundary:${toTs(end).slice(0, 10)}`, day: toTs(end).slice(0, 10) }
  }
  if (start % day === 0) {
    return { tag: `boundary:${toTs(start).slice(0, 10)}`, day: toTs(start).slice(0, 10) }
  }
  return null
}

/** 稳定编号生成，保证重试产出同号对象（数据集只保留一份依据）。 */
export function buildWindowId(ruleCode: string, startMinutes: number, periodMinutes: number): string {
  return `${ruleCode}|W${toTs(startMinutes)}|P${periodMinutes}`
}

export function buildDatasetId(windowId: string): string {
  return `AD|${windowId}`
}

export function buildNotificationId(windowId: string): string {
  return `NTF|${windowId}`
}

export function buildConflictId(overlapTag: string, ruleCode: string): string {
  return `CFL|${ruleCode}|${overlapTag}`
}
