import { useState } from 'react'
import { CheckIcon, CopyIcon } from 'lucide-react'
import { toast } from 'sonner'

import { cn } from '@/lib/utils'
import { appColor, serviceName } from '@/lib/apps'
import { Button } from '@/components/ui/button'

export function AppAvatar({
  service,
  name,
  size = 'md',
  className,
}: {
  service: string
  name?: string
  size?: 'sm' | 'md' | 'lg'
  className?: string
}) {
  const label = name ?? serviceName(service)
  const color = appColor(service)
  return (
    <span
      aria-hidden
      className={cn(
        'grid shrink-0 place-items-center rounded-lg font-semibold text-white select-none',
        size === 'sm' && 'size-7 text-xs',
        size === 'md' && 'size-9 text-sm',
        size === 'lg' && 'size-12 text-lg',
        className,
      )}
      style={{ background: `linear-gradient(135deg, ${color}, color-mix(in oklab, ${color} 70%, black))` }}
    >
      {label.replace(/[^A-Za-z0-9]/g, '').charAt(0).toUpperCase() || '?'}
    </span>
  )
}

const PILL = {
  green: 'bg-emerald-500/12 text-emerald-300 ring-emerald-500/25',
  amber: 'bg-amber-500/12 text-amber-300 ring-amber-500/25',
  red: 'bg-rose-500/12 text-rose-300 ring-rose-500/30',
  violet: 'bg-violet-500/12 text-violet-300 ring-violet-500/30',
  sky: 'bg-sky-500/12 text-sky-300 ring-sky-500/30',
  muted: 'bg-muted text-muted-foreground ring-border',
} as const
export type PillTone = keyof typeof PILL

export function Pill({
  tone = 'muted',
  children,
  title,
  dot,
  className,
}: {
  tone?: PillTone
  children: React.ReactNode
  title?: string
  dot?: boolean
  className?: string
}) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ring-1 ring-inset',
        PILL[tone],
        className,
      )}
    >
      {dot && <span aria-hidden className="size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  )
}

export function AppStatus({ status }: { status: string }) {
  if (status === 'active')
    return (
      <Pill tone="green" dot>
        Working
      </Pill>
    )
  if (status === 'auth_required')
    return (
      <Pill tone="amber" dot>
        Needs sign-in
      </Pill>
    )
  if (status === 'pending')
    return (
      <Pill tone="amber" dot>
        Finish sign-in
      </Pill>
    )
  if (status === 'error')
    return (
      <Pill tone="red" dot>
        Not working
      </Pill>
    )
  return <Pill dot>{status.replace(/_/g, ' ')}</Pill>
}

export function StatTile({
  label,
  value,
  hint,
  icon: Icon,
  onClick,
}: {
  label: string
  value: React.ReactNode
  hint?: React.ReactNode
  icon: React.ComponentType<{ className?: string }>
  onClick?: () => void
}) {
  const body = (
    <>
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <Icon className="size-4" />
        {label}
      </div>
      <div className="mt-2 text-3xl font-semibold tracking-tight tabular-nums">{value}</div>
      {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
    </>
  )
  const cls = 'rounded-xl border border-border bg-card/60 p-4 text-left'
  return onClick ? (
    <button
      type="button"
      onClick={onClick}
      className={cn(cls, 'transition-colors hover:bg-card focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none')}
    >
      {body}
    </button>
  ) : (
    <div className={cls}>{body}</div>
  )
}

/** A rounded panel with an optional heading row. */
export function Panel({
  title,
  description,
  action,
  children,
  className,
  tone,
}: {
  title?: React.ReactNode
  description?: React.ReactNode
  action?: React.ReactNode
  children?: React.ReactNode
  className?: string
  tone?: 'amber' | 'red'
}) {
  return (
    <section
      className={cn(
        'rounded-xl border bg-card/40',
        tone === 'amber' ? 'border-amber-500/30' : tone === 'red' ? 'border-rose-500/30' : 'border-border',
        className,
      )}
    >
      {(title || action) && (
        <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-4">
          <div className="min-w-0">
            {title && <h2 className="text-sm font-semibold tracking-tight">{title}</h2>}
            {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
          </div>
          {action}
        </div>
      )}
      <div className="px-5 pt-3 pb-5">{children}</div>
    </section>
  )
}

export function CopyField({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex min-w-0 items-center gap-1 rounded-lg border border-border bg-muted/40 py-1 pr-1 pl-3">
      <code className="min-w-0 flex-1 truncate font-mono text-xs" title={value}>
        {value}
      </code>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        aria-label={label ? `Copy ${label}` : 'Copy'}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value)
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1500)
          } catch {
            toast.error('Could not copy; select the text and copy it by hand')
          }
        }}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  )
}
