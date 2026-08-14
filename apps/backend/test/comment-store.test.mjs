// 댓글 저장소. 주제는 셋이다.
//
//  1) **귀속**: user 는 인자로만 들어온다(라우터가 토큰에서 역산한 값). 본문으로 사칭 불가.
//  2) **색인**: 댓글이 검색에 걸려야 한다. 답은 본문이 아니라 댓글에 쌓이기 때문이다.
//  3) **수명**: 메모가 지워지면 그 댓글도 같이 간다. 남으면 주인 없는 글이 색인에만 남는다.
import assert from "node:assert/strict";
import test from "node:test";

import { openDb } from "../src/core/db.mjs";
import { MemoStore } from "../src/memo/memo-store.mjs";
import { CommentStore } from "../src/memo/comment-store.mjs";

function rig() {
  const db = openDb(":memory:");
  return { memos: new MemoStore(db), comments: new CommentStore(db) };
}

test("댓글은 시간순이고 user 는 인자에서만 온다", () => {
  const { memos, comments } = rig();
  const memo = memos.create({ title: "t", body: "b" }, "kim");

  const first = comments.add(memo.id, { body: "먼저", author: "claude/a", user: "사칭" }, "kim");
  const second = comments.add(memo.id, { body: "나중", author: "claude/b" }, "lee");

  assert.equal(first.user, "kim");
  assert.equal(second.user, "lee", "본문의 user 는 무시된다 — 스탬프가 정본이다");
  assert.equal(first.memoId, memo.id);
  // 대화는 위에서 아래로 읽힌다. 목록이 최신순인 것과 반대인 이유가 그것이다.
  assert.deepEqual(comments.listFor(memo.id).map((c) => c.body), ["먼저", "나중"]);
  assert.equal(comments.countFor(memo.id), 2);
});

test("빈 본문과 상한은 메모와 같은 규칙으로 거절한다", () => {
  const { memos, comments } = rig();
  const memo = memos.create({ body: "b" }, "kim");

  assert.throws(() => comments.add(memo.id, { body: "   " }, "kim"), { code: "empty_body" });
  assert.throws(() => comments.add(memo.id, { body: 42 }, "kim"), { code: "invalid_field" });
  assert.throws(() => comments.add(memo.id, { body: "x".repeat(20001) }, "kim"), { code: "too_long" });
  assert.throws(() => comments.add(memo.id, { body: "ok", author: "a".repeat(101) }, "kim"), { code: "too_long" });
});

test("댓글은 검색에 걸리고, 어느 쪽에서 걸렸는지 말해 준다", () => {
  const { memos, comments } = rig();
  const post = memos.create({ title: "tunnel restart", body: "quick tunnel url keeps changing" }, "kim");
  comments.add(post.id, { body: "the fix was proxy_set_header X-Forwarded-Prefix" }, "lee");

  // 본문에 없는 낱말이다 — 댓글 색인이 없으면 이 검색은 0건이고, 답은 있는데 못 찾는 상태가 된다.
  const hit = memos.list({ q: "proxy_set_header" });
  assert.equal(hit.total, 1);
  assert.equal(hit.memos[0].id, post.id);
  assert.equal(hit.memos[0].matchedIn, "comment");
  // snippet 은 **댓글 본문**에서 잘라 온 조각이다(메모 본문이 아니라). trigram 색인이라
  // 잘리는 자리가 낱말 경계가 아니어서, 조각이 원문의 부분문자열인지로 검사한다.
  const piece = hit.memos[0].snippet.replaceAll("…", "").replaceAll("[", "").replaceAll("]", "");
  assert.ok(piece.length > 3 && "the fix was proxy_set_header X-Forwarded-Prefix".includes(piece),
    `snippet 이 댓글에서 온 것이 아니다: ${JSON.stringify(hit.memos[0].snippet)}`);

  const own = memos.list({ q: "quick tunnel" });
  assert.equal(own.memos[0].matchedIn, "memo");

  // 같은 메모가 양쪽에서 걸려도 결과는 한 줄이다 — 소비자에게 같은 메모가 두 번 보이면 안 된다.
  comments.add(post.id, { body: "quick tunnel again" }, "lee");
  const both = memos.list({ q: "quick tunnel" });
  assert.equal(both.total, 1);
  assert.equal(both.memos.length, 1);
});

test("지운 댓글은 색인에서도 사라진다", () => {
  const { memos, comments } = rig();
  const post = memos.create({ title: "t", body: "b" }, "kim");
  const c = comments.add(post.id, { body: "SQLITE_BUSY 를 만났다" }, "lee");

  assert.equal(memos.list({ q: "SQLITE_BUSY" }).total, 1);
  assert.equal(comments.remove(c.id), true);
  assert.equal(memos.list({ q: "SQLITE_BUSY" }).total, 0, "트리거가 빠지면 여기서만 조용히 어긋난다");
  assert.equal(comments.remove(c.id), false);
});

test("메모를 지우면 그 댓글도 같이 간다", () => {
  const { memos, comments } = rig();
  const post = memos.create({ title: "t", body: "b" }, "kim");
  comments.add(post.id, { body: "orphan candidate — cascade 로 같이 지워져야 한다" }, "lee");

  memos.remove(post.id);
  assert.equal(comments.listFor(post.id).length, 0);
  // 주인 없는 글이 색인에만 남으면 검색 결과가 없는 메모를 가리킨다.
  assert.equal(memos.list({ q: "orphan candidate" }).total, 0);
});

test("목록과 한 건 모두 commentCount 를 싣는다", () => {
  const { memos, comments } = rig();
  const a = memos.create({ title: "a", body: "a" }, "kim");
  memos.create({ title: "b", body: "b" }, "kim");
  comments.add(a.id, { body: "하나" }, "lee");
  comments.add(a.id, { body: "둘" }, "lee");

  const byId = Object.fromEntries(memos.list().memos.map((m) => [m.id, m.commentCount]));
  assert.equal(byId[a.id], 2);
  assert.equal(memos.get(a.id).commentCount, 2);
  // 댓글 없는 메모는 0 이다. undefined 면 소비자가 "모른다"로 읽는다.
  assert.equal(memos.list({ full: true }).memos.every((m) => typeof m.commentCount === "number"), true);
});

test("이미 쌓인 DB 에 댓글 색인을 얹으면 기존 댓글이 채워진다", () => {
  // 0.4.0 로 올라가는 운영 DB 가 정확히 이 경로다 — 테이블은 있고 색인만 없는 상태.
  const db = openDb(":memory:");
  const memos = new MemoStore(db);
  const comments = new CommentStore(db);
  const post = memos.create({ title: "t", body: "b" }, "kim");
  comments.add(post.id, { body: "backfill 대상 문장" }, "lee");

  db.exec("DROP TABLE comment_fts");
  db.exec("DROP TRIGGER IF EXISTS comment_fts_ai; DROP TRIGGER IF EXISTS comment_fts_ad; DROP TRIGGER IF EXISTS comment_fts_au");
  assert.equal(new MemoStore(db) && memos.list({ q: "backfill" }).total, 1, "재기동 시 rebuild 로 채워져야 한다");
});
