// /api/help 가 낡지 않게 지키는 테스트 — baro_calrory 의 양방향 규약을 그대로 가져온다:
//   (1) AGENT_ROUTES 와 문서에 적힌 모든 경로가 코드에 실재하는가 (유령 경로 금지)
//   (2) AGENT_ROUTES 의 모든 라우트가 자기 주제 문서에 실제로 적혀 있는가 (누락 금지)
// (1)의 "실재"는 라우터 파일에서 뽑아낸 경로 리터럴·경로 정규식에 대한 매칭이다.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AGENT_ROUTES, HELP_DIR, HELP_TOPICS,
  buildLiveState, helpIndexJson, serveHelp, topicFile,
} from "../src/core/help-doc.mjs";
import { openDb } from "../src/core/db.mjs";
import { MemoStore } from "../src/memo/memo-store.mjs";
import { TokenStore } from "../src/auth/token-store.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, "..", "src");
const ROUTE_FILES = ["server.mjs", "memo/routes.mjs", "admin/routes.mjs", "auth/routes.mjs"];
const BASE = "/memo";

function liveRig() {
  const db = openDb(":memory:");
  const memoStore = new MemoStore(db);
  const tokenStore = new TokenStore(db);
  memoStore.create({ body: "x" }, "kim");
  tokenStore.issue({ user: "kim" });
  return buildLiveState({ memoStore, tokenStore, adminConfigured: true, version: "9.9.9" });
}

// ---- 코드에서 실제 라우트를 뽑는다 ------------------------------------------------------
async function routeSurface() {
  const sources = await Promise.all(ROUTE_FILES.map((f) => readFile(resolve(SRC, f), "utf8")));
  const literals = new Set();
  const patterns = [];
  for (const src of sources) {
    for (const m of src.matchAll(/"(\/api\/[^"]*)"/g)) literals.add(m[1]);
    // pathname.match(/^\/api\/…$/) 형태의 경로 정규식 — 줄 단위로 떼어낸다.
    for (const line of src.split("\n")) {
      const at = line.indexOf("pathname.match(/");
      if (at < 0) continue;
      const start = at + "pathname.match(/".length;
      const end = line.lastIndexOf("/)");
      if (end <= start) continue;
      patterns.push(new RegExp(line.slice(start, end)));
    }
  }
  assert.ok(literals.size > 4, "라우트 리터럴 추출이 실패했습니다 (파서를 고치세요)");
  assert.ok(patterns.length >= 3, "라우트 정규식 추출이 실패했습니다 (파서를 고치세요)");
  return { literals, patterns };
}

function pathExists({ literals, patterns }, path) {
  const sample = path.replace(/:[A-Za-z0-9_]+/g, "sample1");
  if (literals.has(sample)) return true;
  return patterns.some((re) => re.test(sample));
}

test("유령 경로 검사가 실제로 거른다 — 가드의 가드", async () => {
  const surface = await routeSurface();
  for (const ghost of ["/api/this-route-does-not-exist", "/api/memoranda", "/api/admin/users"]) {
    assert.equal(pathExists(surface, ghost), false, `유령 경로가 통과했다: ${ghost}`);
  }
  for (const real of ["/api/health", "/api/memos/:memoId", "/api/admin/tokens/:tokenId", "/api/help"]) {
    assert.equal(pathExists(surface, real), true, `실재 경로를 막았다: ${real}`);
  }
});

test("AGENT_ROUTES 의 모든 경로가 코드에 실재한다", async () => {
  const surface = await routeSurface();
  for (const r of AGENT_ROUTES) {
    assert.ok(pathExists(surface, r.path), `문서에만 있는 유령 경로: ${r.method} ${r.path}`);
  }
});

test("코드의 라우트가 인덱스에서 빠지지 않는다 — '전량'의 반대 방향", async () => {
  const indexed = new Set(AGENT_ROUTES.map((r) => r.path.replace(/:[A-Za-z0-9_]+/g, ":id")));
  const missing = [];
  for (const f of ROUTE_FILES) {
    const src = await readFile(resolve(SRC, f), "utf8");
    for (const m of src.matchAll(/pathname === "(\/api\/[^"]+)"/g)) {
      if (!indexed.has(m[1])) missing.push(m[1]);
    }
  }
  assert.deepEqual(missing, [], `라우터에 있는데 AGENT_ROUTES 에 없는 라우트: ${missing.join(", ")}`);
});

