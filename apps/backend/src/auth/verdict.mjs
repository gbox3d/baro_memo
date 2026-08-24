// 토큰 → 정체성 판정. **이 판정의 정본은 여기 하나다.**
//
// 0.9.0 에서는 이 로직이 `/api/auth/whoami` 라우트 안에 있었고, 아티팩트 저장소가 그것을 HTTP 로
// 물어 캐시했다. 프로세스가 하나가 된 지금(0.11.0) 저장소는 이 함수를 직접 부른다 — 그래서
// 사라진 것이 캐시이고, 캐시와 함께 사라진 것이 **폐기 지연**이다. 예전에는 토큰을 회수해도
// 저장소에는 몇 분 뒤에야 닿았다. 지금은 다음 요청이 곧 새 판정이다.
//
// 판정의 세 갈래는 보드의 읽기 문턱과 같은 구분이고, 그 기준은 **누가 고치는가** 다:
//   {ok, user: "kim", admin: false}     사람 토큰 — 귀속이 있다
//   {ok, user: null,  admin: true}      관리자 토큰 — 유효하지만 사람이 없다. 읽기는 되고,
//                                       귀속이 필요한 쓰기(글 작성·아티팩트 발행)는 부르는 쪽이 막는다
//   {status: 401, code: memo_token_invalid}   부르는 쪽이 고친다
//   {status: 503, code: no_tokens_issued}     운영자가 고친다
import { isAdminToken } from "../core/admin-token.mjs";

export function createVerdict({ tokenStore, adminToken = "" }) {
  return function resolve(token) {
    if (isAdminToken(adminToken, token)) return { ok: true, user: null, admin: true };

    const user = tokenStore.userFor(token);
    if (user !== null) return { ok: true, user, admin: false };

    if (tokenStore.counts().active === 0) {
      return {
        ok: false, status: 503, code: "no_tokens_issued",
        error: "No tokens have been issued on this deployment — ask the operator (admin page → issue a token).",
      };
    }
    return {
      ok: false, status: 401, code: "memo_token_invalid",
      error: "Not a valid token — header x-memo-token or Authorization: Bearer.",
    };
  };
}

/**
 * 판정 위에 **팀 문턱**을 얹는다 — 아티팩트 저장소가 쓰는 모양이다 (0.14.0).
 *
 * 정체성은 위의 한 벌이 정본이고 거기에 팀은 없다: 팀은 보드의 개념이라 apps/files 에는
 * "team" 이라는 낱말조차 나오지 않는다. 그런데 0.14.0 이 "소속 없으면 아무것도 없다"를
 * 약속하는 순간, 얹지 않으면 그 문장이 **배포의 절반에만 참**이 된다 — 관리자 페이지는
 * "이 사람들에게 보드는 닫혀 있습니다" 라고 적는데 같은 토큰으로 이 배포의 아티팩트 전부를
 * 목록·다운로드하고 발행까지 한다(`/api/files/verify` 가 nginx auth_request 의 허가 자리다).
 *
 * 그래서 규칙만 여기서 합치고 판정은 늘리지 않는다. 관리자 토큰은 그대로 통과한다 —
 * 운영자에게는 소속이라는 개념이 없고(visibleTeams 가 null), 그 값에는 찍을 사람도 없다.
 */
export function withTeamGate(resolve, teamStore) {
  if (!teamStore) throw new Error("withTeamGate: teamStore is required — the gate fails open without it.");
  return function resolveWithTeam(token) {
    const v = resolve(token);
    if (!v.ok || v.user === null) return v;
    const teams = teamStore.visibleTeams(v.user);
    if (teams !== null && teams.length === 0) {
      return {
        ok: false, status: 403, code: "no_team_assigned",
        error: "Your user belongs to no team on the board, so this store is closed to you too. Ask the operator to put you in one.",
      };
    }
    return v;
  };
}
