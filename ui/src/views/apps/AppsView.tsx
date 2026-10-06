import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { CheckIcon, ChevronRightIcon, Loader2Icon, PlusIcon, SparklesIcon, UsersIcon, XIcon } from 'lucide-react'

import { cn } from '@/lib/utils'
import { attempt, gw, useGw, type Catalog, type Connection, type Share } from '@/lib/gateway'
import { accessMap, appAccess } from '@/lib/access'
import { accessShort, connectionAccount, labelOf, serviceName } from '@/lib/apps'
import { usePulse } from '@/lib/pulse'
import { Page } from '@/components/page'
import { PageIntro } from '@/components/guides'
import { AppAvatar, AppStatus, Pill } from '@/components/app-ui'
import { BusyButton, ErrorLine } from '@/components/gateway'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { AppTile, Directory } from '@/views/apps/Directory'
import { AppDetail } from '@/views/apps/AppDetail'

const POPULAR = ['context7', 'deepwiki', 'figma']

export function AppsView({
  openId,
  directory,
  directoryQuery,
  connected,
  onOpen,
  onDirectory,
  onAdvancedRules,
  onUnauthorized,
}: {
  openId: string | null
  directory: boolean
  directoryQuery?: string
  connected: string | null
  onOpen: (id: string | null) => void
  onDirectory: (open: boolean, query?: string) => void
  onAdvancedRules: () => void
  onUnauthorized: () => void
}) {
  const overview = useGw(() => gw.overview(), [], onUnauthorized)
  const rules = useGw(() => gw.rules(), [], onUnauthorized)
  const shares = useGw(() => gw.shares(), [], onUnauthorized)
  const pulse = usePulse()
  const conns = overview.data?.connections ?? null

  const reload = () => {
    overview.reload()
    rules.reload()
    shares.reload()
    pulse.refresh()
  }

  // Back from an OAuth sign-in: say so, and open the app that was just connected.
  const [connectedSeen, setConnectedSeen] = useState<string | null>(null)
  useEffect(() => {
    if (!connected || !conns || connectedSeen === connected) return
    setConnectedSeen(connected)
    const c = conns.find((x) => x.connection === connected)
    toast.success(`${c ? serviceName(c.service) : connected} is connected`, {
      description: 'All your agents can read it now. Choose below if they may do more.',
    })
    if (c?.id) onOpen(c.id)
  }, [connected, conns, connectedSeen, onOpen])

  const access = useMemo(() => accessMap(rules.data?.rules ?? []), [rules.data])
  const groups = useMemo(() => {
    const m = new Map<string, Connection[]>()
    for (const c of conns ?? []) {
      const list = m.get(c.service) ?? []
      list.push(c)
      m.set(c.service, list)
    }
    return [...m.entries()].sort((a, b) => serviceName(a[0]).localeCompare(serviceName(b[0])))
  }, [conns])

  const current = conns?.find((c) => c.id === openId) ?? null
  const incoming = shares.data?.incoming.filter((s) => !s.accepted) ?? []

  return (
    <Page
      title="Apps"
      intro="The apps your agents can use for you. Click one to choose what agents may do in it."
      action={
        <Button onClick={() => onDirectory(true)}>
          <PlusIcon />
          Add an app
        </Button>
      }
    >
      <PageIntro page="apps" onAction={() => onDirectory(true)} />
      <ErrorLine error={overview.error} />

      {incoming.length > 0 && <IncomingShares shares={incoming} onDone={reload} />}

      {conns == null ? (
        <div className="grid gap-4 md:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-36 rounded-xl" />
          ))}
        </div>
      ) : conns.length === 0 ? (
        <EmptyApps onDirectory={() => onDirectory(true)} onConnected={(id) => { reload(); if (id) onOpen(id) }} onUnauthorized={onUnauthorized} />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {groups.map(([service, list]) => (
            <ServiceCard
              key={service}
              service={service}
              conns={list}
              summary={(c) => {
                if (c.shared_by) return `Shared by ${c.shared_by}`
                const a = appAccess(access, c.connection)
                return rules.data ? accessShort(a.level, a.ask) : ''
              }}
              onOpen={onOpen}
              onAdd={() => onDirectory(true, serviceName(service))}
            />
          ))}
        </div>
      )}

      <Directory
        open={directory}
        initialQuery={directoryQuery}
        onOpenChange={onDirectory}
        connections={conns ?? []}
        vaultReady={overview.data?.vault_ready ?? true}
        onUnauthorized={onUnauthorized}
        onConnected={(id) => {
          reload()
          if (id) window.setTimeout(() => onOpen(id), 50)
        }}
      />

      {current && (
        <AppDetail
          key={current.id}
          conn={current}
          outgoing={(shares.data?.outgoing ?? []).filter((s: Share) => s.id === current.id)}
          onClose={() => onOpen(null)}
          onChanged={reload}
          onDeleted={() => {
            onOpen(null)
            reload()
          }}
          onAdvancedRules={onAdvancedRules}
          onUnauthorized={onUnauthorized}
        />
      )}
    </Page>
  )
}

