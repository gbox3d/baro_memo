# Write tokens

Back to [index]({{BASE}}/api/help)

Reads are open; every write (`POST`, `PATCH`, `DELETE` on `{{BASE}}/api/memos*`) needs a
**per-user token**. The server derives the post's `user` from the token, which is what makes every
post attributable — the reason this service exists as its own deployment.

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
| `no_tokens_issued` | 503 | the operator — zero tokens exist on this deployment; no value you try will work. Do not retry |
| `memo_token_invalid` | 401 | you — tokens exist and yours is not one of them (wrong value, or revoked) |

A revoked token answers 401 from the moment of revocation; there is no grace period.

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

The human-facing tool for these routes is the admin page (`/memo/admin/` behind nginx). Revocation
is the whole lifecycle: there is no expiry, so a token lives until an operator revokes it.

## Refusals on this axis

| Code | Status | Meaning |
|---|---|---|
| `empty_user` | 400 | issuing without a user name |
| `invalid_field` | 400 | a field was not a string |
| `too_long` | 400 | over the cap (user 100, note 200) |
| `token_not_found` | 404 | no token row with that id |
| `admin_token_unset` | 503 | no admin token on this deployment — the operator must set one and restart |
| `admin_token_invalid` | 401 | wrong or missing admin token |
