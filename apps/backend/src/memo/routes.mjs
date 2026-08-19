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
import { LIST_LIMIT, MEMO_SORTS, MEMO_STATUSES, toMemoId } from "./memo-store.mjs";
import { toCommentId } from "./comment-store.mjs";
import { isAdminToken } from "../core/admin-token.mjs";
import { DEFAULT_TEAM } from "../auth/team-store.mjs";

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
const LIST_PARAMS = new Set(["status", "q", "author", "user", "limit", "offset", "full", "sort", "team"]);

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

  // 정렬 축. 기본은 최신순이고 그대로 둔다 — 이미 그것에 기대어 짜인 소비자가 있다.
  const sort = (params.get("sort") || "new").trim() || "new";
  if (!MEMO_SORTS.includes(sort)) {
    throw fail("invalid_param", `sort must be one of ${MEMO_SORTS.join(" · ")}.`);
  }

  return {
    status,
    sort,
    team: (params.get("team") || "").trim(),
    q: (params.get("q") || "").trim(),
    author: (params.get("author") || "").trim(),
    user: (params.get("user") || "").trim(),
    full: boolParam(params, "full"),
    limit: intParam(params, "limit", LIST_LIMIT.default, 1, LIST_LIMIT.max),
    offset: intParam(params, "offset", 0, 0, Number.MAX_SAFE_INTEGER),
  };
}

