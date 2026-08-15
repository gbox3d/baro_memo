// baro_files 백엔드 엔트리포인트 — 릴리스 아티팩트 저장소.
//
// baro_memo 와 같은 뼈대(라우터 체인, .env 하나, 종단 404)에 **예외가 하나** 있다: 청크 업로드
// (PUT /api/uploads/:id/chunks)는 본문을 라우팅 전에 가로채 디스크로 **스트림**한다. 보드처럼
// 본문을 통째로 메모리에 올리는 구조로는 2.8GB 를 받을 수 없고, 이 예외를 보드 프로세스에
// 심지 않으려고 이 서비스가 따로 있다.
//
// 다운로드 경로는 여기 없다 — nginx 가 store/ 를 alias 로 직접 서빙한다(Range·재개·sendfile 이
// 공짜). 이 프로세스는 다운로드 바이트를 만지지 않는다.
import http from "node:http";
import { createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { openDb } from "./core/db.mjs";
import { createIdentity } from "./core/identity.mjs";
import { json } from "./core/http.mjs";
import { FileStore, LIMITS } from "./files/store.mjs";
import { createFileRoutes, presentedToken } from "./files/routes.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");

try { process.loadEnvFile(join(repoRoot, ".env")); } catch { /* .env 없음 — 기본값으로 간다 */ }

// 이 저장소의 .env 는 보드와 공유한다 — 이름이 겹치면 한쪽이 남의 값을 읽는다.
const PORT = Number(process.env.FILES_PORT) || 3002;
const HOST = process.env.FILES_HOST || "127.0.0.1";
// 바이트가 사는 곳. 보드 DB 와 같은 외장 볼륨이다 — 저장소를 지워도 릴리스는 남아야 한다.
const FILES_ROOT = process.env.FILES_ROOT
  ? (isAbsolute(process.env.FILES_ROOT) ? process.env.FILES_ROOT : join(repoRoot, process.env.FILES_ROOT))
  : join(repoRoot, "localfiles", "files");
// 정체성의 정본. 토큰 발급은 보드 한 곳이고 여기는 물어볼 뿐이다.
const MEMO_API = (process.env.MEMO_API || "http://127.0.0.1:3001/api").replace(/\/+$/, "");

const pkg = JSON.parse(await readFile(join(here, "..", "package.json"), "utf8"));

const db = openDb(join(FILES_ROOT, "files.db"));
const store = new FileStore(db, { root: FILES_ROOT });
await store.init();
const identity = createIdentity({ memoApi: MEMO_API });

// 외부 URL 접두사 — nginx 가 X-Forwarded-Prefix: /files 를 붙인다(보드와 같은 규약).
function basePathOf(headers) {
  const raw = String(headers["x-forwarded-prefix"] || process.env.BASE_PATH || "").trim();
  if (!raw.startsWith("/")) return "";
  return raw.replace(/\/+$/, "");
}

const routes = createFileRoutes({ store, identity, basePathOf });

