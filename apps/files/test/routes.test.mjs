// /api/* JSON 라우트의 계약. 주제는 보드와 같은 둘이다:
//  1) 읽기는 토큰이면 되고, **발행은 사람**이어야 한다(관리자 토큰은 귀속할 사람이 없다).
//  2) 거절은 원인마다 다른 상태다 — 401/403/404/405/409/503/507 이 각각 다른 사람의 일이다.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "../src/core/db.mjs";
import { FileStore, LIMITS } from "../src/files/store.mjs";
import { createFileRoutes } from "../src/files/routes.mjs";

const sha = (buf) => createHash("sha256").update(buf).digest("hex");

// 정체성은 표로 흉내 낸다 — 이 파일의 주제는 문턱이지 캐시가 아니다(캐시는 identity.test.mjs).
function fakeIdentity(table) {
  return {
    resolve: async (token) => table[token] || { ok: false, status: 401, code: "memo_token_invalid" },
    cacheSize: () => 0,
  };
}

async function rig() {
  const root = await mkdtemp(join(tmpdir(), "baro-files-routes-"));
  test.after(() => rm(root, { recursive: true, force: true }));
  const store = new FileStore(openDb(":memory:"), { root });
  await store.init();
  const identity = fakeIdentity({
    tok_kim: { ok: true, user: "kim", admin: false },
    tok_lee: { ok: true, user: "lee", admin: false },
    tok_adm: { ok: true, user: null, admin: true },
  });
  const routes = createFileRoutes({ store, identity, basePathOf: () => "/files" });
  const call = (method, path, { body = {}, token = "tok_kim", query = null } = {}) =>
    routes(method, path, query ? new URLSearchParams(query) : null, body, token ? { "x-memo-token": token } : {});
  return { store, call };
}

async function fill(store, id, buf) {
  const fd = await open(store.tmpPath(id), "r+");
  try { await fd.write(buf, 0, buf.length, 0); } finally { await fd.close(); }
  store.recordRange(id, 0, buf.length);
}

test("이 축의 경로가 아니면 null", async () => {
  const { call } = await rig();
  assert.equal(await call("GET", "/api/health"), null);
  assert.equal(await call("GET", "/other"), null);
});

test("verify — 문턱의 세 갈래가 그대로 내려온다", async () => {
  const { call } = await rig();
  assert.deepEqual((await call("GET", "/api/verify")).json, { user: "kim", admin: false });
  assert.deepEqual((await call("GET", "/api/verify", { token: "tok_adm" })).json, { user: null, admin: true });
  const bad = await call("GET", "/api/verify", { token: "nope" });
  assert.equal(bad.status, 401);
  assert.equal(bad.json.code, "memo_token_invalid");
  assert.equal((await call("POST", "/api/verify")).status, 405);
});

test("세션 생성 — 발행은 사람 토큰만, 선언 오류는 400 두고 코드로 갈린다", async () => {
  const { call } = await rig();
  const decl = { name: "sim.zip", size: 10, sha256: "a".repeat(64) };

  const made = await call("POST", "/api/uploads", { body: decl });
  assert.equal(made.status, 201);
  assert.match(made.json.upload.id, /^up_/);
  assert.equal(made.json.upload.user, "kim");

  assert.equal((await call("POST", "/api/uploads", { body: decl, token: "tok_adm" })).json.code, "admin_token_cannot_publish");
  assert.equal((await call("POST", "/api/uploads", { body: decl, token: null })).status, 401);
  assert.equal((await call("POST", "/api/uploads", { body: { ...decl, name: "?" } })).json.code, "invalid_name");
  assert.equal((await call("POST", "/api/uploads", { body: { ...decl, sha256: "no" } })).json.code, "invalid_sha256");
});

