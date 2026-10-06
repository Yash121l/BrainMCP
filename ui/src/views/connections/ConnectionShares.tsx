import { useState } from 'react'
import { toast } from 'sonner'
import { Share2Icon } from 'lucide-react'

import { attempt, gw, type OwnConnection, type Share, type UpstreamTool } from '@/lib/gateway'
import { day } from '@/lib/people'
import { Field } from '@/components/form-dialog'
import { BusyButton, Check, Tag } from '@/components/gateway'
import { Label } from '@/components/ui/label'

export function ConnectionShares({
  conn,
  tools,
  outgoing,
  onChanged,
}: {
  conn: OwnConnection
  tools: UpstreamTool[]
  outgoing: Share[]
  onChanged: () => void
}) {
  const [handle, setHandle] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [days, setDays] = useState('')
  const approved = tools.filter((t) => t.state === 'approved')

  return (
    <div className="grid gap-3">
      <div className="grid grid-cols-[1fr_9rem] gap-3">
        <Field id="s-handle" label="Their handle" placeholder="@alice" value={handle} onChange={(e) => setHandle(e.target.value)} />
        <Field
          id="s-days"
          label="Ends after (days)"
          type="number"
          min={1}
          max={365}
          placeholder="never"
          value={days}
          onChange={(e) => setDays(e.target.value)}
        />
      </div>
      {approved.length > 0 && (
        <div className="grid gap-1.5">
          <Label>Which tools</Label>
          <p className="text-xs text-muted-foreground">Pick none to share only the tools that read.</p>
          <div className="grid max-h-40 grid-cols-2 gap-1.5 overflow-y-auto rounded-md border border-border p-2">
            {approved.map((t) => (
              <Check
                key={t.name}
                checked={picked.includes(t.name)}
                onChange={(v) => setPicked((p) => (v ? [...p, t.name] : p.filter((x) => x !== t.name)))}
              >
                <span className="truncate font-mono text-xs">{t.name}</span>
              </Check>
            ))}
          </div>
        </div>
      )}
      <div>
        <BusyButton
          size="sm"
          disabled={!handle.trim()}
          onClick={async () => {
            const r = await attempt(() =>
              gw.share(conn.id, handle.trim().replace(/^@/, ''), picked, days ? Number(days) : undefined),
            )
            if (!r) return
            toast.success(r.note ?? 'Shared')
            setHandle('')
            setPicked([])
            setDays('')
            onChanged()
          }}
        >
          <Share2Icon />
          Share
        </BusyButton>
      </div>
      {outgoing.length > 0 && (
        <div className="grid gap-2">
          {outgoing.map((s) => (
            <div key={s.grantee} className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm">
              <span>@{s.grantee}</span>
              <Tag tone={s.accepted ? 'green' : 'amber'}>{s.accepted ? 'using it' : 'not accepted yet'}</Tag>
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                {s.tools.length ? s.tools.join(', ') : 'tools that read'}
                {s.expires && ` · until ${day(s.expires)}`}
              </span>
              <BusyButton
                size="xs"
                variant="ghost"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={async () => {
                  if (await attempt(() => gw.unshare(conn.id, s.grantee!), `Stopped sharing with @${s.grantee}`))
                    onChanged()
                }}
              >
                Stop sharing
              </BusyButton>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
