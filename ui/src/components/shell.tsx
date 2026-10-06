import { BrainMark } from '@/components/logo'
import {
  BlocksIcon,
  BotIcon,
  BrainIcon,
  CircleHelpIcon,
  HistoryIcon,
  HouseIcon,
  SearchIcon,
  SettingsIcon,
} from 'lucide-react'

import type { Me, SpaceRef } from '@/lib/api'
import { cn } from '@/lib/utils'
import { RoleBadge } from '@/components/role-badge'
import { ApprovalsBell } from '@/components/approvals'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

export type Dest = 'home' | 'apps' | 'agents' | 'activity' | 'brain' | 'settings' | 'approvals' | 'device'

type NavItem = { id: Dest; label: string; icon: typeof HouseIcon; badge?: number; hint: string }

const SPACE_GROUPS: { label: string; match: (s: SpaceRef) => boolean }[] = [
  { label: 'Your spaces', match: (s) => ['owner', 'admin', 'editor', 'viewer'].includes(s.access) },
  { label: 'Shared with you', match: (s) => s.access === 'share' },
  { label: 'Super admin view', match: (s) => s.access === 'super' || s.access === 'system' },
]
const ACCESS_LABEL: Partial<Record<SpaceRef['access'], string>> = {
  share: 'shared',
  super: 'admin view',
  system: 'default skills',
}

function SpaceSwitcher({ me, onSpace }: { me: Me; onSpace: (handle: string) => void }) {
  if (me.spaces.length < 2) return null
  return (
    <div className="hidden px-3 pb-2 lg:block">
      <p className="mb-1 px-1 text-[11px] font-medium text-muted-foreground">Brain space</p>
      <Select value={me.space ?? undefined} onValueChange={onSpace}>
        <SelectTrigger size="sm" className="w-full" aria-label="Brain space">
          <SelectValue placeholder="Pick a space" />
        </SelectTrigger>
        <SelectContent>
          {SPACE_GROUPS.map((g) => {
            const items = me.spaces.filter(g.match)
            if (!items.length) return null
            return (
              <SelectGroup key={g.label}>
                <SelectLabel>{g.label}</SelectLabel>
                {items.map((s) => (
                  <SelectItem key={s.handle} value={s.handle}>
                    {s.handle}
                    <span className="text-xs text-muted-foreground">{ACCESS_LABEL[s.access] ?? s.access}</span>
                  </SelectItem>
                ))}
              </SelectGroup>
            )
          })}
        </SelectContent>
      </Select>
    </div>
  )
}

export function Sidebar({
  me,
  dest,
  onGo,
  onSpace,
  badges,
}: {
  me: Me | null
  dest: Dest
  onGo: (d: Dest) => void
  onSpace: (handle: string) => void
  badges: Partial<Record<Dest, number>>
}) {
  const items: NavItem[] = [
    ...(me?.user
      ? ([
          { id: 'home', label: 'Home', icon: HouseIcon, hint: 'What needs you, at a glance' },
          { id: 'apps', label: 'Apps', icon: BlocksIcon, hint: 'Apps your agents can use' },
          { id: 'agents', label: 'Agents', icon: BotIcon, hint: 'Your devices and the agents on them' },
          { id: 'activity', label: 'Activity', icon: HistoryIcon, hint: 'Everything your agents did' },
        ] as NavItem[])
      : []),
    { id: 'brain', label: 'Brain', icon: BrainIcon, hint: 'Notes, graph, skills and health' },
    { id: 'settings', label: 'Settings', icon: SettingsIcon, hint: 'Account, keys, sharing and more' },
  ]
  const current: Dest = dest === 'approvals' ? 'home' : dest === 'device' ? 'agents' : dest

  return (
    <aside className="flex w-16 shrink-0 flex-col border-r border-border bg-sidebar lg:w-60">
      <div className="flex h-14 items-center gap-2 px-4">
        <BrainMark />
        <span className="hidden text-sm font-semibold tracking-tight lg:inline">BrainMCP</span>
      </div>
      <nav aria-label="Main" className="grid gap-1 px-2 pt-2 lg:px-3">
        {items.map(({ id, label, icon: Icon, hint }) => {
          const badge = badges[id]
          const active = current === id
          return (
            <Tooltip key={id}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => onGo(id)}
                  title={hint}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'relative flex h-10 items-center justify-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/60 lg:justify-start',
                    active
                      ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                      : 'text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground',
                  )}
                >
                  <Icon className="size-[18px] shrink-0" />
                  <span className="hidden lg:inline">{label}</span>
                  {!!badge && (
                    <span className="absolute top-1 right-1 grid min-w-4 place-items-center rounded-full bg-amber-500 px-1 text-[10px] leading-4 font-semibold text-black tabular-nums lg:static lg:ml-auto lg:min-w-5 lg:bg-amber-500/20 lg:text-amber-300">
                      {badge}
                    </span>
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="right" className="lg:hidden">
                {label}
              </TooltipContent>
            </Tooltip>
          )
        })}
      </nav>
      <div className="mt-auto">
        {me && <SpaceSwitcher me={me} onSpace={onSpace} />}
        <div className="flex items-center justify-center gap-2 border-t border-border px-4 py-3 lg:justify-start">
          <span
            aria-hidden
            className="grid size-7 shrink-0 place-items-center rounded-full bg-muted text-xs font-semibold uppercase"
          >
            {(me?.user ?? me?.name ?? '?').replace('@', '').charAt(0)}
          </span>
          <span className="hidden min-w-0 truncate text-xs text-muted-foreground lg:inline" title={me?.name}>
            {me?.user ?? me?.name ?? '—'}
          </span>
          {me && me.role !== 'none' && (
            <RoleBadge role={me.super ? 'super' : me.role} className="ml-auto hidden shrink-0 text-[10px] lg:inline-flex" />
          )}
        </div>
      </div>
    </aside>
  )
}

export function TopBar({
  me,
  onSearch,
  onHelp,
  onApprovals,
}: {
  me: Me | null
  onSearch: () => void
  onHelp: () => void
  onApprovals: () => void
}) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4 lg:px-6">
      <Button
        variant="outline"
        size="sm"
        className="h-8 w-full max-w-xs justify-start gap-2 text-muted-foreground"
        onClick={onSearch}
      >
        <SearchIcon />
        <span className="truncate">Search notes and pages</span>
        <kbd className="pointer-events-none ml-auto hidden rounded border border-border bg-muted px-1 font-mono text-[10px] sm:inline">
          ⌘K
        </kbd>
      </Button>
      <div className="ml-auto flex items-center gap-1">
        {me?.user && <ApprovalsBell onOpenAll={onApprovals} />}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Help and guides" onClick={onHelp}>
              <CircleHelpIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Help and guides</TooltipContent>
        </Tooltip>
      </div>
    </header>
  )
}
