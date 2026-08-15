// 중요도(점수) 축. 주제는 넷이다.
//
//  1) **한 사람 한 표.** 다시 주면 자기 행이 덮인다 — 합계가 두 배가 되지 않는 것이 이 축의
//     안전성 전부다(재시도·세션 재시작이 순위를 바꾸면 수치가 열의를 재게 된다).
//  2) **상한은 1..5**, 0 은 특별히 이름을 불러 준다 — "취소하려고 0" 이 가장 그럴듯한 오해다.
//  3) **표는 사람의 것**이다. user 없는 표는 귀속이 없고 빈 문자열끼리 UNIQUE 에 부딪힌다.
//  4) **목록에 실리는 세 값**(score·voters·myScore)이 서로 다른 질문에 답한다. 특히 myScore 는
//     **보는 사람마다 다른 값**이라, 파라미터 순서가 어긋나면 조용히 남의 값이 실린다.
import assert from "node:assert/strict";
import test from "node:test";

import { openDb } from "../src/core/db.mjs";
import { MemoStore } from "../src/memo/memo-store.mjs";
import { VoteStore } from "../src/memo/vote-store.mjs";
import { AuditStore } from "../src/memo/audit-store.mjs";

function rig() {
  const db = openDb(":memory:");
  const memos = new MemoStore(db);
  return {
    db, memos, votes: new VoteStore(db), audit: new AuditStore(db),
    // 합계·사람 수·내 점수의 **정본은 MemoStore** 다(같은 수치의 SQL 을 두 벌 두지 않는다).
    // 검사도 그 정본을 통해 본다 — 소비자가 실제로 받는 자리가 여기다.
    sum: (id) => { const m = memos.get(id); return { score: m.score, voters: m.voters }; },
    mine: (id, user) => memos.get(id, user).myScore,
  };
}

test("한 사람 한 표 — 다시 주면 덮이고, 합계는 두 배가 되지 않는다", () => {
  const { memos, votes, sum, mine } = rig();
  const memo = memos.create({ body: "b" }, "kim");

  votes.set(memo.id, 4, "kim");
  votes.set(memo.id, 5, "lee");
  assert.deepEqual(sum(memo.id), { score: 9, voters: 2 });

  // 같은 사람이 다시 — 행이 늘지 않고 값만 바뀐다. 이 축의 last-write-wins 는 늘 자기 것이다.
  votes.set(memo.id, 1, "kim");
  assert.deepEqual(sum(memo.id), { score: 6, voters: 2 });
  assert.equal(mine(memo.id, "kim"), 1);
  assert.equal(mine(memo.id, "lee"), 5);
  assert.equal(mine(memo.id, "park"), 0, "안 준 사람은 0 — 0 은 유효한 점수가 아니라서 겹치지 않는다");

  // 누가 줬는지를 감추지 않는다. 자기 글에 스스로 준 5 와 다섯 사람의 5 를 가르는 것이 이 목록이다.
  assert.deepEqual(votes.listFor(memo.id).map((v) => [v.user, v.value]), [["lee", 5], ["kim", 1]]);
});

test("상한은 1..5 이고 0 은 DELETE 를 가리킨다", () => {
  const { memos, votes, sum } = rig();
  const memo = memos.create({ body: "b" }, "kim");

  for (const bad of [6, 7, -1, 2.5, "abc", null, undefined, {}, true]) {
    assert.throws(() => votes.set(memo.id, bad, "kim"), { code: "invalid_score" }, `통과하면 안 된다: ${String(bad)}`);
  }
  // 0 도 거절이지만 **다른 문장**이다 — 어디로 가야 하는지가 그 자리에 있어야 재시도가 멎는다.
  assert.throws(() => votes.set(memo.id, 0, "kim"), (err) => {
    assert.equal(err.code, "invalid_score");
    assert.match(err.message, /DELETE/, "0 의 거절 문장은 취소하는 길을 가리켜야 한다");
    return true;
  });

  // 문자열 "3" 은 받는다 — 쿼리·폼에서 흔한 모양이고, 뜻이 모호하지 않다.
  assert.equal(votes.set(memo.id, "3", "kim").value, 3);
  assert.equal(sum(memo.id).score, 3);
});

test("사람 없는 표는 저장소가 거절하고, 빈 이름으로는 남의 표를 못 지운다", () => {
  const { memos, votes, sum, db } = rig();
  const memo = memos.create({ body: "b" }, "kim");
  assert.throws(() => votes.set(memo.id, 3, ""), { code: "user_required" });
  assert.deepEqual(sum(memo.id), { score: 0, voters: 0 });

  // 이 스토어는 user='' 인 행을 만들지 않는다. 그래서 가드를 진짜로 걸려면 **저장소가 쓰지 않는
  // 행을 직접 꽂아야** 한다 — 이관이나 라우터를 안 거치는 쓰기가 실제로 그럴 수 있는 자리다.
  // 이 행이 없으면 clear("") 는 가드가 있든 없든 0건을 지워, 검사가 아무것도 지키지 않는다.
  db.prepare("INSERT INTO vote (memo_id, user, value, at) VALUES (?, '', 3, ?)")
    .run(memo.id, new Date().toISOString());
  votes.set(memo.id, 4, "kim");

  assert.equal(votes.clear(memo.id, ""), false, "빈 이름은 아무것도 지우지 않는다");
  assert.deepEqual(sum(memo.id), { score: 7, voters: 2 }, "주인 없는 행도 남의 것이다 — 지우지 않는다");
});

