import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { BotIcon, Loader2Icon } from 'lucide-react'

import { Unauthorized } from '@/lib/api'
import { gw, type AgentLevel, type AppAccess, type Level } from '@/lib/gateway'
import { combine } from '@/lib/access'
import { AGENT_LEVEL_LABEL, LEVEL_HINT, LEVEL_LABEL, accessSentence, agentSentence } from '@/lib/apps'
import { Segmented } from '@/components/segmented'
import { Pill } from '@/components/app-ui'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

const LEVELS: Level[] = ['off', 'read', 'write', 'full']
const AGENT_LEVELS: AgentLevel[] = ['inherit', 'off', 'read', 'write', 'full']

export function AccessPanel({
  connId,
  appName,
  onChanged,
  onAdvanced,
  onUnauthorized,
}: {
  connId: string
  appName: string
  onChanged: () => void
  onAdvanced: () => void
  onUnauthorized: () => void
}) {
  const [access, setAccess] = useState<AppAccess | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    gw.appAccess(connId)
      .then((a) => alive && setAccess(a))
      .catch((e) => {
        if (!alive) return
        if (e instanceof Unauthorized) onUnauthorized()
        else setError(e instanceof Error ? e.message : 'could not load access')
      })
    return () => {
      alive = false
    }
  }, [connId, onUnauthorized])

  const save = async (who: string, level: AgentLevel, ask: boolean, keyId?: string) => {
    setSaving(who)
    try {
      const r = await gw.setAppAccess(connId, level, ask, keyId)
      setAccess(r.access)
      onChanged()
    } catch (e) {
      if (e instanceof Unauthorized) onUnauthorized()
      else toast.error(e instanceof Error ? e.message : 'could not save')
    } finally {
      setSaving(null)
    }
  }

  if (error) return <p className="text-sm text-rose-300">{error}</p>
  if (!access)
    return (
      <div className="grid gap-3">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    )

  const all = { level: access.level, ask: access.ask }
  const extras = access.agents
    .map((a) => {
      const eff = combine(all, { level: a.level, ask: a.ask })
      const name = a.agent ?? a.name
      if (a.level === 'off') return `${name} cannot use it.`
      if (eff.level !== all.level || eff.ask !== all.ask) return agentSentence(name, eff.level, eff.ask)
      return null
    })
    .filter(Boolean)

  return (
    <div className="grid gap-5">
      <div className="grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Label className="text-sm">All agents</Label>
          {saving === 'all' && <Loader2Icon className="size-4 animate-spin text-muted-foreground" />}
        </div>
        <Segmented
          label={`What all agents may do in ${appName}`}
          value={access.level}
          onChange={(level) => save('all', level, access.ask)}
          options={LEVELS.map((l) => ({ value: l, label: LEVEL_LABEL[l], hint: LEVEL_HINT[l] }))}
          disabled={saving === 'all'}
        />
        <label className="flex items-start gap-3 rounded-lg border border-border px-3 py-2.5">
          <Switch
            checked={access.ask && access.level !== 'off'}
            disabled={access.level === 'off' || saving === 'all'}
            onCheckedChange={(v) => save('all', access.level, v)}
            className="mt-0.5"
            aria-describedby={`ask-${connId}`}
          />
          <span className="grid gap-0.5">
            <span className="text-sm font-medium">Ask me before it changes anything</span>
            <span id={`ask-${connId}`} className="text-xs text-muted-foreground">
              Reads go through. Anything that creates, edits, deletes or sends waits for your approval, even beyond the
              level above.
            </span>
          </span>
        </label>
        <div className="rounded-lg bg-muted/50 px-3 py-2.5 text-sm" aria-live="polite">
          <p>{accessSentence(access.level, access.ask)}</p>
          {extras.length > 0 && <p className="mt-1 text-muted-foreground">{extras.join(' ')}</p>}
        </div>
      </div>

      {access.agents.length > 0 && (
        <div className="grid gap-2">
          <div>
            <p className="text-sm font-medium">Per agent</p>
            <p className="text-xs text-muted-foreground">
              Give one agent more access, or turn it off for one agent. Everyone else follows the setting above.
            </p>
          </div>
          <ul className="divide-y divide-border rounded-lg border border-border">
            {access.agents.map((a) => {
              const eff = combine(all, { level: a.level, ask: a.ask })
              return (
                <li key={a.key_id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
                  <BotIcon className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {a.agent ?? a.name}
                      {a.machine && <span className="font-normal text-muted-foreground"> on {a.machine}</span>}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {eff.level === 'off' ? 'No access' : LEVEL_LABEL[eff.level]}
                      {eff.ask && ' · asks first'}
                    </p>
                  </div>
                  {saving === a.key_id && <Loader2Icon className="size-4 animate-spin text-muted-foreground" />}
                  {a.level !== 'inherit' && a.level !== 'off' && (
                    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Switch
                        checked={a.ask}
                        onCheckedChange={(v) => save(a.key_id, a.level, v, a.key_id)}
                        aria-label={`${a.agent ?? a.name} asks before changes`}
                      />
                      Asks first
                    </label>
                  )}
                  <Select
                    value={a.level}
                    onValueChange={(v) => save(a.key_id, v as AgentLevel, v === 'off' ? false : a.ask, a.key_id)}
                  >
                    <SelectTrigger size="sm" className="w-44" aria-label={`Access for ${a.agent ?? a.name}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {AGENT_LEVELS.map((l) => (
                        <SelectItem key={l} value={l}>
                          {AGENT_LEVEL_LABEL[l]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {access.custom_rules > 0 && (
        <p className="text-xs text-muted-foreground">
          <Pill tone="violet" className="mr-1.5">
            {access.custom_rules} advanced rule{access.custom_rules === 1 ? '' : 's'}
          </Pill>
          also mention this app and can change what agents may do.{' '}
          <button type="button" onClick={onAdvanced} className="text-sky-400 hover:underline">
            Open advanced rules
          </button>
        </p>
      )}
    </div>
  )
}
