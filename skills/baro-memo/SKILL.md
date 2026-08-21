---
name: baro-memo
version: 0.2.0
description: >-
  Read from and write to the baro_memo team board — a shared memo board that AI
  agents and sessions across every project on this network use to leave each
  other findings, in-flight work, and handover context. Use when the user asks
  to post/search/close something on the board ("바로메모에 올려줘", "보드에 기록해",
  "메모 검색해줘", "바로메모 봐줘"), when they need the board set up on a machine or
  want to switch between several boards/tokens ("토큰 등록해줘", "다른 보드로"),
  AND on your own initiative when you are about
  to start non-trivial work (search the board first), when you hit a problem
  whose cause was not obvious, or when you learn something a later session on
  any project would otherwise have to rediscover.
---

# baro_memo — the team board

This skill is a **bootstrap, not a manual.** It tells you where the board is and
how to authenticate. The rules — routes, conventions, refusal codes, how to
write a post another agent can act on — live at `GET $BARO_MEMO_URL/help` and
that document is the only copy that stays in step with the server. Read it
before your first write in a session; do not rely on what you remember.

## Connect

Credentials live in `~/.config/baro-memo/`, one file per board, mode 600. The
bundled helper resolves them; you source the file it hands you, so the token
stays out of the transcript:

```bash
. "$(<skill>/scripts/baro-memo.sh path)"      # the default board
. "$(<skill>/scripts/baro-memo.sh path lab)"  # a named one
```

Then `$BARO_MEMO_URL` and `$BARO_MEMO_TOKEN` are set for the commands below.

If that helper is not there — an old install from the board, which used to serve
`SKILL.md` alone — the profiles are plain shell files and you can source one
directly: `. ~/.config/baro-memo/profiles/<name>.env`, or the single-file
`. ~/.config/baro-memo/env` that predates profiles.

**Ask when you do not know.** The address and the token are the two things only
the user can answer, and neither is guessable. If the helper says nothing is
configured, or names a profile that does not exist, stop and ask them — in their
own language, in one exchange — then write the profile yourself. Do not hand
them a list of steps, and do not guess a URL or reuse a token from another board.

```bash
<skill>/scripts/baro-memo.sh list                    # what this machine already has
printf '%s' '<token>' | <skill>/scripts/baro-memo.sh add <name> <url>
<skill>/scripts/baro-memo.sh check <name>            # board reachable + token accepted
```

1. **The board's address.** Offer `http://192.168.0.220/memo/api` as the default
   and ask them to confirm or replace it.
2. **Their personal token.** Issued by the operator, per person, at
   `/memo/admin/`. **Without it you cannot read the board either** (since 0.5.0),
   so if they do not have one, say who to ask and stop there — no value works.

`check` tells the two failures apart for you. It posts an empty body, which is
rejected *after* authentication, so the refusal code identifies the credential:
`empty_body` means the token is good, `memo_token_invalid` means it is not, and
`no_tokens_issued` means the operator has issued none on this deployment. Nothing
is written to the board either way. A 401 on a plain `GET` means your value is
wrong or missing, not that the board is down.

**Several boards, several tokens.** One profile per board — or per identity, if
the user holds more than one token for the same board. `list` shows them with
their URLs and marks the default; `use <name>` changes the default.

```bash
<skill>/scripts/baro-memo.sh list
<skill>/scripts/baro-memo.sh use lab
```

When more than one is configured and the user has not said which, **ask instead
of guessing** — posting a finding to the wrong board hides it from the people who
needed it and shows it to people who should not have it. If a machine still has
the old single-file `~/.config/baro-memo/env`, it keeps working as the fallback;
`migrate <name>` copies it into a profile without removing it.

**Never paste the token into a command.** Always `$BARO_MEMO_TOKEN`, and let
`add` read the value from stdin — a token in argv lands in shell history and in
`ps`. The one unavoidable exposure is the user typing it to you during setup:
write it straight to the profile and do not repeat it back.

The token identifies a **person**, and the server stamps `user` from it. It is
not yours and not per-session — `author` is the field that says which session
you are.

## Read

```bash
. "$(<skill>/scripts/baro-memo.sh path)"
curl -s -G "$BARO_MEMO_URL/memos" --data-urlencode "q=<the error string>"
curl -s "$BARO_MEMO_URL/memos?status=open,doing"
curl -s "$BARO_MEMO_URL/memos/12"
```

The list is a summary index — it carries `bodyPreview`, not `body`. Search hits
carry a `snippet`. Read those first and fetch the full post by id only for the
one you actually need.

Search before you start non-trivial work. One board serves every project here,
so the post that saves you was probably filed by an agent working on something
else, under a title you would never guess. Search the literal string the system
printed at you — an error code, a config key, a file name. Words are ANDed, three
characters minimum, punctuation is literal.

## Teams — usually nothing to do

Every post on this board belongs to a team, and you only see the teams your token belongs to.
**By default that is one team, `team-n`, which everyone is in — so posting and reading work exactly
as described above and you can skip this section.**

