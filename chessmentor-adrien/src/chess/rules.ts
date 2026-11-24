import { ChessError } from './errors'
import { Chess, DEFAULT_POSITION } from 'chess.js'
import type { Game, Color } from './types'

export function newGame(playerId: string, playerColor: Color, automaticFeedback: boolean): Game {
  return {
    playerId,
    playerColor,
    automaticFeedback,
    currentFen: DEFAULT_POSITION,
    moveHistory: [],
    status: 'active',
    result: '*',
    reason: '',
    version: 0,
  }
}
export function positionAt(game: Game, ply: number): string {
  if (!Number.isInteger(ply) || ply < 0 || ply > game.moveHistory.length)
    throw new ChessError('That position does not exist.')
  return ply === 0 ? DEFAULT_POSITION : game.moveHistory[ply - 1].after
}
export function replay(game: Game): Chess {
  const chess = new Chess()
  for (const move of game.moveHistory) chess.move(move.san)
  if (chess.fen() !== game.currentFen) throw new ChessError('Game history is inconsistent.')
  return chess
}
export function assertRevision(game: Game, version: number) {
  if (game.status !== 'active') throw new ChessError('This game has ended.')
  if (game.version !== version)
    throw new ChessError('The position changed. Return to Live and try again.')
}
export function outcome(chess: Chess): Pick<Game, 'status' | 'result' | 'reason'> {
  if (chess.isCheckmate())
    return { status: 'finished', result: chess.turn() === 'w' ? '0-1' : '1-0', reason: 'Checkmate' }
  const reason = chess.isStalemate()
    ? 'Stalemate'
    : chess.isInsufficientMaterial()
      ? 'Insufficient material'
      : chess.isThreefoldRepetition()
        ? 'Threefold repetition'
        : chess.isDrawByFiftyMoves()
          ? 'Fifty-move rule'
          : ''
  return reason
    ? { status: 'finished', result: '1/2-1/2', reason }
    : { status: 'active', result: '*', reason: '' }
}
export function commitMove(
  game: Game,
  version: number,
  uci: string,
  actor: 'player' | 'opponent',
): Game {
  assertRevision(game, version)
  const chess = replay(game)
  if ((chess.turn() === game.playerColor) !== (actor === 'player'))
    throw new ChessError('It is not your turn.')
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) throw new ChessError('Invalid move notation.')
  let move
  try {
    move = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] })
  } catch {
    throw new ChessError('That move is not legal. Choose a legal destination and promotion piece.')
  }
  return {
    ...game,
    ...outcome(chess),
    opponentRetry: null,
    currentFen: chess.fen(),
    version: game.version + 1,
    moveHistory: [
      ...game.moveHistory,
      {
        ply: game.moveHistory.length + 1,
        actor,
        color: move.color,
        san: move.san,
        uci,
        before: move.before,
        after: move.after,
      },
    ],
  }
}
export function resign(game: Game, version: number): Game {
  assertRevision(game, version)
  return {
    ...game,
    status: 'finished',
    result: game.playerColor === 'w' ? '0-1' : '1-0',
    reason: 'Resignation',
    version: game.version + 1,
  }
}
export function branchGame(
  game: Game,
  parentGameId: string,
  ply: number,
  fen: string,
  uci: string,
): Game {
  if (ply >= game.moveHistory.length) throw new ChessError('Choose an earlier position to branch.')
  if (positionAt(game, ply) !== fen) throw new ChessError('The branch refers to a different board.')
  if (game.moveHistory[ply].uci === uci)
    throw new ChessError('Choose a different next move for your branch.')
  const prefix = {
    ...game,
    currentFen: fen,
    moveHistory: game.moveHistory.slice(0, ply),
    version: ply,
  }
  const chess = replay(prefix)
  const start = { ...prefix, ...outcome(chess), parentGameId, branchPly: ply }
  return commitMove(start, ply, uci, chess.turn() === game.playerColor ? 'player' : 'opponent')
}
export function chessContext(game: Game, ply: number) {
  const fen = positionAt(game, ply)
  const chess = new Chess(fen)
  return {
    livePosition: game.status === 'active' && ply === game.moveHistory.length,
    gameStatus: game.status,
    result: game.result,
    fen,
    ply,
    board: chess.board(),
    playerColor: game.playerColor,
    sideToMove: chess.turn(),
    check: chess.isCheck(),
    legalMoves: chess
      .moves({ verbose: true })
      .map((m) => ({ uci: m.from + m.to + (m.promotion ?? ''), san: m.san })),
    history: game.moveHistory.slice(Math.max(0, ply - 24), ply).map((m) => m.san),
  }
}

export function reviewedMoveContext(game: Game, ply: number) {
  const move = game.moveHistory[ply - 1]
  if (!move) throw new ChessError('That move does not exist.')
  const before = new Chess(move.before)
  // SAN is sufficient for feedback and keeps the added input small.
  const legalAlternatives = before.moves()
  return { move, wasOnlyLegalMove: legalAlternatives.length === 1, legalAlternatives }
}
