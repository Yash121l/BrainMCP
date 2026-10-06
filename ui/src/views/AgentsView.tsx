import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  KeyRoundIcon,
  LaptopIcon,
  Loader2Icon,
  MonitorIcon,
  PlusIcon,
  SaveIcon,
  ServerIcon,
  ShieldAlertIcon,
  XIcon,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { attempt, gw, isOwn, normalizeCode, useGw, type DeviceRequest, type GwKey, type Machine } from '@/lib/gateway'
import { accessMap, effectiveFor, type AccessMap } from '@/lib/access'
import { LEVEL_LABEL, ago, appLabel, deviceKind } from '@/lib/apps'
import { Page } from '@/components/page'
import { PageIntro } from '@/components/guides'
import { CopyField, Pill } from '@/components/app-ui'
import { BusyButton, ChipsInput, ConfirmButton, ErrorLine, MultiPick } from '@/components/gateway'
import { Field } from '@/components/form-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'

const DEVICE_ICON = { laptop: LaptopIcon, desktop: MonitorIcon, server: ServerIcon }
const DEFAULT_SERVER = 'https://brain.yashlunawat.com'

export function AgentsView({
  addOpen,
  onAddOpen,
  onUnauthorized,
}: {
  addOpen: boolean
  onAddOpen: (v: boolean) => void
  onUnauthorized: () => void
}) {
  const machines = useGw(() => gw.machines(), [], onUnauthorized)
  const overview = useGw(() => gw.overview(), [], onUnauthorized)
  const rules = useGw(() => gw.rules(), [], onUnauthorized)
  const own = (overview.data?.connections ?? []).filter(isOwn)
  const access = useMemo(() => accessMap(rules.data?.rules ?? []), [rules.data])
  const data = machines.data
  const live = data?.machines.filter((m) => !m.revoked) ?? []
  const revoked = data?.machines.filter((m) => m.revoked) ?? []
  const reload = () => {
    machines.reload()
    rules.reload()
  }

  return (
    <Page
      title="Agents"
      intro="Your devices, and the AI agents on each one. Every agent has its own key, so you can see and limit what each does."
      action={
        <Button onClick={() => onAddOpen(true)}>
          <PlusIcon />
          Add a device
        </Button>
      }
    >
      <PageIntro page="agents" onAction={() => onAddOpen(true)} />
      <ErrorLine error={machines.error} />

      {data == null ? (
        <div className="grid gap-4">
          <Skeleton className="h-40 rounded-xl" />
          <Skeleton className="h-40 rounded-xl" />
        </div>
      ) : live.length === 0 && !data.unassigned_keys.length ? (
        <section className="rounded-2xl border border-dashed border-border px-6 py-12 text-center">
          <div className="mx-auto grid size-14 place-items-center rounded-2xl bg-gradient-to-br from-sky-500/20 to-violet-500/20">
            <LaptopIcon className="size-6" />
          </div>
          <h2 className="mt-4 text-xl font-semibold tracking-tight">Add your first device</h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            Install the brain tool on the computer where Claude Code, Codex or Cursor runs. It takes about a minute.
          </p>
          <Button className="mt-6" onClick={() => onAddOpen(true)}>
            <PlusIcon />
            Add a device
          </Button>
        </section>
      ) : (
        <div className="grid gap-4">
          {live.map((m) => (
            <DeviceCard key={m.id} m={m} access={access} conns={own.map((c) => c.connection)} onChanged={reload} />
          ))}
          {data.unassigned_keys.length > 0 && (
            <section className="rounded-xl border border-border bg-card/40 p-5">
              <h2 className="flex items-center gap-2 text-sm font-semibold">
                <KeyRoundIcon className="size-4 text-muted-foreground" />
                Keys without a device
              </h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Made by hand rather than with brain login. Give each a device and agent name so you can tell them apart.
              </p>
              <ul className="mt-3 grid gap-2">
                {data.unassigned_keys.map((k) => (
                  <AgentRow key={k.id} k={k} access={access} conns={own.map((c) => c.connection)} withMachine onChanged={reload} />
                ))}
              </ul>
            </section>
          )}
          {revoked.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Removed devices: {revoked.map((m) => m.name).join(', ')}. Their keys no longer work.
            </p>
          )}
        </div>
      )}

      <section className="rounded-xl border border-border bg-muted/30 p-5 text-sm">
        <h2 className="font-semibold">Why does each agent get its own key?</h2>
        <p className="mt-1 text-muted-foreground">
          So you always know which agent did what, can limit one without touching the others, and can remove a lost laptop
          in one click. It also keeps approvals honest: the key you use in this console can never approve its own agent's
          requests, so an agent can't sign off on itself.
        </p>
      </section>

      <AddDeviceDialog open={addOpen} onOpenChange={onAddOpen} onDone={reload} />
    </Page>
  )
}

