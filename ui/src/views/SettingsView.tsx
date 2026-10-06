import { BellIcon, BookOpenIcon, KeyRoundIcon, ScaleIcon, ShieldIcon, UserIcon, UsersIcon } from 'lucide-react'

import type { Me } from '@/lib/api'
import { useGuides } from '@/lib/guides'
import { PageIntro } from '@/components/guides'
import { SubNav } from '@/components/subnav'
import { AccountView } from '@/views/AccountView'
import { KeysView } from '@/views/KeysView'
import { SharingView } from '@/views/SharingView'
import { AdminView } from '@/views/AdminView'
import { RulesView } from '@/views/RulesView'
import { NotificationsView } from '@/views/settings/NotificationsView'
import { GuidesView } from '@/views/settings/GuidesView'

export type SettingsTab = 'account' | 'keys' | 'sharing' | 'notifications' | 'rules' | 'admin' | 'guides'
export const SETTINGS_TABS: SettingsTab[] = ['account', 'keys', 'sharing', 'notifications', 'rules', 'admin', 'guides']

export function settingsTabsFor(me: Me | null): SettingsTab[] {
  return SETTINGS_TABS.filter((t) => {
    if (t === 'keys') return !!me?.root_admin
    if (t === 'admin') return !!me?.super_user
    if (t === 'sharing' || t === 'notifications' || t === 'rules') return !!me?.user
    return true
  })
}

const LABELS: Record<SettingsTab, { label: string; icon: React.ComponentType<{ className?: string }> }> = {
  account: { label: 'Account', icon: UserIcon },
  keys: { label: 'Access keys', icon: KeyRoundIcon },
  sharing: { label: 'Project sharing', icon: UsersIcon },
  notifications: { label: 'Notifications', icon: BellIcon },
  rules: { label: 'Advanced rules', icon: ScaleIcon },
  admin: { label: 'Admin', icon: ShieldIcon },
  guides: { label: 'Guides', icon: BookOpenIcon },
}

export function SettingsView({
  me,
  tab,
  onTab,
  pendingShares,
  onOpenSpace,
  onNotesChanged,
  onWelcome,
  onUnauthorized,
}: {
  me: Me
  tab: SettingsTab
  onTab: (t: SettingsTab) => void
  pendingShares: number
  onOpenSpace: (handle: string) => void
  onNotesChanged: () => void
  onWelcome: () => void
  onUnauthorized: () => void
}) {
  const guides = useGuides()
  const tabs = settingsTabsFor(me)
  const current = tabs.includes(tab) ? tab : 'account'
  return (
    <div className="flex h-full flex-col">
      <SubNav
        label="Settings"
        value={current}
        onChange={onTab}
        items={tabs.map((t) => ({ id: t, ...LABELS[t], badge: t === 'sharing' ? pendingShares : undefined }))}
      />
      {!guides.introHidden('settings') && (
        <div className="shrink-0 px-4 pt-4 lg:px-6">
          <PageIntro page="settings" onAction={me.user ? () => onTab('notifications') : undefined} />
        </div>
      )}
      <div className="min-h-0 flex-1">
        {current === 'account' && <AccountView me={me} onUnauthorized={onUnauthorized} />}
        {current === 'keys' && <KeysView onUnauthorized={onUnauthorized} />}
        {current === 'sharing' && (
          <SharingView onOpenSpace={onOpenSpace} onNotesChanged={onNotesChanged} onUnauthorized={onUnauthorized} />
        )}
        {current === 'notifications' && <NotificationsView onUnauthorized={onUnauthorized} />}
        {current === 'rules' && <RulesView onUnauthorized={onUnauthorized} />}
        {current === 'admin' && <AdminView me={me} onOpenSpace={onOpenSpace} onUnauthorized={onUnauthorized} />}
        {current === 'guides' && <GuidesView onWelcome={onWelcome} />}
      </div>
    </div>
  )
}
