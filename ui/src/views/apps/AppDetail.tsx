import { useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangleIcon, ChevronDownIcon, RefreshCwIcon, SaveIcon, Trash2Icon, UsersIcon } from 'lucide-react'

import { cn } from '@/lib/utils'
import {
  attempt,
  gw,
  isOwn,
  reconnect,
  useGw,
  type Connection,
  type OwnConnection,
  type Share,
} from '@/lib/gateway'
import { ago, connectionAccount, labelOf, serviceName } from '@/lib/apps'
import { AppAvatar, AppStatus, Pill } from '@/components/app-ui'
import { BusyButton, ChipsInput, ConfirmButton } from '@/components/gateway'
import { Field } from '@/components/form-dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { ConnectionShares } from '@/views/connections/ConnectionShares'
import { AccessPanel } from '@/views/apps/AccessPanel'
import { ToolReviewBanner, ToolsPanel } from '@/views/apps/ToolsPanel'

const noop = () => {}

function Block({ title, intro, children, tone }: { title: string; intro?: React.ReactNode; children: React.ReactNode; tone?: 'red' }) {
  return (
    <section className={cn('grid gap-3', tone === 'red' && 'rounded-xl border border-rose-500/30 p-4')}>
      <div>
        <h3 className={cn('text-sm font-semibold', tone === 'red' && 'text-rose-300')}>{title}</h3>
        {intro && <p className="mt-0.5 text-xs text-muted-foreground">{intro}</p>}
      </div>
      {children}
    </section>
  )
}

export function AppDetail({
  conn,
  outgoing,
  onClose,
  onChanged,
  onDeleted,
  onAdvancedRules,
  onUnauthorized,
}: {
  conn: Connection
  outgoing: Share[]
  onClose: () => void
  onChanged: () => void
  onDeleted: () => void
  onAdvancedRules: () => void
  onUnauthorized: () => void
}) {
  const own = isOwn(conn) ? conn : null
  const name = serviceName(conn.service)
  const label = conn.label ?? labelOf(conn.connection)
  return (
    <Sheet open onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="sm:max-w-2xl" aria-describedby={undefined}>
        <SheetHeader>
          <div className="flex items-start gap-4">
            <AppAvatar service={conn.service} size="lg" />
            <div className="min-w-0 flex-1">
              <SheetTitle className="flex flex-wrap items-center gap-2">
                {name}
                {label && label !== 'main' && <Pill>{label}</Pill>}
                <AppStatus status={conn.status} />
                {conn.shared_by && <Pill tone="violet">Shared by {conn.shared_by}</Pill>}
              </SheetTitle>
              <SheetDescription className="mt-0.5 truncate">
                {connectionAccount(conn) || (conn.auth === 'none' ? 'Public app, no sign-in' : 'No account name yet')}
                <span className="text-muted-foreground/70"> · {conn.connection}</span>
              </SheetDescription>
            </div>
          </div>
          {own && <HeaderActions conn={own} onChanged={onChanged} />}
        </SheetHeader>
        <SheetBody className="grid content-start gap-8">
          {own ? (
            <OwnBody
              conn={own}
              outgoing={outgoing}
              onChanged={onChanged}
              onDeleted={onDeleted}
              onAdvancedRules={onAdvancedRules}
              onUnauthorized={onUnauthorized}
            />
          ) : (
            <SharedBody conn={conn} />
          )}
        </SheetBody>
      </SheetContent>
    </Sheet>
  )
}

function HeaderActions({ conn, onChanged }: { conn: OwnConnection; onChanged: () => void }) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {conn.auth === 'oauth' && (
        <BusyButton size="sm" variant="outline" onClick={() => reconnect(conn.id)}>
          <RefreshCwIcon />
          Sign in again
        </BusyButton>
      )}
      <BusyButton
        size="sm"
        variant="outline"
        onClick={async () => {
          const r = await attempt(() => gw.sync(conn.id))
          if (!r) return
          const s = r.synced
          const bits = [
            s.added.length && `${s.added.length} new`,
            s.changed.length && `${s.changed.length} changed`,
            s.removed.length && `${s.removed.length} removed`,
          ].filter(Boolean)
          toast.success(`${s.tools} tools${bits.length ? ` · ${bits.join(', ')}` : ', nothing new'}`)
          onChanged()
        }}
      >
        <RefreshCwIcon />
        Refresh tools
      </BusyButton>
      <span className="text-xs text-muted-foreground">Last refreshed {ago(conn.last_sync)}</span>
    </div>
  )
}

