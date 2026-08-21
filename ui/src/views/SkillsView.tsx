import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangleIcon,
  Loader2Icon,
  LockIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
  XIcon,
  ZapIcon,
  ZapOffIcon,
} from 'lucide-react'
import { toast } from 'sonner'

import {
  api,
  Unauthorized,
  type CatalogSkill,
  type SkillEntryInput,
  type SkillRef,
  type SkillsConfig,
} from '@/lib/api'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

type Status = 'loading' | 'ready' | 'error'
type Row = SkillEntryInput
type Origin = 'default' | 'row' | 'both'
type Effective = { name: string; must: boolean; origin: Origin }

const SLUG = /^[a-z0-9-]+$/
const DEFAULT_ROW = 'default'
const BYTES_PER_TOKEN = 4

const MUST_HINT = 'must-load: the full body is injected into every session'
const LAZY_HINT = 'on demand: only the name is listed, the agent fetches the body if it needs it'

function toRows(config: SkillsConfig): Row[] {
  return config.entries.map((entry) => ({
    project: entry.project,
    inherits_default:
      entry.project !== DEFAULT_ROW && config.inherits_default.includes(entry.project),
    skills: entry.skills.map((s) => ({ name: s.name, must: s.must })),
  }))
}

const fingerprint = (rows: Row[]) => JSON.stringify(rows)

const defaultFirst = (rows: Row[]) =>
  [...rows].sort((a, b) => (a.project === DEFAULT_ROW ? -1 : b.project === DEFAULT_ROW ? 1 : 0))

function formatBytes(bytes: number | undefined) {
  if (typeof bytes !== 'number') return 'unknown'
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} kB`
}

function resolveEffective(row: Row, defaults: Row | undefined): Effective[] {
  const out: Effective[] = []
  const add = (skill: SkillRef, origin: Exclude<Origin, 'both'>) => {
    const seen = out.find((s) => s.name === skill.name)
    if (seen) {
      seen.must = seen.must || skill.must
      if (seen.origin !== origin) seen.origin = 'both'
      return
    }
    out.push({ name: skill.name, must: skill.must, origin })
  }
  if (row.project !== DEFAULT_ROW && row.inherits_default && defaults) {
    for (const skill of defaults.skills) add(skill, 'default')
  }
  for (const skill of row.skills) add(skill, 'row')
  return out
}

function mustLoadCost(effective: Effective[], sizeOf: (name: string) => number | undefined) {
  let bytes = 0
  let unknown = 0
  let count = 0
  for (const skill of effective) {
    if (!skill.must) continue
    count++
    const size = sizeOf(skill.name)
    if (typeof size === 'number') bytes += size
    else unknown++
  }
  return { bytes, unknown, count }
}

function SkillChip({
  skill,
  bytes,
  description,
  editable,
  onToggle,
  onRemove,
}: {
  skill: SkillRef
  bytes: number | undefined
  description: string
  editable: boolean
  onToggle: () => void
  onRemove: () => void
}) {
  const hint = [description, skill.must ? MUST_HINT : LAZY_HINT, formatBytes(bytes)]
    .filter(Boolean)
    .join('\n')
  return (
    <Badge
      variant={skill.must ? 'default' : 'outline'}
      className={cn('h-6 gap-1 py-0 pl-1.5 text-[11px]', editable ? 'pr-0.5' : 'pr-2')}
    >
      <button
        type="button"
        onClick={onToggle}
        disabled={!editable}
        aria-pressed={skill.must}
        title={hint}
        className="inline-flex items-center gap-1 rounded-full outline-none disabled:cursor-default"
      >
        {skill.must ? (
          <ZapIcon className="size-2.5" />
        ) : (
          <ZapOffIcon className="size-2.5 opacity-60" />
        )}
        <span className="font-mono">{skill.name}</span>
      </button>
      {editable && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${skill.name}`}
          title={`Remove ${skill.name}`}
          className="rounded-full p-0.5 opacity-60 transition-opacity hover:opacity-100"
        >
          <XIcon className="size-2.5" />
        </button>
      )}
    </Badge>
  )
}

