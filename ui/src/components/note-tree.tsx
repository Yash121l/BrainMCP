import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRightIcon } from 'lucide-react'

import type { NoteMeta } from '@/lib/api'
import { typeColor } from '@/lib/notes'
import { cn } from '@/lib/utils'
import { Skeleton } from '@/components/ui/skeleton'

const STORAGE_KEY = 'brain.tree.expanded'
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

/** The folder tree of every note in the current space. */
export function NoteTree({
  notes,
  loading,
  current,
  onOpenNote,
}: {
  notes: NoteMeta[]
  loading: boolean
  current: string | null
  onOpenNote: (path: string) => void
}) {
  const tree = useMemo(() => buildTree(notes), [notes])
  const [expanded, setExpanded] = useState<Set<string>>(loadExpanded)

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

  if (loading)
    return (
      <div className="grid gap-2 px-1.5 py-1">
        {Array.from({ length: 10 }).map((_, i) => (
          <Skeleton key={i} className="h-5 w-full" />
        ))}
      </div>
    )
  if (!notes.length) return <p className="px-2 py-4 text-xs text-muted-foreground">No notes in this space yet.</p>
  return (
    <TreeLevel
      node={tree}
      depth={0}
      expanded={expanded}
      onToggle={toggle}
      current={current}
      onOpenNote={onOpenNote}
      activeRef={setActiveRow}
    />
  )
}