function reach(access: AccessMap, conns: string[], keyId: string) {
  const usable = conns.map((c) => ({ c, ...effectiveFor(access, c, keyId) })).filter((x) => x.level !== 'off')
  if (!usable.length) return 'No apps yet'
  const by = (l: string) => usable.filter((x) => x.level === l).length
  const parts = [
    by('read') && `${by('read')} read only`,
    by('write') && `${by('write')} read & change`,
    by('full') && `${by('full')} everything`,
  ].filter(Boolean)
  const asks = usable.filter((x) => x.ask).length
  return `Can use ${usable.length} app${usable.length === 1 ? '' : 's'}: ${parts.join(', ')}${asks ? ` · asks before changes in ${asks}` : ''}`
}

function DeviceCard({ m, access, conns, onChanged }: { m: Machine; access: AccessMap; conns: string[]; onChanged: () => void }) {
  const kind = deviceKind(m.name, m.tags)
  const Icon = DEVICE_ICON[kind]
  const [editTags, setEditTags] = useState(false)
  return (
    <section className="rounded-xl border border-border bg-card/40" aria-label={m.name}>
      <div className="flex flex-wrap items-center gap-3 px-5 pt-4">
        <span className="grid size-10 place-items-center rounded-xl bg-muted">
          <Icon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold tracking-tight">{m.name}</h2>
          <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span className="capitalize">{kind}</span> · seen {ago(m.last_seen)}
            {m.tags.map((t) => (
              <Pill key={t} className="py-0">
                {t}
              </Pill>
            ))}
            <button type="button" className="text-sky-400 hover:underline" onClick={() => setEditTags((v) => !v)}>
              {editTags ? 'Done' : 'Edit tags'}
            </button>
          </p>
        </div>
        <ConfirmButton
          label="Remove device"
          title={`Remove ${m.name}?`}
          description="Every agent on this device stops working right away. Run brain login there again to add it back."
          confirm="Remove"
          onConfirm={async () => {
            const r = await attempt(() => gw.revokeMachine(m.id))
            if (r) {
              toast.success(`Removed ${m.name}; ${r.revoked_keys} key${r.revoked_keys === 1 ? '' : 's'} stopped working`)
              onChanged()
            }
            return !!r
          }}
        />
      </div>
      {editTags && (
        <div className="grid gap-1.5 px-5 pt-3">
          <Label>Device tags</Label>
          <ChipsInput
            value={m.tags}
            placeholder="laptop, work"
            onChange={async (tags) => {
              if (await attempt(() => gw.updateMachine(m.id, tags), `Saved ${m.name}'s tags`)) onChanged()
            }}
          />
          <p className="text-xs text-muted-foreground">Tags like laptop, desktop or server also pick the icon.</p>
        </div>
      )}
      <ul className="grid gap-2 p-3">
        {m.keys.map((k) => (
          <AgentRow key={k.id} k={k} access={access} conns={conns} onChanged={onChanged} />
        ))}
        {!m.keys.length && <li className="px-2 py-2 text-sm text-muted-foreground">No agents on this device.</li>}
      </ul>
    </section>
  )
}

