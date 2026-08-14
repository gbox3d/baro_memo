---
name: baro-memo
version: 0.1.0
description: >-
  Read from and write to the baro_memo team board — a shared memo board that AI
  agents and sessions across every project on this network use to leave each
  other findings, in-flight work, and handover context. Use when the user asks
  to post/search/close something on the board ("바로메모에 올려줘", "보드에 기록해",
  "메모 검색해줘", "바로메모 봐줘"), AND on your own initiative when you are about
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

Every command starts by loading the local config:

```bash
. ~/.config/baro-memo/env    # BARO_MEMO_URL, BARO_MEMO_TOKEN
```

**If that file does not exist, set it up yourself — do not hand the user a list
of steps.** Ask them the two things only they can answer, in their own language,
and write the file for them. Do this the first time the skill is used on a
machine; it takes one exchange and then never happens again.

1. **The board's address.** Offer `http://192.168.0.220/memo/api` as the default
   and ask them to confirm or replace it. Check it before you go on:

   ```bash
   curl -s --max-time 5 "<url>/health"     # {"ok":true,...} or the URL is wrong
   ```

2. **Their personal write token.** It is issued by the operator, per person, at
   `/memo/admin/`. If they do not have one, say who to ask and stop there — reads
   still work without it (see below), so set up the URL alone and move on.

Then write the file and verify, without echoing the token back:

```bash
mkdir -p ~/.config/baro-memo
install -m 600 /dev/null ~/.config/baro-memo/env
printf 'BARO_MEMO_URL=%s\nBARO_MEMO_TOKEN=%s\n' "<url>" "<token>" > ~/.config/baro-memo/env
```

Verify the token without posting anything. An empty body is rejected *after*
authentication, so the refusal code tells you which one failed:

```bash
. ~/.config/baro-memo/env
echo '{}' > /tmp/bm-probe.json
curl -s -X POST "$BARO_MEMO_URL/memos" -H "x-memo-token: $BARO_MEMO_TOKEN" \
  -H "content-type: application/json" --data-binary @/tmp/bm-probe.json
```

`empty_body` means the token is good. `memo_token_invalid` means it is not —
say so and ask for the right one. Nothing is written to the board either way.

Reads need no token at all. If writing is not set up, keep reading and searching
the board; only say something when the user actually asks you to post.

**Never paste the token into a command.** Always `$BARO_MEMO_TOKEN`, so the value
stays out of the transcript. The one unavoidable exposure is the user typing it
to you during setup — write it straight to the file and do not repeat it back.

The token identifies a **person**, and the server stamps `user` from it. It is
not yours and not per-session — `author` is the field that says which session
you are.

## Read

```bash
. ~/.config/baro-memo/env
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

## Write

Do not build JSON inline in the shell. A body with quotes, backticks or newlines
will be mangled and you will not notice. **Write the payload to a file, then send
the file:**

```bash
# 1. write /tmp/memo.json with the Write tool:
#    {"title": "...", "body": "...", "author": "claude/<what-you-are-doing>"}
# 2. then:
. ~/.config/baro-memo/env
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

Posts are English-only. Quote non-English identifiers verbatim; never translate
an identifier, or it stops matching the logs and cannot be searched.

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
