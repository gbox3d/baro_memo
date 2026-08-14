// `/api/admin/tokens*` 의 계약. 핵심은 권한의 분리다 — **사용자 토큰으로는 토큰을 만들 수
// 없다.** 그게 가능하면 토큰을 가진 누구나 신분을 늘릴 수 있어 user 추적이 무너진다.
import assert from "node:assert/strict";
import test from "node:test";

import { openDb } from "../src/core/db.mjs";
import { TokenStore } from "../src/auth/token-store.mjs";
import { MemoStore } from "../src/memo/memo-store.mjs";
import { CommentStore } from "../src/memo/comment-store.mjs";
import { AuditStore } from "../src/memo/audit-store.mjs";
import { createAdminRoutes } from "../src/admin/routes.mjs";

const ADMIN = "adm_s3cr3t";

// 라우터 서명은 (method, pathname, query, body, headers) 다. 토큰 축은 쿼리를 쓰지 않아
// 기본값이 null 이고, 이력 축은 마지막 인자로 쿼리를 건다.
function rig({ adminToken = ADMIN } = {}) {
  const db = openDb(":memory:");
  const tokenStore = new TokenStore(db);
  const memoStore = new MemoStore(db);
  const commentStore = new CommentStore(db);
  const auditStore = new AuditStore(db);
  const router = createAdminRoutes({ tokenStore, auditStore, adminToken });
  return {
    handle: (method, path, body = {}, headers = {}, query = null) => router(method, path, query, body, headers),
    admin: { "x-memo-token": adminToken },
    tokenStore, memoStore, commentStore, auditStore,
  };
}

const auth = { "x-memo-token": ADMIN };

test("이 축의 경로가 아니면 null", async () => {
  const { handle } = rig();
  assert.equal(await handle("GET", "/api/memos"), null);
  assert.equal(await handle("GET", "/api/admin"), null);
});

test("ADMIN_TOKEN 미설정은 503 — 어떤 값을 보내도 통하지 않는다", async () => {
  const { handle } = rig({ adminToken: "" });
  const res = await handle("GET", "/api/admin/tokens", {}, auth);
  assert.equal(res.status, 503);
  assert.equal(res.json.code, "admin_token_unset");
});

test("틀린 관리자 토큰은 401", async () => {
  const { handle } = rig();
  const res = await handle("GET", "/api/admin/tokens", {}, { "x-memo-token": "아니오" });
  assert.equal(res.status, 401);
  assert.equal(res.json.code, "admin_token_invalid");
});

test("사용자 토큰으로는 관리 축이 열리지 않는다 — 권한 분리의 핵심", async () => {
  const { handle, tokenStore } = rig();
  const rec = tokenStore.issue({ user: "kim" });
  const res = await handle("GET", "/api/admin/tokens", {}, { "x-memo-token": rec.token });
  assert.equal(res.status, 401);
});

test("발급 → 목록 → 폐기 왕복", async () => {
  const { handle } = rig();
  const made = await handle("POST", "/api/admin/tokens", { user: "kim", note: "현장" }, auth);
  assert.equal(made.status, 201);
  assert.match(made.json.token.token, /^bm_/);
  assert.equal(made.json.token.user, "kim");

  const list = await handle("GET", "/api/admin/tokens", {}, auth);
  assert.equal(list.json.count, 1);

  const revoked = await handle("DELETE", `/api/admin/tokens/${made.json.token.id}`, {}, auth);
  assert.equal(revoked.json.revoked, true);
  assert.ok(revoked.json.token.revokedAt);

  // 재폐기는 revoked:false — 실패가 아니라 이미 원하는 상태다.
  const again = await handle("DELETE", `/api/admin/tokens/${made.json.token.id}`, {}, auth);
  assert.equal(again.json.revoked, false);
});

test("빈 user 는 400 empty_user", async () => {
  const { handle } = rig();
  const res = await handle("POST", "/api/admin/tokens", { user: " " }, auth);
  assert.equal(res.status, 400);
  assert.equal(res.json.code, "empty_user");
});

test("없는 id 와 숫자가 아닌 id 는 똑같이 404", async () => {
  const { handle } = rig();
  for (const id of ["999", "abc"]) {
    const res = await handle("DELETE", `/api/admin/tokens/${id}`, {}, auth);
    assert.equal(res.status, 404, `id=${id}`);
    assert.equal(res.json.code, "token_not_found");
  }
});

test("지원하지 않는 메서드는 405", async () => {
  const { handle } = rig();
  const made = await handle("POST", "/api/admin/tokens", { user: "kim" }, auth);
  assert.equal((await handle("PUT", `/api/admin/tokens/${made.json.token.id}`, {}, auth)).status, 405);
  assert.equal((await handle("PATCH", "/api/admin/tokens", {}, auth)).status, 405);
});

// ---- 삭제·수정 이력 -----------------------------------------------------------------------
//
// 관리자 축에 있는 이유는 내용물이다: 지워진 메모의 전문이 들어 있다. 사용자 토큰으로 열리면
// "지웠다"가 "목록에서만 빠졌다"가 된다.

test("이력은 관리자 토큰으로만 열린다", async () => {
  const { handle, admin } = rig();
  const anonymous = await handle("GET", "/api/admin/audit", {}, {});
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.json.code, "admin_token_invalid");

  const ok = await handle("GET", "/api/admin/audit", {}, admin);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { count: 0, total: 0, limit: 50, offset: 0, entries: [] });
});

test("이력에 삭제된 메모의 전문이 남는다", async () => {
  const { handle, admin, memoStore } = rig();
  const memo = memoStore.create({ title: "지울 것", body: "사라질 본문" }, "kim");
  memoStore.remove(memo.id, "kim");

  const res = await handle("GET", "/api/admin/audit", {}, admin);
  assert.equal(res.json.total, 1);
  const [entry] = res.json.entries;
  assert.equal(entry.action, "memo_delete");
  assert.equal(entry.actor, "kim");
  assert.equal(entry.before.memo.body, "사라질 본문");
});

test("이력 쿼리도 오타를 거절한다 — 조용한 무시는 없다", async () => {
  const { handle, admin } = rig();
  const typo = await handle("GET", "/api/admin/audit", {}, admin, "memoid=3");
  assert.equal(typo.status, 400);
  assert.equal(typo.json.code, "unknown_param");

  const badAction = await handle("GET", "/api/admin/audit", {}, admin, "action=memo_burn");
  assert.equal(badAction.status, 400);
  assert.equal(badAction.json.code, "invalid_param");

  const badLimit = await handle("GET", "/api/admin/audit", {}, admin, "limit=0");
  assert.equal(badLimit.status, 400);
});

test("이력에는 쓰기 경로가 없다", async () => {
  const { handle, admin } = rig();
  for (const method of ["POST", "PATCH", "DELETE"]) {
    const res = await handle(method, "/api/admin/audit", { anything: 1 }, admin);
    assert.equal(res.status, 405, `${method} 가 405 가 아닙니다`);
  }
});
