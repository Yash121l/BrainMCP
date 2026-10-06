import { useState } from 'react'

import {
  attempt,
  describeResource,
  describeSubject,
  gw,
  RISKS,
  type Effect,
  type GwKey,
  type Resource,
  type Risk,
  type Rule,
  type Subject,
} from '@/lib/gateway'
import { Choice, Field, FormDialog } from '@/components/form-dialog'
import { Check, ChipsInput, MultiPick } from '@/components/gateway'
import { Label } from '@/components/ui/label'

const EFFECTS: { value: Effect; label: string; hint: string }[] = [
  { value: 'permit', label: 'Permit', hint: 'Allow without asking' },
  { value: 'approve', label: 'Ask me', hint: 'Allow after you approve each call' },
  { value: 'forbid', label: 'Forbid', hint: 'Never allow; beats any permit' },
]

const clean = <T extends object>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => Array.isArray(v) && v.length)) as T

function Chips({ label, value, onChange, placeholder }: { label: string; value: string[] | undefined; onChange: (v: string[]) => void; placeholder: string }) {
  return (
    <div className="grid gap-1.5">
      <Label>{label}</Label>
      <ChipsInput value={value ?? []} onChange={onChange} placeholder={placeholder} />
    </div>
  )
}

export function RuleDialog({
  rule,
  keys,
  connections,
  trigger,
  onDone,
}: {
  rule?: Rule
  keys: GwKey[]
  connections: string[]
  trigger: React.ReactNode
  onDone: () => void
}) {
  const [effect, setEffect] = useState<Effect>('permit')
  const [subject, setSubject] = useState<Subject>({})
  const [resource, setResource] = useState<Resource>({})
  const [note, setNote] = useState('')
  const [enabled, setEnabled] = useState(true)
  const sub = (patch: Subject) => setSubject((s) => ({ ...s, ...patch }))
  const res = (patch: Resource) => setResource((r) => ({ ...r, ...patch }))
  const keyName = (id: string) => keys.find((k) => k.id === id)?.name ?? id

  return (
    <FormDialog
      trigger={trigger}
      title={rule ? 'Edit rule' : 'New rule'}
      description="Leave a field empty to match anything. Names accept * as a wildcard."
      submitLabel={rule ? 'Save rule' : 'Add rule'}
      onOpen={() => {
        setEffect(rule?.effect ?? 'permit')
        setSubject(rule?.subject ?? {})
        setResource(rule?.resource ?? {})
        setNote(rule?.note ?? '')
        setEnabled(rule?.enabled ?? true)
      }}
      onSubmit={async () => {
        const ok = await attempt(
          () =>
            gw.putRule({
              ...(rule ? { id: rule.id } : {}),
              effect,
              subject: clean(subject),
              resource: clean(resource),
              note: note.trim() || undefined,
              enabled,
            }),
          rule ? 'Rule saved' : 'Rule added',
        )
        if (ok) onDone()
        return ok ? 'close' : 'stay'
      }}
    >
      <div className="grid gap-1.5">
        <Label>Effect</Label>
        <Choice value={effect} options={EFFECTS} onChange={setEffect} />
      </div>

      <fieldset className="grid gap-3 rounded-md border border-border p-3">
        <legend className="px-1 text-xs text-muted-foreground">Who</legend>
        <div className="grid grid-cols-2 gap-3">
          <Chips label="Agents" value={subject.agents} onChange={(agents) => sub({ agents })} placeholder="claude-code" />
          <Chips label="Agent tags" value={subject.agent_tags} onChange={(agent_tags) => sub({ agent_tags })} placeholder="coding" />
          <Chips label="Machines" value={subject.machines} onChange={(machines) => sub({ machines })} placeholder="work-*" />
          <Chips label="Machine tags" value={subject.machine_tags} onChange={(machine_tags) => sub({ machine_tags })} placeholder="laptop" />
        </div>
        {keys.length > 0 && (
          <div className="grid gap-1.5">
            <Label>Only these keys</Label>
            <MultiPick
              options={keys.map((k) => k.id)}
              value={subject.keys ?? []}
              onChange={(ks) => sub({ keys: ks })}
              label={keyName}
            />
          </div>
        )}
      </fieldset>

      <fieldset className="grid gap-3 rounded-md border border-border p-3">
        <legend className="px-1 text-xs text-muted-foreground">What</legend>
        <Chips
          label="Connections"
          value={resource.connections}
          onChange={(c) => res({ connections: c })}
          placeholder={connections[0] ?? 'figma_rtp'}
        />
        <div className="grid grid-cols-2 gap-3">
          <Chips label="Services" value={resource.services} onChange={(services) => res({ services })} placeholder="figma" />
          <Chips label="Tools" value={resource.tools} onChange={(tools) => res({ tools })} placeholder="get_*" />
        </div>
        <div className="grid gap-1.5">
          <Label>Risk</Label>
          <div className="flex flex-wrap gap-4">
            {RISKS.map((r) => (
              <Check
                key={r}
                checked={!!resource.risks?.includes(r)}
                onChange={(on) =>
                  res({ risks: on ? [...(resource.risks ?? []), r] : (resource.risks ?? []).filter((x): x is Risk => x !== r) })
                }
              >
                {r}
              </Check>
            ))}
          </div>
        </div>
      </fieldset>

      <Field id="r-note" label="Note" placeholder="optional" value={note} onChange={(e) => setNote(e.target.value)} />
      <Check checked={enabled} onChange={setEnabled}>
        Enabled
      </Check>
      <p className="rounded-md bg-muted/40 px-3 py-2 text-xs">
        {effect} · {describeSubject(clean(subject), keyName)} → {describeResource(clean(resource))}
      </p>
    </FormDialog>
  )
}