export function createMemoRoutes(ctx) {
  const { memoStore, tokenStore, commentStore, teamStore, voteStore = null, auditStore = null, adminToken = "" } = ctx;
  // 팀 스토어는 선택이 아니다. 없으면 기본값이 "전부 보임"이 되는데, 그건 배선 하나가 빠진
  // 날 비밀 팀이 통째로 열리는 실패다 — 그 실패는 기동 때 죽는 쪽이 낫다.
  if (!teamStore) throw new Error("createMemoRoutes: teamStore is required — visibility fails open without it.");

  return async function handleMemo(method, pathname, query = null, body = {}, headers = {}) {
    const mine = pathname === "/api/memos" || pathname.startsWith("/api/memos/") || pathname === "/api/teams";
    if (!mine) return null;

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

    // 이 사람에게 보이는 팀 — null 은 "전부"(운영자·super). 이 아래의 모든 읽기·쓰기가
    // 이 값 하나로 걸러진다. 경로마다 따로 계산하면 언젠가 한 경로가 빠진다.
    const visible = teamStore.visibleTeams(user || "", { operator: operator || user === null });
    const canSee = (team) => visible === null || visible.includes(team);
    // 보이는 메모만 돌려준다 — 안 보이는 메모는 **없는 메모와 같은 404** 다. 403 은 "있긴
    // 하다"를 말해 주는데, 비밀 프로젝트는 존재 자체가 비밀이다.
    const seen = (id, viewer = "") => {
      const memo = memoStore.get(id, viewer);
      return memo && canSee(memo.team) ? memo : null;
    };
    const teamNotFound = (name) => json(404, {
      error: `No such team: "${name}".`, code: "team_not_found", retryable: false,
    });

    // 내 팀 목록. 자기에게 보이는 팀만 준다 — 팀의 존재가 곧 정보라서, 전체 목록은 관리자
    // 축(/api/admin/teams)에만 있다. super·운영자는 전부(그들에겐 전부가 보이는 팀이다).
    if (pathname === "/api/teams") {
      if (method !== "GET") return json(405, { error: "Method not supported on this path.", method, pathname });
      const teams = visible === null
        ? teamStore.list().map(({ members, ...t }) => t)  // 구성원 명단은 관리자 축의 것이다
        : visible.map((name) => teamStore.get(name)).filter(Boolean);
      return json(200, { count: teams.length, teams });
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
        // viewer 는 쿼리가 아니라 **토큰**에서 온다 — myScore 는 부르는 사람마다 다른 값이고,
        // 쿼리로 받으면 남의 표를 조회하는 길이 열린다.
        // ?team= 은 보이는 팀 안에서의 좁히기다. 안 보이는 팀 이름은 없는 팀과 같은 404 —
        // 200 빈 목록은 "그 팀은 비어 있다"는 다른 사실이 된다.
        let teams = visible;
        if (options.team) {
          if (!canSee(options.team) || !teamStore.get(options.team)) return teamNotFound(options.team);
          teams = [options.team];
        }
        const { total, memos } = memoStore.list({ ...options, viewer: user || "", teams });
        return json(200, {
          count: memos.length, total, limit: options.limit, offset: options.offset, memos,
        });
      } catch (error) { return badRequest(error); }
    }

    if (method === "POST" && pathname === "/api/memos") {
      // 글의 팀은 본문으로 고르되, 저장소에는 검증을 통과한 값만 넘어간다. 소속이 아닌 팀은
      // 존재를 말하지 않는다(404) — 어느 팀에 못 쓰는지의 목록이 곧 팀 목록이 되기 때문이다.
      // null 은 undefined 와 같이 "안 골랐다"로 읽는다 — 많은 클라이언트가 빈 칸을 null 로
      // 직렬화하고, 그것을 404 로 거절하면 팀을 안 쓰는 사람이 팀 때문에 막힌다.
      const team = body?.team == null ? DEFAULT_TEAM : String(body.team).trim();
      if (!team || !teamStore.get(team) || !teamStore.canPost(user, team)) return teamNotFound(body?.team);
      try { return json(201, { memo: memoStore.create(body, user, team) }); }
      catch (error) { return badRequest(error); }
    }

    // ---- 이력 -----------------------------------------------------------------------------
    //
    // 자기 글이 언제 누구에게 고쳐졌는지는 **당사자가 알아야 한다.** 내용(덮인 본문·지워진
    // 제목)은 빼고 사실만 준다 — 전문은 관리자 축(GET /api/admin/audit)에 있다.
    //
    // 메모가 이미 지워졌어도 답한다. "그 메모 어디 갔나"가 이 축이 있는 이유라, 존재 검사를
    // 붙이면 정확히 그 질문에만 404 로 답하게 된다.
    const history = pathname.match(/^\/api\/memos\/([^/]+)\/history$/);
    if (history) {
      const memoId = toMemoId(history[1]);
      if (memoId === null) return json(404, { error: "No such memo.", code: "memo_not_found", id: history[1] });
      if (method !== "GET") return json(405, { error: "Method not supported on this path.", method, pathname });
      if (!auditStore) return json(503, { error: "Audit trail is not wired on this deployment.", code: "audit_unavailable" });
      // **문이 둘이다.**
      //
      // ① 그 글이 지금(또는 지워졌다면 마지막에) 있던 팀이 보이는가. 안 보이면 이력도 통째로
      //    없다 — 줄 단위 필터만 걸면 이동 **이전**에 쌓인 줄이 옛 팀 스탬프로 남아, 비밀 팀에
      //    들어간 글이 "줄은 있는데 삭제 기록은 없다"는 제 3의 상태로 보인다. 그 차이가 곧
      //    "그 글은 아직 어딘가 살아 있다"는 증명이고, 이 축에서 막으려던 것이 정확히 그것이다.
      // ② 남은 줄 중에서도 자기가 못 보던 시절의 사건은 빼 준다(historyFor 의 teams). 그래서
      //    비밀 팀에서 공개로 나온 글은 공개 이후의 이력만 보인다 — 비밀 시절에 누가 손댔는지는
      //    그 팀의 것이다.
      const live = memoStore.get(memoId);
      const finalTeam = live ? live.team : auditStore.finalTeamOf(memoId);
      if (finalTeam !== null && !canSee(finalTeam)) {
        return json(200, { count: 0, total: 0, memoId, history: [] });
      }
      const { total, history: entries } = auditStore.historyFor(memoId, { teams: visible });
      return json(200, { count: entries.length, total, memoId, history: entries });
    }

    // ---- 중요도 ---------------------------------------------------------------------------
    //
    // 한 사람이 한 글에 1~5 점. `PUT` 은 **자기 점수**를 놓는 것이라 멱등하다 — 두 번 나가도
    // 두 배가 되지 않는다. POST 였으면 "5 점 더"로 읽혔을 것이고, 그건 재시도가 순위를 바꾸는
    // 설계다. 남의 표를 건드리는 경로는 없다(user 는 늘 토큰에서 온다).
    //
    // 이력(audit)에 남기지 않는다. 이 축에서 덮이는 것은 언제나 자기 값 하나뿐이라, 본문
    // last-write-wins 처럼 "남의 것이 사라지는" 경우가 없다 — 남길 사고가 없다.
    const score = pathname.match(/^\/api\/memos\/([^/]+)\/score$/);
    if (score) {
      const memoId = toMemoId(score[1]);
      const memo = memoId === null ? null : seen(memoId);
      // 이력과 달리 지워진 글에는 답하지 않는다 — 표는 글과 함께 사라졌고, 여기서 0 을
      // 돌려주면 "아무도 중요하다고 안 했다"는 다른 사실이 된다.
      if (!memo) return json(404, { error: "No such memo.", code: "memo_not_found", id: score[1] });
      if (!["GET", "PUT", "DELETE"].includes(method)) {
        return json(405, { error: "Method not supported on this path.", method, pathname });
      }
      // **순서가 뜻이다**(이력 라우트와 같게): 없는 글은 404, 없는 메서드는 405, 그 다음에야
      // 503 이다. 503 은 "운영자가 고치면 되는 일" 이라는 뜻이라, 오타나 영영 지원 안 될 메서드에
      // 그걸 돌려주면 부르는 쪽은 자기 잘못을 고칠 생각을 못 하고 재시도만 한다.
      if (!voteStore) return json(503, { error: "Scoring is not wired on this deployment.", code: "score_unavailable" });

      // 셋 다 같은 모양으로 답한다 — 부르는 쪽이 응답마다 다른 파서를 두지 않게.
      //
      // 합계·사람 수·내 점수는 **memoStore 가 정본**이다. 여기서 따로 세면 같은 수치의 SQL 이
      // 두 벌이 되고, 한쪽만 고쳐지는 날 목록과 이 라우트가 같은 글을 두고 다른 수를 말한다
      // (관리자 토큰 비교를 core 로 올린 것과 같은 이유다).
      const payload = () => {
        const { score: sum, voters, myScore } = memoStore.get(memoId, user || "");
        return { memoId, score: sum, voters, myScore, scores: voteStore.listFor(memoId) };
      };

      if (method === "GET") return json(200, payload());
      if (method === "PUT") {
        try {
          voteStore.set(memoId, body?.value, user);
          return json(200, payload());
        } catch (error) { return badRequest(error); }
      }
      const deleted = voteStore.clear(memoId, user);
      return json(200, { deleted, ...payload() });
    }

    // ---- 댓글 -----------------------------------------------------------------------------
    //
    // 메모 밑에 걸린다(`/api/memos/:memoId/comments`). 댓글만 따로 도는 최상위 축을 만들지
    // 않는 이유: 댓글은 늘 어떤 메모의 것이고, 최상위로 두면 "어느 메모의?"를 매번 되물어야 한다.
    // 쓰기 문턱은 위에서 이미 걸렸다 — 이 아래는 user 가 토큰에서 역산된 뒤다.
    const comments = pathname.match(/^\/api\/memos\/([^/]+)\/comments$/);
    if (comments) {
      const memoId = toMemoId(comments[1]);
      const memo = memoId === null ? null : seen(memoId);
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
      // 댓글의 가시성은 메모를 따른다 — 안 보이는 메모의 댓글은 id 를 맞혀도 없는 것이다.
      if (comment && !seen(comment.memoId)) {
        return json(404, { error: "No such comment.", code: "comment_not_found", id: commentItem[2] });
      }
      // 다른 메모의 댓글 id 로 지우려는 요청은 "그런 댓글은 없다"다. 경로가 사실과 다르면
      // 지워 주는 쪽이 더 위험하다 — 지운 사람은 자기가 무엇을 지웠는지 모른다.
      if (!comment || String(comment.memoId) !== String(toMemoId(commentItem[1]))) {
        return json(404, { error: "No such comment.", code: "comment_not_found", id: commentItem[2] });
      }
      // 수정은 없다(append-only). 인용되는 글이 조용히 바뀌면 인용이 무의미해진다.
      if (method === "DELETE") return json(200, { deleted: commentStore.remove(commentId, user), id: commentId });
      return json(405, { error: "Method not supported on this path.", method, pathname });
    }

    const item = pathname.match(/^\/api\/memos\/([^/]+)$/);
    if (item) {
      const id = toMemoId(item[1]);
      // 숫자가 아닌 id 는 그 자체로 없는 문서다. 소비자가 할 일이 "요청을 고쳐라"가 아니라
      // "그런 메모는 없다"로 같으므로 400 이 아니라 404.
      const memo = id === null ? null : seen(id, user || "");
      if (!memo) return json(404, { error: "No such memo.", code: "memo_not_found", id: item[1] });

      // 한 건은 **문서**다. 댓글을 같이 실어 주지 않으면 소비자는 commentCount 를 보고 한 번 더
      // 부른다 — 목록이 요약인 것과 달리, 여기서 아끼는 것은 아무것도 없다. 표도 같다(사람 수
      // 만큼이라 짧고, 누가 중요하다고 했는지가 그 글을 읽을지 정하는 근거다).
      if (method === "GET") {
        return json(200, {
          memo,
          comments: commentStore.listFor(id),
          scores: voteStore ? voteStore.listFor(id) : [],
        });
      }

      if (method === "PATCH") {
        // 팀 이동. 목적지는 소속이어야 하고, **글 주인(또는 super)만** 옮길 수 있다.
        //
        // 다른 칸의 PATCH 는 아무나 한다(이 보드의 규약이고, 덮인 값은 이력에 남아 되돌릴 수
        // 있다). 팀 이동만 다른 이유: 되돌릴 수 없는 쪽이 **당한 사람**이다. 남의 공개 글을
        // 비밀 팀으로 끌고 가면 글쓴이는 자기 글을 못 보고, 달아 둔 댓글도 준 점수도 손댈 수
        // 없게 되며(전부 404), 그 글은 비밀 팀 안에서 계속 읽힌다. 남의 말을 데려가는 것이라
        // 편집이 아니라 소유의 문제다.
        // 이동할 팀. undefined 면 이동 없음이고, 저장소는 **이 인자로만** 팀을 본다 — 본문의
        // team 은 여기서 끝난다. 값이 두 곳에서 읽히면 두 조건이 어긋나는 날이 오고, 어긋난
        // 틈은 문턱을 통째로 건너뛰는 길이 된다(실제로 그랬다).
        let moveTo;
        if (body?.team != null) {
          const target = String(body.team).trim();
          if (!target || !teamStore.get(target) || !teamStore.canPost(user, target)) {
            return teamNotFound(body.team);
          }
          if (memo.user !== user && !teamStore.isSuper(user)) {
            return json(403, {
              error: "Only the post's owner (or a super member) can move it to another team — moving it takes other people's comments and scores with it.",
              code: "team_move_not_owner", retryable: false,
            });
          }
          moveTo = target;
        }
        try { return json(200, { memo: memoStore.update(id, body, user, moveTo) }); }
        catch (error) { return badRequest(error); }
      }

      if (method === "DELETE") {
        return json(200, { deleted: memoStore.remove(id, user), id });
      }
    }

    // 경로는 이 축의 것인데 메서드가 없는 조합 — 404 로 흘리면 종단 404 가 "경로가 없다"고
    // 거짓말한다.
    return json(405, { error: "Method not supported on this path.", method, pathname });
  };
}
