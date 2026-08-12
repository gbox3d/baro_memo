// 토큰 저장소 — "토큰에서 사용자를 역산할 수 있는가"와 "폐기가 즉시 서는가"가 전부다.
import assert from "node:assert/strict";
import test from "node:test";

import { openDb } from "../src/core/db.mjs";
import { TokenStore, toTokenId } from "../src/auth/token-store.mjs";

function rig() {
  return new TokenStore(openDb(":memory:"));
}

test("발급 → 역산: 토큰이 사용자를 가리킨다", () => {
  const store = rig();
  const rec = store.issue({ user: "kim", note: "현장" });
  assert.match(rec.token, /^bm_[A-Za-z0-9_-]+$/);
  assert.equal(store.userFor(rec.token), "kim");
});

test("모르는 토큰·빈 토큰은 null", () => {
  const store = rig();
  store.issue({ user: "kim" });
  assert.equal(store.userFor("bm_nope"), null);
  assert.equal(store.userFor(""), null);
  assert.equal(store.userFor(undefined), null);
});

test("폐기는 즉시고, 재폐기는 false — 이미 원하는 상태다", () => {
  const store = rig();
  const rec = store.issue({ user: "kim" });
  assert.equal(store.revoke(rec.id), true);
  assert.equal(store.userFor(rec.token), null);
  assert.equal(store.revoke(rec.id), false);
  assert.ok(store.get(rec.id).revokedAt); // 행은 남는다 — 추적이 존재 이유다
});

test("같은 사용자에게 여러 토큰 — 값은 전부 다르다", () => {
  const store = rig();
  const a = store.issue({ user: "kim" });
  const b = store.issue({ user: "kim" });
  assert.notEqual(a.token, b.token);
  assert.equal(store.userFor(a.token), "kim");
  assert.equal(store.userFor(b.token), "kim");
});

test("빈 사용자·비문자열은 거절", () => {
  const store = rig();
  assert.throws(() => store.issue({ user: " " }), { code: "empty_user" });
  assert.throws(() => store.issue({ user: 3 }), { code: "invalid_field" });
  assert.throws(() => store.issue({ user: "kim", note: "x".repeat(201) }), { code: "too_long" });
});

test("counts 가 활성/폐기를 가른다", () => {
  const store = rig();
  const a = store.issue({ user: "kim" });
  store.issue({ user: "lee" });
  store.revoke(a.id);
  assert.deepEqual(store.counts(), { active: 1, revoked: 1 });
});

test("목록은 최신순이고 toTokenId 는 양의 정수만", () => {
  const store = rig();
  store.issue({ user: "kim" });
  store.issue({ user: "lee" });
  assert.deepEqual(store.list().map((t) => t.user), ["lee", "kim"]);
  assert.equal(toTokenId("2"), 2);
  for (const bad of ["abc", "0", "-1", "1.5"]) assert.equal(toTokenId(bad), null, bad);
});
