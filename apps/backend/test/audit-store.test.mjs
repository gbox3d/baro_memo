// 삭제·수정 이력. 이 파일이 지키는 것은 하나다: **사라진 값이 어딘가에 남아 있는가.**
//
// 나머지는 그 성질을 지탱하는 조건이다 — 이력이 스토어 안에서 남는가(소비자가 잊을 수 없게),
// 메모가 지워져도 그 삭제 기록이 살아남는가(외래키를 걸지 않은 이유), 그리고 지운 내용이
// 일반 검색으로 되살아나지 않는가.
import assert from "node:assert/strict";
import test from "node:test";

import { openDb } from "../src/core/db.mjs";
import { MemoStore } from "../src/memo/memo-store.mjs";
import { CommentStore } from "../src/memo/comment-store.mjs";
import { AuditStore } from "../src/memo/audit-store.mjs";

function rig() {
  const db = openDb(":memory:");
  return { memos: new MemoStore(db), comments: new CommentStore(db), audit: new AuditStore(db) };
}

test("수정은 바뀐 칸만 남긴다 — 덮인 값과 새 값을 함께", () => {
  const { memos, audit } = rig();
  const memo = memos.create({ title: "before", body: "original body", status: "open" }, "kim");

  memos.update(memo.id, { body: "new body", status: "doing" }, "lee");

  const { total, entries } = audit.list({ memoId: memo.id });
  assert.equal(total, 1);
  const [e] = entries;
  assert.equal(e.action, "memo_update");
  assert.equal(e.actor, "lee", "고친 사람은 만든 사람이 아니라 토큰의 주인이다");
  assert.deepEqual(e.before, { body: "original body", status: "open" });
  assert.deepEqual(e.after, { body: "new body", status: "doing" });
  assert.equal(e.before.title, undefined, "안 바뀐 칸은 싣지 않는다");
  assert.match(e.summary, /body/);
});

test("같은 값으로 덮은 수정은 이력이 아니다", () => {
  const { memos, audit } = rig();
  const memo = memos.create({ title: "t", body: "b" }, "kim");
  memos.update(memo.id, { body: "b" }, "kim");
  assert.equal(audit.list().total, 0);
});

test("삭제는 사라지는 것을 전부 남긴다 — 본문과 딸린 댓글까지", () => {
  const { memos, comments, audit } = rig();
  const memo = memos.create({ title: "to delete", body: "the whole body" }, "kim");
  comments.add(memo.id, { body: "the answer that was in the comment", author: "claude/x" }, "lee");

  memos.remove(memo.id, "kim");

  const [e] = audit.list().entries;
  assert.equal(e.action, "memo_delete");
  assert.equal(e.actor, "kim");
  assert.equal(e.before.memo.body, "the whole body");
  // cascade 로 같이 사라지는 댓글을 빼면 "그 스레드에 있던 답" 이 추적 밖으로 나간다.
  assert.deepEqual(e.before.comments.map((c) => c.body), ["the answer that was in the comment"]);
  assert.match(e.summary, /1 comment/);
});

test("메모가 지워져도 그 삭제 기록은 남는다 — 외래키를 걸지 않은 이유", () => {
  const { memos, audit } = rig();
  const memo = memos.create({ title: "t", body: "b" }, "kim");
  memos.remove(memo.id, "kim");

  const { total, entries } = audit.list({ memoId: memo.id });
  assert.equal(total, 1, "cascade 로 같이 지워지면 가장 필요한 순간에 없는 기록이 된다");
  assert.equal(entries[0].memoId, memo.id);
});

test("댓글 삭제도 남는다 — 남의 정정을 지운 것이 추적된다", () => {
  const { memos, comments, audit } = rig();
  const memo = memos.create({ title: "t", body: "b" }, "kim");
  const c = comments.add(memo.id, { body: "correction: the cause was something else" }, "lee");

  comments.remove(c.id, "kim");

  const [e] = audit.list({ action: "comment_delete" }).entries;
  assert.equal(e.actor, "kim", "지운 사람");
  assert.equal(e.before.user, "lee", "쓴 사람");
  assert.equal(e.before.body, "correction: the cause was something else");
  assert.equal(e.commentId, c.id);
  assert.equal(e.memoId, memo.id);
});

test("지운 내용은 일반 검색으로 되살아나지 않는다", () => {
  const { memos, audit } = rig();
  const memo = memos.create({ title: "t", body: "the word zzsecret" }, "kim");
  assert.equal(memos.list({ q: "zzsecret" }).total, 1);

  memos.remove(memo.id, "kim");
  assert.equal(memos.list({ q: "zzsecret" }).total, 0, "지운 것이 ?q= 로 나오면 지운 것이 아니다");
  // 그러나 운영자는 추적할 수 있다.
  assert.equal(audit.list({ action: "memo_delete" }).total, 1);
});

test("이력은 최신순이고 필터가 걸린다", () => {
  const { memos, comments, audit } = rig();
  const a = memos.create({ title: "a", body: "a" }, "kim");
  const b = memos.create({ title: "b", body: "b" }, "lee");
  memos.update(a.id, { status: "doing" }, "kim");
  const c = comments.add(b.id, { body: "x" }, "lee");
  comments.remove(c.id, "lee");
  memos.remove(b.id, "lee");

  const all = audit.list();
  assert.equal(all.total, 3);
  assert.deepEqual(all.entries.map((e) => e.action), ["memo_delete", "comment_delete", "memo_update"]);
  assert.equal(audit.list({ actor: "kim" }).total, 1);
  assert.equal(audit.list({ memoId: b.id }).total, 2);
  assert.equal(audit.list({ action: "memo_update" }).total, 1);
  // total 은 자르기 전 개수 — 잘렸는지를 소비자가 안다(보드 목록과 같은 규약).
  const page = audit.list({ limit: 1 });
  assert.equal(page.entries.length, 1);
  assert.equal(page.total, 3);
});

test("이력을 고치는 경로는 없다 — record 는 추가만 한다", () => {
  const { audit } = rig();
  audit.record({ action: "memo_delete", actor: "kim", memoId: 1, before: { memo: { body: "x" } } });
  audit.record({ action: "memo_delete", actor: "kim", memoId: 1, before: { memo: { body: "y" } } });
  assert.equal(audit.list({ memoId: 1 }).total, 2, "덮어쓰기가 아니라 쌓인다");
  assert.equal(typeof AuditStore.prototype.update, "undefined");
  assert.equal(typeof AuditStore.prototype.remove, "undefined");
});