test("문서에 적힌 모든 API 경로가 코드에 실재한다", async () => {
  const surface = await routeSurface();
  for (const topic of HELP_TOPICS) {
    const md = await readFile(topicFile(topic), "utf8");
    for (const m of md.matchAll(/`(GET|POST|PUT|DELETE|PATCH) \{\{BASE\}\}(\/api\/[^`?\s]+)`/g)) {
      assert.ok(pathExists(surface, m[2]), `${topic}.md 가 없는 경로를 안내합니다: ${m[1]} ${m[2]}`);
    }
  }
});

test("모든 라우트가 자기 주제 문서에 적혀 있다", async () => {
  const docs = new Map();
  for (const topic of HELP_TOPICS) docs.set(topic, await readFile(topicFile(topic), "utf8"));
  for (const r of AGENT_ROUTES) {
    const md = docs.get(r.topic);
    assert.ok(md, `알 수 없는 주제: ${r.topic}`);
    assert.ok(md.includes(`\`${r.method} {{BASE}}${r.path}\``),
      `${r.topic}.md 에 ${r.method} ${r.path} 설명이 없습니다`);
    assert.ok(r.summary?.trim(), `${r.path} 의 요약이 비었습니다`);
  }
  // 주제별로 최소 한 줄씩 — 빈 주제는 문서만 있고 길이 없는 상태다.
  for (const topic of HELP_TOPICS) {
    assert.ok(AGENT_ROUTES.some((r) => r.topic === topic), `라우트가 하나도 없는 주제: ${topic}`);
  }
});

test("주제 문서가 전부 존재하고 index 로 돌아가는 길이 있다", async () => {
  for (const topic of HELP_TOPICS) {
    const res = await serveHelp({ topic, basePath: BASE, origin: "http://board.test" });
    assert.equal(res.status, 200);
    assert.match(res.contentType, /^text\/markdown/);
    assert.ok(res.body.length > 200, `${topic} 문서가 비었습니다`);
    assert.ok(!res.body.includes("{{BASE}}"), "치환되지 않은 {{BASE}} 가 남았습니다");
    assert.ok(!res.body.includes("{{ORIGIN}}"), "치환되지 않은 {{ORIGIN}} 이 남았습니다");
    assert.ok(res.body.includes(`${BASE}/api/`), "외부 URL 접두사가 문서에 반영되지 않았습니다");
    if (topic !== "index") {
      assert.ok(res.body.includes(`[index](${BASE}/api/help)`), `${topic} 에 index 로 가는 링크가 없습니다`);
    }
  }
});

test("help 디렉터리에 주제 목록 밖의 파일이 없다 — 영문 단일 언어 계약", async () => {
  const names = await readdir(HELP_DIR);
  for (const name of names) {
    assert.match(name, /^[a-z0-9-]+\.md$/, `언어 변형으로 보이는 파일: ${name}`);
    assert.ok(HELP_TOPICS.includes(name.replace(/\.md$/, "")), `주제 목록에 없는 문서: ${name}`);
  }
  assert.equal(names.length, HELP_TOPICS.length);
});

test("서빙되는 문서에 한글이 섞이지 않는다 — 이 표면의 독자는 기계다", async () => {
  const live = liveRig();
  for (const topic of HELP_TOPICS) {
    const res = await serveHelp({ topic, live, basePath: "" });
    const hangul = res.body.split("\n").filter((l) => /[가-힣]/.test(l));
    assert.deepEqual(hangul, [], `${topic}.md 에 한글이 섞였습니다`);
  }
});

test("알 수 없는 주제는 404 + 주제 목록", async () => {
  const res = await serveHelp({ topic: "nope", basePath: BASE });
  assert.equal(res.status, 404);
  assert.equal(res.json.topics.length, HELP_TOPICS.length);
});

