import { describe, expect, it, vi } from 'vitest'
import {
  createRequestTrace,
  readTraces,
  saveTrace,
  summarizeTraces,
  isDiagnosticsOwner,
  TRACE_AGE_MS,
  TRACE_LIMIT,
  type TelemetryStorage,
  type RequestTrace,
} from './telemetry'

class Memory implements TelemetryStorage {
  values = new Map<string, unknown>()
  async put<T>(key: string, value: T) {
    this.values.set(key, structuredClone(value))
  }
  async list<T>(options: { prefix: string; reverse?: boolean; limit?: number }) {
    let entries = [...this.values]
      .filter(([key]) => key.startsWith(options.prefix))
      .sort(([a], [b]) => a.localeCompare(b))

    if (options.reverse) entries.reverse()
    if (options.limit) entries = entries.slice(0, options.limit)

    return new Map(entries) as Map<string, T>
  }
  async delete(keys: string[]) {
    keys.forEach((key) => this.values.delete(key))

    return keys.length
  }
}

describe('private dashboard telemetry', () => {
  it('restricts diagnostics to the exact configured owner, failing closed without configuration', () => {
    expect(isDiagnosticsOwner('owner', 'owner')).toBe(true)
    expect(isDiagnosticsOwner('admin', 'owner')).toBe(false)
    expect(isDiagnosticsOwner('owner', undefined)).toBe(false)
    expect(isDiagnosticsOwner(null, 'owner')).toBe(false)
    expect(isDiagnosticsOwner('anon-x', 'anon-x')).toBe(false)
  })
  it('keeps only bounded metadata, never arbitrary fields', () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {})

    try {
      const trace = createRequestTrace('trace-1', 100)
      trace.emit('model.start', {
        model: 'test',
        prompt: 'private',
        authorization: 'secret',
        durationMs: Infinity,
      })
      expect(trace.record.events[0].fields).toEqual({ model: 'test' })

      for (let i = 0; i < 70; i++) trace.emit('storage.complete', { durationMs: i })

      trace.emit('operation.complete', { operation: 'ask' })
      expect(trace.record.events).toHaveLength(60)
      expect(trace.record.truncated).toBe(true)
      expect(trace.record.outcome).toBe('completed')
      expect(JSON.stringify(log.mock.calls)).not.toMatch(/private|secret/)
    } finally {
      log.mockRestore()
    }
  })
  it('persists across readers, updates the same trace and bounds retention without touching game keys', async () => {
    const storage = new Memory()
    const now = Date.now()
    await storage.put('chess-rate:owner', [now])

    for (let i = 0; i < TRACE_LIMIT + 2; i++) {
      const trace = createRequestTrace(`id-${i}`, now - i).record
      await storage.put(`chess-telemetry:${trace.startedAt}:id-${i}`, trace)
    }

    const current = createRequestTrace('new', now + 1).record
    await saveTrace(storage, current, now)
    expect((await readTraces(storage, now)).traces).toHaveLength(TRACE_LIMIT)
    current.outcome = 'failed'
    await saveTrace(storage, current, now)
    expect((await readTraces(storage, now)).traces[0].outcome).toBe('failed')
    expect(storage.values.has('chess-rate:owner')).toBe(true)
    expect((await readTraces(storage, now + TRACE_AGE_MS + 2)).traces).toEqual([])
    await saveTrace(
      storage,
      createRequestTrace('later', now + TRACE_AGE_MS + 2).record,
      now + TRACE_AGE_MS + 2,
    )
    expect(storage.values.size).toBe(2)
  })
  it('separates request failures, attempts, tokens and incomplete work', () => {
    const now = Date.now()
    const record: RequestTrace = {
      traceId: 'test',
      startedAt: now - 5000,
      updatedAt: now,
      operation: 'opponent',
      outcome: 'completed',
      truncated: false,
      events: [
        { at: now, stage: 'model.start', fields: {}, failed: false },
        {
          at: now,
          stage: 'model.complete',
          fields: { durationMs: 1000, inputTokens: 50, outputTokens: 10 },
          failed: false,
        },
        { at: now, stage: 'model.failed', fields: { durationMs: 1001 }, failed: true },
        { at: now, stage: 'model.start', fields: {}, failed: false },
        {
          at: now,
          stage: 'model.complete',
          fields: { durationMs: 2000, inputTokens: 60, outputTokens: 12 },
          failed: false,
        },
      ],
    }
    const stats = summarizeTraces(
      [
        record,
        { ...record, traceId: 'old', startedAt: now - 200000, outcome: 'running', events: [] },
      ],
      now,
    )
    expect(stats).toMatchObject({
      requests: 2,
      failures: 0,
      failureRate: 0,
      calls: 2,
      extraAttempts: 1,
      inputTokens: 110,
      outputTokens: 22,
      incomplete: 1,
      running: 0,
      averageMs: 1500.5,
      p95Ms: 2000,
    })
    expect(summarizeTraces([], now).failureRate).toBeNull()
  })
})
