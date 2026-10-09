import { useState } from 'react'
import {
  EyeIcon,
  LinkIcon,
  Loader2Icon,
  LogOutIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  Trash2Icon,
  UserPlusIcon,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { logout, type Me } from '@/lib/api'
import { runTool, day, useAuditLog, useTool, type AdminSpace, type AdminUser, type Chain, type UserKey } from '@/lib/people'
import { Page, Section } from '@/components/page'
import { Field, FormDialog } from '@/components/form-dialog'
import { AuditTable } from '@/components/audit-table'
import { InviteLink, KeysTable } from '@/views/AccountView'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

type Pane = 'users' | 'spaces' | 'keys' | 'audit'

function NotSuper() {
  return (
    <Page title="Admin">
      <div className="max-w-xl rounded-lg border border-violet-500/30 bg-violet-500/5 p-5">
        <div className="flex items-center gap-2 font-medium">
          <ShieldAlertIcon className="size-4 text-violet-300" />
          Sign in with your super key to open the admin console
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          This session came from an ordinary key, so it can see your own brain but not other people. Your
          super key is in <code className="font-mono text-xs">~/.config/brain-mcp/super-key</code>.
          From a super session you can mint the next one under Account.
        </p>
        <Button
          className="mt-4"
          size="sm"
          onClick={async () => {
            await logout()
            window.location.reload()
          }}
        >
          <LogOutIcon />
          Sign out and switch key
        </Button>
      </div>
    </Page>
  )
}

function StatusBadge({ status }: { status: AdminUser['status'] }) {
  const cls =
    status === 'active'
      ? 'border-emerald-500/25 text-emerald-300'
      : status === 'suspended'
        ? 'border-amber-500/25 text-amber-300'
        : 'text-muted-foreground'
  return (
    <Badge variant="outline" className={cn('text-[10px]', cls)}>
      {status}
    </Badge>
  )
}

function NewUserDialog({ onDone }: { onDone: () => void }) {
  const [handle, setHandle] = useState('')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [canInvite, setCanInvite] = useState(false)
  return (
    <FormDialog
      trigger={
        <Button size="sm">
          <UserPlusIcon />
          New user
        </Button>
      }
      title="New user"
      description="Creates the account and its own encrypted space, and gives you a one-time invite link to send them."
      submitLabel="Create user"
      canSubmit={!!handle.trim()}
      onOpen={() => {
        setHandle('')
        setName('')
        setEmail('')
        setCanInvite(false)
      }}
      onSubmit={async () => {
        const r = await runTool<{ user: string; invite_url: string }>('admin_create_user', {
          handle: handle.trim(),
          name,
          ...(email.trim() ? { email: email.trim() } : {}),
          can_invite: canInvite,
        })
        if (!r) return 'stay'
        onDone()
        return { show: <InviteLink user={r.user} url={r.invite_url} /> }
      }}
    >
      <Field id="u-handle" label="Handle" placeholder="alice" value={handle} onChange={(e) => setHandle(e.target.value.toLowerCase())} hint="2-31 lowercase letters, digits and hyphens. Also the name of their space." />
      <Field id="u-name" label="Name" placeholder="Alice" value={name} onChange={(e) => setName(e.target.value)} />
      <Field id="u-email" label="Email (optional)" type="email" value={email} onChange={(e) => setEmail(e.target.value)} hint="Stored encrypted. Only used so you know who this is." />
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={canInvite} onCheckedChange={(v) => setCanInvite(!!v)} />
        Can invite other people
      </label>
    </FormDialog>
  )
}

function DeleteUser({ user, onDone }: { user: AdminUser; onDone: () => void }) {
  const [confirm, setConfirm] = useState('')
  const [purge, setPurge] = useState(false)
  const [busy, setBusy] = useState(false)
  return (
    <AlertDialog
      onOpenChange={(v) => {
        if (v) {
          setConfirm('')
          setPurge(false)
        }
      }}
    >
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 px-2 text-destructive" title={`Delete ${user.user}`}>
          <Trash2Icon />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {user.user}?</AlertDialogTitle>
          <AlertDialogDescription>
            Wipes every space they own ({user.spaces.join(', ') || 'none'}), destroys the data keys so backups
            become unreadable, and revokes all {user.keys} of their keys. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="del-confirm">Type {user.handle} to confirm</Label>
            <Input id="del-confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={purge} onCheckedChange={(v) => setPurge(!!v)} />
            Also remove the account rows (the handle becomes free again)
          </label>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy || confirm.trim().replace(/^@/, '') !== user.handle}
            className="bg-destructive text-white hover:bg-destructive/90"
            onClick={async (e) => {
              e.preventDefault()
              setBusy(true)
              const r = await runTool('admin_delete_user', { handle: user.handle, confirm: confirm.trim(), purge }, `Deleted ${user.user}`)
              setBusy(false)
              if (r) onDone()
            }}
          >
            {busy && <Loader2Icon className="animate-spin" />}
            Delete user
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function InviteAgain({ user }: { user: AdminUser }) {
  return (
    <FormDialog
      trigger={
        <Button variant="ghost" size="sm" className="h-7 px-2" title="Issue a fresh invite link">
          <LinkIcon />
        </Button>
      }
      title={`New invite link for ${user.user}`}
      description="Use this if they lost their key or the first link expired. Their existing keys keep working; revoke them under Keys if needed."
      submitLabel="Create link"
      onSubmit={async () => {
        const r = await runTool<{ invite_url: string }>('admin_set_user', { handle: user.handle, new_invite: true })
        return r ? { show: <InviteLink user={user.user} url={r.invite_url} /> } : 'stay'
      }}
    >
      <span />
    </FormDialog>
  )
}

function UsersPane({
  onOpenSpace,
  onActivity,
  onUnauthorized,
}: {
  onOpenSpace: (handle: string) => void
  onActivity: (handle: string) => void
  onUnauthorized: () => void
}) {
  const { data, reload } = useTool<{ users: AdminUser[] }>('admin_list_users', {}, onUnauthorized)
  const set = async (u: AdminUser, patch: Record<string, unknown>, msg: string) => {
    if (await runTool('admin_set_user', { handle: u.handle, ...patch }, msg)) reload()
  }
  return (
    <Section
      title="Users"
      intro="Everyone with an account. Suspending blocks every key and session at once and keeps their data; restoring brings it all back."
      action={<NewUserDialog onDone={reload} />}
    >
      <div className="overflow-hidden rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>User</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Spaces</TableHead>
              <TableHead>Keys</TableHead>
              <TableHead>Can invite</TableHead>
              <TableHead>Note quota</TableHead>
              <TableHead>Joined</TableHead>
              <TableHead className="text-right" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data == null
              ? Array.from({ length: 3 }).map((_, i) => (
                  <TableRow key={i}>
                    {Array.from({ length: 8 }).map((__, j) => (
                      <TableCell key={j}>
                        <Skeleton className="h-4 w-full" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              : data.users.map((u) => (
                  <TableRow key={u.handle} className={cn(u.status === 'deleted' && 'opacity-50')}>
                    <TableCell>
                      <div className="flex items-center gap-1.5 font-medium">
                        {u.user}
                        {u.is_super && (
                          <Badge variant="outline" className="border-violet-500/30 text-[10px] text-violet-300">
                            super
                          </Badge>
                        )}
                      </div>
                      {u.name && u.name !== u.handle && <div className="text-xs text-muted-foreground">{u.name}</div>}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={u.status} />
                    </TableCell>
                    <TableCell className="text-xs">
                      <div className="flex flex-wrap gap-1">
                        {u.spaces.map((s) => (
                          <button
                            key={s}
                            type="button"
                            onClick={() => onOpenSpace(s)}
                            className="rounded border border-border px-1.5 py-0.5 hover:bg-muted/50"
                            title={`Browse ${s}. Every read is logged and shown to its owner.`}
                          >
                            {s}
                          </button>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs tabular-nums">{u.keys}</TableCell>
                    <TableCell>
                      {!u.is_super && u.status !== 'deleted' && (
                        <Checkbox
                          checked={u.can_invite}
                          onCheckedChange={(v) => set(u, { can_invite: !!v }, `${u.user} ${v ? 'can' : 'can no longer'} invite people`)}
                          aria-label={`${u.user} can invite`}
                        />
                      )}
                    </TableCell>
                    <TableCell className="text-xs tabular-nums">
                      {u.status === 'deleted' ? '—' : (
                        <button
                          type="button"
                          className="underline decoration-dotted underline-offset-2 hover:text-foreground"
                          onClick={() => {
                            const v = window.prompt(`Note quota for ${u.user} (10 to 100000)`, String(u.quota_notes ?? ''))
                            if (v && Number(v) > 0) set(u, { quota_notes: Number(v) }, `Quota for ${u.user} set to ${v}`)
                          }}
                        >
                          {u.quota_notes ?? 'default'}
                        </button>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground tabular-nums">{day(u.created)}</TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      <Button variant="ghost" size="sm" className="h-7 px-2" title="Their activity" onClick={() => onActivity(u.handle)}>
                        <EyeIcon />
                      </Button>
                      {!u.is_super && u.status !== 'deleted' && (
                        <>
                          <InviteAgain user={u} />
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs"
                            onClick={() =>
                              u.status === 'active'
                                ? window.confirm(`Suspend ${u.user}? All their keys and sessions stop working until you restore them.`) &&
                                  set(u, { status: 'suspended' }, `Suspended ${u.user}`)
                                : set(u, { status: 'active' }, `Restored ${u.user}`)
                            }
                          >
                            {u.status === 'active' ? 'Suspend' : 'Restore'}
                          </Button>
                          <DeleteUser user={u} onDone={reload} />
                        </>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
          </TableBody>
        </Table>
      </div>
    </Section>
  )
}

function SpacesPane({ onOpenSpace, onUnauthorized }: { onOpenSpace: (h: string) => void; onUnauthorized: () => void }) {
  const { data } = useTool<{ spaces: AdminSpace[] }>('admin_list_spaces', {}, onUnauthorized)
  return (
    <Section
      title="Spaces"
      intro="Every brain on this server. Opening one you are not a member of is a super admin read: it is logged, and the owner sees it in their Activity."
    >
      <div className="overflow-hidden rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Space</TableHead>
              <TableHead>Owner</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Storage</TableHead>
              <TableHead>Members</TableHead>
              <TableHead>Shares</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="text-right" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data == null ? (
              <TableRow>
                <TableCell colSpan={8}>
                  <Skeleton className="h-4 w-full" />
                </TableCell>
              </TableRow>
            ) : (
              data.spaces.map((s) => (
                <TableRow key={s.space}>
                  <TableCell className="font-medium">{s.space}</TableCell>
                  <TableCell className="text-xs">{s.owner}</TableCell>
                  <TableCell className="text-xs">{s.kind}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{s.backing === 'git' ? 'git repo' : 'hosted, encrypted'}</TableCell>
                  <TableCell className="text-xs tabular-nums">{s.members}</TableCell>
                  <TableCell className="text-xs tabular-nums">{s.shares}</TableCell>
                  <TableCell className="text-xs text-muted-foreground tabular-nums">{day(s.created)}</TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => onOpenSpace(s.space)}>
                      <EyeIcon />
                      Browse
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </Section>
  )
}

function KeysPane({ onUnauthorized }: { onUnauthorized: () => void }) {
  const { data, reload } = useTool<{ keys: UserKey[] }>('list_keys', { all: true }, onUnauthorized)
  return (
    <Section title="All keys" intro="Every key on the server, whoever owns it. Revoking one also kills the keys, sessions and connector tokens minted from it.">
      <KeysTable keys={data?.keys ?? null} showOwner onRevoked={reload} />
    </Section>
  )
}

function AuditPane({ initialUser, onUnauthorized }: { initialUser: string; onUnauthorized: () => void }) {
  const [user, setUser] = useState(initialUser)
  const [action, setAction] = useState('')
  const [applied, setApplied] = useState({ user: initialUser, action: '' })
  const [chain, setChain] = useState<Chain | null>(null)
  const [verifying, setVerifying] = useState(false)
  const args = { ...(applied.user ? { user: applied.user } : {}), ...(applied.action ? { action: applied.action } : {}) }
  const audit = useAuditLog('admin_audit', args, onUnauthorized)
  return (
    <Section
      title="Audit log"
      intro="Every write, share, key change, sign-in and cross-space read, chained by hash so an edited or deleted row breaks verification."
      action={
        <div className="flex items-center gap-2">
          {chain && (
            <Badge
              variant="outline"
              className={cn('text-[11px]', chain.ok ? 'border-emerald-500/25 text-emerald-300' : 'border-rose-500/30 text-rose-300')}
            >
              {chain.ok ? `chain intact · ${chain.events} events` : `chain broken at event ${chain.broken_at}`}
            </Badge>
          )}
          <Button
            variant="secondary"
            size="sm"
            disabled={verifying}
            onClick={async () => {
              setVerifying(true)
              const r = await runTool<{ chain: Chain }>('admin_audit', { limit: 1, verify: true })
              setVerifying(false)
              if (r) setChain(r.chain)
            }}
          >
            {verifying ? <Loader2Icon className="animate-spin" /> : <ShieldCheckIcon />}
            Verify chain
          </Button>
        </div>
      }
    >
      <form
        className="mb-3 flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          setApplied({ user: user.trim(), action: action.trim() })
        }}
      >
        <Input className="h-8 w-40" placeholder="user, e.g. alice" value={user} onChange={(e) => setUser(e.target.value.replace(/^@/, ''))} />
        <Input className="h-8 w-56" placeholder="action, e.g. super.web_read" value={action} onChange={(e) => setAction(e.target.value)} />
        <Button type="submit" size="sm" variant="outline">
          Filter
        </Button>
        {(applied.user || applied.action) && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setUser('')
              setAction('')
              setApplied({ user: '', action: '' })
            }}
          >
            Clear
          </Button>
        )}
      </form>
      <AuditTable events={audit.events} onMore={audit.more} loadingMore={audit.busy} empty="No events match." />
    </Section>
  )
}

export function AdminView({
  me,
  onOpenSpace,
  onUnauthorized,
}: {
  me: Me
  onOpenSpace: (handle: string) => void
  onUnauthorized: () => void
}) {
  const [pane, setPane] = useState<Pane>('users')
  const [auditUser, setAuditUser] = useState('')
  if (!me.super) return <NotSuper />
  const panes: { id: Pane; label: string }[] = [
    { id: 'users', label: 'Users' },
    { id: 'spaces', label: 'Spaces' },
    { id: 'keys', label: 'Keys' },
    { id: 'audit', label: 'Audit log' },
  ]
  return (
    <Page
      title="Admin"
      intro={
        <>
          Super admin console. Your session expires with the super key
          {me.expires ? ` on ${day(me.expires)}` : ''}. Everything you do here is in the audit log.
        </>
      }
    >
      <div className="-mb-4 flex gap-1 border-b border-border">
        {panes.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => setPane(p.id)}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm transition-colors',
              pane === p.id ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {p.label}
          </button>
        ))}
      </div>
      {pane === 'users' && (
        <UsersPane
          onOpenSpace={onOpenSpace}
          onActivity={(h) => {
            setAuditUser(h)
            setPane('audit')
          }}
          onUnauthorized={onUnauthorized}
        />
      )}
      {pane === 'spaces' && <SpacesPane onOpenSpace={onOpenSpace} onUnauthorized={onUnauthorized} />}
      {pane === 'keys' && <KeysPane onUnauthorized={onUnauthorized} />}
      {pane === 'audit' && <AuditPane key={auditUser} initialUser={auditUser} onUnauthorized={onUnauthorized} />}
    </Page>
  )
}
