/**
 * Board rendering, square selection, promotion choices and annotation geometry.
 * chess.js generates candidate moves for the supplied FEN; server rules revalidate submissions.
 * ChessPiece.tsx owns the SVG artwork. onMove is supplied by GameWorkspace.tsx,
 * or omitted for BoardThumbnail: this component never saves a move itself.
 */

import { useId, useMemo, useState } from 'react'
// Chess rules and notation are implemented by the chess.js dependency (node_modules/chess.js).
import { Chess, type Square } from 'chess.js'
import type { Annotation, Color } from '../../chess/types'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '../ui/Dialog'
import { ChessPiece, PieceArt, type PieceKind } from './ChessPiece'

const names: Record<string, string> = {
  k: 'king',
  q: 'queen',
  r: 'rook',
  b: 'bishop',
  n: 'knight',
  p: 'pawn',
}

const tones = { red: '#ed7373', blue: '#77aeed', yellow: '#edc66e', green: '#8ac9a2' }

/** Map algebraic square coordinates to the displayed orientation, shared by annotation shapes. */
export function boardPoint(square: string, orientation: Color) {
  const file = square.charCodeAt(0) - 97
  const rank = Number(square[1]) - 1

  return orientation === 'w' ? { x: file, y: 7 - rank } : { x: 7 - file, y: rank }
}

export function AnnotationOverlay({
  annotations,
  orientation,
}: {
  annotations: Annotation[]
  orientation: Color
}) {
  const id = useId().replace(/:/g, '')

  return (
    <svg className="annotation-overlay" viewBox="0 0 800 800" aria-label="Mentor board annotations">
      <defs>
        {Object.entries(tones).map(([tone, color]) => (
          <marker
            key={tone}
            id={`${id}-${tone}`}
            markerWidth="3.5"
            markerHeight="3.5"
            refX="2.7"
            refY="1.75"
            orient="auto"
          >
            <path d="M0 0 L3.5 1.75 L0 3.5 Z" fill={color} />
          </marker>
        ))}
      </defs>
      {annotations.map((a, i) => {
        const p = boardPoint(a.type === 'arrow' ? a.from : a.square, orientation)

        if (a.type === 'highlight')
          return (
            <rect
              key={i}
              x={p.x * 100 + 5}
              y={p.y * 100 + 5}
              width="90"
              height="90"
              rx="7"
              fill={tones[a.tone]}
              fillOpacity=".28"
              stroke={tones[a.tone]}
              strokeWidth="5"
            >
              <title>{a.label || a.tone}</title>
            </rect>
          )

        const q = boardPoint(a.to, orientation)

        return (
          <line
            key={i}
            x1={p.x * 100 + 50}
            y1={p.y * 100 + 50}
            x2={q.x * 100 + 50}
            y2={q.y * 100 + 50}
            stroke={tones[a.tone]}
            strokeOpacity=".85"
            strokeWidth="13"
            strokeLinecap="round"
            markerEnd={`url(#${id}-${a.tone})`}
          >
            <title>{a.label || a.tone}</title>
          </line>
        )
      })}
    </svg>
  )
}

interface Props {
  fen: string
  orientation: Color
  interactive?: boolean
  lastMove?: string
  annotations?: Annotation[]
  onMove?: (uci: string) => void
}

