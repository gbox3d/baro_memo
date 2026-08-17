// 진짜 서버를 띄우는 왕복 검사 — 이 파일이 이 저장소의 정직성이다.
//
// 스트리밍 예외(청크 경로가 본문을 라우팅 전에 가로챈다)는 라우터 단위 검사가 못 본다.
// 여기서는 실제 HTTP 로: 순서 없는 청크 → 끊긴 청크(content-length 보다 짧은 몸통) → 같은
// 구간 재전송 → finalize → 해시 검증까지 전부 소켓을 지나간다.
//
// **0.11.0 부터 이 검사가 드는 것은 보드 서버다.** 저장소가 그 프로세스에 마운트로 들어왔고,
// 정체성도 같은 프로세스의 토큰 표에서 온다 — 그래서 예전에 whoami 만 답하던 가짜 보드가
// 사라졌다. 대신 진짜 토큰을 발급해 쓴다: 검사가 지나는 인증 경로가 운영과 같아졌다는 뜻이다.
// 외부 경로도 운영 그대로 `/api/files/...` 를 친다 — nginx 가 `/files/api/` 를 여기로 보낸다.
import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "../../backend/src/core/db.mjs";
import { TokenStore } from "../../backend/src/auth/token-store.mjs";

const work = await mkdtemp(join(tmpdir(), "baro-memo-e2e-"));
const root = join(work, "files");
const adminTokenFile = join(work, "admin.token");
const T = { adm: "adm_e2e_value" };
await writeFile(adminTokenFile, `${T.adm}\n`, { mode: 0o600 });

// 토큰을 **서버보다 먼저** 심는다 — 같은 DB 파일을 서버가 열고, 판정이 그 표에서 나온다.
const seed = openDb(join(work, "memo.db"));
const seedTokens = new TokenStore(seed);
T.kim = seedTokens.issue({ user: "kim" }).token;
T.lee = seedTokens.issue({ user: "lee" }).token;
seed.close();

process.env.NODE_ENV = "test";
process.env.MEMO_DB = join(work, "memo.db");
process.env.FILES_ROOT = root;
process.env.ADMIN_TOKEN_FILE = adminTokenFile;
const { server } = await import("../../backend/src/server.mjs");
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(async () => {
  server.close();
  await rm(work, { recursive: true, force: true });
});

// 마운트가 보드와 같은 프로세스에 있다는 사실 자체를 못 박는다 — 포트 하나, 접두사로 갈린다.
test("한 프로세스가 둘을 든다 — 보드와 저장소가 같은 포트에서 각자 답한다", async () => {
  const board = await fetch(`${base}/api/health`, { headers: { "x-memo-token": T.kim } });
  const boardJson = await board.json();
  assert.equal(boardJson.ok, true);
  assert.equal(boardJson.files, "mounted", "보드 건강이 저장소의 생사도 말해야 한다");

  const store = await (await fetch(`${base}/api/files/health`)).json();
  assert.equal(store.version, boardJson.version, "버전이 둘이면 '무엇이 배포됐나'가 두 질문이 된다");

  // **이 검사가 운영 볼륨을 열지 않았다는 증거.** 서버는 repoRoot 의 .env 도 읽는다 —
  // process.loadEnvFile 이 기존 process.env 를 덮지 않기 때문에 위에서 심은 임시 경로가 이기지만,
  // 그 동작에 조용히 기대면 어느 판에서 뒤집혔을 때 검사가 운영 저장소에 파일을 쓴다.
  // 갓 만든 임시 뿌리는 반드시 비어 있다 — 여기서 0이 아니면 남의 디스크를 연 것이다.
  assert.equal(store.store.artifacts, 0, "빈 임시 뿌리가 아니다 — 운영 볼륨을 열었을 수 있다");
  assert.equal(boardJson.board.total, 0, "빈 임시 DB 가 아니다 — 운영 보드를 열었을 수 있다");
});

const sha = (buf) => createHash("sha256").update(buf).digest("hex");

