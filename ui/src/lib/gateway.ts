import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

import { api, Unauthorized, type Role } from '@/lib/api'

export type Risk = 'read' | 'write' | 'destructive' | 'critical'
export const RISKS: Risk[] = ['read', 'write', 'destructive', 'critical']
export type AuthKind = 'oauth' | 'bearer' | 'header' | 'none'
export type Trust = 'trusted' | 'untrusted'
export type Sensitivity = 'private' | 'public'
export type Taint = 'untrusted' | 'private' | 'flagged'
export const TAINTS: Taint[] = ['untrusted', 'private', 'flagged']

export type Connection = {
  connection: string
  service: string
  account: string | null
  workspace: string | null
  status: string
  tools: number
  default_for?: string[]
  shared_by?: string
  shared_tools?: string[] | string
  id?: string
  label?: string
  url?: string
  auth?: AuthKind
  trust?: Trust
  sensitivity?: Sensitivity
  review?: number
  hidden?: number
  last_sync?: string | null
  last_error?: string | null
  created?: string
}
export type OwnConnection = Connection & { id: string; label: string; auth: AuthKind; trust: Trust; sensitivity: Sensitivity }
export const isOwn = (c: Connection): c is OwnConnection => !!c.id && !c.shared_by
export type SharedConnection = Connection & { id: string; shared_by: string }
export const isShared = (c: Connection): c is SharedConnection => !!c.id && !!c.shared_by

export type Overview = {
  connections: Connection[]
  pending_approvals: number
  pending_shares: number
  notify_url: string | null
  vault_ready: boolean
  bridge_ready: boolean
}

export type ConnectionInput = {
  service: string
  label: string
  url: string
  auth: AuthKind
  secret?: string
  header_name?: string
  account?: string
  workspace?: string
  trust?: Trust
  sensitivity?: Sensitivity
  default_for?: string[]
  grant_read?: boolean
  client_id?: string
  client_secret?: string
  scope?: string
}
export type Synced = { tools: number; added: string[]; changed: string[]; removed: string[] }
export type CreateResult = {
  ok: boolean
  connection: string
  id: string
  authorize_url?: string
  synced?: Synced
  warning?: string
}
export type ConnectionPatch = {
  account?: string
  workspace?: string
  trust?: Trust
  sensitivity?: Sensitivity
  default_for?: string[]
  secret?: string
}

export type ToolState = 'approved' | 'pending' | 'changed' | 'hidden' | 'removed'
export type UpstreamTool = {
  name: string
  title: string | null
  description: string | null
  risk: Risk
  risk_override: Risk | null
  egress: boolean
  egress_mode?: 'auto' | 'on' | 'off'
  state: ToolState
  annotations: Record<string, unknown> | null
  changed: string | null
  /** For changed tools: the description you approved before. */
  approved_description?: string
}
export type ConnectionTools = { connection: string; editable: boolean; tools: UpstreamTool[] }

export type Subject = {
  keys?: string[]
  machines?: string[]
  machine_tags?: string[]
  agents?: string[]
  agent_tags?: string[]
}
export type Resource = { connections?: string[]; services?: string[]; tools?: string[]; risks?: Risk[] }
export type Effect = 'permit' | 'forbid' | 'approve'
export type Rule = {
  id: string
  effect: Effect
  subject: Subject
  resource: Resource
  note: string | null
  enabled: boolean
  global: boolean
  mine: boolean
}
export type BuiltinRule = { effect: 'deny' | 'approve'; text: string }
export type RuleInput = {
  id?: string
  effect: Effect
  subject: Subject
  resource: Resource
  note?: string
  enabled?: boolean
}
export type Decision = {
  decision: 'allow' | 'deny' | 'approval'
  reason: string
  rule?: string | null
  tool_state: ToolState
  risk: Risk
  egress: boolean
}

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'void'
export type Approval = {
  id: string
  connection: string
  tool: string
  status: ApprovalStatus
  scope: 'once' | 'hour' | null
  reason: string | null
  taint: string[]
  agent: string | null
  machine: string | null
  key: string | null
  /** Set when another user's agent asked (through a connection you shared). */
  requested_by?: string
  /** The console session was opened with the key that asked: it may deny, not approve. */
  own_key?: boolean
  created: string
  expires: string | null
  decided: string | null
  arguments: string | null
}

