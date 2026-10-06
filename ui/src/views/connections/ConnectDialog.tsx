import { useState } from 'react'
import { PlusIcon } from 'lucide-react'

import { attempt, gw, type AuthKind, type ConnectionInput, type Sensitivity, type Trust } from '@/lib/gateway'
import { Choice, Field, FormDialog } from '@/components/form-dialog'
import { Banner, Check, ChipsInput } from '@/components/gateway'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'

const AUTH_OPTIONS: { value: AuthKind; label: string; hint: string }[] = [
  { value: 'oauth', label: 'OAuth', hint: 'Sign in at the provider' },
  { value: 'bearer', label: 'Bearer token', hint: 'Authorization: Bearer <token>' },
  { value: 'header', label: 'Custom header', hint: 'A token sent in a header you name' },
  { value: 'none', label: 'None', hint: 'No credential (public server or bridge://)' },
]

const blank = (): ConnectionInput => ({
  service: '',
  label: '',
  url: '',
  auth: 'oauth',
  trust: 'untrusted',
  sensitivity: 'private',
  grant_read: true,
})

export function ConnectDialog({
  vaultReady,
  onDone,
  trigger,
}: {
  vaultReady: boolean
  onDone: () => void
  trigger?: React.ReactNode
}) {
  const [f, setF] = useState<ConnectionInput>(blank)
  const [defaults, setDefaults] = useState<string[]>([])
  const [ownApp, setOwnApp] = useState(false)
  const set = (patch: Partial<ConnectionInput>) => setF((v) => ({ ...v, ...patch }))
  const needsSecret = f.auth === 'bearer' || f.auth === 'header'
  const ready =
    !!f.service.trim() &&
    !!f.label.trim() &&
    !!f.url.trim() &&
    (!needsSecret || !!f.secret) &&
    (f.auth !== 'header' || !!f.header_name?.trim())

  return (
    <FormDialog
      trigger={
        trigger ?? (
          <Button size="sm">
            <PlusIcon />
            Connect account
          </Button>
        )
      }
      title="Add an app by URL"
      description="For any MCP server that is not in the directory. It is named service_label, e.g. figma_rtp; several accounts of one service each get their own label."
      submitLabel={f.auth === 'oauth' ? 'Continue to sign in' : 'Connect'}
      canSubmit={ready}
      onOpen={() => {
        setF(blank())
        setDefaults([])
        setOwnApp(false)
      }}
      onSubmit={async () => {
        const input: ConnectionInput = {
          ...f,
          service: f.service.trim().toLowerCase(),
          label: f.label.trim().toLowerCase(),
          url: f.url.trim(),
          ...(defaults.length ? { default_for: defaults.map((d) => (d.startsWith('project:') ? d : `project:${d}`)) } : {}),
        }
        if (!needsSecret) delete input.secret
        if (f.auth !== 'header') delete input.header_name
        if (f.auth !== 'oauth' || !ownApp) {
          delete input.client_id
          delete input.client_secret
          delete input.scope
        }
        const r = await attempt(() => gw.createConnection(input))
        if (!r) return 'stay'
        onDone()
        if (r.authorize_url) {
          window.location.href = r.authorize_url
          return 'stay'
        }
        return {
          show: r.warning ? (
            <Banner>{r.warning}</Banner>
          ) : (
            <div className="grid gap-2 text-sm">
              <p>
                Connected <b className="font-mono">{r.connection}</b>.
                {r.synced && ` ${r.synced.tools} tools found and approved.`}
              </p>
              {!!r.synced?.added.length && (
                <Banner>
                  {r.synced.added.length} held for review because the description looks like it gives instructions:{' '}
                  <span className="font-mono">{r.synced.added.join(', ')}</span>. Open the connection to read them.
                </Banner>
              )}
              <p className="text-xs text-muted-foreground">
                {f.grant_read !== false
                  ? 'All your agents may now use its read tools. Add a rule for anything that writes.'
                  : 'No agent may use it until a rule permits it.'}
              </p>
            </div>
          ),
        }
      }}
    >
      {!vaultReady && <Banner>Set the VAULT_KEK secret before connecting accounts that need credentials.</Banner>}
      <div className="grid grid-cols-2 gap-3">
        <Field id="c-service" label="Service" placeholder="figma" value={f.service} onChange={(e) => set({ service: e.target.value })} />
        <Field id="c-label" label="Label" placeholder="rtp" value={f.label} onChange={(e) => set({ label: e.target.value })} />
      </div>
      <Field
        id="c-url"
        label="Server URL"
        placeholder="https://mcp.figma.com/mcp"
        value={f.url}
        onChange={(e) => set({ url: e.target.value })}
        hint="An https MCP endpoint, or bridge://<machine>/<server> for a local server."
      />
      <div className="grid gap-1.5">
        <Label>Sign-in</Label>
        <Choice value={f.auth} options={AUTH_OPTIONS} onChange={(auth) => set({ auth })} />
      </div>
      {f.auth === 'header' && (
        <Field id="c-header" label="Header name" placeholder="X-API-Key" value={f.header_name ?? ''} onChange={(e) => set({ header_name: e.target.value })} />
      )}
      {needsSecret && (
        <Field id="c-secret" label="Token" type="password" autoComplete="off" value={f.secret ?? ''} onChange={(e) => set({ secret: e.target.value })} />
      )}
      {f.auth === 'oauth' && (
        <div className="grid gap-3">
          <Check checked={ownApp} onChange={setOwnApp}>
            Use my own OAuth app
          </Check>
          {ownApp && (
            <div className="grid grid-cols-2 gap-3">
              <Field id="c-cid" label="Client ID" value={f.client_id ?? ''} onChange={(e) => set({ client_id: e.target.value })} />
              <Field id="c-csec" label="Client secret" type="password" autoComplete="off" value={f.client_secret ?? ''} onChange={(e) => set({ client_secret: e.target.value })} />
              <Field id="c-scope" label="Scope" placeholder="optional" value={f.scope ?? ''} onChange={(e) => set({ scope: e.target.value })} />
            </div>
          )}
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field id="c-account" label="Account" placeholder="you@company.com" value={f.account ?? ''} onChange={(e) => set({ account: e.target.value })} />
        <Field id="c-ws" label="Workspace" placeholder="optional" value={f.workspace ?? ''} onChange={(e) => set({ workspace: e.target.value })} />
      </div>
      <TrustFields trust={f.trust ?? 'untrusted'} sensitivity={f.sensitivity ?? 'private'} onChange={set} />
      <div className="grid gap-1.5">
        <Label htmlFor="c-defaults">Default for projects</Label>
        <ChipsInput id="c-defaults" value={defaults} onChange={setDefaults} placeholder="rtp-* (optional)" />
      </div>
      <Check checked={f.grant_read !== false} onChange={(grant_read) => set({ grant_read })}>
        Let all my agents use its read tools
      </Check>
    </FormDialog>
  )
}

export function TrustFields({
  trust,
  sensitivity,
  onChange,
}: {
  trust: Trust
  sensitivity: Sensitivity
  onChange: (patch: { trust?: Trust; sensitivity?: Sensitivity }) => void
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="grid gap-1.5">
        <Label>Output</Label>
        <Choice
          value={trust}
          options={[
            { value: 'untrusted', label: 'Untrusted', hint: 'Content from outsiders (email, web)' },
            { value: 'trusted', label: 'Trusted', hint: 'Only you or your team write it' },
          ]}
          onChange={(trust) => onChange({ trust })}
        />
      </div>
      <div className="grid gap-1.5">
        <Label>Data</Label>
        <Choice
          value={sensitivity}
          options={[
            { value: 'private', label: 'Private' },
            { value: 'public', label: 'Public' },
          ]}
          onChange={(sensitivity) => onChange({ sensitivity })}
        />
      </div>
    </div>
  )
}
