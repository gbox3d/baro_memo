// 정체성 축: /api/auth/whoami
//
// 이 보드가 다른 서비스에 내어 주는 것은 딱 하나, **토큰이 누구인가**다. baro_files(아티팩트
// 서비스)가 업로드에 사람을 찍을 때 이 라우트를 부른다 — 토큰 발급을 두 벌 두면 사람이 서비스
// 수만큼 늘어나고, 폐기가 한쪽만 되는 날부터 "누구"가 서비스마다 다른 답이 된다.
//
// 답의 세 갈래는 보드의 읽기 문턱과 같은 구분이다:
//   200 {user: "kim", admin: false}  사람 토큰 — 이 사람이다
//   200 {user: null, admin: true}    관리자 토큰 — 유효하지만 사람이 없다. 부르는 쪽은 이 값으로
//                                    읽기는 허용하되 귀속이 필요한 쓰기(발행)는 거절해야 한다
//   401 memo_token_invalid           토큰이 아니다 — 부르는 쪽이 고친다
//   503 no_tokens_issued             발급된 토큰이 0개 — 운영자가 고친다
//
// **폴링당하는 표면이다.** 소비자는 답을 짧게(분 단위) 캐시하라 — 폐기의 전파가 그만큼 늦는
// 것은 이 보드의 소프트 폐기 정책과 같은 결이다.
import { json } from "../core/http.mjs";
import { isAdminToken } from "../core/admin-token.mjs";
import { presentedToken } from "../memo/routes.mjs";

export function createAuthRoutes(ctx) {
  const { tokenStore, adminToken = "" } = ctx;

  return async function handleAuth(method, pathname, query, body, headers = {}) {
    if (pathname !== "/api/auth/whoami") return null;
    if (method !== "GET") return json(405, { error: "Method not supported on this path.", method, pathname });

    const presented = presentedToken(headers);
    if (isAdminToken(adminToken, presented)) return json(200, { user: null, admin: true });

    const user = tokenStore.userFor(presented);
    if (user !== null) return json(200, { user, admin: false });

    // 거절의 구분은 읽기 문턱과 같다 — 고칠 사람이 다르기 때문이다.
    if (tokenStore.counts().active === 0) {
      return json(503, {
        error: "No tokens have been issued on this deployment — ask the operator (admin page → issue a token).",
        code: "no_tokens_issued", retryable: false,
      });
    }
    return json(401, {
      error: "Not a valid token — header x-memo-token or Authorization: Bearer.",
      code: "memo_token_invalid", retryable: false,
    });
  };
}
