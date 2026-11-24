import { traceEvent } from './diagnostics'
import type { UsageStatus } from './limits'

export const TRACE_LIMIT = 500
export const TRACE_AGE_MS = 7 * 24 * 60 * 60 * 1000
const PREFIX = 'chess-telemetry:'
export type TraceFields = Record<string, string | number | boolean | undefined>
export type TraceEmitter = (stage: string, fields?: TraceFields, failed?: boolean) => void
export interface TraceStep {
  at: number
  stage: string
  fields: TraceFields
  failed: boolean
}
export interface RequestTrace {
  traceId: string
  startedAt: number
  updatedAt: number
  operation: string
  outcome: 'running' | 'completed' | 'failed'
  events: TraceStep[]
  truncated: boolean
}
export interface TelemetrySnapshot {
  usage?: UsageStatus
  credential?: { valid: boolean; expiresAt?: number }
  traces: RequestTrace[]
  collectedAt: number
  retentionDays: number
  limit: number
}
export interface TelemetryStorage {
  put<T>(key: string, value: T): Promise<void>
  list<T>(options: { prefix: string; reverse?: boolean; limit?: number }): Promise<Map<string, T>>
  delete(keys: string[]): Promise<number>
}
const fieldsAllowed = new Set([
  'operation',
  'waitMs',
  'tool',
  'durationMs',
  'success',
  'model',
  'purpose',
  'maxOutputTokens',
  'inputTokens',
  'outputTokens',
  'finishReason',
  'code',
  'status',
  'providerRequestId',
  'attempt',
  'rejectedCount',
])
export function createRequestTrace(traceId: string, startedAt = Date.now()) {
  const record: RequestTrace = {
    traceId,
    startedAt,
    updatedAt: startedAt,
    operation: 'invalid',
    outcome: 'running',
    events: [],
    truncated: false,
  }
  const emit: TraceEmitter = (stage, fields = {}, failed = false) => {
    const safe: TraceFields = {}
    for (const [key, value] of Object.entries(fields))
      if (fieldsAllowed.has(key)) {
        if (typeof value === 'string') safe[key] = value.slice(0, 160)
        else if (
          typeof value === 'boolean' ||
          (typeof value === 'number' && Number.isFinite(value))
        )
          safe[key] = value
      }
    traceEvent(traceId, stage, safe, failed)
    record.updatedAt = Date.now()
    if (typeof safe.operation === 'string') record.operation = safe.operation
    if (stage === 'operation.complete') record.outcome = 'completed'
    if (stage === 'operation.failed') record.outcome = 'failed'
    if (record.events.length < 60)
      record.events.push({ at: record.updatedAt, stage, fields: safe, failed })
    else record.truncated = true
  }
  return { record, emit }
}
export async function saveTrace(storage: TelemetryStorage, trace: RequestTrace, now = Date.now()) {
  await storage.put(
    `${PREFIX}${trace.startedAt.toString().padStart(13, '0')}:${trace.traceId}`,
    trace,
  )
  const stored = await storage.list<RequestTrace>({ prefix: PREFIX, reverse: true })
  const remove = [...stored]
    .filter(([, r], i) => i >= TRACE_LIMIT || r.startedAt < now - TRACE_AGE_MS)
    .map(([key]) => key)
  if (remove.length) await storage.delete(remove)
}
export async function readTraces(
  storage: TelemetryStorage,
  now = Date.now(),
): Promise<TelemetrySnapshot> {
  const stored = await storage.list<RequestTrace>({
    prefix: PREFIX,
    reverse: true,
    limit: TRACE_LIMIT,
  })
  return {
    traces: [...stored.values()].filter((r) => r.startedAt >= now - TRACE_AGE_MS),
    collectedAt: now,
    retentionDays: 7,
    limit: TRACE_LIMIT,
  }
}
export function isDiagnosticsOwner(userId: string | null | undefined, ownerId: string | undefined) {
  return !!ownerId && !!userId && !userId.startsWith('anon-') && userId === ownerId
}
export function summarizeTraces(traces: RequestTrace[], now: number) {
  const steps = traces.flatMap((t) => t.events)
  const calls = steps.filter((e) => e.stage === 'model.start').length
  const modelTimes: number[] = []
  for (const trace of traces) {
    let duration: number | undefined
    for (const event of trace.events) {
      if (event.stage === 'model.start') {
        if (duration !== undefined) modelTimes.push(duration)
        duration = undefined
      }
      if (
        (event.stage === 'model.complete' || event.stage === 'model.failed') &&
        typeof event.fields.durationMs === 'number'
      )
        duration = event.fields.durationMs
    }
    if (duration !== undefined) modelTimes.push(duration)
  }
  modelTimes.sort((a, b) => a - b)
  const finished = traces.filter((t) => t.outcome !== 'running')
  const failures = finished.filter((t) => t.outcome === 'failed').length
  const completed = steps.filter((e) => e.stage === 'model.complete')
  const sumTokens = (field: string) =>
    completed.reduce(
      (n, e) => n + (typeof e.fields[field] === 'number' ? (e.fields[field] as number) : 0),
      0,
    )
  return {
    requests: traces.length,
    failures,
    failureRate: finished.length ? failures / finished.length : null,
    calls,
    extraAttempts: traces.reduce(
      (sum, t) => sum + Math.max(0, t.events.filter((e) => e.stage === 'model.start').length - 1),
      0,
    ),
    averageMs: modelTimes.length ? modelTimes.reduce((a, b) => a + b, 0) / modelTimes.length : null,
    p95Ms: modelTimes.length ? modelTimes[Math.ceil(modelTimes.length * 0.95) - 1] : null,
    inputTokens: sumTokens('inputTokens'),
    outputTokens: sumTokens('outputTokens'),
    running: traces.filter((t) => t.outcome === 'running' && now - t.startedAt < 120000).length,
    incomplete: traces.filter((t) => t.outcome === 'running' && now - t.startedAt >= 120000).length,
  }
}
