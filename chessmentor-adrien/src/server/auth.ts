import { verifyJwt } from 'deepspace/worker'
import type { Env } from '../../worker'

export async function verifyUserToken(env: Env, token: string | null) {
  if (!token || token.length > 8192) return null
  const { result } = await verifyJwt(
    { publicKey: env.AUTH_JWT_PUBLIC_KEY, issuer: env.AUTH_JWT_ISSUER },
    token,
  )
  if (
    !result ||
    typeof result.userId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(result.userId) ||
    result.userId.startsWith('anon-')
  )
    return null
  // jose checks expiry when present; app access also requires it to exist.
  if (typeof result.claims.exp !== 'number' || result.claims.exp <= Date.now() / 1000) return null
  if (
    (env.CHESS_BLOCKED_USER_IDS ?? '')
      .split(',')
      .map((id) => id.trim())
      .includes(result.userId)
  )
    return null
  return result
}
