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
//
// 열람은 두 층이다. 내용까지 보는 곳은 관리자 축 하나(GET /api/admin/audit)이고, 사용자는
// 자기가 보던 글에 무슨 일이 있었는지를 사실만으로 본다(GET /api/memos/:id/history) —
// 자기 글이 고쳐졌는데 본인만 모르는 상태를 만들지 않으려는 것이고, 그 경계가 toPublicEntry 다.
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
    team: row.team,
    summary: row.summary,
    // 저장은 문자열이지만 소비자에게는 객체로 준다 — 읽는 쪽이 또 파싱하지 않게.
    before: row.before ? JSON.parse(row.before) : null,
    after: row.after ? JSON.parse(row.after) : null,
  };
}

// 일반 사용자가 볼 수 있는 만큼 — **사실만 남기고 내용은 뺀다.**
//
// 언제·누가·무엇을 했는가는 당사자가 알아야 한다(자기 글이 고쳐졌는데 본인만 모르는 상태를
// 만들지 않는다). 반대로 `before`/`after` 와 `summary` 는 덮인 본문과 지워진 제목을 품고 있어
// 여기 실을 수 없다 — 그걸 실으면 "관리자 전용"이 이름뿐이 된다.
//
// 이름(누가 썼던 글인가)은 내용이 아니라 귀속이라 남긴다. 바뀐 칸 이름도 마찬가지다:
// "본문이 바뀌었다"는 사실이고, 바뀐 본문이 내용이다.
export function toPublicEntry(entry) {
  const base = {
    id: entry.id, at: entry.at, actor: entry.actor, action: entry.action, memoId: entry.memoId,
  };
  if (entry.action === "memo_update") {
    return { ...base, fields: Object.keys(entry.after || {}) };
  }
  if (entry.action === "memo_delete") {
    return {
      ...base,
      memoOwner: entry.before?.memo?.user ?? "",
      commentsRemoved: (entry.before?.comments || []).length,
    };
  }
  if (entry.action === "comment_delete") {
    return { ...base, commentId: entry.commentId, commentAuthor: entry.before?.user ?? "" };
  }
  return base;
}

export class AuditStore {
  constructor(db) {
    this.db = db;
    ensureSchema(db);
  }

  record({ action, actor = "", memoId = null, commentId = null, team = "team-n", summary = "", before = null, after = null }) {
    this.db
      .prepare("INSERT INTO audit (at, actor, action, memo_id, comment_id, team, summary, before, after) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        new Date().toISOString(), actor, action, memoId, commentId, team, summary,
        before === null ? "" : JSON.stringify(before),
        after === null ? "" : JSON.stringify(after),
      );
  }

  /**
   * 한 메모의 이력, 사용자에게 보이는 만큼(내용 없이). **메모가 이미 지워졌어도 답한다** —
   * "그 메모 어디 갔나"가 이 축이 존재하는 이유라, 여기서 404 를 내면 물어볼 곳이 없어진다.
   */
  // teams 는 보는 사람의 가시 팀이다(null = 전부). **줄 단위로** 거른다 — 글이 팀을 옮겨
  // 다녔으면 각 사건은 그 사건이 일어난 팀의 구성원에게만 보인다. 메모가 지워진 뒤에는
  // 이 필터가 유일한 문이다(메모 행이 없어 팀을 물어볼 곳이 이력뿐이다).
  historyFor(memoId, { limit = AUDIT_LIMIT.default, offset = 0, teams = null } = {}) {
    const { total, entries } = this.list({ memoId, limit, offset, teams });
    return { total, history: entries.map(toPublicEntry) };
  }

  /** 최신순. `total` 을 같이 주므로 잘렸는지는 소비자가 안다(보드 목록과 같은 규약). */
  list({ memoId = null, action = "", actor = "", limit = AUDIT_LIMIT.default, offset = 0, teams = null } = {}) {
    const where = [];
    const params = [];
    if (memoId !== null) { where.push("memo_id = ?"); params.push(memoId); }
    if (teams !== null) {
      if (teams.length === 0) where.push("1 = 0");
      else { where.push(`team IN (${teams.map(() => "?").join(", ")})`); params.push(...teams); }
    }
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
