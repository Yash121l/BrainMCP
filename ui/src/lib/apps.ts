// Plain-language helpers for the simple console: app names and colors, access
// summaries, risk words, activity sentences and relative times.

import type { AgentLevel, Connection, GwEvent, HomeEvent, Level, Risk } from '@/lib/gateway'

// ---------------------------------------------------------------- names + colors

const NAMES: Record<string, string> = {
  figma: 'Figma',
  canva: 'Canva',
  miro: 'Miro',
  gamma: 'Gamma',
  linear: 'Linear',
  notion: 'Notion',
  atlassian: 'Jira & Confluence',
  monday: 'monday.com',
  airtable: 'Airtable',
  granola: 'Granola',
  fireflies: 'Fireflies',
  calendly: 'Calendly',
  attio: 'Attio',
  intercom: 'Intercom',
  stripe: 'Stripe',
  paypal: 'PayPal',
  square: 'Square',
  ramp: 'Ramp',
  mercury: 'Mercury',
  github: 'GitHub',
  gitlab: 'GitLab',
  sentry: 'Sentry',
  vercel: 'Vercel',
  netlify: 'Netlify',
  supabase: 'Supabase',
  neon: 'Neon',
  prisma: 'Prisma Postgres',
  posthog: 'PostHog',
  semgrep: 'Semgrep',
  jam: 'Jam',
  dropbox: 'Dropbox',
  zapier: 'Zapier',
  apify: 'Apify',
  deepwiki: 'DeepWiki',
  context7: 'Context7',
  cloudflaredocs: 'Cloudflare Docs',
  huggingface: 'Hugging Face',
  exa: 'Exa',
  slack: 'Slack',
  hubspot: 'HubSpot',
  asana: 'Asana',
  box: 'Box',
  gmail: 'Gmail',
  gdrive: 'Google Drive',
  gcal: 'Google Calendar',
}

/** "figma" → "Figma"; unknown services get a capitalised id. */
export function serviceName(service: string): string {
  const key = service.toLowerCase().replace(/[^a-z0-9]/g, '')
  return NAMES[key] ?? service.charAt(0).toUpperCase() + service.slice(1)
}

/** The service part of a connection name: figma_rtp → figma. */
export const serviceOf = (connection: string) => connection.replace(/_[^_]+$/, '')
export const labelOf = (connection: string) => connection.match(/_([^_]+)$/)?.[1] ?? ''

/** "Figma (rtp)" for a connection name; "Figma" when the label is main. */
export function appLabel(connection: string | null | undefined): string {
  if (!connection) return 'an app'
  const label = labelOf(connection)
  const name = serviceName(serviceOf(connection))
  return label && label !== 'main' ? `${name} (${label})` : name
}

// Rough brand hues so the avatar is recognisable at a glance; others hash to a hue.
const BRAND: Record<string, string> = {
  figma: '#a259ff',
  canva: '#00c4cc',
  miro: '#f2c94c',
  linear: '#5e6ad2',
  notion: '#9ca3af',
  atlassian: '#2684ff',
  airtable: '#18bfff',
  granola: '#7cb342',
  stripe: '#635bff',
  paypal: '#169bd7',
  github: '#8b949e',
  gitlab: '#fc6d26',
  sentry: '#8d5cf6',
  vercel: '#a1a1aa',
  supabase: '#3ecf8e',
  posthog: '#f9bd2b',
  dropbox: '#0061fe',
  zapier: '#ff4f00',
  deepwiki: '#38bdf8',
  context7: '#10b981',
  cloudflaredocs: '#f38020',
  huggingface: '#ffcc4d',
  exa: '#3b82f6',
  slack: '#e01e5a',
  hubspot: '#ff7a59',
  asana: '#f06a6a',
  box: '#0061d5',
  gmail: '#ea4335',
  calendly: '#006bff',
  intercom: '#1f8ded',
}

export function appColor(service: string): string {
  const key = service.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (BRAND[key]) return BRAND[key]
  let h = 0
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return `hsl(${h % 360} 65% 60%)`
}

// ---------------------------------------------------------------- access levels

export const LEVEL_LABEL: Record<Level, string> = {
  off: 'Off',
  read: 'Read',
  write: 'Read & change',
  full: 'Everything',
}
export const AGENT_LEVEL_LABEL: Record<AgentLevel, string> = { inherit: 'Same as everyone', ...LEVEL_LABEL }

