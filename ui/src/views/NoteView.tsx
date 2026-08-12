import { useMemo } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CornerUpLeftIcon, FileTextIcon } from 'lucide-react'

import type { Note } from '@/lib/api'
import { fmValue, rewriteWikilinks, stripFrontmatter, WIKI_DEAD, WIKI_SCHEME } from '@/lib/markdown'
import { titleOf, typeColor, type NoteIndex } from '@/lib/notes'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'

export function NoteView({
  note,
  loading,
  index,
  backlinks,
  onOpenNote,
}: {
  note: Note | null
  loading: boolean
  index: NoteIndex
  backlinks: string[] | null
  onOpenNote: (path: string) => void
}) {
  const body = useMemo(
    () => (note ? rewriteWikilinks(stripFrontmatter(note.content || ''), index) : ''),
    [note, index],
  )

  const components: Components = useMemo(
    () => ({
      a({ href, children, ...props }) {
        const target = href ?? ''
        if (target.startsWith(WIKI_SCHEME)) {
          const path = decodeURIComponent(target.slice(WIKI_SCHEME.length))
          return (
            <button
              type="button"
              onClick={() => onOpenNote(path)}
              title={path}
              className="cursor-pointer font-medium text-sky-400 underline decoration-sky-400/40 decoration-dotted underline-offset-4 transition-colors hover:text-sky-300 hover:decoration-sky-300"
            >
              {children}
            </button>
          )
        }
        if (target.startsWith(WIKI_DEAD)) {
          return (
            <span
              title={`unresolved: ${decodeURIComponent(target.slice(WIKI_DEAD.length))}`}
              className="text-muted-foreground/70 underline decoration-dotted underline-offset-4"
            >
              {children}
            </span>
          )
        }
        return (
          <a href={target} target="_blank" rel="noreferrer" {...props}>
            {children}
          </a>
        )
      },
    }),
    [onOpenNote],
  )

  if (loading && !note) {
    return (
      <div className="mx-auto w-full max-w-3xl px-8 py-10">
        <Skeleton className="h-4 w-64" />
        <Skeleton className="mt-6 h-9 w-2/3" />
        <div className="mt-8 grid gap-3">
          {Array.from({ length: 12 }).map((_, i) => (
            <Skeleton key={i} className={cn('h-4', i % 4 === 3 ? 'w-2/3' : 'w-full')} />
          ))}
        </div>
      </div>
    )
  }

  if (!note) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
        <FileTextIcon className="size-6" />
        <p className="text-sm">Pick a note from the sidebar, or press ⌘K to search.</p>
      </div>
    )
  }

  const meta = index.byPath.get(note.path)
  const chips = Object.entries(note.frontmatter || {})
    .filter(([k, v]) => v != null && v !== '' && k !== 'title')
    .slice(0, 10)
  const segments = note.path.split('/')

  return (
    <ScrollArea className="h-full">
      <article className="mx-auto w-full max-w-3xl px-8 py-10">
        <div className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
          {meta?.type && (
            <span
              aria-hidden
              className="mr-1 size-2 rounded-full"
              style={{ background: typeColor(meta.type) }}
            />
          )}
          {segments.map((s, i) => (
            <span key={i} className="flex items-center gap-1.5">
              {i > 0 && <span className="text-muted-foreground/40">/</span>}
              <span className={cn(i === segments.length - 1 && 'text-foreground/80')}>{s}</span>
            </span>
          ))}
        </div>

        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-balance">
          {titleOf(index, note.path)}
        </h1>

        {chips.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-1.5">
            {chips.map(([k, v]) => (
              <Badge
                key={k}
                variant="secondary"
                className="max-w-[22rem] gap-1 font-normal text-muted-foreground"
              >
                <span className="text-foreground/70">{k}</span>
                <span className="truncate">{fmValue(v).slice(0, 120)}</span>
              </Badge>
            ))}
          </div>
        )}

        <div
          className={cn(
            'prose prose-invert prose-zinc mt-8 max-w-none',
            'prose-headings:font-semibold prose-headings:tracking-tight',
            'prose-h1:text-2xl prose-h2:mt-10 prose-h2:border-b prose-h2:border-border prose-h2:pb-2 prose-h2:text-xl',
            'prose-h3:text-base prose-p:text-[15px] prose-li:text-[15px] prose-p:leading-7',
            'prose-a:text-sky-400 prose-a:underline-offset-4 hover:prose-a:text-sky-300',
            'prose-code:rounded prose-code:bg-muted prose-code:px-1.5 prose-code:py-0.5 prose-code:text-[13px] prose-code:font-normal prose-code:before:content-none prose-code:after:content-none',
            'prose-pre:rounded-lg prose-pre:border prose-pre:border-border prose-pre:bg-card prose-pre:text-[13px]',
            'prose-blockquote:border-l-2 prose-blockquote:border-zinc-600 prose-blockquote:font-normal prose-blockquote:not-italic prose-blockquote:text-muted-foreground',
            'prose-hr:border-border prose-th:text-foreground prose-td:border-border prose-th:border-border',
            'prose-img:rounded-lg prose-strong:text-foreground',
          )}
        >
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            urlTransform={(url) => url}
            components={components}
          >
            {body}
          </ReactMarkdown>
        </div>

        <Card className="mt-12">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm text-muted-foreground">
              <CornerUpLeftIcon className="size-4" />
              Backlinks
              {backlinks && (
                <span className="tabular-nums text-muted-foreground/60">{backlinks.length}</span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {backlinks == null ? (
              <div className="flex flex-wrap gap-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-6 w-32" />
                ))}
              </div>
            ) : backlinks.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing links here yet.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {backlinks.map((p) => (
                  <button
                    key={p}
                    onClick={() => onOpenNote(p)}
                    title={p}
                    className="max-w-[18rem] truncate rounded-md border border-border bg-muted/40 px-2.5 py-1 text-xs text-foreground/80 transition-colors hover:border-zinc-600 hover:bg-muted hover:text-foreground"
                  >
                    {titleOf(index, p)}
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </article>
    </ScrollArea>
  )
}
