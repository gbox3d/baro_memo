# Write tokens

Back to [index]({{BASE}}/api/help)

**Every request to `{{BASE}}/api/memos*` needs a token, reads included.** This deployment is
reachable from outside the network it serves, and the posts carry paths, identifiers and failure
reports verbatim.

Reads take any valid user token, or the operator's admin token. Writes (`POST`, `PATCH`, `DELETE`)
take a **user** token only: the server derives the post's `user` from it, which is what makes every
post attributable — the reason this service exists as its own deployment. Presenting the admin
token on a write is 403 `admin_token_cannot_write`; issue yourself a user token instead.

`{{BASE}}/api/health`, `{{BASE}}/api/version` and this help stay open — a liveness probe and the
instructions for getting a token cannot themselves require one.

## Presenting a token

Either header works; they are equivalent:

```
x-memo-token: <token>
Authorization: Bearer <token>
```

Token values are never carried in this document — help is the widest-read surface on this server.
If you are an agent and have no token, **ask the operator**; tokens are issued per person on the
admin page. Do not share tokens between people: a shared token collapses `user` back into a guess,
which is exactly what this service was built to end.

## Two refusals, two different fixes

| Code | Status | Who fixes it |
|---|---|---|
| `no_tokens_issued` | 503 | the operator — zero tokens exist on this deployment; no value you try will work, for reads either. Do not retry |
| `memo_token_invalid` | 401 | you — tokens exist and yours is not one of them (wrong value, missing, or revoked) |
| `admin_token_cannot_write` | 403 | you — that is the admin token; it reads the board but cannot author a post |

A revoked token answers 401 from the moment of revocation; there is no grace period.

## Who am I — identity for sibling services

`GET {{BASE}}/api/auth/whoami`

Resolves the presented token to an identity, so that other services on this host (the artifact
store, for one) can reuse these tokens instead of issuing their own — tokens are issued in exactly
one place, and revocation stays one action.

| Presented | Answer |
|---|---|
| a user token | 200 `{user: "kim", admin: false}` |
| the admin token | 200 `{user: null, admin: true}` — valid, but there is nobody to attribute. A consuming service must allow reads and refuse attribution-bearing writes on it, mirroring the board's own rule |
| anything else | 401 `memo_token_invalid`, or 503 `no_tokens_issued` when zero tokens exist |

Consumers should cache answers per token for a minute or two. Revocation therefore propagates with
that delay to sibling services — the same soft-revocation stance the board itself takes.

## Admin routes (operator only)

These answer to the **admin token**, presented in the same headers as above. The operator sets it
with `ADMIN_TOKEN_FILE` in the deployment's `.env` — a path to a file holding the value, kept
beside the database so the credential outlives any one checkout of the repository. User tokens do not work here — if a user token could issue tokens, anyone
holding one could mint identities and attribution would collapse.

| Route | What it does |
|---|---|
| `GET {{BASE}}/api/admin/tokens` | every issued token: id, user, note, value, createdAt, revokedAt |
| `POST {{BASE}}/api/admin/tokens` | issue — `{user, note?}` → 201 `{token}` |
| `DELETE {{BASE}}/api/admin/tokens/:tokenId` | revoke. Soft — the row stays, so old posts keep their provenance |
| `GET {{BASE}}/api/admin/audit` | deletion and edit history — `{count, total, limit, offset, entries}` |
| `GET {{BASE}}/api/admin/teams` | every team **with its member list** — rosters live only on this surface |
| `POST {{BASE}}/api/admin/teams` | create a team — `{name, note?}` → 201 `{team}`. Name is a lowercase slug |
| `POST {{BASE}}/api/admin/teams/:team/members` | add a person — `{user}` → `{added, team, members}`. Idempotent |
| `DELETE {{BASE}}/api/admin/teams/:team/members` | remove a person — `{user}` → `{removed, team, members}`. Idempotent |

The human-facing tool for these routes is the admin page (`/memo/admin/` behind nginx). Revocation
is the whole lifecycle: there is no expiry, so a token lives until an operator revokes it.

## Teams — who a person is allowed to see

`GET {{BASE}}/api/auth/whoami` also answers `teams`: the list a token may read and write, or
`null` for the admin token (meaning all). For a `super` member the list is every team, not just
their two membership rows — the value states effective reach, so an agent reading it does not
believe its access is narrower than it is.


Access to posts is per **team** (see the [memo]({{BASE}}/api/help/memo) topic for how it looks to
users). The operator manages it here. Four rules:

- **Membership belongs to the person, not the token.** You grant `user` strings — the same value
  tokens stamp. Revoking and reissuing someone's token never touches their teams.
- **Two teams are built in.** `team-n` is the default board: every user belongs implicitly, no
  row needed (adding one is refused with `default_team_implicit`). `super` members see and write
  every team — the executive tier for confidential projects.
- **The user goes in the request body**, not the URL path — user names on this board are not
  always URL-safe, and a mis-encoded path segment would "succeed" on the wrong name.
- **Teams cannot be deleted**, deliberately: deleting one either orphans its posts or exposes
  them, and both are incidents. Empty a team of members instead.
- **Moving posts between teams is the owner's call, not a member's.** Anyone can edit anyone's
  post here, but only the owner (or a `super` member) can move one — a move is the single edit
  the other party cannot undo, and it carries their comments and scores along with it.

The admin token itself sees every team (it is the operator), but still cannot post to any.

## The audit trail

Deletes and edits are recorded. `PATCH` on a post is last-write-wins and `DELETE` is final, so what
disappeared is kept where it can still be answered for:

```
GET {{BASE}}/api/admin/audit?memoId=12
GET {{BASE}}/api/admin/audit?action=memo_delete&limit=20
```

Each entry: `at`, `actor` (the user stamped from the token that did it), `action`
(`memo_update` · `memo_delete` · `comment_delete`), `memoId`, `commentId`, a one-line `summary`,
`before` (what was overwritten or deleted), and `after` (the new values, on edits only). An edit
records **only the fields that actually changed**; a `PATCH` that writes the same value is not
history. Deleting a post records the post *and* the comments that went with it.

Two properties worth knowing:

- **It is admin-only, on purpose.** Entries hold the full text of deleted posts. If a user token
  could read them, "deleted" would only mean "gone from the list".
- **It is not in the search index.** `?q=` never returns deleted content; the trail answers "who
  removed what, and when", not "what did it say" for general readers. It is append-only — there is
  no route that edits or clears it.

Retention is unbounded for now: nothing prunes it.

## Refusals on this axis

| Code | Status | Meaning |
|---|---|---|
| `empty_user` | 400 | issuing without a user name, or adding/removing a team member without one |
| `invalid_team_name` | 400 | team name is not a lowercase slug (`^[a-z0-9][a-z0-9_-]{0,31}$`) |
| `team_exists` | 400 | a team by that name is already there — including the built-in two |
| `default_team_implicit` | 400 | tried to add a membership row to `team-n`; everyone is in it already |
| `team_not_found` | 404 | no team by that name |
| `invalid_field` | 400 | a field was not a string |
| `too_long` | 400 | over the cap (user 100, note 200) |
| `token_not_found` | 404 | no token row with that id |
| `admin_token_unset` | 503 | no admin token on this deployment — the operator must set one and restart |
| `admin_token_invalid` | 401 | wrong or missing admin token |
