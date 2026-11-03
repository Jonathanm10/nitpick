import { useEffect, useState, type FormEvent } from "react"
import type { YouTrackUser } from "@nitpick/core"
import type { SignInMethodResponse } from "@nitpick/server/api"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button, buttonVariants } from "@/components/ui/button"
import { LogoMark } from "@/components/studio"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Spinner } from "@/components/ui/spinner"
import { api } from "@/lib/api"

/** What `?sign-in=` says when YouTrack's login sent the browser back unsigned. */
const youTrackSignInErrors = new Map([
  ["denied", "YouTrack didn't give nitpick access, so you're not signed in."],
  [
    "expired",
    "That sign-in took too long, or another one started since. Try again.",
  ],
  [
    "failed",
    "YouTrack couldn't sign you in. Try again; if it keeps failing, ask whoever runs nitpick to check its registration in YouTrack.",
  ],
])

function youTrackSignInError(): string | undefined {
  const code = new URLSearchParams(window.location.search).get("sign-in")
  if (code === null) return undefined
  return youTrackSignInErrors.get(code) ?? youTrackSignInErrors.get("failed")
}

/**
 * Sign-in through YouTrack's own login when nitpick is registered with
 * YouTrack's Hub; otherwise with the Reviewer's YouTrack permanent token,
 * which the server checks with YouTrack. The token leaves the page once, in
 * the sign-in request; afterwards the page holds only the server's HttpOnly
 * cookie.
 */
export function SignInPage({
  notice,
  onSignedIn,
}: {
  /** Why the Reviewer is back here, e.g. YouTrack rejected their token. */
  readonly notice?: string
  readonly onSignedIn: (reviewer: YouTrackUser) => void
}) {
  const [method, setMethod] = useState<SignInMethodResponse["method"]>()
  const [token, setToken] = useState("")
  const [error, setError] = useState(youTrackSignInError)
  const [isSigningIn, setIsSigningIn] = useState(false)
  const isEmpty = token.trim() === ""

  useEffect(() => {
    // Read once: a reload shouldn't say it again.
    if (new URLSearchParams(window.location.search).has("sign-in")) {
      window.history.replaceState(
        null,
        "",
        window.location.pathname + window.location.hash
      )
    }
    api.signInMethod().then(
      (response) => setMethod(response.method),
      () => setMethod("token")
    )
  }, [])

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

  const notices = (
    <>
      {notice !== undefined && error === undefined && (
        <Alert>
          <AlertDescription className="select-text">{notice}</AlertDescription>
        </Alert>
      )}
      {error !== undefined && (
        <p role="alert" className="text-sm text-destructive select-text">
          {error}
        </p>
      )}
    </>
  )

  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-6 canvas-dots p-6">
      <div className="flex w-full max-w-[360px] flex-col gap-5">
        <div className="flex flex-col items-center gap-3 text-center">
          <LogoMark size={44} />
          <div>
            <h1 className="text-[17px] font-semibold tracking-[-0.01em]">
              Sign in to nitpick
            </h1>
            <p className="mt-1 text-[12.5px] text-text-2">
              {method === "youTrack"
                ? "Use your YouTrack account."
                : "Use your YouTrack permanent token."}{" "}
              Your Issues and Feedback are filed as you.
            </p>
          </div>
        </div>
        <div className="rounded-[14px] p-4 studio-card">
          {method === undefined ? (
            <div className="flex justify-center py-2">
              <Spinner aria-label="Loading" />
            </div>
          ) : method === "youTrack" ? (
            <div className="flex flex-col gap-3">
              {notices}
              {/* A link: the server sends the browser on to YouTrack. */}
              <a
                href="/api/sign-in/youtrack"
                className={buttonVariants({ className: "h-9 w-full" })}
              >
                Sign in with YouTrack
              </a>
            </div>
          ) : (
            <form
              method="post"
              className="flex flex-col gap-3"
              onSubmit={signIn}
            >
              {notice !== undefined && error === undefined && (
                <Alert>
                  <AlertDescription className="select-text">
                    {notice}
                  </AlertDescription>
                </Alert>
              )}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="youtrack-token" className="studio-label">
                  Permanent token
                </Label>
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
                  className="text-[11.5px] text-text-3"
                >
                  Create one in YouTrack: your profile, Account Security, New
                  token.
                </p>
              </div>
              {error !== undefined && (
                <p
                  role="alert"
                  className="text-sm text-destructive select-text"
                >
                  {error}
                </p>
              )}
              <Button
                type="submit"
                className="h-9"
                disabled={isEmpty || isSigningIn}
              >
                {isSigningIn && <Spinner />}
                Sign in
              </Button>
            </form>
          )}
        </div>
        <p className="text-center font-mono text-[10.5px] text-text-3">
          nitpick {__NITPICK_VERSION__}
        </p>
      </div>
    </main>
  )
}
