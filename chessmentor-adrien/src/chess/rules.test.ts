import { describe, expect, it } from 'vitest'
import { Chess, DEFAULT_POSITION } from 'chess.js'
import {
  chessContext,
  commitMove,
  newGame,
  outcome,
  positionAt,
  replay,
  resign,
  reviewedMoveContext,
} from './rules'
import type { Game } from './types'

function play(moves: string[], game = newGame('alice', 'w', false)): Game {
  return moves.reduce(
    (g, uci) =>
      commitMove(g, g.version, uci, replay(g).turn() === g.playerColor ? 'player' : 'opponent'),
    game,
  )
}

describe('authoritative chess rules', () => {
  it('creates an empty position at revision and ply zero', () => {
    expect(newGame('alice', 'b', true)).toMatchObject({
      playerId: 'alice',
      playerColor: 'b',
      automaticFeedback: true,
      currentFen: DEFAULT_POSITION,
      version: 0,
      moveHistory: [],
      status: 'active',
    })
  })
  it('commits legal moves with SAN, UCI, both FENs and one revision', () => {
    const g = play(['e2e4', 'c7c5'])
    expect(g.version).toBe(2)
    expect(g.moveHistory[0]).toMatchObject({
      san: 'e4',
      uci: 'e2e4',
      before: DEFAULT_POSITION,
      actor: 'player',
      ply: 1,
    })
    expect(g.moveHistory[1]).toMatchObject({
      san: 'c5',
      actor: 'opponent',
      color: 'b',
      ply: 2,
      before: g.moveHistory[0].after,
      after: g.currentFen,
    })
  })
  it('rejects illegal moves and a mismatched side', () => {
    const g = newGame('alice', 'w', false)
    expect(() => commitMove(g, 0, 'e2e5', 'player')).toThrow(/not legal/)
    expect(() => commitMove(g, 0, 'e2e4', 'opponent')).toThrow(/not your turn/)
    expect(g.moveHistory).toHaveLength(0)
  })
  it('rejects stale and duplicate moves', () => {
    const g = play(['e2e4'])
    expect(() => commitMove(g, 0, 'e2e4', 'player')).toThrow(/position changed/)
  })
  it('supports White opening when the human plays Black', () => {
    const g = commitMove(newGame('alice', 'b', false), 0, 'd2d4', 'opponent')
    expect(replay(g).turn()).toBe('b')
    expect(commitMove(g, 1, 'd7d5', 'player').moveHistory[1].actor).toBe('player')
  })
  it('moves both king and rook when castling', () => {
    const g = play(['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'g8f6', 'e1g1'])
    const board = replay(g)
    expect(board.get('g1')?.type).toBe('k')
    expect(board.get('f1')?.type).toBe('r')
    expect(g.moveHistory.at(-1)?.san).toBe('O-O')
  })
  it('captures en passant and preserves reconstruction', () => {
    const g = play(['e2e4', 'a7a6', 'e4e5', 'd7d5', 'e5d6'])
    expect(replay(g).get('d5')).toBeUndefined()
    expect(replay(g).get('d6')?.color).toBe('w')
    expect(g.moveHistory.at(-1)?.san).toBe('exd6')
  })
  it('requires a promotion piece and supports underpromotion', () => {
    const g = play(['a2a4', 'h7h5', 'a4a5', 'h5h4', 'a5a6', 'h4h3', 'a6b7', 'h3g2'])
    expect(() => commitMove(g, 8, 'b7a8', 'player')).toThrow(/promotion/)
    expect(replay(commitMove(g, 8, 'b7a8n', 'player')).get('a8')).toMatchObject({
      type: 'n',
      color: 'w',
    })

    for (const piece of ['q', 'r', 'b'])
      expect(replay(commitMove(g, 8, `b7a8${piece}`, 'player')).get('a8')?.type).toBe(piece)
  })
  it('detects checkmate and rejects further moves', () => {
    const g = play(['f2f3', 'e7e5', 'g2g4', 'd8h4'])
    expect(g).toMatchObject({ status: 'finished', result: '0-1', reason: 'Checkmate' })
    expect(() => commitMove(g, 4, 'a2a3', 'player')).toThrow(/ended/)
  })
  it('retains the full repetition history', () => {
    const g = play(['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8'])
    expect(g).toMatchObject({
      status: 'finished',
      result: '1/2-1/2',
      reason: 'Threefold repetition',
    })
    expect(new Chess(g.currentFen).isThreefoldRepetition()).toBe(false)
  })
  it.each([
    ['7k/5Q2/6K1/8/8/8/8/8 b - - 0 1', 'Stalemate'],
    ['7k/8/6K1/8/8/8/8/8 w - - 0 1', 'Insufficient material'],
    ['7k/8/6K1/8/8/8/R7/8 w - - 100 70', 'Fifty-move rule'],
  ])('recognizes terminal draw %s', (fen, reason) =>
    expect(outcome(new Chess(fen))).toEqual({ status: 'finished', result: '1/2-1/2', reason }),
  )
  it('resigns for either color without modifying the history', () => {
    for (const color of ['w', 'b'] as const) {
      const g = newGame('alice', color, false)
      const ended = resign(g, 0)
      expect(ended.result).toBe(color === 'w' ? '0-1' : '1-0')
      expect(ended.version).toBe(1)
      expect(ended.moveHistory).toEqual([])
      expect(() => resign(ended, 1)).toThrow(/ended/)
    }
  })
  it.each([
    '7k/8/8/8/8/8/8/KN6 w - - 0 1',
    '7k/8/8/8/8/8/8/KB6 w - - 0 1',
    '6nk/8/8/8/8/8/8/K7 w - - 0 1',
    '6bk/8/8/8/8/8/8/K7 w - - 0 1',
  ])('draws with just kings and a single minor piece: %s', (fen) => {
    expect(outcome(new Chess(fen))).toEqual({
      status: 'finished',
      result: '1/2-1/2',
      reason: 'Insufficient material',
    })
  })
  it.each([
    ['7k/P7/8/8/8/8/8/K7 w - - 0 1', 'a7', 'a8', 'n'],
    ['7k/P7/8/8/8/8/8/K7 w - - 0 1', 'a7', 'a8', 'b'],
    ['7k/8/8/8/8/8/p7/7K b - - 0 1', 'a2', 'a1', 'n'],
    ['7k/8/8/8/8/8/p7/7K b - - 0 1', 'a2', 'a1', 'b'],
  ])('immediately draws after lone-pawn underpromotion: %s %s%s%s', (fen, from, to, promotion) => {
    const chess = new Chess(fen)
    expect(outcome(chess).status).toBe('active')
    chess.move({ from, to, promotion })
    expect(outcome(chess)).toEqual({
      status: 'finished',
      result: '1/2-1/2',
      reason: 'Insufficient material',
    })
  })
  it.each([
    '7k/8/8/8/8/8/P7/KN6 w - - 0 1',
    '6rk/8/8/8/8/8/8/KB6 w - - 0 1',
    '6qk/8/8/8/8/8/8/KN6 w - - 0 1',
    '6nk/8/8/8/8/8/8/KN6 w - - 0 1',
  ])('does not declare insufficient material just by counting minor pieces: %s', (fen) => {
    expect(outcome(new Chess(fen)).status).toBe('active')
  })
  it.each(['n', 'b'])(
    'commits a lone %s promotion as a finished game for either actor',
    (piece) => {
      // Legal complete history reaching a two-kings/one-pawn endgame.
      const history = `d4 Nf6 c4 e6 Bf4 d5 e3 Bd6 Nf3 O-O Bd3 Bxf4 exf4 c5 O-O Nc6
      Bc2 dxc4 dxc5 Qxd1 Rxd1 Nd5 f5 Ndb4 Be4 exf5 Bd5 Nxd5 Rxd5 Be6 Rd2 Rfd8
      Nc3 Rd3 Rad1 Rxd2 Rxd2 Rd8 Rxd8+ Nxd8 Ne5 Nc6 Nxc6 bxc6 g3 Kf8 Kg2 Bd5+
      f3 Be6 h4 Ke7 Kh3 f4+ g4 h6 Ne2 g5 hxg5 hxg5 Nd4 Bd5 Kg2 Kf6 Kf2 c3
      bxc3 Bxa2 Nxc6 a6 Na5 Ke6 c6 Kd6 c4 Bxc4 Nxc4+ Kxc6 Ne5+ Kd5 Nxf7 Ke6
      Nxg5+ Kf6 Nh3 Ke5 Ke2 a5 Kd3 a4 Kc3 a3 Kb3 a2 Kxa2 Kd4 g5 Ke5 Kb3 Kf5
      Kc4 Ke5 Nxf4 Kxf4 g6 Kxf3 g7 Kf4`
        .trim()
        .split(/\s+/)
      const board = new Chess()
      const moves = history.map((san) => board.move(san))

      for (const color of ['w', 'b'] as const) {
        // Construct the fixture once; commitMove below replays its complete
        // history. Recommitting every prefix made this test quadratic.
        const game: Game = {
          ...newGame('alice', color, false),
          currentFen: board.fen(),
          version: moves.length,
          moveHistory: moves.map((move, index) => ({
            ply: index + 1,
            actor: move.color === color ? 'player' : 'opponent',
            color: move.color,
            san: move.san,
            uci: move.from + move.to + (move.promotion ?? ''),
            before: move.before,
            after: move.after,
          })),
        }
        const drawn = commitMove(
          game,
          game.version,
          `g7g8${piece}`,
          color === 'w' ? 'player' : 'opponent',
        )
        expect(drawn).toMatchObject({
          status: 'finished',
          result: '1/2-1/2',
          reason: 'Insufficient material',
        })
        expect(replay(drawn).get('g8')?.type).toBe(piece)
        expect(() => commitMove(drawn, drawn.version, 'f4f3', 'opponent')).toThrow(/ended/)
      }
    },
  )
  it('grounds the audited Kh8 reflection in both legal Black alternatives', () => {
    const board = new Chess('8/7k/5K2/8/6Q1/8/8/8 b - - 17 63')
    const move = board.move('Kh8')
    const game: Game = {
      ...newGame('alice', 'w', false),
      currentFen: board.fen(),
      version: 1,
      moveHistory: [
        {
          ply: 1,
          actor: 'opponent',
          color: 'b',
          san: move.san,
          uci: 'h7h8',
          before: move.before,
          after: move.after,
        },
      ],
    }
    const context = reviewedMoveContext(game, 1)
    expect(context.wasOnlyLegalMove).toBe(false)
    expect(context.legalAlternatives.sort()).toEqual(['Kh6', 'Kh8'])
  })
  it('historical context uses the selected position and cannot mutate the game', () => {
    const g = play(['e2e4', 'e7e5', 'g1f3'])
    const original = structuredClone(g)
    expect(positionAt(g, 0)).toBe(DEFAULT_POSITION)
    expect(chessContext(g, 1)).toMatchObject({
      fen: g.moveHistory[0].after,
      ply: 1,
      sideToMove: 'b',
      history: ['e4'],
    })
    expect(g).toEqual(original)
    expect(() => positionAt(g, 4)).toThrow(/does not exist/)
    expect(() => positionAt(g, -1)).toThrow(/does not exist/)
  })
  it('rejects corrupt FEN/history pairs', () => {
    const g = play(['e2e4'])
    g.currentFen = DEFAULT_POSITION
    expect(() => replay(g)).toThrow(/inconsistent/)
  })
})
