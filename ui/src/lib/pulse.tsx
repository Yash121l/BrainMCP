// One shared poll of what changes under the user: pending approvals and the
// connection overview. The bell, Home, the sidebar badges and the approvals page
// all read from here, so a decision made in one place shows up everywhere.

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

import { Unauthorized } from '@/lib/api'
import { expired } from '@/lib/people'
import { gw, type Approval, type Overview } from '@/lib/gateway'

type Pulse = {
  approvals: Approval[] | null
  overview: Overview | null
  refresh: () => Promise<void>
  decide: (a: Approval, decision: 'approve' | 'deny', scope?: 'once' | 'hour') => Promise<boolean>
}

const Ctx = createContext<Pulse>({
  approvals: null,
  overview: null,
  refresh: async () => {},
  decide: async () => false,
})

export const usePulse = () => useContext(Ctx)

export function PulseProvider({
  enabled,
  onUnauthorized,
  children,
}: {
  enabled: boolean
  onUnauthorized: () => void
  children: React.ReactNode
}) {
  const [approvals, setApprovals] = useState<Approval[] | null>(null)
  const [overview, setOverview] = useState<Overview | null>(null)
  const unauth = useRef(onUnauthorized)
  unauth.current = onUnauthorized

  const refresh = useCallback(async () => {
    if (!enabled) return
    try {
      const [a, o] = await Promise.all([gw.approvals('pending'), gw.overview()])
      setApprovals(a.approvals.filter((x) => x.status === 'pending' && !expired(x.expires)))
      setOverview(o)
    } catch (e) {
      if (e instanceof Unauthorized) unauth.current()
    }
  }, [enabled])

  useEffect(() => {
    if (!enabled) return
    refresh()
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') refresh()
    }, 10000)
    const onVisible = () => document.visibilityState === 'visible' && refresh()
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [enabled, refresh])

  const decide = useCallback(
    async (a: Approval, decision: 'approve' | 'deny', scope: 'once' | 'hour' = 'once') => {
      try {
        await gw.decide(a.id, decision, scope)
        toast.success(
          decision === 'deny'
            ? `Denied. ${a.agent ?? 'The agent'} will be told no.`
            : scope === 'hour'
              ? `Approved for an hour. ${a.agent ?? 'The agent'} can carry on.`
              : `Approved once. ${a.agent ?? 'The agent'} can carry on.`,
        )
        setApprovals((list) => list?.filter((x) => x.id !== a.id) ?? list)
        refresh()
        return true
      } catch (e) {
        if (e instanceof Unauthorized) unauth.current()
        else toast.error(e instanceof Error ? e.message : 'request failed')
        return false
      }
    },
    [refresh],
  )

  return <Ctx.Provider value={{ approvals, overview, refresh, decide }}>{children}</Ctx.Provider>
}
