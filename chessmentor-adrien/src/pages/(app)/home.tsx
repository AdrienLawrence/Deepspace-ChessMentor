/**
 * Saved-game dashboard. DeepSpace useQuery supplies the authenticated game list.
 * Board thumbnails are rendered by src/components/chess/Chessboard.tsx.
 */

import { useState } from 'react'
import { Link } from 'react-router-dom'
// Browser authentication, hooks and data providers: node_modules/deepspace/dist/index.js.
// Public signatures: node_modules/deepspace/dist/index.d.ts.
import { AuthOverlay, useAuth, useQuery } from 'deepspace'
import { Plus, BookOpen, Sparkles, Clock3 } from 'lucide-react'
import type { Game } from '../../chess/types'
import { BoardThumbnail } from '../../components/chess/Chessboard'

export default function HomePage() {
  const { isSignedIn } = useAuth()
  const [auth, setAuth] = useState(false)
  const games = useQuery<Game>('games', { orderBy: 'updatedAt', orderDir: 'desc' })

  return (
    <div className="dashboard">
      <section className="dashboard-hero">
        <div>
          <div className="eyebrow">
            <Sparkles size={14} /> YOUR NEXT MOVE STARTS WITH UNDERSTANDING
          </div>
          <h1>
            See the board.
            <br />
            <span>Find your own way.</span>
          </h1>
          <p>
            Play with curiosity. Explore ideas with your mentor.
            <br className="desktop-break" /> Turn every position into a little more understanding.
          </p>
          {isSignedIn ? (
            <Link className="primary-button" to="/game/new">
              <Plus size={18} /> New game
            </Link>
          ) : (
            <button className="primary-button" onClick={() => setAuth(true)}>
              Sign in to start learning
            </button>
          )}
        </div>
        <div className="hero-motif" aria-hidden>
          <span>♞</span>
          <div className="motif-caption">
            LOOK AHEAD.
            <br />
            LEARN AS YOU PLAY.
          </div>
        </div>
      </section>
      <div className="dashboard-divider">
        <span>
          <BookOpen size={16} /> Your personal chess study
        </span>
        <span>No clock. Room to think.</span>
      </div>
      <section className="saved-games">
        <header>
          <div>
            <div className="eyebrow">PICK UP WHERE YOU LEFT OFF</div>
            <h2>My games</h2>
          </div>
          <span className="count-badge">{games.records.length} saved</span>
        </header>
        {games.status === 'error' ? (
          <p className="error-banner">Your saved games could not load. Refresh to reconnect.</p>
        ) : games.status === 'loading' && isSignedIn ? (
          <p className="muted">Loading your games…</p>
        ) : games.records.length ? (
          <div className="game-grid">
            {games.records.map((row) => {
              const g = row.data

              return (
                <Link
                  key={row.recordId}
                  className="game-card"
                  to={`/game/${row.recordId}${g.status === 'finished' ? '/analysis' : ''}`}
                >
                  <div className="mini-board">
                    <BoardThumbnail fen={g.currentFen} orientation={g.playerColor} />
                  </div>
                  <div className="game-card-info">
                    <span className={`game-badge ${g.status}`}>
                      {g.status === 'active' ? 'In progress' : g.reason}
                    </span>
                    <h3>You vs. OpenAI</h3>
                    <p>
                      Playing {g.playerColor === 'w' ? 'White' : 'Black'} · {g.moveHistory.length}{' '}
                      plies{g.status === 'finished' ? ` · ${g.result}` : ''}
                    </p>
                    <div className="game-card-footer">
                      <span>
                        <Clock3 size={12} />{' '}
                        {new Date(row.updatedAt).toLocaleDateString(undefined, {
                          month: 'short',
                          day: 'numeric',
                        })}
                      </span>
                      <strong>{g.status === 'active' ? 'Resume game' : 'Analyze game'}</strong>
                    </div>
                  </div>
                </Link>
              )
            })}
          </div>
        ) : (
          <div className="empty-games">
            <div className="empty-piece">♙</div>
            <h3>Your next lesson is on the board.</h3>
            <p>
              Start a game and make yourself at home. Your moves,
              <br /> conversations, and discoveries will be waiting here.
            </p>
            {isSignedIn ? (
              <Link className="secondary-button" to="/game/new">
                <Plus size={16} /> Create your first game
              </Link>
            ) : (
              <button className="secondary-button" onClick={() => setAuth(true)}>
                Sign in to save your games
              </button>
            )}
          </div>
        )}
      </section>
      <footer className="dashboard-footer">
        <span>CHESSMENTOR</span>
        <p>Better questions. Deeper understanding. Your move.</p>
      </footer>
      {auth && <AuthOverlay onClose={() => setAuth(false)} />}
    </div>
  )
}
