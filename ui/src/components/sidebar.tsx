import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIcon,
  ChevronRightIcon,
  FileTextIcon,
  KeyRoundIcon,
  NetworkIcon,
  SearchIcon,
  SparklesIcon,
} from 'lucide-react'

import type { Me, NoteMeta } from '@/lib/api'
import { typeColor } from '@/lib/notes'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { RoleBadge } from '@/components/role-badge'

export type Tab = 'notes' | 'graph' | 'health' | 'skills' | 'keys'

const STORAGE_KEY = 'brain.tree.expanded'
const WIDTH_KEY = 'brain.sidebar.width'
const WIDTH_MIN = 200
const WIDTH_MAX = 560
const WIDTH_DEFAULT = 272
const DEFAULT_EXPANDED = ['vault', 'skills']
const INDENT = 14 // px per depth level
const ROW_BASE_PAD = 8 // px before the chevron at depth 0

// ---------------------------------------------------------------- tree model

type Folder = {
  name: string
  path: string
  folders: Folder[]
  files: NoteMeta[]
  /** total notes below this folder, at any depth */
  count: number
}

const fileLabel = (n: NoteMeta) =>
  n.title || (n.path.split('/').pop() as string).replace(/\.md$/, '')

/** Turn flat note paths into a nested folder tree (folders first, then files, A→Z). */
function buildTree(notes: NoteMeta[]): Folder {
  type Draft = Omit<Folder, 'folders'> & { folders: Map<string, Draft> }
  const root: Draft = { name: '', path: '', folders: new Map(), files: [], count: 0 }

  for (const note of notes) {
    const segments = note.path.split('/')
    segments.pop() // the file itself
    let node = root
    node.count++
    for (const segment of segments) {
      let child = node.folders.get(segment)
      if (!child) {
        child = {
          name: segment,
          path: node.path ? `${node.path}/${segment}` : segment,
          folders: new Map(),
          files: [],
          count: 0,
        }
        node.folders.set(segment, child)
      }
      node = child
      node.count++
    }
    node.files.push(note)
  }

  const finalize = (draft: Draft): Folder => ({
    name: draft.name,
    path: draft.path,
    count: draft.count,
    folders: [...draft.folders.values()]
      .map(finalize)
      .sort((a, b) => a.name.localeCompare(b.name)),
    files: draft.files.sort((a, b) => fileLabel(a).localeCompare(fileLabel(b))),
  })

  return finalize(root)
}

/** Every ancestor folder path of a note: vault/logs/sessions/x.md → vault, vault/logs, … */
function ancestorsOf(path: string): string[] {
  const segments = path.split('/')
  segments.pop()
  const out: string[] = []
  let acc = ''
  for (const s of segments) {
    acc = acc ? `${acc}/${s}` : s
    out.push(acc)
  }
  return out
}

const clampWidth = (w: number) => Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, Math.round(w)))

function loadWidth(): number {
  try {
    const stored = Number(localStorage.getItem(WIDTH_KEY))
    if (Number.isFinite(stored) && stored > 0) return clampWidth(stored)
  } catch {
    /* storage unavailable — start at the default */
  }
  return WIDTH_DEFAULT
}

function loadExpanded(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed)) return new Set(parsed.filter((v) => typeof v === 'string'))
    }
  } catch {
    /* private mode / corrupt value — fall back to the defaults */
  }
  return new Set(DEFAULT_EXPANDED)
}

// ---------------------------------------------------------------- tree rows

function FolderRow({
  node,
  depth,
  open,
  onToggle,
}: {
  node: Folder
  depth: number
  open: boolean
  onToggle: (path: string) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onToggle(node.path)}
      title={node.path}
      aria-expanded={open}
      style={{ paddingLeft: ROW_BASE_PAD + depth * INDENT }}
      className="flex w-full items-center gap-1 rounded-md py-1 pr-2 text-left text-[13px] text-muted-foreground transition-colors hover:bg-sidebar-accent/50 hover:text-foreground"
    >
      <ChevronRightIcon
        className={cn('size-3.5 shrink-0 transition-transform duration-150', open && 'rotate-90')}
      />
      <span className="min-w-0 truncate">{node.name}</span>
      <span className="ml-auto shrink-0 pl-2 text-[10px] tabular-nums text-muted-foreground/50">
        {node.count}
      </span>
    </button>
  )
}

function FileRow({
  note,
  depth,
  active,
  onOpenNote,
  activeRef,
}: {
  note: NoteMeta
  depth: number
  active: boolean
  onOpenNote: (path: string) => void
  activeRef: (el: HTMLButtonElement | null) => void
}) {
  return (
    <button
      type="button"
      ref={active ? activeRef : undefined}
      onClick={() => onOpenNote(note.path)}
      title={note.path}
      style={{ paddingLeft: ROW_BASE_PAD + depth * INDENT + 4 }}
      className={cn(
        'flex w-full items-center gap-2 rounded-md py-1 pr-2 text-left text-[13px] transition-colors',
        active
          ? 'bg-sidebar-accent text-sidebar-accent-foreground'
          : 'text-foreground/80 hover:bg-sidebar-accent/50 hover:text-foreground',
      )}
    >
      <span
        aria-hidden
        className="size-1.5 shrink-0 rounded-full"
        style={{ background: typeColor(note.type) }}
      />
      <span className="min-w-0 truncate">{fileLabel(note)}</span>
    </button>
  )
}

