// Read the access levels the Apps page set back out of the rule list, so cards
// and agent summaries need one gw_rules call instead of one gw_app_access per app.
// Mirrors the "managed:app:<connection>:<who>:<kind>" notes written by src/apps.js.

import type { AgentLevel, Level, Rule, Risk } from '@/lib/gateway'

const NOTE = /^managed:app:([^:]+):([^:]+):(permit|ask|block)$/

export type Managed = { level: AgentLevel; ask: boolean }
export type AccessMap = Map<string, { all: { level: Level; ask: boolean }; keys: Map<string, Managed> }>

export const isManaged = (r: Pick<Rule, 'note'>) => !!r.note && r.note.startsWith('managed:')

function levelOf(risks: Risk[] = []): Level {
  const has = (xs: Risk[]) => xs.every((x) => risks.includes(x))
  if (has(['read', 'write', 'destructive', 'critical'])) return 'full'
  if (has(['read', 'write'])) return 'write'
  if (has(['read'])) return 'read'
  return 'off'
}

export function accessMap(rules: Rule[]): AccessMap {
  const out: AccessMap = new Map()
  const entry = (conn: string) => {
    let e = out.get(conn)
    if (!e) {
      e = { all: { level: 'off', ask: false }, keys: new Map() }
      out.set(conn, e)
    }
    return e
  }
  for (const r of rules) {
    if (!r.enabled) continue
    const m = NOTE.exec(r.note ?? '')
    if (!m) continue
    const [, conn, who, kind] = m
    const e = entry(conn)
    if (who === 'all') {
      if (kind === 'permit') e.all.level = levelOf(r.resource.risks)
      if (kind === 'ask') e.all.ask = true
      continue
    }
    const k = e.keys.get(who) ?? { level: 'inherit', ask: false }
    if (kind === 'block') k.level = 'off'
    else if (kind === 'permit' && k.level !== 'off') k.level = levelOf(r.resource.risks)
    else if (kind === 'ask') k.ask = true
    e.keys.set(who, k)
  }
  return out
}

export function appAccess(map: AccessMap, connection: string) {
  return map.get(connection)?.all ?? { level: 'off' as Level, ask: false }
}

const ORDER: Level[] = ['off', 'read', 'write', 'full']
export const levelRank = (l: Level) => ORDER.indexOf(l)

/** What one agent can do in one app: its own level when it has one (higher or lower), else everyone's. */
export function combine(all: { level: Level; ask: boolean }, own: Managed | undefined): { level: Level; ask: boolean } {
  const level = own && own.level !== 'inherit' ? own.level : all.level
  return { level, ask: level !== 'off' && (all.ask || !!own?.ask) }
}

export function effectiveFor(map: AccessMap, connection: string, keyId: string): { level: Level; ask: boolean } {
  const e = map.get(connection)
  if (!e) return { level: 'off', ask: false }
  return combine(e.all, e.keys.get(keyId))
}

/** A plain description of the friendly rule a managed note stands for. */
export function managedText(note: string, keyName: (id: string) => string): string | null {
  const m = NOTE.exec(note)
  if (!m) return null
  const [, conn, who, kind] = m
  const whom = who === 'all' ? 'All agents' : keyName(who)
  if (kind === 'block') return `${whom}: no access to ${conn}`
  if (kind === 'ask') return `${whom}: ask before changes in ${conn}`
  return `${whom}: may use ${conn}`
}
