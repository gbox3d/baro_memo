// 메모 축 라우트: /api/memos*
//
// 문턱은 하나이고, 그 위에 사람 확인이 하나 더 붙는다 (0.5.0 에서 읽기가 닫혔다).
//   읽기: 토큰이 필요하다. 사람 토큰이거나 관리자 토큰. 이 보드는 밖에서 닿는 주소로 열려 있고
//         게시물에는 경로·식별자·실패 사례가 그대로 들어 있다.
//   쓰기: **사람** 토큰만. 토큰에서 사용자를 역산해 `user`(생성)·`updatedBy`(갱신)에 찍는다 —
//         작성자 추적이 이 서비스를 baro_calrory 에서 분리한 이유다. 관리자 토큰에는 사람이
//         없어서 찍을 값이 없다(403 admin_token_cannot_write).
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
import { toCommentId } from "./comment-store.mjs";
import { isAdminToken } from "../core/admin-token.mjs";

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
  const { memoStore, tokenStore, commentStore, adminToken = "" } = ctx;

  return async function handleMemo(method, pathname, query = null, body = {}, headers = {}) {
    if (pathname !== "/api/memos" && !pathname.startsWith("/api/memos/")) return null;

    const presented = presentedToken(headers);
    // 관리자 토큰은 **읽기까지**다. 쓰기로 인정하지 않는 이유: 그 값에는 사람이 없어서 user 를
    // 찍을 수 없고, 운영자는 자기 사람 토큰을 스스로 발급할 수 있다.
    const operator = isAdminToken(adminToken, presented);
    let user = tokenStore.userFor(presented);

    // 읽기도 토큰이 필요하다. 이 보드는 밖에서 닿는 주소로 열려 있고, 게시물에는 경로·식별자·
    // 실패 사례가 그대로 들어 있다. 문턱은 하나이고, 쓰기는 그 위에 사람 확인이 더 붙는다.
    if (user === null && !operator) {
      if (tokenStore.counts().active === 0) {
        return json(503, {
          error: "No tokens have been issued on this deployment — ask the operator (admin page → issue a token).",
          code: "no_tokens_issued", retryable: false,
        });
      }
      return json(401, {
        error: "The board needs a token, for reads as well as writes — header x-memo-token or Authorization: Bearer. Ask the operator for one.",
        code: "memo_token_invalid", retryable: false,
      });
    }

    if (method !== "GET") {
      // 여기서 걸리는 것은 관리자 토큰 하나뿐이다(사람 토큰은 이미 위를 통과했다).
      if (user === null) {
        return json(403, {
          error: "The admin token can read the board but not write to it — issue yourself a user token; `user` is stamped from it.",
          code: "admin_token_cannot_write", retryable: false,
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

    // ---- 댓글 -----------------------------------------------------------------------------
    //
    // 메모 밑에 걸린다(`/api/memos/:memoId/comments`). 댓글만 따로 도는 최상위 축을 만들지
    // 않는 이유: 댓글은 늘 어떤 메모의 것이고, 최상위로 두면 "어느 메모의?"를 매번 되물어야 한다.
    // 쓰기 문턱은 위에서 이미 걸렸다 — 이 아래는 user 가 토큰에서 역산된 뒤다.
    const comments = pathname.match(/^\/api\/memos\/([^/]+)\/comments$/);
    if (comments) {
      const memoId = toMemoId(comments[1]);
      const memo = memoId === null ? null : memoStore.get(memoId);
      // 없는 메모에 다는 댓글은 조용히 떠돌게 두지 않는다 — 메모 축과 같은 404.
      if (!memo) return json(404, { error: "No such memo.", code: "memo_not_found", id: comments[1] });

      if (method === "GET") {
        const list = commentStore.listFor(memoId);
        return json(200, { count: list.length, memoId, comments: list });
      }
      if (method === "POST") {
        try { return json(201, { comment: commentStore.add(memoId, body, user) }); }
        catch (error) { return badRequest(error); }
      }
      return json(405, { error: "Method not supported on this path.", method, pathname });
    }

    const commentItem = pathname.match(/^\/api\/memos\/([^/]+)\/comments\/([^/]+)$/);
    if (commentItem) {
      const commentId = toCommentId(commentItem[2]);
      const comment = commentId === null ? null : commentStore.get(commentId);
      // 다른 메모의 댓글 id 로 지우려는 요청은 "그런 댓글은 없다"다. 경로가 사실과 다르면
      // 지워 주는 쪽이 더 위험하다 — 지운 사람은 자기가 무엇을 지웠는지 모른다.
      if (!comment || String(comment.memoId) !== String(toMemoId(commentItem[1]))) {
        return json(404, { error: "No such comment.", code: "comment_not_found", id: commentItem[2] });
      }
      // 수정은 없다(append-only). 인용되는 글이 조용히 바뀌면 인용이 무의미해진다.
      if (method === "DELETE") return json(200, { deleted: commentStore.remove(commentId), id: commentId });
      return json(405, { error: "Method not supported on this path.", method, pathname });
    }

    const item = pathname.match(/^\/api\/memos\/([^/]+)$/);
    if (item) {
      const id = toMemoId(item[1]);
      // 숫자가 아닌 id 는 그 자체로 없는 문서다. 소비자가 할 일이 "요청을 고쳐라"가 아니라
      // "그런 메모는 없다"로 같으므로 400 이 아니라 404.
      const memo = id === null ? null : memoStore.get(id);
      if (!memo) return json(404, { error: "No such memo.", code: "memo_not_found", id: item[1] });

      // 한 건은 **문서**다. 댓글을 같이 실어 주지 않으면 소비자는 commentCount 를 보고 한 번 더
      // 부른다 — 목록이 요약인 것과 달리, 여기서 아끼는 것은 아무것도 없다.
      if (method === "GET") return json(200, { memo, comments: commentStore.listFor(id) });

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
