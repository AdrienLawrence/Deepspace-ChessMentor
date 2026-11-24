import { useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ChevronLeft, Sparkles, Shuffle } from 'lucide-react'
import { chessAction } from '../../../../chess/client'
import { ChessPiece } from '../../../../components/chess/ChessPiece'
export default function NewGamePage() {
  const [color, setColor] = useState<'w' | 'b' | 'random'>('w')
  const [feedback, setFeedback] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const id = useRef(crypto.randomUUID()),
    submitting = useRef(false),
    navigate = useNavigate()
  async function start() {
    if (submitting.current) return
    submitting.current = true
    setBusy(true)
    setError('')
    try {
      const game = await chessAction({
        op: 'create',
        requestId: id.current,
        color,
        automaticFeedback: feedback,
      })
      navigate(`/game/${game.gameId}`)
    } catch (e) {
      setError((e as Error).message)
      submitting.current = false
      setBusy(false)
    }
  }
  return (
    <div className="setup-page">
      <Link className="back-link" to="/home">
        <ChevronLeft size={16} /> Back to my games
      </Link>
      <div className="eyebrow">A LITTLE CURIOSITY GOES A LONG WAY</div>
      <h1>
        A fresh board.
        <br />
        <span>A new perspective.</span>
      </h1>
      <p className="lead">
        No clock. No pressure. Just you, the board, and a mentor to help you see what’s possible.
      </p>
      <form
        className="setup-card"
        onSubmit={(e) => {
          e.preventDefault()
          void start()
        }}
      >
        <fieldset disabled={busy}>
          <legend>Choose your side</legend>
          <div className="color-options">
            {(['w', 'b', 'random'] as const).map((c) => (
              <button
                key={c}
                type="button"
                className={color === c ? 'color-choice active' : 'color-choice'}
                aria-pressed={color === c}
                onClick={() => setColor(c)}
              >
                {c === 'random' ? <Shuffle size={36} /> : <ChessPiece type="k" color={c} />}
                <strong>{c === 'w' ? 'White' : c === 'b' ? 'Black' : 'Random'}</strong>
                <small>
                  {c === 'w'
                    ? 'Make the first move'
                    : c === 'b'
                      ? 'Let the opponent begin'
                      : 'A fresh point of view'}
                </small>
              </button>
            ))}
          </div>
          <label className="feedback-toggle">
            <span>
              <strong>Reflect after each move</strong>
              <small>Get automatic mentor feedback. You can always ask questions yourself.</small>
            </span>
            <input
              type="checkbox"
              role="switch"
              checked={feedback}
              onChange={(e) => setFeedback(e.target.checked)}
            />
          </label>
        </fieldset>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <button className="primary-button start-button" disabled={busy}>
          {busy ? 'Preparing your board…' : 'Start learning'}
        </button>
        <p className="setup-note">
          <Sparkles size={14} /> Your progress and conversations are saved automatically.
        </p>
      </form>
    </div>
  )
}
