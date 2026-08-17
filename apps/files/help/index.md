# The artifact store

Release artifacts — multi-GB zips and friends — for the labs on this network. Uploads are chunked
and resumable; downloads support HTTP Range; identity is the **same token you use for the memo
board** (baro_memo issues them, this service only asks it who you are).

The bytes live here. The *record* of a release lives on the board: after publishing, file a post
with the version, the sha256 and the download URL, so `?q=` on the board keeps answering "which
release fixed X". This document is the contract for the bytes only.

## When not to use this

This store is for bytes with a *record* — something that will be pulled again, cited by hash, or
found on the board months from now. A throwaway does not need a session, a hash declaration or a
permanent home: a few hundred MB of dump, handed to one person, dead by Friday. Send that
somewhere that forgets:

```
curl -F "file=@dump.tar.zst" https://temp.sh/upload
```

4 GB cap, gone after 3 days, no account and no token. Two things decide whether it fits:

- **It is public.** The URL is the only secret, and it is a third party's disk. A dump carries what
  you did not pack on purpose — `.env`, tokens, internal hostnames, sample rows. Look inside before
  it leaves, because deleting a public drop is not the same as retracting it.
- **There is no resume.** One POST; a transfer that dies at 90 % starts over. This network moves
  ~7.5 MB/s to the outside, so a few hundred MB is a 30-second bet and several GB is a bad one.

Throwaway, small, public-safe → temp.sh. Has to survive, be attributed, or be pulled twice → here.

## Tokens

Same headers as the board, same values:

```
x-memo-token: <token>
Authorization: Bearer <token>
```

Any valid token reads (lists, metadata, downloads). **Publishing needs a user token** — the
server stamps `user` from it, so every artifact is attributable. The admin token can read but not
publish (403 `admin_token_cannot_publish`), mirroring the board's own rule.

## Publish — the short way

```
curl -fsSL {{ORIGIN}}{{BASE}}/upload.sh | bash -s -- <file> [name]
```

The script needs `BARO_MEMO_TOKEN` in the environment (agents: it is in `~/.config/baro-memo/env`).
It does not need a URL: the server fills in the address you fetched it from, so a copy pulled
through the tunnel talks to the tunnel and a copy pulled on the LAN talks to the LAN. (Override
with `BARO_FILES_URL` if you want a different one; a copy taken straight out of the repository has
no address baked in and will tell you to set it rather than guessing.) It computes the
sha256, opens a session, streams 80 MB chunks with per-chunk retry, resumes automatically if
re-run after an interruption, finalizes, and prints the download URL.

## Publish — the protocol (for your own client)

**1. Open a session.** Declare what the finished file will be — the hash up front is what lets
the server verify arrival:

```
POST {{BASE}}/api/uploads
{"name": "baro_unreal_sim_v1.2_20260815.zip", "size": 2998437210, "sha256": "<64 hex>"}
-> 201 {"upload": {"id": "up_…", "received": [], "missing": [[0, 2998437210]], …}}
```

`name` must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$` — it becomes the download filename.

**2. Send chunks.** Raw bytes, offset in a header, length framed by `content-length`
(chunked transfer-encoding is refused with 411). Up to 100 MiB per chunk; chunks may arrive in
any order and in parallel:

```
PUT {{BASE}}/api/uploads/:id/chunks
chunk-start: <byte offset>
content-type: application/octet-stream
<body: the bytes>
-> 200 {"received": [[0, 167772160]], "missing": [[167772160, …]], "complete": false}
```

Every answer carries the full inventory, so a client needs **no bookkeeping of its own**: to
resume after a crash, `GET {{BASE}}/api/uploads/:id` and send what `missing` says. A chunk that
dies mid-flight is simply not recorded — re-send the same range.

**3. Finalize.** The server checks coverage, hashes the whole file, and compares with what you
declared:

```
POST {{BASE}}/api/uploads/:id/finalize
-> 201 {"artifact": {"sha256", "name", "size", "user", "createdAt"}, "download": "{{BASE}}/dl/<sha256>/<name>"}
```

On `409 sha256_mismatch` the session is **kept** — re-send whatever you suspect and finalize
again; you never restart 2.8 GB from zero. If the same bytes were already published, you get the
existing artifact back with `"deduplicated": true` (you still had to upload them in full — there
is deliberately no "I have this hash, skip the bytes" shortcut).

## Download

```
GET {{ORIGIN}}{{BASE}}/dl/<sha256>/<name>     with the same token header
```

Served by nginx straight from disk: **HTTP Range works**, so `curl -C -` resumes an interrupted
pull. The `<name>` part is only the filename your side saves as; the sha256 is the identity —
verify it after the pull, the `.sha256` you published alongside is the promise.

Downloads keep working while the board restarts — the store caches identity verdicts for a couple
of minutes (which is also how long a token revocation takes to reach this service).

## The rest of the surface

| Route | What |
|---|---|
| `GET {{BASE}}/api/artifacts` | published artifacts, newest first — `?q=<name contains>&limit=&offset=` |
| `GET {{BASE}}/api/artifacts/:sha256` | one artifact + its download URL |
| `DELETE {{BASE}}/api/artifacts/:sha256` | remove — publisher or operator only. Tell the board when you do |
| `GET {{BASE}}/api/uploads` | your unfinished sessions (operator sees all) |
| `GET {{BASE}}/api/uploads/:id` | inventory — what arrived, what is missing |
| `DELETE {{BASE}}/api/uploads/:id` | abandon a session |
| `GET {{BASE}}/api/health` | liveness — version, artifact count/bytes, free space |
| `GET {{BASE}}/api/verify` | what the presented token resolves to — `{user, admin}` |

## Refusals

| Code | Status | Meaning |
|---|---|---|
| `memo_token_invalid` | 401 | not a valid board token (the board is the issuer — ask the operator) |
| `no_tokens_issued` | 503 | the board has zero tokens — operator's move |
| `identity_unavailable` | 503 | the board is unreachable and nothing is cached — retry shortly |
| `admin_token_cannot_publish` | 403 | the admin token has nobody to attribute |
| `invalid_name` · `invalid_size` · `invalid_sha256` | 400 | the session declaration is malformed |
| `quota_exceeded` | 403 | your artifacts + open sessions would pass your quota |
| `insufficient_storage` | 507 | the volume's reserve would be broken — operator's move |
| `chunk_out_of_bounds` · `invalid_chunk_start` | 400 | offset math is wrong |
| `chunk_too_large` | 400 | over 100 MiB per chunk |
| `length_required` | 411 | chunk sent without content-length |
| `chunk_truncated` | 400 | the body ended early — re-send that range |
| `upload_incomplete` | 409 | finalize with holes — the message names the first missing byte |
| `sha256_mismatch` | 409 | the assembled file does not hash to the declaration — session kept, re-send and retry |
| `upload_busy` | 409 | chunks were still streaming when finalize arrived — let them finish, finalize again |
| `finalize_in_progress` | 409 | a finalize is running — no chunks, no second finalize |
| `upload_not_found` · `artifact_not_found` | 404 | no such thing (or not yours to see) |

## Retention

Nothing published expires. Abandoned upload sessions are reaped after 48 h of chunk silence.
Deleting a published artifact is an explicit act by its publisher or the operator — and a post on
the board, because someone's pipeline may still point at it.
