// Product analytics (PostHog). The console shows private brain notes, so this is the
// strict setup: every replay is fully text-masked, autocapture never records element
// text or attributes, URL hashes (which can carry search terms and device codes) are
// dropped, and people are identified by internal user id only. Events carry counts
// and kinds, never note paths, titles, contents or search queries.
import posthog from 'posthog-js'

const KEY = import.meta.env.VITE_POSTHOG_KEY as string | undefined
const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname)
const enabled = !!KEY && (import.meta.env.PROD || import.meta.env.VITE_POSTHOG_DEV === '1') && !LOCAL

/** The current console screen ("brain/notes"), from the hash route; never its query. */
function screen(): string {
  const [path] = window.location.hash.replace(/^#\/?/, '').split('?')
  const [dest = '', sub = ''] = path.split('/')
  const ok = (s: string) => /^[a-z-]{1,20}$/.test(s)
  if (!ok(dest)) return 'home'
  return ok(sub) ? `${dest}/${sub}` : dest
}

export function initAnalytics() {
  if (!enabled) return
  posthog.init(KEY!, {
    api_host: '/ingest',
    ui_host: 'https://us.posthog.com',
    defaults: '2026-08-30',
    capture_pageview: 'history_change',
    capture_pageleave: true,
    autocapture: true,
    enable_heatmaps: true,
    capture_dead_clicks: true,
    capture_exceptions: true,
    capture_performance: { web_vitals: true },
    disable_capture_url_hashes: true,
    mask_all_text: true,
    mask_all_element_attributes: true,
    session_recording: { maskAllInputs: true, maskTextSelector: '*' },
    before_send: (event) => {
      if (event) event.properties = { ...event.properties, screen: screen() }
      return event
    },
  })
  posthog.register({ app: 'brain-mcp' })
}

/** The console routes by hash, which PostHog ignores: one pageview per screen change. */
export function trackScreen() {
  if (enabled) posthog.capture('$pageview', { navigation_type: 'hash_route' })
}

/** Internal user id only: no handle, email or name on the person. */
export function identifyUser(userId: string | null | undefined) {
  if (enabled && userId) posthog.identify(userId)
}

export function resetUser() {
  if (enabled) posthog.reset()
}

type Props = Record<string, string | number | boolean | null | undefined>

export function track(event: string, props: Props = {}) {
  if (enabled) posthog.capture(event, props)
}
