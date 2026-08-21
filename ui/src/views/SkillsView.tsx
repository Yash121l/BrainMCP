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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

type Status = 'loading' | 'ready' | 'error'
type Row = SkillEntryInput

const SLUG = /^[a-z0-9-]+$/
const DEFAULT_ROW = 'default'

const MUST_HINT = 'must-load — the full skill body is injected into every session'
const LAZY_HINT = 'on demand — only the name is listed; the agent fetches the body if it needs it'

function toRows(config: SkillsConfig): Row[] {
  return config.entries.map((entry) => ({
    project: entry.project,
    inherits_default:
      entry.project !== DEFAULT_ROW && config.inherits_default.includes(entry.project),
    skills: entry.skills.map((s) => ({ name: s.name, must: s.must })),
  }))
}

const fingerprint = (rows: Row[]) => JSON.stringify(rows)

function SkillChip({
  skill,
  description,
  editable,
  onToggle,
  onRemove,
}: {
  skill: SkillRef
  description: string | null
  editable: boolean
  onToggle: () => void
  onRemove: () => void
}) {
  const hint = skill.must ? MUST_HINT : LAZY_HINT
  return (
    <Badge
      variant={skill.must ? 'default' : 'outline'}
      className={cn('gap-1 py-1 pl-2', editable ? 'pr-1' : 'pr-2')}
    >
      <button
        type="button"
        onClick={onToggle}
        disabled={!editable}
        aria-pressed={skill.must}
        title={description ? `${description}\n${hint}` : hint}
        className="inline-flex items-center gap-1 rounded-full outline-none disabled:cursor-default"
      >
        {skill.must ? (
          <ZapIcon className="size-3" />
        ) : (
          <ZapOffIcon className="size-3 opacity-60" />
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
          <XIcon className="size-3" />
        </button>
      )}
    </Badge>
  )
}

