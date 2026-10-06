import { useMemo, useState } from 'react'
import { CheckIcon, CircleAlertIcon, ClockIcon, InfoIcon, Loader2Icon, RefreshCwIcon, ShieldXIcon } from 'lucide-react'

import { cn } from '@/lib/utils'
import { gw, useGw, type GwEvent } from '@/lib/gateway'
import {
  OUTCOME_WORD,
  actorOf,
  appLabel,
  clock,
  dayLabel,
  eventSentence,
  outcomeOf,
  plainReason,
  serviceOf,
  splitTarget,
  toolWords,
  type Outcome,
} from '@/lib/apps'
import { Page } from '@/components/page'
import { PageIntro } from '@/components/guides'
import { AppAvatar } from '@/components/app-ui'
import { BusyButton, ErrorLine } from '@/components/gateway'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

const PAGE = 50

const ICON: Record<Outcome, { icon: typeof CheckIcon; cls: string; label: string }> = {
  done: { icon: CheckIcon, cls: 'bg-emerald-500/15 text-emerald-300', label: 'Done' },
  blocked: { icon: ShieldXIcon, cls: 'bg-rose-500/15 text-rose-300', label: 'Blocked' },
  waiting: { icon: ClockIcon, cls: 'bg-amber-500/15 text-amber-300', label: 'Waiting for you' },
  failed: { icon: CircleAlertIcon, cls: 'bg-rose-500/15 text-rose-300', label: 'Failed' },
  info: { icon: InfoIcon, cls: 'bg-muted text-muted-foreground', label: 'Info' },
}

export function OutcomeIcon({ outcome }: { outcome: string }) {
  const o = ICON[outcomeOf(outcome)]
  const Icon = o.icon
  return (
    <span className={cn('grid size-6 shrink-0 place-items-center rounded-full', o.cls)} title={o.label} aria-label={o.label} role="img">
      <Icon className="size-3.5" />
    </span>
  )
}

function reasonOf(e: GwEvent): string {
  const d = e.detail
  if (d && typeof d === 'object' && !Array.isArray(d)) {
    const o = d as Record<string, unknown>
    for (const k of ['reason', 'error', 'note']) if (typeof o[k] === 'string') return o[k] as string
  }
  return typeof d === 'string' ? d : ''
}

const ALL = '__all'

