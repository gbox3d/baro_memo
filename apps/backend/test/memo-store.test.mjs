// 저장소 불변식 — HTTP 이전의 이야기. 원본(baro_calrory memo-store)의 검사에
// user/updatedBy 스탬프가 더해졌다: 이 저장소의 존재 이유가 그 두 칸이다.
import assert from "node:assert/strict";
import test from "node:test";

import { openDb } from "../src/core/db.mjs";
import { LIST_LIMIT, MemoStore, MEMO_STATUSES, PREVIEW_CHARS, toMemoId } from "../src/memo/memo-store.mjs";

function rig() {
  return new MemoStore(openDb(":memory:"));
}

test("생성은 user 를 두 번째 인자에서 찍는다 — 본문의 어떤 값도 아니다", () => {
  const store = rig();
  const memo = store.create({ body: "x", author: "claude/test" }, "kim");
  assert.equal(memo.user, "kim");
  assert.equal(memo.updatedBy, "kim");
  assert.equal(memo.author, "claude/test"); // author 는 자유기입 그대로
});

test("갱신은 updatedBy 만 갈아 끼우고 user 는 불변이다", () => {
  const store = rig();
  const { id } = store.create({ body: "x" }, "kim");
  const after = store.update(id, { status: "doing" }, "lee");
  assert.equal(after.user, "kim");
  assert.equal(after.updatedBy, "lee");
  assert.equal(after.status, "doing");
});

test("빈 body 는 empty_body — 생성과 갱신 양쪽 다", () => {
  const store = rig();
  assert.throws(() => store.create({ body: "  " }, "kim"), { code: "empty_body" });
  const { id } = store.create({ body: "x" }, "kim");
  assert.throws(() => store.update(id, { body: "" }, "kim"), { code: "empty_body" });
});

test("문자열이 아닌 필드는 뭉개지 않고 거절한다", () => {
  const store = rig();
  assert.throws(() => store.create({ body: { a: 1 } }, "kim"), { code: "invalid_field" });
  assert.throws(() => store.create({ body: "x", title: 3 }, "kim"), { code: "invalid_field" });
});

test("상한 초과는 too_long", () => {
  const store = rig();
  assert.throws(() => store.create({ body: "y".repeat(20001) }, "kim"), { code: "too_long" });
});

test("status 는 세 값뿐", () => {
  const store = rig();
  assert.deepEqual([...MEMO_STATUSES], ["open", "doing", "done"]);
  assert.throws(() => store.create({ body: "x", status: "보류" }, "kim"), { code: "invalid_status" });
  const memo = store.create({ body: "x" }, "kim");
  assert.equal(memo.status, "open"); // 기본값
});

test("빈 PATCH 는 no_fields — 오타가 성공으로 읽히지 않게", () => {
  const store = rig();
  const { id } = store.create({ body: "x" }, "kim");
  assert.throws(() => store.update(id, { tilte: "오타" }, "kim"), { code: "no_fields" });
});

test("목록은 최신(id 역순)이고 counts 가 상태별로 센다", () => {
  const store = rig();
  store.create({ body: "a" }, "kim");
  store.create({ body: "b", status: "doing" }, "kim");
  store.create({ body: "c", status: "done" }, "kim");
  assert.deepEqual(store.list({ full: true }).memos.map((m) => m.body), ["c", "b", "a"]);
  assert.deepEqual(store.counts(), { total: 3, open: 1, doing: 1, done: 1 });
});

test("목록의 기본은 요약 — 미리보기는 PREVIEW_CHARS 에서 잘리고 길이는 원본을 말한다", () => {
  const store = rig();
  store.create({ body: "x".repeat(PREVIEW_CHARS + 50) }, "kim");
  const [memo] = store.list().memos;
  assert.equal(memo.body, undefined);
  assert.equal(memo.bodyPreview.length, PREVIEW_CHARS);
  assert.equal(memo.bodyLength, PREVIEW_CHARS + 50);
  // 상한보다 짧으면 미리보기가 곧 전문이다 — 그래도 bodyLength 로 판별된다.
  const short = store.create({ body: "tiny" }, "kim");
  const found = store.list().memos.find((m) => m.id === short.id);
  assert.equal(found.bodyPreview, "tiny");
  assert.equal(found.bodyLength, 4);
});

