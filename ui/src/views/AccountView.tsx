import { useState } from 'react'
import { KeyRoundIcon, LogOutIcon, PlusIcon, UserPlusIcon } from 'lucide-react'

import { cn } from '@/lib/utils'
import { logout, type Me, type Role } from '@/lib/api'
import {
  runTool,
  day,
  expired,
  stamp,
  useAuditLog,
  useTool,
  type UserKey,
  type WhoAmI,
} from '@/lib/people'
import { Page, Section } from '@/components/page'
import { Choice, Field, FormDialog } from '@/components/form-dialog'
import { AuditTable } from '@/components/audit-table'
import { RoleBadge } from '@/components/role-badge'
import { CopyButton, Handoff } from '@/views/KeysView'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

export function InviteLink({ user, url }: { user: string; url: string }) {
  return (
    <div className="grid gap-3">
      <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">Invite link for {user}</span>
          <CopyButton value={url} variant="ghost" />
        </div>
        <code className="mt-1 block font-mono text-[12px] break-all text-emerald-300 select-all">{url}</code>
      </div>
      <p className="text-xs text-muted-foreground">
        Send it to them privately. It works once, within 72 hours. Opening it shows their first key and the
        lines to paste into Claude Code or claude.ai. Their notes live in their own encrypted space; you
        cannot read them unless they share.
      </p>
    </div>
  )
}