export type GwKey = {
  id: string
  name: string
  role: Role
  agent: string | null
  agent_tags: string[]
  pinned: string[]
  machine_id: string | null
  last_used: string | null
  expires: string | null
  created: string | null
}
export type Machine = {
  id: string
  name: string
  tags: string[]
  revoked: boolean
  last_seen: string | null
  created: string | null
  keys: GwKey[]
}
export type Machines = { machines: Machine[]; unassigned_keys: GwKey[] }
export type KeyPatch = { agent?: string; agent_tags?: string[]; machine?: string; pinned?: string[] }

export type GwEvent = {
  id: number
  ts: string
  action: string
  outcome: string
  target: string | null
  detail: unknown
  key_name: string | null
  agent: string | null
  machine: string | null
}

export type Share = {
  id: string
  connection: string
  service: string
  label: string
  tools: string[]
  expires: string | null
  accepted: boolean
  grantee?: string
  owner?: string
  account?: string | null
}
export type Shares = { outgoing: Share[]; incoming: Share[] }

/** "claude-code, codex and cursor" for a device asking on behalf of several harnesses. */
export function agentList(req: { agent: string | null; agents?: string[] }): string {
  const list = req.agents?.length ? req.agents : req.agent ? [req.agent] : []
  if (!list.length) return 'A terminal'
  return list.length === 1 ? list[0] : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`
}

export type DeviceRequest = {
  machine: string
  agent: string | null
  /** One key is minted per agent; the CLI asks for every harness it found. */
  agents?: string[]
  requested: string
  expires: string
  existing_machine: boolean
  machine_tags: string[]
}
export type DeviceInput = {
  user_code: string
  role?: 'read' | 'write' | 'admin'
  agent?: string
  agent_tags?: string[]
  machine?: string
  machine_tags?: string[]
}

// ---------------------------------------------------------------- simple layer (apps.js)

export type Level = 'off' | 'read' | 'write' | 'full'
export type AgentLevel = Level | 'inherit'
export type AgentAccess = {
  key_id: string
  name: string
  agent: string | null
  machine: string | null
  level: AgentLevel
  ask: boolean
}
export type AppAccess = {
  connection: string
  level: Level
  ask: boolean
  agents: AgentAccess[]
  custom_rules: number
}

export type AppAuth = 'oauth' | 'token' | 'app' | 'none' | 'detect' | 'restricted'
export type CatalogApp = {
  id: string
  name: string
  category: string
  url: string
  auth: AppAuth
  description: string
  /** For restricted apps: why they can't connect, and any workaround. */
  note?: string
  token_help?: string
  token_url?: string
  header_name?: string | null
  registry_name?: string
  repository?: string | null
  verified: boolean
  connected: { id: string; connection: string; account: string | null; status: string }[]
}
export type Catalog = { featured: CatalogApp[]; registry: CatalogApp[]; redirect_uri: string }

export type ConnectAppInput = {
  app_id?: string
  label?: string
  account?: string
  workspace?: string
  secret?: string
  client_id?: string
  client_secret?: string
  name?: string
  url?: string
  auth?: AppAuth
  header_name?: string | null
  service?: string
}
/** Either a connection was made, or `needs` says what input is missing. */
export type ConnectAppResult = {
  ok?: boolean
  connection?: string
  id?: string
  authorize_url?: string
  synced?: Synced
  warning?: string
  app?: string
  auth?: AppAuth
  error?: string
  needs?: 'token' | 'app'
  token_help?: string
  token_url?: string
  redirect_uri?: string
}

export type HomePending = {
  id: string
  connection: string | null
  tool: string
  reason: string | null
  agent: string | null
  machine: string | null
  created: string
}
export type HomeEvent = {
  id: number
  ts: string
  action: string
  outcome: string
  target: string | null
  agent: string | null
  machine: string | null
}
export type Home = {
  user: string
  counts: { apps: number; agents: number; machines: number; calls_7d: number; pending: number }
  pending: HomePending[]
  attention: { id: string; connection: string; status: string; last_error: string | null }[]
  review: { id: string; connection: string; tools_to_review: number }[]
  recent: HomeEvent[]
  checklist: { connect_app: boolean; add_agent: boolean; first_call: boolean; notifications: boolean }
}

/** Like api.tool, but hands back the JSON body of a 400 too (gw_connect_app answers `needs` that way). */
async function toolBody<T>(name: string, args: object): Promise<T> {
  const res = await fetch('/app/api/tool', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, args }),
  })
  if (res.status === 401) throw new Unauthorized()
  const body = (await res.json().catch(() => null)) as (T & { error?: string; needs?: string }) | null
  if (!body) throw new Error(`request failed (${res.status})`)
  if (!res.ok && !body.needs) throw new Error(body.error || `request failed (${res.status})`)
  return body
}

type Ok = { ok: true }
const call = <T,>(name: string, args: object = {}) => api.tool<T>(name, args as Record<string, unknown>)

export const gw = {
  home: () => call<Home>('gw_home'),
  catalog: (query?: string) => call<Catalog>('gw_catalog', query ? { query } : {}),
  connectApp: (input: ConnectAppInput) => toolBody<ConnectAppResult>('gw_connect_app', input),
  appAccess: (id: string) => call<AppAccess>('gw_app_access', { id }),
  setAppAccess: (id: string, level: AgentLevel, ask: boolean, key_id?: string) =>
    call<Ok & { access: AppAccess }>('gw_set_app_access', { id, level, ask, ...(key_id ? { key_id } : {}) }),
  overview: () => call<Overview>('gw_overview'),
  createConnection: (input: ConnectionInput) => call<CreateResult>('gw_connection_create', input),
  reconnect: (id: string) => call<{ authorize_url: string }>('gw_connection_reconnect', { id }),
  updateConnection: (id: string, patch: ConnectionPatch) => call<Ok>('gw_connection_update', { id, ...patch }),
  deleteConnection: (id: string) => call<Ok & { note?: string }>('gw_connection_delete', { id }),
  sync: (id: string) => call<{ synced: Synced }>('gw_connection_sync', { id }),
  tools: (id: string) => call<ConnectionTools>('gw_connection_tools', { id }),
  reviewTools: (id: string, tools: string[], action: 'approve' | 'hide') =>
    call<Ok>('gw_tool_review', { id, tools, action }),
  /** Change one field: `risk: ''` clears the override; egress sets the egress flag. */
  setTool: (id: string, tool: string, patch: { risk: Risk | '' } | { egress: boolean | 'auto' }) =>
    call<Ok>('gw_tool_review', { id, tools: [tool], action: 'set', ...patch }),
  rules: () => call<{ rules: Rule[]; builtin: BuiltinRule[] }>('gw_rules'),
  putRule: (rule: RuleInput) => call<Ok & { id: string }>('gw_rule_put', rule),
  deleteRule: (id: string) => call<Ok>('gw_rule_delete', { id }),
  testRule: (args: { key_id: string; connection: string; tool: string; taint?: Taint[] }) =>
    call<Decision>('gw_rule_test', args),
  approvals: (status?: 'pending' | 'approved' | 'denied' | 'expired') =>
    call<{ approvals: Approval[] }>('gw_approvals', status ? { status } : {}),
  decide: (id: string, decision: 'approve' | 'deny', scope: 'once' | 'hour' = 'once') =>
    call<Ok & { status: 'approved' | 'denied'; scope: 'once' | 'hour' }>('gw_approval_decide', { id, decision, scope }),
  machines: () => call<Machines>('gw_machines'),
  updateMachine: (id: string, tags: string[]) => call<Ok>('gw_machine_update', { id, tags }),
  revokeMachine: (id: string) => call<Ok & { revoked_keys: number }>('gw_machine_revoke', { id }),
  updateKey: (id: string, patch: KeyPatch) => call<Ok>('gw_key_update', { id, ...patch }),
  activity: (before?: number, limit = 50) =>
    call<{ events: GwEvent[] }>('gw_activity', before ? { limit, before } : { limit }),
  settings: (notify_url: string) => call<Ok>('gw_settings', { notify_url }),
  share: (id: string, withHandle: string, tools: string[], expires_days?: number) =>
    call<Ok & { note?: string }>('gw_connection_share', {
      id,
      with: withHandle,
      tools,
      ...(expires_days ? { expires_days } : {}),
    }),
  unshare: (id: string, withHandle: string) => call<Ok>('gw_connection_unshare', { id, with: withHandle }),
  shares: () => call<Shares>('gw_connection_shares'),
  accept: (id: string) => call<Ok>('gw_connection_accept', { id }),
  decline: (id: string) => call<Ok>('gw_connection_decline', { id }),
  lookupDevice: (user_code: string) => call<DeviceRequest>('gw_device_lookup', { user_code }),
  approveDevice: (input: DeviceInput) =>
    call<Ok & { machine: string; agent: string; key_id: string }>('gw_device_approve', input),
  denyDevice: (user_code: string) => call<Ok>('gw_device_deny', { user_code }),
}

/** Run a gateway call, toast its error, return null on failure. */
export async function attempt<T>(run: () => Promise<T>, success?: string): Promise<T | null> {
  try {
    const r = await run()
    if (success) toast.success(success)
    return r
  } catch (e) {
    toast.error(e instanceof Error ? e.message : 'request failed')
    return null
  }
}

export async function reconnect(id: string) {
  const r = await attempt(() => gw.reconnect(id))
  if (r?.authorize_url) window.location.href = r.authorize_url
}

export function useGw<T>(load: () => Promise<T>, deps: unknown[], onUnauthorized: () => void) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const loadRef = useRef(load)
  loadRef.current = load
  const depKey = JSON.stringify(deps)
  const reload = useCallback(() => {
    return loadRef
      .current()
      .then((d) => {
        setData(d)
        setError(null)
      })
      .catch((e) => {
        if (e instanceof Unauthorized) onUnauthorized()
        else setError(e instanceof Error ? e.message : 'request failed')
      })
  }, [onUnauthorized])
  useEffect(() => {
    reload()
  }, [reload, depKey])
  return { data, error, reload }
}

export const splitList = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)

export function prettyJson(text: string | null): string {
  if (!text) return ''
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

export function normalizeCode(code: string) {
  const s = code.toUpperCase().replace(/[^A-Z0-9]/g, '')
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4)}` : code.trim().toUpperCase()
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

const list = (xs: string[] | undefined) => (xs?.length ? xs.join(', ') : '')

export function describeSubject(s: Subject, keyName: (id: string) => string = (id) => id) {
  const who: string[] = []
  if (s.keys?.length) who.push(`keys ${s.keys.map(keyName).join(', ')}`)
  if (s.agents?.length) who.push(`agents ${list(s.agents)}`)
  if (s.agent_tags?.length) who.push(`agents tagged ${list(s.agent_tags)}`)
  const agentPart = who.length ? who.join(' and ') : 'all agents'
  const where: string[] = []
  if (s.machines?.length) where.push(`on ${list(s.machines)}`)
  if (s.machine_tags?.length) where.push(`on machines tagged ${list(s.machine_tags)}`)
  return [agentPart, ...where].join(' ')
}

export function describeResource(r: Resource) {
  const what = [...(r.connections ?? []), ...(r.services ?? []).map((s) => `${s} (any account)`)]
  const tools = r.tools?.length ? list(r.tools) : ''
  let out = what.length ? what.join(', ') : 'any connection'
  if (tools) out += ` · ${tools}`
  if (r.risks?.length) out += ` · ${list(r.risks)}`
  return out
}

export type DiffPart = { text: string; kind: 'same' | 'added' | 'removed' }

/** Word-level diff (LCS over whitespace-separated tokens, whitespace kept). */
export function wordDiff(before: string, after: string): DiffPart[] {
  const a = before.split(/(\s+)/)
  const b = after.split(/(\s+)/)
  const n = a.length
  const m = b.length
  // lengths[i][j] = LCS length of a[i:] and b[j:]
  const lengths: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lengths[i][j] = a[i] === b[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1])
  const out: DiffPart[] = []
  const push = (text: string, kind: DiffPart['kind']) => {
    const last = out[out.length - 1]
    if (last && last.kind === kind) last.text += text
    else out.push({ text, kind })
  }
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push(a[i], 'same')
      i++
      j++
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) push(a[i++], 'removed')
    else push(b[j++], 'added')
  }
  while (i < n) push(a[i++], 'removed')
  while (j < m) push(b[j++], 'added')
  return out
}
