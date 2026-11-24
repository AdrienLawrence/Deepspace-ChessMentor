/**
 * Collection Schemas
 *
 * All collections with columns and RBAC permissions.
 * Single source of truth — imported by both worker and frontend.
 *
 * Add schemas by creating a file in src/schemas/ and importing it here.
 */

// SDK collection contracts and built-in schema definitions: node_modules/deepspace/dist/schema.js.
// Public signatures: node_modules/deepspace/dist/schema.d.ts.
import type { CollectionSchema } from 'deepspace/schema'
import { usersSchema } from './schemas/users-schema'
import { settingsSchema } from './schemas/admin-schema'
import { chessSchemas } from './schemas/chess-schema'

export const schemas: CollectionSchema[] = [usersSchema, settingsSchema, ...chessSchemas]