function OwnBody({
  conn,
  outgoing,
  onChanged,
  onDeleted,
  onAdvancedRules,
  onUnauthorized,
}: {
  conn: OwnConnection
  outgoing: Share[]
  onChanged: () => void
  onDeleted: () => void
  onAdvancedRules: () => void
  onUnauthorized: () => void
}) {
  const tools = useGw(() => gw.tools(conn.id), [conn.id, conn.last_sync, conn.review], noop)
  const changed = () => {
    tools.reload()
    onChanged()
  }
  const name = serviceName(conn.service)

  return (
    <>
      {conn.status !== 'active' && <FixBanner conn={conn} onChanged={changed} />}
      {tools.data && <ToolReviewBanner connId={conn.id} tools={tools.data.tools} onChanged={changed} />}

      <Block title="Who can use it" intro={`Decide what your agents may do in ${name}. You can change this any time.`}>
        <AccessPanel
          connId={conn.id}
          appName={name}
          onChanged={onChanged}
          onAdvanced={onAdvancedRules}
          onUnauthorized={onUnauthorized}
        />
      </Block>

      <Block title="Tools" intro="The actions this app offers. Each says in plain words what it does.">
        {tools.error ? (
          <p className="text-sm text-rose-300">{tools.error}</p>
        ) : (
          <ToolsPanel connId={conn.id} tools={tools.data?.tools ?? null} editable={tools.data?.editable ?? true} onChanged={changed} />
        )}
      </Block>

      <Block
        title="Share with a person"
        intro="Let someone else's agents use this account through you. They never see your password, and you choose which tools."
      >
        <ConnectionShares conn={conn} tools={tools.data?.tools ?? []} outgoing={outgoing} onChanged={onChanged} />
      </Block>

      <AccountDetails conn={conn} onSaved={onChanged} />

      <Block
        tone="red"
        title="Disconnect"
        intro="Removes this account from BrainMCP. The stored sign-in is destroyed, shares end and waiting approvals are cancelled."
      >
        <div>
          <ConfirmButton
            label={
              <>
                <Trash2Icon />
                Disconnect {name}
              </>
            }
            title={`Disconnect ${conn.connection}?`}
            description="Your agents lose access right away. To be thorough, also remove BrainMCP's access in the app's own settings if it offers that."
            confirm="Disconnect"
            onConfirm={async () => {
              const ok = await attempt(() => gw.deleteConnection(conn.id), `Disconnected ${conn.connection}`)
              if (ok) onDeleted()
              return !!ok
            }}
          />
        </div>
      </Block>
    </>
  )
}

function FixBanner({ conn, onChanged }: { conn: OwnConnection; onChanged: () => void }) {
  const [secret, setSecret] = useState('')
  const name = serviceName(conn.service)
  const tokenAuth = conn.auth === 'bearer' || conn.auth === 'header'
  return (
    <div className="grid gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
      <div className="flex items-start gap-3">
        <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-amber-300" />
        <div className="min-w-0">
          <p className="text-sm font-semibold">
            {conn.status === 'pending' ? `Finish signing in to ${name}` : `${name} needs you to sign in again`}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Agents can't use it until then.{conn.last_error ? ` The app said: “${conn.last_error}”.` : ''}
          </p>
        </div>
      </div>
      {conn.auth === 'oauth' ? (
        <div>
          <BusyButton size="sm" onClick={() => reconnect(conn.id)}>
            <RefreshCwIcon />
            {conn.status === 'pending' ? 'Finish sign-in' : 'Reconnect'}
          </BusyButton>
        </div>
      ) : tokenAuth ? (
        <div className="flex flex-wrap gap-2">
          <Input
            type="password"
            autoComplete="off"
            placeholder="Paste a new token"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            className="max-w-xs"
            aria-label="New token"
          />
          <BusyButton size="sm" disabled={!secret.trim()} onClick={async () => {
            if (await attempt(() => gw.updateConnection(conn.id, { secret: secret.trim() }), 'Token replaced')) {
              setSecret('')
              onChanged()
            }
          }}>
            Save token
          </BusyButton>
        </div>
      ) : (
        <div>
          <BusyButton
            size="sm"
            onClick={async () => {
              if (await attempt(() => gw.sync(conn.id), 'It answered again')) onChanged()
            }}
          >
            <RefreshCwIcon />
            Try again
          </BusyButton>
        </div>
      )}
    </div>
  )
}

