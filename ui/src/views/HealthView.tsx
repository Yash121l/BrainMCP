import { useCallback, useEffect, useState } from 'react'
import {
  AlertTriangleIcon,
  ClockIcon,
  FileWarningIcon,
  Link2OffIcon,
  RefreshCwIcon,
  StickyNoteIcon,
} from 'lucide-react'

import { api, Unauthorized, type HealthReport } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'

type Status = 'loading' | 'ready' | 'error'

function StatCard({
  icon: Icon,
  label,
  value,
  warn,
}: {
  icon: typeof StickyNoteIcon
  label: string
  value: number
  warn?: boolean
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2 px-5">
        <CardTitle className="text-xs font-medium text-muted-foreground">{label}</CardTitle>
        <Icon className={cn('size-4 text-muted-foreground', warn && value > 0 && 'text-amber-400')} />
      </CardHeader>
      <CardContent className="px-5">
        <span
          className={cn(
            'text-3xl font-semibold tabular-nums',
            warn && value > 0 && 'text-amber-400',
          )}
        >
          {value}
        </span>
      </CardContent>
    </Card>
  )
}

function Row({
  onClick,
  title,
  subtitle,
  trailing,
}: {
  onClick: () => void
  title: string
  subtitle: string
  trailing?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={subtitle}
      className="flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left text-sm transition-colors hover:bg-accent/50"
    >
      <span className="min-w-0 flex-1 truncate text-foreground/90">{title}</span>
      {trailing && (
        <span className="shrink-0 truncate text-xs text-muted-foreground">{trailing}</span>
      )}
    </button>
  )
}

function EmptyRow() {
  return <p className="px-2.5 py-2 text-sm text-muted-foreground">all clean ✓</p>
}

function SectionSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="grid gap-2 px-2.5 py-2">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-5 w-full" />
      ))}
    </div>
  )
}