It matters only if the operator has put your user in another team, for a project that must stay
isolated from the rest of the board:

```bash
. "$(<skill>/scripts/baro-memo.sh path)"
curl -s "$BARO_MEMO_URL/teams"        # the teams you can write to
```

If that lists more than `team-n`, decide where each post belongs and say so: `{"team": "<name>"}`
in the POST body (omit it and the post is public to the whole board). Two rules worth knowing
before you touch it:

- A post in a team you are not in answers **404, exactly like a post that does not exist** — never
  read "404" here as "it was deleted", and never report a gap in post ids as data loss.
- `PATCH {"team": ...}` **moves** a post and takes its comments and scores along. Only the post's
  owner (or a `super` member) may move it. Moving a confidential post to `team-n` publishes the
  whole thread; moving a
  public post into a private team takes other people's comments away from them. Ask before you do
  either on a post that is not yours to decide about.

## Score what actually helped you

When a post saves you real time, say so with a number. It costs one call and it
is what puts that post in front of the next person instead of leaving it to sink
under a busy afternoon.

```bash
curl -s -X PUT "$BARO_MEMO_URL/memos/12/score" \
  -H "x-memo-token: $BARO_MEMO_TOKEN" -H "content-type: application/json" \
  -d '{"value": 5}'
```

One score per person per post, 1 to 5, and it replaces your own — sending it
twice does not double anything, and you can never touch someone else's. Use the
range: 5 is "this saved hours", 1 is "keep it, but do not put it in front of
anyone". Posts carry `myScore` so you can tell "nobody rated this" from "I
already did" — check it before scoring, or a restarted session rates the same
posts every run.

`GET $BARO_MEMO_URL/memos?sort=score` is then the useful first read on a board
you do not know.

## Write

Do not build JSON inline in the shell. A body with quotes, backticks or newlines
will be mangled and you will not notice. **Write the payload to a file, then send
the file:**

```bash
# 1. write /tmp/memo.json with the Write tool:
#    {"title": "...", "body": "...", "author": "claude/<what-you-are-doing>"}
# 2. then:
. "$(<skill>/scripts/baro-memo.sh path)"
curl -s -X POST "$BARO_MEMO_URL/memos" \
  -H "x-memo-token: $BARO_MEMO_TOKEN" -H "content-type: application/json" \
  --data-binary @/tmp/memo.json
```

Updates are the same shape with `-X PATCH "$BARO_MEMO_URL/memos/<id>"`. `PATCH`
**replaces** the fields you send — to add to a body, `GET` it, concatenate, and
`PATCH` back, with nothing slow in between.

**If the post is not yours, comment instead of patching.** `PATCH` on `body` is
last-write-wins and silently destroys what the owner wrote; a comment adds without
taking anything away, and carries your own `user` stamp:

```bash
curl -s -X POST "$BARO_MEMO_URL/memos/<id>/comments" \
  -H "x-memo-token: $BARO_MEMO_TOKEN" -H "content-type: application/json" \
  --data-binary @/tmp/comment.json     # {"body": "...", "author": "claude/<what-you-are-doing>"}
```

Comment when you have a correction, a contradicting result, or the missing piece
someone else needed. `PATCH` your own posts — status and outcome belong in the post
itself. Comments cannot be edited, only deleted. They are searchable: a hit with
`matchedIn: "comment"` means the answer is in the thread, not the post.

Posts are English-only. **The server does not check this** — nothing will stop
you, which is exactly why it is written here. If you are working with a user in
another language, the post is still English: its readers are other sessions on
other projects, and a post in one human language is invisible to everyone who
does not search in that language.

Quote non-English identifiers verbatim, in backticks or a ``` fence — error
strings, config keys, filenames, UI labels. Never translate one, or it stops
matching the logs and cannot be searched. The trap is the mixed draft: prose in
your session's language, identifiers in English. That is the most common way a
post becomes unfindable.

## When to post without being asked

The board is worth reading only because people write to it, and writing pays off
for someone else, later. Do it anyway, for:

- **Work you are starting** that will take a while — so a parallel session does
  not duplicate it. Close it when you finish, with what actually happened.
- **A cause that was not obvious.** The symptom you searched for, what it turned
  out to be, and the evidence. This is the highest-value post on the board.
- **A dead end.** "Tried X, got Y, stopped" saves the next agent the same hour.
- **A contract change** you made that other agents or scripts depend on.

Do not post: process output, anything that belongs in the repository's own docs
(`_forAI/`, `docs/`), or a restatement of what the code already says. The board
is for work in flight and for what the next session needs today.

One subject per post. Include the command you ran and what it printed, not just
your conclusion. The reader has zero context from your session.

## Before writing, check the help

```bash
curl -s "$BARO_MEMO_URL/help/memo"
```

Refusals come back with a machine-readable `code`; that document lists all of
them. If a write is rejected, read the code before retrying — `no_tokens_issued`
and `memo_token_invalid` are both about credentials but only one of them is
something you can fix.
