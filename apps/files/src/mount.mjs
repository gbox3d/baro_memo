// 아티팩트 저장소를 보드 프로세스에 얹는 마운트.
//
// **한 저장소, 한 프로세스**(0.11.0). 그전에는 포트 둘이었고, 그 이유로 든 것은 "보드는 본문을
// 통째로 메모리에 올린 뒤 라우팅하므로 수 GB 스트리밍을 심을 수 없다"였다. 코드를 다시 읽으니
// 절반은 틀렸다 — 청크 경로는 **본문을 읽기 전에** 가로채므로 라우팅 구조와 무관하고, Node 의
// I/O 는 소켓을 잡을 뿐 이벤트 루프를 막지 않는다. 프로세스를 가른 대가로 남은 것은 정체성을
// HTTP 로 되묻는 홉과 그 캐시(=폐기 지연), 그리고 버전 두 벌이었다. 그래서 합쳤다.
//
// 진짜로 남았던 이유는 하나뿐이다: **보드를 재시작하면 전송 중 업로드가 끊긴다.** 재개가 그
// 대가를 "명령 한 번 다시"로 낮추므로 받아들인다.
//
// 경로는 프로세스 안에서 갈라 둔다. 보드도 저장소도 `/api/health` 를 갖고 있어, 같은 이름이
// 같은 프로세스에 있으면 어느 쪽 문으로 들어왔는지로만 구분해야 한다 — 그건 헤더에 기대는
// 라우팅이고 위조 한 번에 무너진다. 대신 마운트 접두사(`/api/files`)로 가른다: nginx 가
// `/files/api/` 를 여기로 보내고, 이 안에서 접두사를 벗겨 저장소 라우터에는 **예전 그대로**
// `/api/...` 를 넘긴다. 그래서 routes.mjs 와 그 검사는 한 줄도 바뀌지 않는다.
import { createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { openDb } from "./core/db.mjs";
import { json } from "./core/http.mjs";
import { FileStore, LIMITS } from "./files/store.mjs";
import { createFileRoutes, presentedToken } from "./files/routes.mjs";

const here = dirname(fileURLToPath(import.meta.url));

// 세션 생성 JSON 이 전부다 — 파일 바이트는 청크 경로만 받는다. 보드의 1 MiB 와 따로 두는 이유는
// 거절 메시지다: 여기서 큰 본문은 "너무 크다"가 아니라 "문을 잘못 골랐다"이다.
export const FILES_BODY_CAP = 64 * 1024;

export const FILES_PREFIX = "/api/files";

// 저장소가 없는 채로도 보드는 선다. 외장 볼륨이 안 붙은 아침에 게시판까지 죽는 것은 합치면서
// 새로 생길 뻔한 실패였다 — 마운트는 그때 503 만 답하고 보드는 평소대로 돈다.
function unavailable(reason) {
  return json(503, {
    error: `The artifact store is not mounted: ${reason}`,
    code: "store_unavailable", retryable: true,
  });
}

export async function createFilesMount({
  root, repoRoot, resolveToken, version, prefix = FILES_PREFIX, basePathOf = () => "",
}) {
  let store = null;
  let db = null;
  let failure = null;
  try {
    db = openDb(join(root, "files.db"));
    store = new FileStore(db, { root });
    await store.init();
  } catch (error) {
    failure = String(error?.message || error);
    console.error(`[baro_memo/files] store unavailable at ${root}: ${failure}`);
    try { db?.close(); } catch { /* 이미 닫혔거나 열린 적 없다 */ }
    db = null; store = null;
  }

  const identity = { resolve: async (token) => resolveToken(token) };
  const routes = store ? createFileRoutes({ store, identity, basePathOf }) : null;

  // 외부 경로 → 저장소 라우터가 아는 경로. `/api/files/uploads/x` → `/api/uploads/x`.
  function inner(pathname) {
    if (pathname === prefix) return "/api";
    if (!pathname.startsWith(`${prefix}/`)) return null;
    return `/api${pathname.slice(prefix.length)}`;
  }

  // ---- 청크 수신 — 이 프로세스의 스트리밍 경로는 이것 하나다 -------------------------------
  //
  // content-length 프레이밍에 기댄다: Node 는 선언된 길이만큼 정확히 주거나 에러를 낸다.
  // 끊긴 청크는 pipeline 이 던지고, 장부(recordRange)는 **끝까지 받은 뒤에만** 적는다 —
  // 찢어진 쓰기는 재전송이 같은 자리에 덮으므로 해가 없다.
  async function receive(req, res, id) {
    const respond = (result) => {
      res.writeHead(result.status, { "content-type": "application/json" });
      res.end(JSON.stringify(result.json));
    };
    if (!store) return respond(unavailable(failure));

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
    // 희소 파일이라 여유는 차오르며 소모된다 — 청크마다 바닥을 확인한다. 이 볼륨에는 보드 DB 도 산다.
    if (await store.freeBytes() < LIMITS.reserveBytes) {
      return respond(json(507, { error: "Store is out of reserved space.", code: "insufficient_storage" }));
    }

    // 상태 확인과 진행 계수는 store 안의 **한 동기 블록**이다(beginChunk) — 여기서 얻은 자리는
    // finalize 가 볼 수 있고, finalize 는 이 자리가 비기 전에는 해시를 시작하지 않는다.
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

  // 청크 경로인가 — **본문을 읽기 전에** 답해야 하므로 경로만 보고 판정한다.
  function streamingId(pathname) {
    const p = inner(pathname);
    if (!p) return null;
    const m = p.match(/^\/api\/uploads\/([A-Za-z0-9_-]+)\/chunks$/);
    return m ? m[1] : null;
  }

  async function handle(method, pathname, query, body, headers) {
    const p = inner(pathname);
    if (p === null) return null;

    if (method === "GET" && p === "/api/health") {
      if (!store) return unavailable(failure);
      return json(200, {
        ok: true, version,
        store: { ...store.counts(), freeBytes: await store.freeBytes() },
      });
    }
    if (method === "GET" && p === "/api/version") return json(200, { version });

    // 업로드 클라이언트. **서버가 주소를 박아서 준다** — 받아 간 주소가 곧 그 사람이 쓸 주소다.
    // 정적 파일로 서빙하면 기본 주소가 한 벌 박히고, 밖에 선 사람에게만 틀린다.
    if (method === "GET" && p === "/api/upload.sh") {
      const raw = await readFile(join(repoRoot, "scripts", "upload-artifact.sh"), "utf8");
      const origin = headers.host ? `http://${headers.host}` : "";
      return {
        status: 200,
        contentType: "text/x-shellscript; charset=utf-8",
        body: raw.replaceAll("{{API}}", `${origin}${basePathOf(headers)}/api`),
      };
    }

    if (method === "GET" && p === "/api/help") {
      const md = (await readFile(resolve(here, "..", "help", "index.md"), "utf8"))
        .replaceAll("{{ORIGIN}}", headers.host ? `http://${headers.host}` : "")
        .replaceAll("{{BASE}}", basePathOf(headers));
      return { status: 200, contentType: "text/markdown; charset=utf-8", body: md };
    }

    if (!routes) return unavailable(failure);
    const res = await routes(method, p, query, body, headers);
    if (res) return res;
    return json(404, { error: "No such route.", method, pathname, help: `${basePathOf(headers)}/api/help` });
  }

  return {
    prefix, bodyCap: FILES_BODY_CAP, store, ok: !!store, failure,
    owns: (pathname) => inner(pathname) !== null,
    streamingId, receive, handle,
    close: () => { try { db?.close(); } catch { /* 이미 닫혔다 */ } },
  };
}

// 유령 세션 정리 — 기동 때 한 번, 이후 한 시간마다. 완성본은 건드리지 않는다.
// 함수로 뽑아 둔 이유는 검사다: 배선(즉시 1회 + 주기 + 거절 삼킴)이 검사 없는 코드로 남으면
// reapStale 이 어느 날 던지기 시작해도 아무도 모른다.
export function wireReaper(target, intervalMs = 3600 * 1000) {
  if (!target) return null;
  const reap = () => Promise.resolve(target.reapStale())
    .catch((e) => console.error("[baro_memo/files] reap failed:", e.message));
  reap();
  const timer = setInterval(reap, intervalMs);
  timer.unref();
  return timer;
}
