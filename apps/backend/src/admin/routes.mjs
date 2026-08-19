// 관리 축 라우트: /api/admin/tokens* · /api/admin/audit
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
import { AUDIT_ACTIONS, AUDIT_LIMIT } from "../memo/audit-store.mjs";
import { presentedToken } from "../memo/routes.mjs";

function badRequest(error) {
  return json(400, { error: error.message, code: error.code || "invalid_token_request", retryable: false });
}

// 이력 조회의 쿼리. 메모 축과 같은 규약이다 — 모르는 이름은 조용히 무시하지 않고 거절한다.
const AUDIT_PARAMS = new Set(["memoId", "action", "actor", "limit", "offset"]);

function parseAuditQuery(query) {
  const params = query instanceof URLSearchParams ? query : new URLSearchParams(query || "");
  for (const name of params.keys()) {
    if (!AUDIT_PARAMS.has(name)) {
      throw Object.assign(new Error(`Unknown query parameter "${name}" — allowed: ${[...AUDIT_PARAMS].join(", ")}.`), { code: "unknown_param" });
    }
  }
  const int = (name, fallback, min, max) => {
    const raw = params.get(name);
    if (raw === null || raw.trim() === "") return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      throw Object.assign(new Error(`${name} must be an integer in ${min}..${max}.`), { code: "invalid_param" });
    }
    return n;
  };
  const action = (params.get("action") || "").trim();
  if (action && !AUDIT_ACTIONS.includes(action)) {
    throw Object.assign(new Error(`action must be one of ${AUDIT_ACTIONS.join(" · ")}.`), { code: "invalid_param" });
  }
  return {
    memoId: int("memoId", null, 1, Number.MAX_SAFE_INTEGER),
    action,
    actor: (params.get("actor") || "").trim(),
    limit: int("limit", AUDIT_LIMIT.default, 1, AUDIT_LIMIT.max),
    offset: int("offset", 0, 0, Number.MAX_SAFE_INTEGER),
  };
}

export function createAdminRoutes(ctx) {
  const { tokenStore, teamStore = null, auditStore = null, adminToken = "" } = ctx;

  // query 는 이 축에서 쓰지 않는다 — 서명은 라우터 규약(server.mjs)이라 자리를 지킨다.
  return async function handleAdmin(method, pathname, query = null, body = {}, headers = {}) {
    const mine = pathname === "/api/admin/tokens" || pathname.startsWith("/api/admin/tokens/")
      || pathname === "/api/admin/audit"
      || pathname === "/api/admin/teams" || pathname.startsWith("/api/admin/teams/");
    if (!mine) return null;

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

    // 삭제·수정 이력. **관리자 축에 두는 이유**: 여기에는 지워진 메모의 전문이 들어 있다.
    // 사용자 토큰으로 열면 "지웠다"가 "목록에서만 빠졌다"가 된다.
    if (pathname === "/api/admin/audit") {
      if (method !== "GET") return json(405, { error: "Method not supported on this path.", method, pathname });
      if (!auditStore) return json(503, { error: "Audit trail is not wired on this deployment.", code: "audit_unavailable" });
      try {
        const options = parseAuditQuery(query);
        const { total, entries } = auditStore.list(options);
        return json(200, { count: entries.length, total, limit: options.limit, offset: options.offset, entries });
      } catch (error) { return badRequest(error); }
    }

    // ---- 팀 — 만들고, 사람을 넣고 뺀다 ---------------------------------------------------
    //
    // 구성원 명단이 실리는 곳은 이 축뿐이다. 팀의 존재도, 누가 어디 속하는지도 정보라서
    // 사용자 축(/api/teams)은 자기에게 보이는 팀 이름까지만 준다.
    // 구성원 지정이 경로가 아니라 **본문**인 이유: user 는 한국어일 수 있고(실제로 있다),
    // 경로 조각의 인코딩 실수는 "없는 사람을 추가"로 조용히 성공해 버린다.
    if (pathname === "/api/admin/teams" || pathname.startsWith("/api/admin/teams/")) {
      if (!teamStore) return json(503, { error: "Teams are not wired on this deployment.", code: "teams_unavailable" });

      if (pathname === "/api/admin/teams") {
        if (method === "GET") {
          const teams = teamStore.list();
          return json(200, { count: teams.length, teams });
        }
        if (method === "POST") {
          try { return json(201, { team: teamStore.create(body) }); }
          catch (error) { return badRequest(error); }
        }
        return json(405, { error: "Method not supported on this path.", method, pathname });
      }

      const members = pathname.match(/^\/api\/admin\/teams\/([a-z0-9][a-z0-9_-]{0,31})\/members$/);
      if (members) {
        const team = members[1];
        try {
          if (method === "POST") {
            const added = teamStore.addMember(team, body?.user);
            return json(200, { added, team, members: teamStore.membersOf(team) });
          }
          if (method === "DELETE") {
            const removed = teamStore.removeMember(team, body?.user);
            return json(200, { removed, team, members: teamStore.membersOf(team) });
          }
        } catch (error) {
          if (error.code === "team_not_found") return json(404, { error: error.message, code: error.code });
          return badRequest(error);
        }
        return json(405, { error: "Method not supported on this path.", method, pathname });
      }
      return json(404, { error: "No such admin route.", code: "admin_route_not_found", pathname });
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
