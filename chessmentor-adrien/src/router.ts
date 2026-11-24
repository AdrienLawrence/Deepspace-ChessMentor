// Generouted, changes to this file will be overridden
/* eslint-disable */

import { components, hooks, utils } from '@generouted/react-router/client'

export type Path =
  | `*`
  | `/`
  | `/api-status`
  | `/diagnostics`
  | `/game/:id`
  | `/game/:id/analysis`
  | `/game/new`
  | `/home`
  | `/settings`

export type Params = {
  '/*': { '*': string }
  '/game/:id': { id: string }
  '/game/:id/analysis': { id: string }
}

export type ModalPath = never

export const { Link, Navigate } = components<Path, Params>()
export const { useModals, useNavigate, useParams } = hooks<Path, Params, ModalPath>()
export const { redirect } = utils<Path, Params>()