function NewKeyDialog({ me, who, onDone }: { me: Me; who: WhoAmI; onDone: () => void }) {
  const [name, setName] = useState('')
  const [role, setRole] = useState<Role>('write')
  const [spaces, setSpaces] = useState<string[]>([])
  const [days, setDays] = useState<number>(90)
  const roles: { value: Role; label: string; hint: string }[] = [
    { value: 'read', label: 'read', hint: 'read notes and skills' },
    { value: 'write', label: 'write', hint: 'read, and save sessions, decisions and notes' },
    { value: 'admin', label: 'admin', hint: 'everything you can do, including keys and sharing' },
    ...(me.super ? [{ value: 'super' as Role, label: 'super', hint: 'super admin, every space' }] : []),
  ]
  const expiry = [
    { value: 30, label: '30 days' },
    { value: 90, label: '90 days' },
    { value: 365, label: '1 year' },
    { value: 0, label: 'never' },
  ]
  return (
    <FormDialog
      trigger={
        <Button size="sm">
          <PlusIcon />
          New key
        </Button>
      }
      title="New key"
      description="For another machine or app. It can never do more than the key you signed in with, and revoking that key revokes this one too."
      submitLabel="Create key"
      canSubmit={!!name.trim()}
      onOpen={() => {
        setName('')
        setRole('write')
        setSpaces([])
        setDays(90)
      }}
      onSubmit={async () => {
        const r = await runTool<{ key: string }>('create_key', {
          name: name.trim(),
          role,
          ...(spaces.length && role !== 'super' ? { spaces } : {}),
          expires_days: days || 'never',
        })
        if (!r) return 'stay'
        onDone()
        return { show: <Handoff name={name.trim()} secret={r.key} editable={false} /> }
      }}
    >
      <Field id="k-name" label="Name" placeholder="work laptop" value={name} onChange={(e) => setName(e.target.value)} />
      <div className="grid gap-1.5">
        <Label>Role</Label>
        <Choice
          value={role}
          options={roles}
          onChange={(r) => {
            setRole(r)
            setDays(r === 'super' ? 365 : 90)
          }}
        />
      </div>
      {role !== 'super' && (
        <div className="grid gap-1.5">
          <Label>Spaces</Label>
          <div className="grid gap-1.5 rounded-md border border-border p-2.5">
            {who.spaces.map((s) => (
              <label key={s.space} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={spaces.includes(s.space)}
                  onCheckedChange={(v) =>
                    setSpaces((prev) => (v ? [...prev, s.space] : prev.filter((x) => x !== s.space)))
                  }
                />
                {s.space}
                <span className="text-xs text-muted-foreground">{s.role}</span>
              </label>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">Leave all unticked to reach every space you can.</p>
        </div>
      )}
      <div className="grid gap-1.5">
        <Label>Expires</Label>
        <Choice value={days} options={expiry} onChange={setDays} />
      </div>
    </FormDialog>
  )
}

export function KeysTable({
  keys,
  showOwner = false,
  onRevoked,
}: {
  keys: UserKey[] | null
  showOwner?: boolean
  onRevoked: () => void
}) {
  const cols = showOwner ? 8 : 7
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Name</TableHead>
            {showOwner && <TableHead>Owner</TableHead>}
            <TableHead>Role</TableHead>
            <TableHead>Scope</TableHead>
            <TableHead>Created</TableHead>
            <TableHead>Expires</TableHead>
            <TableHead>Last used</TableHead>
            <TableHead className="text-right">Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {keys == null
            ? Array.from({ length: 3 }).map((_, i) => (
                <TableRow key={i}>
                  {Array.from({ length: cols }).map((__, j) => (
                    <TableCell key={j}>
                      <Skeleton className="h-4 w-full" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            : keys.map((k) => {
                const dead = !!k.revoked || expired(k.expires)
                return (
                  <TableRow key={k.id} className={cn(dead && 'opacity-50')}>
                    <TableCell className="font-medium">
                      <span className={cn(k.revoked && 'line-through')}>{k.name}</span>
                      <div className="font-mono text-[11px] text-muted-foreground">{k.id}</div>
                    </TableCell>
                    {showOwner && <TableCell className="text-xs">@{k.owner}</TableCell>}
                    <TableCell>
                      <RoleBadge role={k.role} />
                    </TableCell>
                    <TableCell className="max-w-[14rem] text-xs text-muted-foreground">
                      {k.scopes.length ? k.scopes.join(', ') : 'everything the owner can reach'}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground tabular-nums">{day(k.created)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground tabular-nums">{day(k.expires)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground tabular-nums">{stamp(k.last_used)}</TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      {dead ? (
                        <Badge variant="outline" className="text-muted-foreground">
                          {k.revoked ? 'revoked' : 'expired'}
                        </Badge>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 text-xs text-destructive"
                          onClick={async () => {
                            if (!window.confirm(`Revoke ${k.name}? Keys minted from it, and its web and connector sessions, stop working too.`)) return
                            if (await runTool('revoke_key', { id: k.id }, `Revoked ${k.name}`)) onRevoked()
                          }}
                        >
                          Revoke
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}
          {keys?.length === 0 && (
            <TableRow>
              <TableCell colSpan={cols} className="py-8 text-center text-sm text-muted-foreground">
                No keys.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  )
}

export function AccountView({ me, onUnauthorized }: { me: Me; onUnauthorized: () => void }) {
  const who = useTool<WhoAmI>('whoami', {}, onUnauthorized)
  const keys = useTool<{ keys: UserKey[] }>('list_keys', {}, onUnauthorized)
  const audit = useAuditLog('audit_log', {}, onUnauthorized)
  const [handle, setHandle] = useState('')
  const [name, setName] = useState('')
  const adminKey = who.data?.key.role === 'admin' || who.data?.key.role === 'super'

  return (
    <Page
      title="Account"
      intro="Who you are signed in as, your keys, and every recorded action on your data."
      action={
        <Button
          variant="outline"
          size="sm"
          onClick={async () => {
            await logout()
            window.location.reload()
          }}
        >
          <LogOutIcon />
          Sign out
        </Button>
      }
    >
      <Section title="You">
        {who.data == null ? (
          <Skeleton className="h-16 w-full" />
        ) : (
          <div className="grid gap-3 rounded-lg border border-border p-4 sm:grid-cols-3">
            <div>
              <div className="text-xs text-muted-foreground">User</div>
              <div className="mt-0.5 text-lg font-semibold">{who.data.user}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Signed in with</div>
              <div className="mt-1 flex items-center gap-2 text-sm">
                <KeyRoundIcon className="size-3.5 text-muted-foreground" />
                {me.name}
                <RoleBadge role={me.super ? 'super' : who.data.key.role} className="text-[10px]" />
              </div>
              {me.expires && <div className="mt-0.5 text-xs text-muted-foreground">key expires {stamp(me.expires)} UTC</div>}
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Spaces</div>
              <div className="mt-1 flex flex-wrap gap-1">
                {who.data.spaces.map((s) => (
                  <Badge key={s.space} variant="outline" className="text-[11px]">
                    {s.space} · {s.role}
                  </Badge>
                ))}
              </div>
            </div>
          </div>
        )}
      </Section>

      {who.data && (who.data.can_invite || me.super) && adminKey && (
        <Section title="Invite someone" intro="Creates an account with its own private space and gives you a one-time link to send them.">
          <FormDialog
            trigger={
              <Button size="sm" variant="secondary">
                <UserPlusIcon />
                Invite a person
              </Button>
            }
            title="Invite a person"
            submitLabel="Create invite"
            canSubmit={!!handle.trim()}
            onOpen={() => {
              setHandle('')
              setName('')
            }}
            onSubmit={async () => {
              const r = await runTool<{ user: string; invite_url: string }>('invite_user', { handle: handle.trim(), name })
              return r ? { show: <InviteLink user={r.user} url={r.invite_url} /> } : 'stay'
            }}
          >
            <Field id="i-handle" label="Handle" placeholder="alice" value={handle} onChange={(e) => setHandle(e.target.value.toLowerCase())} hint="Becomes @handle and the name of their space." />
            <Field id="i-name" label="Name" placeholder="Alice" value={name} onChange={(e) => setName(e.target.value)} />
          </FormDialog>
        </Section>
      )}

      <Section
        title="Your keys"
        intro="One per machine or app. The secret is shown once when you create it."
        action={who.data && adminKey && <NewKeyDialog me={me} who={who.data} onDone={keys.reload} />}
      >
        <KeysTable keys={keys.data?.keys ?? null} onRevoked={keys.reload} />
      </Section>

      <Section
        title="Activity"
        intro="Your own actions, actions on spaces you own or admin, and any access to your data by someone else, including the super admin."
        action={
          <Button variant="ghost" size="sm" onClick={audit.reload}>
            Refresh
          </Button>
        }
      >
        <AuditTable events={audit.events} onMore={audit.more} loadingMore={audit.busy} />
      </Section>

      <p className="text-xs text-muted-foreground">
        Everything here also works over MCP: whoami, create_key, list_keys, revoke_key, audit_log.
      </p>
    </Page>
  )
}
