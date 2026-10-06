import { useId } from 'react'
import { cn } from '@/lib/utils'

/** The BrainMCP mark: two hemispheres around a hub wired to the apps and agents it serves. */
export function BrainMark({ className, title }: { className?: string; title?: string }) {
  const g = `bm-${useId().replace(/:/g, '')}`
  return (
    <svg viewBox="0 0 64 64" fill="none" className={cn('size-8 shrink-0', className)} role={title ? 'img' : undefined} aria-hidden={title ? undefined : true}>
      {title && <title>{title}</title>}
      <defs>
        <linearGradient id={g} x1="10" y1="8" x2="54" y2="58" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#5EEAD4" />
          <stop offset="0.5" stopColor="#60A5FA" />
          <stop offset="1" stopColor="#A78BFA" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="15" fill="#0B1022" />
      <path d="M28.5 12.5c-8.6 0-15 5.8-15 13.6 0 3 .9 5.6 2.6 7.6-1.6 1.9-2.6 4.3-2.6 6.9 0 6.1 5 10.9 11.4 10.9h3.6" stroke={`url(#${g})`} strokeWidth="4.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M35.5 12.5c8.6 0 15 5.8 15 13.6 0 3-.9 5.6-2.6 7.6 1.6 1.9 2.6 4.3 2.6 6.9 0 6.1-5 10.9-11.4 10.9h-3.6" stroke={`url(#${g})`} strokeWidth="4.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M32 32 21.5 23.5M32 32l10.5-8.5M32 32 22 42.5M32 32l10 10.5M32 32v14" stroke={`url(#${g})`} strokeWidth="2.4" strokeLinecap="round" opacity=".85" />
      <circle cx="21.5" cy="23.5" r="3.1" fill={`url(#${g})`} />
      <circle cx="42.5" cy="23.5" r="3.1" fill={`url(#${g})`} />
      <circle cx="22" cy="42.5" r="3.1" fill={`url(#${g})`} />
      <circle cx="42" cy="42.5" r="3.1" fill={`url(#${g})`} />
      <circle cx="32" cy="32" r="6.4" fill="#F8FAFC" />
      <circle cx="32" cy="46.5" r="2.6" fill={`url(#${g})`} />
    </svg>
  )
}