export function ActivityView({ onApprovals, onUnauthorized }: { onApprovals: () => void; onUnauthorized: () => void }) {
  const first = useGw(() => gw.activity(undefined, PAGE), [], onUnauthorized)
  const [older, setOlder] = useState<GwEvent[]>([])
  const [done, setDone] = useState(false)
  const [loading, setLoading] = useState(false)
  const [agent, setAgent] = useState(ALL)
  const [app, setApp] = useState(ALL)
  const [outcome, setOutcome] = useState(ALL)

  const events = useMemo(
    () => (first.data ? [...first.data.events, ...older].filter((e) => e.action !== 'gw.result' || e.outcome !== 'ok') : null),
    [first.data, older],
  )
  const agents = useMemo(() => [...new Set((events ?? []).map((e) => e.agent).filter((x): x is string => !!x))].sort(), [events])
  const apps = useMemo(
    () => [...new Set((events ?? []).map((e) => splitTarget(e.target).connection).filter((x): x is string => !!x && x.includes('_')))].sort(),
    [events],
  )
  const shown = (events ?? []).filter(
    (e) =>
      (agent === ALL || (agent === 'you' ? !e.agent : e.agent === agent)) &&
      (app === ALL || splitTarget(e.target).connection === app) &&
      (outcome === ALL || outcomeOf(e.outcome) === outcome),
  )
  const days: [string, GwEvent[]][] = []
  for (const e of shown) {
    const d = dayLabel(e.ts)
    const last = days[days.length - 1]
    if (last && last[0] === d) last[1].push(e)
    else days.push([d, [e]])
  }
  const raw = first.data ? [...first.data.events, ...older] : []
  const lastId = raw[raw.length - 1]?.id

  const more = async () => {
    if (!lastId) return
    setLoading(true)
    try {
      const r = await gw.activity(lastId, PAGE)
      setOlder((o) => [...o, ...r.events])
      if (r.events.length < PAGE) setDone(true)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Page
      title="Activity"
      intro="Everything your agents did with your apps, and every change you made. Newest first."
      action={
        <BusyButton
          size="sm"
          variant="outline"
          onClick={async () => {
            setOlder([])
            setDone(false)
            await first.reload()
          }}
        >
          <RefreshCwIcon />
          Refresh
        </BusyButton>
      }
    >
      <PageIntro page="activity" />
      <ErrorLine error={first.error} />

      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filters">
        <Select value={agent} onValueChange={setAgent}>
          <SelectTrigger size="sm" className="w-44" aria-label="Filter by agent">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Everyone</SelectItem>
            <SelectItem value="you">You (in the console)</SelectItem>
            {agents.map((a) => (
              <SelectItem key={a} value={a}>
                {a}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={app} onValueChange={setApp}>
          <SelectTrigger size="sm" className="w-48" aria-label="Filter by app">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All apps</SelectItem>
            {apps.map((a) => (
              <SelectItem key={a} value={a}>
                {appLabel(a)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={outcome} onValueChange={setOutcome}>
          <SelectTrigger size="sm" className="w-44" aria-label="Filter by outcome">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Any outcome</SelectItem>
            {(['done', 'waiting', 'blocked', 'failed'] as Outcome[]).map((o) => (
              <SelectItem key={o} value={o}>
                {OUTCOME_WORD[o]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {(agent !== ALL || app !== ALL || outcome !== ALL) && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setAgent(ALL)
              setApp(ALL)
              setOutcome(ALL)
            }}
          >
            Clear filters
          </Button>
        )}
      </div>

      {events == null ? (
        <div className="grid gap-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : days.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
          {events.length ? 'Nothing matches these filters.' : 'Nothing has happened yet. Once an agent uses an app, it shows up here.'}
        </p>
      ) : (
        <div className="grid gap-6">
          {days.map(([d, list]) => (
            <section key={d}>
              <h2 className="sticky top-0 z-10 mb-2 bg-background/90 py-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase backdrop-blur">
                {d}
              </h2>
              <ol className="divide-y divide-border rounded-xl border border-border bg-card/30">
                {list.map((e) => (
                  <Row key={e.id} e={e} onApprovals={onApprovals} />
                ))}
              </ol>
            </section>
          ))}
        </div>
      )}

      {events && !done && raw.length >= PAGE && (
        <Button variant="outline" onClick={more} disabled={loading} className="justify-self-center">
          {loading && <Loader2Icon className="animate-spin" />}
          Load older
        </Button>
      )}
    </Page>
  )
}

function Row({ e, onApprovals }: { e: GwEvent; onApprovals: () => void }) {
  const { connection, tool } = splitTarget(e.target)
  const o = outcomeOf(e.outcome)
  const reason = o === 'blocked' || o === 'failed' || o === 'waiting' ? plainReason(reasonOf(e)) : ''
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <OutcomeIcon outcome={e.outcome} />
      {connection && connection.includes('_') ? (
        <AppAvatar service={serviceOf(connection)} size="sm" className="mt-[-2px]" />
      ) : (
        <span className="size-7 shrink-0" />
      )}
      <div className="min-w-0 flex-1">
        <p className="text-sm break-words">
          <span className="font-medium">{actorOf(e)}</span>
          <span className="text-muted-foreground"> · </span>
          {eventSentence(e)}
          {connection && connection.includes('_') && <span className="text-muted-foreground"> ({connection})</span>}
          {tool && (
            <>
              <span className="text-muted-foreground"> · </span>
              <span title={tool}>{toolWords(tool).toLowerCase()}</span>
            </>
          )}
        </p>
        {(reason || o !== 'done') && o !== 'info' && (
          <p className={cn('mt-0.5 text-xs', o === 'waiting' ? 'text-amber-300' : 'text-rose-300')}>
            {OUTCOME_WORD[o]}
            {reason && `: ${reason}`}
            {o === 'waiting' && (
              <button type="button" onClick={onApprovals} className="ml-2 text-sky-400 hover:underline">
                Open approvals
              </button>
            )}
          </p>
        )}
      </div>
      <time className="shrink-0 text-xs text-muted-foreground tabular-nums" dateTime={e.ts}>
        {clock(e.ts)}
      </time>
    </li>
  )
}
