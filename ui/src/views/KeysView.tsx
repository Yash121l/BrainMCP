import { useEffect, useState } from 'react'
import { CheckIcon, CopyIcon, Loader2Icon, PlusIcon, TriangleAlertIcon } from 'lucide-react'
import { toast } from 'sonner'

import { api, Unauthorized, type ApiKey, type Role } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { RoleBadge } from '@/components/role-badge'
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
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

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value)
          setCopied(true)
          setTimeout(() => setCopied(false), 1600)
        } catch {
          toast.error('Clipboard blocked — select the key and copy manually.')
        }
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
      {copied ? 'Copied' : 'Copy'}
    </Button>
  )
}

function CreateKeyDialog({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [role, setRole] = useState<Role>('read')
  const [prefixes, setPrefixes] = useState('')
  const [expires, setExpires] = useState('')
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState<string | null>(null)

  function reset() {
    setName('')
    setRole('read')
    setPrefixes('')
    setExpires('')
    setCreated(null)
    setBusy(false)
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy || !name.trim()) return
    setBusy(true)
    try {
      const res = await api.createKey({
        name: name.trim(),
        role,
        prefixes: prefixes
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        expires_days: expires ? Number(expires) : null,
      })
      setCreated(res.key)
      onCreated()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'could not create key')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v)
        if (!v) reset()
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">
          <PlusIcon />
          Create key
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>Key created</DialogTitle>
              <DialogDescription>
                Copy it now — it is hashed on the server and will never be shown again.
              </DialogDescription>
            </DialogHeader>
            <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-3">
              <code className="block font-mono text-[13px] break-all text-emerald-300 select-all">
                {created}
              </code>
            </div>
            <p className="flex items-start gap-2 text-xs text-amber-300/90">
              <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
              Works everywhere: web login, MCP bearer token, and claude.ai connector consent.
            </p>
            <DialogFooter className="sm:justify-between">
              <CopyButton value={created} />
              <Button variant="secondary" onClick={() => setOpen(false)}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={submit}>
            <DialogHeader>
              <DialogTitle>Create access key</DialogTitle>
              <DialogDescription>
                Scope a key to a role and, optionally, to path prefixes. Empty prefixes = the whole
                brain.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-5">
              <div className="grid gap-2">
                <Label htmlFor="k-name">Name</Label>
                <Input
                  id="k-name"
                  placeholder="who / why"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoFocus
                  required
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="k-role">Role</Label>
                <Select value={role} onValueChange={(v) => setRole(v as Role)}>
                  <SelectTrigger id="k-role" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="read">read</SelectItem>
                    <SelectItem value="write">write</SelectItem>
                    <SelectItem value="admin">admin</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="k-prefixes">Path prefixes</Label>
                <Textarea
                  id="k-prefixes"
                  rows={3}
                  className="font-mono text-xs"
                  placeholder="vault/projects/pulse.md, vault/topics/, vault/logs/"
                  value={prefixes}
                  onChange={(e) => setPrefixes(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Comma-separated. Leave empty for full access.
                </p>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="k-expiry">Expires in (days)</Label>
                <Input
                  id="k-expiry"
                  type="number"
                  min={1}
                  placeholder="never"
                  value={expires}
                  onChange={(e) => setExpires(e.target.value)}
                />
              </div>
            </div>
            <DialogFooter>
              <Button type="submit" disabled={busy || !name.trim()}>
                {busy && <Loader2Icon className="animate-spin" />}
                Create key
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
            working immediately and cannot be restored.
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

  const expired = (k: ApiKey) => !!k.expires && new Date(k.expires.replace(' ', 'T') + 'Z') < new Date()

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto w-full max-w-5xl px-8 py-10">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Access keys</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              Each key carries a role (read / write / admin) and optional path prefixes. Keys work
              everywhere — web login, MCP bearer, claude.ai connector consent.
            </p>
          </div>
          <CreateKeyDialog onCreated={load} />
        </div>

        <div className="mt-6 overflow-hidden rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Name</TableHead>
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
                          <span className="text-xs text-muted-foreground italic">everything</span>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            {k.prefixes.map((p) => (
                              <code
                                key={p}
                                className="rounded border border-border bg-muted/50 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
                              >
                                {p}
                              </code>
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
                      <TableCell className="text-right">
                        {k.revoked ? (
                          <Badge variant="outline" className="text-muted-foreground">
                            revoked
                          </Badge>
                        ) : expired(k) ? (
                          <Badge variant="outline" className="text-muted-foreground">
                            expired
                          </Badge>
                        ) : (
                          <RevokeButton k={k} onDone={load} />
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
              {keys?.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">
                    No keys yet.
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
