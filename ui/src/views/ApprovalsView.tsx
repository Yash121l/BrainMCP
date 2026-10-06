import { CheckIcon } from 'lucide-react'

import { gw, useGw, type Approval } from '@/lib/gateway'
import { expired } from '@/lib/people'
import { ago, appLabel, serviceOf, toolWords } from '@/lib/apps'
import { usePulse } from '@/lib/pulse'
import { Page } from '@/components/page'
import { PageIntro } from '@/components/guides'
import { AppAvatar, Panel, Pill } from '@/components/app-ui'
import { ApprovalItem } from '@/components/approvals'
import { ErrorLine } from '@/components/gateway'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

export function ApprovalsView({ onNotifications, onUnauthorized }: { onNotifications: () => void; onUnauthorized: () => void }) {
  const pulse = usePulse()
  const pendingCount = pulse.approvals?.length ?? 0
  const history = useGw(() => gw.approvals(), [pendingCount], onUnauthorized)
  const pending = pulse.approvals
  const past = (history.data?.approvals ?? []).filter((a) => !(a.status === 'pending' && !expired(a.expires)))
  const notify = !!pulse.overview?.notify_url

  return (
    <Page title="Approvals" intro="Requests your agents are waiting on. They carry on by themselves once you decide.">
      <PageIntro page="approvals" />
      <ErrorLine error={history.error} />
      {!notify && pulse.overview && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-muted/30 px-4 py-3 text-sm">
          <span className="min-w-0 flex-1">Get a push on your phone when an agent waits for you.</span>
          <Button size="sm" variant="outline" onClick={onNotifications}>
            Set up notifications
          </Button>
        </div>
      )}
      <Panel title="Waiting for you">
        {pending == null ? (
          <Skeleton className="h-28 w-full" />
        ) : pending.length ? (
          <div className="grid gap-3">
            {pending.map((a) => (
              <ApprovalItem key={a.id} a={a} />
            ))}
          </div>
        ) : (
          <div className="flex items-center gap-3 rounded-lg bg-emerald-500/5 px-4 py-4 text-sm">
            <CheckIcon className="size-4 text-emerald-300" />
            Nothing is waiting for you.
          </div>
        )}
      </Panel>
      <Panel title="Earlier decisions">
        {history.data == null ? (
          <Skeleton className="h-24 w-full" />
        ) : past.length ? (
          <ul className="divide-y divide-border">
            {past.map((a) => (
              <HistoryRow key={a.id} a={a} />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No decisions yet.</p>
        )}
      </Panel>
    </Page>
  )
}

const STATUS: Record<string, { label: string; tone: 'green' | 'red' | 'muted' }> = {
  approved: { label: 'Approved', tone: 'green' },
  denied: { label: 'Denied', tone: 'red' },
  expired: { label: 'Expired', tone: 'muted' },
  void: { label: 'Cancelled', tone: 'muted' },
  pending: { label: 'Expired', tone: 'muted' },
}

function HistoryRow({ a }: { a: Approval }) {
  const s = STATUS[a.status] ?? STATUS.expired
  return (
    <li className="flex flex-wrap items-center gap-3 py-2.5">
      <AppAvatar service={serviceOf(a.connection)} size="sm" />
      <p className="min-w-0 flex-1 truncate text-sm">
        <span className="font-medium">{a.agent ?? a.key ?? 'An agent'}</span>
        {a.machine && <span className="text-muted-foreground"> on {a.machine}</span>} · {toolWords(a.tool).toLowerCase()} in{' '}
        {appLabel(a.connection)}
        {a.requested_by && <span className="text-muted-foreground"> · {a.requested_by}'s agent</span>}
      </p>
      <Pill tone={s.tone}>
        {s.label}
        {a.status === 'approved' && a.scope === 'hour' && ' for an hour'}
      </Pill>
      <span className="w-20 text-right text-xs text-muted-foreground">{ago(a.decided ?? a.created)}</span>
    </li>
  )
}
