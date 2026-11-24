import { describe, expect, it } from 'vitest'
import { Chess } from 'chess.js'
import { materialAt } from './material'

describe('material of the displayed position', () => {
  it('counts starting material, captures and historical positions', () => {
    const chess = new Chess()
    const start = chess.fen()
    chess.move('e4')
    chess.move('d5')
    chess.move('exd5')
    expect(materialAt(chess.fen())).toEqual({ w: 39, b: 38, difference: 1 })
    expect(materialAt(start)).toEqual({ w: 39, b: 39, difference: 0 })
  })
  it('counts promoted material and gives kings no points', () => {
    const chess = new Chess('7k/P7/8/8/8/8/8/K7 w - - 0 1')
    chess.move('a8=Q+')
    expect(materialAt(chess.fen())).toEqual({ w: 9, b: 0, difference: 9 })
    expect(materialAt('7k/8/8/8/8/8/8/K7 w - - 0 1').difference).toBe(0)
  })
})