async function api(method, path, { body, token = T.kim, headers = {} } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { "x-memo-token": token } : {}),
      ...(body && !(body instanceof Uint8Array) ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body instanceof Uint8Array ? body : body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

const putChunk = (id, buf, start, extra = {}) =>
  api("PUT", `/api/files/uploads/${id}/chunks`, {
    body: buf,
    headers: { "chunk-start": String(start), "content-type": "application/octet-stream", ...extra },
  });

test("왕복: 순서 없는 청크 → 재전송 → finalize → 바이트가 store 에 그대로", async () => {
  const body = randomBytes(300 * 1024); // 300KB, 3청크
  const { json: made } = await api("POST", "/api/files/uploads", {
    body: { name: "sim_v1.zip", size: body.length, sha256: sha(body) },
  });
  const id = made.upload.id;
  const third = 100 * 1024;

  // 마지막 → 처음 → 가운데, 순서 없이. 가운데는 일부러 두 번(재전송 무해).
  assert.equal((await putChunk(id, body.subarray(2 * third), 2 * third)).json.complete, false);
  assert.equal((await putChunk(id, body.subarray(0, third), 0)).json.complete, false);
  await putChunk(id, body.subarray(third, 2 * third), third);
  const again = await putChunk(id, body.subarray(third, 2 * third), third);
  assert.equal(again.json.complete, true);
  assert.deepEqual(again.json.received, [[0, body.length]], "재전송이 구간을 늘리지 않는다");

  const done = await api("POST", `/api/files/uploads/${id}/finalize`);
  assert.equal(done.status, 201);
  assert.equal(done.json.artifact.sha256, sha(body));
  assert.deepEqual(await readFile(join(root, "store", sha(body))), body, "디스크의 바이트가 원본 그대로다");
});

test("끊긴 청크는 장부에 없다 — content-length 보다 짧은 몸통", async () => {
  const body = randomBytes(64 * 1024);
  const { json: made } = await api("POST", "/api/files/uploads", {
    body: { name: "trunc.bin", size: body.length, sha256: sha(body) },
  });
  const id = made.upload.id;

  // content-length 를 실제보다 크게 선언하고 소켓을 끊는다 — Node http 클라이언트로는
  // 어렵고, 날소켓으로 절반만 쓰고 닫는다.
  await new Promise((resolve) => {
    const net = server.address();
    const sock = http.request({
      host: "127.0.0.1", port: net.port, method: "PUT", path: `/api/files/uploads/${id}/chunks`,
      headers: {
        "x-memo-token": T.kim, "chunk-start": "0",
        "content-type": "application/octet-stream", "content-length": String(body.length),
      },
    });
    sock.on("error", () => resolve());
    sock.on("response", () => resolve());
    sock.write(body.subarray(0, 1000), () => sock.destroy());
  });

  const inv = await api("GET", `/api/files/uploads/${id}`);
  assert.deepEqual(inv.json.upload.received, [], "반쯤 온 청크가 받은 척 기록되면 finalize 가 해시에서야 터진다");

  // 같은 구간을 온전히 다시 보내면 복구된다.
  assert.equal((await putChunk(id, body, 0)).json.complete, true);
  assert.equal((await api("POST", `/api/files/uploads/${id}/finalize`)).status, 201);
});

test("청크 문턱: 관리자 금지·경계 검사·411·크기 상한", async () => {
  const body = randomBytes(1024);
  const { json: made } = await api("POST", "/api/files/uploads", {
    body: { name: "guard.bin", size: body.length, sha256: sha(body) },
  });
  const id = made.upload.id;

  assert.equal((await putChunk(id, body, 0, { "x-memo-token": T.adm })).status, 403);
  assert.equal((await putChunk(id, body, 0, { "x-memo-token": "nope" })).status, 401);
  assert.equal((await putChunk(id, body, 512)).json.code, "chunk_out_of_bounds", "끝을 넘는 청크");
  assert.equal((await putChunk(id, body, -1)).json.code, "invalid_chunk_start");
  assert.equal((await api("POST", `/api/files/uploads/${id}/chunks`, { body })).status, 405, "청크는 PUT 이다");

  // 남의 세션에는 청크를 꽂을 수 없다 — 서버 발급 id 에 소유자가 묶여 있고, 남의 것은
  // 존재조차 보이지 않는다(404). 이 검사가 없으면 교차 주입 차단은 이름뿐이다.
  const spoof = await putChunk(id, body, 0, { "x-memo-token": T.lee });
  assert.equal(spoof.status, 404);
  assert.equal(spoof.json.code, "upload_not_found");
  const owner = await putChunk(id, body, 0);
  assert.equal(owner.status, 200, "주인은 된다");
});

test("411 과 청크 상한 — 제목만 있던 두 문턱을 날소켓으로 건다", async () => {
  const { connect } = await import("node:net");
  const net = server.address();
  const body = randomBytes(1024);
  const { json: made } = await api("POST", "/api/files/uploads", {
    body: { name: "caps.bin", size: 200 * 1024 * 1024, sha256: sha(body) },
  });
  const id = made.upload.id;

  // Node 클라이언트는 transfer-encoding 헤더에 제 처리를 얹는다 — 날소켓으로 원문 그대로 보낸다.
  const rawProbe = (headerLines) => new Promise((resolve, reject) => {
    const sock = connect(net.port, "127.0.0.1", () => {
      sock.write(`PUT /api/files/uploads/${id}/chunks HTTP/1.1\r\nhost: t\r\nx-memo-token: ${T.kim}\r\nchunk-start: 0\r\n${headerLines}\r\n`);
    });
    let raw = "";
    sock.on("data", (c) => {
      raw += c;
      const m = raw.match(/^HTTP\/1\.1 (\d+)[\s\S]*?\r\n\r\n([\s\S]*)$/);
      if (m) { sock.destroy(); resolve({ status: Number(m[1]), body: m[2] }); }
    });
    sock.on("error", reject);
    setTimeout(() => { sock.destroy(); reject(new Error("probe timeout")); }, 3000).unref();
  });

  const te = await rawProbe("transfer-encoding: chunked\r\n");
  assert.equal(te.status, 411);
  assert.match(te.body, /length_required/);

  const over = await rawProbe(`content-length: ${100 * 1024 * 1024 + 1}\r\n`);
  assert.equal(over.status, 400, "몸통을 보내기 전에 선언만으로 거절돼야 한다");
  assert.match(over.body, /chunk_too_large/);
});

test("흐르는 청크가 있는 동안 finalize 는 기다리라고 답한다 — 해시 중 오염의 그 창", async () => {
  const body = randomBytes(64 * 1024);
  const { json: made } = await api("POST", "/api/files/uploads", {
    body: { name: "busy.bin", size: body.length, sha256: sha(body) },
  });
  const id = made.upload.id;
  const net = server.address();

  // 먼저 세션을 **완성**시킨다 — 커버리지 검사가 busy 검사보다 앞이라, 구멍이 있으면
  // upload_incomplete 가 먼저 답한다(그건 안전하다). 오염의 창은 "완성된 세션에 낡은
  // 재전송이 흐르는 동안 finalize" 다 — 재전송은 이 프로토콜의 1급 시민이다(잃은 ack).
  await putChunk(id, body, 0);

  // 이제 같은 구간의 재전송을 **열어만 두고**(헤더 + 앞부분만 보내고 멈춤) finalize 를 부른다.
  const slow = http.request({
    host: "127.0.0.1", port: net.port, method: "PUT", path: `/api/files/uploads/${id}/chunks`,
    headers: {
      "x-memo-token": T.kim, "chunk-start": "0",
      "content-type": "application/octet-stream", "content-length": String(body.length),
    },
  });
  const slowDone = new Promise((resolve) => { slow.on("response", resolve); slow.on("error", resolve); });
  slow.write(body.subarray(0, 1024));
  await new Promise((r) => setTimeout(r, 50)); // 서버가 스트림을 열 시간

  const busy = await api("POST", `/api/files/uploads/${id}/finalize`);
  assert.equal(busy.status, 409);
  assert.equal(busy.json.code, "upload_busy", "흐르는 쓰기를 무시하고 해시하면 발행본이 오염된다");

  slow.end(body.subarray(1024)); // 청크를 마저 보낸다
  await slowDone;
  const done = await api("POST", `/api/files/uploads/${id}/finalize`);
  assert.equal(done.status, 201, "청크가 끝나면 finalize 가 된다 — 세션은 busy 로 죽지 않았다");
});

test("sha 불일치 → 세션 유지 → 재전송 → 성공, 그리고 dedupe", async () => {
  const body = randomBytes(2048);
  const { json: made } = await api("POST", "/api/files/uploads", {
    body: { name: "fix.bin", size: body.length, sha256: sha(body) },
  });
  const id = made.upload.id;

  await putChunk(id, randomBytes(2048), 0); // 틀린 바이트로 채운다
  const bad = await api("POST", `/api/files/uploads/${id}/finalize`);
  assert.equal(bad.status, 409);
  assert.equal(bad.json.code, "sha256_mismatch");

  await putChunk(id, body, 0); // 바로잡는다
  assert.equal((await api("POST", `/api/files/uploads/${id}/finalize`)).status, 201);

  // 같은 바이트를 다른 사람이 또 — 전량 올린 뒤에 기존 완성본을 받는다.
  const { json: re } = await api("POST", "/api/files/uploads", {
    body: { name: "other-name.bin", size: body.length, sha256: sha(body) },
  });
  await putChunk(re.upload.id, body, 0);
  const dedup = await api("POST", `/api/files/uploads/${re.upload.id}/finalize`);
  assert.equal(dedup.json.deduplicated, true);
  assert.equal(dedup.json.artifact.name, "fix.bin", "정체는 첫 발행이다");
});

test("도움말·건강 — 열려 있고, 큰 본문은 JSON 경로에서 413 이다", async () => {
  const health = await api("GET", "/api/files/health", { token: null });
  assert.equal(health.status, 200);
  assert.ok(health.json.store.freeBytes > 0);

  const helpRes = await fetch(`${base}/api/files/help`);
  assert.match(await helpRes.text(), /chunk/i);

  // fetch 는 본문을 다 못 보낸 채 이른 응답을 받으면 넘어지므로, 날 http 클라이언트로 본다 —
  // 관심사는 "413 이 코드와 함께 클라이언트에 **닿는가**"다(소켓 리셋으로 삼켜지지 않고).
  const big = await new Promise((resolve, reject) => {
    const net = server.address();
    const reqBig = http.request({
      host: "127.0.0.1", port: net.port, method: "POST", path: "/api/files/uploads",
      headers: { "x-memo-token": T.kim, "content-type": "application/json" },
    }, (res) => {
      let raw = "";
      res.on("data", (c) => { raw += c; });
      res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(raw) }));
    });
    reqBig.on("error", reject);
    reqBig.end(JSON.stringify({ name: "x".repeat(70 * 1024), size: 1, sha256: "a".repeat(64) }));
  });
  assert.equal(big.status, 413, "세션 JSON 은 64KB 면 충분하다 — 파일 바이트는 청크 경로로");
  assert.equal(big.json.code, "body_too_large");
});

