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
  ply: number
  actor: 'player' | 'opponent'
  color: Color
  san: string
  uci: string
  before: string
  after: string
}
export interface Game {
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
  currentFen: string
  moveHistory: MoveEntry[]
  status: 'active' | 'finished'
  result: '*' | '1-0' | '0-1' | '1/2-1/2'
  reason: string
  version: number
}
export interface Message {
  playerId: string
  gameId: string
  role: 'player' | 'coach'
  content: string
  linkedPly: number
  positionFen: string
  annotations: Annotation[]
  status: 'pending' | 'completed' | 'failed'
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
