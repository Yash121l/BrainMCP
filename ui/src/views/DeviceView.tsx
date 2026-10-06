import { useEffect, useState } from 'react'
import { CheckIcon, Loader2Icon, ShieldAlertIcon, TerminalIcon, XIcon } from 'lucide-react'

import { attempt, gw, normalizeCode, type DeviceRequest } from '@/lib/gateway'
import { stamp } from '@/lib/people'
import { Page } from '@/components/page'
import { Choice, Field } from '@/components/form-dialog'
import { Banner, BusyButton, ChipsInput, Tag } from '@/components/gateway'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'

type Role = 'read' | 'write' | 'admin'
type Outcome = { kind: 'approved'; machine: string; agent: string } | { kind: 'denied' }
type Lookup = { state: 'idle' } | { state: 'loading' } | { state: 'error'; error: string } | { state: 'ok'; req: DeviceRequest }

export function DeviceView({ code: initial, onDone }: { code: string; onDone: () => void }) {
  const [code, setCode] = useState(initial)
  const [role, setRole] = useState<Role>('write')
  const [agent, setAgent] = useState('')
  const [machine, setMachine] = useState('')
  const [agentTags, setAgentTags] = useState<string[]>([])
  const [machineTags, setMachineTags] = useState<string[]>([])
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [lookup, setLookup] = useState<Lookup>({ state: 'idle' })
  const userCode = normalizeCode(code)
  const valid = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(userCode)

  useEffect(() => {
    if (!valid) {
      setLookup({ state: 'idle' })
      return
    }
    let alive = true
    setLookup({ state: 'loading' })
    gw.lookupDevice(userCode)
      .then((req) => {
        if (!alive) return
        setLookup({ state: 'ok', req })
        setMachineTags(req.machine_tags)
      })
      .catch((e) => alive && setLookup({ state: 'error', error: e instanceof Error ? e.message : 'lookup failed' }))
    return () => {
      alive = false
    }
  }, [userCode, valid])

  if (outcome) {
    return (
      <Page title="Approve a device">
        {outcome.kind === 'approved' ? (
          <Banner tone="green">
            Approved. <b>{outcome.agent}</b> on <b>{outcome.machine}</b> is signed in; go back to your terminal.
          </Banner>
        ) : (
          <Banner tone="red">Denied. The terminal gets no key.</Banner>
        )}
        <div>
          <Button size="sm" variant="outline" onClick={onDone}>
            Go to agents
          </Button>
        </div>
      </Page>
    )
  }

  const req = lookup.state === 'ok' ? lookup.req : null

  return (
    <Page
      title="Approve a device"
      intro="A terminal ran brain login and is waiting for you. Approve only if you started it yourself and the code matches what it shows."
    >
      <div className="grid max-w-xl gap-5">
        {initial ? (
          <div className="rounded-lg border border-border px-4 py-3 text-center font-mono text-3xl tracking-[0.3em]">
            {userCode}
          </div>
        ) : (
          <Field id="dv-code" label="Code" placeholder="ABCD-EFGH" value={code} onChange={(e) => setCode(e.target.value)} />
        )}

        {lookup.state === 'loading' && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2Icon className="size-4 animate-spin" /> Looking up the request…
          </p>
        )}
        {lookup.state === 'error' && <Banner tone="red">{lookup.error}</Banner>}
        {req && (
          <div className="grid gap-3 rounded-lg border border-border p-4" aria-live="polite">
            <div className="flex items-start gap-3">
              <TerminalIcon className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 text-sm">
                <p className="break-words">
                  <b className="font-mono">{req.agent ?? 'A terminal'}</b> on <b className="font-mono">{req.machine}</b>{' '}
                  is asking for access.
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Requested {stamp(req.requested)} UTC · code expires {stamp(req.expires)} UTC
                  {' · '}
                  {req.existing_machine ? (
                    <Tag tone="green">a device you already have</Tag>
                  ) : (
                    <Tag tone="amber">new device</Tag>
                  )}
                </p>
              </div>
            </div>
            <Banner>
              <span className="flex items-start gap-2">
                <ShieldAlertIcon className="mt-0.5 size-4 shrink-0" />
                Only approve a code that your own terminal is showing right now.
              </span>
            </Banner>
          </div>
        )}

        <div className="grid gap-1.5">
          <Label>What its key may do in your Brain</Label>
          <Choice
            value={role}
            onChange={setRole}
            options={[
              { value: 'read', label: 'Read' },
              { value: 'write', label: 'Write' },
              { value: 'admin', label: 'Admin' },
            ]}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field
            id="dv-agent"
            label="Agent"
            placeholder={req?.agent ?? 'as the terminal sent it'}
            value={agent}
            onChange={(e) => setAgent(e.target.value)}
          />
          <Field
            id="dv-machine"
            label="Device"
            placeholder={req?.machine ?? 'as the terminal sent it'}
            value={machine}
            onChange={(e) => setMachine(e.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="dv-agent-tags">Agent tags</Label>
          <ChipsInput id="dv-agent-tags" value={agentTags} onChange={setAgentTags} placeholder="coding" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="dv-machine-tags">Device tags</Label>
          <ChipsInput id="dv-machine-tags" value={machineTags} onChange={setMachineTags} placeholder="laptop" />
          {req?.existing_machine && (
            <p className="text-xs text-muted-foreground">These are {req.machine}'s current tags; changing them here updates the machine.</p>
          )}
        </div>
        <div className="flex gap-2">
          <BusyButton
            disabled={!req}
            onClick={async () => {
              const tagsChanged = machineTags.join() !== (req?.machine_tags ?? []).join()
              const r = await attempt(() =>
                gw.approveDevice({
                  user_code: userCode,
                  role,
                  ...(agent.trim() ? { agent: agent.trim() } : {}),
                  ...(machine.trim() ? { machine: machine.trim() } : {}),
                  ...(agentTags.length ? { agent_tags: agentTags } : {}),
                  ...(tagsChanged ? { machine_tags: machineTags } : {}),
                }),
              )
              if (r) setOutcome({ kind: 'approved', machine: r.machine, agent: r.agent })
            }}
          >
            <CheckIcon />
            Approve
          </BusyButton>
          <BusyButton
            variant="ghost"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            disabled={!req}
            onClick={async () => {
              if (await attempt(() => gw.denyDevice(userCode))) setOutcome({ kind: 'denied' })
            }}
          >
            <XIcon />
            Deny
          </BusyButton>
        </div>
      </div>
    </Page>
  )
}
