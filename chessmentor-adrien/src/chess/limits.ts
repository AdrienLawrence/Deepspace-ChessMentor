import { ChessError } from './errors'

export interface LimitStorage {
  get<T>(key: string): Promise<T | undefined>
  put<T>(key: string, value: T): Promise<void>
}
export interface AtomicLimitStorage extends LimitStorage {
  transaction<T>(callback: (txn: LimitStorage) => Promise<T>): Promise<T>
}
export interface LimitConfig {
  CHESS_AI_ENABLED?: string
  CHESS_AI_USER_DAILY?: string
  CHESS_AI_APP_DAILY?: string
}
export const LIMIT_DEFAULTS = { userDaily: 300, appDaily: 1000, concurrent: 4 } as const
export interface UsageStatus {
  enabled: boolean
  appDailyLimit: number
  userDailyLimit: number
  appUsedToday: number
  resetsAt: number
}
type Rule = { key: string; limit: number; interval: number }
type Window = { start: number; count: number }
const MINUTE = 60_000,
  HOUR = 60 * MINUTE,
  DAY = 24 * HOUR

function configured(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 100_000)
    throw new ChessError(
      'The app’s usage configuration needs attention.',
      503,
      'usage_configuration',
    )
  return Number(value)
}

/** All windows are reserved together or none are; no lost updates across users. */
async function consume(txn: LimitStorage, rules: Rule[], now: number) {
  const pending: [string, Window][] = []
  for (const rule of rules) {
    const key = `chess-limits:${rule.key}`
    const stored = await txn.get<Window>(key)
    const start = Math.floor(now / rule.interval) * rule.interval
    const count = stored?.start === start ? stored.count : 0
    if (count >= rule.limit)
      throw new ChessError(
        'Usage limit reached. Please wait before trying again.',
        429,
        'usage_limit',
        Math.max(1, Math.ceil((start + rule.interval - now) / 1000)),
      )
    pending.push([key, { start, count: count + 1 }])
  }
  for (const [key, value] of pending) await txn.put(key, value)
}

export async function admitRequest(storage: AtomicLimitStorage, userId: string, now = Date.now()) {
  await storage.transaction((txn) =>
    consume(
      txn,
      [
        { key: `request:${userId}`, limit: 30, interval: MINUTE },
        { key: 'request:app', limit: 300, interval: MINUTE },
      ],
      now,
    ),
  )
}

export async function admitCreation(storage: AtomicLimitStorage, userId: string, now = Date.now()) {
  await storage.transaction((txn) =>
    consume(
      txn,
      [
        { key: `create-hour:${userId}`, limit: 10, interval: HOUR },
        { key: `create-day:${userId}`, limit: 30, interval: DAY },
        { key: 'create-day:app', limit: 200, interval: DAY },
      ],
      now,
    ),
  )
}

type Lease = { id: string; expires: number }
const LEASE_KEY = 'chess-limits:model-leases'
export async function readUsage(
  storage: LimitStorage,
  config: LimitConfig,
  now = Date.now(),
): Promise<UsageStatus> {
  const start = Math.floor(now / DAY) * DAY
  const current = await storage.get<Window>('chess-limits:model-day:app')
  return {
    enabled: config.CHESS_AI_ENABLED !== 'false',
    appDailyLimit: configured(config.CHESS_AI_APP_DAILY, LIMIT_DEFAULTS.appDaily),
    userDailyLimit: configured(config.CHESS_AI_USER_DAILY, LIMIT_DEFAULTS.userDaily),
    appUsedToday: current?.start === start ? current.count : 0,
    resetsAt: start + DAY,
  }
}
/** Reserve before each provider request. Failures count; duplicate saved results don't. */
export async function reserveModel(
  storage: AtomicLimitStorage,
  userId: string,
  config: LimitConfig,
  now = Date.now(),
) {
  if (config.CHESS_AI_ENABLED === 'false')
    throw new ChessError('AI is temporarily paused by the app owner.', 503, 'ai_paused')
  if (config.CHESS_AI_ENABLED !== undefined && config.CHESS_AI_ENABLED !== 'true')
    throw new ChessError(
      'The app’s usage configuration needs attention.',
      503,
      'usage_configuration',
    )
  const userDaily = configured(config.CHESS_AI_USER_DAILY, LIMIT_DEFAULTS.userDaily)
  const appDaily = configured(config.CHESS_AI_APP_DAILY, LIMIT_DEFAULTS.appDaily)
  const id = crypto.randomUUID()
  await storage.transaction(async (txn) => {
    const leases = ((await txn.get<Lease[]>(LEASE_KEY)) ?? []).filter((l) => l.expires > now)
    if (leases.length >= LIMIT_DEFAULTS.concurrent)
      throw new ChessError(
        'The AI is serving other players. Please try again shortly.',
        429,
        'ai_capacity',
        10,
      )
    await consume(
      txn,
      [
        { key: `model-minute:${userId}`, limit: 12, interval: MINUTE },
        { key: `model-hour:${userId}`, limit: 120, interval: HOUR },
        { key: `model-day:${userId}`, limit: userDaily, interval: DAY },
        { key: 'model-minute:app', limit: 30, interval: MINUTE },
        { key: 'model-day:app', limit: appDaily, interval: DAY },
      ],
      now,
    )
    await txn.put(LEASE_KEY, [...leases, { id, expires: now + 60_000 }])
  })
  return async () => {
    await storage.transaction(async (txn) => {
      const leases = (await txn.get<Lease[]>(LEASE_KEY)) ?? []
      await txn.put(
        LEASE_KEY,
        leases.filter((l) => l.id !== id && l.expires > Date.now()),
      )
    })
  }
}
