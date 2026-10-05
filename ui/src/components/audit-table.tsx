import { Loader2Icon } from 'lucide-react'

import { cn } from '@/lib/utils'
import { stamp, type AuditEvent } from '@/lib/people'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

const CROSSED = /^(super|share)\./

export function AuditTable({
  events,
  onMore,
  loadingMore = false,
  empty = 'Nothing recorded yet.',
}: {
  events: AuditEvent[] | null
  onMore?: () => void
  loadingMore?: boolean
  empty?: string
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>When (UTC)</TableHead>
            <TableHead>Who</TableHead>
            <TableHead>Action</TableHead>
            <TableHead>Space</TableHead>
            <TableHead>Target</TableHead>
            <TableHead>About</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {events == null
            ? Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  {Array.from({ length: 6 }).map((__, j) => (
                    <TableCell key={j}>
                      <Skeleton className="h-4 w-full" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            : events.map((e) => (
                <TableRow key={e.id} className={cn(CROSSED.test(e.action) && 'bg-violet-500/5')}>
                  <TableCell className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                    {stamp(e.ts)}
                  </TableCell>
                  <TableCell className="text-xs">
                    {e.actor ? `@${e.actor}` : <span className="text-muted-foreground">{e.via ?? '—'}</span>}
                  </TableCell>
                  <TableCell className="text-xs whitespace-nowrap">
                    <span className="font-mono">{e.action}</span>
                    {e.outcome !== 'ok' && (
                      <Badge variant="outline" className="ml-1.5 border-rose-500/30 text-[10px] text-rose-300">
                        {e.outcome}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{e.space ? `@${e.space}` : '—'}</TableCell>
                  <TableCell
                    className="max-w-[18rem] truncate font-mono text-[11px] text-muted-foreground"
                    title={[e.target, e.detail].filter(Boolean).join('\n')}
                  >
                    {e.target ?? e.detail ?? '—'}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{e.subject ? `@${e.subject}` : '—'}</TableCell>
                </TableRow>
              ))}
          {events?.length === 0 && (
            <TableRow>
              <TableCell colSpan={6} className="py-10 text-center text-sm text-muted-foreground">
                {empty}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      {onMore && events && events.length > 0 && (
        <div className="flex justify-center border-t border-border p-2">
          <Button variant="ghost" size="sm" onClick={onMore} disabled={loadingMore}>
            {loadingMore && <Loader2Icon className="animate-spin" />}
            Older events
          </Button>
        </div>
      )}
    </div>
  )
}

