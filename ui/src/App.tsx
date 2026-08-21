import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'

import {
  api,
  Unauthorized,
  type GraphData,
  type Me,
  type Note,
  type NoteMeta,
} from '@/lib/api'
import { buildIndex } from '@/lib/notes'
import { Sidebar, type Tab } from '@/components/sidebar'
import { CommandPalette } from '@/components/command-palette'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Login } from '@/views/Login'
import { NoteView } from '@/views/NoteView'
import { HealthView } from '@/views/HealthView'
import { KeysView } from '@/views/KeysView'
import { SkillsView } from '@/views/SkillsView'

// force-graph + d3 are heavy; only pull them in when the Graph tab is opened.
const GraphView = lazy(() => import('@/views/GraphView').then((m) => ({ default: m.GraphView })))

type Auth = 'checking' | 'in' | 'out'

export default function App() {
  const [auth, setAuth] = useState<Auth>('checking')
  const [me, setMe] = useState<Me | null>(null)
  const [notes, setNotes] = useState<NoteMeta[]>([])
  const [notesLoading, setNotesLoading] = useState(true)

  const [tab, setTab] = useState<Tab>('notes')
  const [path, setPath] = useState<string | null>(null)
  const [note, setNote] = useState<Note | null>(null)
  const [noteLoading, setNoteLoading] = useState(false)
  const [backlinks, setBacklinks] = useState<string[] | null>(null)

  const [graph, setGraph] = useState<GraphData | null>(null)
  const [graphLoading, setGraphLoading] = useState(false)

  const [paletteOpen, setPaletteOpen] = useState(false)

  const index = useMemo(() => buildIndex(notes), [notes])

  const signedOut = useCallback(() => {
    setAuth('out')
    setMe(null)
  }, [])

  const fail = useCallback(
    (e: unknown, msg: string) => {
      if (e instanceof Unauthorized) signedOut()
      else toast.error(e instanceof Error ? e.message : msg)
    },
    [signedOut],
  )

  // session + note list
  useEffect(() => {
    let alive = true
    api
      .me()
      .then((m) => {
        if (!alive) return
        setMe(m)
        setAuth('in')
        return api.notes().then((list) => {
          if (!alive) return
          setNotes(list)
          setNotesLoading(false)
          const start = list.find((n) => n.path === 'vault/BRAIN.md') ?? list[0]
          if (start) setPath(start.path)
        })
      })
      .catch((e) => {
        if (!alive) return
        if (e instanceof Unauthorized) setAuth('out')
        else {
          setAuth('out')
          toast.error(e instanceof Error ? e.message : 'could not reach the brain')
        }
      })
    return () => {
      alive = false
    }
  }, [])

  // current note + its backlinks
  useEffect(() => {
    if (!path || auth !== 'in') return
    let alive = true
    setNoteLoading(true)
    setBacklinks(null)
    api
      .note(path)
      .then((n) => {
        if (!alive) return
        setNote(n)
        setNoteLoading(false)
      })
      .catch((e) => {
        if (!alive) return
        setNoteLoading(false)
        fail(e, 'could not open note')
      })
    api
      .backlinks(path)
      .then((b) => alive && setBacklinks(b))
      .catch(() => alive && setBacklinks([]))
    return () => {
      alive = false
    }
  }, [path, auth, fail])

  // graph data, loaded the first time the tab is opened
  useEffect(() => {
    if (tab !== 'graph' || graph || graphLoading || auth !== 'in') return
    setGraphLoading(true)
    api
      .graph()
      .then(setGraph)
      .catch((e) => fail(e, 'could not load the graph'))
      .finally(() => setGraphLoading(false))
  }, [tab, graph, graphLoading, auth, fail])

  // ⌘K / Ctrl-K
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setPaletteOpen((v) => !v)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const openNote = useCallback((p: string) => {
    setTab('notes')
    setPath(p)
  }, [])

  if (auth === 'checking') {
    return (
      <div className="grid min-h-svh place-items-center">
        <span className="animate-pulse text-2xl" aria-hidden>
          🧠
        </span>
      </div>
    )
  }

  if (auth === 'out') {
    return (
      <>
        <Login />
        <Toaster position="top-center" />
      </>
    )
  }

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex h-svh overflow-hidden bg-background">
        <Sidebar
          me={me}
          notes={notes}
          loading={notesLoading}
          tab={tab}
          onTab={setTab}
          current={path}
          onOpenNote={openNote}
          onSearch={() => setPaletteOpen(true)}
        />
        <main className="min-w-0 flex-1">
          {tab === 'notes' && (
            <NoteView
              note={note}
              loading={noteLoading}
              index={index}
              backlinks={backlinks}
              onOpenNote={openNote}
            />
          )}
          {tab === 'graph' && (
            <Suspense
              fallback={
                <div className="grid h-full place-items-center text-sm text-muted-foreground">
                  loading graph…
                </div>
              }
            >
              <GraphView data={graph} loading={graphLoading} onOpenNote={openNote} />
            </Suspense>
          )}
          {tab === 'health' && <HealthView onOpenNote={openNote} onUnauthorized={signedOut} />}
          {tab === 'skills' && <SkillsView onUnauthorized={signedOut} />}
          {tab === 'keys' && me?.role === 'admin' && <KeysView onUnauthorized={signedOut} />}
        </main>
      </div>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        index={index}
        onOpenNote={openNote}
        onUnauthorized={signedOut}
      />
      <Toaster position="bottom-right" />
    </TooltipProvider>
  )
}
