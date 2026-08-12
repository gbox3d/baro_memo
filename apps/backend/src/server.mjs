// baro_memo 백엔드 엔트리포인트.
//
// 설정은 .env 하나다(레포 루트). config.json 을 두지 않는 이유: 이 서버의 설정은 포트·관리자
// 토큰·DB 경로 셋뿐이고, 사용자 토큰 같은 살아 있는 데이터는 전부 SQLite 에 있다 — 파일 두
// 벌이면 "어느 쪽이 정본인가"가 생긴다.
//
// 라우터 규약은 baro_calrory 와 같다: (method, pathname, body, headers) → {status, ...} | null.
// null 이면 다음 라우터로 넘어가고, 끝까지 null 이면 종단 404 다.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { openDb } from "./core/db.mjs";
import { MemoStore } from "./memo/memo-store.mjs";
import { TokenStore } from "./auth/token-store.mjs";
import { createMemoRoutes } from "./memo/routes.mjs";
import { createAdminRoutes } from "./admin/routes.mjs";
import { buildLiveState, serveHelp } from "./core/help-doc.mjs";
import { json } from "./core/http.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");

// .env 는 없어도 된다(전부 기본값이 있다) — 있으면 process.env 에 얹는다.
try { process.loadEnvFile(join(repoRoot, ".env")); } catch { /* .env 없음 — 기본값으로 간다 */ }

const PORT = Number(process.env.PORT) || 9100;
const HOST = process.env.HOST || "0.0.0.0";
const ADMIN_TOKEN = (process.env.ADMIN_TOKEN || "").trim();
const DB_PATH = process.env.MEMO_DB
  ? (isAbsolute(process.env.MEMO_DB) ? process.env.MEMO_DB : join(repoRoot, process.env.MEMO_DB))
  : join(repoRoot, "localfiles", "memo.db");

const pkg = JSON.parse(await readFile(join(here, "..", "package.json"), "utf8"));

const db = openDb(DB_PATH);
const memoStore = new MemoStore(db);
const tokenStore = new TokenStore(db);

const routers = [
  createMemoRoutes({ memoStore, tokenStore }),
  createAdminRoutes({ tokenStore, adminToken: ADMIN_TOKEN }),
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
    });
  }

  if (method === "GET" && pathname === "/api/health") {
    return json(200, { ok: true, version: pkg.version, board: memoStore.counts(), tokens: tokenStore.counts() });
  }
  if (method === "GET" && pathname === "/api/version") {
    return json(200, { version: pkg.version });
  }

  for (const route of routers) {
    const res = await route(method, pathname, body, headers);
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
  console.log(`[baro_memo] v${pkg.version} listening on ${HOST}:${PORT} · db=${DB_PATH} · admin=${ADMIN_TOKEN ? "configured" : "UNSET"}`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    server.close(() => { db.close(); process.exit(0); });
  });
}
