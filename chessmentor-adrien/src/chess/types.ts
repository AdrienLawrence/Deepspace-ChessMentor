/**
 * Shared chess data contracts and runtime validation schemas.
 * Zod owns parsing and validation; types inferred here are shared by UI and server.
 * Database columns and collection permissions are defined separately in src/schemas/chess-schema.ts.
 */

// Zod's parser implementation lives in node_modules/zod; the app-specific schemas are below.
import { z } from 'zod'

export const squareSchema = z.string().regex(/^[a-h][1-8]$/)

export const annotationSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('arrow'),
    from: squareSchema,
    to: squareSchema,
    tone: z.enum(['red', 'blue', 'yellow', 'green']),
    label: z.string().max(80).optional(),
  }),
  z.object({
    type: z.literal('highlight'),
    square: squareSchema,
    tone: z.enum(['red', 'blue', 'yellow', 'green']),
    label: z.string().max(80).optional(),
  }),
])

export type Annotation = z.infer<typeof annotationSchema>

export type Color = 'w' | 'b'

export interface MoveEntry {
  /** One half-move: White's first move is ply 1 and Black's reply is ply 2. */
  ply: number
  actor: 'player' | 'opponent'
  color: Color
  /** Human-readable notation from chess.js, such as Nf3 or O-O. */
  san: string
  /** Coordinate notation used by commands and the model, such as e2e4 or e7e8q. */
  uci: string
  before: string
  after: string
}

export interface Game {
  /** Failed AI outputs retained only for the matching revision and position. */
  opponentRetry?: {
    version: number
    fen: string
    rejected: { uci: string | null; reason: string }[]
  } | null
  parentGameId?: string
  branchPly?: number
  playerId: string
  playerColor: Color
  automaticFeedback: boolean
  /** Full chess.js position encoding, including side to move and castling rights. */
  currentFen: string
  moveHistory: MoveEntry[]
  status: 'active' | 'finished'
  result: '*' | '1-0' | '0-1' | '1/2-1/2'
  reason: string
  /** Server revision used to reject stale commands; optimistic UI waits for this value. */
  version: number
}

export interface Message {
  playerId: string
  gameId: string
  role: 'player' | 'coach'
  content: string
  /** Position selected when the question/response was created, not the current live ply. */
  linkedPly: number
  positionFen: string
  annotations: Annotation[]
  status: 'pending' | 'completed' | 'failed'
  /** Stable across retries so service.ts can return an existing answer without duplicating it. */
  requestId: string
}

export interface Feedback {
  playerId: string
  gameId: string
  ply: number
  positionFen: string
  summary: string
  annotations: Annotation[]
}

/** The subset of the SDK record envelope consumed by the chess application. */
export interface Row<T> {
  recordId: string
  data: T
  createdAt: string
  updatedAt: string
}

export const commandSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('branch'),
    gameId: z.string().min(1).max(150),
    requestId: z.string().uuid(),
    ply: z.number().int().nonnegative(),
    fen: z.string().max(120),
    uci: z.string().regex(/^[a-h][1-8][a-h][1-8][qrbn]?$/),
  }),
  z.object({
    op: z.literal('create'),
    requestId: z.string().uuid(),
    color: z.enum(['w', 'b', 'random']),
    automaticFeedback: z.boolean(),
  }),
  z.object({
    op: z.literal('move'),
    gameId: z.string().min(1).max(150),
    version: z.number().int().nonnegative(),
    uci: z.string().regex(/^[a-h][1-8][a-h][1-8][qrbn]?$/),
  }),
  z.object({
    op: z.literal('opponent'),
    gameId: z.string().min(1).max(150),
    version: z.number().int().nonnegative(),
  }),
  z.object({
    op: z.literal('resign'),
    gameId: z.string().min(1).max(150),
    version: z.number().int().nonnegative(),
  }),
  z.object({
    op: z.literal('ask'),
    gameId: z.string().min(1).max(150),
    requestId: z.string().uuid(),
    ply: z.number().int().nonnegative(),
    fen: z.string().max(120),
    question: z.string().trim().min(1).max(2000),
  }),
  z.object({
    op: z.literal('feedback'),
    gameId: z.string().min(1).max(150),
    ply: z.number().int().positive(),
  }),
])

export type Command = z.infer<typeof commandSchema>
