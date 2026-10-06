import { BrainMark } from '@/components/logo'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'

import {
  api,
  scopeReadsToSpace,
  Unauthorized,
  type GraphData,
  type Me,
  type Note,
  type NoteMeta,
} from '@/lib/api'
import type { WhoAmI } from '@/lib/people'
import { buildIndex } from '@/lib/notes'
import { isOwn } from '@/lib/gateway'
import { useGuides, type Page as GuidePage } from '@/lib/guides'
import { PulseProvider, usePulse } from '@/lib/pulse'
import { Sidebar, TopBar, type Dest } from '@/components/shell'
import { CommandPalette } from '@/components/command-palette'
import { HelpSheet, WelcomeModal } from '@/components/guides'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Login } from '@/views/Login'
import { HomeView } from '@/views/HomeView'
import { AppsView } from '@/views/apps/AppsView'
import { AgentsView } from '@/views/AgentsView'
import { ActivityView } from '@/views/ActivityView'
import { ApprovalsView } from '@/views/ApprovalsView'
import { DeviceView } from '@/views/DeviceView'
import { BrainView, BRAIN_TABS, type BrainTab } from '@/views/BrainView'
import { SettingsView, SETTINGS_TABS, type SettingsTab } from '@/views/SettingsView'

type Auth = 'checking' | 'in' | 'out'
type Route = { dest: Dest; sub: string; params: URLSearchParams }

const DESTS: Dest[] = ['home', 'apps', 'agents', 'activity', 'brain', 'settings', 'approvals', 'device']
// Old tab names still work as links (bookmarks, the CLI, OAuth and device redirects).
const LEGACY: Record<string, [Dest, string]> = {
  notes: ['brain', 'notes'],
  graph: ['brain', 'graph'],
  health: ['brain', 'health'],
  skills: ['brain', 'skills'],
  sharing: ['settings', 'sharing'],
  account: ['settings', 'account'],
  keys: ['settings', 'keys'],
  admin: ['settings', 'admin'],
  rules: ['settings', 'rules'],
  notifications: ['settings', 'notifications'],
  connections: ['apps', ''],
  machines: ['agents', ''],
}

