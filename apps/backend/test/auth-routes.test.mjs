// /api/auth/whoami — 정체성 축. 주제는 하나다: **토큰이 누구인가에 대한 답이 보드의 문턱과
// 같은 구분으로 갈라진다.** 이 라우트는 형제 서비스(baro_files)가 쓰므로, 여기서 갈라지는
// 코드가 곧 그 서비스의 인증 동작이다.
import assert from "node:assert/strict";
import test from "node:test";

import { openDb } from "../src/core/db.mjs";
import { TokenStore } from "../src/auth/token-store.mjs";
import { createAuthRoutes } from "../src/auth/routes.mjs";

function rig({ adminToken = "adm_test_value" } = {}) {
  const db = openDb(":memory:");
  const tokenStore = new TokenStore(db);
  const router = createAuthRoutes({ tokenStore, adminToken });
  return { tokenStore, router, adminToken };
}

test("이 축의 경로가 아니면 null — 다음 라우터로 넘어간다", async () => {
  const { router } = rig();
  assert.equal(await router("GET", "/api/auth"), null);
  assert.equal(await router("GET", "/api/auth/whoami/extra"), null);
});

test("사람 토큰은 사람을, 관리자 토큰은 사람 없음을 답한다", async () => {
  const { router, tokenStore, adminToken } = rig();
  const { token } = tokenStore.issue({ user: "kim" });

  const person = await router("GET", "/api/auth/whoami", null, {}, { "x-memo-token": token });
  assert.deepEqual(person.json, { user: "kim", admin: false });

  // 관리자 토큰은 유효하지만 귀속할 사람이 없다 — 소비자가 발행(쓰기)을 거절할 근거가 이 값이다.
  const operator = await router("GET", "/api/auth/whoami", null, {}, { "x-memo-token": adminToken });
  assert.deepEqual(operator.json, { user: null, admin: true });

  // Bearer 도 같은 표면이다.
  const bearer = await router("GET", "/api/auth/whoami", null, {}, { authorization: `Bearer ${token}` });
  assert.equal(bearer.json.user, "kim");
});

test("거절은 읽기 문턱과 같은 구분이다 — 401 과 503 은 고칠 사람이 다르다", async () => {
  const zero = rig();
  const empty = await zero.router("GET", "/api/auth/whoami", null, {}, { "x-memo-token": "bm_any" });
  assert.equal(empty.status, 503);
  assert.equal(empty.json.code, "no_tokens_issued");

  const { router, tokenStore } = rig();
  tokenStore.issue({ user: "kim" });
  const wrong = await router("GET", "/api/auth/whoami", null, {}, { "x-memo-token": "bm_wrong" });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.json.code, "memo_token_invalid");

  const rec = tokenStore.list()[0];
  const value = rec.token;
  tokenStore.revoke(rec.id);
  tokenStore.issue({ user: "lee" }); // 폐기 뒤에도 활성 토큰이 남아 503 으로 새지 않게
  const revoked = await router("GET", "/api/auth/whoami", null, {}, { "x-memo-token": value });
  assert.equal(revoked.status, 401, "폐기된 토큰은 그 순간부터 남이다");
});

test("GET 뿐이다 — 다른 메서드는 405 로 정확히 거절한다", async () => {
  const { router, adminToken } = rig();
  const res = await router("POST", "/api/auth/whoami", null, {}, { "x-memo-token": adminToken });
  assert.equal(res.status, 405);
});
