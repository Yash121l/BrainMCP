import { ToggleGroup } from 'radix-ui'

import { cn } from '@/lib/utils'

/** A row of mutually exclusive options (radio semantics, arrow-key navigation). */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  size = 'md',
  disabled,
  className,
}: {
  value: T
  options: { value: T; label: string; hint?: string }[]
  onChange: (v: T) => void
  label: string
  size?: 'sm' | 'md'
  disabled?: boolean
  className?: string
}) {
  return (
    <ToggleGroup.Root
      type="single"
      value={value}
      aria-label={label}
      disabled={disabled}
      onValueChange={(v) => v && onChange(v as T)}
      className={cn('inline-flex flex-wrap gap-0.5 rounded-lg border border-border bg-muted/40 p-0.5', className)}
    >
      {options.map((o) => (
        <ToggleGroup.Item
          key={o.value}
          value={o.value}
          title={o.hint}
          className={cn(
            'rounded-md font-medium whitespace-nowrap text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-50 data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm',
            size === 'sm' ? 'px-2 py-1 text-xs' : 'px-3 py-1.5 text-sm',
          )}
        >
          {o.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  )
}
