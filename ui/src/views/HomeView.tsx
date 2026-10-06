import { useEffect } from 'react'
import {
  ActivityIcon,
  AlertTriangleIcon,
  ArrowRightIcon,
  BellRingIcon,
  BlocksIcon,
  BotIcon,
  CheckIcon,
  LaptopIcon,
  PlugIcon,
  RefreshCwIcon,
  SparklesIcon,
  XIcon,
  ZapIcon,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { gw, reconnect, useGw, type Home } from '@/lib/gateway'
import { actorOf, ago, appLabel, eventSentence, serviceOf, splitTarget, toolWords } from '@/lib/apps'
import { useGuides } from '@/lib/guides'
import { usePulse } from '@/lib/pulse'
import { Page } from '@/components/page'
import { PageIntro } from '@/components/guides'
import { AppAvatar, Panel, StatTile } from '@/components/app-ui'
import { ApprovalItem } from '@/components/approvals'
import { BusyButton, ErrorLine } from '@/components/gateway'
import { OutcomeIcon } from '@/views/ActivityView'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

function greeting() {
  const h = new Date().getHours()
  return h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}

export function HomeView({
  onApps,
  onOpenApp,
  onDirectory,
  onAgents,
  onAddDevice,
  onActivity,
  onApprovals,
  onNotifications,
  onUnauthorized,
}: {
  onApps: () => void
  onOpenApp: (id: string) => void
  onDirectory: () => void
  onAgents: () => void
  onAddDevice: () => void
  onActivity: () => void
  onApprovals: () => void
  onNotifications: () => void
  onUnauthorized: () => void
}) {
  const home = useGw(() => gw.home(), [], onUnauthorized)
  const pulse = usePulse()
  const guides = useGuides()
  const h = home.data

  // keep Home in step with decisions made from the bell
  const pendingCount = pulse.approvals?.length
  const { reload } = home
  useEffect(() => {
    if (pendingCount != null) reload()
  }, [pendingCount, reload])

  const auth = (id: string) => pulse.overview?.connections.find((c) => c.id === id)?.auth
  const pending = pulse.approvals ?? null
  const needsYou = (pending?.length ?? 0) + (h?.attention.length ?? 0) + (h?.review.length ?? 0)

  return (
    <Page
      title={h ? `${greeting()}, ${h.user.replace(/^@/, '')}` : greeting()}
      intro="Here is what needs you, and what your agents have been up to."
    >
      <PageIntro page="home" onAction={onDirectory} />
      <ErrorLine error={home.error} />

      <Panel
        title={
          <span className="flex items-center gap-2">
            Needs you
            {needsYou > 0 && (
              <span className="rounded-full bg-amber-500/20 px-2 text-xs font-medium text-amber-300 tabular-nums">{needsYou}</span>
            )}
          </span>
        }
        description="Requests waiting for your OK, and apps that need a hand."
        action={
          pending && pending.length > 0 ? (
            <Button size="sm" variant="ghost" onClick={onApprovals}>
              All approvals
              <ArrowRightIcon />
            </Button>
          ) : undefined
        }
      >
        {pending == null || !h ? (
          <Skeleton className="h-24 w-full" />
        ) : needsYou === 0 ? (
          <div className="flex items-center gap-3 rounded-lg bg-emerald-500/5 px-4 py-4 text-sm">
            <span className="grid size-8 place-items-center rounded-full bg-emerald-500/15 text-emerald-300">
              <CheckIcon className="size-4" />
            </span>
            You're all caught up. Agents that need your OK will show up here, and on your phone if you turn on notifications.
          </div>
        ) : (
          <div className="grid gap-3">
            {pending.slice(0, 4).map((a) => (
              <ApprovalItem key={a.id} a={a} />
            ))}
            {pending.length > 4 && (
              <Button variant="outline" size="sm" onClick={onApprovals} className="justify-self-start">
                {pending.length - 4} more waiting
              </Button>
            )}
            {h.attention.map((c) => (
              <div key={c.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-500/25 bg-amber-500/5 p-4">
                <AppAvatar service={serviceOf(c.connection)} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1.5 text-sm font-medium">
                    <AlertTriangleIcon className="size-3.5 text-amber-300" />
                    {c.status === 'pending'
                      ? `Finish signing in to ${appLabel(c.connection)}`
                      : `${appLabel(c.connection)} needs you to sign in again`}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    Agents can't use it until then.{c.last_error ? ` The app said: “${c.last_error}”.` : ''}
                  </p>
                </div>
                {auth(c.id) === 'oauth' ? (
                  <BusyButton size="sm" onClick={() => reconnect(c.id)}>
                    <RefreshCwIcon />
                    {c.status === 'pending' ? 'Finish sign-in' : 'Reconnect'}
                  </BusyButton>
                ) : (
                  <Button size="sm" onClick={() => onOpenApp(c.id)}>
                    <RefreshCwIcon />
                    Reconnect
                  </Button>
                )}
              </div>
            ))}
            {h.review.map((r) => (
              <div key={r.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-violet-500/25 bg-violet-500/5 p-4">
                <AppAvatar service={serviceOf(r.connection)} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1.5 text-sm font-medium">
                    <SparklesIcon className="size-3.5 text-violet-300" />
                    {appLabel(r.connection)} has {r.tools_to_review} new or changed tool{r.tools_to_review === 1 ? '' : 's'}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">Agents can't use them until you take a look.</p>
                </div>
                <Button size="sm" variant="outline" onClick={() => onOpenApp(r.id)}>
                  Review
                </Button>
              </div>
            ))}
          </div>
        )}
      </Panel>

      {h && !guides.checklistHidden && !Object.values(h.checklist).every(Boolean) && (
        <Checklist
          h={h}
          onDismiss={guides.hideChecklist}
          onConnect={onDirectory}
          onDevice={onAddDevice}
          onAgents={onAgents}
          onNotifications={onNotifications}
        />
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile icon={BlocksIcon} label="Apps" value={h?.counts.apps ?? '–'} hint="connected" onClick={onApps} />
        <StatTile
          icon={BotIcon}
          label="Agents"
          value={h?.counts.agents ?? '–'}
          hint={h ? `on ${h.counts.machines} device${h.counts.machines === 1 ? '' : 's'}` : ' '}
          onClick={onAgents}
        />
        <StatTile icon={ZapIcon} label="Calls this week" value={h?.counts.calls_7d ?? '–'} hint="by your agents" onClick={onActivity} />
      </div>

      <Panel
        title="Recent activity"
        description="The last few things that happened, newest first."
        action={
          <Button size="sm" variant="ghost" onClick={onActivity}>
            See all
            <ArrowRightIcon />
          </Button>
        }
      >
        {!h ? (
          <Skeleton className="h-40 w-full" />
        ) : h.recent.length ? (
          <ul className="divide-y divide-border">
            {h.recent.map((e) => {
              const { connection, tool } = splitTarget(e.target)
              return (
                <li key={e.id} className="flex items-center gap-3 py-2.5">
                  <OutcomeIcon outcome={e.outcome} />
                  {connection && <AppAvatar service={serviceOf(connection)} size="sm" />}
                  <p className="min-w-0 flex-1 truncate text-sm">
                    <span className="font-medium">{actorOf(e)}</span> {eventSentence(e)}
                    {tool && <span className="text-muted-foreground"> · {toolWords(tool).toLowerCase()}</span>}
                  </p>
                  <span className="shrink-0 text-xs text-muted-foreground">{ago(e.ts)}</span>
                </li>
              )
            })}
          </ul>
        ) : (
          <div className="flex items-center gap-3 py-4 text-sm text-muted-foreground">
            <ActivityIcon className="size-4" />
            Nothing yet. Once an agent uses one of your apps, it shows up here.
          </div>
        )}
      </Panel>
    </Page>
  )
}

function Checklist({
  h,
  onDismiss,
  onConnect,
  onDevice,
  onAgents,
  onNotifications,
}: {
  h: Home
  onDismiss: () => void
  onConnect: () => void
  onDevice: () => void
  onAgents: () => void
  onNotifications: () => void
}) {
  const steps = [
    {
      done: h.checklist.connect_app,
      icon: PlugIcon,
      title: 'Connect an app',
      body: 'Pick Figma, Linear, GitHub or any app from the directory.',
      cta: 'Open the directory',
      run: onConnect,
    },
    {
      done: h.checklist.add_agent,
      icon: LaptopIcon,
      title: 'Add a device',
      body: 'Install the brain tool where your agents run and approve its code.',
      cta: 'Add a device',
      run: onDevice,
    },
    {
      done: h.checklist.first_call,
      icon: ZapIcon,
      title: 'Make a first call',
      body: 'Ask your agent something that needs an app, e.g. “list my Linear issues”.',
      cta: 'How agents connect',
      run: onAgents,
    },
    {
      done: h.checklist.notifications,
      icon: BellRingIcon,
      title: 'Get approvals on your phone',
      body: 'A push the moment an agent waits for you.',
      cta: 'Set up notifications',
      run: onNotifications,
    },
  ]
  const done = steps.filter((s) => s.done).length
  return (
    <section className="rounded-xl border border-border bg-card/40 p-5" aria-label="Getting started">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Getting started</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {done} of {steps.length} done
          </p>
        </div>
        <Button size="icon-sm" variant="ghost" aria-label="Hide getting started" onClick={onDismiss}>
          <XIcon />
        </Button>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
        <div className="h-full rounded-full bg-emerald-400 transition-all" style={{ width: `${(done / steps.length) * 100}%` }} />
      </div>
      <ol className="mt-4 grid gap-3 md:grid-cols-2">
        {steps.map((s, i) => (
          <li
            key={s.title}
            className={cn('flex gap-3 rounded-lg border border-border p-3', s.done && 'border-transparent bg-muted/40')}
          >
            <span
              className={cn(
                'grid size-7 shrink-0 place-items-center rounded-full text-xs font-semibold',
                s.done ? 'bg-emerald-500/20 text-emerald-300' : 'bg-muted text-foreground',
              )}
            >
              {s.done ? <CheckIcon className="size-4" /> : i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <p className={cn('text-sm font-medium', s.done && 'text-muted-foreground line-through')}>{s.title}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{s.body}</p>
              {!s.done && (
                <Button size="xs" variant="outline" className="mt-2" onClick={s.run}>
                  {s.cta}
                </Button>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}
