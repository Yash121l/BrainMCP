import { useEffect, useState } from 'react'
import {
  CheckIcon,
  CopyIcon,
  Loader2Icon,
  PencilIcon,
  PlusIcon,
  TriangleAlertIcon,
} from 'lucide-react'
import { toast } from 'sonner'

import { api, Unauthorized, type ApiKey, type Role, type Scopes } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { RoleBadge } from '@/components/role-badge'
import { ScopeChip, ScopePicker } from '@/components/scope-picker'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
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

const date = (s: string | null) => (s ? s.slice(0, 10) : '—')
const stamp = (s: string | null) => (s ? s.slice(0, 16).replace('T', ' ') : 'never')

const ROLES: { role: Role; hint: string }[] = [
  { role: 'read', hint: 'browse, search, read' },
  { role: 'write', hint: 'read + save sessions, decisions, notes' },
  { role: 'admin', hint: 'everything, including these keys' },
]

type Expiry = number | 'never' | 'keep'
const EXPIRY_OPTIONS: { value: Expiry; label: string }[] = [
  { value: 30, label: '30 days' },
  { value: 90, label: '90 days' },
  { value: 365, label: '1 year' },
  { value: 'never', label: 'Never' },
]

function CopyButton({
  value,
  label = 'Copy',
  variant = 'outline',
}: {
  value: string
  label?: string
  variant?: 'outline' | 'ghost' | 'secondary'
}) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      type="button"
      variant={variant}
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value)
          setCopied(true)
          setTimeout(() => setCopied(false), 1600)
        } catch {
          toast.error('Clipboard blocked — select the text and copy manually.')
        }
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
      {copied ? 'Copied' : label}
    </Button>
  )
}

function RolePicker({ value, onChange }: { value: Role; onChange: (r: Role) => void }) {
  return (
    <div className="grid gap-2 sm:grid-cols-3">
      {ROLES.map(({ role, hint }) => (
        <button
          key={role}
          type="button"
          onClick={() => onChange(role)}
          aria-pressed={value === role}
          className={cn(
            'rounded-lg border p-2.5 text-left transition-colors',
            value === role
              ? 'border-primary/40 bg-primary/10'
              : 'border-border hover:border-border/80 hover:bg-muted/40',
          )}
        >
          <RoleBadge role={role} className="text-[10px]" />
          <div className="mt-1.5 text-xs text-muted-foreground">{hint}</div>
        </button>
      ))}
    </div>
  )
}