export function Chessboard({
  fen,
  orientation,
  interactive = false,
  lastMove,
  annotations = [],
  onMove,
}: Props) {
  const chess = useMemo(() => new Chess(fen), [fen])
  const [selected, setSelected] = useState<Square | null>(null)
  const [promotion, setPromotion] = useState<string | null>(null)
  const moves = selected ? chess.moves({ square: selected, verbose: true }) : []
  const files = orientation === 'w' ? 'abcdefgh' : 'hgfedcba'
  const ranks = orientation === 'w' ? '87654321' : '12345678'

  function choose(square: Square) {
    if (!interactive) return

    const candidates = moves.filter((m) => m.to === square)

    if (selected && candidates.length) {
      const uci = selected + square

      if (candidates.some((m) => m.promotion)) setPromotion(uci)
      else onMove?.(uci)

      setSelected(null)
    } else
      setSelected(
        chess.get(square)?.color === chess.turn() ? (square === selected ? null : square) : null,
      )
  }

  function moveFocus(event: React.KeyboardEvent<HTMLButtonElement>, row: number, column: number) {
    const delta: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    }

    if (event.key === 'Escape') {
      setSelected(null)
      setPromotion(null)
    }
    if (!delta[event.key]) return

    event.preventDefault()
    const [dr, dc] = delta[event.key]
    const next = event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(
      `[data-cell="${Math.max(0, Math.min(7, row + dr))}-${Math.max(0, Math.min(7, column + dc))}"]`,
    )
    next?.focus()
  }

  return (
    <div className="board-shell">
      <div
        className="chessboard"
        role="group"
        aria-label={`${orientation === 'w' ? 'White' : 'Black'} at bottom. Chessboard`}
      >
        {[...ranks].flatMap((rank, row) =>
          [...files].map((file, col) => {
            const square = (file + rank) as Square
            const piece = chess.get(square)
            const destination = interactive && moves.some((m) => m.to === square)
            const check = piece?.type === 'k' && piece.color === chess.turn() && chess.isCheck()

            return (
              <button
                key={square}
                type="button"
                data-cell={`${row}-${col}`}
                data-square={square}
                className={`square ${(row + col) % 2 ? 'dark' : 'light'} ${selected === square ? 'selected' : ''} ${lastMove?.slice(0, 2) === square || lastMove?.slice(2, 4) === square ? 'last-move' : ''} ${check ? 'in-check' : ''}`}
                aria-label={`${square}${piece ? ` ${piece.color === 'w' ? 'White' : 'Black'} ${names[piece.type]}` : ' empty'}${destination ? ', legal destination' : ''}`}
                aria-pressed={selected === square}
                aria-disabled={!interactive}
                onClick={() => choose(square)}
                onKeyDown={(e) => moveFocus(e, row, col)}
              >
                {col === 0 && (
                  <span className="rank-label" aria-hidden>
                    {rank}
                  </span>
                )}
                {row === 7 && (
                  <span className="file-label" aria-hidden>
                    {file}
                  </span>
                )}
                {piece && <ChessPiece type={piece.type} color={piece.color} className="piece" />}
                {destination && <span className={piece ? 'capture-ring' : 'move-dot'} />}
              </button>
            )
          }),
        )}
        <AnnotationOverlay annotations={annotations} orientation={orientation} />
        <Dialog
          open={!!promotion}
          onOpenChange={(open) => {
            if (!open) setPromotion(null)
          }}
        >
          <DialogContent>
            <DialogTitle>Promote your pawn</DialogTitle>
            <DialogDescription>Choose the piece your pawn becomes.</DialogDescription>
            <div className="promotion-choices">
              {['q', 'r', 'b', 'n'].map((p) => (
                <button
                  className="promotion-piece"
                  key={p}
                  aria-label={`Promote to ${names[p]}`}
                  onClick={() => {
                    if (promotion) onMove?.(promotion + p)

                    setPromotion(null)
                  }}
                >
                  <ChessPiece type={p as PieceKind} color={chess.turn()} />
                </button>
              ))}
            </div>
            <button className="text-button" onClick={() => setPromotion(null)}>
              Cancel
            </button>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  )
}

/** Decorative game-card board: no nested controls or extra keyboard stops. */
export function BoardThumbnail({ fen, orientation }: { fen: string; orientation: Color }) {
  const chess = useMemo(() => new Chess(fen), [fen])

  return (
    <div className="board-shell">
      <svg viewBox="0 0 80 80" role="img" aria-label="Saved game position">
        {Array.from({ length: 64 }, (_, i) => (
          <rect
            key={i}
            x={(i % 8) * 10}
            y={Math.floor(i / 8) * 10}
            width="10"
            height="10"
            fill={((i % 8) + Math.floor(i / 8)) % 2 ? '#9c8360' : '#e2d4b8'}
          />
        ))}
        {chess
          .board()
          .flat()
          .filter((p) => p !== null)
          .map((p) => {
            const at = boardPoint(p.square, orientation)

            return (
              <svg
                key={p.square}
                x={at.x * 10}
                y={at.y * 10}
                width="10"
                height="10"
                viewBox="0 0 45 45"
              >
                <PieceArt type={p.type} color={p.color} />
              </svg>
            )
          })}
      </svg>
    </div>
  )
}
