// baro_memo 백엔드 엔트리포인트 — 게시판과 아티팩트 저장소를 **한 프로세스**로 든다(0.11.0).
//
// 설정은 .env 하나다(레포 루트). config.json 을 두지 않는 이유: 이 서버의 설정은 포트·관리자
// 토큰·DB 경로 정도이고, 사용자 토큰 같은 살아 있는 데이터는 전부 SQLite 에 있다 — 파일 두
// 벌이면 "어느 쪽이 정본인가"가 생긴다.
//
// 라우터 규약: (method, pathname, query, body, headers) → {status, ...} | null.
// null 이면 다음 라우터로 넘어가고, 끝까지 null 이면 종단 404 다. `query` 는 URLSearchParams —
// 예전에는 파싱해 놓고 help 에만 주었는데, 그래서 `/api/memos?status=open` 이 조용히 전체를
// 돌려주고 있었다. 아래 handle() 과 같은 순서로 맞춰 둔다.
//
// **이 규약의 예외는 하나뿐이다**: 청크 업로드(`/api/files/uploads/:id/chunks`)는 본문을
// 라우팅 전에 가로채 디스크로 스트림한다. 그 가로채기가 아래 createServer 의 첫 줄이다 —
// 라우터에 닿기 전이므로 규약은 깨지지 않고, 2.8 GB 가 메모리에 오르지도 않는다.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readAdminToken } from "./core/admin-token.mjs";
import { openDb } from "./core/db.mjs";
import { MemoStore } from "./memo/memo-store.mjs";
import { CommentStore } from "./memo/comment-store.mjs";
import { VoteStore } from "./memo/vote-store.mjs";
import { AuditStore } from "./memo/audit-store.mjs";
import { TokenStore } from "./auth/token-store.mjs";
import { TeamStore } from "./auth/team-store.mjs";
import { createVerdict } from "./auth/verdict.mjs";
import { createMemoRoutes } from "./memo/routes.mjs";
import { createAdminRoutes } from "./admin/routes.mjs";
import { createAuthRoutes } from "./auth/routes.mjs";
import { buildLiveState, serveHelp } from "./core/help-doc.mjs";
import { json } from "./core/http.mjs";
import { createFilesMount, wireReaper } from "../../files/src/mount.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");

// .env 는 없어도 된다(전부 기본값이 있다) — 있으면 process.env 에 얹는다.
try { process.loadEnvFile(join(repoRoot, ".env")); } catch { /* .env 없음 — 기본값으로 간다 */ }

const PORT = Number(process.env.PORT) || 9100;
const HOST = process.env.HOST || "0.0.0.0";
const { token: ADMIN_TOKEN, source: ADMIN_SOURCE } = readAdminToken();
// 팀원에게 건네는 주소. 이 서버가 **자기를 뭐라고 부르라고 알려 줄** 값이라, Host 헤더가
// 아니라 설정에서 온다 — 운영자가 사내망 IP 로 관리자 페이지를 열어도 초대 메시지에는 밖에서
// 닿는 주소가 실려야 한다. 비어 있으면 소비자가 자기가 연 주소로 떨어진다(null 을 준다).
const RELEASE_BASE_URL = String(process.env.RELEASE_BASE_URL || "").trim().replace(/\/+$/, "");
const DB_PATH = process.env.MEMO_DB
  ? (isAbsolute(process.env.MEMO_DB) ? process.env.MEMO_DB : join(repoRoot, process.env.MEMO_DB))
  : join(repoRoot, "localfiles", "memo.db");
// 아티팩트 바이트가 사는 곳. **파일은 그냥 파일이다** — DB 에는 장부만 있고 여기에
// store/<sha256> 과 tmp/<세션id> 가 평범한 파일로 앉는다. deploy/nginx-baro-files.conf 의
// alias 뿌리와 같아야 한다(한쪽만 바꾸면 다운로드가 404 다).
const FILES_ROOT = process.env.FILES_ROOT
  ? (isAbsolute(process.env.FILES_ROOT) ? process.env.FILES_ROOT : join(repoRoot, process.env.FILES_ROOT))
  : join(repoRoot, "localfiles", "files");