// ---- 청크 수신 — 이 서버에 스트리밍 경로는 이것 하나다 -----------------------------------
//
// content-length 프레이밍에 기댄다: Node 는 선언된 길이만큼 정확히 주거나 에러를 낸다.
// 끊긴 청크는 pipeline 이 던지고, 장부(recordRange)는 **끝까지 받은 뒤에만** 적는다 —
// 찢어진 쓰기는 재전송이 같은 자리에 덮으므로 해가 없다.
async function receiveChunk(req, res, id) {
  const respond = (result) => {
    res.writeHead(result.status, { "content-type": "application/json" });
    res.end(JSON.stringify(result.json));
  };

  const verdict = await identity.resolve(presentedToken(req.headers));
  if (!verdict.ok) return respond(json(verdict.status, { error: "Refused.", code: verdict.code }));
  if (verdict.user === null) {
    return respond(json(403, { error: "The admin token cannot publish.", code: "admin_token_cannot_publish" }));
  }

  const peek = store.getUpload(id);
  if (!peek || peek.user !== verdict.user) {
    return respond(json(404, { error: "No such upload.", code: "upload_not_found", id }));
  }

  const start = Number(req.headers["chunk-start"]);
  const declared = Number(req.headers["content-length"]);
  if (req.headers["transfer-encoding"]) {
    // 길이 선언이 없는 본문은 "어디까지가 이 청크인가"를 서버가 알 수 없다.
    return respond(json(411, { error: "Chunked transfer-encoding is not accepted — send content-length.", code: "length_required" }));
  }
  if (!Number.isSafeInteger(start) || start < 0) {
    return respond(json(400, { error: "chunk-start header must be a non-negative integer.", code: "invalid_chunk_start" }));
  }
  if (!Number.isSafeInteger(declared) || declared <= 0 || declared > LIMITS.maxChunkBytes) {
    return respond(json(400, { error: `content-length must be 1..${LIMITS.maxChunkBytes} bytes per chunk.`, code: "chunk_too_large" }));
  }
  if (start + declared > peek.size) {
    return respond(json(400, { error: "Chunk exceeds the declared file size.", code: "chunk_out_of_bounds" }));
  }
  // 희소 파일이라 여유는 차오르며 소모된다 — 청크마다 바닥을 확인한다. 이 볼륨에는 보드도 산다.
  if (await store.freeBytes() < LIMITS.reserveBytes) {
    return respond(json(507, { error: "Store is out of reserved space.", code: "insufficient_storage" }));
  }

  // 상태 확인과 진행 계수는 store 안의 **한 동기 블록**이다(beginChunk) — 여기서 얻은 자리는
  // finalize 가 볼 수 있고, finalize 는 이 자리가 비기 전에는 해시를 시작하지 않는다.
  // 이 줄과 위의 peek 사이에 finalize 가 끼어들 수 있으므로, 문턱의 진짜 판정은 이쪽이다.
  const upload = store.beginChunk(id);
  if (!upload) {
    return respond(json(409, { error: "Upload is finalizing — no more chunks.", code: "finalize_in_progress" }));
  }

  try {
    const ws = createWriteStream(store.tmpPath(id), { flags: "r+", start });
    await pipeline(req, ws);
    store.recordRange(id, start, start + declared);
  } catch (error) {
    // 끊겼거나(본문이 일찍 끝남), 스트림 도중 세션이 사라졌다(소유자의 abandon). 어느 쪽이든
    // 장부에는 안 적혔으므로 같은 구간 재전송이 곧 복구다.
    if (!res.writableEnded) {
      const gone = !store.getUpload(id);
      try {
        respond(gone
          ? json(404, { error: "Upload disappeared while the chunk was streaming.", code: "upload_not_found", id })
          : json(400, { error: "Chunk body ended early — re-send this range.", code: "chunk_truncated" }));
      } catch { /* 소켓 사망 */ }
    }
    return undefined;
  } finally {
    store.endChunk(id);
  }

  const inv = store.inventory(id);
  return respond(json(200, { received: inv.received, missing: inv.missing, complete: inv.complete }));
}

// ---- 나머지는 보드와 같은 작은 JSON 세계다 ------------------------------------------------

const BODY_CAP = 64 * 1024; // 세션 생성 JSON 이 전부다 — 큰 본문은 청크 경로만 받는다

// 상한을 넘으면 **소켓을 바로 죽이지 않는다** — 죽이면 413 이 클라이언트에 닿기 전에
// 연결이 리셋되어, 부르는 쪽은 "왜"를 영영 모른다(보드의 그 자리에서 배운 것).
// 읽기만 멈추고 거절을 돌려준 뒤, 응답이 나간 다음에 server 쪽이 연결을 닫는다.
function readBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > BODY_CAP) {
        req.pause();
        rejectBody(Object.assign(new Error("body too large"), { code: "body_too_large" }));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", rejectBody);
  });
}

