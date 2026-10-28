# Reviewers sign in through YouTrack's login, and each sees only their own History

After trying the deployed web app, the user asked for two changes to what ADR-0012 and the PRD's answers 1 and 2 settled. A Reviewer's History must not be mixed with other Reviewers'. And Reviewers should sign in with YouTrack's own login, the company's single sign-on, rather than paste a permanent token.

## Decision

- **History is each Reviewer's own.** `GET /api/history` returns only the entries the signed-in Reviewer filed (`filedBy`), and only they see an entry they imported. The server still keeps every Reviewer's entries in one `history/` folder, each file named by its filer, so nothing on disk moves. An entry without a filer is in no Reviewer's History. A Swift app History file that is already in one Reviewer's History still imports into another's. This replaces PRD answer 2 and the "become shared" part of ADR-0012. Open Review Sessions were already each Reviewer's own (PRD answer 5).
- **Sign-in through YouTrack's Hub.** YouTrack has a Hub service built in at `<instance>/hub`, which is an OAuth 2.0 authorization server. nitpick registers there as a service (a client). The page's "Sign in with YouTrack" button runs the authorization code flow: PKCE with S256, scope `YouTrack`, and `access_type=offline`. The state and the code verifier stay in an HttpOnly cookie that only the callback route reads. A code returned to a browser that didn't start that sign-in therefore signs no one in. The server exchanges the code for tokens, asks YouTrack's `api/users/me` who the Reviewer is, and starts the same sign-in a token starts. The cookie, the sliding month and sign-out are unchanged.
- **The tokens live where the permanent token lived.** Hub's access token lasts about an hour. The server seals the access token and the refresh token in the sign-in's file with the existing key. It renews them a minute before they expire, one renewal at a time per sign-in, and seals any new refresh token before using it. Filing can therefore still resume after a restart. If Hub no longer accepts the refresh token, the sign-in ends with a message, and the open Review Session stays.
- **Token sign-in stays as the fallback.** It applies when no Hub client is configured (`NITPICK_YOUTRACK_CLIENT_ID`, plus `NITPICK_YOUTRACK_CLIENT_SECRET` for a confidential client). It also keeps working for scripts and proof harnesses. The page offers one method: the YouTrack button when nitpick is registered with Hub, the token form otherwise.

## Considered Options

- **Keep permanent tokens.** Rejected: every Reviewer has to create a token and paste it, which is the friction the user asked to remove.
- **The implicit flow in the browser.** Rejected: JetBrains deprecates it, Hub issues no refresh token for it, and the token would sit in the page. That breaks issue 10's rule that no token reaches the browser.
- **A login of nitpick's own.** Rejected: YouTrack already knows the Reviewers, and filing needs a YouTrack token anyway.
- **Keep the state and verifier in server memory.** Rejected: unauthenticated requests could fill that memory, and a restart would lose sign-ins in progress. A short-lived HttpOnly cookie scoped to the callback path avoids both.

## Consequences

- A YouTrack administrator registers nitpick once, with its callback URL as a redirect URI (`docs/operations.md`). Until then, Reviewers sign in with tokens as before.
- The registered redirect URI must match the address Reviewers open. A second address, or HTTPS later on, needs its own redirect URI.
- The client secret is host config, kept outside the repo like the rest of `server.env`.
- `YouTrackCredentials` in core now takes either a token or a function that returns the current token. Only the server knows how a token renews.