const pkg = JSON.parse(await readFile(join(here, "..", "package.json"), "utf8"));

const db = openDb(DB_PATH);
const memoStore = new MemoStore(db);
const commentStore = new CommentStore(db);
const voteStore = new VoteStore(db);
const auditStore = new AuditStore(db);
const tokenStore = new TokenStore(db);
const teamStore = new TeamStore(db);
// 정체성 판정의 정본. 게시판의 whoami 도, 아티팩트 저장소도 이 함수 하나를 부른다 — 판정이
// 두 벌이면 폐기가 한쪽에만 닿는 날이 온다.
const verdict = createVerdict({ tokenStore, adminToken: ADMIN_TOKEN });

// 외부 URL 접두사. nginx 스니펫이 X-Forwarded-Prefix 를 붙인다(/memo 또는 /files) — 직접
// 포트로 온 요청은 접두사가 없어 "" 가 된다. 헤더는 문서 링크에만 쓰이므로 위조돼도 잃을 것이 없다.
function basePathOf(headers) {
  const raw = String(headers["x-forwarded-prefix"] || process.env.BASE_PATH || "").trim();
  if (!raw.startsWith("/")) return "";
  return raw.replace(/\/+$/, "");
}

// 저장소 마운트. 여는 데 실패해도(외장 볼륨 미장착 등) **보드는 선다** — 마운트만 503 을 답한다.
// 프로세스를 합치면서 새로 생길 뻔한 실패 결합이 정확히 이것이었다.
const files = await createFilesMount({
  root: FILES_ROOT, repoRoot, version: pkg.version, basePathOf,
  resolveToken: (token) => verdict(token),
});
wireReaper(files.store);

const routers = [
  createMemoRoutes({ memoStore, tokenStore, commentStore, teamStore, voteStore, auditStore, adminToken: ADMIN_TOKEN }),
  createAdminRoutes({ tokenStore, teamStore, auditStore, adminToken: ADMIN_TOKEN }),
  createAuthRoutes({ verdict, teamStore }),
];

async function handle(method, pathname, query, body, headers) {
  // 저장소 마운트가 먼저다 — 접두사가 갈라져 있어 보드 라우터와 겹치지 않는다.
  if (files.owns(pathname)) return files.handle(method, pathname, query, body, headers);

  // help 표면. 주제 문서는 산문 그대로, index 에만 라이브 블록이 붙는다.
  const help = pathname.match(/^\/api\/help(?:\/([a-z0-9-]+))?$/);
  if (help && method === "GET") {
    return serveHelp({
      topic: help[1] || "index",
      format: query.get("format") || "markdown",
      live: buildLiveState({ memoStore, tokenStore, adminConfigured: !!ADMIN_TOKEN, version: pkg.version }),
      basePath: basePathOf(headers),
      // 이 서버가 밖에서 무슨 이름으로 불리는지는 Host 헤더로만 안다. 문서의 명령줄에 쓰는
      // 용도이고, 위조돼도 그 헤더를 보낸 쪽이 이미 그 페이지를 받아 간 쪽이다.
      origin: headers.host ? `http://${headers.host}` : "",
    });
  }

  if (method === "GET" && pathname === "/api/health") {
    return json(200, {
      ok: true, version: pkg.version,
      // 접두사는 요청이 알려 준다(nginx 의 X-Forwarded-Prefix). 원점은 설정이 정한다 —
      // 둘을 합쳐야 "밖에서 이 보드를 부르는 이름" 이 된다.
      boardUrl: RELEASE_BASE_URL ? `${RELEASE_BASE_URL}${basePathOf(headers)}` : null,
      board: memoStore.counts(), tokens: tokenStore.counts(),
      // 같은 프로세스가 저장소도 든다. 보드만 보고 "다 살아 있다"고 읽지 않게, 마운트의 생사를
      // 여기서도 말한다 — 죽어 있으면 이 값이 유일한 단서다.
      files: files.ok ? "mounted" : `unavailable: ${files.failure}`,
    });
  }
  if (method === "GET" && pathname === "/api/version") {
    return json(200, { version: pkg.version });
  }

  for (const route of routers) {
    const res = await route(method, pathname, query, body, headers);
    if (res) return res;
  }
  return json(404, { error: "No such route.", method, pathname, help: "/api/help" });
}

