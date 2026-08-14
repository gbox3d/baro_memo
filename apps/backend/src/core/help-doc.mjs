// AI 에이전트용 사용 설명 — `GET /api/help` 로 서빙된다. baro_calrory 의 help 패턴을 그대로
// 가져온다: 산문은 help/<topic>.md, 휘발성 사실(개수·설정 여부)은 요청 시각에 계산해 붙인다.
//
// **영문 단일 언어다.** 이 표면의 독자는 기계다. 두 언어를 두면 같은 계약이 두 벌이 되어
// 한쪽만 갱신되는 순간 서로 다른 말을 한다. 사람이 읽는 한국어는 readme.md 가 정본이다.
//
// AGENT_ROUTES 는 JSON 인덱스의 유일한 출처이고, test/help-doc.test.mjs 가 (1) 여기 적힌
// 경로가 코드에 실재하는지 (2) 각 라우트가 자기 주제 문서에 실제로 적혀 있는지를 양방향으로
// 검사한다 — 손으로 쓴 API 문서는 반드시 낡기 때문이다.
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export const HELP_DIR = resolve(here, "..", "..", "help");
export const HELP_TOPICS = ["index", "memo", "tokens"];

// 외부 URL 접두사. 문서에는 `{{BASE}}` 로 적고 서빙 시각에 실제 값으로 치환한다 —
// 마운트 경로(/memo 프록시 유무)가 바뀌어도 문서가 거짓말하지 않게.
const BASE_TOKEN = "{{BASE}}";
// 문서에 **실행 가능한 명령**을 적으려면 경로 접두사만으로는 모자란다(`curl /memo/install.sh`
// 는 명령이 아니다). 요청의 Host 에서 절대 주소를 만들어 넣는다 — 이 서버는 자기가 밖에서
// 무슨 이름으로 불리는지 그 헤더로만 안다(사내망 IP·터널 주소·localhost 가 다 맞다).
const ORIGIN_TOKEN = "{{ORIGIN}}";

// 이 서버가 여는 **전량**이다. 인덱스에 없는 기능은 에이전트에게 없는 기능이다.
export const AGENT_ROUTES = Object.freeze([
  { method: "GET", path: "/api/help", topic: "index",
    summary: "This document. ?format=json for the full machine index · /api/help/<topic>" },
  { method: "GET", path: "/api/health", topic: "index",
    summary: "Liveness — ok, version, board and token counts, and boardUrl: the address to hand out (RELEASE_BASE_URL + this mount), or null if the deployment has not been told one" },
  { method: "GET", path: "/api/version", topic: "index",
    summary: "Backend's own version" },

  { method: "GET", path: "/api/memos", topic: "memo",
    summary: "Summary index of the board, newest first — {count, total, limit, offset, memos}. No body, just bodyPreview/bodyLength (and commentCount); ?full=1 for real bodies. q is full-text over title+body+comments (words are AND, 3 chars minimum, punctuation is literal) and adds snippet + matchedIn (memo|comment) to each hit. Other filters: status (comma list) · author (contains) · user (exact) · limit (≤200, default 50) · offset. Needs a token — reads are not open (any user token, or the admin token)",
    query: "?status=open,doing&q=&author=&user=&limit=50&offset=0&full=0" },
  { method: "POST", path: "/api/memos", topic: "memo",
    summary: "Post to the board. Needs a user token; `user` is stamped from it",
    body: "{body, title?, status?, author?}" },
  { method: "GET", path: "/api/memos/:memoId", topic: "memo",
    summary: "One post by id with its comments — {memo, comments}, or 404 memo_not_found" },
  { method: "PATCH", path: "/api/memos/:memoId", topic: "memo",
    summary: "Partial update — omitted fields keep their value; `updatedBy` is stamped from your token. Needs a user token",
    body: "{title?, body?, status?, author?}" },
  { method: "DELETE", path: "/api/memos/:memoId", topic: "memo",
    summary: "Remove a post, and its comments with it. Needs a user token" },

  { method: "GET", path: "/api/memos/:memoId/history", topic: "memo",
    summary: "Who changed this post and when — {count, total, memoId, history}. Facts only: at, actor, action, changed field names; never the overwritten or deleted text (that is admin-only, GET /api/admin/audit). Answers even after the post is deleted. Needs a token" },

  { method: "GET", path: "/api/memos/:memoId/comments", topic: "memo",
    summary: "The thread under one post, oldest first — {count, memoId, comments}. GET /api/memos/:memoId already carries them; this is for re-reading one thread. Needs a token, like every read" },
  { method: "POST", path: "/api/memos/:memoId/comments", topic: "memo",
    summary: "Reply to a post without overwriting it — `user` is stamped from your token. Comments are append-only: there is no edit. Needs a user token",
    body: "{body, author?}" },
  { method: "DELETE", path: "/api/memos/:memoId/comments/:commentId", topic: "memo",
    summary: "Remove one comment. The path must name the post it belongs to, else 404 comment_not_found. Needs a user token" },

  { method: "GET", path: "/api/admin/tokens", topic: "tokens",
    summary: "Every issued token with its user and revocation state. Admin token only" },
  { method: "POST", path: "/api/admin/tokens", topic: "tokens",
    summary: "Issue a write token for a user. Admin token only",
    body: "{user, note?}" },
  { method: "DELETE", path: "/api/admin/tokens/:tokenId", topic: "tokens",
    summary: "Revoke a token (soft — the row stays for the audit trail). Admin token only" },

  { method: "GET", path: "/api/admin/audit", topic: "tokens",
    summary: "Deletion and edit history, newest first — {count, total, limit, offset, entries}. Each entry carries actor, action (memo_update|memo_delete|comment_delete), the overwritten or deleted content in `before`, and `after` for edits. Admin token only: it holds the full text of deleted posts",
    query: "?memoId=&action=&actor=&limit=50&offset=0" },
]);

