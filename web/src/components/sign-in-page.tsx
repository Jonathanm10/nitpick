import { useState, type FormEvent } from "react"
import type { YouTrackUser } from "@nitpick/core"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Spinner } from "@/components/ui/spinner"
import { api } from "@/lib/api"

/**
 * Sign-in with the Reviewer's YouTrack permanent token, which the server
 * checks with YouTrack. The token leaves the page once, in the sign-in
 * request; afterwards the page holds only the server's HttpOnly cookie.
 */
export function SignInPage({
  notice,
  onSignedIn,
}: {
  /** Why the Reviewer is back here, e.g. YouTrack rejected their token. */
  readonly notice?: string
  readonly onSignedIn: (reviewer: YouTrackUser) => void
}) {
  const [token, setToken] = useState("")
  const [error, setError] = useState<string>()
  const [isSigningIn, setIsSigningIn] = useState(false)
  const isEmpty = token.trim() === ""

  function signIn(event: FormEvent) {
    event.preventDefault()
    if (isEmpty || isSigningIn) return
    setIsSigningIn(true)
    setError(undefined)
    api.signIn(token).then(
      ({ reviewer }) => {
        setToken("")
        onSignedIn(reviewer)
      },
      (refusal: unknown) => {
        setError(
          refusal instanceof Error
            ? refusal.message
            : "The token couldn't be checked."
        )
        setIsSigningIn(false)
      }
    )
  }

  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Sign in to nitpick</CardTitle>
          <CardDescription>
            Use your YouTrack permanent token. Your Issues and Feedback are
            filed as you.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form method="post" className="flex flex-col gap-3" onSubmit={signIn}>
            {notice !== undefined && error === undefined && (
              <Alert>
                <AlertDescription className="select-text">
                  {notice}
                </AlertDescription>
              </Alert>
            )}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="youtrack-token">Permanent token</Label>
              <Input
                id="youtrack-token"
                type="password"
                autoComplete="off"
                spellCheck={false}
                autoFocus
                value={token}
                aria-invalid={error !== undefined}
                aria-describedby="youtrack-token-hint"
                onChange={(event) => setToken(event.target.value)}
              />
              <p
                id="youtrack-token-hint"
                className="text-xs text-muted-foreground"
              >
                Create one in YouTrack: your profile, Account Security, New
                token.
              </p>
            </div>
            {error !== undefined && (
              <p role="alert" className="text-sm text-destructive select-text">
                {error}
              </p>
            )}
            <Button type="submit" disabled={isEmpty || isSigningIn}>
              {isSigningIn && <Spinner />}
              Sign in
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  )
}
