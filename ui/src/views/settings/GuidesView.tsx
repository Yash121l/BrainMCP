import { toast } from 'sonner'
import { BookOpenIcon, RotateCcwIcon } from 'lucide-react'

import { useGuides } from '@/lib/guides'
import { Page } from '@/components/page'
import { Panel } from '@/components/app-ui'
import { Button } from '@/components/ui/button'

export function GuidesView({ onWelcome }: { onWelcome: () => void }) {
  const guides = useGuides()
  return (
    <Page title="Guides" intro="The welcome tour, the “How this works” cards on each page, and the Getting started checklist.">
      <Panel title="Start over" description="Bring back every guide you dismissed, as if this were your first visit.">
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => {
              guides.reset()
              toast.success('Guides are back on every page')
            }}
          >
            <RotateCcwIcon />
            Reset guides
          </Button>
          <Button variant="outline" onClick={onWelcome}>
            <BookOpenIcon />
            Replay the welcome tour
          </Button>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Help is always one click away: the ? button at the top right explains the page you are on and the words used here.
        </p>
      </Panel>
    </Page>
  )
}
