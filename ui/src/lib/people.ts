import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'

import { api, Unauthorized, type Role } from '@/lib/api'

export type Pending =
  | { type: 'member'; space: string; role: string; from: string }
  | { type: 'share'; project: string; role: string }
export type WhoAmI = {
  user: string
  super_admin_key: boolean
  can_invite: boolean
  key: { id: string; role: Role; via: string; spaces: string[] | string }
  spaces: { space: string; role: string; kind: string; backing: string }[]
  shared_with_me: { project: string; role: string; expires: string | null }[]
  pending?: Pending[]
}
export type ProjectRow = { project: string; status: string | null; updated: string | null; access: string }
export type ShareRow = {
  project: string
  with: string
  role: string
  expires: string | null
  status: 'active' | 'pending'
}
export type Shares = {
  shared_by_me: ShareRow[]
  shared_with_me: { project: string; role: string; expires: string | null }[]
}
export type Member = { user: string; role: string; status: 'active' | 'pending'; since: string }
export type UserKey = {
  id: string
  name: string
  role: Role
  created: string | null
  expires: string | null
  revoked: number
  last_used: string | null
  owner: string
  scopes: string[]
}
export type AuditEvent = {
  id: number
  ts: string
  actor: string | null
  actor_key: string | null
  via: string | null
  action: string
  outcome: string
  space: string | null
  target: string | null
  subject: string | null
  detail: string | null
}
export type AdminUser = {
  user: string
  handle: string
  name: string | null
  status: 'active' | 'suspended' | 'deleted'
  is_super: boolean
  can_invite: boolean
  quota_notes: number | null
  created: string
  keys: number
  spaces: string[]
}
export type AdminSpace = {
  space: string
  kind: string
  backing: string
  created: string
  owner: string
  members: number
  shares: number
}
export type Chain = { ok: boolean; events: number; head?: string; broken_at?: number }

export function splitProject(ref: string): { space: string; slug: string } {
  const m = ref.match(/^@([^/]+)\/(.+)$/)
  return m ? { space: `@${m[1]}`, slug: m[2] } : { space: '', slug: ref }
}

export const day = (s: string | null | undefined) => (s ? s.slice(0, 10) : '—')
export const stamp = (s: string | null | undefined) => (s ? s.slice(0, 16).replace('T', ' ') : '—')
export const expired = (s: string | null) => !!s && new Date(s.replace(' ', 'T') + 'Z') < new Date()

export function useTool<T>(
  name: string,
  args: Record<string, unknown>,
  onUnauthorized: () => void,
  enabled = true,
) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const key = JSON.stringify(args)
  const reload = useCallback(() => {
    if (!enabled) return
    api
      .tool<T>(name, JSON.parse(key))
      .then((d) => {
        setData(d)
        setError(null)
      })
      .catch((e) => {
        if (e instanceof Unauthorized) onUnauthorized()
        else setError(e instanceof Error ? e.message : `${name} failed`)
      })
  }, [name, key, enabled, onUnauthorized])
  useEffect(reload, [reload])
  return { data, error, reload }
}

export async function runTool<T>(
  name: string,
  args: Record<string, unknown>,
  success?: string,
): Promise<T | null> {
  try {
    const r = await api.tool<T>(name, args)
    if (success) toast.success(success)
    return r
  } catch (e) {
    toast.error(e instanceof Error ? e.message : `${name} failed`)
    return null
  }
}

export function useAuditLog(tool: string, args: Record<string, unknown>, onUnauthorized: () => void, enabled = true) {
  const first = useTool<{ events: AuditEvent[] }>(tool, { ...args, limit: 50 }, onUnauthorized, enabled)
  const [older, setOlder] = useState<{ key: string; events: AuditEvent[] }>({ key: '', events: [] })
  const [busy, setBusy] = useState(false)
  const key = JSON.stringify(args)
  const extra = older.key === key ? older.events : []
  const events = first.data ? [...first.data.events, ...extra] : null
  return {
    events,
    busy,
    reload: () => {
      setOlder({ key, events: [] })
      first.reload()
    },
    more: async () => {
      const last = events?.[events.length - 1]
      if (!last) return
      setBusy(true)
      const r = await runTool<{ events: AuditEvent[] }>(tool, { ...args, limit: 50, before: last.id })
      setBusy(false)
      if (r) setOlder({ key, events: [...extra, ...r.events] })
    },
  }
}
