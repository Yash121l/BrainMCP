import { useEffect, useMemo, useRef } from 'react'

import ForceGraph from 'force-graph'
import type { GraphData } from '@/lib/api'
import { TYPE_COLORS, typeColor } from '@/lib/notes'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'

const BG = '#09090b' // zinc-950, matches --background
const DIM_NODE = '#27272a'
const DIM_LINK = 'rgba(255,255,255,0.05)'
const LINK = 'rgba(255,255,255,0.10)'
const LINK_HOT = 'rgba(167,139,250,0.85)'

type FGNode = { id: string; title: string; type: string; x?: number; y?: number }

// force-graph renders a string label as HTML; note titles and types are user content.
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

export function GraphView({
  data,
  loading,
  onOpenNote,
}: {
  data: GraphData | null
  loading: boolean
  onOpenNote: (path: string) => void
}) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const graphRef = useRef<ForceGraph<FGNode> | null>(null)
  const hoverRef = useRef<string | null>(null)
  const onOpen = useRef(onOpenNote)
  onOpen.current = onOpenNote

  const { degree, adjacency, types } = useMemo(() => {
    const degree = new Map<string, number>()
    const adjacency = new Map<string, Set<string>>()
    for (const l of data?.links ?? []) {
      degree.set(l.source, (degree.get(l.source) ?? 0) + 1)
      degree.set(l.target, (degree.get(l.target) ?? 0) + 1)
      if (!adjacency.has(l.source)) adjacency.set(l.source, new Set())
      if (!adjacency.has(l.target)) adjacency.set(l.target, new Set())
      adjacency.get(l.source)!.add(l.target)
      adjacency.get(l.target)!.add(l.source)
    }
    const types = [...new Set((data?.nodes ?? []).map((n) => n.type || 'note'))].sort(
      (a, b) => (TYPE_COLORS[a] ? 0 : 1) - (TYPE_COLORS[b] ? 0 : 1) || a.localeCompare(b),
    )
    return { degree, adjacency, types }
  }, [data])

  useEffect(() => {
    const host = hostRef.current
    if (!host || !data) return

    const near = (id: string) => {
      const h = hoverRef.current
      if (!h) return true
      return id === h || (adjacency.get(h)?.has(id) ?? false)
    }
    const hot = (l: { source?: unknown; target?: unknown }) => {
      const h = hoverRef.current
      if (!h) return false
      const s = typeof l.source === 'object' ? (l.source as FGNode).id : (l.source as string)
      const t = typeof l.target === 'object' ? (l.target as FGNode).id : (l.target as string)
      return s === h || t === h
    }

    const g = new ForceGraph<FGNode>(host)
      .graphData({ nodes: [...data.nodes], links: data.links.map((l) => ({ ...l })) })
      .nodeId('id')
      .backgroundColor(BG)
      // hover highlighting reads external state, so the canvas must keep redrawing
      .autoPauseRedraw(false)
      .nodeRelSize(4)
      .nodeLabel((n) => escapeHtml(`${n.title || n.id}  ·  ${n.type}`))
      .nodeVal((n) => 1 + Math.sqrt(degree.get(n.id) ?? 0) * 1.6)
      .nodeColor((n) => (near(n.id) ? typeColor(n.type) : DIM_NODE))
      .linkColor((l) => (hoverRef.current ? (hot(l) ? LINK_HOT : DIM_LINK) : LINK))
      .linkWidth((l) => (hoverRef.current && hot(l) ? 1.8 : 0.6))
      .nodeCanvasObjectMode(() => 'after')
      .nodeCanvasObject((n, ctx, scale) => {
        const deg = degree.get(n.id) ?? 0
        const h = hoverRef.current
        const focused = h != null && near(n.id)
        if (!focused && (scale < 1.6 || deg < 6)) return
        const label = n.title || n.id.split('/').pop() || n.id
        const size = Math.max(10 / scale, 2.5)
        ctx.font = `${size}px Inter, ui-sans-serif, system-ui, sans-serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'
        ctx.fillStyle = focused ? 'rgba(250,250,250,0.95)' : 'rgba(228,228,231,0.55)'
        const r = Math.sqrt(1 + Math.sqrt(deg) * 1.6) * 4
        ctx.fillText(label, n.x ?? 0, (n.y ?? 0) + r + 1.5)
      })
      .onNodeHover((n) => {
        hoverRef.current = n?.id ?? null
        host.style.cursor = n ? 'pointer' : 'default'
      })
      .onNodeClick((n) => onOpen.current(n.id))
      .onBackgroundClick(() => {
        hoverRef.current = null
      })

    g.d3Force('charge')?.strength(-42)
    graphRef.current = g

    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      if (width && height) g.width(width).height(height)
    })
    ro.observe(host)
    g.width(host.clientWidth).height(host.clientHeight)

    return () => {
      ro.disconnect()
      g._destructor()
      graphRef.current = null
      host.replaceChildren()
    }
  }, [data, degree, adjacency])

  return (
    <div className="relative h-full w-full">
      <div ref={hostRef} className="absolute inset-0" />
      {loading && !data && (
        <div className="absolute inset-0 grid place-items-center">
          <Skeleton className="size-64 rounded-full" />
        </div>
      )}
      {data && (
        <>
          <div className="pointer-events-none absolute top-4 right-4 rounded-lg border border-border bg-card/80 p-3 backdrop-blur">
            <p className="mb-2 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
              Types
            </p>
            <div className="flex max-w-[13rem] flex-wrap gap-1.5">
              {types.map((t) => (
                <Badge
                  key={t}
                  variant="outline"
                  className="gap-1.5 border-border bg-transparent font-normal text-muted-foreground"
                >
                  <span
                    aria-hidden
                    className="size-1.5 rounded-full"
                    style={{ background: typeColor(t) }}
                  />
                  {t}
                </Badge>
              ))}
            </div>
          </div>
          <div className="pointer-events-none absolute bottom-4 left-4 text-xs text-muted-foreground">
            {data.nodes.length.toLocaleString()} notes · {data.links.length.toLocaleString()} links
            <span className="ml-2 text-muted-foreground/60">
              hover to focus · click to open
            </span>
          </div>
        </>
      )}
    </div>
  )
}
