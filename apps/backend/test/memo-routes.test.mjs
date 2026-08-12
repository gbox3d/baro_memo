// `/api/memos*` 의 HTTP 계약. 이 파일의 주제는 둘이다.
//
//  1) **쓰기와 읽기의 문턱이 다르다.** 읽기는 열려 있고, 쓰기는 사용자 토큰에서 user 를
//     역산해 찍는다 — 본문으로는 user 를 사칭할 수 없어야 한다.
//  2) **거절은 원인마다 다른 상태여야 한다.** 토큰 0개(운영자가 고칠 일)와 토큰 불일치
//     (부르는 쪽이 고칠 일)를 같은 401 로 뭉개면, 운영자는 영영 맞는 값을 찾아 헤맨다.
import assert from "node:assert/strict";
import test from "node:test";

import { openDb } from "../src/core/db.mjs";
import { MemoStore } from "../src/memo/memo-store.mjs";
import { TokenStore } from "../src/auth/token-store.mjs";
import { createMemoRoutes } from "../src/memo/routes.mjs";

// 라우터 하나만 세운다. users 에 적은 사용자마다 토큰을 발급해 돌려준다.
function rig(users = ["kim"]) {
  const db = openDb(":memory:");
  const memoStore = new MemoStore(db);
  const tokenStore = new TokenStore(db);
  const tokens = Object.fromEntries(users.map((u) => [u, tokenStore.issue({ user: u }).token]));
  return { handle: createMemoRoutes({ memoStore, tokenStore }), memoStore, tokenStore, tokens };
}

test("이 축의 경로가 아니면 null — 다음 라우터로 넘어간다", async () => {
  const { handle } = rig();
  assert.equal(await handle("GET", "/api/health"), null);
  assert.equal(await handle("GET", "/api/memoranda"), null); // 접두사만 닮은 남의 경로
});

test("읽기는 토큰 없이 열려 있다", async () => {
  const { handle, memoStore } = rig();
  memoStore.create({ body: "first" }, "kim");
  const list = await handle("GET", "/api/memos", {}, {});
  assert.equal(list.status, 200);
  assert.equal(list.json.count, 1);
  assert.equal(list.json.memos[0].body, "first");
});

test("토큰 0개는 401 이 아니라 503 — 고칠 사람이 다르다", async () => {
  const { handle } = rig([]);
  const res = await handle("POST", "/api/memos", { body: "x" }, { "x-memo-token": "bm_anything" });
  assert.equal(res.status, 503);
  assert.equal(res.json.code, "no_tokens_issued");
  // 읽기는 계속 된다.
  assert.equal((await handle("GET", "/api/memos", {}, {})).status, 200);
});

test("쓰기는 토큰 없이 401, 틀린 토큰도 401", async () => {
  const { handle } = rig();
  const none = await handle("POST", "/api/memos", { body: "x" }, {});
  assert.equal(none.status, 401);
  assert.equal(none.json.code, "memo_token_invalid");
  assert.equal((await handle("POST", "/api/memos", { body: "x" }, { "x-memo-token": "bm_wrong" })).status, 401);
});

test("폐기된 토큰은 그 순간부터 401", async () => {
  const { handle, tokenStore, tokens } = rig(["kim"]);
  tokenStore.issue({ user: "lee" }); // 폐기 뒤에도 활성 토큰이 남아 503 으로 새지 않게
  const rec = tokenStore.list().find((t) => t.user === "kim");
  tokenStore.revoke(rec.id);
  const res = await handle("POST", "/api/memos", { body: "x" }, { "x-memo-token": tokens.kim });
  assert.equal(res.status, 401);
});

test("user 는 토큰에서 찍힌다 — 본문의 author 와는 별개다", async () => {
  const { handle, tokens } = rig(["kim"]);
  const made = await handle("POST", "/api/memos",
    { body: "밤에 실패", author: "claude/night" }, { "x-memo-token": tokens.kim });
  assert.equal(made.status, 201);
  assert.equal(made.json.memo.user, "kim");
  assert.equal(made.json.memo.updatedBy, "kim");
  assert.equal(made.json.memo.author, "claude/night");
});