// 본문 상한 1 MiB — 저장소의 필드 상한(20k)보다 훨씬 크지만, JSON.parse 전에 메모리를 지키는
// 것은 이 층의 일이다. 저장소 마운트는 더 좁다(64 KiB): 거기서 큰 본문은 "너무 크다"가 아니라
// "문을 잘못 골랐다"이고, 파일 바이트는 청크 경로로만 들어온다.
const BODY_CAP = 1024 * 1024;

// 상한을 넘으면 **소켓을 바로 죽이지 않는다** — 죽이면 413 이 클라이언트에 닿기 전에 연결이
// 리셋되어, 부르는 쪽은 "왜"를 영영 모른다(저장소 쪽에서 배운 것을 보드에도 들인다).
// 읽기만 멈추고 거절을 돌려준 뒤, 응답이 나간 다음에 연결을 닫는다.
function readBody(req, cap) {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > cap) {
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

export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  // 스트리밍 예외 — 본문을 읽기 전에 가로챈다. 이 가로채기가 있어서 저장소가 이 프로세스에
  // 들어올 수 있었다: 라우터는 본문이 필요하고, 이 경로는 본문이 라우터에 닿으면 안 된다.
  const chunkId = files.streamingId(url.pathname);
  if (chunkId) {
    if (req.method !== "PUT") {
      res.writeHead(405, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "Chunks are PUT.", method: req.method }));
    }
    try { await files.receive(req, res, chunkId); } catch (error) {
      if (!res.writableEnded) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(error?.message || error), code: "internal" }));
      }
    }
    return undefined;
  }

  const mounted = files.owns(url.pathname);
  const cap = mounted ? files.bodyCap : BODY_CAP;
  let result;
  let overflow = false;
  try {
    let body = {};
    if (req.method !== "GET" && req.method !== "HEAD") {
      const raw = await readBody(req, cap);
      if (raw.trim()) {
        try { body = JSON.parse(raw); }
        catch { result = json(400, { error: "Body is not valid JSON.", code: "invalid_json" }); }
      }
    }
    if (!result) result = await handle(req.method, url.pathname, url.searchParams, body, req.headers);
  } catch (error) {
    overflow = error?.code === "body_too_large";
    result = overflow
      ? json(413, mounted
        ? { error: "Body exceeds 64 KiB — file bytes go through the chunk route.", code: "body_too_large" }
        : { error: "Body exceeds 1 MiB.", code: "body_too_large" })
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

// 검사는 자기가 포트를 고른다(0번). 여기서 듣기 시작하면 검사 실행이 운영 포트를 물게 된다.
if (process.env.NODE_ENV !== "test") {
  server.listen(PORT, HOST, () => {
    // 관리자 토큰의 **출처**를 찍는다(값이 아니라 경로다). "고친 파일과 서버가 읽은 파일이
    // 다르다"가 이 종류 설정에서 가장 흔한 사고다.
    console.log(`[baro_memo] v${pkg.version} listening on ${HOST}:${PORT} · db=${DB_PATH} · admin=${ADMIN_TOKEN ? "configured" : "UNSET"} (${ADMIN_SOURCE})`);
    console.log(`[baro_memo/files] ${files.ok ? `mounted at ${files.prefix} · root=${FILES_ROOT}` : `UNAVAILABLE — ${files.failure}`}`);
  });

  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      server.close(() => { files.close(); db.close(); process.exit(0); });
    });
  }
}
