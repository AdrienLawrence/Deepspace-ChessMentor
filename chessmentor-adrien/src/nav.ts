import type { Role } from './constants'
export interface NavItem {
  path: string
  label: string
  roles?: Role[]
  devOnly?: boolean
}
export const nav: NavItem[] = [
  { path: '/home', label: 'My games' },
  { path: '/game/new', label: 'New game' },
  { path: '/settings', label: 'Settings' },
  { path: '/diagnostics', label: 'Diagnostics', roles: ['admin'] },
]
