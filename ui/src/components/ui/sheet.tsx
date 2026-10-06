import * as React from 'react'
import { XIcon } from 'lucide-react'
import { Dialog as SheetPrimitive } from 'radix-ui'

import { cn } from '@/lib/utils'

const Sheet = (props: React.ComponentProps<typeof SheetPrimitive.Root>) => <SheetPrimitive.Root data-slot="sheet" {...props} />
const SheetTrigger = (props: React.ComponentProps<typeof SheetPrimitive.Trigger>) => (
  <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />
)
const SheetClose = (props: React.ComponentProps<typeof SheetPrimitive.Close>) => (
  <SheetPrimitive.Close data-slot="sheet-close" {...props} />
)

function SheetContent({
  className,
  children,
  side = 'right',
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Content> & { side?: 'right' | 'left' }) {
  return (
    <SheetPrimitive.Portal>
      <SheetPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50" />
      <SheetPrimitive.Content
        data-slot="sheet-content"
        className={cn(
          'fixed inset-y-0 z-50 flex h-full w-full flex-col border-border bg-background shadow-xl outline-none',
          side === 'right' ? 'right-0 border-l sm:max-w-xl' : 'left-0 border-r sm:max-w-sm',
          className,
        )}
        {...props}
      >
        {children}
        <SheetPrimitive.Close className="absolute top-4 right-4 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
          <XIcon className="size-4" />
          <span className="sr-only">Close</span>
        </SheetPrimitive.Close>
      </SheetPrimitive.Content>
    </SheetPrimitive.Portal>
  )
}

const SheetHeader = ({ className, ...props }: React.ComponentProps<'div'>) => (
  <div className={cn('grid gap-1 border-b border-border px-6 py-5 pr-12', className)} {...props} />
)
const SheetTitle = ({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Title>) => (
  <SheetPrimitive.Title className={cn('text-lg font-semibold tracking-tight', className)} {...props} />
)
const SheetDescription = ({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Description>) => (
  <SheetPrimitive.Description className={cn('text-sm text-muted-foreground', className)} {...props} />
)
const SheetBody = ({ className, ...props }: React.ComponentProps<'div'>) => (
  <div className={cn('scrollbar-thin min-h-0 flex-1 overflow-y-auto px-6 py-5', className)} {...props} />
)

export { Sheet, SheetTrigger, SheetClose, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetBody }
