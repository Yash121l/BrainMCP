import { cn } from '@/lib/utils'

export function SubNav<T extends string>({
  items,
  value,
  onChange,
  label,
}: {
  items: { id: T; label: string; icon?: React.ComponentType<{ className?: string }>; badge?: number }[]
  value: T
  onChange: (v: T) => void
  label: string
}) {
  return (
    <nav aria-label={label} className="scrollbar-thin flex shrink-0 gap-1 overflow-x-auto border-b border-border px-4 lg:px-6">
      {items.map(({ id, label: text, icon: Icon, badge }) => (
        <button
          key={id}
          type="button"
          onClick={() => onChange(id)}
          aria-current={value === id ? 'page' : undefined}
          className={cn(
            '-mb-px flex h-11 items-center gap-2 border-b-2 px-3 text-sm whitespace-nowrap transition-colors outline-none focus-visible:bg-accent/50',
            value === id
              ? 'border-foreground font-medium text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
        >
          {Icon && <Icon className="size-4" />}
          {text}
          {!!badge && (
            <span className="rounded-full bg-amber-500/20 px-1.5 text-[10px] font-medium text-amber-300 tabular-nums">{badge}</span>
          )}
        </button>
      ))}
    </nav>
  )
}