function TreeLevel({
  node,
  depth,
  expanded,
  onToggle,
  current,
  onOpenNote,
  activeRef,
}: {
  node: Folder
  depth: number
  expanded: Set<string>
  onToggle: (path: string) => void
  current: string | null
  onOpenNote: (path: string) => void
  activeRef: (el: HTMLButtonElement | null) => void
}) {
  return (
    <>
      {node.folders.map((child) => {
        const open = expanded.has(child.path)
        return (
          <div key={child.path}>
            <FolderRow node={child} depth={depth} open={open} onToggle={onToggle} />
            {open && (
              <TreeLevel
                node={child}
                depth={depth + 1}
                expanded={expanded}
                onToggle={onToggle}
                current={current}
                onOpenNote={onOpenNote}
                activeRef={activeRef}
              />
            )}
          </div>
        )
      })}
      {node.files.map((file) => (
        <FileRow
          key={file.path}
          note={file}
          depth={depth}
          active={current === file.path}
          onOpenNote={onOpenNote}
          activeRef={activeRef}
        />
      ))}
    </>
  )
}

// ---------------------------------------------------------------- sidebar

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
  const tree = useMemo(() => buildTree(notes), [notes])
  const [expanded, setExpanded] = useState<Set<string>>(loadExpanded)
  const [width, setWidth] = useState(loadWidth)

  useEffect(() => {
    try {
      localStorage.setItem(WIDTH_KEY, String(width))
    } catch {
      /* storage unavailable — the width just won't persist */
    }
  }, [width])

  const startResize = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = e.currentTarget.parentElement?.getBoundingClientRect().width ?? WIDTH_DEFAULT
    const onMove = (ev: PointerEvent) => setWidth(clampWidth(startWidth + ev.clientX - startX))
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      document.body.style.userSelect = ''
    }
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [])

  const toggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...expanded]))
    } catch {
      /* storage unavailable — expansion just won't persist */
    }
  }, [expanded])

  // reveal the active note wherever it was opened from (palette, wikilink, backlink)
  useEffect(() => {
    if (!current) return
    const ancestors = ancestorsOf(current)
    setExpanded((prev) => {
      if (ancestors.every((a) => prev.has(a))) return prev
      const next = new Set(prev)
      for (const a of ancestors) next.add(a)
      return next
    })
  }, [current])

  // Scroll the active row into view once per note change — the ref callback is
  // re-invoked whenever `current` changes or the row (re)mounts after its
  // ancestors expand, and left alone when unrelated folders are toggled.
  const scrolledTo = useRef<string | null>(null)
  const setActiveRow = useCallback(
    (el: HTMLButtonElement | null) => {
      if (el && current && scrolledTo.current !== current) {
        scrolledTo.current = current
        el.scrollIntoView({ block: 'nearest' })
      }
    },
    [current],
  )

  const navItems: { id: Tab; label: string; icon: typeof FileTextIcon }[] = [
    { id: 'notes', label: 'Notes', icon: FileTextIcon },
    { id: 'graph', label: 'Graph', icon: NetworkIcon },
    { id: 'health', label: 'Health', icon: ActivityIcon },
    { id: 'skills', label: 'Skills', icon: SparklesIcon },
    ...(me?.role === 'admin'
      ? [{ id: 'keys' as const, label: 'Keys', icon: KeyRoundIcon }]
      : []),
  ]

  return (
    <aside
      style={{ width }}
      className="relative flex shrink-0 flex-col border-r border-border bg-sidebar"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        aria-valuenow={width}
        aria-valuemin={WIDTH_MIN}
        aria-valuemax={WIDTH_MAX}
        tabIndex={0}
        onPointerDown={startResize}
        onDoubleClick={() => setWidth(WIDTH_DEFAULT)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') setWidth((w) => clampWidth(w - 16))
          else if (e.key === 'ArrowRight') setWidth((w) => clampWidth(w + 16))
          else return
          e.preventDefault()
        }}
        className="absolute top-0 -right-1 z-10 h-full w-2 cursor-col-resize transition-colors hover:bg-primary/30 focus-visible:bg-primary/40 focus-visible:outline-none"
      />
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

      {/* radix wraps scroll content in a display:table div that grows to its widest
          row; block layout is what makes deep paths truncate instead of overflow */}
      <ScrollArea className="min-h-0 flex-1 [&>div>div]:block!">
        <div className="p-1.5 pb-6">
          {loading ? (
            <div className="grid gap-2 px-1.5 py-1">
              {Array.from({ length: 10 }).map((_, i) => (
                <Skeleton key={i} className="h-5 w-full" />
              ))}
            </div>
          ) : (
            <TreeLevel
              node={tree}
              depth={0}
              expanded={expanded}
              onToggle={toggle}
              current={current}
              onOpenNote={onOpenNote}
              activeRef={setActiveRow}
            />
          )}
        </div>
      </ScrollArea>

      <Separator />

      <div className="flex items-center gap-2 px-3 py-2.5">
        <span className="min-w-0 truncate text-xs text-muted-foreground">{me?.name ?? '—'}</span>
        {me && <RoleBadge role={me.role} className="ml-auto shrink-0 text-[10px]" />}
      </div>
    </aside>
  )
}
