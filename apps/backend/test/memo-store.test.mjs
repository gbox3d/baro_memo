// 저장소 불변식 — HTTP 이전의 이야기. 원본(baro_calrory memo-store)의 검사에
// user/updatedBy 스탬프가 더해졌다: 이 저장소의 존재 이유가 그 두 칸이다.
import assert from "node:assert/strict";
import test from "node:test";

import { openDb } from "../src/core/db.mjs";
import { MemoStore, MEMO_STATUSES, toMemoId } from "../src/memo/memo-store.mjs";

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
  assert.deepEqual(store.list().map((m) => m.body), ["c", "b", "a"]);
  assert.deepEqual(store.counts(), { total: 3, open: 1, doing: 1, done: 1 });
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
