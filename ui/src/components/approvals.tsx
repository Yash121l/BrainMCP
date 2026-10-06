import { useState } from 'react'
import { BellIcon, CheckIcon, ChevronDownIcon, ClockIcon, XIcon } from 'lucide-react'

import { cn } from '@/lib/utils'
import { prettyJson, type Approval } from '@/lib/gateway'
import { ago, appLabel, plainReason, serviceOf, toolWords } from '@/lib/apps'
import { usePulse } from '@/lib/pulse'
import { AppAvatar } from '@/components/app-ui'
import { BusyButton } from '@/components/gateway'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

export function approvalHeadline(a: Pick<Approval, 'agent' | 'machine' | 'key' | 'tool' | 'connection'>) {
  const who = a.agent ?? a.key ?? 'An agent'
  return (
    <>
      <b className="font-semibold">{who}</b>
      {a.machine && <span className="text-muted-foreground"> on {a.machine}</span>} wants to{' '}
      <b className="font-semibold">{toolWords(a.tool).toLowerCase()}</b> in{' '}
      <b className="font-semibold">{appLabel(a.connection)}</b>
    </>
  )
}

export function ApprovalItem({ a, compact = false }: { a: Approval; compact?: boolean }) {
  const { decide } = usePulse()
  const [details, setDetails] = useState(false)
  const args = prettyJson(a.arguments)
  const reason = plainReason(a.reason)
  return (
    <div className={cn('grid gap-2.5', !compact && 'rounded-xl border border-amber-500/25 bg-amber-500/5 p-4')}>
      <div className="flex items-start gap-3">
        <AppAvatar service={serviceOf(a.connection)} size="sm" />
        <div className="min-w-0 flex-1">
          <p className="text-sm leading-snug break-words">{approvalHeadline(a)}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {ago(a.created)}
            {a.requested_by && ` · through an app you shared with ${a.requested_by}`}
          </p>
          {reason && !compact && <p className="mt-1.5 text-xs break-words text-muted-foreground">Why it asks: {reason}.</p>}
        </div>
      </div>
      {!compact && (
        <div>
          <button
            type="button"
            onClick={() => setDetails((v) => !v)}
            aria-expanded={details}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ChevronDownIcon className={cn('size-3.5 transition-transform', details && 'rotate-180')} />
            {details ? 'Hide' : 'Show'} what it will send
          </button>
          {details &&
            (args ? (
              <pre className="scrollbar-thin mt-2 max-h-56 overflow-auto rounded-lg bg-background/70 p-3 font-mono text-xs">
                {args}
              </pre>
            ) : (
              <p className="mt-2 text-xs text-muted-foreground">The details are not available for this request.</p>
            ))}
        </div>
      )}
      {a.own_key && (
        <p className="text-xs text-amber-300">
          You signed in with this agent's own key, so you can deny but not approve here. Sign in with your personal key to
          approve.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <BusyButton size={compact ? 'xs' : 'sm'} disabled={a.own_key} onClick={() => decide(a, 'approve', 'once')}>
          <CheckIcon />
          Approve once
        </BusyButton>
        <BusyButton
          size={compact ? 'xs' : 'sm'}
          variant="outline"
          disabled={a.own_key}
          onClick={() => decide(a, 'approve', 'hour')}
          title="Approve this and the same kind of request from this agent for the next hour"
        >
          <ClockIcon />
          For an hour
        </BusyButton>
        <BusyButton
          size={compact ? 'xs' : 'sm'}
          variant="ghost"
          className="text-rose-300 hover:bg-rose-500/10 hover:text-rose-200"
          onClick={() => decide(a, 'deny')}
        >
          <XIcon />
          Deny
        </BusyButton>
      </div>
    </div>
  )
}

export function ApprovalsBell({ onOpenAll }: { onOpenAll: () => void }) {
  const { approvals } = usePulse()
  const [open, setOpen] = useState(false)
  const n = approvals?.length ?? 0
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="relative"
          aria-label={n ? `Approvals: ${n} waiting` : 'Approvals: nothing waiting'}
        >
          <BellIcon />
          {n > 0 && (
            <span className="absolute -top-0.5 -right-0.5 grid min-w-4 place-items-center rounded-full bg-amber-500 px-1 text-[10px] leading-4 font-semibold text-black tabular-nums">
              {n}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(26rem,calc(100vw-2rem))] p-0">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <p className="text-sm font-semibold">Approvals</p>
            <p className="text-xs text-muted-foreground">
              {n ? `${n} request${n === 1 ? '' : 's'} waiting for you` : 'Nothing is waiting for you'}
            </p>
          </div>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              setOpen(false)
              onOpenAll()
            }}
          >
            See all
          </Button>
        </div>
        <div className="scrollbar-thin max-h-[60vh] overflow-y-auto">
          {n ? (
            <div className="divide-y divide-border">
              {approvals!.slice(0, 6).map((a) => (
                <div key={a.id} className="px-4 py-3">
                  <ApprovalItem a={a} compact />
                </div>
              ))}
            </div>
          ) : (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              When an agent wants to change something you asked to check, it shows up here.
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