/** 이 서버가 지금 무엇인지 — 문서에 적을 수 없는(적으면 낡는) 사실만 계산한다. */
export function buildLiveState({ memoStore = null, tokenStore = null, adminConfigured = false, version = "0.0.0" } = {}) {
  return {
    backendVersion: version,
    board: memoStore ? memoStore.counts() : null,
    // 토큰 값은 싣지 않는다 — help 는 가장 넓게 읽히는 표면이다. 개수까지가 사실이다.
    tokens: tokenStore ? tokenStore.counts() : null,
    adminConfigured,
  };
}

/** `/api/help[/<topic>]` 한 요청. sendResult 가 그대로 받는 모양으로 돌려준다. */
export async function serveHelp({ topic = "index", format = "markdown", live = null, basePath = "", origin = "" } = {}) {
  if (!HELP_TOPICS.includes(topic)) {
    return {
      status: 404,
      contentType: "application/json",
      json: {
        error: `No such help topic: "${topic}"`,
        topics: HELP_TOPICS.map((t) => topicUrl(t, basePath)),
      },
    };
  }
  if (format === "json") {
    return { status: 200, contentType: "application/json", json: helpIndexJson({ basePath, live }) };
  }
  let markdown = (await readFile(topicFile(topic), "utf8"))
    .replaceAll(ORIGIN_TOKEN, origin)   // {{ORIGIN}}{{BASE}} 순서라 ORIGIN 을 먼저 치환한다
    .replaceAll(BASE_TOKEN, basePath);
  // 라이브 블록은 index 에만 붙인다 — 주제 문서는 순수한 산문으로 두고, 상태는 한 곳에서만 본다.
  if (topic === "index" && live) markdown += renderLiveBlock(live);
  return { status: 200, contentType: "text/markdown; charset=utf-8", body: markdown };
}

/** 기계용 인덱스. 산문은 중복하지 않는다 — 라우트·주제 링크·라이브 상태뿐. */
export function helpIndexJson({ basePath = "", live = null } = {}) {
  return {
    name: "baro_memo",
    backendVersion: live?.backendVersion ?? null,
    basePath: basePath || "/",
    prose: topicUrl("index", basePath),
    topics: HELP_TOPICS.map((t) => ({ topic: t, url: topicUrl(t, basePath) })),
    routes: AGENT_ROUTES.map((r) => ({
      method: r.method,
      path: `${basePath}${r.path}`,
      topic: r.topic,
      summary: r.summary,
      ...(r.query ? { query: r.query } : {}),
      ...(r.body ? { body: r.body } : {}),
    })),
    live,
  };
}

export function topicFile(topic) {
  return resolve(HELP_DIR, `${topic}.md`);
}

function topicUrl(topic, basePath) {
  return topic === "index" ? `${basePath}/api/help` : `${basePath}/api/help/${topic}`;
}

function renderLiveBlock(live) {
  const b = live.board;
  const t = live.tokens;
  return `

---

## This server, right now

Computed per request — never stale. Everything above is prose; everything here is state.

- **Board**: ${b ? `${b.total} posts (open ${b.open} · doing ${b.doing} · done ${b.done})` : "unavailable"}
- **Write tokens**: ${t ? `${t.active} active, ${t.revoked} revoked` : "unavailable"}${t && t.active === 0 ? " — **writes are impossible until the operator issues one** (503 no_tokens_issued)" : ""}
- **Admin**: ${live.adminConfigured ? "configured" : "NOT configured — token issuing answers 503 admin_token_unset"}

\`backendVersion\`: ${live.backendVersion}
`;
}
