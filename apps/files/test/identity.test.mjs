// 정체성 캐시 — 주제는 하나다: **보드가 없어도 아는 답으로는 버틴다.**
// 다운로드 인증이 요청마다 이 캐시를 지나므로, 캐시의 성질이 곧 릴리스 채널의 가용성이다.
import assert from "node:assert/strict";
import test from "node:test";

import { createIdentity } from "../src/core/identity.mjs";

function fakeMemo() {
  const state = { calls: 0, down: false, answer: { status: 200, body: { user: "kim", admin: false } } };
  const fetchImpl = async () => {
    state.calls += 1;
    if (state.down) throw new Error("ECONNREFUSED");
    return { ok: state.answer.status === 200, status: state.answer.status, json: async () => state.answer.body };
  };
  return { state, fetchImpl };
}

test("긍정 답은 TTL 동안 캐시된다 — 보드를 요청마다 때리지 않는다", async () => {
  const { state, fetchImpl } = fakeMemo();
  let clock = 0;
  const id = createIdentity({ memoApi: "http://memo", fetchImpl, now: () => clock, ttlMs: 1000 });

  assert.deepEqual(await id.resolve("tok"), { ok: true, user: "kim", admin: false });
  await id.resolve("tok");
  await id.resolve("tok");
  assert.equal(state.calls, 1, "TTL 안에서는 한 번이다");

  clock = 1001;
  await id.resolve("tok");
  assert.equal(state.calls, 2, "TTL 이 지나면 다시 묻는다");
});

test("부정 답도 짧게 캐시된다 — 틀린 토큰의 재시도가 보드를 두들기지 않게", async () => {
  const { state, fetchImpl } = fakeMemo();
  state.answer = { status: 401, body: { code: "memo_token_invalid" } };
  let clock = 0;
  const id = createIdentity({ memoApi: "http://memo", fetchImpl, now: () => clock, negativeTtlMs: 100 });

  const v = await id.resolve("wrong");
  assert.deepEqual(v, { ok: false, status: 401, code: "memo_token_invalid" });
  await id.resolve("wrong");
  assert.equal(state.calls, 1);
  clock = 101;
  await id.resolve("wrong");
  assert.equal(state.calls, 2, "부정 캐시는 짧다 — 방금 발급받은 토큰이 오래 거절되지 않게");
});

test("보드가 죽으면 만료된 답이라도 쓴다 — 릴리스 다운로드는 보드 재시작의 볼모가 아니다", async () => {
  const { state, fetchImpl } = fakeMemo();
  let clock = 0;
  const id = createIdentity({ memoApi: "http://memo", fetchImpl, now: () => clock, ttlMs: 1000, staleMaxMs: 10_000 });

  await id.resolve("tok");
  state.down = true;
  clock = 5000; // TTL 은 지났고 staleMax 안이다
  assert.deepEqual(await id.resolve("tok"), { ok: true, user: "kim", admin: false }, "묵은 답으로 버틴다");

  clock = 20_000; // staleMax 도 지났다
  const v = await id.resolve("tok");
  assert.equal(v.code, "identity_unavailable", "한도를 넘으면 정확한 원인으로 거절한다 — 네 토큰이 틀렸다가 아니라");
  assert.equal(v.status, 503);
});

test("아는 답이 없는 채로 보드가 죽으면 identity_unavailable — 즉시", async () => {
  const { state, fetchImpl } = fakeMemo();
  state.down = true;
  const id = createIdentity({ memoApi: "http://memo", fetchImpl });
  const v = await id.resolve("never-seen");
  assert.deepEqual(v, { ok: false, status: 503, code: "identity_unavailable" });
});

test("빈 토큰은 보드에 묻지도 않는다", async () => {
  const { state, fetchImpl } = fakeMemo();
  const id = createIdentity({ memoApi: "http://memo", fetchImpl });
  const v = await id.resolve("");
  assert.equal(v.code, "memo_token_invalid");
  assert.equal(state.calls, 0);
});
