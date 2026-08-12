import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { Role } from '@/lib/api'

const ROLE_CLASS: Record<Role, string> = {
  admin: 'border-rose-500/25 bg-rose-500/10 text-rose-300',
  write: 'border-amber-500/25 bg-amber-500/10 text-amber-300',
  read: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300',
}

export function RoleBadge({ role, className }: { role: Role; className?: string }) {
  return (
    <Badge variant="outline" className={cn('font-medium', ROLE_CLASS[role] ?? ROLE_CLASS.read, className)}>
      {role}
    </Badge>
  )
}
