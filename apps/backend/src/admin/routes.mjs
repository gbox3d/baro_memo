// 관리 축 라우트: /api/admin/tokens*
//
// 이 축의 소비자는 에이전트가 아니라 **운영자**(관리자 페이지)다. 사용자 토큰이 아니라
// 관리자 토큰 하나로 지킨다 — 사용자 토큰으로 토큰을 발급할 수 있으면 토큰을 가진
// 누구나 신분을 늘릴 수 있어 추적이 무너진다. 그 토큰의 출처는 core/admin-token.mjs 가 정한다.
//
// 거절 구분은 memo 축과 같은 철학이다:
//   503 admin_token_unset   — 관리자 토큰이 없다. 운영자가 채우고 재시작해야 한다.
//   401 admin_token_invalid — 설정돼 있는데 네 것이 아니다.
//
// 반환 규약: 이 축의 경로가 아니면 null.
import { json } from "../core/http.mjs";
import { isAdminToken } from "../core/admin-token.mjs";
import { toTokenId } from "../auth/token-store.mjs";
import { presentedToken } from "../memo/routes.mjs";

function badRequest(error) {
  return json(400, { error: error.message, code: error.code || "invalid_token_request", retryable: false });
}

export function createAdminRoutes(ctx) {
  const { tokenStore, adminToken = "" } = ctx;

  // query 는 이 축에서 쓰지 않는다 — 서명은 라우터 규약(server.mjs)이라 자리를 지킨다.
  return async function handleAdmin(method, pathname, query = null, body = {}, headers = {}) {
    if (pathname !== "/api/admin/tokens" && !pathname.startsWith("/api/admin/tokens/")) return null;

    const expected = String(adminToken || "").trim();
    if (!expected) {
      return json(503, {
        error: "No admin token on this deployment — set ADMIN_TOKEN_FILE (or ADMIN_TOKEN) in .env and restart.",
        code: "admin_token_unset", retryable: false,
      });
    }
    if (!isAdminToken(expected, presentedToken(headers))) {
      return json(401, {
        error: "Admin routes need the admin token — header x-memo-token or Authorization: Bearer.",
        code: "admin_token_invalid", retryable: false,
      });
    }

    if (method === "GET" && pathname === "/api/admin/tokens") {
      const tokens = tokenStore.list();
      return json(200, { count: tokens.length, tokens });
    }

    if (method === "POST" && pathname === "/api/admin/tokens") {
      try { return json(201, { token: tokenStore.issue(body) }); }
      catch (error) { return badRequest(error); }
    }

    const item = pathname.match(/^\/api\/admin\/tokens\/([^/]+)$/);
    if (item) {
      const id = toTokenId(item[1]);
      const record = id === null ? null : tokenStore.get(id);
      if (!record) return json(404, { error: "No such token.", code: "token_not_found", id: item[1] });

      if (method === "DELETE") {
        // 이미 폐기된 토큰의 재폐기는 revoked:false — 실패가 아니라 이미 원하는 상태다.
        return json(200, { revoked: tokenStore.revoke(id), token: tokenStore.get(id) });
      }
    }

    return json(405, { error: "Method not supported on this path.", method, pathname });
  };
}
