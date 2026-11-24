import type { CollectionSchema } from 'deepspace/schema'
const locked = { read: 'own', create: false, update: false, delete: false } as const
function collection(
  name: string,
  fields: string[],
  numbers: string[] = [],
  json: string[] = [],
): CollectionSchema {
  return {
    name,
    ownerField: 'playerId',
    permissions: {
      '*': { read: false, create: false, update: false, delete: false },
      viewer: { read: false, create: false, update: false, delete: false },
      member: locked,
      admin: locked,
    },
    columns: [
      {
        name: 'playerId',
        storage: 'text',
        interpretation: 'plain',
        userBound: true,
        immutable: true,
      },
      ...fields.map((name) => ({
        name,
        storage: 'text' as const,
        interpretation: 'plain' as const,
      })),
      ...numbers.map((name) => ({
        name,
        storage: 'number' as const,
        interpretation: 'number' as const,
      })),
      ...json.map((name) => ({
        name,
        storage: 'text' as const,
        interpretation: { kind: 'json' as const },
      })),
    ],
  }
}
export const chessSchemas = [
  collection(
    'games',
    ['playerColor', 'currentFen', 'status', 'result', 'reason', 'parentGameId'],
    ['version', 'branchPly'],
    ['moveHistory', 'automaticFeedback', 'opponentRetry'],
  ),
  collection(
    'game_messages',
    ['gameId', 'role', 'content', 'positionFen', 'status', 'requestId'],
    ['linkedPly'],
    ['annotations'],
  ),
  collection('move_feedback', ['gameId', 'positionFen', 'summary'], ['ply'], ['annotations']),
]
