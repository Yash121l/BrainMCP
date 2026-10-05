import { useState } from 'react'
import { Loader2Icon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'

export type SubmitOutcome = 'close' | 'stay' | { show: React.ReactNode }

export function FormDialog({
  trigger,
  title,
  description,
  submitLabel,
  canSubmit = true,
  onOpen,
  onSubmit,
  children,
}: {
  trigger: React.ReactNode
  title: string
  description?: React.ReactNode
  submitLabel: string
  canSubmit?: boolean
  onOpen?: () => void
  onSubmit: () => Promise<SubmitOutcome>
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<React.ReactNode>(null)

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v)
        if (v) {
          setResult(null)
          setBusy(false)
          onOpen?.()
        }
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {result ? (
          <>
            {result}
            <DialogFooter>
              <Button onClick={() => setOpen(false)}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <form
            className="grid gap-4"
            onSubmit={async (e) => {
              e.preventDefault()
              if (busy || !canSubmit) return
              setBusy(true)
              const r = await onSubmit()
              setBusy(false)
              if (r === 'close') setOpen(false)
              else if (r !== 'stay') setResult(r.show)
            }}
          >
            {children}
            <DialogFooter>
              <Button type="submit" disabled={busy || !canSubmit}>
                {busy && <Loader2Icon className="animate-spin" />}
                {submitLabel}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

export function Field({
  id,
  label,
  hint,
  ...input
}: { id: string; label: string; hint?: string } & React.ComponentProps<typeof Input>) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} {...input} />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

export function Choice<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T
  options: { value: T; label: string; hint?: string }[]
  onChange: (v: T) => void
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          title={o.hint}
          className={
            value === o.value
              ? 'rounded-md border border-primary/40 bg-primary/10 px-2.5 py-1 text-xs'
              : 'rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted/40'
          }
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
