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
