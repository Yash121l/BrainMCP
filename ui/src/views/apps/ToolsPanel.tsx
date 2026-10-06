import { useState } from 'react'
import { CheckCheckIcon, CheckIcon, ChevronDownIcon, EyeIcon, EyeOffIcon, SparklesIcon } from 'lucide-react'

import { cn } from '@/lib/utils'
import { attempt, gw, RISKS, wordDiff, type Risk, type UpstreamTool } from '@/lib/gateway'
import { RISK_HINT, RISK_WORD, toolWords } from '@/lib/apps'
import { Pill, type PillTone } from '@/components/app-ui'
import { BusyButton } from '@/components/gateway'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

const RISK_TONE: Record<Risk, PillTone> = { read: 'sky', write: 'amber', destructive: 'red', critical: 'violet' }

export function RiskPill({ risk }: { risk: Risk }) {
  return (
    <Pill tone={RISK_TONE[risk]} title={RISK_HINT[risk]}>
      {RISK_WORD[risk]}
    </Pill>
  )
}

const effective = (t: UpstreamTool): Risk => t.risk_override ?? t.risk

/** Banner listing new and changed tools, with a before/after diff and Approve. */
export function ToolReviewBanner({
  connId,
  tools,
  onChanged,
}: {
  connId: string
  tools: UpstreamTool[]
  onChanged: () => void
}) {
  const review = tools.filter((t) => t.state === 'pending' || t.state === 'changed')
  if (!review.length) return null
  const act = async (names: string[], action: 'approve' | 'hide', msg: string) => {
    if (await attempt(() => gw.reviewTools(connId, names, action), msg)) onChanged()
  }
  return (
    <section className="rounded-xl border border-violet-500/30 bg-violet-500/5 p-4">
      <div className="flex flex-wrap items-start gap-3">
        <SparklesIcon className="mt-0.5 size-4 text-violet-300" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">
            {review.length} tool{review.length === 1 ? ' is' : 's are'} new or changed
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Agents can't use {review.length === 1 ? 'it' : 'them'} until you approve. Read the description: a changed one
            could now carry instructions aimed at your agent.
          </p>
        </div>
        {review.length > 1 && (
          <BusyButton size="sm" onClick={() => act(review.map((t) => t.name), 'approve', `Approved ${review.length} tools`)}>
            <CheckCheckIcon />
            Approve all
          </BusyButton>
        )}
      </div>
      <div className="mt-3 grid gap-3">
        {review.map((t) => (
          <div key={t.name} className="grid gap-2 rounded-lg border border-border bg-background/60 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{toolWords(t.name)}</span>
              <code className="font-mono text-[11px] text-muted-foreground">{t.name}</code>
              <Pill tone={t.state === 'changed' ? 'violet' : 'amber'}>{t.state === 'changed' ? 'Changed' : 'New'}</Pill>
              <RiskPill risk={effective(t)} />
              <div className="ml-auto flex gap-1.5">
                <BusyButton size="xs" onClick={() => act([t.name], 'approve', `Approved ${t.name}`)}>
                  <CheckIcon />
                  Approve
                </BusyButton>
                <BusyButton size="xs" variant="ghost" onClick={() => act([t.name], 'hide', `Hid ${t.name}`)}>
                  <EyeOffIcon />
                  Hide
                </BusyButton>
              </div>
            </div>
            {t.state === 'changed' && t.approved_description != null ? (
              <DescriptionDiff before={t.approved_description} after={t.description ?? ''} />
            ) : (
              t.description && <p className="text-xs whitespace-pre-wrap text-muted-foreground">{t.description}</p>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}

function DescriptionDiff({ before, after }: { before: string; after: string }) {
  const parts = wordDiff(before, after)
  const side = (keep: 'removed' | 'added') =>
    parts
      .filter((p) => p.kind === 'same' || p.kind === keep)
      .map((p, i) => (
        <span
          key={i}
          className={cn(
            p.kind === 'removed' && 'rounded-sm bg-rose-500/20 text-rose-200 line-through',
            p.kind === 'added' && 'rounded-sm bg-emerald-500/20 text-emerald-200',
          )}
        >
          {p.text}
        </span>
      ))
  return (
    <div className="grid gap-2 md:grid-cols-2">
      <div className="grid content-start gap-1">
        <span className="text-[11px] font-medium text-muted-foreground">Before (what you approved)</span>
        <p className="rounded-md border border-border bg-muted/30 p-2 text-xs whitespace-pre-wrap text-muted-foreground">
          {before ? side('removed') : <i>no description</i>}
        </p>
      </div>
      <div className="grid content-start gap-1">
        <span className="text-[11px] font-medium text-muted-foreground">Now</span>
        <p className="rounded-md border border-violet-500/30 bg-muted/30 p-2 text-xs whitespace-pre-wrap">
          {after ? side('added') : <i>no description</i>}
        </p>
      </div>
    </div>
  )
}

export function ToolsPanel({
  connId,
  tools,
  editable,
  onChanged,
}: {
  connId: string
  tools: UpstreamTool[] | null
  editable: boolean
  onChanged: () => void
}) {
  const [open, setOpen] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  if (!tools) return <Skeleton className="h-12 w-full" />

  const live = tools.filter((t) => t.state === 'approved')
  const hidden = tools.filter((t) => t.state === 'hidden')
  const removed = tools.filter((t) => t.state === 'removed')
  const counts = RISKS.map((r) => [r, live.filter((t) => effective(t) === r).length] as const).filter(([, n]) => n > 0)
  const shown = advanced ? [...live, ...hidden, ...removed] : live

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="inline-flex items-center gap-2 rounded-md text-sm font-medium hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
        >
          <ChevronDownIcon className={cn('size-4 transition-transform', open && 'rotate-180')} />
          {live.length} tool{live.length === 1 ? '' : 's'} agents can use
        </button>
        <div className="flex flex-wrap gap-1.5">
          {counts.map(([r, n]) => (
            <Pill key={r} tone={RISK_TONE[r]} title={RISK_HINT[r]}>
              {n} {RISK_WORD[r].toLowerCase()}
            </Pill>
          ))}
          {hidden.length > 0 && <Pill>{hidden.length} hidden</Pill>}
        </div>
        {editable && open && (
          <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
            <Switch checked={advanced} onCheckedChange={setAdvanced} aria-label="Show advanced tool settings" />
            Advanced
          </label>
        )}
      </div>
      {open && (
        <>
          {advanced && (
            <p className="text-xs text-muted-foreground">
              Advanced: override how risky a tool is, or whether it “sends data out” (egress). Hidden tools are invisible to
              every agent.
            </p>
          )}
          {shown.length ? (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {shown.map((t) => (
                <ToolRow key={t.name} connId={connId} t={t} advanced={advanced && editable} onChanged={onChanged} />
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No tools yet. Use “Refresh tools” above to fetch them.</p>
          )}
        </>
      )}
    </div>
  )
}

function ToolRow({
  connId,
  t,
  advanced,
  onChanged,
}: {
  connId: string
  t: UpstreamTool
  advanced: boolean
  onChanged: () => void
}) {
  const set = async (patch: { risk: Risk | '' } | { egress: boolean | 'auto' }) => {
    if (await attempt(() => gw.setTool(connId, t.name, patch))) onChanged()
  }
  const review = async (action: 'approve' | 'hide', msg: string) => {
    if (await attempt(() => gw.reviewTools(connId, [t.name], action), msg)) onChanged()
  }
  return (
    <li className={cn('grid gap-1.5 px-3 py-2.5', t.state !== 'approved' && 'opacity-70')}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{toolWords(t.name)}</span>
        <RiskPill risk={effective(t)} />
        {t.egress && (
          <Pill tone="amber" title="Sends something outside the app, like an email, post or upload">
            Sends data out
          </Pill>
        )}
        {t.state === 'hidden' && <Pill>Hidden</Pill>}
        {t.state === 'removed' && <Pill tone="red">Removed by the app</Pill>}
        <code className="ml-auto font-mono text-[11px] text-muted-foreground">{t.name}</code>
      </div>
      {t.description && <p className="line-clamp-2 text-xs text-muted-foreground" title={t.description}>{t.description}</p>}
      {advanced && t.state !== 'removed' && (
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <Select value={t.risk_override ?? 'auto'} onValueChange={(v) => set({ risk: v === 'auto' ? '' : (v as Risk) })}>
            <SelectTrigger size="sm" className="h-7 w-44 text-xs" aria-label={`Risk of ${t.name}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Risk: automatic ({RISK_WORD[t.risk].toLowerCase()})</SelectItem>
              {RISKS.map((r) => (
                <SelectItem key={r} value={r}>
                  Risk: {RISK_WORD[r].toLowerCase()} ({r})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={t.egress_mode ?? 'auto'} onValueChange={(v) => set({ egress: v === 'auto' ? 'auto' : v === 'on' })}>
            <SelectTrigger size="sm" className="h-7 w-52 text-xs" aria-label={`Sends data out: ${t.name}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Sends data out: automatic ({t.egress ? 'yes' : 'no'})</SelectItem>
              <SelectItem value="on">Sends data out: yes (egress on)</SelectItem>
              <SelectItem value="off">Sends data out: no (egress off)</SelectItem>
            </SelectContent>
          </Select>
          {t.state === 'hidden' ? (
            <BusyButton size="xs" variant="outline" onClick={() => review('approve', `${t.name} is visible again`)}>
              <EyeIcon />
              Show to agents
            </BusyButton>
          ) : (
            <BusyButton size="xs" variant="ghost" onClick={() => review('hide', `Hid ${t.name}`)}>
              <EyeOffIcon />
              Hide from agents
            </BusyButton>
          )}
        </div>
      )}
    </li>
  )
}
