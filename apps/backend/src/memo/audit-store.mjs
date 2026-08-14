// 삭제·수정 이력.
//
// 이 보드는 여러 세션이 남의 글을 고치고 지우는 곳이다. `PATCH` 의 body 는 last-write-wins 이고
// `DELETE` 는 되돌릴 수 없으므로, 사라진 값이 어디에도 없으면 "그 문단 어디 갔나"에 답할 수 없다.
//
// 원칙 셋:
//   1. **기록은 스토어 안에서** 남는다. 라우터나 소비자가 부르는 구조면 언젠가 한 경로가 빠지고,
//      추적은 그 순간부터 거짓말이 된다.
//   2. **추가만 한다.** 이력을 고치는 경로는 만들지 않는다 — 고칠 수 있는 이력은 이력이 아니다.
//   3. **일반 검색에 넣지 않는다.** 지운 내용이 `?q=` 로 되살아나면 지운 것이 아니다.
//      열람은 관리자 축(GET /api/admin/audit) 하나뿐이다.
import { ensureSchema } from "./schema.mjs";

export const AUDIT_ACTIONS = Object.freeze(["memo_update", "memo_delete", "comment_delete"]);

// 한 쪽에 실어 주는 기본값. 이력은 전문을 들고 있어 목록이 무거워지기 쉽다.
export const AUDIT_LIMIT = Object.freeze({ default: 50, max: 200 });

function toEntry(row) {
  if (!row) return null;
  return {
    id: row.id,
    at: row.at,
    actor: row.actor,
    action: row.action,
    memoId: row.memo_id,
    commentId: row.comment_id,
    summary: row.summary,
    // 저장은 문자열이지만 소비자에게는 객체로 준다 — 읽는 쪽이 또 파싱하지 않게.
    before: row.before ? JSON.parse(row.before) : null,
    after: row.after ? JSON.parse(row.after) : null,
  };
}

export class AuditStore {
  constructor(db) {
    this.db = db;
    ensureSchema(db);
  }

  record({ action, actor = "", memoId = null, commentId = null, summary = "", before = null, after = null }) {
    this.db
      .prepare("INSERT INTO audit (at, actor, action, memo_id, comment_id, summary, before, after) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        new Date().toISOString(), actor, action, memoId, commentId, summary,
        before === null ? "" : JSON.stringify(before),
        after === null ? "" : JSON.stringify(after),
      );
  }

  /** 최신순. `total` 을 같이 주므로 잘렸는지는 소비자가 안다(보드 목록과 같은 규약). */
  list({ memoId = null, action = "", actor = "", limit = AUDIT_LIMIT.default, offset = 0 } = {}) {
    const where = [];
    const params = [];
    if (memoId !== null) { where.push("memo_id = ?"); params.push(memoId); }
    if (action) { where.push("action = ?"); params.push(action); }
    if (actor) { where.push("actor = ?"); params.push(actor); }
    const clause = where.length ? ` WHERE ${where.join(" AND ")}` : "";

    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM audit${clause}`).get(...params).n;
    const rows = this.db
      .prepare(`SELECT * FROM audit${clause} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset);
    return { total, entries: rows.map(toEntry) };
  }
}