function AccountDetails({ conn, onSaved }: { conn: OwnConnection; onSaved: () => void }) {
  const [open, setOpen] = useState(false)
  const [account, setAccount] = useState(conn.account ?? '')
  const [workspace, setWorkspace] = useState(conn.workspace ?? '')
  const [untrusted, setUntrusted] = useState(conn.trust === 'untrusted')
  const [priv, setPriv] = useState(conn.sensitivity === 'private')
  const [defaults, setDefaults] = useState((conn.default_for ?? []).map((d) => d.replace(/^project:/, '')))
  const [secret, setSecret] = useState('')
  const staticSecret = conn.auth === 'bearer' || conn.auth === 'header'

  return (
    <section className="grid gap-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-2 text-left text-sm font-semibold"
      >
        <ChevronDownIcon className={cn('size-4 transition-transform', open && 'rotate-180')} />
        Account details and advanced
      </button>
      {open && (
        <div className="grid gap-4 rounded-xl border border-border p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id="d-account" label="Account" placeholder="you@company.com" value={account} onChange={(e) => setAccount(e.target.value)} />
            <Field id="d-ws" label="Workspace" placeholder="Team or org name" value={workspace} onChange={(e) => setWorkspace(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="d-defaults">Use this account by default in projects</Label>
            <ChipsInput id="d-defaults" value={defaults} onChange={setDefaults} placeholder="rtp-*" />
            <p className="text-xs text-muted-foreground">
              When an agent asks for {serviceName(conn.service)} inside a matching project, this account is picked.
            </p>
          </div>
          {staticSecret && (
            <Field
              id="d-secret"
              label="Replace token"
              type="password"
              autoComplete="off"
              placeholder="Leave empty to keep the current one"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
            />
          )}
          <div className="grid gap-2">
            <label className="flex items-start gap-3">
              <Switch checked={untrusted} onCheckedChange={setUntrusted} className="mt-0.5" />
              <span className="grid gap-0.5">
                <span className="text-sm">Reads untrusted data</span>
                <span className="text-xs text-muted-foreground">
                  Content here can be written by other people (emails, comments, web pages). After reading it, actions that
                  send data out ask you first. Technical name: trust = untrusted.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-3">
              <Switch checked={priv} onCheckedChange={setPriv} className="mt-0.5" />
              <span className="grid gap-0.5">
                <span className="text-sm">Holds private data</span>
                <span className="text-xs text-muted-foreground">
                  Treat what agents read here as private. Technical name: sensitivity = private.
                </span>
              </span>
            </label>
          </div>
          <p className="text-xs text-muted-foreground">
            Address: <code className="font-mono">{conn.url}</code> · sign-in: {conn.auth} · added {ago(conn.created)}
          </p>
          <div>
            <BusyButton
              size="sm"
              onClick={async () => {
                const ok = await attempt(
                  () =>
                    gw.updateConnection(conn.id, {
                      account: account.trim(),
                      workspace: workspace.trim(),
                      trust: untrusted ? 'untrusted' : 'trusted',
                      sensitivity: priv ? 'private' : 'public',
                      default_for: defaults.map((d) => (d.startsWith('project:') ? d : `project:${d}`)),
                      ...(secret ? { secret } : {}),
                    }),
                  'Saved',
                )
                if (ok) {
                  setSecret('')
                  onSaved()
                }
              }}
            >
              <SaveIcon />
              Save details
            </BusyButton>
          </div>
        </div>
      )}
    </section>
  )
}

function SharedBody({ conn }: { conn: Connection }) {
  const tools = useGw(() => gw.tools(conn.id!), [conn.id], noop)
  return (
    <>
      <div className="flex gap-3 rounded-xl border border-violet-500/30 bg-violet-500/5 p-4 text-sm">
        <UsersIcon className="mt-0.5 size-4 shrink-0 text-violet-300" />
        <p>
          {conn.shared_by} shared this account with you. Your agents use it through {conn.shared_by}, and never see their
          password. Only {conn.shared_by} can change it or what is shared.
        </p>
      </div>
      <Block title="Tools shared with you">
        <ToolsPanel connId={conn.id!} tools={tools.data?.tools ?? null} editable={false} onChanged={noop} />
      </Block>
    </>
  )
}
