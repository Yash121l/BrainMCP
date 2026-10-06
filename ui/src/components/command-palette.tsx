import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRightIcon, FileTextIcon, Loader2Icon, SearchIcon } from 'lucide-react'

import { api, Unauthorized, type SearchHit } from '@/lib/api'
import { titleOf, typeColor, type NoteIndex } from '@/lib/notes'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'

/** FTS snippets arrive as plain text with <b>…</b> markers — render them safely. */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/(<\/?b>)/g)
  let bold = false
  return (
    <span className="line-clamp-2 text-xs text-muted-foreground">
      {parts.map((p, i) => {
        if (p === '<b>') {
          bold = true
          return null
        }
        if (p === '</b>') {
          bold = false
          return null
        }
        return bold ? (
          <mark key={i} className="bg-transparent font-medium text-foreground">
            {p}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        )
      })}
    </span>
  )
}

export function CommandPalette({
  open,
  onOpenChange,
  index,
  onOpenNote,
  onUnauthorized,
  pages = [],
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  index: NoteIndex
  onOpenNote: (path: string) => void
  onUnauthorized: () => void
  /** Pages the palette can jump to: label plus what to run. */
  pages?: { label: string; keywords?: string; run: () => void }[]
}) {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [searching, setSearching] = useState(false)
  const abort = useRef<AbortController | null>(null)

  // debounced full-text search
  useEffect(() => {
    const term = q.trim()
    abort.current?.abort()
    if (!open || term.length < 2) {
      setHits([])
      setSearching(false)
      return
    }
    setSearching(true)
    const t = setTimeout(() => {
      const ac = new AbortController()
      abort.current = ac
      api
        .search(term, ac.signal)
        .then((r) => {
          setHits(r)
          setSearching(false)
        })
        .catch((e) => {
          if (ac.signal.aborted) return
          setSearching(false)
          if (e instanceof Unauthorized) onUnauthorized()
        })
    }, 250)
    return () => clearTimeout(t)
  }, [q, open, onUnauthorized])

  const titleMatches = useMemo(() => {
    const term = q.trim().toLowerCase()
    if (!term) return index.notes.slice(0, 8)
    return index.notes
      .filter(
        (n) =>
          (n.title || '').toLowerCase().includes(term) || n.path.toLowerCase().includes(term),
      )
      .slice(0, 8)
  }, [q, index])

  const hitPaths = new Set(titleMatches.map((n) => n.path))
  const pageMatches = useMemo(() => {
    const term = q.trim().toLowerCase()
    if (!term) return pages.slice(0, 6)
    return pages.filter((p) => `${p.label} ${p.keywords ?? ''}`.toLowerCase().includes(term)).slice(0, 6)
  }, [q, pages])

  function pick(path: string) {
    onOpenChange(false)
    setQ('')
    onOpenNote(path)
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      shouldFilter={false}
      title="Search"
      description="Jump to a page, or search notes by title, path or full text"
      className="max-w-2xl"
    >
      <CommandInput
        placeholder="Search pages and notes…"
        value={q}
        onValueChange={setQ}
      />
      <CommandList className="max-h-[60vh]">
        {!searching && titleMatches.length === 0 && hits.length === 0 && pageMatches.length === 0 && (
          <CommandEmpty>Nothing found.</CommandEmpty>
        )}

        {pageMatches.length > 0 && (
          <CommandGroup heading="Go to">
            {pageMatches.map((p) => (
              <CommandItem
                key={p.label}
                value={`p:${p.label}`}
                onSelect={() => {
                  onOpenChange(false)
                  setQ('')
                  p.run()
                }}
              >
                <ArrowRightIcon className="size-3.5 text-muted-foreground" />
                {p.label}
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {titleMatches.length > 0 && (
          <CommandGroup heading={q.trim() ? 'Titles' : 'Recent paths'}>
            {titleMatches.map((n) => (
              <CommandItem key={n.path} value={`t:${n.path}`} onSelect={() => pick(n.path)}>
                <span
                  aria-hidden
                  className="size-1.5 shrink-0 rounded-full"
                  style={{ background: typeColor(n.type) }}
                />
                <span className="truncate">{titleOf(index, n.path)}</span>
                <span className="ml-auto truncate pl-4 font-mono text-[11px] text-muted-foreground">
                  {n.path}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        <CommandGroup
          heading={
            <span className="flex items-center gap-2">
              Full text
              {searching && <Loader2Icon className="size-3 animate-spin" />}
            </span>
          }
        >
          {hits
            .filter((h) => !hitPaths.has(h.path))
            .map((h) => (
              <CommandItem
                key={h.path}
                value={`f:${h.path}`}
                onSelect={() => pick(h.path)}
                className="items-start"
              >
                <FileTextIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                <span className="grid min-w-0 gap-0.5">
                  <span className="truncate font-mono text-[11px] text-sky-400">{h.path}</span>
                  <Snippet text={h.snippet || ''} />
                </span>
              </CommandItem>
            ))}
          {!searching && q.trim().length >= 2 && hits.length === 0 && (
            <div className="px-2 py-3 text-xs text-muted-foreground">
              <SearchIcon className="mr-1.5 inline size-3" />
              No full-text matches.
            </div>
          )}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}