test("내 표를 거둔다 — 없던 표를 거두는 것은 false, 이미 원하는 상태다", () => {
  const { memos, votes, sum } = rig();
  const memo = memos.create({ body: "b" }, "kim");
  votes.set(memo.id, 5, "kim");
  votes.set(memo.id, 2, "lee");

  assert.equal(votes.clear(memo.id, "kim"), true);
  assert.equal(votes.clear(memo.id, "kim"), false, "재요청은 실패가 아니다");
  assert.deepEqual(sum(memo.id), { score: 2, voters: 1 }, "남의 표는 그대로다");
});

test("목록은 score·voters·myScore 를 싣고, myScore 는 보는 사람마다 다르다", () => {
  const { memos, votes } = rig();
  const a = memos.create({ body: "alpha" }, "kim");
  votes.set(a.id, 5, "kim");
  votes.set(a.id, 2, "lee");

  const asKim = memos.list({ viewer: "kim" }).memos[0];
  assert.equal(asKim.score, 7);
  assert.equal(asKim.voters, 2, "합만 보면 한 사람의 확신과 팀의 합의가 구분되지 않는다");
  assert.equal(asKim.myScore, 5);

  assert.equal(memos.list({ viewer: "lee" }).memos[0].myScore, 2);
  assert.equal(memos.list({ viewer: "park" }).memos[0].myScore, 0);
  // 보는 사람이 없으면(관리자 토큰) 0 이다 — 그 값에는 사람이 없어 표도 없다.
  assert.equal(memos.list().memos[0].myScore, 0);

  // 한 건도 같은 모양이다. 목록과 한 건이 다른 필드를 주면 소비자가 파서를 둘 두게 된다.
  assert.equal(memos.get(a.id, "lee").myScore, 2);
  assert.equal(memos.get(a.id).score, 7);
});

test("sort=score 는 중요도순, 동점은 최신순으로 갈린다", () => {
  const { memos, votes } = rig();
  const first = memos.create({ body: "first" }, "kim");
  const second = memos.create({ body: "second" }, "kim");
  const third = memos.create({ body: "third" }, "kim");
  votes.set(first.id, 5, "kim");
  votes.set(first.id, 4, "lee");   // 9
  votes.set(third.id, 3, "kim");   // 3
  // second 는 0 점

  assert.deepEqual(memos.list({ sort: "score" }).memos.map((m) => m.id), [first.id, third.id, second.id]);
  // 기본은 여전히 최신순이다 — 이미 그것에 기대어 짜인 소비자가 있다.
  assert.deepEqual(memos.list().memos.map((m) => m.id), [third.id, second.id, first.id]);

  // 동점(둘 다 0)은 최신순으로 안정적으로 갈린다. 안 그러면 쪽을 넘길 때마다 순서가 흔들린다.
  votes.clear(first.id, "kim");
  votes.clear(first.id, "lee");
  votes.clear(third.id, "kim");
  assert.deepEqual(memos.list({ sort: "score" }).memos.map((m) => m.id), [third.id, second.id, first.id]);
});

test("검색·필터와 같이 걸어도 myScore 가 어긋나지 않는다 — 파라미터 순서 회귀", () => {
  const { memos, votes } = rig();
  const hit = memos.create({ title: "nginx prefix", body: "x-forwarded-prefix strips nothing" }, "kim");
  const other = memos.create({ body: "unrelated" }, "kim");
  votes.set(hit.id, 4, "lee");
  votes.set(other.id, 5, "lee");

  // my_score 의 물음표는 SELECT 목록에 있어 **q 의 두 물음표보다 먼저** 바인딩된다.
  // 순서가 어긋나면 검색어가 사람 이름 자리로 들어가 myScore 가 조용히 0 이 된다.
  const found = memos.list({ q: "prefix", user: "kim", sort: "score", viewer: "lee" });
  assert.equal(found.total, 1);
  assert.equal(found.memos[0].id, hit.id);
  assert.equal(found.memos[0].myScore, 4, "검색과 같이 걸면 파라미터가 밀린다 — 그 회귀를 잡는 자리다");
  assert.equal(found.memos[0].score, 4);
  assert.ok(found.memos[0].snippet, "검색의 기존 계약(snippet)이 살아 있어야 한다");
});

test("메모를 지우면 표도 가고, 사라진 표는 이력에 남는다", () => {
  const { memos, votes, audit, db } = rig();
  const memo = memos.create({ title: "important", body: "b" }, "kim");
  votes.set(memo.id, 5, "kim");
  votes.set(memo.id, 4, "lee");

  assert.equal(memos.remove(memo.id, "park"), true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM vote WHERE memo_id = ?").get(memo.id).n, 0,
    "표는 글과 함께 간다 — 주인 없는 표가 남으면 합계가 유령을 센다");

  const entry = audit.list({ memoId: memo.id }).entries[0];
  assert.equal(entry.action, "memo_delete");
  assert.deepEqual(entry.before.votes.map((v) => [v.user, v.value]), [["kim", 5], ["lee", 4]]);
  assert.match(entry.summary, /9 point\(s\) from 2 voter\(s\)/);
  // myScore 는 보는 사람의 값이라 보관본에 뜻이 없다. 표는 votes 가 사람과 함께 들고 있다.
  assert.equal(entry.before.memo.myScore, undefined);
  assert.equal(entry.before.memo.score, 9);
});

test("점수를 고치는 것은 이력에 남지 않는다 — 사라지는 것이 늘 자기 값뿐이다", () => {
  const { memos, votes, audit } = rig();
  const memo = memos.create({ body: "b" }, "kim");
  votes.set(memo.id, 5, "kim");
  votes.set(memo.id, 1, "kim");
  votes.clear(memo.id, "kim");
  assert.equal(audit.list({ memoId: memo.id }).total, 0);
});