test("total 은 필터 뒤·자르기 전 — 잘렸는지를 소비자가 알 수 있게", () => {
  const store = rig();
  for (const s of ["open", "open", "doing", "done"]) store.create({ body: "x", status: s }, "kim");
  const page = store.list({ limit: 1 });
  assert.equal(page.memos.length, 1);
  assert.equal(page.total, 4);
  assert.equal(store.list({ status: ["open"] }).total, 2);
  assert.equal(store.list({ status: ["open", "doing"] }).total, 3);
});

test("기본 limit 이 있다 — 상한 없는 목록은 '언젠가 느려지는' 라우트다", () => {
  const store = rig();
  for (let i = 0; i < LIST_LIMIT.default + 5; i += 1) store.create({ body: `m${i}` }, "kim");
  const page = store.list();
  assert.equal(page.memos.length, LIST_LIMIT.default);
  assert.equal(page.total, LIST_LIMIT.default + 5);
});

// ---- 전문 검색 ---------------------------------------------------------------------------
//
// 외부 콘텐츠 FTS5 는 트리거가 전부다. 트리거 하나가 빠지면 색인이 조용히 어긋나고, 그 증상은
// "왜 이 메모가 안 잡히지"로 몇 주 뒤에 나타난다. 그래서 세 갈래를 다 붙잡는다.

test("색인은 생성·갱신·삭제를 따라간다", () => {
  const store = rig();
  const memo = store.create({ title: "tunnel", body: "cloudflared hands out a new URL" }, "kim");
  assert.equal(store.list({ q: "cloudflared" }).total, 1, "INSERT 가 색인되지 않았습니다");

  store.update(memo.id, { body: "nginx serves it under a stable prefix" }, "kim");
  assert.equal(store.list({ q: "cloudflared" }).total, 0, "UPDATE 뒤 옛 본문이 색인에 남았습니다");
  assert.equal(store.list({ q: "nginx" }).total, 1, "UPDATE 된 본문이 색인되지 않았습니다");

  store.remove(memo.id);
  assert.equal(store.list({ q: "nginx" }).total, 0, "DELETE 뒤 색인이 남았습니다");
});

test("이미 쌓인 DB 에 색인을 얹으면 기존 행이 채워진다 — 마이그레이션 경로", () => {
  const db = openDb(":memory:");
  const store = new MemoStore(db);
  store.create({ title: "old post", body: "written before the index existed" }, "kim");
  // 색인을 통째로 버리고 새 MemoStore 를 세운다 = 운영 DB 에 새 코드가 처음 붙는 순간.
  db.exec("DROP TABLE memo_fts");
  const reopened = new MemoStore(db);
  assert.equal(reopened.list({ q: "written" }).total, 1, "기존 행이 색인되지 않았습니다");
});

test("검색은 제목과 본문 양쪽 · 결과에 snippet · 3글자 미만은 거절", () => {
  const store = rig();
  store.create({ title: "plates unreadable", body: "exposure, not the detector" }, "kim");
  assert.equal(store.list({ q: "plates" }).total, 1);
  const [hit] = store.list({ q: "detector" }).memos;
  assert.match(hit.snippet, /\[detector\]/);
  assert.throws(() => store.list({ q: "de" }), { code: "query_too_short" });
});

test("삭제 뒤 id 는 재사용되지 않는다 — 외부 기록이 어긋나지 않게", () => {
  const store = rig();
  const first = store.create({ body: "x" }, "kim");
  assert.equal(store.remove(first.id), true);
  const second = store.create({ body: "y" }, "kim");
  assert.ok(second.id > first.id);
});

test("toMemoId 는 양의 정수만 통과시킨다", () => {
  assert.equal(toMemoId("3"), 3);
  for (const bad of ["abc", "1.5", "-2", "0", ""]) assert.equal(toMemoId(bad), null, bad);
});
