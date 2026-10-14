// Thin typed client for the Worker's /app/api/* JSON endpoints.
// A 401 anywhere means the brain_session cookie is gone -> surface as Unauthorized
// so the shell can drop back to the login screen.

import { resetUser, track } from './analytics'

export class Unauthorized extends Error {
  constructor() {
    super('unauthorized')
    this.name = 'Unauthorized'
  }
}

export type Role = 'read' | 'write' | 'admin' | 'super'

export type SpaceAccess = 'owner' | 'admin' | 'editor' | 'viewer' | 'share' | 'super' | 'system'
export type SpaceRef = {
  handle: string
  kind: 'personal' | 'team' | 'system'
  backing: 'git' | 'hosted'
  owner: string
  access: SpaceAccess
}
export type Me = {
  role: Role | 'none'
  name: string
  prefixes: string[]
  user: string | null
  /** Internal user id, for analytics identify only. */
  user_id: string | null
  super: boolean
  super_user: boolean
  can_invite: boolean
  expires: string | null
  root_admin: boolean
  space: string | null
  access: SpaceAccess | null
  writable: boolean
  spaces: SpaceRef[]
}
export type NoteMeta = { path: string; title: string | null; type: string | null }
export type Note = { path: string; content: string; frontmatter: Record<string, unknown> }
export type SearchHit = { path: string; snippet: string }
export type GraphNode = { id: string; title: string; type: string }
export type GraphLink = { source: string; target: string }
export type GraphData = { nodes: GraphNode[]; links: GraphLink[] }
export type ApiKey = {
  id: string
  name: string
  role: Role
  prefixes: string[]
  created: string | null
  expires: string | null
  revoked: number
  last_used: string | null
}
export type ScopeProject = {
  slug: string
  title: string
  path: string
  status: string | null
  notes: number
}
export type ScopeArea = { prefix: string; notes: number }
export type Scopes = { projects: ScopeProject[]; areas: ScopeArea[]; total_notes: number }
export type CatalogSkill = { name: string; description: string; bytes?: number }
export type SkillRef = { name: string; must: boolean }
export type SkillEntry = { project: string; skills: SkillRef[] }
export type SkillsConfig = {
  catalog: CatalogSkill[]
  entries: SkillEntry[]
  inherits_default: string[]
  editable: boolean
}
export type KeyInput = {
  name: string
  role: Role
  prefixes: string[]
  expires_days: number | null
}
export type SkillEntryInput = { project: string; inherits_default: boolean; skills: SkillRef[] }
export type UnsavedSession = { path: string; date: string; project: string }
export type StaleProject = { path: string; project: string; updated: string }
export type BrokenLink = { src: string; dst: string }
export type HealthReport = {
  generated_at: string
  counts: { notes: number; links: number; sessions_7d: number; decisions_total: number }
  unsaved_sessions: UnsavedSession[]
  unsaved_total: number
  stale_active_projects: StaleProject[]
  broken_links: BrokenLink[]
  broken_links_total: number
}

let currentSpace: string | null = null

export function scopeReadsToSpace(handle: string | null) {
  currentSpace = handle
}

const inSpace = (path: string) =>
  currentSpace ? `${path}${path.includes('?') ? '&' : '?'}space=${encodeURIComponent(currentSpace)}` : path

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/app/api/${path}`, { credentials: 'same-origin', ...init })
  if (res.status === 401) throw new Unauthorized()
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) {
    const detail =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : ''
    throw new Error(detail || `request failed (${res.status})`)
  }
  return body as T
}

const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

export const api = {
  me: () => req<Me>(inSpace('me')),
  notes: () => req<{ notes: NoteMeta[] }>(inSpace('notes')).then((d) => d.notes),
  note: (path: string) => req<Note>(inSpace(`note?path=${encodeURIComponent(path)}`)),
  backlinks: (path: string) =>
    req<{ backlinks: string[] }>(inSpace(`backlinks?path=${encodeURIComponent(path)}`)).then(
      (d) => d.backlinks,
    ),
  search: (q: string, signal?: AbortSignal) =>
    req<{ results: SearchHit[] }>(inSpace(`search?q=${encodeURIComponent(q)}`), { signal }).then((d) => {
      // counts only: the query itself never leaves the console
      track('search_run', { query_length: q.length, result_count: d.results.length })
      return d.results
    }),
  graph: () => req<GraphData>(inSpace('graph')),
  keys: () => req<{ keys: ApiKey[] }>('keys').then((d) => d.keys),
  check: () => req<HealthReport>(inSpace('check')),
  skills: () => req<SkillsConfig>(inSpace('skills')),
  saveSkills: (entries: SkillEntryInput[]) =>
    req<{ ok: true; commit: string }>(inSpace('skills'), json({ entries }, 'PUT')).then((r) => {
      track('skills_saved', { projects: entries.length, skills: entries.reduce((n, e) => n + e.skills.length, 0) })
      return r
    }),
  tool: <T,>(name: string, args: Record<string, unknown> = {}) =>
    req<T>('tool', json({ name, args })),
  scopes: () => req<Scopes>('scopes'),
  createKey: (body: KeyInput) =>
    req<{ id: string; key: string }>('keys', json(body)).then((r) => {
      track('key_created', { role: body.role, scoped: body.prefixes.length > 0, expires_days: body.expires_days })
      return r
    }),
  updateKey: (id: string, patch: Partial<KeyInput>) =>
    req<{ key: ApiKey }>('keys', json({ id, ...patch }, 'PATCH')).then((d) => d.key),
  revokeKey: (id: string) => req<{ ok: true }>('keys/revoke', json({ id })),
}

export async function logout() {
  await fetch('/app/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {})
  resetUser()
}

/** Log in with an access key. Returns an error message, or null on success. */
export async function login(accessKey: string): Promise<string | null> {
  const form = new FormData()
  form.set('access_key', accessKey)
  const res = await fetch('/app/login', {
    method: 'POST',
    body: form,
    credentials: 'same-origin',
    redirect: 'manual',
  })
  // The worker answers 302 on success; `redirect: manual` surfaces that as an
  // opaque response (status 0) in browsers, so treat anything non-4xx as OK.
  if (res.type === 'opaqueredirect' || res.status === 0 || res.status === 302 || res.ok) return null
  return (await res.text().catch(() => '')) || 'invalid or revoked key'
}