test("index 에만 라이브 블록이 붙는다", async () => {
  const live = liveRig();
  const index = await serveHelp({ topic: "index", live, basePath: BASE });
  const memo = await serveHelp({ topic: "memo", live, basePath: BASE });
  assert.ok(index.body.includes("9.9.9"), "index 에 라이브 블록이 없습니다");
  assert.ok(!memo.body.includes("9.9.9"), "주제 문서에 라이브 블록이 새어 나갔습니다");
});

test("라이브 블록에 토큰 값이 실리지 않는다 — 개수까지가 사실이다", () => {
  const db = openDb(":memory:");
  const tokenStore = new TokenStore(db);
  const rec = tokenStore.issue({ user: "kim" });
  const live = buildLiveState({ memoStore: new MemoStore(db), tokenStore, adminConfigured: true, version: "1.0.0" });
  const dump = JSON.stringify(live);
  assert.ok(!dump.includes(rec.token), "라이브 상태가 토큰 값을 노출합니다");
  assert.ok(!dump.includes("kim"), "라이브 상태가 사용자 이름을 노출합니다");
  assert.deepEqual(live.tokens, { active: 1, revoked: 0 });
});

test("토큰 0개면 라이브 블록이 쓰기 불가를 말한다", async () => {
  const db = openDb(":memory:");
  const live = buildLiveState({
    memoStore: new MemoStore(db), tokenStore: new TokenStore(db),
    adminConfigured: false, version: "1.0.0",
  });
  const res = await serveHelp({ topic: "index", live, basePath: "" });
  assert.ok(res.body.includes("no_tokens_issued"), "쓰기 불가 경고가 없습니다");
  assert.ok(res.body.includes("admin_token_unset"), "관리자 미설정 경고가 없습니다");
});

test("format=json 은 라우트 인덱스를 준다 (경로에 base 가 붙는다)", async () => {
  const res = await serveHelp({ format: "json", basePath: BASE, live: liveRig() });
  assert.equal(res.status, 200);
  assert.equal(res.contentType, "application/json");
  assert.equal(res.json.routes.length, AGENT_ROUTES.length);
  assert.equal(res.json.backendVersion, "9.9.9");
  for (const r of res.json.routes) {
    assert.ok(r.path.startsWith(`${BASE}/api/`), `base 누락: ${r.path}`);
    assert.ok(r.summary?.trim(), `요약 누락: ${r.path}`);
  }
  assert.deepEqual(res.json.topics.map((t) => t.topic), HELP_TOPICS);
});

test("목록 라우트의 쿼리 힌트가 실제 파라미터와 어긋나지 않는다", async () => {
  const route = AGENT_ROUTES.find((r) => r.method === "GET" && r.path === "/api/memos");
  assert.ok(route.query, "목록 라우트에 쿼리 힌트가 없습니다");
  // 힌트에 적힌 이름이 라우터가 실제로 받는 이름인지 — 문서만 아는 파라미터는 유령이다.
  const src = await readFile(resolve(SRC, "memo/routes.mjs"), "utf8");
  const allowed = src.match(/const LIST_PARAMS = new Set\(\[([^\]]*)\]\)/)[1]
    .match(/"([a-z]+)"/g).map((s) => s.replaceAll('"', ""));
  for (const name of new URLSearchParams(route.query).keys()) {
    assert.ok(allowed.includes(name), `힌트에만 있는 쿼리 파라미터: ${name}`);
  }
  // 반대 방향 — 받는데 문서에 없는 것.
  for (const name of allowed) {
    assert.match(route.query, new RegExp(`[?&]${name}=`), `문서에서 빠진 쿼리 파라미터: ${name}`);
  }
});

test("본문이 있는 라우트는 body 힌트를 싣는다 — GET 에는 없다", () => {
  const withBody = AGENT_ROUTES.filter((r) => r.body);
  assert.ok(withBody.length >= 3, "body 힌트가 거의 없습니다");
  for (const r of withBody) assert.notEqual(r.method, "GET", `GET 에 body 힌트가 붙었습니다: ${r.path}`);
  const index = helpIndexJson({ basePath: BASE });
  const post = index.routes.find((r) => r.path.endsWith("/api/memos") && r.method === "POST");
  assert.match(post.body, /author\?/);
});
