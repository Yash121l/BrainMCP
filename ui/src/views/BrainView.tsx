import { Suspense, lazy } from 'react'
import { ActivityIcon, FileTextIcon, NetworkIcon, SparklesIcon } from 'lucide-react'

import type { GraphData, Note, NoteMeta } from '@/lib/api'
import type { NoteIndex } from '@/lib/notes'
import { useGuides } from '@/lib/guides'
import { PageIntro } from '@/components/guides'
import { NoteTree } from '@/components/note-tree'
import { SubNav } from '@/components/subnav'
import { ScrollArea } from '@/components/ui/scroll-area'
import { NoteView } from '@/views/NoteView'
import { HealthView } from '@/views/HealthView'
import { SkillsView } from '@/views/SkillsView'

// force-graph + d3 are heavy; only pull them in when the Graph tab is opened.
const GraphView = lazy(() => import('@/views/GraphView').then((m) => ({ default: m.GraphView })))

export type BrainTab = 'notes' | 'graph' | 'skills' | 'health'
export const BRAIN_TABS: BrainTab[] = ['notes', 'graph', 'skills', 'health']

export function BrainView({
  tab,
  onTab,
  notes,
  notesLoading,
  path,
  note,
  noteLoading,
  index,
  backlinks,
  graph,
  graphLoading,
  onOpenNote,
  onUnauthorized,
}: {
  tab: BrainTab
  onTab: (t: BrainTab) => void
  notes: NoteMeta[]
  notesLoading: boolean
  path: string | null
  note: Note | null
  noteLoading: boolean
  index: NoteIndex
  backlinks: string[] | null
  graph: GraphData | null
  graphLoading: boolean
  onOpenNote: (path: string) => void
  onUnauthorized: () => void
}) {
  const guides = useGuides()
  return (
    <div className="flex h-full flex-col">
      <SubNav
        label="Brain"
        value={tab}
        onChange={onTab}
        items={[
          { id: 'notes', label: 'Notes', icon: FileTextIcon },
          { id: 'graph', label: 'Graph', icon: NetworkIcon },
          { id: 'skills', label: 'Skills', icon: SparklesIcon },
          { id: 'health', label: 'Health', icon: ActivityIcon },
        ]}
      />
      {!guides.introHidden('brain') && (
        <div className="shrink-0 px-4 pt-4 lg:px-6">
          <PageIntro page="brain" />
        </div>
      )}
      <div className="min-h-0 flex-1">
        {tab === 'notes' && (
          <div className="flex h-full">
            <aside className="hidden w-64 shrink-0 border-r border-border md:block lg:w-72" aria-label="Notes">
              <ScrollArea className="h-full [&>div>div]:block!">
                <div className="p-1.5 pb-6">
                  <NoteTree notes={notes} loading={notesLoading} current={path} onOpenNote={onOpenNote} />
                </div>
              </ScrollArea>
            </aside>
            <div className="min-w-0 flex-1">
              <NoteView note={note} loading={noteLoading} index={index} backlinks={backlinks} onOpenNote={onOpenNote} />
            </div>
          </div>
        )}
        {tab === 'graph' && (
          <Suspense fallback={<div className="grid h-full place-items-center text-sm text-muted-foreground">Loading graph…</div>}>
            <GraphView data={graph} loading={graphLoading} onOpenNote={onOpenNote} />
          </Suspense>
        )}
        {tab === 'skills' && <SkillsView onUnauthorized={onUnauthorized} />}
        {tab === 'health' && <HealthView onOpenNote={onOpenNote} onUnauthorized={onUnauthorized} />}
      </div>
    </div>
  )
}
