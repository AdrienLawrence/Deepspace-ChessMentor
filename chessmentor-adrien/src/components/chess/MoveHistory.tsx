/**
 * Presentation-only move list and navigation controls.
 * GameWorkspace.tsx owns the selected ply and restores live mode at the latest move.
 * The onSelect callbacks change that selection; they do not fetch data or request AI.
 */

import { ChevronLeft, ChevronRight, ChevronsLeft, Radio } from 'lucide-react'
import type { MoveEntry } from '../../chess/types'

export function MoveNavigation({
  ply,
  total,
  live,
  onSelect,
}: {
  ply: number
  total: number
  live: boolean
  onSelect: (ply: number | null) => void
}) {
  return (
    <div className="move-navigation">
      <div className="move-controls">
        <button aria-label="Starting position" disabled={!ply} onClick={() => onSelect(0)}>
          <ChevronsLeft size={18} />
        </button>
        <button aria-label="Previous move" disabled={!ply} onClick={() => onSelect(ply - 1)}>
          <ChevronLeft size={18} />
        </button>
        <span>{ply === 0 ? 'Starting position' : `Ply ${ply} of ${total}`}</span>
        <button aria-label="Next move" disabled={ply >= total} onClick={() => onSelect(ply + 1)}>
          <ChevronRight size={18} />
        </button>
      </div>
      <button className={`live-button ${live ? 'is-live' : ''}`} onClick={() => onSelect(null)}>
        <Radio size={14} />
        {live ? 'Live position' : 'Return to Live'}
      </button>
    </div>
  )
}

export function MoveHistory({
  moves,
  ply,
  onSelect,
}: {
  moves: MoveEntry[]
  ply: number
  onSelect: (ply: number) => void
}) {
  return (
    <div className="move-history">
      <div className="section-label">
        MOVE HISTORY <span>{moves.length} plies</span>
      </div>
      {!moves.length ? (
        <p className="muted small">Your first move begins the story.</p>
      ) : (
        <div className="move-list">
          {Array.from({ length: Math.ceil(moves.length / 2) }, (_, i) => (
            <div className="move-pair" key={i}>
              <span>{i + 1}.</span>
              {moves.slice(i * 2, i * 2 + 2).map((m) => (
                <button
                  key={m.ply}
                  aria-label={`View ply ${m.ply}: ${m.san}`}
                  aria-current={ply === m.ply ? 'step' : undefined}
                  className={ply === m.ply ? 'current' : ''}
                  onClick={() => onSelect(m.ply)}
                >
                  {m.san}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
