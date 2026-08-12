import { useMemo, useState } from 'react'
import {
  ChevronRightIcon,
  FileTextIcon,
  KeyRoundIcon,
  NetworkIcon,
  SearchIcon,
} from 'lucide-react'

import type { Me, NoteMeta } from '@/lib/api'
import { typeColor } from '@/lib/notes'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { RoleBadge } from '@/components/role-badge'

export type Tab = 'notes' | 'graph' | 'keys'

const DEFAULT_OPEN = new Set(['vault/projects', 'vault/rules', 'skills'])

export function Sidebar({
  me,
  notes,
  loading,
  tab,
  onTab,
  current,
  onOpenNote,
  onSearch,
}: {
  me: Me | null
  notes: NoteMeta[]
  loading: boolean
  tab: Tab
  onTab: (t: Tab) => void
  current: string | null
  onOpenNote: (path: string) => void
  onSearch: () => void
}) {
  const groups = useMemo(() => {
    const g = new Map<string, NoteMeta[]>()
    for (const n of notes) {
      const dir = n.path.split('/').slice(0, -1).join('/') || '(root)'
      const list = g.get(dir)
      if (list) list.push(n)
      else g.set(dir, [n])
    }
    return [...g.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [notes])

  const [open, setOpen] = useState<Set<string>>(DEFAULT_OPEN)
  const toggle = (dir: string) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(dir)) next.delete(dir)
      else next.add(dir)
      return next
    })

  const navItems: { id: Tab; label: string; icon: typeof FileTextIcon }[] = [
    { id: 'notes', label: 'Notes', icon: FileTextIcon },
    { id: 'graph', label: 'Graph', icon: NetworkIcon },
    ...(me?.role === 'admin'
      ? [{ id: 'keys' as const, label: 'Keys', icon: KeyRoundIcon }]
      : []),
  ]

  return (
    <aside className="flex w-[17rem] shrink-0 flex-col border-r border-border bg-sidebar">
      <div className="flex h-14 items-center gap-2 px-3">
        <span className="flex items-center gap-2 text-sm font-semibold tracking-tight">
          <span aria-hidden className="text-base">
            🧠
          </span>
          brain
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto h-8 gap-2 px-2 text-muted-foreground"
          onClick={onSearch}
        >
          <SearchIcon className="size-4" />
          <kbd className="pointer-events-none rounded border border-border bg-muted px-1 font-mono text-[10px] text-muted-foreground">
            ⌘K
          </kbd>
        </Button>
      </div>

      <Separator />

      <nav className="grid gap-1 p-2">
        {navItems.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => onTab(id)}
            className={cn(
              'flex h-8 items-center gap-2 rounded-md px-2 text-sm transition-colors',
              tab === id
                ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                : 'text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground',
            )}
          >
            <Icon className="size-4" />
            {label}
          </button>
        ))}
      </nav>

      <Separator />

      <ScrollArea className="min-h-0 flex-1">
        <div className="p-2 pb-6">
          {loading ? (
            <div className="grid gap-2 px-1 py-1">
              {Array.from({ length: 10 }).map((_, i) => (
                <Skeleton key={i} className="h-5 w-full" />
              ))}
            </div>
          ) : (
            groups.map(([dir, items]) => {
              const isOpen = open.has(dir)
              return (
                <div key={dir} className="mb-0.5">
                  <button
                    onClick={() => toggle(dir)}
                    className="flex w-full items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase transition-colors hover:bg-sidebar-accent/50 hover:text-foreground"
                  >
                    <ChevronRightIcon
                      className={cn('size-3 transition-transform', isOpen && 'rotate-90')}
                    />
                    <span className="truncate">{dir}</span>
                    <span className="ml-auto text-[10px] tabular-nums text-muted-foreground/60">
                      {items.length}
                    </span>
                  </button>
                  {isOpen && (
                    <div className="mt-0.5 grid">
                      {items.map((n) => (
                        <button
                          key={n.path}
                          onClick={() => onOpenNote(n.path)}
                          title={n.path}
                          className={cn(
                            'flex items-center gap-2 rounded-md py-1 pr-2 pl-6 text-left text-[13px] transition-colors',
                            current === n.path
                              ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                              : 'text-foreground/80 hover:bg-sidebar-accent/50 hover:text-foreground',
                          )}
                        >
                          <span
                            aria-hidden
                            className="size-1.5 shrink-0 rounded-full"
                            style={{ background: typeColor(n.type) }}
                          />
                          <span className="truncate">
                            {n.title || n.path.split('/').pop()?.replace(/\.md$/, '')}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>
      </ScrollArea>

      <Separator />

      <div className="flex items-center gap-2 px-3 py-2.5">
        <span className="truncate text-xs text-muted-foreground">{me?.name ?? '—'}</span>
        {me && <RoleBadge role={me.role} className="ml-auto text-[10px]" />}
      </div>
    </aside>
  )
}