function ExpiryPicker({
  value,
  onChange,
  keepLabel,
}: {
  value: Expiry
  onChange: (e: Expiry) => void
  keepLabel: string | null
}) {
  const options = keepLabel
    ? [{ value: 'keep' as Expiry, label: keepLabel }, ...EXPIRY_OPTIONS]
    : EXPIRY_OPTIONS
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className={cn(
            'rounded-md border px-2.5 py-1 text-xs transition-colors',
            value === o.value
              ? 'border-primary/40 bg-primary/10 text-foreground'
              : 'border-border text-muted-foreground hover:bg-muted/50',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** Everything the person on the other end needs, in the three shapes they might need it. */
function Handoff({ name, secret }: { name: string; secret: string }) {
  const origin = window.location.origin
  const mcp = `claude mcp add --transport http brain ${origin}/mcp --header "Authorization: Bearer ${secret}"`
  const installer = `curl -fsSL -H "Authorization: Bearer ${secret}" ${origin}/skills/install.sh | sh`
  const invite = [
    `brain access for ${name}`,
    ``,
    `Web app: ${origin} — sign in with this key:`,
    secret,
    ``,
    `Claude Code:`,
    mcp,
    ``,
    `Skills library (optional):`,
    installer,
  ].join('\n')

  return (
    <div className="grid gap-3">
      <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">Access key</span>
          <CopyButton value={secret} variant="ghost" />
        </div>
        <code className="mt-1 block font-mono text-[13px] break-all text-emerald-300 select-all">
          {secret}
        </code>
      </div>

      <div className="grid gap-2">
        {[
          { label: 'Claude Code', cmd: mcp },
          { label: 'Skills + hook installer', cmd: installer },
        ].map(({ label, cmd }) => (
          <div key={label} className="rounded-lg border border-border p-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">{label}</span>
              <CopyButton value={cmd} variant="ghost" />
            </div>
            <code className="mt-1 block font-mono text-[11px] break-all text-muted-foreground select-all">
              {cmd}
            </code>
          </div>
        ))}
      </div>

      <p className="flex items-start gap-2 text-xs text-amber-300/90">
        <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
        Copy it now — the key is hashed on the server and never shown again. The scope and role
        stay editable; the secret does not.
      </p>
      <CopyButton value={invite} label="Copy the whole invite" variant="secondary" />
    </div>
  )
}

function KeyDialog({
  existing,
  scopes: scopeData,
  onSaved,
  trigger,
}: {
  existing: ApiKey | null
  scopes: Scopes | null
  onSaved: () => void
  trigger: React.ReactNode
}) {
  const editing = !!existing
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [role, setRole] = useState<Role>('read')
  const [scopes, setScopes] = useState<string[] | null>(null)
  const [expiry, setExpiry] = useState<Expiry>('never')
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState<string | null>(null)

  function reset() {
    setName(existing?.name ?? '')
    setRole(existing?.role ?? 'read')
    setScopes(existing ? (existing.prefixes.length ? existing.prefixes : null) : null)
    setExpiry(editing ? 'keep' : 90)
    setCreated(null)
    setBusy(false)
  }

  const ready = !!name.trim() && (scopes === null || scopes.length > 0)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy || !ready) return
    setBusy(true)
    try {
      const fields = {
        name: name.trim(),
        role,
        prefixes: scopes ?? [],
        ...(expiry === 'keep' ? {} : { expires_days: expiry === 'never' ? null : expiry }),
      }
      if (existing) {
        await api.updateKey(existing.id, fields)
        toast.success(`Updated ${fields.name}`)
        setOpen(false)
      } else {
        const res = await api.createKey({ expires_days: null, ...fields })
        setCreated(res.key)
      }
      onSaved()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'could not save the key')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v)
        if (v) reset()
        else setCreated(null)
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-xl">
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>Send this to {name.trim()}</DialogTitle>
              <DialogDescription>
                One key, three surfaces: the web app, an MCP client, and the installer.
              </DialogDescription>
            </DialogHeader>
            <Handoff name={name.trim()} secret={created} />
            <DialogFooter>
              <Button variant="secondary" onClick={() => setOpen(false)}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={submit}>
            <DialogHeader>
              <DialogTitle>{editing ? `Edit “${existing.name}”` : 'Grant access'}</DialogTitle>
              <DialogDescription>
                {editing
                  ? 'Role, scope and expiry change in place — the key itself keeps working.'
                  : 'Pick who it is for, what they can do, and which part of the brain they see.'}
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-5 py-5">
              <div className="grid gap-2">
                <Label htmlFor="k-name">Who is it for</Label>
                <Input
                  id="k-name"
                  placeholder="Priya — diligence read-only"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoFocus
                  required
                />
              </div>
              <div className="grid gap-2">
                <Label>What they can do</Label>
                <RolePicker value={role} onChange={setRole} />
              </div>
              <div className="grid gap-2">
                <Label>What they can see</Label>
                <ScopePicker scopes={scopes} onChange={setScopes} data={scopeData} role={role} />
              </div>
              <div className="grid gap-2">
                <Label>Expires</Label>
                <ExpiryPicker
                  value={expiry}
                  onChange={setExpiry}
                  keepLabel={editing ? `Keep (${date(existing.expires) === '—' ? 'never' : date(existing.expires)})` : null}
                />
              </div>
            </div>
            <DialogFooter>
              <Button type="submit" disabled={busy || !ready}>
                {busy && <Loader2Icon className="animate-spin" />}
                {editing ? 'Save changes' : 'Create key'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

function RevokeButton({ k, onDone }: { k: ApiKey; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
        >
          Revoke
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Revoke “{k.name}”?</AlertDialogTitle>
          <AlertDialogDescription>
            This also kills every web session and connector token minted from it. The key stops
            working immediately and cannot be restored. To narrow access instead, edit the key.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-white hover:bg-destructive/90"
            disabled={busy}
            onClick={async (e) => {
              e.preventDefault() // keep the dialog up until the request settles
              setBusy(true)
              try {
                await api.revokeKey(k.id)
                toast.success(`Revoked ${k.name}`)
                setOpen(false)
                onDone()
              } catch (err) {
                toast.error(err instanceof Error ? err.message : 'revoke failed')
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy && <Loader2Icon className="animate-spin" />}
            Revoke key
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export function KeysView({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [keys, setKeys] = useState<ApiKey[] | null>(null)
  const [scopeData, setScopeData] = useState<Scopes | null>(null)

  function load() {
    api
      .keys()
      .then(setKeys)
      .catch((e) => {
        if (e instanceof Unauthorized) onUnauthorized()
        else toast.error(e instanceof Error ? e.message : 'could not load keys')
      })
  }
  useEffect(load, [onUnauthorized])
  useEffect(() => {
    api.scopes().then(setScopeData).catch(() => setScopeData(null))
  }, [])

  const expired = (k: ApiKey) => !!k.expires && new Date(k.expires.replace(' ', 'T') + 'Z') < new Date()

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto w-full max-w-5xl px-8 py-10">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Access keys</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              One key per person. It carries a role and a scope — the whole brain, or only the
              projects and folders you pick — and works for the web app, MCP clients and claude.ai
              connector consent alike.
            </p>
          </div>
          <KeyDialog
            existing={null}
            scopes={scopeData}
            onSaved={load}
            trigger={
              <Button size="sm">
                <PlusIcon />
                Grant access
              </Button>
            }
          />
        </div>

        <div className="mt-6 overflow-hidden rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Who</TableHead>
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
                ? Array.from({ length: 4 }).map((_, i) => (
                    <TableRow key={i}>
                      {Array.from({ length: 7 }).map((__, j) => (
                        <TableCell key={j}>
                          <Skeleton className="h-4 w-full" />
                        </TableCell>
                      ))}
                    </TableRow>
                  ))
                : keys.map((k) => (
                    <TableRow key={k.id} className={cn(k.revoked && 'opacity-50')}>
                      <TableCell className="font-medium">
                        <span className={cn(k.revoked && 'line-through')}>{k.name}</span>
                        <div className="font-mono text-[11px] text-muted-foreground">{k.id}</div>
                      </TableCell>
                      <TableCell>
                        <RoleBadge role={k.role} />
                      </TableCell>
                      <TableCell className="max-w-[20rem]">
                        {k.prefixes.length === 0 ? (
                          <span className="text-xs text-muted-foreground italic">
                            whole brain
                          </span>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            {k.prefixes.map((p) => (
                              <ScopeChip key={p} scope={p} />
                            ))}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground tabular-nums">
                        {date(k.created)}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground tabular-nums">
                        {date(k.expires)}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground tabular-nums">
                        {stamp(k.last_used)}
                      </TableCell>
                      <TableCell className="text-right whitespace-nowrap">
                        {k.revoked ? (
                          <Badge variant="outline" className="text-muted-foreground">
                            revoked
                          </Badge>
                        ) : expired(k) ? (
                          <Badge variant="outline" className="text-muted-foreground">
                            expired
                          </Badge>
                        ) : (
                          <>
                            <KeyDialog
                              existing={k}
                              scopes={scopeData}
                              onSaved={load}
                              trigger={
                                <Button variant="ghost" size="sm" className="h-7 text-xs">
                                  <PencilIcon />
                                  Edit
                                </Button>
                              }
                            />
                            <RevokeButton k={k} onDone={load} />
                          </>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
              {keys?.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">
                    No keys yet — “Grant access” mints the first one.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </ScrollArea>
  )
}
