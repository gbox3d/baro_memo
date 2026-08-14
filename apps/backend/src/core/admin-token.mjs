// 관리자 토큰을 어디서 읽는가.
//
// 이 자격증명은 **자기가 지키는 데이터와 같은 수명**이어야 한다. DB 는 저장소 밖 볼륨
// (/mnt/data/baro_memo_db) 에 있어서 저장소를 지우고 다시 받아도 살아남는데, 토큰이 저장소
// 안 .env 에만 있으면 그때 보드와 발급된 사용자 토큰은 남고 그걸 관리할 열쇠만 사라진다.
// 그래서 ADMIN_TOKEN_FILE 로 DB 옆의 파일을 가리킬 수 있게 한다.
//
// 정본은 하나여야 하므로 우선순위를 못 박는다: **ADMIN_TOKEN_FILE 이 있으면 그 파일이
// 전부다.** 파일을 못 읽었다고 ADMIN_TOKEN 으로 몰래 내려가지 않는다 — 그러면 운영자는
// 자기가 방금 고친 파일이 아니라 잊고 있던 환경변수로 인증되는 상황을 만난다.
import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";

/**
 * 제시된 값이 관리자 토큰인가. 길이가 다르면 timingSafeEqual 이 던지므로 먼저 거른다.
 * 미설정(expected 가 "")은 언제나 false — 빈 토큰으로 통과하는 문은 만들지 않는다.
 *
 * 관리 라우트와 **읽기 문턱** 두 곳이 쓴다: 운영자는 사람 토큰이 없어도 보드를 읽을 수 있어야
 * 한다(관리자 페이지가 든 것이 이 값이고, 어차피 스스로 사람 토큰을 발급할 수 있다).
 */
export function isAdminToken(expected, presented) {
  const a = Buffer.from(String(expected || ""), "utf8");
  const b = Buffer.from(String(presented || ""), "utf8");
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * @returns {{ token: string, source: string }} token 이 "" 이면 미설정 —
 *   관리 라우트가 503 admin_token_unset 으로 답한다. 여기서 던지지 않는 이유: 관리자
 *   자격증명 하나 때문에 프로세스가 죽으면 읽기·쓰기까지 멎는데, 보드는 그것과 무관하다.
 */
export function readAdminToken(env = process.env, log = console.error) {
  const file = String(env.ADMIN_TOKEN_FILE || "").trim();
  if (!file) return { token: String(env.ADMIN_TOKEN || "").trim(), source: "env" };
  try {
    return { token: readFileSync(file, "utf8").trim(), source: file };
  } catch (error) {
    // 조용히 미설정이 되면 "왜 관리자 페이지가 503 이지"를 처음부터 뒤지게 된다.
    log(`[baro_memo] ADMIN_TOKEN_FILE 을 읽지 못했습니다 (${file}): ${error.message}`);
    return { token: "", source: file };
  }
}