function ServiceCard({
  service,
  conns,
  summary,
  onOpen,
  onAdd,
}: {
  service: string
  conns: Connection[]
  summary: (c: Connection) => string
  onOpen: (id: string) => void
  onAdd: () => void
}) {
  const name = serviceName(service)
  const review = conns.reduce((n, c) => n + (c.review ?? 0), 0)
  return (
    <section className="flex flex-col rounded-xl border border-border bg-card/40" aria-label={name}>
      <div className="flex items-center gap-3 px-4 pt-4 pb-2">
        <AppAvatar service={service} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold tracking-tight">{name}</h2>
          <p className="text-xs text-muted-foreground">
            {conns.length === 1 ? '1 account' : `${conns.length} accounts`}
          </p>
        </div>
        {review > 0 && (
          <Pill tone="violet" title="New or changed tools wait for your review">
            <SparklesIcon className="size-3" />
            {review} to review
          </Pill>
        )}
      </div>
      <ul className="grid gap-1 px-2 pb-2">
        {conns.map((c) => {
          const label = c.label ?? labelOf(c.connection)
          return (
            <li key={c.id ?? c.connection}>
              <button
                type="button"
                disabled={!c.id}
                onClick={() => c.id && onOpen(c.id)}
                className="group flex w-full items-center gap-3 rounded-lg px-2 py-2.5 text-left transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none disabled:cursor-default"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium">
                      {connectionAccount(c) || (label === 'main' ? name : label)}
                    </span>
                    {label && label !== 'main' && <Pill className="py-0">{label}</Pill>}
                    <AppStatus status={c.status} />
                  </div>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {summary(c)}
                    {c.shared_by ? '' : ` · ${c.tools} tool${c.tools === 1 ? '' : 's'}`}
                  </p>
                </div>
                <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
              </button>
            </li>
          )
        })}
      </ul>
      <div className="mt-auto border-t border-border px-4 py-2">
        <button type="button" onClick={onAdd} className="text-xs text-muted-foreground hover:text-foreground">
          + Add another {name} account
        </button>
      </div>
    </section>
  )
}

function IncomingShares({ shares, onDone }: { shares: Share[]; onDone: () => void }) {
  return (
    <section className="grid gap-2 rounded-xl border border-violet-500/30 bg-violet-500/5 p-4">
      <div className="flex items-center gap-2">
        <UsersIcon className="size-4 text-violet-300" />
        <h2 className="text-sm font-semibold">Shared with you</h2>
      </div>
      {shares.map((s) => (
        <div key={s.id} className="flex flex-wrap items-center gap-3 rounded-lg bg-background/60 px-3 py-2.5">
          <AppAvatar service={s.service} size="sm" />
          <p className="min-w-0 flex-1 text-sm">
            <b>@{s.owner}</b> shared <b>{serviceName(s.service)}</b>
            {s.account && <span className="text-muted-foreground"> ({s.account})</span>} with you
            <span className="text-muted-foreground">
              {' '}
              · {s.tools.length ? `${s.tools.length} tools` : 'tools that read'}
            </span>
          </p>
          <BusyButton
            size="sm"
            onClick={async () => {
              if (await attempt(() => gw.accept(s.id), `You can now use ${s.connection}`)) onDone()
            }}
          >
            <CheckIcon />
            Accept
          </BusyButton>
          <BusyButton
            size="sm"
            variant="ghost"
            onClick={async () => {
              if (await attempt(() => gw.decline(s.id), 'Declined')) onDone()
            }}
          >
            <XIcon />
            Decline
          </BusyButton>
        </div>
      ))}
    </section>
  )
}

function EmptyApps({
  onDirectory,
  onConnected,
  onUnauthorized,
}: {
  onDirectory: () => void
  onConnected: (id: string | null) => void
  onUnauthorized: () => void
}) {
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  useEffect(() => {
    gw.catalog().then(setCatalog).catch(() => {})
  }, [])
  const popular = POPULAR.map((id) => catalog?.featured.find((a) => a.id === id)).filter((a) => !!a)
  return (
    <section className="rounded-2xl border border-dashed border-border px-6 py-12 text-center">
      <div className="mx-auto grid size-14 place-items-center rounded-2xl bg-gradient-to-br from-sky-500/20 to-violet-500/20">
        <PlusIcon className="size-6" />
      </div>
      <h2 className="mt-4 text-xl font-semibold tracking-tight">Connect your first app</h2>
      <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
        Your agents can use any app you connect, without ever seeing your password. Start with one of these, or browse the
        whole directory.
      </p>
      <div className={cn('mx-auto mt-6 grid max-w-3xl gap-3 text-left sm:grid-cols-3')}>
        {catalog == null ? (
          <Loader2Icon className="col-span-full mx-auto size-5 animate-spin text-muted-foreground" />
        ) : (
          popular.map((a) => (
            <AppTile
              key={a.id}
              app={a}
              compact
              redirectUri={catalog.redirect_uri}
              connections={[]}
              onDone={onConnected}
              onUnauthorized={onUnauthorized}
            />
          ))
        )}
      </div>
      <Button className="mt-6" variant="outline" onClick={onDirectory}>
        Browse all apps
      </Button>
    </section>
  )
}
