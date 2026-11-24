import { describe, expect, it } from 'vitest'
import { boardPoint } from './Chessboard'

describe('board annotation coordinates', () => {
  it('aligns arrows and highlights with either board orientation', () => {
    expect(boardPoint('a8', 'w')).toEqual({ x: 0, y: 0 })
    expect(boardPoint('h1', 'w')).toEqual({ x: 7, y: 7 })
    expect(boardPoint('h1', 'b')).toEqual({ x: 0, y: 0 })
    expect(boardPoint('a8', 'b')).toEqual({ x: 7, y: 7 })
    expect(boardPoint('e4', 'w')).toEqual({ x: 4, y: 4 })
    expect(boardPoint('e4', 'b')).toEqual({ x: 3, y: 3 })
  })
})
