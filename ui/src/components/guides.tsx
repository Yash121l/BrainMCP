import { useState } from 'react'
import { ArrowRightIcon, BookOpenIcon, LaptopIcon, LightbulbIcon, PlugIcon, ShieldCheckIcon, XIcon } from 'lucide-react'

import { cn } from '@/lib/utils'
import { GLOSSARY, GUIDES, useGuides, type Page } from '@/lib/guides'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'

/** The dismissible "How this works" card at the top of a page. */
export function PageIntro({ page, onAction, actionLabel }: { page: Page; onAction?: () => void; actionLabel?: string }) {
  const guides = useGuides()
  if (guides.introHidden(page)) return null
  const g = GUIDES[page]
  const label = actionLabel ?? g.action
  return (
    <section
      aria-label={g.title}
      className="relative overflow-hidden rounded-xl border border-sky-500/20 bg-gradient-to-br from-sky-500/[0.07] via-transparent to-violet-500/[0.06] p-5"
    >
      <button
        type="button"
        onClick={() => guides.hideIntro(page)}
        aria-label="Hide this guide"
        className="absolute top-3 right-3 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <XIcon className="size-4" />
      </button>
      <div className="flex items-center gap-2 text-xs font-medium tracking-wide text-sky-300 uppercase">
        <LightbulbIcon className="size-3.5" />
        {g.title}
      </div>
      <p className="mt-1.5 max-w-2xl pr-6 text-sm text-foreground/90">{g.summary}</p>
      <ol className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {g.steps.map((s, i) => (
          <li key={s.title} className="flex gap-3">
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-sky-500/15 text-xs font-semibold text-sky-300 tabular-nums">
              {i + 1}
            </span>
            <div className="min-w-0">
              <p className="text-sm font-medium">{s.title}</p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{s.body}</p>
            </div>
          </li>
        ))}
      </ol>
      <div className="mt-4 flex flex-wrap gap-2">
        {onAction && label && (
          <Button size="sm" onClick={onAction}>
            {label}
            <ArrowRightIcon />
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => guides.hideIntro(page)}>
          Got it
        </Button>
      </div>
    </section>
  )
}

export function HelpSheet({
  open,
  onOpenChange,
  page,
  onWelcome,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  page: Page
  onWelcome: () => void
}) {
  const guides = useGuides()
  const g = GUIDES[page]
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <BookOpenIcon className="size-4 text-muted-foreground" />
            Help
          </SheetTitle>
          <SheetDescription>{g.summary}</SheetDescription>
        </SheetHeader>
        <SheetBody className="grid content-start gap-8">
          <section>
            <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{g.title}</h3>
            <ol className="mt-3 grid gap-4">
              {g.steps.map((s, i) => (
                <li key={s.title} className="flex gap-3">
                  <span className="grid size-6 shrink-0 place-items-center rounded-full bg-muted text-xs font-semibold tabular-nums">
                    {i + 1}
                  </span>
                  <div>
                    <p className="text-sm font-medium">{s.title}</p>
                    <p className="mt-0.5 text-sm text-muted-foreground">{s.body}</p>
                  </div>
                </li>
              ))}
            </ol>
            <div className="mt-4 flex flex-wrap gap-2">
              {guides.introHidden(page) && (
                <Button size="sm" variant="outline" onClick={() => guides.showIntro(page)}>
                  Show the guide on this page again
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  onOpenChange(false)
                  onWelcome()
                }}
              >
                Replay the welcome tour
              </Button>
            </div>
          </section>
          <section>
            <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Words you will see</h3>
            <dl className="mt-3 grid gap-3">
              {GLOSSARY.map((w) => (
                <div key={w.term} className="rounded-lg border border-border px-3 py-2.5">
                  <dt className="text-sm font-medium">{w.term}</dt>
                  <dd className="mt-0.5 text-sm text-muted-foreground">{w.body}</dd>
                </div>
              ))}
            </dl>
          </section>
        </SheetBody>
      </SheetContent>
    </Sheet>
  )
}

const WELCOME = [
  {
    icon: ShieldCheckIcon,
    title: 'Welcome to BrainMCP',
    body: 'BrainMCP lets your AI agents (Claude Code, Codex, Cursor and others) use your apps, like Figma, Linear or Gmail, without ever seeing your passwords. You decide what each agent may do, and anything risky waits for your OK.',
    points: ['Connect an app once; every agent can use it.', 'Each agent has its own key, so you always know who did what.', 'Your Brain keeps notes, decisions and skills your agents share.'],
  },
  {
    icon: PlugIcon,
    title: 'Connect your first app',
    body: 'Pick an app from the directory. Most take one click: you sign in at the app and come straight back. New apps start as read only, so agents can look things up but not change anything.',
    points: ['Search the directory or the public MCP Registry.', 'Connect several accounts of one app, like work and personal.', 'Raise access later, when you trust it.'],
    cta: 'Open the directory',
  },
  {
    icon: LaptopIcon,
    title: 'Add your first device',
    body: 'Install the small brain command-line tool on each computer where your agents run. It signs them in with a short code you approve here, and sets each agent up to use BrainMCP.',
    points: ['One command to install, one to sign in.', 'You approve every new device by code.', 'Remove a device any time; its keys stop working at once.'],
    cta: 'Add a device',
  },
]

export function WelcomeModal({
  open,
  onClose,
  onConnect,
  onAddDevice,
}: {
  open: boolean
  onClose: () => void
  onConnect: () => void
  onAddDevice: () => void
}) {
  const [step, setStep] = useState(0)
  const s = WELCOME[step]
  const last = step === WELCOME.length - 1
  const Icon = s.icon
  const finish = (then?: () => void) => {
    onClose()
    setStep(0)
    then?.()
  }
  return (
    <Dialog open={open} onOpenChange={(v) => !v && finish()}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-lg">
        <div className="bg-gradient-to-br from-sky-500/15 via-violet-500/10 to-transparent px-6 pt-8 pb-6">
          <span className="grid size-11 place-items-center rounded-xl bg-background/70 ring-1 ring-border">
            <Icon className="size-5" />
          </span>
          <p className="mt-4 text-xs font-medium text-muted-foreground">
            Step {step + 1} of {WELCOME.length}
          </p>
          <DialogTitle className="mt-1 text-xl tracking-tight">{s.title}</DialogTitle>
          <DialogDescription className="mt-2 text-sm leading-relaxed text-foreground/80">{s.body}</DialogDescription>
        </div>
        <ul className="grid gap-2 px-6 py-5">
          {s.points.map((p) => (
            <li key={p} className="flex gap-2 text-sm text-muted-foreground">
              <span aria-hidden className="mt-2 size-1.5 shrink-0 rounded-full bg-sky-400" />
              {p}
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-6 py-4">
          <div className="flex gap-1.5" aria-hidden>
            {WELCOME.map((_, i) => (
              <span key={i} className={cn('h-1.5 rounded-full transition-all', i === step ? 'w-5 bg-foreground' : 'w-1.5 bg-muted-foreground/40')} />
            ))}
          </div>
          <div className="ml-auto flex flex-wrap gap-2">
            <Button variant="ghost" size="sm" onClick={() => finish()}>
              {last ? 'Close' : 'Skip'}
            </Button>
            {s.cta && (
              <Button variant="outline" size="sm" onClick={() => finish(step === 1 ? onConnect : onAddDevice)}>
                {s.cta}
              </Button>
            )}
            {!last && (
              <Button size="sm" onClick={() => setStep((v) => v + 1)}>
                Next
                <ArrowRightIcon />
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
