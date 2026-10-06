import { useMemo, useState } from 'react'
import { BellIcon, BellOffIcon, ExternalLinkIcon } from 'lucide-react'

import { attempt, gw, useGw } from '@/lib/gateway'
import { usePulse } from '@/lib/pulse'
import { Page } from '@/components/page'
import { CopyField, Panel, Pill } from '@/components/app-ui'
import { BusyButton, ErrorLine } from '@/components/gateway'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

function randomTopic() {
  const bytes = new Uint8Array(9)
  crypto.getRandomValues(bytes)
  return `brain-${Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 16)}`
}

export function NotificationsView({ onUnauthorized }: { onUnauthorized: () => void }) {
  const overview = useGw(() => gw.overview(), [], onUnauthorized)
  const pulse = usePulse()
  const topic = useMemo(randomTopic, [])
  const [url, setUrl] = useState<string | null>(null)
  const saved = overview.data?.notify_url ?? ''
  const value = url ?? saved

  const save = async (v: string) => {
    if (await attempt(() => gw.settings(v), v ? 'Notifications are on' : 'Notifications are off')) {
      setUrl(null)
      overview.reload()
      pulse.refresh()
    }
  }

  return (
    <Page title="Notifications" intro="Get a push on your phone the moment an agent waits for your approval.">
      <ErrorLine error={overview.error} />
      <Panel
        title={
          <span className="flex items-center gap-2">
            Phone notifications
            {overview.data && (saved ? <Pill tone="green" dot>On</Pill> : <Pill dot>Off</Pill>)}
          </span>
        }
        description="BrainMCP uses ntfy, a free push service. No account needed."
      >
        <ol className="grid gap-4">
          <li className="flex gap-3">
            <Step n={1} />
            <div className="text-sm">
              <p className="font-medium">Install the ntfy app</p>
              <p className="mt-0.5 text-muted-foreground">
                Free for{' '}
                <a className="text-sky-400 hover:underline" href="https://apps.apple.com/app/ntfy/id1625396347" target="_blank" rel="noreferrer">
                  iPhone <ExternalLinkIcon className="inline size-3" />
                </a>{' '}
                and{' '}
                <a className="text-sky-400 hover:underline" href="https://play.google.com/store/apps/details?id=io.heckel.ntfy" target="_blank" rel="noreferrer">
                  Android <ExternalLinkIcon className="inline size-3" />
                </a>
                .
              </p>
            </div>
          </li>
          <li className="flex gap-3">
            <Step n={2} />
            <div className="min-w-0 flex-1 text-sm">
              <p className="font-medium">Subscribe to a private topic</p>
              <p className="mt-0.5 text-muted-foreground">
                In the app, tap + and enter this topic name. We made a random one for you: anyone who knows the name can read
                the alerts, so keep it long and secret.
              </p>
              <div className="mt-2 max-w-sm">
                <CopyField value={topic} label="topic" />
              </div>
            </div>
          </li>
          <li className="flex gap-3">
            <Step n={3} />
            <div className="min-w-0 flex-1 text-sm">
              <Label htmlFor="notify-url" className="font-medium">
                Paste the topic address here and save
              </Label>
              <div className="mt-2 flex flex-wrap gap-2">
                <Input
                  id="notify-url"
                  placeholder={`https://ntfy.sh/${topic}`}
                  value={value}
                  onChange={(e) => setUrl(e.target.value)}
                  className="max-w-md flex-1"
                />
                {!value && (
                  <BusyButton variant="outline" onClick={() => save(`https://ntfy.sh/${topic}`)}>
                    Use https://ntfy.sh/{topic.slice(0, 10)}…
                  </BusyButton>
                )}
                <BusyButton disabled={value === saved} onClick={() => save(value.trim())}>
                  <BellIcon />
                  Save
                </BusyButton>
                {saved && (
                  <BusyButton variant="ghost" onClick={() => save('')}>
                    <BellOffIcon />
                    Turn off
                  </BusyButton>
                )}
              </div>
            </div>
          </li>
        </ol>
      </Panel>
    </Page>
  )
}

function Step({ n }: { n: number }) {
  return (
    <span className="grid size-6 shrink-0 place-items-center rounded-full bg-muted text-xs font-semibold tabular-nums">{n}</span>
  )
}