export const LEVEL_HINT: Record<Level, string> = {
  off: 'No agent can use this app.',
  read: 'Agents can look things up, but not change anything.',
  write: 'Agents can read and make changes, but not delete.',
  full: 'Agents can read, change and delete.',
}

/** Short line for an app card: "All agents: read only · asks before changes". */
export function accessShort(level: Level, ask: boolean): string {
  const base = {
    off: 'No agents',
    read: 'All agents: read only',
    write: 'All agents: read & change',
    full: 'All agents: everything',
  }[level]
  return ask && level !== 'off' ? `${base} · asks before changes` : base
}

/** One sentence for the whole app, in plain words. */
export function accessSentence(level: Level, ask: boolean): string {
  if (level === 'off') return 'No agent can use this app unless you give one access below.'
  if (ask) {
    if (level === 'read') return 'Agents can read freely. Anything that changes, deletes or sends waits for your OK first.'
    return 'Agents can read freely. Changes and deletes wait for your OK first.'
  }
  if (level === 'read') return 'Agents can look things up, but cannot change anything.'
  if (level === 'write') return 'Agents can read and make changes. Deleting is blocked.'
  return 'Agents can read, change and delete. Sending or paying still asks you first.'
}

export function agentSentence(name: string, level: AgentLevel, ask: boolean): string | null {
  if (level === 'inherit') return ask ? `${name} asks you before changes.` : null
  if (level === 'off') return `${name} cannot use it.`
  const what = { read: 'can only read', write: 'can read and change', full: 'can do everything' }[level]
  return `${name} ${what}${ask ? ', and asks you before changes' : ''}.`
}

// ---------------------------------------------------------------- tools

export const RISK_WORD: Record<Risk, string> = {
  read: 'Reads',
  write: 'Changes',
  destructive: 'Deletes',
  critical: 'Sends or pays',
}
export const RISK_HINT: Record<Risk, string> = {
  read: 'Only looks things up.',
  write: 'Creates or edits something.',
  destructive: 'Deletes or overwrites something.',
  critical: 'Sends messages, posts publicly, moves money or similar. Always asks you first.',
}

// ---------------------------------------------------------------- devices

export type DeviceKind = 'laptop' | 'desktop' | 'server'
export function deviceKind(name: string, tags: string[]): DeviceKind {
  const all = [name, ...tags].join(' ').toLowerCase()
  if (/server|vps|headless|cloud|ci\b|box/.test(all)) return 'server'
  if (/desktop|workstation|tower|imac|mini/.test(all)) return 'desktop'
  return 'laptop'
}

// ---------------------------------------------------------------- times

export function parseTs(ts: string | null | undefined): Date | null {
  if (!ts) return null
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? ts : `${ts.replace(' ', 'T')}Z`
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d
}