function AgentRow({
  k,
  access,
  conns,
  withMachine = false,
  onChanged,
}: {
  k: GwKey
  access: AccessMap
  conns: string[]
  withMachine?: boolean
  onChanged: () => void
}) {
  const [open, setOpen] = useState(false)
  const [agent, setAgent] = useState(k.agent ?? '')
  const [tags, setTags] = useState(k.agent_tags)
  const [pinned, setPinned] = useState(k.pinned)
  const [machine, setMachine] = useState('')
  const dirty =
    agent !== (k.agent ?? '') || tags.join() !== k.agent_tags.join() || pinned.join() !== k.pinned.join() || (withMachine && !!machine.trim())
  const levels = conns
    .map((c) => ({ c, ...effectiveFor(access, c, k.id) }))
    .filter((x) => x.level !== 'off')

  return (
    <li className="rounded-lg border border-border bg-background/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
      >
        <BotIcon className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
            {k.agent ?? k.name}
            {k.agent_tags.map((t) => (
              <Pill key={t} className="py-0">
                {t}
              </Pill>
            ))}
            {k.pinned.length > 0 && <Pill tone="sky" className="py-0">{k.pinned.length} pinned</Pill>}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {reach(access, conns, k.id)} · used {ago(k.last_used)}
          </p>
        </div>
        <ChevronDownIcon className={cn('size-4 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="grid gap-4 border-t border-border px-3 py-3">
          {levels.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {levels.map((x) => (
                <Pill key={x.c} tone={x.level === 'read' ? 'sky' : x.level === 'write' ? 'amber' : 'red'}>
                  {appLabel(x.c)}: {LEVEL_LABEL[x.level].toLowerCase()}
                  {x.ask && ' · asks'}
                </Pill>
              ))}
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id={`a-${k.id}`} label="Agent name" placeholder="claude-code" value={agent} onChange={(e) => setAgent(e.target.value)} />
            {withMachine ? (
              <Field id={`m-${k.id}`} label="Device" placeholder="work-laptop" value={machine} onChange={(e) => setMachine(e.target.value)} />
            ) : (
              <div className="grid gap-1.5">
                <Label>Tags</Label>
                <ChipsInput value={tags} onChange={setTags} placeholder="coding" />
              </div>
            )}
          </div>
          {withMachine && (
            <div className="grid gap-1.5">
              <Label>Tags</Label>
              <ChipsInput value={tags} onChange={setTags} placeholder="coding" />
            </div>
          )}
          <div className="grid gap-1.5">
            <Label>Pinned apps</Label>
            <MultiPick options={conns} value={pinned} onChange={setPinned} label={appLabel} empty="Connect an app first to pin it." />
            <p className="text-xs text-muted-foreground">
              Pinned apps show their tools directly in this agent's tool list, so it doesn't have to search for them.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <BusyButton
              size="sm"
              disabled={!dirty}
              onClick={async () => {
                const ok = await attempt(
                  () =>
                    gw.updateKey(k.id, {
                      agent: agent.trim(),
                      agent_tags: tags,
                      pinned,
                      ...(withMachine && machine.trim() ? { machine: machine.trim() } : {}),
                    }),
                  `Saved ${agent || k.name}`,
                )
                if (ok) onChanged()
              }}
            >
              <SaveIcon />
              Save
            </BusyButton>
            <span className="text-xs text-muted-foreground">To change which apps it can use, open the app on the Apps page.</span>
          </div>
        </div>
      )}
    </li>
  )
}

type Lookup = { state: 'idle' } | { state: 'loading' } | { state: 'error'; error: string } | { state: 'ok'; req: DeviceRequest }

export function AddDeviceDialog({
  open,
  onOpenChange,
  onDone,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onDone: () => void
}) {
  const [step, setStep] = useState(0)
  const [code, setCode] = useState('')
  const [lookup, setLookup] = useState<Lookup>({ state: 'idle' })
  const [result, setResult] = useState<{ agent: string; machine: string } | null>(null)
  const origin = window.location.origin
  const custom = origin !== DEFAULT_SERVER
  const install = custom
    ? `curl -fsSL ${origin}/cli/install.sh | BRAIN_URL=${origin} sh`
    : `curl -fsSL ${origin}/cli/install.sh | sh`
  const login = custom ? `brain login --server ${origin}` : 'brain login'
  const userCode = normalizeCode(code)
  const valid = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(userCode)

  useEffect(() => {
    if (open) {
      setStep(0)
      setCode('')
      setResult(null)
      setLookup({ state: 'idle' })
    }
  }, [open])

  useEffect(() => {
    if (!valid) {
      setLookup({ state: 'idle' })
      return
    }
    let alive = true
    setLookup({ state: 'loading' })
    gw.lookupDevice(userCode)
      .then((req) => alive && setLookup({ state: 'ok', req }))
      .catch((e) => alive && setLookup({ state: 'error', error: e instanceof Error ? e.message : 'lookup failed' }))
    return () => {
      alive = false
    }
  }, [userCode, valid])

  const req = lookup.state === 'ok' ? lookup.req : null
  const steps = ['Install', 'Sign in', 'Approve']

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Add a device</DialogTitle>
          <DialogDescription>Three short steps on the computer where your agents run.</DialogDescription>
        </DialogHeader>
        <ol className="flex items-center gap-2" aria-label="Progress">
          {steps.map((s, i) => (
            <li key={s} className="flex flex-1 items-center gap-2">
              <span
                className={cn(
                  'grid size-6 shrink-0 place-items-center rounded-full text-xs font-semibold',
                  i < step || result ? 'bg-emerald-500/20 text-emerald-300' : i === step ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground',
                )}
                aria-current={i === step ? 'step' : undefined}
              >
                {i < step || result ? <CheckIcon className="size-3.5" /> : i + 1}
              </span>
              <span className={cn('text-xs', i === step ? 'font-medium' : 'text-muted-foreground')}>{s}</span>
              {i < steps.length - 1 && <span className="h-px flex-1 bg-border" />}
            </li>
          ))}
        </ol>

        {result ? (
          <div className="grid gap-3">
            <div className="flex gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4 text-sm">
              <CheckIcon className="mt-0.5 size-4 shrink-0 text-emerald-300" />
              <p>
                <b>{result.agent}</b> on <b>{result.machine}</b> is signed in. Back in the terminal, run this to set up the
                agents it found:
              </p>
            </div>
            <CopyField value="brain apply" label="command" />
            <p className="text-xs text-muted-foreground">
              New agents can read every app you connected. Change that per app on the Apps page.
            </p>
            <div className="flex justify-end">
              <Button onClick={() => onOpenChange(false)}>Done</Button>
            </div>
          </div>
        ) : step === 0 ? (
          <div className="grid gap-3">
            <p className="text-sm">Open a terminal on that computer and paste this. It needs Node.js 20 or newer.</p>
            <CopyField value={install} label="install command" />
            <p className="text-xs text-muted-foreground">
              It installs one small file, the <code className="font-mono">brain</code> command, in your home folder. Nothing
              runs in the background.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setStep(2)}>
                I already have a code
              </Button>
              <Button onClick={() => setStep(1)}>Next</Button>
            </div>
          </div>
        ) : step === 1 ? (
          <div className="grid gap-3">
            <p className="text-sm">Now sign in from that terminal:</p>
            <CopyField value={login} label="login command" />
            <p className="text-xs text-muted-foreground">
              It shows a code like <code className="font-mono">ABCD-EFGH</code> and tries to open this page in your browser.
              On a server without a browser, just copy the code.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setStep(0)}>
                Back
              </Button>
              <Button onClick={() => setStep(2)}>I have a code</Button>
            </div>
          </div>
        ) : (
          <div className="grid gap-3">
            <Label htmlFor="add-code">Code from the terminal</Label>
            <Input
              id="add-code"
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="ABCD-EFGH"
              className="h-12 text-center font-mono text-xl tracking-[0.3em] uppercase"
              autoComplete="off"
            />
            {lookup.state === 'loading' && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2Icon className="size-4 animate-spin" /> Looking it up…
              </p>
            )}
            {lookup.state === 'error' && (
              <p className="text-sm text-rose-300">
                {/expired|no such|unknown|not found/i.test(lookup.error)
                  ? 'That code is unknown or has expired. Run brain login again for a fresh one.'
                  : lookup.error}
              </p>
            )}
            {req && (
              <div className="grid gap-2 rounded-xl border border-border p-4" aria-live="polite">
                <p className="text-sm">
                  <b>{req.agent ?? 'A terminal'}</b> on <b>{req.machine}</b> is asking to sign in
                  {req.existing_machine ? ' (a device you already have).' : ' (a new device).'}
                </p>
                <p className="flex items-start gap-2 text-xs text-amber-300">
                  <ShieldAlertIcon className="mt-0.5 size-3.5 shrink-0" />
                  Only approve a code your own terminal is showing right now.
                </p>
              </div>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="ghost" onClick={() => setStep(1)}>
                Back
              </Button>
              <BusyButton
                variant="ghost"
                className="text-rose-300 hover:bg-rose-500/10 hover:text-rose-200"
                disabled={!req}
                onClick={async () => {
                  if (await attempt(() => gw.denyDevice(userCode), 'Denied. That terminal gets no key.')) onOpenChange(false)
                }}
              >
                <XIcon />
                Deny
              </BusyButton>
              <BusyButton
                disabled={!req}
                onClick={async () => {
                  const r = await attempt(() => gw.approveDevice({ user_code: userCode, role: 'write' }))
                  if (r) {
                    setResult({ agent: r.agent, machine: r.machine })
                    onDone()
                  }
                }}
              >
                <CheckIcon />
                Approve
              </BusyButton>
            </div>
            <p className="text-xs text-muted-foreground">
              Want to set the agent's name, tags or a read-only key first?{' '}
              <a className="text-sky-400 hover:underline" href={`#device${valid ? `?code=${userCode}` : ''}`}>
                Use the detailed approval page
              </a>
              .
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