function EntryCard({
  row,
  catalog,
  editable,
  onPatch,
  onRemoveRow,
}: {
  row: Row
  catalog: CatalogSkill[]
  editable: boolean
  onPatch: (patch: Partial<Row>) => void
  onRemoveRow: () => void
}) {
  const isDefault = row.project === DEFAULT_ROW
  const mustCount = row.skills.filter((s) => s.must).length
  const taken = new Set(row.skills.map((s) => s.name))
  const available = catalog.filter((s) => !taken.has(s.name))
  const describe = (name: string) => catalog.find((s) => s.name === name)?.description ?? null

  return (
    <Card className="mt-6 gap-0">
      <CardHeader className="flex-row items-start justify-between gap-4 border-b border-border px-5 pb-4">
        <div className="min-w-0">
          <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-mono">{row.project}</span>
            {isDefault && (
              <Badge variant="secondary" className="text-[10px]">
                applies to every session
              </Badge>
            )}
          </CardTitle>
          <CardDescription className="mt-1.5 text-xs">
            {isDefault
              ? 'Loaded for every session, whichever project it belongs to.'
              : row.inherits_default
                ? 'Extends the default set — these skills load on top of it.'
                : 'Replaces the default set for this project.'}
          </CardDescription>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-xs tabular-nums text-muted-foreground">
            {row.skills.length} {row.skills.length === 1 ? 'skill' : 'skills'} · {mustCount}{' '}
            must-load
          </span>
          {editable && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onRemoveRow}
              aria-label={`Remove the ${row.project} row`}
              title={`Remove the ${row.project} row`}
              className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash2Icon />
            </Button>
          )}
        </div>
      </CardHeader>

      <CardContent className="px-5 pt-4">
        {!isDefault && (
          <Label className="mb-3 w-fit text-xs font-normal text-muted-foreground">
            <Checkbox
              checked={row.inherits_default}
              disabled={!editable}
              onCheckedChange={(v) => onPatch({ inherits_default: v === true })}
            />
            Extends the default set (uncheck to replace it)
          </Label>
        )}

        {row.skills.length === 0 ? (
          <p className="text-sm text-muted-foreground">No skills in this row.</p>
        ) : (
          <div className="flex flex-wrap items-center gap-1.5">
            {row.skills.map((skill, i) => (
              <SkillChip
                key={skill.name}
                skill={skill}
                description={describe(skill.name)}
                editable={editable}
                onToggle={() =>
                  onPatch({
                    skills: row.skills.map((s, j) => (i === j ? { ...s, must: !s.must } : s)),
                  })
                }
                onRemove={() => onPatch({ skills: row.skills.filter((_, j) => i !== j) })}
              />
            ))}
          </div>
        )}

        {editable && (
          <div className="mt-4">
            <Select
              value=""
              disabled={available.length === 0}
              onValueChange={(name) =>
                onPatch({ skills: [...row.skills, { name, must: false }] })
              }
            >
              <SelectTrigger size="sm" className="w-[18rem]" aria-label="Add a skill">
                <SelectValue
                  placeholder={available.length === 0 ? 'Every skill added' : 'Add a skill…'}
                />
              </SelectTrigger>
              <SelectContent>
                {available.map((s) => (
                  <SelectItem key={s.name} value={s.name}>
                    <span className="font-mono text-xs">{s.name}</span>
                    <span className="truncate text-xs text-muted-foreground">{s.description}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </CardContent>
    </Card>
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
  const [slug, setSlug] = useState('')

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
  const dirty = status === 'ready' && fingerprint(rows) !== baseline

  const patchRow = useCallback((index: number, patch: Partial<Row>) => {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)))
  }, [])

  const slugTaken = rows.some((r) => r.project === slug)
  const slugValid = SLUG.test(slug) && !slugTaken

  function addRow(e: React.FormEvent) {
    e.preventDefault()
    if (!slugValid) return
    setRows((prev) => [...prev, { project: slug, inherits_default: true, skills: [] }])
    setSlug('')
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

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto w-full max-w-5xl px-8 py-10">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Skills</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              Which skills are always on, per project. The <code className="font-mono">default</code>{' '}
              row applies to every session; a project row either extends it or replaces it.
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
            <Badge className="gap-1 py-0.5">
              <ZapIcon className="size-3" />
              must-load
            </Badge>
            full body injected into every session
          </span>
          <span className="flex items-center gap-2">
            <Badge variant="outline" className="gap-1 py-0.5">
              <ZapOffIcon className="size-3 opacity-60" />
              on demand
            </Badge>
            name only, fetched when needed
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
          <div className="grid">
            {Array.from({ length: 2 }).map((_, i) => (
              <Card key={i} className="mt-6 gap-0">
                <CardHeader className="border-b border-border px-5 pb-4">
                  <Skeleton className="h-4 w-32" />
                </CardHeader>
                <CardContent className="px-5 pt-4">
                  <Skeleton className="h-6 w-72" />
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <>
            {rows.length === 0 && (
              <Card className="mt-6">
                <CardContent className="px-5 text-sm text-muted-foreground">
                  No skill mappings yet.
                </CardContent>
              </Card>
            )}

            {rows.map((row, i) => (
              <EntryCard
                key={row.project}
                row={row}
                catalog={catalog}
                editable={editable}
                onPatch={(patch) => patchRow(i, patch)}
                onRemoveRow={() => setRows((prev) => prev.filter((_, j) => j !== i))}
              />
            ))}

            {editable && (
              <Card className="mt-6 border-dashed">
                <CardContent className="px-5">
                  <form onSubmit={addRow} className="flex flex-wrap items-center gap-2">
                    <Label htmlFor="s-project" className="text-xs font-normal text-muted-foreground">
                      New project row
                    </Label>
                    <Input
                      id="s-project"
                      value={slug}
                      onChange={(e) => setSlug(e.target.value)}
                      placeholder="project-slug"
                      className="h-8 w-[16rem] font-mono text-xs"
                    />
                    <Button type="submit" size="sm" variant="outline" disabled={!slugValid}>
                      <PlusIcon />
                      Add project
                    </Button>
                    {slug !== '' && !SLUG.test(slug) && (
                      <span className="text-xs text-destructive">
                        lowercase letters, digits and hyphens only
                      </span>
                    )}
                    {slugTaken && (
                      <span className="text-xs text-destructive">
                        that project already has a row
                      </span>
                    )}
                  </form>
                </CardContent>
              </Card>
            )}
          </>
        )}
      </div>
    </ScrollArea>
  )
}
