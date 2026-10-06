import { PencilIcon, PlusIcon, Trash2Icon } from 'lucide-react'

import { attempt, describeResource, describeSubject, gw, useGw, type BuiltinRule, type GwKey, type Rule } from '@/lib/gateway'
import { Empty, Page, Section } from '@/components/page'
import { Check, ConfirmButton, ErrorLine, Tag, type Tone } from '@/components/gateway'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { RuleDialog } from '@/views/rules/RuleDialog'
import { RuleTest } from '@/views/rules/RuleTest'
import { isManaged, managedText } from '@/lib/access'

const EFFECT_TONE: Record<Rule['effect'] | BuiltinRule['effect'], Tone> = {
  permit: 'green',
  forbid: 'red',
  deny: 'red',
  approve: 'amber',
}

export function RulesView({ onUnauthorized }: { onUnauthorized: () => void }) {
  const rules = useGw(() => gw.rules(), [], onUnauthorized)
  const machines = useGw(() => gw.machines(), [], onUnauthorized)
  const overview = useGw(() => gw.overview(), [], onUnauthorized)
  const keys: GwKey[] = [
    ...(machines.data?.machines.filter((m) => !m.revoked).flatMap((m) => m.keys) ?? []),
    ...(machines.data?.unassigned_keys ?? []),
  ]
  const keyName = (id: string) => keys.find((k) => k.id === id)?.name ?? id
  const connNames = overview.data?.connections.map((c) => c.connection) ?? []

  return (
    <Page
      title="Advanced rules"
      intro="The precise rules behind access levels. The Apps page writes most of these for you (marked “Set from the Apps page”); add your own only for cases it can't express. A forbid always wins. Destructive and critical tools need a rule that names their risk or the tool itself; wildcards never reach them."
      action={
        <RuleDialog
          keys={keys}
          connections={connNames}
          onDone={rules.reload}
          trigger={
            <Button size="sm">
              <PlusIcon />
              New rule
            </Button>
          }
        />
      }
    >
      <ErrorLine error={rules.error} />
      <Section title="Your rules">
        {rules.data == null ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <div className="grid gap-2">
            {rules.data.rules.map((r) => (
              <RuleRow key={r.id} r={r} keyName={keyName} keys={keys} connections={connNames} onChanged={rules.reload} />
            ))}
            {!rules.data.rules.length && <Empty>No rules yet. Agents can use nothing until a rule permits it.</Empty>}
          </div>
        )}
      </Section>
      <Section title="Built in" intro="These always apply, on top of your rules.">
        {rules.data == null ? (
          <Skeleton className="h-20 w-full" />
        ) : (
          <div className="grid gap-2">
            {rules.data.builtin.map((b) => (
              <div key={b.text} className="flex items-start gap-3 rounded-lg border border-dashed border-border px-3 py-2.5 text-sm">
                <Tag tone={EFFECT_TONE[b.effect] ?? 'muted'}>{b.effect}</Tag>
                <span>{b.text}</span>
              </div>
            ))}
          </div>
        )}
      </Section>
      <Section title="Test" intro="What would happen if this key called this tool now?">
        <RuleTest
          keys={keys}
          connections={overview.data?.connections ?? []}
          ruleLabel={(id) => {
            const r = rules.data?.rules.find((x) => x.id === id)
            if (!r) return id
            return r.note || `${r.effect} · ${describeSubject(r.subject, keyName)} → ${describeResource(r.resource)}`
          }}
        />
      </Section>
    </Page>
  )
}

function RuleRow({
  r,
  keyName,
  keys,
  connections,
  onChanged,
}: {
  r: Rule
  keyName: (id: string) => string
  keys: GwKey[]
  connections: string[]
  onChanged: () => void
}) {
  const toggle = async (enabled: boolean) => {
    const ok = await attempt(() =>
      gw.putRule({ id: r.id, effect: r.effect, subject: r.subject, resource: r.resource, note: r.note ?? undefined, enabled }),
    )
    if (ok) onChanged()
  }
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5">
      <Check checked={r.enabled} disabled={!r.mine} onChange={toggle}>
        <span className="sr-only">Enabled</span>
      </Check>
      <div className={r.enabled ? 'min-w-0 flex-1' : 'min-w-0 flex-1 opacity-50'}>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Tag tone={EFFECT_TONE[r.effect]}>{r.effect}</Tag>
          <span>{describeSubject(r.subject, keyName)}</span>
          <span className="text-muted-foreground">→</span>
          <span className="min-w-0 font-mono text-xs break-all">{describeResource(r.resource)}</span>
          {r.global && <Tag tone="violet">global</Tag>}
          {isManaged(r) && <Tag tone="sky">Set from the Apps page</Tag>}
        </div>
        {r.note && (
          <p className="mt-0.5 text-xs break-words text-muted-foreground">
            {isManaged(r) ? (managedText(r.note, keyName) ?? r.note) : r.note}
          </p>
        )}
      </div>
      {r.mine && (
        <div className="flex items-center gap-1">
          <RuleDialog
            rule={r}
            keys={keys}
            connections={connections}
            onDone={onChanged}
            trigger={
              <Button size="icon-sm" variant="ghost" aria-label="Edit rule">
                <PencilIcon />
              </Button>
            }
          />
          <ConfirmButton
            size="xs"
            ariaLabel="Delete rule"
            label={<Trash2Icon />}
            title="Delete this rule?"
            description={`${r.effect} · ${describeSubject(r.subject, keyName)} → ${describeResource(r.resource)}`}
            confirm="Delete rule"
            onConfirm={async () => {
              const ok = await attempt(() => gw.deleteRule(r.id), 'Rule deleted')
              if (ok) onChanged()
              return !!ok
            }}
          />
        </div>
      )}
    </div>
  )
}
