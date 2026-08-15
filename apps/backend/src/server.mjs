// baro_memo 백엔드 엔트리포인트.
//
// 설정은 .env 하나다(레포 루트). config.json 을 두지 않는 이유: 이 서버의 설정은 포트·관리자
// 토큰·DB 경로 셋뿐이고, 사용자 토큰 같은 살아 있는 데이터는 전부 SQLite 에 있다 — 파일 두
// 벌이면 "어느 쪽이 정본인가"가 생긴다.
//
// 라우터 규약: (method, pathname, query, body, headers) → {status, ...} | null.
// null 이면 다음 라우터로 넘어가고, 끝까지 null 이면 종단 404 다. `query` 는 URLSearchParams —
// 예전에는 파싱해 놓고 help 에만 주었는데, 그래서 `/api/memos?status=open` 이 조용히 전체를
// 돌려주고 있었다. 아래 handle() 과 같은 순서로 맞춰 둔다.
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
import { createMemoRoutes } from "./memo/routes.mjs";
import { createAdminRoutes } from "./admin/routes.mjs";
import { createAuthRoutes } from "./auth/routes.mjs";
import { buildLiveState, serveHelp } from "./core/help-doc.mjs";
import { json } from "./core/http.mjs";

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

const pkg = JSON.parse(await readFile(join(here, "..", "package.json"), "utf8"));

const db = openDb(DB_PATH);
const memoStore = new MemoStore(db);
const commentStore = new CommentStore(db);
const voteStore = new VoteStore(db);
const auditStore = new AuditStore(db);
const tokenStore = new TokenStore(db);

const routers = [
  createMemoRoutes({ memoStore, tokenStore, commentStore, voteStore, auditStore, adminToken: ADMIN_TOKEN }),
  createAdminRoutes({ tokenStore, auditStore, adminToken: ADMIN_TOKEN }),
  createAuthRoutes({ tokenStore, adminToken: ADMIN_TOKEN }),
];

// 외부 URL 접두사. nginx 스니펫이 X-Forwarded-Prefix: /memo 를 붙인다 — 직접 포트로 온
// 요청은 접두사가 없어 "" 가 된다. 헤더는 문서 링크에만 쓰이므로 위조돼도 잃을 것이 없다.
function basePathOf(headers) {
  const raw = String(headers["x-forwarded-prefix"] || process.env.BASE_PATH || "").trim();
  if (!raw.startsWith("/")) return "";
  return raw.replace(/\/+$/, "");
}

async function handle(method, pathname, query, body, headers) {
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
// 것은 이 층의 일이다.
const BODY_CAP = 1024 * 1024;

function readBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > BODY_CAP) { rejectBody(Object.assign(new Error("body too large"), { code: "body_too_large" })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", rejectBody);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  let result;
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
    result = error?.code === "body_too_large"
      ? json(413, { error: "Body exceeds 1 MiB.", code: "body_too_large" })
      : json(500, { error: String(error?.message || error), code: "internal" });
  }
  const payload = result.json !== undefined ? JSON.stringify(result.json) : result.body;
  res.writeHead(result.status, { "content-type": result.contentType || "application/json" });
  res.end(payload);
});

server.listen(PORT, HOST, () => {
  // 관리자 토큰의 **출처**를 찍는다(값이 아니라 경로다). "고친 파일과 서버가 읽은 파일이
  // 다르다"가 이 종류 설정에서 가장 흔한 사고다.
  console.log(`[baro_memo] v${pkg.version} listening on ${HOST}:${PORT} · db=${DB_PATH} · admin=${ADMIN_TOKEN ? "configured" : "UNSET"} (${ADMIN_SOURCE})`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    server.close(() => { db.close(); process.exit(0); });
  });
}