test("본문으로 user 를 보내면 400 user_readonly — 조용한 무시는 사칭의 반쪽이다", async () => {
  const { handle, tokens } = rig(["kim"]);
  const res = await handle("POST", "/api/memos", { body: "x", user: "lee" }, { "x-memo-token": tokens.kim });
  assert.equal(res.status, 400);
  assert.equal(res.json.code, "user_readonly");
});

test("다른 사용자의 PATCH 는 updatedBy 만 바꾼다 — user 는 만든 사람의 것", async () => {
  const { handle, tokens } = rig(["kim", "lee"]);
  const made = await handle("POST", "/api/memos", { body: "x" }, { "x-memo-token": tokens.kim });
  const { id } = made.json.memo;
  const patched = await handle("PATCH", `/api/memos/${id}`, { status: "done" }, { "x-memo-token": tokens.lee });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.memo.user, "kim");
  assert.equal(patched.json.memo.updatedBy, "lee");
});

test("Authorization: Bearer 로도 통과한다", async () => {
  const { handle, tokens } = rig(["kim"]);
  const res = await handle("POST", "/api/memos", { body: "x" }, { authorization: `Bearer ${tokens.kim}` });
  assert.equal(res.status, 201);
});

test("접수 → 조회 → 부분 갱신 → 삭제 왕복", async () => {
  const { handle, tokens } = rig(["kim"]);
  const auth = { "x-memo-token": tokens.kim };
  const made = await handle("POST", "/api/memos", { title: "야간 판독", body: "3번 면 실패" }, auth);
  const { id } = made.json.memo;

  const got = await handle("GET", `/api/memos/${id}`, {}, {});
  assert.equal(got.json.memo.title, "야간 판독");

  const patched = await handle("PATCH", `/api/memos/${id}`, { status: "done" }, auth);
  assert.equal(patched.json.memo.status, "done");
  assert.equal(patched.json.memo.body, "3번 면 실패"); // 안 보낸 필드는 그대로

  const gone = await handle("DELETE", `/api/memos/${id}`, {}, auth);
  assert.equal(gone.json.deleted, true);
  assert.equal((await handle("GET", `/api/memos/${id}`, {}, {})).status, 404);
});

test("없는 id 와 숫자가 아닌 id 는 똑같이 404", async () => {
  const { handle } = rig();
  for (const id of ["999", "abc", "1.5", "-2"]) {
    const res = await handle("GET", `/api/memos/${id}`, {}, {});
    assert.equal(res.status, 404, `id=${id}`);
    assert.equal(res.json.code, "memo_not_found");
  }
});

test("잘못된 본문은 400 + 코드 (인증을 통과한 뒤의 이야기다)", async () => {
  const { handle, tokens } = rig(["kim"]);
  const auth = { "x-memo-token": tokens.kim };
  const empty = await handle("POST", "/api/memos", { body: "  " }, auth);
  assert.equal(empty.status, 400);
  assert.equal(empty.json.code, "empty_body");

  const made = await handle("POST", "/api/memos", { body: "x" }, auth);
  const noop = await handle("PATCH", `/api/memos/${made.json.memo.id}`, { tilte: "오타" }, auth);
  assert.equal(noop.status, 400);
  assert.equal(noop.json.code, "no_fields");
});

test("지원하지 않는 메서드는 405 — 종단 404 로 흘리면 '경로가 없다'는 거짓말이 된다", async () => {
  const { handle, tokens } = rig(["kim"]);
  const auth = { "x-memo-token": tokens.kim };
  const made = await handle("POST", "/api/memos", { body: "x" }, auth);
  assert.equal((await handle("PUT", `/api/memos/${made.json.memo.id}`, { body: "y" }, auth)).status, 405);
});
