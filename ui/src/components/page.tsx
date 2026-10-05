import { ScrollArea } from '@/components/ui/scroll-area'

export function Page({
  title,
  intro,
  action,
  children,
}: {
  title: string
  intro?: React.ReactNode
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <ScrollArea className="h-full">
      <div className="mx-auto w-full max-w-5xl px-8 py-10">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
            {intro && <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{intro}</p>}
          </div>
          {action}
        </div>
        <div className="mt-8 grid gap-10">{children}</div>
      </div>
    </ScrollArea>
  )
}

export function Section({
  title,
  intro,
  action,
  children,
}: {
  title: string
  intro?: React.ReactNode
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section>
      <div className="mb-3 flex items-end justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold tracking-tight">{title}</h2>
          {intro && <p className="mt-0.5 max-w-2xl text-xs text-muted-foreground">{intro}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
      {children}
    </div>
  )
}
