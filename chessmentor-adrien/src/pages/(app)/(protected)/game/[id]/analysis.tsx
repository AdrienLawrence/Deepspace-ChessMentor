/**
 * Analysis route: reuse GameWorkspace.tsx with automatic live-play requests disabled.
 * Board navigation and questions still use the shared workspace implementation.
 */

import GamePage from '../../../../../components/chess/GameWorkspace'

export default function AnalysisPage() {
  return <GamePage analysis />
}
