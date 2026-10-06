import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  BadgeCheckIcon,
  ExternalLinkIcon,
  GlobeIcon,
  LinkIcon,
  Loader2Icon,
  PlusIcon,
  SearchIcon,
  XIcon,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { Unauthorized } from '@/lib/api'
import {
  gw,
  type Catalog,
  type CatalogApp,
  type ConnectAppInput,
  type ConnectAppResult,
  type Connection,
} from '@/lib/gateway'
import { AppAvatar, CopyField, Pill } from '@/components/app-ui'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ConnectDialog } from '@/views/connections/ConnectDialog'

/** The service id the server gives an app (mirrors serviceId in src/apps.js). */
export function serviceIdOf(app: Pick<CatalogApp, 'id'>): string {
  let s = app.id.toLowerCase().split('/').pop()!.replace(/[^a-z0-9]/g, '')
  if (!/^[a-z]/.test(s)) s = `app${s}`
  return s.slice(0, 24) || 'app'
}

/** Accounts already connected for a directory entry (matched by URL, or by service id). */
export function connectedFor(app: CatalogApp, connections: Connection[]) {
  const sid = serviceIdOf(app)
  const seen = new Set(app.connected.map((c) => c.id))
  const extra = connections
    .filter((c) => c.id && !c.shared_by && c.service === sid && !seen.has(c.id))
    .map((c) => ({ id: c.id!, connection: c.connection, account: c.account, status: c.status }))
  return [...app.connected, ...extra]
}

/** Run gw_connect_app and handle every outcome. Returns the result for the caller to act on. */
export async function connectApp(
  app: CatalogApp,
  extra: Partial<ConnectAppInput> = {},
  onUnauthorized?: () => void,
): Promise<ConnectAppResult | null> {
  const input: ConnectAppInput = app.verified
    ? { app_id: app.id, ...extra }
    : { app_id: app.id, name: app.name, url: app.url, auth: app.auth, header_name: app.header_name ?? null, ...extra }
  let r: ConnectAppResult
  try {
    r = await gw.connectApp(input)
  } catch (e) {
    if (e instanceof Unauthorized) onUnauthorized?.()
    else toast.error(e instanceof Error ? e.message : 'could not connect')
    return null
  }
  if (r.authorize_url) {
    toast(`Taking you to ${app.name} to sign in…`)
    window.location.href = r.authorize_url
    return r
  }
  if (r.needs) return r
  if (r.error && !r.id) {
    toast.error(r.error)
    return r
  }
  if (r.id) {
    toast.success(`${app.name} is connected`, {
      description: 'All your agents can read it now. Open it to give more access.',
    })
    if (r.warning) toast.warning(r.warning)
  }
  return r
}

