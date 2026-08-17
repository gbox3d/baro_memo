// 정체성 축. 주제는 하나다: **토큰이 누구인가에 대한 답이 보드의 문턱과 같은 구분으로
// 갈라진다.** 0.11.0 부터 그 답을 두 소비자가 쓴다 — `/api/auth/whoami` 와, 같은 프로세스의
// 아티팩트 저장소다. 그래서 검사는 라우트가 아니라 **판정(createVerdict)** 을 겨눈다: 여기서
// 갈라지는 코드가 곧 발행 권한과 다운로드 인증이다.
import assert from "node:assert/strict";
import test from "node:test";

import { openDb } from "../src/core/db.mjs";
import { TokenStore } from "../src/auth/token-store.mjs";
import { createVerdict } from "../src/auth/verdict.mjs";
import { createAuthRoutes } from "../src/auth/routes.mjs";

function rig({ adminToken = "adm_test_value" } = {}) {
  const db = openDb(":memory:");
  const tokenStore = new TokenStore(db);
  const verdict = createVerdict({ tokenStore, adminToken });
  const router = createAuthRoutes({ verdict });
  return { tokenStore, router, verdict, adminToken };
}

// 저장소가 이 판정을 그대로 받아 발행을 가른다 — 라우트를 거치지 않으므로 여기서 못 박는다.
test("판정은 셋으로 갈린다 — 사람, 사람 없는 관리자, 그리고 남", () => {
  const { verdict, tokenStore, adminToken } = rig();
  const { token } = tokenStore.issue({ user: "kim" });

  assert.deepEqual(verdict(token), { ok: true, user: "kim", admin: false });
  // user === null 이 곧 "발행 불가" 의 근거다. 저장소가 이 값 하나로 admin_token_cannot_publish 를 낸다.
  assert.deepEqual(verdict(adminToken), { ok: true, user: null, admin: true });
  assert.equal(verdict("bm_wrong").code, "memo_token_invalid");
});

test("폐기는 다음 요청부터 듣는다 — 프로세스가 합쳐지며 캐시가 사라진 자리다", () => {
  const { verdict, tokenStore } = rig();
  const { token } = tokenStore.issue({ user: "kim" });
  tokenStore.issue({ user: "lee" });
  assert.equal(verdict(token).user, "kim");

  tokenStore.revoke(tokenStore.list().find((t) => t.user === "kim").id);
  // 0.10.0 까지는 저장소가 HTTP 로 물어 분 단위로 캐시했다 — 폐기가 그만큼 늦게 닿았다.
  assert.equal(verdict(token).ok, false, "같은 프로세스라면 폐기는 즉시여야 한다");
  assert.equal(verdict(token).status, 401);
});

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