export function HealthView({
  onOpenNote,
  onUnauthorized,
}: {
  onOpenNote: (path: string) => void
  onUnauthorized: () => void
}) {
  const [report, setReport] = useState<HealthReport | null>(null)
  const [status, setStatus] = useState<Status>('loading')
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    setStatus((s) => (s === 'ready' ? 'ready' : 'loading'))
    api
      .check()
      .then((r) => {
        setReport(r)
        setStatus('ready')
        setError(null)
      })
      .catch((e) => {
        if (e instanceof Unauthorized) {
          onUnauthorized()
          return
        }
        setError(e instanceof Error ? e.message : 'could not load health report')
        setStatus('error')
      })
  }, [onUnauthorized])

  useEffect(load, [load])

  const generated = report ? new Date(report.generated_at).toLocaleString() : null

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto w-full max-w-5xl px-8 py-10">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Health</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              Vault hygiene: unsaved sessions, stale projects, and broken links.
              {generated && <span className="ml-1 text-muted-foreground/60">Generated {generated}.</span>}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={load}
            disabled={status === 'loading'}
          >
            <RefreshCwIcon className={cn(status === 'loading' && 'animate-spin')} />
            Refresh
          </Button>
        </div>

        {status === 'error' ? (
          <Card className="mt-6 border-amber-500/25 bg-amber-500/5">
            <CardContent className="flex items-center gap-3 px-5 py-5">
              <AlertTriangleIcon className="size-5 shrink-0 text-amber-400" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground">Could not load the health report</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{error}</p>
              </div>
              <Button variant="outline" size="sm" onClick={load}>
                Retry
              </Button>
            </CardContent>
          </Card>
        ) : (
          <>
            <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
              {status === 'loading' && !report ? (
                Array.from({ length: 4 }).map((_, i) => (
                  <Card key={i}>
                    <CardHeader className="px-5">
                      <Skeleton className="h-4 w-20" />
                    </CardHeader>
                    <CardContent className="px-5">
                      <Skeleton className="h-8 w-12" />
                    </CardContent>
                  </Card>
                ))
              ) : (
                <>
                  <StatCard icon={StickyNoteIcon} label="Notes" value={report?.counts.notes ?? 0} />
                  <StatCard
                    icon={ClockIcon}
                    label="Sessions (7d)"
                    value={report?.counts.sessions_7d ?? 0}
                  />
                  <StatCard
                    icon={StickyNoteIcon}
                    label="Decisions"
                    value={report?.counts.decisions_total ?? 0}
                  />
                  <StatCard
                    icon={Link2OffIcon}
                    label="Broken links"
                    value={report?.broken_links_total ?? 0}
                    warn
                  />
                </>
              )}
            </div>

            <Card className="mt-6">
              <CardHeader className="flex-row items-center justify-between gap-2 border-b border-border px-5 pb-4">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <FileWarningIcon className="size-4 text-muted-foreground" />
                  Unsaved sessions
                </CardTitle>
                {!!report && report.unsaved_total > 0 && (
                  <Badge variant="outline" className="text-muted-foreground">
                    {report.unsaved_total}
                  </Badge>
                )}
              </CardHeader>
              <CardContent className="px-2.5 pt-3">
                {status === 'loading' && !report ? (
                  <SectionSkeleton />
                ) : report && report.unsaved_sessions.length > 0 ? (
                  <div className="grid">
                    {report.unsaved_sessions.map((s) => (
                      <Row
                        key={s.path}
                        onClick={() => onOpenNote(s.path)}
                        title={`${s.date} · ${s.project}`}
                        subtitle={s.path}
                        trailing={s.path}
                      />
                    ))}
                  </div>
                ) : (
                  <EmptyRow />
                )}
              </CardContent>
            </Card>

            <Card className="mt-6">
              <CardHeader className="flex-row items-center justify-between gap-2 border-b border-border px-5 pb-4">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <ClockIcon className="size-4 text-muted-foreground" />
                  Stale active projects
                </CardTitle>
                {!!report && report.stale_active_projects.length > 0 && (
                  <Badge variant="outline" className="text-muted-foreground">
                    {report.stale_active_projects.length}
                  </Badge>
                )}
              </CardHeader>
              <CardContent className="px-2.5 pt-3">
                {status === 'loading' && !report ? (
                  <SectionSkeleton />
                ) : report && report.stale_active_projects.length > 0 ? (
                  <div className="grid">
                    {report.stale_active_projects.map((p) => (
                      <Row
                        key={p.path}
                        onClick={() => onOpenNote(p.path)}
                        title={p.project}
                        subtitle={p.path}
                        trailing={`updated ${p.updated}`}
                      />
                    ))}
                  </div>
                ) : (
                  <EmptyRow />
                )}
              </CardContent>
            </Card>

            <Card className="mt-6">
              <CardHeader className="flex-row items-center justify-between gap-2 border-b border-border px-5 pb-4">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Link2OffIcon className="size-4 text-muted-foreground" />
                  Broken links
                </CardTitle>
                {!!report && report.broken_links_total > 0 && (
                  <Badge variant="outline" className="text-muted-foreground">
                    {report.broken_links.length < report.broken_links_total
                      ? `showing ${report.broken_links.length} of ${report.broken_links_total}`
                      : report.broken_links_total}
                  </Badge>
                )}
              </CardHeader>
              <CardContent className="px-2.5 pt-3">
                {status === 'loading' && !report ? (
                  <SectionSkeleton />
                ) : report && report.broken_links.length > 0 ? (
                  <div className="grid">
                    {report.broken_links.map((l, i) => (
                      <Row
                        key={`${l.src}->${l.dst}-${i}`}
                        onClick={() => onOpenNote(l.src)}
                        title={`${l.src} → ${l.dst}`}
                        subtitle={`${l.src} → ${l.dst}`}
                      />
                    ))}
                  </div>
                ) : (
                  <EmptyRow />
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </ScrollArea>
  )
}