export function ago(ts: string | null | undefined): string {
  const d = parseTs(ts)
  if (!d) return 'never'
  const s = Math.round((Date.now() - d.getTime()) / 1000)
  if (s < 0) return 'just now'
  if (s < 45) return 'just now'
  if (s < 90) return 'a minute ago'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  const days = Math.round(h / 24)
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function clock(ts: string | null | undefined): string {
  const d = parseTs(ts)
  return d ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : ''
}

export function dayLabel(ts: string | null | undefined): string {
  const d = parseTs(ts)
  if (!d) return 'Unknown day'
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((start(new Date()) - start(d)) / 86400000)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Yesterday'
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
}

// ---------------------------------------------------------------- activity

export type Outcome = 'done' | 'blocked' | 'waiting' | 'failed' | 'info'
export function outcomeOf(outcome: string): Outcome {
  if (['ok', 'allow', 'approved', 'allowed'].includes(outcome)) return 'done'
  if (['denied', 'deny', 'forbidden'].includes(outcome)) return 'blocked'
  if (['pending', 'approval'].includes(outcome)) return 'waiting'
  if (['error', 'failed', 'expired'].includes(outcome)) return 'failed'
  return 'info'
}

export const OUTCOME_WORD: Record<Outcome, string> = {
  done: 'Done',
  blocked: 'Blocked',
  waiting: 'Waiting for you',
  failed: 'Failed',
  info: '',
}

/** Split "figma_main.search_files" into its connection and tool. */
export function splitTarget(target: string | null): { connection: string | null; tool: string | null } {
  if (!target) return { connection: null, tool: null }
  const i = target.indexOf('.')
  return i < 0 ? { connection: target, tool: null } : { connection: target.slice(0, i), tool: target.slice(i + 1) }
}

type AnyEvent = Pick<GwEvent, 'action' | 'outcome' | 'target'> & Partial<Pick<GwEvent, 'detail'>> & Pick<HomeEvent, 'agent' | 'machine'>

/** Who did it, in words: "codex on macbook-pro", or "You" for console actions. */
export function actorOf(e: Pick<HomeEvent, 'agent' | 'machine'>): string {
  if (e.agent) return e.machine ? `${e.agent} on ${e.machine}` : e.agent
  return 'You'
}

/** What happened, in words, without the actor. */
export function eventSentence(e: AnyEvent): string {
  const { connection } = splitTarget(e.target)
  const app = connection ? appLabel(connection) : 'an app'
  switch (e.action) {
    case 'gw.call': {
      const o = outcomeOf(e.outcome)
      if (o === 'waiting') return `asked to use ${app}`
      if (o === 'blocked') return `was stopped from using ${app}`
      if (o === 'failed') return `tried ${app}, but it failed`
      return `used ${app}`
    }
    case 'gw.result':
      return `got a result from ${app}`
    case 'gw.approval':
      return e.outcome === 'denied' ? `denied a request to use ${app}` : `approved a request to use ${app}`
    case 'gw.connection.create':
      return `added ${app}`
    case 'gw.connection.connect':
      return `signed in to ${app}`
    case 'gw.connection.sync':
      return `refreshed the tool list of ${app}`
    case 'gw.connection.update':
      return `changed the settings of ${app}`
    case 'gw.connection.delete':
      return `disconnected ${app}`
    case 'gw.connection.share':
      return `shared ${app}`
    case 'gw.connection.unshare':
      return `stopped sharing ${app}`
    case 'gw.access.set':
      return `changed who can use ${app}`
    case 'gw.tools.review':
    case 'gw.tool.review':
      return `reviewed tools of ${app}`
    case 'gw.machine.revoke':
      return `removed the device ${e.target ?? ''}`.trim()
    case 'gw.machine.update':
      return `changed the device ${e.target ?? ''}`.trim()
    case 'gw.key.update':
      return 'changed an agent'
    case 'gw.device.approve':
      return 'added a device'
    case 'gw.device.deny':
      return 'denied a device sign-in'
    case 'gw.settings':
      return 'changed notification settings'
    default:
      if (e.action.startsWith('gw.rule')) return 'changed an advanced rule'
      return `${e.action.replace(/^gw\./, '').replace(/[._]/g, ' ')}${e.target ? ` · ${e.target}` : ''}`
  }
}

/** The reason shown under blocked/failed rows, in plain words. */
export function plainReason(reason: string | null | undefined): string {
  if (!reason) return ''
  return reason
    .split(';')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      if (/^critical tool/.test(r)) return 'this action sends or pays, so it always asks you'
      if (/approve rule matches/.test(r)) return 'you asked to approve changes on this app'
      if (/egress after untrusted and private input/.test(r))
        return 'it would send data out after reading private and outside content'
      if (/egress after output that looked like an injection/.test(r))
        return 'an earlier result looked like it tried to give the agent instructions'
      if (/forbid rule/.test(r)) return 'this agent is not allowed to use this app'
      if (/no rule permits/.test(r)) return 'this agent has no access to this app'
      if (/no rule names (\w+) tools/.test(r)) return 'this kind of action is not allowed on this app'
      if (/^permitted$/.test(r)) return ''
      return r
    })
    .filter(Boolean)
    .join('; ')
}

export const connectionAccount = (c: Pick<Connection, 'account' | 'workspace'>) =>
  [c.account, c.workspace].filter(Boolean).join(' · ')

/** Turn a tool id into words: "create_issue" → "Create issue". */
export function toolWords(tool: string | null | undefined): string {
  if (!tool) return ''
  const s = tool.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().trim()
  return s.charAt(0).toUpperCase() + s.slice(1)
}
