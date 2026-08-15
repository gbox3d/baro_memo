// 정체성 — 토큰이 누구인가는 **이 서비스가 답하지 않는다.** baro_memo 의
// GET /api/auth/whoami 가 정본이다. 발급을 두 벌 두면 사람이 서비스 수만큼 늘고,
// 폐기가 한쪽만 되는 날부터 "누구"가 서비스마다 다른 답이 된다.
//
// 캐시를 두는 이유는 둘이고, 방향이 반대라 둘 다 적는다:
//   1. 다운로드는 nginx 가 요청마다 auth_request 로 이 서비스의 /api/verify 를 부른다 —
//      Range 재개가 잦아 같은 토큰이 분당 수십 번 들어온다. 보드를 그 빈도로 때리지 않는다.
//   2. **보드가 재시작 중이어도 릴리스는 받아져야 한다.** 캐시가 살아 있는 동안 다운로드는
//      보드 없이 돈다. 만료된 항목도 보드가 안 닿으면 한도(staleMaxMs) 안에서 계속 쓴다 —
//      폐기 전파가 그만큼 늦는 것은 보드 자신의 소프트 폐기 정책과 같은 결이다.
//
// 답의 모양: {ok:true, user, admin} | {ok:false, status, code}. 부정 답도 짧게 캐시한다 —
// 틀린 토큰으로 재시도하는 클라이언트가 보드를 두들기지 않게.
export function createIdentity({
  memoApi,
  ttlMs = 120_000,
  negativeTtlMs = 5_000,
  staleMaxMs = 3_600_000,
  // 보드가 **매달려 있는** 경우(죽은 게 아니라 안 답하는 경우)의 한도. 이 시계가 없으면
  // 묵은 답이 캐시에 멀쩡히 있는데도 다운로드 인증이 그 매달림을 그대로 물려받는다 —
  // "보드는 다운로드 경로에 없다"는 경계가 행으로만 있고 시간으로는 없는 상태가 된다.
  timeoutMs = 2_000,
  fetchImpl = fetch,
  now = Date.now,
} = {}) {
  const cache = new Map(); // token -> {at, verdict}

  function askWithDeadline(token) {
    let timer;
    return Promise.race([
      fetchImpl(`${memoApi}/auth/whoami`, { headers: { "x-memo-token": token } }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("identity timeout")), timeoutMs); }),
    ]).finally(() => clearTimeout(timer));
  }

  async function resolve(token) {
    if (!token) return { ok: false, status: 401, code: "memo_token_invalid" };

    const hit = cache.get(token);
    const age = hit ? now() - hit.at : Infinity;
    const freshFor = hit?.verdict.ok ? ttlMs : negativeTtlMs;
    if (hit && age < freshFor) return hit.verdict;

    let verdict;
    try {
      const res = await askWithDeadline(token);
      const data = await res.json().catch(() => ({}));
      verdict = res.ok
        ? { ok: true, user: data.user ?? null, admin: data.admin === true }
        : { ok: false, status: res.status, code: data.code || "memo_token_invalid" };
    } catch {
      // 보드가 안 닿는다. 만료됐어도 아는 답이 있으면 그걸 쓴다 — 릴리스 다운로드가
      // 보드 재시작에 볼모로 잡히지 않게. 아는 답도 없으면 원인을 정확히 말한다:
      // 503 identity_unavailable 은 "네 토큰이 틀렸다"가 아니다.
      if (hit && age < staleMaxMs) return hit.verdict;
      return { ok: false, status: 503, code: "identity_unavailable" };
    }
    cache.set(token, { at: now(), verdict });
    return verdict;
  }

  return { resolve, cacheSize: () => cache.size };
}
