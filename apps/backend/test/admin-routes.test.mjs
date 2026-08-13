// `/api/admin/tokens*` 의 계약. 핵심은 권한의 분리다 — **사용자 토큰으로는 토큰을 만들 수
// 없다.** 그게 가능하면 토큰을 가진 누구나 신분을 늘릴 수 있어 user 추적이 무너진다.
import assert from "node:assert/strict";
import test from "node:test";

import { openDb } from "../src/core/db.mjs";
import { TokenStore } from "../src/auth/token-store.mjs";
import { createAdminRoutes } from "../src/admin/routes.mjs";

const ADMIN = "adm_s3cr3t";

// 라우터 서명은 (method, pathname, query, body, headers) 다. 이 축은 쿼리를 쓰지 않으므로
// 자리를 null 로 채워 두고 검사는 body·headers 만 본다.
function rig({ adminToken = ADMIN } = {}) {
  const tokenStore = new TokenStore(openDb(":memory:"));
  const router = createAdminRoutes({ tokenStore, adminToken });
  return {
    handle: (method, path, body = {}, headers = {}) => router(method, path, null, body, headers),
    tokenStore,
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
