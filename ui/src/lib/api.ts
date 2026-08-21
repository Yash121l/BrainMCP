// Thin typed client for the Worker's /app/api/* JSON endpoints.
// A 401 anywhere means the brain_session cookie is gone -> surface as Unauthorized
// so the shell can drop back to the login screen.

export class Unauthorized extends Error {
  constructor() {
    super('unauthorized')
    this.name = 'Unauthorized'
  }
}

export type Role = 'read' | 'write' | 'admin'

export type Me = { role: Role; name: string; prefixes: string[] }
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
export type CatalogSkill = { name: string; description: string; bytes?: number }
export type SkillRef = { name: string; must: boolean }
export type SkillEntry = { project: string; skills: SkillRef[] }
export type SkillsConfig = {
  catalog: CatalogSkill[]
  entries: SkillEntry[]
  inherits_default: string[]
  editable: boolean
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
  me: () => req<Me>('me'),
  notes: () => req<{ notes: NoteMeta[] }>('notes').then((d) => d.notes),
  note: (path: string) => req<Note>(`note?path=${encodeURIComponent(path)}`),
  backlinks: (path: string) =>
    req<{ backlinks: string[] }>(`backlinks?path=${encodeURIComponent(path)}`).then((d) => d.backlinks),
  search: (q: string, signal?: AbortSignal) =>
    req<{ results: SearchHit[] }>(`search?q=${encodeURIComponent(q)}`, { signal }).then((d) => d.results),
  graph: () => req<GraphData>('graph'),
  keys: () => req<{ keys: ApiKey[] }>('keys').then((d) => d.keys),
  check: () => req<HealthReport>('check'),
  skills: () => req<SkillsConfig>('skills'),
  saveSkills: (entries: SkillEntryInput[]) =>
    req<{ ok: true; commit: string }>('skills', json({ entries }, 'PUT')),
  createKey: (body: { name: string; role: Role; prefixes: string[]; expires_days: number | null }) =>
    req<{ id: string; key: string }>('keys', json(body)),
  revokeKey: (id: string) => req<{ ok: true }>('keys/revoke', json({ id })),
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