async function handle(method, pathname, query, body, headers) {
  if (method === "GET" && pathname === "/api/health") {
    return json(200, {
      ok: true, version: pkg.version,
      store: { ...store.counts(), freeBytes: await store.freeBytes() },
      identityCache: identity.cacheSize(),
    });
  }
  if (method === "GET" && pathname === "/api/version") return json(200, { version: pkg.version });

  // 업로드 클라이언트. **서버가 주소를 박아서 준다** — 받아 간 주소가 곧 그 사람이 쓸 주소다.
  // 정적 파일로 서빙하면 스크립트 안의 기본 주소가 한 벌 박히고, 밖에 선 사람에게만 틀린다.
  if (method === "GET" && pathname === "/api/upload.sh") {
    const raw = await readFile(join(repoRoot, "scripts", "upload-artifact.sh"), "utf8");
    const origin = headers.host ? `http://${headers.host}` : "";
    return {
      status: 200,
      contentType: "text/x-shellscript; charset=utf-8",
      body: raw.replaceAll("{{API}}", `${origin}${basePathOf(headers)}/api`),
    };
  }

  if (method === "GET" && pathname === "/api/help") {
    const md = (await readFile(join(here, "..", "help", "index.md"), "utf8"))
      .replaceAll("{{ORIGIN}}", headers.host ? `http://${headers.host}` : "")
      .replaceAll("{{BASE}}", basePathOf(headers));
    return { status: 200, contentType: "text/markdown; charset=utf-8", body: md };
  }

  const res = await routes(method, pathname, query, body, headers);
  if (res) return res;
  return json(404, { error: "No such route.", method, pathname, help: "/api/help" });
}

export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  // 스트리밍 예외 — 본문을 읽기 전에 가로챈다. 이 한 줄이 이 서비스의 존재 이유다.
  const chunk = url.pathname.match(/^\/api\/uploads\/([A-Za-z0-9_-]+)\/chunks$/);
  if (chunk) {
    if (req.method !== "PUT") {
      res.writeHead(405, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "Chunks are PUT.", method: req.method }));
    }
    try { await receiveChunk(req, res, chunk[1]); } catch (error) {
      if (!res.writableEnded) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(error?.message || error), code: "internal" }));
      }
    }
    return undefined;
  }

  let result;
  let overflow = false;
  try {
    let body = {};
    if (req.method !== "GET" && req.method !== "HEAD") {
      const raw = await readBody(req);
      if (raw.trim()) {
        try { body = JSON.parse(raw); }
        catch { result = json(400, { error: "Body is not valid JSON.", code: "invalid_json" }); }
      }
    }
    if (!result) result = await handle(req.method, url.pathname, url.searchParams, body, req.headers);
  } catch (error) {
    overflow = error?.code === "body_too_large";
    result = overflow
      ? json(413, { error: "Body exceeds 64 KiB — file bytes go through the chunk route.", code: "body_too_large" })
      : json(500, { error: String(error?.message || error), code: "internal" });
  }
  const payload = result.json !== undefined ? JSON.stringify(result.json) : result.body;
  res.writeHead(result.status, {
    "content-type": result.contentType || "application/json",
    // 본문을 다 읽지 않고 답하는 유일한 경우 — 이 연결로 다음 요청을 받을 수 없다.
    ...(overflow ? { connection: "close" } : {}),
  });
  res.end(payload, () => { if (overflow) res.destroy(); });
});

// 유령 세션 정리 — 기동 때 한 번, 이후 한 시간마다. 완성본은 건드리지 않는다.
// 함수로 뽑아 둔 이유는 검사다: 배선(즉시 1회 + 주기 + 거절 삼킴)이 검사 없는 코드로 남으면
// reapStale 이 어느 날 던지기 시작해도 아무도 모른다.
export function wireReaper(target, intervalMs = 3600 * 1000) {
  const reap = () => Promise.resolve(target.reapStale())
    .catch((e) => console.error("[baro_files] reap failed:", e.message));
  reap();
  const timer = setInterval(reap, intervalMs);
  timer.unref();
  return timer;
}
wireReaper(store);

if (process.env.NODE_ENV !== "test") {
  server.listen(PORT, HOST, () => {
    console.log(`[baro_files] v${pkg.version} listening on ${HOST}:${PORT} · root=${FILES_ROOT} · identity=${MEMO_API}`);
  });
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      server.close(() => { db.close(); process.exit(0); });
    });
  }
}