test("남의 세션은 존재도 보이지 않는다 — 404 로 같다", async () => {
  const { call } = await rig();
  const { json: made } = await call("POST", "/api/uploads", { body: { name: "a.bin", size: 5, sha256: "a".repeat(64) } });
  const id = made.upload.id;

  assert.equal((await call("GET", `/api/uploads/${id}`)).status, 200);
  assert.equal((await call("GET", `/api/uploads/${id}`, { token: "tok_lee" })).status, 404, "남의 것은 없다와 같다");
  assert.equal((await call("GET", `/api/uploads/${id}`, { token: "tok_adm" })).status, 200, "운영자는 유령 세션을 치우는 사람이라 본다");
  assert.equal((await call("GET", "/api/uploads/up_nope")).status, 404);
});

test("finalize — 구멍은 409, 완성이 곧 다운로드 주소다", async () => {
  const { store, call } = await rig();
  const body = Buffer.from("finalize!");
  const { json: made } = await call("POST", "/api/uploads", { body: { name: "f.bin", size: body.length, sha256: sha(body) } });

  const hole = await call("POST", `/api/uploads/${made.upload.id}/finalize`);
  assert.equal(hole.status, 409);
  assert.equal(hole.json.code, "upload_incomplete");

  await fill(store, made.upload.id, body);
  assert.equal((await call("POST", `/api/uploads/${made.upload.id}/finalize`, { token: "tok_lee" })).status, 404, "finalize 도 남의 것은 없다");

  const done = await call("POST", `/api/uploads/${made.upload.id}/finalize`);
  assert.equal(done.status, 201);
  assert.equal(done.json.download, `/files/dl/${sha(body)}/f.bin`, "접두사·해시·이름이 그대로 주소다");
});

test("완성본 — 목록·조회는 토큰이면 되고, 삭제는 발행자나 운영자다", async () => {
  const { store, call } = await rig();
  const body = Buffer.from("owned-by-kim");
  const { json: made } = await call("POST", "/api/uploads", { body: { name: "o.bin", size: body.length, sha256: sha(body) } });
  await fill(store, made.upload.id, body);
  await call("POST", `/api/uploads/${made.upload.id}/finalize`);

  assert.equal((await call("GET", "/api/artifacts", { token: "tok_lee" })).json.total, 1);
  assert.equal((await call("GET", "/api/artifacts", { token: "tok_adm" })).json.total, 1);
  assert.equal((await call("GET", `/api/artifacts/${sha(body)}`)).status, 200);
  assert.equal((await call("GET", `/api/artifacts/${"9".repeat(64)}`)).status, 404);

  assert.equal((await call("DELETE", `/api/artifacts/${sha(body)}`, { token: "tok_lee" })).json.code, "not_your_artifact");
  assert.equal((await call("DELETE", `/api/artifacts/${sha(body)}`, { token: "tok_adm" })).json.deleted, true, "운영자는 지울 수 있다");
});

test("모르는 쿼리 값은 400 — 조용한 무시를 만들지 않는다", async () => {
  const { call } = await rig();
  const res = await call("GET", "/api/artifacts", { query: "limit=0" });
  assert.equal(res.status, 400);
  assert.equal(res.json.code, "invalid_param");
});

test("identity_unavailable 은 retryable 이다 — 다른 거절과 다른 처지라서", async () => {
  const root = await mkdtemp(join(tmpdir(), "baro-files-id-"));
  test.after(() => rm(root, { recursive: true, force: true }));
  const store = new FileStore(openDb(":memory:"), { root });
  await store.init();
  const identity = { resolve: async () => ({ ok: false, status: 503, code: "identity_unavailable" }), cacheSize: () => 0 };
  const routes = createFileRoutes({ store, identity, basePathOf: () => "" });
  const res = await routes("GET", "/api/artifacts", null, {}, { "x-memo-token": "any" });
  assert.equal(res.status, 503);
  assert.equal(res.json.retryable, true, "보드가 곧 돌아온다 — 기다렸다 다시가 맞는 답이다");
});
