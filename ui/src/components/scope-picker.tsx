import { useMemo, useState } from 'react'
import { FolderIcon, HashIcon, SearchIcon } from 'lucide-react'

import type { Scopes } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Textarea } from '@/components/ui/textarea'

const projectSlug = (scope: string) =>
  /^project:([A-Za-z0-9._-]+)$/.exec(scope)?.[1] ?? null

/** How a scope reads in a table: `project:pulse` → "pulse", a path stays a path. */
export function ScopeChip({ scope }: { scope: string }) {
  const slug = projectSlug(scope)
  return (
    <Badge
      variant="outline"
      className={cn(
        'gap-1 font-mono text-[11px] font-normal',
        slug ? 'border-sky-500/25 bg-sky-500/10 text-sky-300' : 'text-muted-foreground',
      )}
    >
      {slug ? <HashIcon className="size-3" /> : <FolderIcon className="size-3" />}
      {slug ?? scope}
    </Badge>
  )
}

function Toggle({
  active,
  onClick,
  title,
  hint,
}: {
  active: boolean
  onClick: () => void
  title: string
  hint: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'rounded-lg border p-3 text-left transition-colors',
        active
          ? 'border-primary/40 bg-primary/10'
          : 'border-border hover:border-border/80 hover:bg-muted/40',
      )}
    >
      <div className="text-sm font-medium">{title}</div>
      <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>
    </button>
  )
}

/**
 * Picks scopes out of the live brain — projects and folders that exist, with note
 * counts — instead of asking for hand-typed path prefixes. `null` is the whole brain;
 * an empty array means the pick list is open but still empty, which callers reject.
 */
export function ScopePicker({
  scopes,
  onChange,
  data,
  role,
}: {
  scopes: string[] | null
  onChange: (next: string[] | null) => void
  data: Scopes | null
  role: string
}) {
  const [query, setQuery] = useState('')

  const areaSet = useMemo(() => new Set((data?.areas ?? []).map((a) => a.prefix)), [data])
  const picked = useMemo(() => {
    const projects = new Set<string>()
    const areas = new Set<string>()
    const custom: string[] = []
    for (const s of scopes ?? []) {
      const slug = projectSlug(s)
      if (slug) projects.add(slug)
      else if (areaSet.has(s)) areas.add(s)
      else custom.push(s)
    }
    return { projects, areas, custom }
  }, [scopes, areaSet])

  const everything = scopes === null
  const replace = (projects: Set<string>, areas: Set<string>, custom: string[]) =>
    onChange([...[...projects].map((s) => `project:${s}`), ...areas, ...custom])

  const toggleProject = (slug: string) => {
    const next = new Set(picked.projects)
    if (!next.delete(slug)) next.add(slug)
    replace(next, picked.areas, picked.custom)
  }
  const toggleArea = (prefix: string) => {
    const next = new Set(picked.areas)
    if (!next.delete(prefix)) next.add(prefix)
    replace(picked.projects, next, picked.custom)
  }

  const projects = (data?.projects ?? []).filter((p) => {
    const q = query.trim().toLowerCase()
    return !q || p.slug.toLowerCase().includes(q) || p.title.toLowerCase().includes(q)
  })

  const reach = everything
    ? data?.total_notes ?? null
    : (data?.projects ?? [])
        .filter((p) => picked.projects.has(p.slug))
        .reduce((n, p) => n + p.notes, 0) +
      (data?.areas ?? []).filter((a) => picked.areas.has(a.prefix)).reduce((n, a) => n + a.notes, 0)

  return (
    <div className="grid gap-3">
      <div className="grid grid-cols-2 gap-2">
        <Toggle
          active={everything}
          onClick={() => onChange(null)}
          title="Whole brain"
          hint="every note, now and later"
        />
        <Toggle
          active={!everything}
          onClick={() => onChange(scopes ?? [])}
          title="Only what I pick"
          hint="projects and folders below"
        />
      </div>

      {!everything && (
        <div className="grid gap-3 rounded-lg border border-border p-3">
          <div className="grid gap-2">
            <div className="flex items-center justify-between gap-2">
              <Label>Projects</Label>
              <div className="relative">
                <SearchIcon className="pointer-events-none absolute top-2 left-2 size-3.5 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="filter"
                  className="h-7 w-40 pl-7 text-xs"
                />
              </div>
            </div>
            <ScrollArea className="h-44 rounded-md border border-border">
              <div className="grid gap-px p-1">
                {projects.map((p) => {
                  const on = picked.projects.has(p.slug)
                  return (
                    <button
                      key={p.slug}
                      type="button"
                      onClick={() => toggleProject(p.slug)}
                      className={cn(
                        'flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors',
                        on ? 'bg-primary/10' : 'hover:bg-muted/50',
                      )}
                    >
                      <Checkbox checked={on} tabIndex={-1} className="pointer-events-none" />
                      <span className="min-w-0 flex-1 truncate">{p.title}</span>
                      {p.status === 'active' && (
                        <span className="text-[10px] text-emerald-400/80">active</span>
                      )}
                      <span className="tabular-nums text-[10px] text-muted-foreground">
                        {p.notes}
                      </span>
                    </button>
                  )
                })}
                {projects.length === 0 && (
                  <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                    {data ? 'no project matches that' : 'loading projects…'}
                  </p>
                )}
              </div>
            </ScrollArea>
            <p className="text-xs text-muted-foreground">
              A project scope follows the project: its note plus every note filed under it,
              including ones written after the key was issued.
            </p>
          </div>

          <div className="grid gap-2">
            <Label>Folders</Label>
            <div className="flex flex-wrap gap-1.5">
              {(data?.areas ?? []).map((a) => {
                const on = picked.areas.has(a.prefix)
                return (
                  <button
                    key={a.prefix}
                    type="button"
                    onClick={() => toggleArea(a.prefix)}
                    className={cn(
                      'rounded-md border px-2 py-1 font-mono text-[11px] transition-colors',
                      on
                        ? 'border-primary/40 bg-primary/10 text-foreground'
                        : 'border-border text-muted-foreground hover:bg-muted/50',
                    )}
                  >
                    {a.prefix}
                    <span className="ml-1.5 tabular-nums opacity-60">{a.notes}</span>
                  </button>
                )
              })}
            </div>
          </div>

          <details className="group">
            <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
              Exact paths ({picked.custom.length})
            </summary>
            <Textarea
              rows={2}
              className="mt-2 font-mono text-xs"
              placeholder="vault/firm/people.md, skills/unslop/"
              value={picked.custom.join(', ')}
              onChange={(e) =>
                replace(
                  picked.projects,
                  picked.areas,
                  e.target.value
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean),
                )
              }
            />
          </details>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        {everything ? (
          <>Sees all {reach ?? '—'} notes.</>
        ) : scopes!.length === 0 ? (
          <span className="text-amber-300">Pick at least one project or folder.</span>
        ) : (
          <>
            Sees about {reach} notes across {scopes!.length} scope
            {scopes!.length === 1 ? '' : 's'}.
          </>
        )}
        {!everything && role !== 'read' && (
          <>
            {' '}
            New files land in shared folders, so a writer also needs the folder it writes to
            (<code className="font-mono">vault/logs/</code> for sessions and decisions).
          </>
        )}
      </p>
    </div>
  )
}