test("리퍼 배선 — 기동 즉시 1회, 주기 반복, 거절은 삼킨다", async () => {
  const { wireReaper } = await import("../src/mount.mjs");
  let calls = 0;
  let rejectOnce = true;
  const stub = {
    reapStale: () => {
      calls += 1;
      if (rejectOnce) { rejectOnce = false; return Promise.reject(new Error("db locked")); }
      return Promise.resolve(0);
    },
  };
  const timer = wireReaper(stub, 20);
  assert.equal(calls, 1, "기동 즉시 한 번 — 재시작으로 유령이 치워지는 근거다");
  await new Promise((r) => setTimeout(r, 55));
  clearInterval(timer);
  assert.ok(calls >= 2, "주기 반복이 배선돼 있어야 한다");
  // 첫 호출의 거절이 프로세스를 못 죽였다는 사실 자체가 '삼킨다'의 증명이다(unhandledRejection 이면 여기 못 온다).
});

test("서빙되는 업로드 스크립트에는 **받아 간 주소**가 박힌다 — 저장소 사본은 큰 소리로 멈춘다", async () => {
  const { readFile } = await import("node:fs/promises");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");

  // fetch 는 host 를 못 바꾼다(금지 헤더). 이 검사의 주제가 바로 Host 라 날 http 로 친다.
  const fetchAs = (host) => new Promise((resolve, reject) => {
    const net = server.address();
    const r = http.request({
      host: "127.0.0.1", port: net.port, method: "GET", path: "/api/files/upload.sh",
      headers: { host, "x-forwarded-prefix": "/files" },
    }, (res) => {
      let raw = ""; res.on("data", (c) => { raw += c; });
      res.on("end", () => resolve({ body: raw, type: res.headers["content-type"] || "" }));
    });
    r.on("error", reject);
    r.end();
  });

  // 사내망으로 받은 것과 터널로 받은 것이 서로 다른 주소를 들고 나가야 한다.
  const asLan = await fetchAs("192.168.0.220");
  const lan = asLan.body;
  assert.match(asLan.type, /shellscript/);
  assert.match(lan, /BARO_FILES_URL:-http:\/\/192\.168\.0\.220\/files\/api/);

  const tunnel = (await fetchAs("gobackdev.iptime.org:22030")).body;
  assert.match(tunnel, /BARO_FILES_URL:-http:\/\/gobackdev\.iptime\.org:22030\/files\/api/,
    "밖에서 받은 사본이 사내망 주소를 들고 나가면 그 사람에게만 깨진다 — 원인이 안 보이는 종류다");
  assert.equal(tunnel.includes("{{API}}"), false, "치환이 남으면 스크립트가 죽는다");

  // 저장소의 원본에는 주소가 없다 — 조용히 사내망으로 떨어지는 대신 멈추게 되어 있어야 한다.
  const here = dirname(fileURLToPath(import.meta.url));
  const raw = await readFile(join(here, "..", "..", "..", "scripts", "upload-artifact.sh"), "utf8");
  assert.ok(raw.includes("{{API}}"), "원본에 주소가 박혀 있으면 서버가 채워 줄 자리가 없다");
  assert.match(raw, /BARO_FILES_URL 을 정하고/, "안 채워진 사본은 이유를 말하고 멈춰야 한다");
});