export function Directory({
  open,
  initialQuery,
  onOpenChange,
  connections,
  vaultReady,
  onConnected,
  onUnauthorized,
}: {
  open: boolean
  initialQuery?: string
  onOpenChange: (v: boolean) => void
  connections: Connection[]
  vaultReady: boolean
  onConnected: (id: string | null) => void
  onUnauthorized: () => void
}) {
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('All')
  const [registry, setRegistry] = useState<{ q: string; items: CatalogApp[] } | null>(null)
  const [searching, setSearching] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const customRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open) {
      setQuery(initialQuery ?? '')
      setCategory('All')
    }
  }, [open, initialQuery])

  useEffect(() => {
    if (!open || catalog) return
    gw.catalog()
      .then(setCatalog)
      .catch((e) => {
        if (e instanceof Unauthorized) onUnauthorized()
        else toast.error(e instanceof Error ? e.message : 'could not load the directory')
      })
  }, [open, catalog, onUnauthorized])

  // debounced registry search
  useEffect(() => {
    const q = query.trim()
    if (!open || q.length < 2) {
      setRegistry(null)
      setSearching(false)
      return
    }
    setSearching(true)
    let alive = true
    const t = window.setTimeout(() => {
      gw.catalog(q)
        .then((c) => {
          if (!alive) return
          setRegistry({ q, items: c.registry })
          setCatalog((old) => old ?? c)
        })
        .catch(() => alive && setRegistry({ q, items: [] }))
        .finally(() => alive && setSearching(false))
    }, 400)
    return () => {
      alive = false
      window.clearTimeout(t)
    }
  }, [query, open])

  const categories = useMemo(() => {
    const seen: string[] = []
    for (const a of catalog?.featured ?? []) if (!seen.includes(a.category)) seen.push(a.category)
    return ['All', ...seen]
  }, [catalog])

  const q = query.trim().toLowerCase()
  const featured = (catalog?.featured ?? []).filter(
    (a) =>
      (category === 'All' || a.category === category) &&
      (!q || `${a.name} ${a.category} ${a.description}`.toLowerCase().includes(q)),
  )

  const done = (id: string | null) => {
    onConnected(id)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[min(90vh,56rem)] flex-col gap-0 p-0 sm:max-w-5xl"
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          searchRef.current?.focus()
        }}
      >
        <DialogHeader className="border-b border-border px-6 pt-6 pb-4 text-left">
          <DialogTitle className="text-xl">Add an app</DialogTitle>
          <DialogDescription>
            Pick an app and connect it. Your password never reaches your agents, and new apps start as read only.
          </DialogDescription>
          <div className="relative mt-3">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search apps, e.g. Notion, Stripe, search the web…"
              aria-label="Search apps"
              className="h-10 pl-9"
            />
            {query && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setQuery('')}
                className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
              >
                <XIcon className="size-4" />
              </button>
            )}
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label="Categories">
            {categories.map((c) => (
              <button
                key={c}
                type="button"
                aria-pressed={category === c}
                onClick={() => setCategory(c)}
                className={cn(
                  'rounded-full border px-3 py-1 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none',
                  category === c
                    ? 'border-transparent bg-foreground text-background'
                    : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                {c}
              </button>
            ))}
          </div>
        </DialogHeader>

        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {!vaultReady && (
            <p className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-200">
              This server has no vault key yet, so apps that need a sign-in or token cannot be stored. Apps marked “No
              sign-in” still work.
            </p>
          )}
          {catalog == null ? (
            <div className="grid place-items-center py-20 text-sm text-muted-foreground">
              <Loader2Icon className="size-5 animate-spin" />
            </div>
          ) : (
            <>
              <div className="mb-3 flex items-center gap-2">
                <BadgeCheckIcon className="size-4 text-sky-400" />
                <h3 className="text-sm font-semibold">Verified apps</h3>
                <span className="text-xs text-muted-foreground">
                  {featured.length} {category === 'All' && !q ? 'apps checked by BrainMCP' : `of ${catalog.featured.length}`}
                </span>
              </div>
              {featured.length ? (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {featured.map((a) => (
                    <AppTile
                      key={a.id}
                      app={a}
                      redirectUri={catalog.redirect_uri}
                      connections={connections}
                      onDone={done}
                      onUnauthorized={onUnauthorized}
                    />
                  ))}
                </div>
              ) : (
                <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
                  No verified app matches{q ? ` “${query.trim()}”` : ''}
                  {category !== 'All' ? ` in ${category}` : ''}.
                </p>
              )}

              {q.length >= 2 && (
                <section className="mt-8">
                  <div className="mb-3 flex items-center gap-2">
                    <GlobeIcon className="size-4 text-muted-foreground" />
                    <h3 className="text-sm font-semibold">More from the MCP Registry</h3>
                    {searching && <Loader2Icon className="size-3.5 animate-spin text-muted-foreground" />}
                  </div>
                  <p className="mb-3 text-xs text-muted-foreground">
                    Community servers from the public MCP Registry. BrainMCP has not checked these; connect only ones you
                    trust.
                  </p>
                  {registry?.items.length ? (
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                      {registry.items.map((a) => (
                        <AppTile
                          key={a.id}
                          app={a}
                          redirectUri={catalog.redirect_uri}
                          connections={connections}
                          onDone={done}
                          onUnauthorized={onUnauthorized}
                        />
                      ))}
                    </div>
                  ) : (
                    !searching && (
                      <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
                        Nothing in the registry matches “{query.trim()}”.
                      </p>
                    )
                  )}
                </section>
              )}
              <div ref={customRef} className="mt-8 scroll-mt-4">
                <CustomServerCard redirectUri={catalog.redirect_uri} onDone={done} onUnauthorized={onUnauthorized} />
              </div>
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3 border-t border-border px-6 py-3 text-xs text-muted-foreground">
          <span>Can't find it? Any MCP server works if you have its address.</span>
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              customRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              customRef.current?.querySelector('input')?.focus({ preventScroll: true })
            }}
          >
            <LinkIcon />
            Add any MCP server
          </Button>
          <ConnectDialog
            vaultReady={vaultReady}
            onDone={() => done(null)}
            trigger={
              <Button size="xs" variant="ghost" className="ml-auto">
                Advanced: set every field
              </Button>
            }
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}

const AUTH_PILL: Record<string, { label: string; title: string }> = {
  oauth: { label: 'Sign in', title: 'You sign in at the app; BrainMCP never sees your password.' },
  none: { label: 'No sign-in', title: 'Public; nothing to sign in to.' },
  token: { label: 'API token', title: 'Paste a token you create in the app.' },
  app: { label: 'Needs setup', title: 'The app asks you to register your own OAuth app first.' },
  detect: { label: 'Community', title: 'From the public MCP Registry; BrainMCP checks how it signs in when you connect.' },
}

type Mode = 'idle' | 'token' | 'app'

/** Inline fields for apps that need a token, or a client id + secret, then retry. */
function NeedsFields({
  id,
  name,
  mode,
  help,
  helpUrl,
  redirectUri,
  secret,
  setSecret,
  clientId,
  setClientId,
  clientSecret,
  setClientSecret,
}: {
  id: string
  name: string
  mode: 'token' | 'app'
  help?: string
  helpUrl?: string
  redirectUri: string
  secret: string
  setSecret: (v: string) => void
  clientId: string
  setClientId: (v: string) => void
  clientSecret: string
  setClientSecret: (v: string) => void
}) {
  if (mode === 'token')
    return (
      <div className="grid gap-1.5">
        <Label htmlFor={`tok-${id}`}>API token</Label>
        <Input
          id={`tok-${id}`}
          type="password"
          autoComplete="off"
          autoFocus
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          placeholder="Paste the token"
        />
        {help && <p className="text-xs text-muted-foreground">{help}</p>}
        {helpUrl && (
          <a href={helpUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-sky-400 hover:underline">
            Where do I get this? <ExternalLinkIcon className="size-3" />
          </a>
        )}
      </div>
    )
  return (
    <div className="grid gap-2.5">
      {help && <p className="text-xs leading-relaxed text-muted-foreground">{help}</p>}
      {helpUrl && (
        <a href={helpUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-sky-400 hover:underline">
          Open {name}'s developer page <ExternalLinkIcon className="size-3" />
        </a>
      )}
      <div className="grid gap-1.5">
        <Label>Redirect URL to paste there</Label>
        <CopyField value={redirectUri} label="redirect URL" />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`cid-${id}`}>Client ID</Label>
        <Input id={`cid-${id}`} autoFocus value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`cs-${id}`}>Client secret</Label>
        <Input id={`cs-${id}`} type="password" autoComplete="off" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} />
      </div>
    </div>
  )
}

