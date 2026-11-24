import { USERS_COLUMNS, type CollectionSchema } from 'deepspace/schema'

export const usersSchema: CollectionSchema = {
  name: 'users',
  roster: 'read-policy',
  columns: [...USERS_COLUMNS],
  permissions: {
    viewer: { read: 'own', create: false, update: false, delete: false },
    member: { read: 'own', create: false, update: false, delete: false },
    admin: { read: true, create: false, update: true, delete: true },
  },
}
