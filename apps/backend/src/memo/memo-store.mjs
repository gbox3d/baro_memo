// 메모 저장소 — baro_calrory 의 memo 축(2026-08)을 독립 서비스로 떼어낸 것.
//
// 원본과의 차이는 **작성자 추적** 하나다. 원본은 공유 토큰 하나라 author 가 자기 신고였는데,
// 여기는 사용자별 토큰이라 서버가 토큰에서 사용자를 역산해 찍는다:
//   - `user`       : 만든 사람. 생성 시각에 토큰에서 찍히고 그 뒤로 불변이다.
//   - `updatedBy`  : 마지막으로 고친 사람. PATCH 마다 토큰에서 다시 찍힌다.
//   - `author`     : 세션 자기명명(`claude/height-axis` 같은 것). 자유기입 그대로 둔다 —
//                    한 사용자의 토큰으로 여러 세션이 돌 때 이 칸이 세션을 가른다.
// 셋 다 역할이 달라서 어느 하나로 합치면 나머지 둘의 질문에 답할 수 없다.
//
// 부분 갱신(상태만 done)이 잦은 데이터라 JSON 파일 통째 재작성이 아니라 SQLite 다 — 겹치는
// 두 갱신에서 뒤엣것이 앞엣것을 통째로 지우는 사고를 스키마 수준에서 없앤다(원본의 결정).
export const MEMO_STATUSES = Object.freeze(["open", "doing", "done"]);

// AUTOINCREMENT: 삭제된 id 를 재사용하지 않는다. 재사용하면 "3번 메모"라고 적어 둔 외부
// 기록이 어느 날 다른 메모를 가리킨다.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS memo (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT NOT NULL DEFAULT '',
    body       TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'open',
    author     TEXT NOT NULL DEFAULT '',
    user       TEXT NOT NULL DEFAULT '',
    updated_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

// 길이 상한. 토큰 뒤에 있어도 **토큰을 아는 사람의 실수**(로그 한 뭉치 붙여넣기)는 못 막는다.
const LIMITS = Object.freeze({ title: 200, body: 20000, author: 100, status: 100 });

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

// 문자열 필드 정규화 — 트림 + 상한. 숫자·객체는 문자열로 뭉개지 않고 거절한다:
// body 에 객체가 들어오면 "[object Object]" 가 저장되고 그건 조용한 데이터 손실이다.
function text(value, field) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw fail("invalid_field", `${field} must be a string.`);
  const s = value.trim();
  if (s.length > LIMITS[field]) throw fail("too_long", `${field} exceeds the cap (${LIMITS[field]} chars).`);
  return s;
}

function status(value) {
  const s = text(value, "status") || "open";
  if (!MEMO_STATUSES.includes(s)) {
    throw fail("invalid_status", `status must be one of ${MEMO_STATUSES.join(" · ")}.`);
  }
  return s;
}

// URL 조각을 id 로. 라우터가 `/api/memos/<무엇이든>` 을 받으므로 여기서 한 번에 거른다.
export function toMemoId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function toMemo(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    status: row.status,
    author: row.author,
    user: row.user,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class MemoStore {
  constructor(db) {
    this.db = db;
    this.db.exec(SCHEMA);
  }

  list() {
    // 최신순. 정렬 키가 created_at 이 아니라 id 인 이유: 같은 초의 두 건은 시각으로 순서가 안 선다.
    return this.db.prepare("SELECT * FROM memo ORDER BY id DESC").all().map(toMemo);
  }

  get(id) {
    return toMemo(this.db.prepare("SELECT * FROM memo WHERE id = ?").get(id));
  }

  counts() {
    const rows = this.db.prepare("SELECT status, COUNT(*) AS n FROM memo GROUP BY status").all();
    const by = Object.fromEntries(MEMO_STATUSES.map((s) => [s, 0]));
    for (const r of rows) if (r.status in by) by[r.status] = r.n;
    return { total: Object.values(by).reduce((a, b) => a + b, 0), ...by };
  }

  // user 는 본문이 아니라 두 번째 인자다 — 라우터가 토큰에서 역산한 값만 들어온다.
  create(input = {}, user = "") {
    const body = text(input.body, "body");
    if (!body) throw fail("empty_body", "body cannot be empty.");
    const now = new Date().toISOString();
    const { lastInsertRowid } = this.db
      .prepare("INSERT INTO memo (title, body, status, author, user, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(text(input.title, "title"), body, status(input.status), text(input.author, "author"), user, user, now, now);
    return this.get(Number(lastInsertRowid));
  }

  // 부분 갱신. 보내지 않은 필드는 건드리지 않는다. updated_by 는 매번 토큰의 사용자로 찍힌다.
  update(id, patch = {}, user = "") {
    if (!this.get(id)) return null;
    const sets = [];
    const values = [];
    if (patch.title !== undefined) { sets.push("title = ?"); values.push(text(patch.title, "title")); }
    if (patch.body !== undefined) {
      const body = text(patch.body, "body");
      if (!body) throw fail("empty_body", "body cannot be empty.");
      sets.push("body = ?"); values.push(body);
    }
    if (patch.status !== undefined) { sets.push("status = ?"); values.push(status(patch.status)); }
    if (patch.author !== undefined) { sets.push("author = ?"); values.push(text(patch.author, "author")); }
    // 빈 PATCH 를 200 으로 돌려주면 소비자는 자기 오타(tilte)를 성공으로 읽는다.
    if (sets.length === 0) throw fail("no_fields", "nothing recognisable to update.");
    sets.push("updated_by = ?", "updated_at = ?");
    values.push(user, new Date().toISOString(), id);
    this.db.prepare(`UPDATE memo SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    return this.get(id);
  }

  remove(id) {
    return this.db.prepare("DELETE FROM memo WHERE id = ?").run(id).changes > 0;
  }
}