function useNeeds() {
  const [mode, setMode] = useState<Mode>('idle')
  const [needs, setNeeds] = useState<ConnectAppResult | null>(null)
  const [secret, setSecret] = useState('')
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const reset = () => {
    setMode('idle')
    setNeeds(null)
    setSecret('')
    setClientId('')
    setClientSecret('')
  }
  const extra = (): Partial<ConnectAppInput> =>
    mode === 'token' ? { secret: secret.trim() } : mode === 'app' ? { client_id: clientId.trim(), client_secret: clientSecret.trim() } : {}
  const ready = mode === 'token' ? !!secret.trim() : mode === 'app' ? !!clientId.trim() && !!clientSecret.trim() : true
  return { mode, setMode, needs, setNeeds, secret, setSecret, clientId, setClientId, clientSecret, setClientSecret, busy, setBusy, reset, extra, ready }
}

export function AppTile({
  app,
  redirectUri,
  connections,
  onDone,
  onUnauthorized,
  compact = false,
}: {
  app: CatalogApp
  redirectUri: string
  connections: Connection[]
  onDone: (id: string | null) => void
  onUnauthorized: () => void
  compact?: boolean
}) {
  const existing = connectedFor(app, connections)
  const n = useNeeds()
  const auth = n.needs?.needs ?? app.auth

  const run = async () => {
    n.setBusy(true)
    const r = await connectApp(app, n.extra(), onUnauthorized)
    n.setBusy(false)
    if (!r) return
    if (r.needs) {
      if (n.mode !== 'idle') toast.error(r.error ?? 'Something is missing')
      n.setNeeds(r)
      n.setMode(r.needs)
      return
    }
    if (r.id && !r.authorize_url) {
      n.reset()
      onDone(r.id)
    }
  }

  // One click for sign-in and public apps; token and app-setup apps open their fields first.
  const primary = () => {
    if (auth === 'token') return n.setMode('token')
    if (auth === 'app') return n.setMode('app')
    run()
  }

  const primaryLabel = auth === 'none' ? 'Add' : auth === 'app' ? 'Set up' : 'Connect'
  const pill = AUTH_PILL[app.verified ? app.auth : 'detect'] ?? AUTH_PILL.detect

  return (
    <div
      className={cn(
        'flex flex-col rounded-xl border border-border bg-card/50 p-4 transition-colors',
        n.mode !== 'idle' && 'border-sky-500/40 bg-card',
      )}
    >
      <div className="flex items-start gap-3">
        <AppAvatar service={serviceIdOf(app)} name={app.name} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <p className="truncate text-sm font-semibold" title={app.name}>
              {app.name}
            </p>
            {app.verified && <BadgeCheckIcon className="size-3.5 shrink-0 text-sky-400" aria-label="Verified" />}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-muted-foreground">{app.verified ? app.category : 'Community'}</span>
            <Pill className="py-0" title={pill.title}>
              {pill.label}
            </Pill>
          </div>
        </div>
      </div>
      {!compact && (
        <p className="mt-2.5 line-clamp-2 min-h-8 text-xs leading-relaxed text-muted-foreground" title={app.description}>
          {app.description || app.url}
        </p>
      )}
      {app.repository && (
        <a
          href={app.repository}
          target="_blank"
          rel="noreferrer"
          className="mt-1 inline-flex items-center gap-1 truncate text-[11px] text-sky-400 hover:underline"
        >
          Source <ExternalLinkIcon className="size-3" />
        </a>
      )}

      {n.mode !== 'idle' ? (
        <form
          className="mt-3 grid gap-3 border-t border-border pt-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (n.ready && !n.busy) run()
          }}
        >
          <NeedsFields
            id={app.id}
            name={app.name}
            mode={n.mode}
            help={n.needs?.token_help ?? app.token_help}
            helpUrl={n.needs?.token_url ?? app.token_url}
            redirectUri={n.needs?.redirect_uri ?? redirectUri}
            secret={n.secret}
            setSecret={n.setSecret}
            clientId={n.clientId}
            setClientId={n.setClientId}
            clientSecret={n.clientSecret}
            setClientSecret={n.setClientSecret}
          />
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={!n.ready || n.busy}>
              {n.busy && <Loader2Icon className="animate-spin" />}
              {n.mode === 'app' ? `Continue to ${app.name}` : 'Connect'}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={n.reset}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="mt-auto flex flex-wrap items-center gap-2 pt-3">
          {existing.length > 0 ? (
            <>
              <Pill tone="green" dot className="max-w-full truncate" title={existing.map((c) => c.connection).join(', ')}>
                {existing.length === 1
                  ? `Connected as ${existing[0].account ?? existing[0].connection}`
                  : `${existing.length} accounts connected`}
              </Pill>
              <Button size="xs" variant="outline" className="ml-auto" onClick={primary} disabled={n.busy}>
                {n.busy ? <Loader2Icon className="animate-spin" /> : <PlusIcon />}
                Add another account
              </Button>
            </>
          ) : (
            <Button size="sm" className="w-full" onClick={primary} disabled={n.busy}>
              {n.busy && <Loader2Icon className="animate-spin" />}
              {primaryLabel}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

/** For servers not in the directory: paste an address, BrainMCP works out how it signs in. */
export function CustomServerCard({
  redirectUri,
  onDone,
  onUnauthorized,
}: {
  redirectUri: string
  onDone: (id: string | null) => void
  onUnauthorized: () => void
}) {
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const n = useNeeds()
  const valid = /^https?:\/\/\S+$/.test(url.trim())
  const displayName = name.trim() || (valid ? new URL(url.trim()).hostname.replace(/^(www|mcp|api)\./, '') : 'Custom app')

  const run = async () => {
    n.setBusy(true)
    const app: CatalogApp = {
      id: 'custom',
      name: displayName,
      category: 'Custom',
      url: url.trim(),
      auth: 'detect',
      description: '',
      verified: false,
      connected: [],
    }
    const r = await connectApp(app, n.extra(), onUnauthorized)
    n.setBusy(false)
    if (!r) return
    if (r.needs) {
      if (n.mode !== 'idle') toast.error(r.error ?? 'Something is missing')
      n.setNeeds(r)
      n.setMode(r.needs)
      return
    }
    if (r.id && !r.authorize_url) {
      n.reset()
      setUrl('')
      setName('')
      onDone(r.id)
    }
  }

  return (
    <section className="rounded-xl border border-dashed border-border bg-card/30 p-4" aria-label="Add any MCP server">
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted">
          <LinkIcon className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold">Add any MCP server</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Not in the list? Paste its address. BrainMCP works out whether it needs a sign-in, a token, or nothing.
          </p>
        </div>
      </div>
      <form
        className="mt-3 grid gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (valid && n.ready && !n.busy) run()
        }}
      >
        <div className="grid gap-2 sm:grid-cols-[1fr_12rem]">
          <Input
            value={url}
            onChange={(e) => {
              setUrl(e.target.value)
              if (n.mode !== 'idle') n.reset()
            }}
            placeholder="https://example.com/mcp"
            aria-label="Server address"
            inputMode="url"
          />
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (optional)" aria-label="Name (optional)" />
        </div>
        {n.mode !== 'idle' && (
          <NeedsFields
            id="custom"
            name={displayName}
            mode={n.mode}
            help={n.needs?.token_help ?? (n.mode === 'token' ? 'This server wants an API token. Create one in its settings and paste it here.' : undefined)}
            helpUrl={n.needs?.token_url}
            redirectUri={n.needs?.redirect_uri ?? redirectUri}
            secret={n.secret}
            setSecret={n.setSecret}
            clientId={n.clientId}
            setClientId={n.setClientId}
            clientSecret={n.clientSecret}
            setClientSecret={n.setClientSecret}
          />
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" size="sm" disabled={!valid || !n.ready || n.busy}>
            {n.busy && <Loader2Icon className="animate-spin" />}
            Connect
          </Button>
          {n.busy && n.mode === 'idle' && <span className="text-xs text-muted-foreground">Checking how it signs in…</span>}
        </div>
      </form>
    </section>
  )
}