function SkillPicker({
  available,
  onPick,
}: {
  available: CatalogSkill[]
  onPick: (name: string) => void
}) {
  const [open, setOpen] = useState(false)
  const empty = available.length === 0
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="xs" disabled={empty} className="border-dashed">
          <PlusIcon />
          {empty ? 'Every skill added' : 'Add skill'}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[24rem] overflow-hidden p-0">
        <Command>
          <CommandInput placeholder="Search skills" className="h-9" />
          <CommandList>
            <CommandEmpty>No skill matches.</CommandEmpty>
            <CommandGroup>
              {available.map((s) => (
                <CommandItem
                  key={s.name}
                  value={`${s.name} ${s.description}`}
                  onSelect={() => {
                    onPick(s.name)
                    setOpen(false)
                  }}
                  className="items-start"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="truncate font-mono text-xs">{s.name}</span>
                      <span className="ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground">
                        {formatBytes(s.bytes)}
                      </span>
                    </div>
                    {s.description && (
                      <p className="truncate text-[11px] text-muted-foreground">{s.description}</p>
                    )}
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function AddProjectButton({ taken, onAdd }: { taken: string[]; onAdd: (slug: string) => void }) {
  const [open, setOpen] = useState(false)
  const [slug, setSlug] = useState('')
  const malformed = slug !== '' && !SLUG.test(slug)
  const duplicate = taken.includes(slug)
  const valid = SLUG.test(slug) && !duplicate

  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v)
        if (!v) setSlug('')
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="outline" size="xs" className="h-7 rounded-full border-dashed">
          <PlusIcon />
          Project
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-3">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (!valid) return
            onAdd(slug)
            setSlug('')
            setOpen(false)
          }}
          className="grid gap-2"
        >
          <Label htmlFor="s-project" className="text-xs font-normal text-muted-foreground">
            New project row
          </Label>
          <Input
            id="s-project"
            autoFocus
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="project-slug"
            className="h-8 font-mono text-xs"
          />
          {malformed && (
            <p className="text-xs text-destructive">lowercase letters, digits and hyphens only</p>
          )}
          {duplicate && <p className="text-xs text-destructive">that project already has a row</p>}
          <Button type="submit" size="sm" disabled={!valid}>
            Add row
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  )
}

function ProjectPill({
  project,
  mustCount,
  active,
  isDefault,
  onSelect,
}: {
  project: string
  mustCount: number
  active: boolean
  isDefault: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      title={`${project}: ${mustCount} must-load ${mustCount === 1 ? 'skill' : 'skills'} per session`}
      className={cn(
        'flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors',
        active
          ? 'border-primary/40 bg-primary/15 text-foreground'
          : 'border-border text-muted-foreground hover:bg-accent/50 hover:text-foreground',
        isDefault && !active && 'text-foreground/80',
      )}
    >
      <span className={cn('font-mono', isDefault && 'font-medium')}>{project}</span>
      <span className="flex items-center gap-0.5 text-[10px] tabular-nums opacity-70">
        <ZapIcon className="size-2.5" />
        {mustCount}
      </span>
    </button>
  )
}

function CostStat({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div
        className={cn(
          'text-lg font-semibold tabular-nums',
          muted ? 'text-muted-foreground' : 'text-foreground',
        )}
      >
        {value}
      </div>
    </div>
  )
}

function EffectiveRow({
  skill,
  bytes,
  description,
}: {
  skill: Effective
  bytes: number | undefined
  description: string
}) {
  return (
    <div
      title={description || undefined}
      className="flex items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-accent/40"
    >
      {skill.must ? (
        <ZapIcon className="size-3 shrink-0 text-primary" />
      ) : (
        <ZapOffIcon className="size-3 shrink-0 text-muted-foreground/60" />
      )}
      <span className={cn('truncate font-mono', !skill.must && 'text-muted-foreground')}>
        {skill.name}
      </span>
      {skill.origin !== 'row' && (
        <Badge
          variant="outline"
          className="h-4 shrink-0 px-1 py-0 text-[10px] font-normal text-muted-foreground"
        >
          {skill.origin === 'both' ? 'inherited, also on this row' : 'inherited'}
        </Badge>
      )}
      <span className="ml-auto shrink-0 tabular-nums text-muted-foreground/70">
        {skill.must ? formatBytes(bytes) : 'name only'}
      </span>
    </div>
  )
}

