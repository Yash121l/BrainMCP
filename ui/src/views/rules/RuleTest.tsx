import { useEffect, useState } from 'react'
import { FlaskConicalIcon } from 'lucide-react'

import { attempt, gw, TAINTS, type Connection, type Decision, type GwKey, type Taint, type UpstreamTool } from '@/lib/gateway'
import { BusyButton, Check, OutcomeTag, RiskTag, StateTag, Tag } from '@/components/gateway'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

function Pick({
  label,
  value,
  onChange,
  options,
  placeholder,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  placeholder: string
}) {
  return (
    <div className="grid gap-1.5">
      <Label>{label}</Label>
      <Select value={value || undefined} onValueChange={onChange}>
        <SelectTrigger className="w-full" aria-label={label}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

export function RuleTest({
  keys,
  connections,
  ruleLabel = (id) => id,
}: {
  keys: GwKey[]
  connections: Connection[]
  ruleLabel?: (id: string) => string
}) {
  const [keyId, setKeyId] = useState('')
  const [conn, setConn] = useState('')
  const [tool, setTool] = useState('')
  const [tools, setTools] = useState<UpstreamTool[] | null>(null)
  const [taint, setTaint] = useState<Taint[]>([])
  const [result, setResult] = useState<Decision | null>(null)

  const picked = connections.find((c) => c.connection === conn)
  const ownId = picked?.id ?? null

  useEffect(() => {
    setTools(null)
    setTool('')
    setResult(null)
    if (!ownId) return
    let alive = true
    gw.tools(ownId)
      .then((r) => alive && setTools(r.tools.filter((t) => t.state !== 'removed')))
      .catch(() => alive && setTools([]))
    return () => {
      alive = false
    }
  }, [ownId])

  if (!keys.length) {
    return (
      <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
        You have no agent keys yet. Add a machine (brain login) or make a key, then test it here.
      </p>
    )
  }
  return (
    <div className="grid gap-4 rounded-lg border border-border p-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Pick
          label="Key"
          value={keyId}
          onChange={setKeyId}
          placeholder="Pick a key"
          options={keys.map((k) => ({ value: k.id, label: k.name }))}
        />
        <Pick
          label="Connection"
          value={conn}
          onChange={setConn}
          placeholder="Pick a connection"
          options={connections.map((c) => ({ value: c.connection, label: c.shared_by ? `${c.connection} (${c.shared_by})` : c.connection }))}
        />
        {tools ? (
          <Pick label="Tool" value={tool} onChange={setTool} placeholder="Pick a tool" options={tools.map((t) => ({ value: t.name, label: t.name }))} />
        ) : (
          <div className="grid gap-1.5">
            <Label htmlFor="t-tool">Tool</Label>
            <Input id="t-tool" placeholder="tool name" value={tool} onChange={(e) => setTool(e.target.value)} />
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <span className="text-xs text-muted-foreground">Key has already read:</span>
        {TAINTS.map((t) => (
          <Check key={t} checked={taint.includes(t)} onChange={(on) => setTaint((x) => (on ? [...x, t] : x.filter((y) => y !== t)))}>
            {t === 'flagged' ? 'flagged output' : `${t} data`}
          </Check>
        ))}
        <BusyButton
          size="sm"
          className="ml-auto"
          disabled={!keyId || !conn || !tool.trim()}
          onClick={async () => {
            setResult(await attempt(() => gw.testRule({ key_id: keyId, connection: conn, tool: tool.trim(), taint })))
          }}
        >
          <FlaskConicalIcon />
          Test
        </BusyButton>
      </div>
      {result && (
        <div className="grid gap-1.5 rounded-md bg-muted/30 px-3 py-2.5 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <OutcomeTag outcome={result.decision} />
            <span>{result.reason}</span>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            tool <StateTag state={result.tool_state} /> <RiskTag risk={result.risk} />
            {result.egress && <Tag tone="amber">egress</Tag>}
            {result.rule && <span className="break-words">matched: {ruleLabel(result.rule)}</span>}
          </div>
        </div>
      )}
    </div>
  )
}
