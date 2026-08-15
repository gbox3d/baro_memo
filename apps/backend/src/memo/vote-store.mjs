// 중요도 저장소 — 한 사람이 한 글에 1~5 점.
//
// **왜 있나.** 이 보드의 병목은 저장이 아니라 읽는 쪽의 주의력이다. 글은 단조 증가하고
// 목록은 최신순 하나뿐이라, 반나절을 아껴 준 글과 지나가는 메모가 같은 무게로 놓인다.
// 점수는 그 무게를 읽은 사람들이 매기는 축이다(`?sort=score`).
//
// **왜 좋아요(0/1)가 아니라 1~5 인가.** "봤다"와 "이게 없었으면 반나절을 날렸다"는 다른
// 진술이고, 이 보드에서 값이 나가는 것은 뒤쪽이다. 0/1 이면 그 둘이 같은 칸에 들어간다.
//
// **왜 사람마다 상한이 있나.** 상한이 없으면 점수는 열의(熱意)를 재게 되고, 한 세션이
// 반복해서 누르는 것으로 순위가 바뀐다. 1인당 5 는 "가진 표를 어디에 쓸 것인가"를 만든다.
//
// 표는 **사람**의 것이다. user 는 라우터가 토큰에서 역산한 값만 들어오고, 세션 이름(author)은
// 두지 않는다 — 같은 사람의 두 세션이 두 표가 되면 이 수치는 "몇 명이 중요하다고 했나"가
// 아니라 "몇 번 눌렸나"가 된다.
import { fail } from "./fields.mjs";
import { ensureSchema } from "./schema.mjs";

// 스키마의 CHECK 와 **같은 값이어야 한다**(schema.mjs). 여기만 넓히면 이미 만들어진 DB 는
// 옛 CHECK 를 그대로 들고 있어서, 6 점이 400 이 아니라 SQLite 제약 위반(500)으로 나온다.
export const SCORE_LIMIT = Object.freeze({ min: 1, max: 5 });

function toVote(row) {
  if (!row) return null;
  return { user: row.user, value: row.value, at: row.at };
}

// 점수 정규화. 문자열 "3" 도 받는다(쿼리·폼에서 흔한 모양이다). 받지 않는 것은 소수·범위 밖·
// 숫자가 아닌 것이고, 그중 0 은 **특별히 이름을 불러 준다** — "취소하려고 0 을 보냈다"가
// 이 API 에서 가장 그럴듯한 오해라, 그 자리에서 DELETE 를 가리키지 않으면 사람은 0 이
// 저장됐다고 믿거나 왜 거절인지 모른 채 재시도한다.
export function toScore(value) {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (n === 0) {
    throw fail("invalid_score", "0 is not a score — DELETE this path to withdraw your score.");
  }
  if (!Number.isInteger(n) || n < SCORE_LIMIT.min || n > SCORE_LIMIT.max) {
    throw fail("invalid_score", `score must be an integer in ${SCORE_LIMIT.min}..${SCORE_LIMIT.max} (one score per person per post).`);
  }
  return n;
}

export class VoteStore {
  constructor(db) {
    this.db = db;
    ensureSchema(db);
  }

  /**
   * 한 글의 표 전부 — 높은 점수부터, 같으면 먼저 준 순서.
   *
   * **누가 줬는지를 감추지 않는다.** 이름은 내용이 아니라 귀속이고(이력의 toPublicEntry 가
   * 세운 그 선이다), 감추면 자기 글에 스스로 5 를 준 것과 다섯 사람이 준 것이 같아 보인다.
   */
  listFor(memoId) {
    return this.db
      .prepare("SELECT * FROM vote WHERE memo_id = ? ORDER BY value DESC, id")
      .all(memoId)
      .map(toVote);
  }

  // 합계(`score`)·사람 수(`voters`)·내 점수(`myScore`)를 **여기서 세지 않는다.** 그 셋은 메모에
  // 실려 나가는 값이라 `MemoStore` 가 이미 목록·한 건에서 계산하고 있고, 같은 수치의 SQL 을 두
  // 벌 두면 한쪽만 고쳐지는 날 목록과 점수 라우트가 같은 글을 두고 다른 수를 말한다. 이 스토어는
  // 표를 **쓰고 세우는** 일만 한다(관리자 토큰 비교를 core 로 올린 것과 같은 판단이다).

  /**
   * 내 점수를 놓는다. 다시 부르면 **내 행만** 덮인다(UNIQUE(memo_id, user) + upsert) —
   * 남의 표는 어떤 경로로도 건드릴 수 없으므로, 이 last-write-wins 는 본문의 그것과 다르다.
   * 그래서 이 축에는 이력(audit)이 없다: 사라지는 것이 늘 자기 값뿐이다.
   */
  set(memoId, value, user = "") {
    // 라우터가 이미 사람을 확인하지만 불변식은 저장소에 둔다 — 사람 없는 표는 귀속이 없고,
    // 빈 문자열끼리 UNIQUE 에 부딪혀 "누군가의 표"를 덮는다.
    if (!user) throw fail("user_required", "a score belongs to a person — no user was stamped.");
    const score = toScore(value);
    this.db
      .prepare(`
        INSERT INTO vote (memo_id, user, value, at) VALUES (?, ?, ?, ?)
        ON CONFLICT (memo_id, user) DO UPDATE SET value = excluded.value, at = excluded.at`)
      .run(memoId, user, score, new Date().toISOString());
    return toVote(this.db.prepare("SELECT * FROM vote WHERE memo_id = ? AND user = ?").get(memoId, user));
  }

  /**
   * 내 표를 거둔다. 없던 표를 거두는 것은 false — 이미 원하는 상태다(토큰 폐기와 같은 결).
   *
   * 사람이 없으면 아무것도 지우지 않는다. 이 스토어는 `user = ''` 인 행을 만들지 않지만,
   * 이관이나 라우터를 안 거치는 다른 쓰기가 그런 행을 넣을 수는 있다 — 그때 빈 값으로 부른
   * 삭제가 **남의 표를 지우는** 것이 이 가드가 막는 것이다.
   */
  clear(memoId, user = "") {
    if (!user) return false;
    return this.db.prepare("DELETE FROM vote WHERE memo_id = ? AND user = ?").run(memoId, user).changes > 0;
  }
}
