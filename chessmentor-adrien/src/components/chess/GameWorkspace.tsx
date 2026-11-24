/**
 * Connect the subscribed game record to board, history and mentor UI.
 * DeepSpace useQuery owns confirmed data. Local optimistic/branch state only previews it.
 * src/chess/rules.ts computes positions; src/chess/client.ts sends commands to the server.
 * Chessboard.tsx handles selection, MoveHistory.tsx navigation, and MentorPanel.tsx chat.
 */

import { useEffect, useRef, useState } from 'react'
import { Link, useParams, useNavigate } from 'react-router-dom'
// Browser authentication, hooks and data providers: node_modules/deepspace/dist/index.js.
// Public signatures: node_modules/deepspace/dist/index.d.ts.
import { useQuery } from 'deepspace'
// Chess rules and notation are implemented by the chess.js dependency (node_modules/chess.js).
import { Chess } from 'chess.js'
import { Flag, Sparkles, BookOpen, RotateCcw, X, ChevronLeft } from 'lucide-react'
import { Chessboard } from './Chessboard'
import { MoveHistory, MoveNavigation } from './MoveHistory'
import { MentorPanel } from './MentorPanel'
import { chessAction } from '../../chess/client'
import { positionAt, commitMove, branchGame } from '../../chess/rules'
import { materialAt } from '../../chess/material'
import type { Annotation, Game, Message, Feedback, Row } from '../../chess/types'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '../ui'

export default function GamePage({ analysis = false }: { analysis?: boolean }) {
  const { id = '' } = useParams()
  const games = useQuery<Game>('games', { where: { recordId: id } })

  if (games.status === 'error')
    return (
      <div className="page-state" role="alert">
        Unable to connect to saved games. Please refresh to reconnect.
      </div>
    )
  if (games.status !== 'ready')
    return (
      <div className="page-state" aria-busy="true">
        Opening your board…
      </div>
    )

  const record = games.records[0]

  if (!record)
    return (
      <div className="page-state">
        <h1>Game not found</h1>
        <p>This game is unavailable or belongs to another account.</p>
        <Link className="primary-button" to="/home">
          Back to games
        </Link>
      </div>
    )

  return <Workspace key={`${id}-${analysis}`} record={record} analysis={analysis} />
}

