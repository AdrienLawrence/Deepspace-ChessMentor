import { Chess } from 'chess.js'

export function materialAt(fen: string) {
  const values = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 }
  const totals = { w: 0, b: 0 }
  for (const piece of new Chess(fen).board().flat())
    if (piece) totals[piece.color] += values[piece.type]
  return { ...totals, difference: totals.w - totals.b }
}
