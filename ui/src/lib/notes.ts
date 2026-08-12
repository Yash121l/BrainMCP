import type { NoteMeta } from './api'

export type NoteIndex = {
  notes: NoteMeta[]
  byPath: Map<string, NoteMeta>
  byNoExt: Map<string, string>
  byBase: Map<string, string>
}

export function buildIndex(notes: NoteMeta[]): NoteIndex {
  const byPath = new Map<string, NoteMeta>()
  const byNoExt = new Map<string, string>()
  const byBase = new Map<string, string>()
  for (const n of notes) {
    byPath.set(n.path, n)
    const noExt = n.path.replace(/\.md$/, '')
    byNoExt.set(noExt, n.path)
    const base = noExt.split('/').pop() as string
    if (!byBase.has(base)) byBase.set(base, n.path)
  }
  return { notes, byPath, byNoExt, byBase }
}

/** Resolve a [[wikilink]] target to a real note path: full path, then vault/ prefix, then basename. */
export function resolveLink(index: NoteIndex, target: string): string | null {
  const t = target.trim()
  if (!t) return null
  return (
    index.byNoExt.get(t) ??
    index.byNoExt.get(`vault/${t}`) ??
    index.byBase.get(t.split('/').pop() as string) ??
    null
  )
}

export function titleOf(index: NoteIndex, path: string): string {
  return index.byPath.get(path)?.title || (path.split('/').pop() as string).replace(/\.md$/, '')
}

export function dirOf(path: string): string {
  const d = path.split('/').slice(0, -1).join('/')
  return d || '(root)'
}

/** Node/type colors — muted jewel tones that sit well on zinc-950. */
export const TYPE_COLORS: Record<string, string> = {
  project: '#a78bfa',
  topic: '#60a5fa',
  session: '#71717a',
  rules: '#f87171',
  reference: '#34d399',
  'decision-log': '#fbbf24',
  plan: '#e879f9',
  index: '#fde68a',
  activity: '#94a3b8',
  note: '#a1a1aa',
}

export const typeColor = (t?: string | null) => TYPE_COLORS[t || 'note'] ?? TYPE_COLORS.note