function Workspace({ record, analysis }: { record: Row<Game>; analysis: boolean }) {
  const go = useNavigate()

  // The parent keeps useQuery subscribed. Preview a move only until the saved
  // revision catches up; never write optimistic state into the SDK record cache.
  const [optimistic, setOptimistic] = useState<Game | null>(null)
  const confirmed = record.data
  const pendingMove = !!optimistic && confirmed.version < optimistic.version
  const game = optimistic && pendingMove ? optimistic : confirmed
  const id = record.recordId
  const total = game.moveHistory.length

  // Saved conversation and feedback keep their own subscriptions to the same game.
  const messages = useQuery<Message>('game_messages', {
    where: { gameId: id },
    orderBy: 'createdAt',
    orderDir: 'asc',
  })
  const feedback = useQuery<Feedback>('move_feedback', { where: { gameId: id } })

  // null means live; a number selects a historical ply without changing the game.
  const [viewed, setViewed] = useState<number | null>(null)
  const [selection, setSelection] = useState<{
    ply: number
    annotations: Annotation[]
    id: string
  } | null>(null)
  const [moving, setMoving] = useState(false)
  const [thinking, setThinking] = useState(false)
  const [asking, setAsking] = useState(false)
  const [error, setError] = useState('')
  const [aiError, setAiError] = useState('')
  const [feedbackError, setFeedbackError] = useState('')
  const [confirmResign, setConfirmResign] = useState(false)

  // A historical move stays a draft until createBranch sends the server command.
  const [branchDraft, setBranchDraft] = useState<{
    ply: number
    fen: string
    uci: string
    requestId: string
    previewFen: string
  } | null>(null)
  const branchButton = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!branchDraft) return

    branchButton.current?.focus({ preventScroll: true })
    branchButton.current?.scrollIntoView({ block: 'nearest' })
  }, [branchDraft])

  // Refs prevent duplicate submissions between renders; state drives visible feedback.
  const attempted = useRef(new Set<number>())
  const feedbackAttempts = useRef(new Set<number>())
  const feedbackInFlight = useRef(false)
  const [reflecting, setReflecting] = useState(false)
  const moveLock = useRef(false)
  const opponentLock = useRef(false)
  const [thinkingSince, setThinkingSince] = useState<number | null>(null)
  const [elapsed, setElapsed] = useState(0)

  // Confirmation comes from useQuery, not merely from the HTTP request finishing.
  useEffect(() => {
    if (optimistic && confirmed.version >= optimistic.version) setOptimistic(null)
  }, [confirmed.version, optimistic])

  useEffect(() => {
    if (thinkingSince === null) return

    const timer = window.setInterval(
      () => setElapsed(Math.floor((Date.now() - thinkingSince) / 1000)),
      1000,
    )

    return () => window.clearInterval(timer)
  }, [thinkingSince])

  const [feedbackRetry, setFeedbackRetry] = useState(0)

  // rules.ts reconstructs the viewed position; material.ts counts the shown pieces.
  const ply = Math.min(viewed ?? total, total)
  const fen = positionAt(game, ply)
  const displayedFen = branchDraft?.previewFen ?? fen
  const current = new Chess(game.currentFen)
  const material = materialAt(displayedFen)
  const aiTurn = game.status === 'active' && current.turn() !== game.playerColor
  const live = viewed === null
  const branchable = ply < total && new Chess(fen).turn() === game.playerColor
  const interactive =
    !moving &&
    !pendingMove &&
    !branchDraft &&
    (branchable || (!analysis && live && game.status === 'active' && !aiTurn))
  const annotations = selection?.ply === ply ? selection.annotations : []

  // chessAction in src/chess/client.ts is the transport. The server chooses and
  // validates the opponent move in src/chess/service.ts; the UI never selects it.
  async function opponent() {
    if (opponentLock.current || pendingMove) return

    opponentLock.current = true
    setThinking(true)
    setThinkingSince(Date.now())
    setElapsed(0)
    setAiError('')

    try {
      await chessAction({ op: 'opponent', gameId: id, version: game.version })
    } catch (e) {
      setAiError(e instanceof Error ? e.message : 'Opponent unavailable.')
    } finally {
      opponentLock.current = false
      setThinking(false)
      setThinkingSince(null)
    }
  }

  useEffect(() => {
    if (analysis || pendingMove || !aiTurn || attempted.current.has(game.version)) return

    attempted.current.add(game.version)
    void opponent()
    // The immutable revision identifies one opponent turn, including remount recovery.
  }, [id, game.version, aiTurn, analysis, pendingMove])

  // Fill one missing reflection at a time. service.ts rechecks ownership and
  // duplicate results before ai.ts makes a paid request through the provider.
  useEffect(() => {
    if (
      analysis ||
      pendingMove ||
      !game.automaticFeedback ||
      feedback.status !== 'ready' ||
      aiTurn ||
      thinking ||
      feedbackInFlight.current ||
      feedbackError
    )
      return

    const missing = game.moveHistory.find(
      (m) =>
        m.ply > (game.branchPly ?? 0) &&
        !feedback.records.some((f) => f.data.ply === m.ply) &&
        !feedbackAttempts.current.has(m.ply),
    )

    if (!missing) return

    feedbackAttempts.current.add(missing.ply)
    feedbackInFlight.current = true
    setReflecting(true)
    void chessAction({ op: 'feedback', gameId: id, ply: missing.ply })
      .catch((e) => setFeedbackError(e.message))
      .finally(() => {
        feedbackInFlight.current = false
        setReflecting(false)
        setFeedbackRetry((n) => n + 1)
      })
  }, [
    analysis,
    pendingMove,
    game.automaticFeedback,
    game.moveHistory,
    feedback.status,
    feedback.records,
    aiTurn,
    thinking,
    id,
    feedbackRetry,
    feedbackError,
  ])

  async function move(uci: string) {
    if (moveLock.current || moving || pendingMove || branchDraft) return
    if (branchable) {
      try {
        // Shared pure helper in src/chess/rules.ts; no branch is saved yet.
        const preview = branchGame(game, id, ply, fen, uci)
        setBranchDraft({
          ply,
          fen,
          uci,
          requestId: crypto.randomUUID(),
          previewFen: preview.currentFen,
        })
        setSelection(null)
        setError('')
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not preview that move.')
      }

      return
    }

    let preview: Game

    try {
      // Reuse the server's rules for instant feedback, then submit for authority.
      preview = commitMove(confirmed, confirmed.version, uci, 'player')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Invalid move.')

      return
    }

    moveLock.current = true
    setOptimistic(preview)
    setMoving(true)
    setError('')
    setSelection(null)

    try {
      await chessAction({ op: 'move', gameId: id, version: confirmed.version, uci })
    } catch (e) {
      // The latest subscribed record becomes visible again if saving fails.
      setOptimistic(null)
      setError(e instanceof Error ? e.message : 'Could not save move.')
    } finally {
      moveLock.current = false
      setMoving(false)
    }
  }

  async function ask(question: string, requestId: string, targetPly: number, targetFen?: string) {
    setAsking(true)
    setError('')

    try {
      await chessAction({
        op: 'ask',
        gameId: id,
        question,
        requestId,
        ply: targetPly,
        fen: targetFen ?? positionAt(game, targetPly),
      })

      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send question.')

      return false
    } finally {
      setAsking(false)
    }
  }

  function navigate(p: number | null) {
    if (pendingMove || moving) return

    setViewed(p === total ? null : p)
    setSelection(null)
    setBranchDraft(null)
  }

  async function createBranch() {
    if (!branchDraft || moving || moveLock.current) return

    moveLock.current = true
    setMoving(true)
    setError('')

    try {
      const { previewFen: _preview, ...command } = branchDraft
      const created = await chessAction({ op: 'branch', gameId: id, ...command })
      go(`/game/${created.gameId}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create branch.')
    } finally {
      moveLock.current = false
      setMoving(false)
    }
  }

  const color = game.playerColor === 'w' ? 'White' : 'Black'
  const status = pendingMove
    ? 'Saving your move…'
    : ply < total
      ? branchable
        ? 'Your turn · History'
        : 'Opponent’s turn · History'
      : game.status === 'finished'
        ? `${game.reason} · ${game.result}`
        : thinking
          ? `Opponent is thinking · ${elapsed}s`
          : aiTurn
            ? 'Opponent’s turn'
            : current.isCheck()
              ? 'Your turn · Check'
              : 'Your turn'

  return (
    <div className="workspace-page">
      <div className="workspace-top">
        <div>
          <Link className="back-link" to="/home">
            <ChevronLeft size={15} /> My games
          </Link>
          <h1>{analysis ? 'Every move, a lesson.' : 'Make your next move count.'}</h1>
          {game.parentGameId && (
            <Link className="back-link" to={`/game/${game.parentGameId}/analysis`}>
              Branched after ply {game.branchPly} · View original game
            </Link>
          )}
        </div>
        <div className="workspace-actions">
          {!analysis && (
            <Link className="secondary-button" to={`/game/${id}/analysis`}>
              <BookOpen size={16} /> Analyze
            </Link>
          )}
          {analysis && game.status === 'active' && (
            <Link className="primary-button" to={`/game/${id}`}>
              Resume game
            </Link>
          )}
          {!analysis && game.status === 'active' && (
            <button
              className="icon-button"
              aria-label="Resign game"
              disabled={moving || pendingMove}
              onClick={() => setConfirmResign(true)}
            >
              <Flag size={17} />
            </button>
          )}
        </div>
      </div>
      {(error || aiError) && (
        <div className="error-banner" role="alert">
          <span>{error || aiError}</span>
          {aiError && (
            <button disabled={thinking} onClick={() => void opponent()}>
              <RotateCcw size={14} /> Retry opponent
            </button>
          )}
          {error && (
            <button aria-label="Dismiss error" onClick={() => setError('')}>
              <X size={16} />
            </button>
          )}
        </div>
      )}
      <div className="game-workspace">
        <section className="board-section">
          <div className="player-strip">
            <div className="player-avatar opponent-avatar">♞</div>
            <div>
              <strong>OpenAI opponent</strong>
              <span>{game.playerColor === 'w' ? 'Black' : 'White'} pieces</span>
            </div>
            {branchDraft ? (
              <div className="branch-callout" role="group" aria-label="Branch preview actions">
                <button
                  className="create-branch-button"
                  ref={branchButton}
                  disabled={moving}
                  onClick={() => void createBranch()}
                >
                  {moving ? 'Creating…' : '+ Create branch'}
                </button>
                <button
                  className="cancel-branch-button"
                  aria-label="Cancel branch preview"
                  disabled={moving}
                  onClick={() => setBranchDraft(null)}
                >
                  <X size={16} />
                </button>
              </div>
            ) : (
              <span className={`status-pill ${thinking ? 'thinking-pill' : ''}`}>
                {thinking && <span className="pulse" />}
                {status}
              </span>
            )}
          </div>
          {thinking && (
            <p className="thinking-note" role="status">
              {elapsed >= 25
                ? 'Still waiting for the opponent. The request may be queued or taking longer to process.'
                : elapsed >= 10
                  ? 'The opponent is taking a little longer. You can review earlier moves while you wait.'
                  : 'Waiting for the opponent’s response…'}
            </p>
          )}
          {(!live || analysis) && (
            <div className="history-banner">
              <BookOpen size={15} />
              {analysis ? 'Analysis mode' : 'Viewing history'} ·{' '}
              {ply === 0 ? 'Starting position' : `Ply ${ply}`}
              <span>
                {branchDraft
                  ? 'Alternative move preview'
                  : branchable
                    ? 'Your pieces are playable'
                    : 'Read-only board'}
              </span>
            </div>
          )}
          <div className="board-tools">
            {annotations.length > 0 && (
              <button className="secondary-button" onClick={() => setSelection(null)}>
                <X size={14} /> Clear annotations
              </button>
            )}
          </div>
          <Chessboard
            key={`${displayedFen}-${interactive}`}
            fen={displayedFen}
            orientation={game.playerColor}
            interactive={interactive}
            lastMove={branchDraft?.uci ?? game.moveHistory[ply - 1]?.uci}
            annotations={annotations}
            onMove={(uci) => void move(uci)}
          />
          <div
            className="material-counter"
            aria-label="Material count"
            title="Pawn 1 · Knight 3 · Bishop 3 · Rook 5 · Queen 9. Material only, not an engine evaluation."
          >
            <span>
              Material · White {material.w} · Black {material.b}
            </span>
            <strong>
              {material.difference === 0
                ? 'Equal'
                : `${material.difference > 0 ? 'White' : 'Black'} +${Math.abs(material.difference)}`}
            </strong>
          </div>
          <div className="player-strip bottom-player">
            <div className="player-avatar human-avatar">{game.playerColor === 'w' ? '♔' : '♚'}</div>
            <div>
              <strong>
                You <span className="you-badge">LEARNING</span>
              </strong>
              <span>
                {color} pieces ·{' '}
                {branchDraft
                  ? 'Previewing an alternative'
                  : moving || pendingMove
                    ? 'Saving move…'
                    : game.status === 'finished'
                      ? 'Game complete'
                      : 'Take your time'}
              </span>
            </div>
            <span className="saved-label">
              {branchDraft
                ? 'Branch preview'
                : moving
                  ? 'Saving…'
                  : pendingMove
                    ? 'Syncing…'
                    : 'Game saved'}
            </span>
          </div>
          <MoveNavigation ply={ply} total={total} live={live} onSelect={navigate} />
          {annotations.length > 0 && (
            <div className="annotation-legend">
              <span>Threat</span>
              <span>Defense</span>
              <span>Focus</span>
              <span>Opportunity</span>
            </div>
          )}
          <MoveHistory moves={game.moveHistory} ply={ply} onSelect={navigate} />
          {feedbackError && (
            <div className="feedback-error">
              {feedbackError}{' '}
              <button
                onClick={() => {
                  feedbackAttempts.current.clear()
                  setFeedbackError('')
                  setFeedbackRetry((n) => n + 1)
                }}
              >
                Retry feedback
              </button>
            </div>
          )}
          <div className="board-tip">
            <Sparkles size={16} />
            <p>
              {analysis
                ? 'Select any move or mentor message to revisit its position.'
                : 'Before you move, ask why. Your mentor is here to help you see the board.'}
            </p>
          </div>
          {game.status === 'finished' && !pendingMove && !branchDraft && (
            <div className="game-summary">
              <h2>
                {game.result === '1/2-1/2'
                  ? 'A drawn game'
                  : game.result === (game.playerColor === 'w' ? '1-0' : '0-1')
                    ? 'You won this game'
                    : 'A game to learn from'}
              </h2>
              <p>
                {game.reason} · {Math.ceil(total / 2)} moves · Played as {color}
              </p>
              <Link className="primary-button" to="/game/new">
                Start another game
              </Link>
            </div>
          )}
        </section>
        <MentorPanel
          messages={messages.records}
          feedback={feedback.records}
          ply={ply}
          busy={asking}
          savingMove={pendingMove}
          previewingBranch={!!branchDraft}
          reflecting={reflecting}
          selectedId={selection?.id}
          onAsk={ask}
          onSelect={(p, a, selectedId) => {
            if (pendingMove || moving) return

            setViewed(p === total && !analysis ? null : p)
            setBranchDraft(null)
            setSelection({ ply: p, annotations: a, id: selectedId })
          }}
        />
      </div>
      {(messages.status === 'error' || feedback.status === 'error') && (
        <p className="error-banner">Some saved coaching could not load. Refresh to reconnect.</p>
      )}
      <Dialog open={confirmResign} onOpenChange={setConfirmResign}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Resign this game?</DialogTitle>
            <DialogDescription>
              Your opponent wins. You can still review every move and keep learning in analysis.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button className="secondary-button" onClick={() => setConfirmResign(false)}>
              Keep playing
            </button>
            <button
              className="primary-button"
              disabled={moving}
              onClick={async () => {
                setMoving(true)

                try {
                  await chessAction({ op: 'resign', gameId: id, version: game.version })
                  setConfirmResign(false)
                } catch (e) {
                  setError((e as Error).message)
                } finally {
                  setMoving(false)
                }
              }}
            >
              Resign game
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
