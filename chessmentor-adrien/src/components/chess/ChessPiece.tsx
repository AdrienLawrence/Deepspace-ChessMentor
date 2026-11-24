/**
 * Shared SVG piece artwork for Chessboard.tsx, thumbnails and promotion choices.
 * Explicit colors keep white/black pieces consistent across browsers and operating systems.
 */

import type { Color } from '../../chess/types'

export type PieceKind = 'p' | 'n' | 'b' | 'r' | 'q' | 'k'

// Original vector artwork: explicit paint, never a platform font or emoji.
export function PieceArt({ type, color }: { type: PieceKind; color: Color }) {
  const fill = color === 'w' ? '#fff9ec' : '#242622'
  const stroke = color === 'w' ? '#302b22' : '#d5c6a9'

  return (
    <g fill={fill} stroke={stroke} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round">
      {type === 'p' && (
        <>
          <path d="M17 19h11l-2 7 5 7H14l5-7z" />
          <circle cx="22.5" cy="13" r="6.5" />
        </>
      )}
      {type === 'r' && (
        <>
          <path d="M12 8h5v6h4V8h4v6h4V8h5v12l-5 4v9H16v-9l-4-4z" />
          <path d="M16 21h13M17 29h11" fill="none" />
        </>
      )}
      {type === 'b' && (
        <>
          <path d="M22.5 7c-3 5-10 9-10 15 0 4 4 6 7 7l-3 4h13l-3-4c4-1 7-3 7-7 0-6-7-10-10.5-15z" />
          <path d="m23 12 5 8M17 27h11" fill="none" />
          <circle cx="22.5" cy="6" r="2" />
        </>
      )}
      {type === 'n' && (
        <>
          <path d="M13 33c1-6 5-10 11-13l-6-1-5 5-5-4 6-9 8-3 4-4 1 6c8 5 9 14 7 23z" />
          <path d="M25 15c5 5 6 11 4 15M14 16l3-1" fill="none" />
          <circle cx="21" cy="13" r="1.1" fill={stroke} stroke="none" />
        </>
      )}
      {type === 'q' && (
        <>
          <path d="m10 13 6 8 6.5-12 6.5 12 6-8-5 19H15z" />
          <path d="M16 27h13" fill="none" />
          <circle cx="10" cy="11" r="2.5" />
          <circle cx="22.5" cy="7" r="2.5" />
          <circle cx="35" cy="11" r="2.5" />
        </>
      )}
      {type === 'k' && (
        <>
          <path d="M20 4h5v5h4v4h-4v5h-5v-5h-4V9h4z" />
          <path d="M16 32c0-6-7-10-5-15 2-5 8-4 11.5 1C26 13 32 12 34 17c2 5-5 9-5 15z" />
          <path d="M16 27h13" fill="none" />
        </>
      )}
      <path d="M14 33h17l4 7H10z" />
      <path d="M12 37h21" fill="none" />
    </g>
  )
}

export function ChessPiece({
  type,
  color,
  className = '',
}: {
  type: PieceKind
  color: Color
  className?: string
}) {
  return (
    <svg
      className={`chess-piece ${className}`}
      viewBox="0 0 45 45"
      aria-hidden="true"
      focusable="false"
      data-piece={type}
      data-color={color}
    >
      <PieceArt type={type} color={color} />
    </svg>
  )
}
