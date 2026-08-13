// 메모 축 라우트: /api/memos*
//
// 문턱이 둘로 갈린다 — 이 서비스의 계약 그 자체다.
//   읽기: 열려 있다. "접수함을 보는 데까지 비밀을 요구하면 접수함이 아니다" (원본의 의도 유지).
//   쓰기: 사용자 토큰. 토큰에서 사용자를 역산해 `user`(생성)·`updatedBy`(갱신)에 찍는다 —
//         작성자 추적이 이 서비스를 baro_calrory 에서 분리한 이유다.
//
// 그래서 본문의 `user` 는 받지 않는다. 조용히 무시하면 소비자는 자기가 보낸 값이 저장된 줄
// 안다 — 400 으로 정확히 거절한다(빈 PATCH 를 no_fields 로 거절하는 것과 같은 결).
//
// 거절은 원인마다 상태가 다르다. 고칠 사람이 다르기 때문이다:
//   503 no_tokens_issued  — 발급된 토큰이 0개. 어떤 값을 넣어도 안 된다. 관리자가 발급해야 한다.
//   401 memo_token_invalid — 토큰들이 있는데 네 것이 아니다. 부르는 쪽이 고친다.
//
// 반환 규약: 이 축의 경로가 아니면 null.
import { json } from "../core/http.mjs";
import { LIST_LIMIT, MEMO_STATUSES, toMemoId } from "./memo-store.mjs";

// 헤더 두 곳: 전용 `x-memo-token` 과 표준 `Authorization: Bearer`. 도구 사정이다 — 일부
// 클라이언트는 Authorization 을 자기 인증에 이미 쓴다.
export function presentedToken(headers = {}) {
  const direct = headers["x-memo-token"];
  if (direct) return String(direct).trim();
  const auth = String(headers.authorization || "");
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : "";
}

// 저장소가 던지는 불변식 위반은 전부 소비자 잘못이라 400. 코드를 그대로 실어 보내는 이유:
// "왜 거절당했나"를 사람이 문장으로, 에이전트가 코드로 읽는다.
function badRequest(error) {
  return json(400, { error: error.message, code: error.code || "invalid_memo", retryable: false });
}

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

// ---- 목록 쿼리 ---------------------------------------------------------------------------
//
// 여기 없는 이름은 거절한다. 조용히 무시하면 `?staus=open` 이 보드 전체를 200 으로 돌려주고,
// 소비자는 필터가 걸린 줄 안다 — 본문의 오타를 no_fields 로 거절하는 것과 같은 결이다.
const LIST_PARAMS = new Set(["status", "q", "author", "user", "limit", "offset", "full"]);

function asParams(query) {
  return query instanceof URLSearchParams ? query : new URLSearchParams(query || "");
}

function intParam(params, name, fallback, min, max) {
  const raw = params.get(name);
  if (raw === null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw fail("invalid_param", `${name} must be an integer in ${min}..${max}.`);
  }
  return n;
}

// `?full` 처럼 값 없이 쓰는 형태도 켜짐으로 받는다 — 손으로 치는 URL 에서 흔한 모양이다.
function boolParam(params, name) {
  const raw = params.get(name);
  if (raw === null) return false;
  const s = raw.trim().toLowerCase();
  if (s === "" || s === "1" || s === "true") return true;
  if (s === "0" || s === "false") return false;
  throw fail("invalid_param", `${name} must be 1 or 0.`);
}

export function parseListQuery(query) {
  const params = asParams(query);
  for (const name of params.keys()) {
    if (!LIST_PARAMS.has(name)) {
      throw fail("unknown_param", `Unknown query parameter "${name}" — allowed: ${[...LIST_PARAMS].join(", ")}.`);
    }
  }

  // 콤마 목록을 받는다. `?status=open,doing` 이 "지금 살아 있는 일" 이라는 가장 잦은 질문이다.
  let status = null;
  const rawStatus = (params.get("status") || "").trim();
  if (rawStatus) {
    status = rawStatus.split(",").map((s) => s.trim()).filter(Boolean);
    for (const s of status) {
      if (!MEMO_STATUSES.includes(s)) {
        throw fail("invalid_status", `status must be one of ${MEMO_STATUSES.join(" · ")}.`);
      }
    }
  }

  return {
    status,
    q: (params.get("q") || "").trim(),
    author: (params.get("author") || "").trim(),
    user: (params.get("user") || "").trim(),
    full: boolParam(params, "full"),
    limit: intParam(params, "limit", LIST_LIMIT.default, 1, LIST_LIMIT.max),
    offset: intParam(params, "offset", 0, 0, Number.MAX_SAFE_INTEGER),
  };
}

export function createMemoRoutes(ctx) {
  const { memoStore, tokenStore } = ctx;

  return async function handleMemo(method, pathname, query = null, body = {}, headers = {}) {
    if (pathname !== "/api/memos" && !pathname.startsWith("/api/memos/")) return null;

    let user = null;
    if (method !== "GET") {
      if (tokenStore.counts().active === 0) {
        return json(503, {
          error: "No write tokens have been issued on this deployment — ask the operator (admin page → issue a token).",
          code: "no_tokens_issued", retryable: false,
        });
      }
      user = tokenStore.userFor(presentedToken(headers));
      if (user === null) {
        return json(401, {
          error: "Writes need a user token — header x-memo-token or Authorization: Bearer.",
          code: "memo_token_invalid", retryable: false,
        });
      }
      if (body && body.user !== undefined) {
        return json(400, {
          error: "`user` is stamped from your token and cannot be set in the body.",
          code: "user_readonly", retryable: false,
        });
      }
    }

    // 목록은 요약이다(전문은 `?full=1` 또는 id 한 건). count 는 이번에 실어 준 개수,
    // total 은 필터를 통과한 전체 — 둘이 다르면 뒷장이 있다는 뜻이다.
    if (method === "GET" && pathname === "/api/memos") {
      try {
        // 저장소도 던진다 — 검색어가 trigram 하한보다 짧으면 query_too_short.
        const options = parseListQuery(query);
        const { total, memos } = memoStore.list(options);
        return json(200, {
          count: memos.length, total, limit: options.limit, offset: options.offset, memos,
        });
      } catch (error) { return badRequest(error); }
    }

    if (method === "POST" && pathname === "/api/memos") {
      try { return json(201, { memo: memoStore.create(body, user) }); }
      catch (error) { return badRequest(error); }
    }

    const item = pathname.match(/^\/api\/memos\/([^/]+)$/);
    if (item) {
      const id = toMemoId(item[1]);
      // 숫자가 아닌 id 는 그 자체로 없는 문서다. 소비자가 할 일이 "요청을 고쳐라"가 아니라
      // "그런 메모는 없다"로 같으므로 400 이 아니라 404.
      const memo = id === null ? null : memoStore.get(id);
      if (!memo) return json(404, { error: "No such memo.", code: "memo_not_found", id: item[1] });

      if (method === "GET") return json(200, { memo });

      if (method === "PATCH") {
        try { return json(200, { memo: memoStore.update(id, body, user) }); }
        catch (error) { return badRequest(error); }
      }

      if (method === "DELETE") {
        return json(200, { deleted: memoStore.remove(id), id });
      }
    }

    // 경로는 이 축의 것인데 메서드가 없는 조합 — 404 로 흘리면 종단 404 가 "경로가 없다"고
    // 거짓말한다.
    return json(405, { error: "Method not supported on this path.", method, pathname });
  };
}
