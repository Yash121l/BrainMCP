import { useState } from 'react'
import { Loader2Icon, KeyRoundIcon } from 'lucide-react'

import { login } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

export function Login() {
  const [key, setKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!key.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      const err = await login(key.trim())
      if (err) {
        setError(err)
        setBusy(false)
        return
      }
      window.location.reload()
    } catch {
      setError('could not reach the brain')
      setBusy(false)
    }
  }

  return (
    <div className="relative flex min-h-svh items-center justify-center p-6">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.35] [background:radial-gradient(60rem_40rem_at_50%_-10%,theme(colors.zinc.700),transparent)]"
      />
      <form onSubmit={onSubmit} className="relative w-full max-w-sm">
        <Card>
          <CardHeader>
            <div className="mb-1 flex items-center gap-2 text-lg font-semibold tracking-tight">
              <span aria-hidden>🧠</span> brain
            </div>
            <CardTitle className="text-base">Sign in</CardTitle>
            <CardDescription>
              Use the key from your invite, or any key you made since. You see your own space and
              whatever has been shared with you.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <div className="grid gap-2">
              <Label htmlFor="access_key">Access key</Label>
              <Input
                id="access_key"
                name="access_key"
                type="password"
                autoFocus
                autoComplete="current-password"
                placeholder="bk_…"
                value={key}
                onChange={(e) => {
                  setKey(e.target.value)
                  if (error) setError(null)
                }}
                aria-invalid={!!error}
              />
            </div>
            {error && (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            )}
          </CardContent>
          <CardFooter>
            <Button type="submit" className="w-full" disabled={busy || !key.trim()}>
              {busy ? (
                <Loader2Icon className="animate-spin" />
              ) : (
                <KeyRoundIcon />
              )}
              Enter
            </Button>
          </CardFooter>
        </Card>
        <p className="mt-4 text-center text-xs text-muted-foreground">
          Super admin: sign in with your super key to open the Admin console.
        </p>
      </form>
    </div>
  )
}