function readHash(): Route | null {
  const raw = window.location.hash.replace(/^#\/?/, '')
  if (!raw) return null
  const [path, query = ''] = raw.split('?')
  const [name, sub = ''] = path.split('/')
  const params = new URLSearchParams(query)
  if (LEGACY[name]) return { dest: LEGACY[name][0], sub: LEGACY[name][1] || sub, params }
  if ((DESTS as string[]).includes(name)) return { dest: name as Dest, sub, params }
  return null
}

const hashFor = (dest: Dest, sub = '', query = '') => `#${dest}${sub ? `/${sub}` : ''}${query ? `?${query}` : ''}`

const initialRoute = readHash()

export default function App() {
  const [auth, setAuth] = useState<Auth>('checking')
  const [me, setMe] = useState<Me | null>(null)
  const signedOut = useCallback(() => {
    setAuth('out')
    setMe(null)
  }, [])

  return (
    <PulseProvider enabled={auth === 'in' && !!me?.user} onUnauthorized={signedOut}>
      <Shell auth={auth} setAuth={setAuth} me={me} setMe={setMe} signedOut={signedOut} />
    </PulseProvider>
  )
}

function Shell({
  auth,
  setAuth,
  me,
  setMe,
  signedOut,
}: {
  auth: Auth
  setAuth: (a: Auth) => void
  me: Me | null
  setMe: (m: Me | null) => void
  signedOut: () => void
}) {
  const [route, setRoute] = useState<Route>(initialRoute ?? { dest: 'home', sub: '', params: new URLSearchParams() })
  const [notes, setNotes] = useState<NoteMeta[]>([])
  const [notesLoading, setNotesLoading] = useState(true)
  const [path, setPath] = useState<string | null>(null)
  const [note, setNote] = useState<Note | null>(null)
  const [noteLoading, setNoteLoading] = useState(false)
  const [backlinks, setBacklinks] = useState<string[] | null>(null)
  const [graph, setGraph] = useState<GraphData | null>(null)
  const [graphLoading, setGraphLoading] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [welcomeOpen, setWelcomeOpen] = useState(false)
  const [pendingShares, setPendingShares] = useState(0)
  const [connected, setConnected] = useState<string | null>(null)
  const guides = useGuides()
  const pulse = usePulse()
  const index = useMemo(() => buildIndex(notes), [notes])

  const go = useCallback((dest: Dest, sub = '', query = '', replace = false) => {
    const next = hashFor(dest, sub, query)
    if (window.location.hash !== next) {
      if (replace) window.history.replaceState(null, '', next)
      else window.history.pushState(null, '', next)
    }
    setRoute({ dest, sub, params: new URLSearchParams(query) })
  }, [])

  // Back from OAuth: "#apps?connected=figma_main" (or the old "#connections?..."). Show it once.
  useEffect(() => {
    const done = route.dest === 'apps' ? route.params.get('connected') : null
    if (done) {
      setConnected(done)
      go('apps', '', '', true)
    }
  }, [route, go])

  useEffect(() => {
    const onHash = () => {
      const r = readHash()
      if (r) setRoute(r)
    }
    window.addEventListener('hashchange', onHash)
    window.addEventListener('popstate', onHash)
    return () => {
      window.removeEventListener('hashchange', onHash)
      window.removeEventListener('popstate', onHash)
    }
  }, [])

  const fail = useCallback(
    (e: unknown, msg: string) => {
      if (e instanceof Unauthorized) signedOut()
      else toast.error(e instanceof Error ? e.message : msg)
    },
    [signedOut],
  )

  const loadSpace = useCallback(
    (alive: () => boolean) => {
      setNotesLoading(true)
      return api.me().then((m) => {
        if (!alive()) return
        setMe(m)
        setAuth('in')
        if (m.user) {
          api
            .tool<WhoAmI>('whoami')
            .then((w) => alive() && setPendingShares(w.pending?.length ?? 0))
            .catch(() => {})
        }
        if (m.role === 'none') {
          setNotes([])
          setNotesLoading(false)
          return
        }
        return api.notes().then((list) => {
          if (!alive()) return
          setNotes(list)
          setNotesLoading(false)
          const start =
            list.find((n) => n.path === 'vault/BRAIN.md') ?? list.find((n) => n.path === 'vault/README.md') ?? list[0]
          setPath(start ? start.path : null)
          if (!start) setNote(null)
        })
      })
    },
    [setAuth, setMe],
  )

  useEffect(() => {
    let alive = true
    loadSpace(() => alive).catch((e) => {
      if (!alive) return
      setAuth('out')
      if (!(e instanceof Unauthorized)) toast.error(e instanceof Error ? e.message : 'could not reach the brain')
    })
    return () => {
      alive = false
    }
  }, [loadSpace, setAuth])

  // Without a user (a scoped key), the gateway pages don't apply: land in the Brain.
  useEffect(() => {
    if (auth !== 'in' || !me || me.user) return
    if (['home', 'apps', 'agents', 'activity', 'approvals', 'device'].includes(route.dest)) go('brain', 'notes', '', true)
  }, [auth, me, route.dest, go])

  // First visit: the welcome tour.
  useEffect(() => {
    if (auth === 'in' && me?.user && !guides.welcomeSeen && route.dest !== 'device') setWelcomeOpen(true)
  }, [auth, me?.user, guides.welcomeSeen, route.dest])

  const refreshNotes = useCallback(() => {
    api.notes().then(setNotes).catch(() => {})
  }, [])

  const openSpace = useCallback(
    (handle: string) => {
      scopeReadsToSpace(handle)
      setGraph(null)
      go('brain', 'notes')
      loadSpace(() => true).catch((e) => fail(e, `could not open ${handle}`))
    },
    [loadSpace, fail, go],
  )

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

  const brainTab: BrainTab = (BRAIN_TABS as string[]).includes(route.sub) ? (route.sub as BrainTab) : 'notes'
  const settingsTab: SettingsTab = (SETTINGS_TABS as string[]).includes(route.sub) ? (route.sub as SettingsTab) : 'account'

  useEffect(() => {
    if (route.dest !== 'brain' || brainTab !== 'graph' || graph || graphLoading || auth !== 'in') return
    setGraphLoading(true)
    api
      .graph()
      .then(setGraph)
      .catch((e) => fail(e, 'could not load the graph'))
      .finally(() => setGraphLoading(false))
  }, [route.dest, brainTab, graph, graphLoading, auth, fail])

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

  const openNote = useCallback(
    (p: string) => {
      go('brain', 'notes')
      setPath(p)
    },
    [go],
  )

  const openApp = useCallback((id: string | null) => go('apps', '', id ? `app=${encodeURIComponent(id)}` : ''), [go])
  const openDirectory = useCallback(
    (open: boolean, q?: string) => go('apps', '', open ? `add=1${q ? `&q=${encodeURIComponent(q)}` : ''}` : ''),
    [go],
  )
  const addDevice = useCallback((open: boolean) => go('agents', '', open ? 'add=1' : ''), [go])
  const advancedRules = useCallback(() => go('settings', 'rules'), [go])
  const notifications = useCallback(() => go('settings', 'notifications'), [go])
  const clearConnected = useCallback(() => setConnected(null), [])

  const own = (pulse.overview?.connections ?? []).filter(isOwn)
  const appsBadge = own.filter((c) => c.status !== 'active' || (c.review ?? 0) > 0).length

  const pages = useMemo(
    () =>
      [
        ...(me?.user
          ? [
              { label: 'Home', run: () => go('home') },
              { label: 'Apps', keywords: 'connections accounts', run: () => go('apps') },
              { label: 'Add an app (directory)', keywords: 'connect catalog', run: () => openDirectory(true) },
              { label: 'Agents and devices', keywords: 'machines keys', run: () => go('agents') },
              { label: 'Add a device', keywords: 'brain login code', run: () => addDevice(true) },
              { label: 'Activity', keywords: 'log history audit', run: () => go('activity') },
              { label: 'Approvals', keywords: 'pending', run: () => go('approvals') },
              { label: 'Notifications', keywords: 'ntfy phone push', run: () => go('settings', 'notifications') },
              { label: 'Advanced rules', keywords: 'policy permit forbid', run: () => go('settings', 'rules') },
              { label: 'Project sharing', keywords: 'share invite', run: () => go('settings', 'sharing') },
            ]
          : []),
        { label: 'Brain notes', run: () => go('brain', 'notes') },
        { label: 'Graph', run: () => go('brain', 'graph') },
        { label: 'Skills', run: () => go('brain', 'skills') },
        { label: 'Health', run: () => go('brain', 'health') },
        { label: 'Account', keywords: 'sign out keys', run: () => go('settings', 'account') },
        { label: 'Guides', keywords: 'help reset tour', run: () => go('settings', 'guides') },
      ] as { label: string; keywords?: string; run: () => void }[],
    [me?.user, go, openDirectory, addDevice],
  )

  if (auth === 'checking') {
    return (
      <div className="grid min-h-svh place-items-center">
        <BrainMark className="size-12 animate-pulse" />
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

  const dest = route.dest
  const guidePage: GuidePage = dest === 'device' ? 'agents' : (dest as GuidePage)

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex h-svh overflow-hidden bg-background">
        <Sidebar
          me={me}
          dest={dest}
          onGo={(d) => go(d, d === 'brain' ? brainTab : d === 'settings' ? settingsTab : '')}
          onSpace={openSpace}
          badges={{ home: pulse.approvals?.length ?? 0, apps: appsBadge, settings: pendingShares }}
        />
        <main key={me?.space ?? ''} className="flex min-w-0 flex-1 flex-col">
          <TopBar me={me} onSearch={() => setPaletteOpen(true)} onHelp={() => setHelpOpen(true)} onApprovals={() => go('approvals')} />
          {me && <SpaceBanner me={me} />}
          <div className="min-h-0 flex-1">
            {me?.user && (
              <>
                {dest === 'home' && (
                  <HomeView
                    onApps={() => go('apps')}
                    onOpenApp={(id) => openApp(id)}
                    onDirectory={() => openDirectory(true)}
                    onAgents={() => go('agents')}
                    onAddDevice={() => addDevice(true)}
                    onActivity={() => go('activity')}
                    onApprovals={() => go('approvals')}
                    onNotifications={notifications}
                    onUnauthorized={signedOut}
                  />
                )}
                {dest === 'apps' && (
                  <AppsView
                    openId={route.params.get('app')}
                    directory={route.params.get('add') === '1'}
                    directoryQuery={route.params.get('q') ?? undefined}
                    connected={connected}
                    onOpen={(id) => {
                      clearConnected()
                      openApp(id)
                    }}
                    onDirectory={openDirectory}
                    onAdvancedRules={advancedRules}
                    onUnauthorized={signedOut}
                  />
                )}
                {dest === 'agents' && (
                  <AgentsView addOpen={route.params.get('add') === '1'} onAddOpen={addDevice} onUnauthorized={signedOut} />
                )}
                {dest === 'activity' && <ActivityView onApprovals={() => go('approvals')} onUnauthorized={signedOut} />}
                {dest === 'approvals' && <ApprovalsView onNotifications={notifications} onUnauthorized={signedOut} />}
                {dest === 'device' && (
                  <DeviceView
                    key={route.params.get('code') ?? ''}
                    code={route.params.get('code') ?? ''}
                    onDone={() => go('agents')}
                  />
                )}
              </>
            )}
            {dest === 'brain' && (
              <BrainView
                tab={brainTab}
                onTab={(t) => go('brain', t)}
                notes={notes}
                notesLoading={notesLoading}
                path={path}
                note={note}
                noteLoading={noteLoading}
                index={index}
                backlinks={backlinks}
                graph={graph}
                graphLoading={graphLoading}
                onOpenNote={openNote}
                onUnauthorized={signedOut}
              />
            )}
            {dest === 'settings' && me && (
              <SettingsView
                me={me}
                tab={settingsTab}
                onTab={(t) => go('settings', t)}
                pendingShares={pendingShares}
                onOpenSpace={openSpace}
                onNotesChanged={refreshNotes}
                onWelcome={() => setWelcomeOpen(true)}
                onUnauthorized={signedOut}
              />
            )}
          </div>
        </main>
      </div>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        index={index}
        onOpenNote={openNote}
        onUnauthorized={signedOut}
        pages={pages}
      />
      <HelpSheet open={helpOpen} onOpenChange={setHelpOpen} page={guidePage} onWelcome={() => setWelcomeOpen(true)} />
      <WelcomeModal
        open={welcomeOpen}
        onClose={() => {
          setWelcomeOpen(false)
          guides.seeWelcome()
        }}
        onConnect={() => openDirectory(true)}
        onAddDevice={() => addDevice(true)}
      />
      <Toaster position="bottom-right" />
    </TooltipProvider>
  )
}

function SpaceBanner({ me }: { me: Me }) {
  const owner = me.spaces.find((s) => s.handle === me.space)?.owner
  const text =
    me.role === 'none'
      ? `This key has no access to ${me.space}. Pick another space in the sidebar.`
      : me.access === 'super'
        ? `Viewing ${me.space} as super admin. Every read is logged and shown to ${owner ?? 'its owner'} in their Activity.`
        : me.access === 'share'
          ? `${me.space} shared with you: you see only the projects ${owner ?? 'its owner'} shared.`
          : me.access === 'system'
            ? '@system holds the default skills every user starts with. Read-only unless you sign in with a super key.'
            : null
  if (!text) return null
  const tone =
    me.access === 'super'
      ? 'border-violet-500/30 bg-violet-500/10 text-violet-200'
      : 'border-amber-500/25 bg-amber-500/5 text-amber-200'
  return <div className={`border-b px-6 py-2 text-xs ${tone}`}>{text}</div>
}
