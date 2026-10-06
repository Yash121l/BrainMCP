import { useState } from 'react'
import { Loader2Icon, XIcon } from 'lucide-react'

import { cn } from '@/lib/utils'
import type { Risk, ToolState } from '@/lib/gateway'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
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

const TONES = {
  green: 'border-emerald-500/25 text-emerald-300',
  amber: 'border-amber-500/25 text-amber-300',
  red: 'border-rose-500/30 text-rose-300',
  violet: 'border-violet-500/30 text-violet-300',
  sky: 'border-sky-500/30 text-sky-300',
  muted: 'text-muted-foreground',
} as const
export type Tone = keyof typeof TONES

export function Tag({ tone = 'muted', children, title }: { tone?: Tone; children: React.ReactNode; title?: string }) {
  return (
    <Badge variant="outline" className={cn('text-[10px]', TONES[tone])} title={title}>
      {children}
    </Badge>
  )
}

const STATUS_TONE: Record<string, Tone> = { active: 'green', auth_required: 'amber', pending: 'amber', error: 'red', disabled: 'muted' }
export function StatusTag({ status }: { status: string }) {
  return <Tag tone={STATUS_TONE[status] ?? 'muted'}>{status.replace('_', ' ')}</Tag>
}

const STATE_TONE: Record<ToolState, Tone> = { approved: 'green', pending: 'amber', changed: 'violet', hidden: 'muted', removed: 'red' }
export function StateTag({ state }: { state: ToolState }) {
  return <Tag tone={STATE_TONE[state]}>{state}</Tag>
}

const RISK_TONE: Record<Risk, Tone> = { read: 'sky', write: 'amber', destructive: 'red', critical: 'violet' }
export function RiskTag({ risk }: { risk: Risk }) {
  return <Tag tone={RISK_TONE[risk] ?? 'muted'}>{risk}</Tag>
}

const OUTCOME_TONE: Record<string, Tone> = {
  ok: 'green',
  allow: 'green',
  approved: 'green',
  denied: 'red',
  deny: 'red',
  error: 'red',
  pending: 'amber',
  approval: 'amber',
  expired: 'muted',
  void: 'muted',
}
export function OutcomeTag({ outcome }: { outcome: string }) {
  return <Tag tone={OUTCOME_TONE[outcome] ?? 'muted'}>{outcome}</Tag>
}

export function Check({
  checked,
  onChange,
  children,
  disabled,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  children: React.ReactNode
  disabled?: boolean
}) {
  return (
    <label className={cn('flex items-center gap-2 text-sm', disabled ? 'opacity-50' : 'cursor-pointer')}>
      <Checkbox checked={checked} disabled={disabled} onCheckedChange={(v) => onChange(v === true)} />
      {children}
    </label>
  )
}

export function ChipsInput({
  value,
  onChange,
  placeholder,
  id,
}: {
  value: string[]
  onChange: (v: string[]) => void
  placeholder?: string
  id?: string
}) {
  const [draft, setDraft] = useState('')
  const commit = () => {
    const add = draft
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s && !value.includes(s))
    if (add.length) onChange([...value, ...add])
    setDraft('')
  }
  return (
    <div className="flex min-h-9 flex-wrap items-center gap-1 rounded-md border border-input px-2 py-1 dark:bg-input/30">
      {value.map((v) => (
        <span key={v} className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
          {v}
          <button
            type="button"
            aria-label={`Remove ${v}`}
            className="text-muted-foreground hover:text-foreground"
            onClick={() => onChange(value.filter((x) => x !== v))}
          >
            <XIcon className="size-3" />
          </button>
        </span>
      ))}
      <Input
        id={id}
        value={draft}
        placeholder={value.length ? '' : placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault()
            commit()
          } else if (e.key === 'Backspace' && !draft && value.length) {
            onChange(value.slice(0, -1))
          }
        }}
        className="h-7 min-w-24 flex-1 border-0 bg-transparent px-1 shadow-none focus-visible:ring-0 dark:bg-transparent"
      />
    </div>
  )
}

export function ConfirmButton({
  label,
  title,
  description,
  confirm,
  onConfirm,
  size = 'sm',
  ariaLabel,
}: {
  ariaLabel?: string
  label: React.ReactNode
  title: string
  description: React.ReactNode
  confirm: string
  onConfirm: () => Promise<boolean>
  size?: 'sm' | 'xs'
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button
          variant="ghost"
          size={size}
          aria-label={ariaLabel}
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
        >
          {label}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-white hover:bg-destructive/90"
            disabled={busy}
            onClick={async (e) => {
              e.preventDefault()
              setBusy(true)
              const ok = await onConfirm()
              setBusy(false)
              if (ok) setOpen(false)
            }}
          >
            {busy && <Loader2Icon className="animate-spin" />}
            {confirm}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export function BusyButton({
  onClick,
  children,
  ...props
}: Omit<React.ComponentProps<typeof Button>, 'onClick'> & { onClick: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false)
  return (
    <Button
      {...props}
      disabled={busy || props.disabled}
      onClick={async () => {
        setBusy(true)
        try {
          await onClick()
        } finally {
          setBusy(false)
        }
      }}
    >
      {busy && <Loader2Icon className="animate-spin" />}
      {children}
    </Button>
  )
}

export function Banner({ tone = 'amber', children }: { tone?: 'amber' | 'green' | 'red'; children: React.ReactNode }) {
  const cls = {
    amber: 'border-amber-500/25 bg-amber-500/5 text-amber-200',
    green: 'border-emerald-500/25 bg-emerald-500/5 text-emerald-200',
    red: 'border-rose-500/30 bg-rose-500/5 text-rose-200',
  }[tone]
  return <div className={cn('rounded-lg border px-3 py-2.5 text-sm', cls)}>{children}</div>
}

export function ErrorLine({ error }: { error: string | null }) {
  if (!error) return null
  return <Banner tone="red">{error}</Banner>
}

export function MultiPick({
  options,
  value,
  onChange,
  empty = 'None available.',
  label = (v) => v,
}: {
  options: string[]
  value: string[]
  onChange: (v: string[]) => void
  empty?: string
  label?: (v: string) => string
}) {
  if (!options.length) return <p className="text-xs text-muted-foreground">{empty}</p>
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const on = value.includes(o)
        return (
          <button
            key={o}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(on ? value.filter((x) => x !== o) : [...value, o])}
            className={cn(
              'rounded-md border px-2 py-0.5 font-mono text-xs',
              on ? 'border-primary/40 bg-primary/10' : 'border-border text-muted-foreground hover:bg-muted/40',
            )}
          >
            {label(o)}
          </button>
        )
      })}
    </div>
  )
}
