import { useCallback, useEffect, useRef, useState } from 'react'
import { getAuthToken } from 'deepspace'
import { RefreshCw, Activity } from 'lucide-react'
import {
  summarizeTraces,
  type TelemetrySnapshot,
  type RequestTrace,
} from '../../../chess/telemetry'
import '../../../diagnostics.css'

const number = (value: number) => value.toLocaleString()
const seconds = (value: number | null) => (value === null ? '—' : `${(value / 1000).toFixed(1)}s`)
function stateOf(trace: RequestTrace, now: number) {
  return trace.outcome === 'running' && now - trace.startedAt >= 120000
    ? 'incomplete'
    : trace.outcome
}
export default function Diagnostics() {
  const [snapshot, setSnapshot] = useState<TelemetrySnapshot | null>(null)
  const [error, setError] = useState('')
  const [denied, setDenied] = useState(false)
  const [loading, setLoading] = useState(false)
  const [automatic, setAutomatic] = useState(true)
  const [hours, setHours] = useState(24)
  const [operation, setOperation] = useState('all')
  const [status, setStatus] = useState('all')
  const [search, setSearch] = useState('')
  const [visibleCount, setVisibleCount] = useState(50)
  const pending = useRef(false)
  const controller = useRef<AbortController | null>(null)
  const refresh = useCallback(async () => {
    if (pending.current) return
    pending.current = true
    const abort = new AbortController()
    controller.current = abort
    setLoading(true)
    try {
      const token = await getAuthToken()
      if (!token) throw new Error('Sign in as the app owner to view diagnostics.')
      const response = await fetch('/api/actions/diagnostics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: '{}',
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]),
      })
      if (!response.headers.get('Content-Type')?.includes('application/json'))
        throw new Error('Diagnostics could not load. Try refreshing shortly.')
      const result = (await response.json()) as {
        success: boolean
        data: TelemetrySnapshot
        status?: number
        error?: string
      }
      if (!response.ok || !result.success) {
        if (response.status === 403 || result.status === 403) {
          setDenied(true)
          setAutomatic(false)
          setSnapshot(null)
        }
        throw new Error(result.error || 'Diagnostics could not load. Try refreshing.')
      }
      setSnapshot(result.data)
      setError('')
    } catch (e) {
      if (!abort.signal.aborted)
        setError(e instanceof Error ? e.message : 'Diagnostics could not load.')
    } finally {
      pending.current = false
      if (!abort.signal.aborted) setLoading(false)
    }
  }, [])
  useEffect(() => {
    void refresh()
    return () => controller.current?.abort()
  }, [refresh])
  useEffect(() => {
    if (!automatic || denied) return
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh()
    }, 30000)
    return () => window.clearInterval(timer)
  }, [automatic, denied, refresh])
  const now = snapshot?.collectedAt ?? Date.now()
  const traces = (snapshot?.traces ?? []).filter(
    (t) =>
      t.startedAt >= now - hours * 3600000 &&
      (operation === 'all' || t.operation === operation) &&
      (status === 'all' || stateOf(t, now) === status) &&
      (!search.trim() || t.traceId.toLowerCase().includes(search.trim().toLowerCase())),
  )
  const metrics = summarizeTraces(traces, now)
  const errors = new Map<string, number>()
  for (const trace of traces)
    for (const step of trace.events)
      if (step.stage === 'operation.failed') {
        const code = String(step.fields.code ?? 'unknown')
        errors.set(code, (errors.get(code) ?? 0) + 1)
      }
  const buckets = Array.from({ length: 12 }, (_, i) => {
    const from = now - hours * 3600000 + ((hours * 3600000) / 12) * i
    const values = traces.filter(
      (t) => t.startedAt >= from && t.startedAt < from + (hours * 3600000) / 12,
    )
    return {
      from,
      success: values.filter((t) => t.outcome === 'completed').length,
      failed: values.filter((t) => t.outcome === 'failed').length,
    }
  })
  const peak = Math.max(1, ...buckets.map((b) => b.success + b.failed))
  return (
    <div className="diagnostics-page">
      <header className="diagnostics-header">
        <div>
          <p className="diag-eyebrow">
            <Activity size={15} /> OWNER DIAGNOSTICS
          </p>
          <h1>See what happened.</h1>
          <p>AI requests, delays and failures in one place.</p>
        </div>
        <div className="diag-refresh">
          <label>
            <input
              type="checkbox"
              checked={automatic}
              disabled={denied}
              onChange={(e) => setAutomatic(e.target.checked)}
            />{' '}
            Refresh every 30s
          </label>
          <button
            className="secondary-button"
            disabled={loading || denied}
            onClick={() => void refresh()}
          >
            <RefreshCw size={15} />
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </header>
      {snapshot?.usage && !denied && (
        <div className="diag-filters" aria-label="AI usage limits">
          <p>
            <strong>AI {snapshot.usage.enabled ? 'enabled' : 'paused'}</strong> ·{' '}
            {number(snapshot.usage.appUsedToday)} / {number(snapshot.usage.appDailyLimit)} app
            attempts today · {number(snapshot.usage.userDailyLimit)} per player per day. Resets at{' '}
            {new Date(snapshot.usage.resetsAt).toLocaleTimeString()}. Failed attempts and retries
            count.
          </p>
        </div>
      )}
      {snapshot?.credential && !denied && (
        <p role={snapshot.credential.valid ? undefined : 'alert'}>
          AI credential:{' '}
          {snapshot.credential.valid
            ? 'signature, owner, app scope and expiration verified'
            : 'invalid or missing; AI requests are blocked'}
          . This check does not verify billing balance or platform revocation.
        </p>
      )}
      {error && (
        <div className="error-banner" role="alert">
          {error}
          {snapshot && ' Showing the last successful snapshot.'}
        </div>
      )}
      {denied ? (
        <p>
          Diagnostics are restricted to the app owner, including when another user has an admin
          role.
        </p>
      ) : (
        <>
          <div className="diag-filters">
            <label>
              Time range
              <select
                aria-label="Time range"
                value={hours}
                onChange={(e) => setHours(Number(e.target.value))}
              >
                <option value={1}>Past hour</option>
                <option value={24}>Past 24 hours</option>
                <option value={168}>Past 7 days</option>
              </select>
            </label>
            <label>
              Operation
              <select
                aria-label="Operation"
                value={operation}
                onChange={(e) => setOperation(e.target.value)}
              >
                <option value="all">All operations</option>
                {[
                  'ask',
                  'opponent',
                  'feedback',
                  'move',
                  'branch',
                  'create',
                  'resign',
                  'invalid',
                ].map((op) => (
                  <option key={op}>{op}</option>
                ))}
              </select>
            </label>
            <label>
              Result
              <select
                aria-label="Result"
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                <option value="all">All results</option>
                {['completed', 'failed', 'running', 'incomplete'].map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
            <label className="diag-search">
              Trace reference
              <input
                placeholder="Paste a trace ID"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
          </div>
          <div className="diag-metrics">
            {[
              [
                'Requests',
                number(metrics.requests),
                `${metrics.running} running · ${metrics.incomplete} incomplete`,
              ],
              [
                'Failed operations',
                metrics.failureRate === null ? '—' : `${(metrics.failureRate * 100).toFixed(1)}%`,
                `${metrics.failures} failed; running requests excluded`,
              ],
              [
                'AI response time',
                seconds(metrics.averageMs),
                `95th percentile: ${seconds(metrics.p95Ms)}`,
              ],
              [
                'AI attempts',
                number(metrics.calls),
                `${metrics.extraAttempts} extra attempts within requests`,
              ],
              [
                'Reported tokens',
                number(metrics.inputTokens + metrics.outputTokens),
                `${number(metrics.inputTokens)} input · ${number(metrics.outputTokens)} output`,
              ],
            ].map(([label, value, note]) => (
              <section className="diag-card" key={label}>
                <h2>{label}</h2>
                <strong>{snapshot ? value : '—'}</strong>
                <p>{note}</p>
              </section>
            ))}
          </div>
          <div className="diag-panels">
            <section className="diag-card">
              <h2>Request activity</h2>
              <p className="diag-legend">
                <span>Completed</span>
                <span>Failed</span>
              </p>
              <div
                className="diag-chart"
                role="img"
                aria-label={`Activity across ${hours} hours: ${traces.filter((t) => t.outcome === 'completed').length} completed and ${metrics.failures} failed operations`}
              >
                {buckets.map((b) => (
                  <div
                    className="diag-bar"
                    key={b.from}
                    title={`${new Date(b.from).toLocaleString()}: ${b.success} completed, ${b.failed} failed`}
                  >
                    <i style={{ height: `${(b.failed / peak) * 100}%` }} />
                    <b style={{ height: `${(b.success / peak) * 100}%` }} />
                  </div>
                ))}
              </div>
              <p className="diag-chart-label">
                <span>{new Date(now - hours * 3600000).toLocaleString()}</span>
                <span>{new Date(now).toLocaleString()}</span>
              </p>
            </section>
            <section className="diag-card">
              <h2>Failure reasons</h2>
              {errors.size ? (
                <ul className="diag-errors">
                  {[...errors]
                    .sort((a, b) => b[1] - a[1])
                    .map(([code, count]) => (
                      <li key={code}>
                        <code>{code.replaceAll('_', ' ')}</code>
                        <strong>{count}</strong>
                      </li>
                    ))}
                </ul>
              ) : (
                <p>No recorded failures in this selection.</p>
              )}
            </section>
          </div>
          <section className="diag-card diag-traces">
            <div className="diag-section-title">
              <h2>Request traces</h2>
              <span>
                {Math.min(visibleCount, traces.length)} of {traces.length} shown
              </span>
            </div>
            {!snapshot ? (
              <p role="status">{loading ? 'Loading diagnostics…' : 'No snapshot available.'}</p>
            ) : !traces.length ? (
              <p>
                No traces match this selection. Collection begins with the dashboard release;
                earlier console logs are not backfilled.
              </p>
            ) : (
              traces.slice(0, visibleCount).map((t) => (
                <details className="diag-trace" key={t.traceId}>
                  <summary>
                    <span className={`diag-outcome ${stateOf(t, now)}`}>{stateOf(t, now)}</span>
                    <strong>{t.operation}</strong>
                    <time>{new Date(t.startedAt).toLocaleString()}</time>
                    <code>{t.traceId}</code>
                    <span>{seconds(t.updatedAt - t.startedAt)}</span>
                  </summary>
                  <p>
                    {stateOf(t, now) === 'incomplete'
                      ? 'No final outcome recorded; the request may have been interrupted.'
                      : t.outcome === 'running'
                        ? 'Request in progress. Stage details appear when it finishes.'
                        : 'Stage timings below are relative to request start.'}
                  </p>
                  <div className="diag-step-table">
                    <table>
                      <thead>
                        <tr>
                          <th>Elapsed</th>
                          <th>Stage</th>
                          <th>Details</th>
                        </tr>
                      </thead>
                      <tbody>
                        {t.events.map((e, i) => (
                          <tr key={i}>
                            <td>{seconds(e.at - t.startedAt)}</td>
                            <td>{e.stage}</td>
                            <td>
                              {Object.entries(e.fields).map(([key, value]) => (
                                <span className="diag-field" key={key}>
                                  {key}: {String(value)}
                                </span>
                              ))}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {t.truncated && (
                    <p>
                      Stage list truncated after 60 events. Consult hosted logs using this trace ID.
                    </p>
                  )}
                </details>
              ))
            )}
            {traces.length > visibleCount && (
              <button className="secondary-button" onClick={() => setVisibleCount((n) => n + 50)}>
                Show more traces
              </button>
            )}
          </section>
          <footer className="diag-note">
            {snapshot && <>Updated {new Date(snapshot.collectedAt).toLocaleTimeString()}. </>}Shows
            up to 500 recent requests from the past 7 days. Metrics follow the filters and cover
            retained traces only. Token counts include reported usage, not unreported or interrupted
            calls, and are not a billing balance. Prompts, answers and credentials are excluded.
            Extra attempts count within one request, not manual retries across requests.
          </footer>
        </>
      )}
    </div>
  )
}