export function SkillsView({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [config, setConfig] = useState<SkillsConfig | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [baseline, setBaseline] = useState('[]')
  const [status, setStatus] = useState<Status>('loading')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [selected, setSelected] = useState(DEFAULT_ROW)

  const load = useCallback(() => {
    setStatus((s) => (s === 'ready' ? 'ready' : 'loading'))
    api
      .skills()
      .then((c) => {
        const next = toRows(c)
        setConfig(c)
        setRows(next)
        setBaseline(fingerprint(next))
        setResult(null)
        setError(null)
        setStatus('ready')
      })
      .catch((e) => {
        if (e instanceof Unauthorized) {
          onUnauthorized()
          return
        }
        setError(e instanceof Error ? e.message : 'could not load skills')
        setStatus('error')
      })
  }, [onUnauthorized])

  useEffect(load, [load])

  const editable = config?.editable ?? false
  const catalog = useMemo(() => config?.catalog ?? [], [config])
  const byName = useMemo(() => new Map(catalog.map((s) => [s.name, s])), [catalog])
  const sizeOf = useCallback((name: string) => byName.get(name)?.bytes, [byName])
  const describe = useCallback((name: string) => byName.get(name)?.description ?? '', [byName])
  const dirty = status === 'ready' && fingerprint(rows) !== baseline

  const ordered = useMemo(() => defaultFirst(rows), [rows])
  const defaults = useMemo(() => rows.find((r) => r.project === DEFAULT_ROW), [rows])
  const row = ordered.find((r) => r.project === selected) ?? ordered[0] ?? null
  const effective = useMemo(
    () => (row ? resolveEffective(row, defaults) : []),
    [row, defaults],
  )
  const cost = useMemo(() => mustLoadCost(effective, sizeOf), [effective, sizeOf])
  const lazy = effective.filter((s) => !s.must)
  const tokens = Math.round(cost.bytes / BYTES_PER_TOKEN)

  const patchRow = useCallback((project: string, patch: Partial<Row>) => {
    setRows((prev) => prev.map((r) => (r.project === project ? { ...r, ...patch } : r)))
  }, [])

  function addRow(slug: string) {
    setRows((prev) => [...prev, { project: slug, inherits_default: slug !== DEFAULT_ROW, skills: [] }])
    setSelected(slug)
  }

  function removeRow(project: string) {
    setRows((prev) => prev.filter((r) => r.project !== project))
    setSelected(DEFAULT_ROW)
  }

  async function save() {
    if (!dirty || saving) return
    const payload = rows.map((r) => ({
      project: r.project,
      inherits_default: r.project === DEFAULT_ROW ? false : r.inherits_default,
      skills: r.skills,
    }))
    setSaving(true)
    setResult(null)
    try {
      const res = await api.saveSkills(payload)
      setBaseline(fingerprint(rows))
      setResult({ ok: true, message: `Saved as ${res.commit.slice(0, 7)}` })
      toast.success('Skill mappings saved')
    } catch (e) {
      if (e instanceof Unauthorized) {
        onUnauthorized()
        return
      }
      const message = e instanceof Error ? e.message : 'could not save skills'
      setResult({ ok: false, message })
      toast.error(message)
    } finally {
      setSaving(false)
    }
  }

  const isDefaultRow = row?.project === DEFAULT_ROW
  const available = row ? catalog.filter((s) => !row.skills.some((r) => r.name === s.name)) : []

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto w-full max-w-5xl px-8 py-10">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Skills</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              Which skills bind to a session, per project. The{' '}
              <code className="font-mono">default</code> row applies to every session; a project row
              either extends it or replaces it.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="outline" size="sm" onClick={load} disabled={status === 'loading'}>
              <RefreshCwIcon className={cn(status === 'loading' && 'animate-spin')} />
              Refresh
            </Button>
            {editable && (
              <Button size="sm" onClick={save} disabled={!dirty || saving}>
                {saving && <Loader2Icon className="animate-spin" />}
                Save
              </Button>
            )}
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
          <span className="flex items-center gap-2">
            <Badge className="h-5 gap-1 px-1.5 py-0 text-[11px]">
              <ZapIcon className="size-2.5" />
              must-load
            </Badge>
            full body injected into every session
          </span>
          <span className="flex items-center gap-2">
            <Badge variant="outline" className="h-5 gap-1 px-1.5 py-0 text-[11px]">
              <ZapOffIcon className="size-2.5 opacity-60" />
              on demand
            </Badge>
            name only, fetched with get_skill when needed
          </span>
          {editable && <span>Click a skill to flip it.</span>}
        </div>

        {status === 'ready' && !editable && (
          <p className="mt-4 flex items-center gap-2 text-xs text-amber-300/90">
            <LockIcon className="size-3.5 shrink-0" />
            Your key is read-only, so this view cannot be edited.
          </p>
        )}

        {(dirty || result) && (
          <p
            className={cn(
              'mt-4 text-xs',
              result && !result.ok ? 'text-destructive' : 'text-muted-foreground',
            )}
          >
            {dirty ? 'Unsaved changes.' : result?.message}
          </p>
        )}

        {status === 'error' ? (
          <Card className="mt-6 border-amber-500/25 bg-amber-500/5">
            <CardContent className="flex items-center gap-3 px-5 py-5">
              <AlertTriangleIcon className="size-5 shrink-0 text-amber-400" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground">Could not load skills</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{error}</p>
              </div>
              <Button variant="outline" size="sm" onClick={load}>
                Retry
              </Button>
            </CardContent>
          </Card>
        ) : status === 'loading' && !config ? (
          <>
            <div className="mt-6 flex flex-wrap gap-1.5">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-7 w-24 rounded-full" />
              ))}
            </div>
            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              {Array.from({ length: 2 }).map((_, i) => (
                <Card key={i} className="gap-0">
                  <CardHeader className="border-b border-border px-5 pb-4">
                    <Skeleton className="h-4 w-40" />
                  </CardHeader>
                  <CardContent className="grid gap-2 px-5 pt-4">
                    {Array.from({ length: 4 }).map((__, j) => (
                      <Skeleton key={j} className="h-5 w-full" />
                    ))}
                  </CardContent>
                </Card>
              ))}
            </div>
          </>
        ) : !row ? (
          <Card className="mt-6">
            <CardContent className="flex items-center gap-3 px-5 text-sm text-muted-foreground">
              No skill mappings yet.
              {editable && <AddProjectButton taken={[]} onAdd={addRow} />}
            </CardContent>
          </Card>
        ) : (
          <>
            <div className="mt-6 flex flex-wrap items-center gap-1.5">
              {ordered.map((r, i) => (
                <div key={r.project} className="flex items-center gap-1.5">
                  <ProjectPill
                    project={r.project}
                    mustCount={
                      mustLoadCost(resolveEffective(r, defaults), sizeOf).count
                    }
                    active={r.project === row.project}
                    isDefault={r.project === DEFAULT_ROW}
                    onSelect={() => setSelected(r.project)}
                  />
                  {i === 0 && r.project === DEFAULT_ROW && ordered.length > 1 && (
                    <span aria-hidden className="mx-1 h-4 w-px bg-border" />
                  )}
                </div>
              ))}
              {editable && (
                <AddProjectButton taken={rows.map((r) => r.project)} onAdd={addRow} />
              )}
            </div>

            {!defaults && (
              <p className="mt-3 flex items-center gap-2 text-xs text-amber-300/90">
                <AlertTriangleIcon className="size-3.5 shrink-0" />
                There is no default row. Saving fails until one exists.
              </p>
            )}

            <div className="mt-4 grid items-start gap-4 lg:grid-cols-2">
              <Card className="gap-0">
                <CardHeader className="gap-1 border-b border-border px-5 pb-4">
                  <CardTitle className="text-sm">
                    <span className="font-mono">{row.project}</span> row
                  </CardTitle>
                  <CardDescription className="text-xs">
                    {isDefaultRow
                      ? 'Loads in every session, whichever project it belongs to.'
                      : row.inherits_default
                        ? 'Loads on top of the default set.'
                        : 'Replaces the default set for this project.'}
                  </CardDescription>
                  {editable && !isDefaultRow && (
                    <CardAction>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => removeRow(row.project)}
                        aria-label={`Delete the ${row.project} row`}
                        title={`Delete the ${row.project} row`}
                        className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      >
                        <Trash2Icon />
                      </Button>
                    </CardAction>
                  )}
                </CardHeader>

                <CardContent className="px-5 pt-4">
                  {!isDefaultRow && (
                    <Label className="mb-3 w-fit text-xs font-normal text-muted-foreground">
                      <Checkbox
                        checked={row.inherits_default}
                        disabled={!editable}
                        onCheckedChange={(v) =>
                          patchRow(row.project, { inherits_default: v === true })
                        }
                      />
                      Extends the default set (uncheck to replace it)
                    </Label>
                  )}

                  {row.skills.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No skills on this row.</p>
                  ) : (
                    <div className="flex flex-wrap items-center gap-1">
                      {row.skills.map((skill, i) => (
                        <SkillChip
                          key={skill.name}
                          skill={skill}
                          bytes={sizeOf(skill.name)}
                          description={describe(skill.name)}
                          editable={editable}
                          onToggle={() =>
                            patchRow(row.project, {
                              skills: row.skills.map((s, j) =>
                                i === j ? { ...s, must: !s.must } : s,
                              ),
                            })
                          }
                          onRemove={() =>
                            patchRow(row.project, {
                              skills: row.skills.filter((_, j) => i !== j),
                            })
                          }
                        />
                      ))}
                    </div>
                  )}

                  {editable && (
                    <div className="mt-4">
                      <SkillPicker
                        available={available}
                        onPick={(name) =>
                          patchRow(row.project, {
                            skills: [...row.skills, { name, must: false }],
                          })
                        }
                      />
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card className="gap-0">
                <CardHeader className="gap-1 border-b border-border px-5 pb-4">
                  <CardTitle className="text-sm">Effective set for a session</CardTitle>
                  <CardDescription className="text-xs">
                    What a session for <span className="font-mono">{row.project}</span> actually
                    receives.
                  </CardDescription>
                </CardHeader>

                <CardContent className="px-5 pt-4">
                  <div className="flex flex-wrap gap-x-8 gap-y-3">
                    <CostStat label="Must-load skills" value={String(cost.count)} />
                    <CostStat label="Injected bytes" value={formatBytes(cost.bytes)} />
                    <CostStat
                      label="Tokens (estimate)"
                      value={`~${tokens.toLocaleString()}`}
                    />
                    <CostStat label="On demand" value={String(lazy.length)} muted />
                  </div>
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    Token count is bytes divided by 4, an estimate rather than a measurement.
                    {cost.unknown > 0 &&
                      (cost.unknown === 1
                        ? ' One must-load skill is missing from the catalog, so its size is not counted.'
                        : ` ${cost.unknown} must-load skills are missing from the catalog, so their size is not counted.`)}
                  </p>

                  {effective.length === 0 ? (
                    <p className="mt-4 text-xs text-muted-foreground">
                      This project loads no skills.
                    </p>
                  ) : (
                    <div className="mt-4 grid gap-3">
                      {cost.count > 0 && (
                        <div>
                          <div className="px-2 text-[11px] font-medium text-muted-foreground">
                            Injected in full
                          </div>
                          <div className="mt-1 grid">
                            {effective
                              .filter((s) => s.must)
                              .map((s) => (
                                <EffectiveRow
                                  key={s.name}
                                  skill={s}
                                  bytes={sizeOf(s.name)}
                                  description={describe(s.name)}
                                />
                              ))}
                          </div>
                        </div>
                      )}
                      {lazy.length > 0 && (
                        <div>
                          <div className="px-2 text-[11px] font-medium text-muted-foreground">
                            Listed by name
                          </div>
                          <div className="mt-1 grid">
                            {lazy.map((s) => (
                              <EffectiveRow
                                key={s.name}
                                skill={s}
                                bytes={sizeOf(s.name)}
                                description={describe(s.name)}
                              />
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </>
        )}
      </div>
    </ScrollArea>
  )
}
