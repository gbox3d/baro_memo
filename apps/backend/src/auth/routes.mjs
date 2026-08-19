// 정체성 축: /api/auth/whoami
//
// 이 보드가 밖에 내어 주는 것은 딱 하나, **토큰이 누구인가**다. 토큰 발급을 두 벌 두면 사람이
// 서비스 수만큼 늘어나고, 폐기가 한쪽만 되는 날부터 "누구"가 서비스마다 다른 답이 된다.
//
// 0.11.0 에서 아티팩트 저장소가 같은 프로세스로 들어오면서 **이 라우트의 소비자는 사라졌다** —
// 저장소는 이제 createVerdict 를 직접 부른다. 라우트를 남겨 두는 이유는 두 가지다: 사람이
// "내 토큰이 뭐로 읽히나"를 물어볼 자리가 있어야 하고(발급 직후 확인이 여기다), 다음에 붙는
// 형제 서비스가 다시 프로세스 밖일 수 있다. 판정 자체는 여기 없다 — verdict.mjs 가 정본이다.
//
// **폴링당하는 표면이다.** 프로세스 밖 소비자는 답을 짧게(분 단위) 캐시하라 — 폐기의 전파가
// 그만큼 늦는 것은 이 보드의 소프트 폐기 정책과 같은 결이다.
import { json } from "../core/http.mjs";
import { presentedToken } from "../memo/routes.mjs";

export function createAuthRoutes(ctx) {
  const { verdict, teamStore = null } = ctx;

  return async function handleAuth(method, pathname, query, body, headers = {}) {
    if (pathname !== "/api/auth/whoami") return null;
    if (method !== "GET") return json(405, { error: "Method not supported on this path.", method, pathname });

    const v = verdict(presentedToken(headers));
    if (v.ok) {
      // teams: 이 토큰으로 **쓸 수 있는 팀**이고, GET /api/teams 가 이름을 주는 목록과 같은
      // 집합이다. 소속 표(teamsOf)를 그대로 쓰면 super 구성원이 어긋난다 — 그 사람의 소속
      // 행은 두 개인데 실제로는 모든 팀에 쓸 수 있어서, 이 값을 믿는 에이전트가 자기 권한을
      // 실제보다 좁게 안다. 관리자 토큰은 사람이 없으므로 null("전부").
      const teams = teamStore
        ? (v.user === null ? null : (teamStore.visibleTeams(v.user) ?? teamStore.list().map((t) => t.name)))
        : undefined;
      return json(200, { user: v.user, admin: v.admin, ...(teams !== undefined ? { teams } : {}) });
    }
    return json(v.status, { error: v.error, code: v.code, retryable: false });
  };
}
