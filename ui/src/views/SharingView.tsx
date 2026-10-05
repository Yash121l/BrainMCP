import { useState } from 'react'
import { toast } from 'sonner'
import {
  CheckIcon,
  ChevronRightIcon,
  DownloadIcon,
  FolderPlusIcon,
  PlusIcon,
  Share2Icon,
  UserPlusIcon,
  XIcon,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import {
  runTool,
  day,
  splitProject,
  useTool,
  type Member,
  type ProjectRow,
  type Shares,
  type WhoAmI,
} from '@/lib/people'
import { Empty, Page, Section } from '@/components/page'
import { Choice, Field, FormDialog } from '@/components/form-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

const MANAGES = new Set(['owner', 'admin'])

function StatusBadge({ status }: { status: 'active' | 'pending' }) {
  return status === 'active' ? (
    <Badge variant="outline" className="border-emerald-500/25 text-[10px] text-emerald-300">
      active
    </Badge>
  ) : (
    <Badge variant="outline" className="border-amber-500/25 text-[10px] text-amber-300">
      waiting for them
    </Badge>
  )
}

function Skeletons({ cols, rows = 3 }: { cols: number; rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, i) => (
        <TableRow key={i}>
          {Array.from({ length: cols }).map((__, j) => (
            <TableCell key={j}>
              <Skeleton className="h-4 w-full" />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </>
  )
}

function PendingSection({ who, onDone }: { who: WhoAmI; onDone: () => void }) {
  const pending = who.pending ?? []
  if (!pending.length) return null
  return (
    <Section
      title="Waiting for you"
      intro="Someone offered you access. Nothing here reaches your sessions until you accept it."
    >
      <div className="grid gap-2">
        {pending.map((p) => {
          const target =
            p.type === 'member'
              ? { space: p.space }
              : { space: splitProject(p.project).space, project: splitProject(p.project).slug }
          const label = p.type === 'member' ? p.space : p.project
          return (
            <div
              key={label}
              className="flex items-center gap-3 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2.5"
            >
              <div className="min-w-0 flex-1 text-sm">
                <span className="font-medium">{label}</span>
                <span className="ml-2 text-xs text-muted-foreground">
                  {p.type === 'member' ? `join the space as ${p.role}, from ${p.from}` : `project shared with you as ${p.role}`}
                </span>
              </div>
              <Button
                size="sm"
                onClick={async () => {
                  if (await runTool('accept', target, `Accepted ${label}`)) onDone()
                }}
              >
                <CheckIcon />
                Accept
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  if (await runTool('decline', target, `Declined ${label}`)) onDone()
                }}
              >
                <XIcon />
                Decline
              </Button>
            </div>
          )
        })}
      </div>
    </Section>
  )
}

function NewProjectDialog({ spaces, onDone }: { spaces: string[]; onDone: () => void }) {
  const [slug, setSlug] = useState('')
  const [title, setTitle] = useState('')
  const [goal, setGoal] = useState('')
  const [space, setSpace] = useState(spaces[0] ?? '')
  return (
    <FormDialog
      trigger={
        <Button size="sm">
          <FolderPlusIcon />
          New project
        </Button>
      }
      title="New project"
      description="Creates vault/projects/<slug>.md. Sessions that name this slug load it."
      submitLabel="Create project"
      canSubmit={!!slug.trim() && !!space}
      onOpen={() => {
        setSlug('')
        setTitle('')
        setGoal('')
        setSpace(spaces[0] ?? '')
      }}
      onSubmit={async () => {
        const r = await runTool('create_project', { slug: slug.trim(), title, goal, space }, `Created ${space}/${slug.trim()}`)
        if (r) onDone()
        return r ? 'close' : 'stay'
      }}
    >
      <Field id="p-slug" label="Slug" placeholder="garden" value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} hint="Lowercase letters, digits, dots, hyphens." />
      <Field id="p-title" label="Title" placeholder="Garden planner" value={title} onChange={(e) => setTitle(e.target.value)} />
      <Field id="p-goal" label="Goal" placeholder="One sentence on what this is for" value={goal} onChange={(e) => setGoal(e.target.value)} />
      {spaces.length > 1 && (
        <div className="grid gap-1.5">
          <Label>Space</Label>
          <Choice value={space} options={spaces.map((s) => ({ value: s, label: s }))} onChange={setSpace} />
        </div>
      )}
    </FormDialog>
  )
}

function ShareDialog({ project, onDone }: { project: string; onDone: () => void }) {
  const [user, setUser] = useState('')
  const [role, setRole] = useState<'viewer' | 'editor'>('viewer')
  const [days, setDays] = useState<number | 0>(0)
  return (
    <FormDialog
      trigger={
        <Button variant="ghost" size="sm" className="h-7 text-xs">
          <Share2Icon />
          Share
        </Button>
      }
      title={`Share ${project}`}
      description="They get this project only, never the rest of the space. It applies once they accept."
      submitLabel="Offer access"
      canSubmit={!!user.trim()}
      onOpen={() => {
        setUser('')
        setRole('viewer')
        setDays(0)
      }}
      onSubmit={async () => {
        const r = await runTool<{ status: string }>(
          'share',
          { project, with: user.trim(), role, ...(days ? { expires_days: days } : {}) },
        )
        if (r) {
          onDone()
          return {
            show: (
            <p className="text-sm">
              Offered {project} to <b>{user.trim().startsWith('@') ? user.trim() : `@${user.trim()}`}</b> as {role}.
              Status: {r.status}. They accept it in their Sharing tab, or with the accept tool.
            </p>
            ),
          }
        }
        return 'stay'
      }}
    >
      <Field id="s-user" label="User" placeholder="@alice" value={user} onChange={(e) => setUser(e.target.value)} />
      <div className="grid gap-1.5">
        <Label>Role</Label>
        <Choice
          value={role}
          onChange={setRole}
          options={[
            { value: 'viewer', label: 'viewer', hint: 'read the project' },
            { value: 'editor', label: 'editor', hint: 'read and write the project, but not skills or rules' },
          ]}
        />
      </div>
      <div className="grid gap-1.5">
        <Label>Expires</Label>
        <Choice
          value={days}
          onChange={setDays}
          options={[
            { value: 0, label: 'never' },
            { value: 7, label: '7 days' },
            { value: 30, label: '30 days' },
            { value: 90, label: '90 days' },
          ]}
        />
      </div>
    </FormDialog>
  )
}

function MembersPanel({
  space,
  manage,
  onUnauthorized,
}: {
  space: string
  manage: boolean
  onUnauthorized: () => void
}) {
  const { data, reload } = useTool<{ members: Member[] }>('list_members', { space }, onUnauthorized)
  const [user, setUser] = useState('')
  const [role, setRole] = useState<'viewer' | 'editor' | 'admin'>('editor')
  return (
    <div className="grid gap-2 border-t border-border bg-muted/20 px-4 py-3">
      {data == null ? (
        <Skeleton className="h-4 w-48" />
      ) : (
        data.members.map((m) => (
          <div key={m.user} className="flex items-center gap-2 text-sm">
            <span className="font-medium">{m.user}</span>
            <Badge variant="outline" className="text-[10px]">
              {m.role}
            </Badge>
            {m.status === 'pending' && <StatusBadge status="pending" />}
            {manage && m.role !== 'owner' && (
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto h-7 text-xs"
                onClick={async () => {
                  if (await runTool('remove_member', { space, user: m.user }, `Removed ${m.user}`)) reload()
                }}
              >
                Remove
              </Button>
            )}
          </div>
        ))
      )}
      {manage && (
        <form
          className="mt-1 flex flex-wrap items-center gap-2"
          onSubmit={async (e) => {
            e.preventDefault()
            if (!user.trim()) return
            if (await runTool('add_member', { space, user: user.trim(), role }, `Invited ${user.trim()} to ${space}`)) {
              setUser('')
              reload()
            }
          }}
        >
          <input
            value={user}
            onChange={(e) => setUser(e.target.value)}
            placeholder="@user"
            className="h-8 w-40 rounded-md border border-input bg-transparent px-2 text-sm"
          />
          <Choice
            value={role}
            onChange={setRole}
            options={[
              { value: 'viewer', label: 'viewer' },
              { value: 'editor', label: 'editor' },
              { value: 'admin', label: 'admin' },
            ]}
          />
          <Button type="submit" size="sm" variant="secondary" disabled={!user.trim()}>
            <UserPlusIcon />
            Add member
          </Button>
        </form>
      )}
    </div>
  )
}

export function SharingView({
  onUnauthorized,
  onOpenSpace,
  onNotesChanged,
}: {
  onUnauthorized: () => void
  onOpenSpace: (handle: string) => void
  onNotesChanged: () => void
}) {
  const who = useTool<WhoAmI>('whoami', {}, onUnauthorized)
  const projects = useTool<{ projects: ProjectRow[] }>('list_projects', {}, onUnauthorized)
  const shares = useTool<Shares>('list_shares', {}, onUnauthorized)
  const [open, setOpen] = useState<string | null>(null)
  const [newSpace, setNewSpace] = useState('')

  const reloadAll = () => {
    who.reload()
    projects.reload()
    shares.reload()
  }
  const adminKey = who.data?.key.role === 'admin' || who.data?.key.role === 'super'
  const roleIn = new Map((who.data?.spaces ?? []).map((s) => [s.space, s.role]))
  const writable = (who.data?.spaces ?? [])
    .filter((s) => s.role !== 'viewer' && s.kind !== 'system')
    .map((s) => s.space)
  const manages = (space: string) => adminKey && MANAGES.has(roleIn.get(space) ?? '')

  return (
    <Page
      title="Sharing"
      intro="Your projects and spaces, who can see them, and what other people have shared with you. Every change here is written to the audit log."
    >
      {who.data && <PendingSection who={who.data} onDone={reloadAll} />}

      <Section
        title="Projects"
        intro="Everything you can reach, across your spaces and shares."
        action={who.data && writable.length > 0 && <NewProjectDialog
              spaces={writable}
              onDone={() => {
                projects.reload()
                onNotesChanged()
              }}
            />}
      >
        <div className="overflow-hidden rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Project</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Your access</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead className="text-right" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {projects.data == null ? (
                <Skeletons cols={5} />
              ) : projects.data.projects.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-sm text-muted-foreground">
                    No projects yet.
                  </TableCell>
                </TableRow>
              ) : (
                projects.data.projects.map((p) => (
                  <TableRow key={p.project}>
                    <TableCell className="font-medium">{p.project}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{p.status ?? '—'}</TableCell>
                    <TableCell className="text-xs">{p.access}</TableCell>
                    <TableCell className="text-xs text-muted-foreground tabular-nums">{day(p.updated)}</TableCell>
                    <TableCell className="text-right">
                      {manages(splitProject(p.project).space) && <ShareDialog project={p.project} onDone={shares.reload} />}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </Section>

      <Section title="Shared by you" intro="Projects in spaces you own or admin that other people can reach.">
        {shares.data == null ? (
          <Skeleton className="h-10 w-full" />
        ) : shares.data.shared_by_me.length === 0 ? (
          <Empty>Nothing shared yet. Use Share on a project above.</Empty>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Project</TableHead>
                  <TableHead>With</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead className="text-right" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {shares.data.shared_by_me.map((s) => (
                  <TableRow key={`${s.project}|${s.with}`}>
                    <TableCell className="font-medium">{s.project}</TableCell>
                    <TableCell>{s.with}</TableCell>
                    <TableCell className="text-xs">{s.role}</TableCell>
                    <TableCell>
                      <StatusBadge status={s.status} />
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground tabular-nums">{day(s.expires)}</TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={async () => {
                          if (await runTool('unshare', { project: s.project, with: s.with }, `Stopped sharing ${s.project} with ${s.with}`)) shares.reload()
                        }}
                      >
                        Stop sharing
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Section>

      <Section title="Shared with you" intro="Projects other people gave you. Leaving removes your access.">
        {shares.data == null ? (
          <Skeleton className="h-10 w-full" />
        ) : shares.data.shared_with_me.length === 0 ? (
          <Empty>Nobody has shared a project with you.</Empty>
        ) : (
          <div className="grid gap-2">
            {shares.data.shared_with_me.map((s) => {
              const { space, slug } = splitProject(s.project)
              return (
                <div key={s.project} className="flex items-center gap-3 rounded-lg border border-border px-3 py-2">
                  <span className="text-sm font-medium">{s.project}</span>
                  <Badge variant="outline" className="text-[10px]">
                    {s.role}
                  </Badge>
                  {s.expires && <span className="text-xs text-muted-foreground">until {day(s.expires)}</span>}
                  <Button variant="ghost" size="sm" className="ml-auto h-7 text-xs" onClick={() => onOpenSpace(space)}>
                    Open
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={async () => {
                      if (await runTool('decline', { space, project: slug }, `Left ${s.project}`)) reloadAll()
                    }}
                  >
                    Leave
                  </Button>
                </div>
              )
            })}
          </div>
        )}
      </Section>

      <Section
        title="Spaces"
        intro="A space is a whole brain. Your personal space is yours alone; team spaces have members."
        action={
          adminKey && (
            <FormDialog
              trigger={
                <Button size="sm" variant="secondary">
                  <PlusIcon />
                  New team space
                </Button>
              }
              title="New team space"
              description="You own it and can add members. Up to 5 per person."
              submitLabel="Create space"
              canSubmit={!!newSpace.trim()}
              onOpen={() => setNewSpace('')}
              onSubmit={async () => {
                const r = await runTool('create_space', { handle: newSpace.trim() }, `Created @${newSpace.trim().replace(/^@/, '')}`)
                if (r) who.reload()
                return r ? 'close' : 'stay'
              }}
            >
              <Field id="sp-handle" label="Handle" placeholder="garden-club" value={newSpace} onChange={(e) => setNewSpace(e.target.value.toLowerCase())} hint="2-31 lowercase letters, digits and hyphens. Becomes @handle." />
            </FormDialog>
          )
        }
      >
        <div className="overflow-hidden rounded-lg border border-border">
          {who.data == null ? (
            <Skeleton className="m-3 h-6 w-64" />
          ) : (
            who.data.spaces.map((s) => (
              <div key={s.space} className="border-b border-border last:border-b-0">
                <div className="flex items-center gap-2 px-3 py-2">
                  <button
                    type="button"
                    className="flex min-w-0 items-center gap-1.5 text-sm font-medium"
                    onClick={() => setOpen(open === s.space ? null : s.space)}
                    aria-expanded={open === s.space}
                  >
                    <ChevronRightIcon className={cn('size-3.5 transition-transform', open === s.space && 'rotate-90')} />
                    {s.space}
                  </button>
                  <Badge variant="outline" className="text-[10px]">
                    {s.role}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {s.kind} · {s.backing === 'git' ? 'git repo' : 'hosted, encrypted'}
                  </span>
                  <div className="ml-auto flex gap-1">
                    <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => onOpenSpace(s.space)}>
                      Open
                    </Button>
                    {s.backing === 'hosted' && manages(s.space) && (
                      <ExportButton space={s.space} />
                    )}
                  </div>
                </div>
                {open === s.space && (
                  <MembersPanel space={s.space} manage={manages(s.space) && s.kind !== 'system'} onUnauthorized={onUnauthorized} />
                )}
              </div>
            ))
          )}
        </div>
      </Section>
    </Page>
  )
}

function ExportButton({ space }: { space: string }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-7 text-xs"
      title="Download every note in this space as JSON. The link works once, for an hour."
      onClick={async () => {
        const r = await runTool<{ url: string; notes: number }>('export_space', { space })
        if (r) {
          toast.success(`Downloading ${r.notes} notes from ${space}`)
          window.location.assign(r.url)
        }
      }}
    >
      <DownloadIcon />
      Export
    </Button>
  )
}
