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

// 전문 검색. 이 보드는 프로젝트를 가로질러 읽히는 물건이라, 찾는 쪽은 저장소도 제목도 모르고
// **증상 문자열**(`X-Forwarded-Prefix`, `no_tokens_issued`) 하나만 안다. 제목 검색으로는 못 잡는다.
//
//   content='memo'  : 본문을 복사하지 않는다. FTS5 는 색인만 갖고 텍스트는 memo 를 참조한다 —
//                     복사하면 20000자짜리 정본이 두 벌이 되고, 어느 쪽이 진짜인가가 생긴다.
//   tokenize=trigram: 3글자 창을 색인한다. `memo_store.mjs` 같은 식별자를 부분으로 잡고 한글도
//                     걸린다. 값은 색인 크기와 순위의 무딤 — 못 찾는 것보다 낫다는 판단이다.
//                     대신 **3글자 미만 질의는 원리적으로 불가능**하다(toMatchQuery 가 거절한다).
const FTS_SCHEMA = `
  CREATE VIRTUAL TABLE memo_fts USING fts5(
    title, body, content='memo', content_rowid='id', tokenize='trigram'
  );
  -- 외부 콘텐츠 색인은 자동으로 따라오지 않는다. 세 트리거가 동기화의 전부다.
  CREATE TRIGGER IF NOT EXISTS memo_fts_ai AFTER INSERT ON memo BEGIN
    INSERT INTO memo_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
  END;
  CREATE TRIGGER IF NOT EXISTS memo_fts_ad AFTER DELETE ON memo BEGIN
    INSERT INTO memo_fts(memo_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
  END;
  CREATE TRIGGER IF NOT EXISTS memo_fts_au AFTER UPDATE ON memo BEGIN
    INSERT INTO memo_fts(memo_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
    INSERT INTO memo_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
  END;
`;

// trigram 의 하한. 이보다 짧은 질의는 색인에 대응하는 항목 자체가 없다.
export const SEARCH_MIN_CHARS = 3;

// 길이 상한. 토큰 뒤에 있어도 **토큰을 아는 사람의 실수**(로그 한 뭉치 붙여넣기)는 못 막는다.
const LIMITS = Object.freeze({ title: 200, body: 20000, author: 100, status: 100 });

// 목록의 기본은 **요약**이다. 이 보드는 모든 세션이 작업 시작 전에 한 번씩 읽는 표면이라,
// 전문을 기본값으로 실으면 게시물 수에 비례해 모든 세션의 토큰이 새어 나간다(4건에 9.5KB
// 였다). 앞 200자면 "이게 내가 찾던 건가"는 판정된다 — 전문은 id 로 한 건만 가져간다.
export const PREVIEW_CHARS = 200;
// 기본 상한이 없으면 "언젠가 느려지는" 라우트가 된다. total 을 늘 함께 주므로 잘렸는지는
// 소비자가 안다 — 조용한 절단이 아니다.
export const LIST_LIMIT = Object.freeze({ default: 50, max: 200 });

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

// 목록 항목. `body` 를 빈 문자열로 두지 않고 **아예 빼는** 이유: 빈 문자열이면 소비자는
// "본문 없는 메모"로 읽는다. 없는 칸은 없어야 물어보러 온다.
function toSummary(row) {
  return {
    id: row.id,
    title: row.title,
    bodyPreview: row.body_preview,
    bodyLength: row.body_length,
    status: row.status,
    author: row.author,
    user: row.user,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// LIKE 의 와일드카드를 사용자 입력에서 무력화한다. 안 하면 `?author=%` 한 글자가 전체 일치가
// 되고, 밑줄이 든 값을 찾는 사람은 엉뚱한 것까지 받는다. SQL 은 ESCAPE 로 받는다.
function likeContains(value) {
  return `%${String(value).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

// 사용자 문자열 → FTS5 MATCH 식.
//
// 날것을 그대로 넘기면 안 된다. `C++` 은 syntax error, `a-b` 는 "no such column: b" 다 —
// 검색어 하나가 500 이 되고, 운 나쁘면 `title:` 같은 걸로 질의 의미가 바뀐다. 그래서 각 낱말을
// **인용 구절**로 감싼다(내부 `"` 는 겹따옴표로 이스케이프). 낱말 사이는 FTS5 의 암묵 AND 라
// `q=nginx prefix` 는 "둘 다 든 메모"가 된다 — 검색창의 상식과 같다.
export function toMatchQuery(value) {
  const terms = String(value).split(/\s+/).filter(Boolean);
  for (const t of terms) {
    // 짧은 낱말을 조용히 버리면 `?q=UI` 가 "결과 없음"으로 와서 없는 것과 구분이 안 된다.
    if (t.length < SEARCH_MIN_CHARS) {
      throw fail("query_too_short", `Search term "${t}" is shorter than ${SEARCH_MIN_CHARS} characters.`);
    }
  }
  return terms.map((t) => `"${t.replaceAll('"', '""')}"`).join(" ");
}

export class MemoStore {
  constructor(db) {
    this.db = db;
    this.db.exec(SCHEMA);
    // 색인이 없을 때만 세우고 기존 행을 한 번에 채운다('rebuild'). 매 기동마다 rebuild 하면
    // 보드가 커진 뒤 시작이 느려지고, 그건 아무도 안 보는 곳에서 느려지는 종류의 비용이다.
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'memo_fts'").get()) {
      this.db.exec(FTS_SCHEMA);
      this.db.exec("INSERT INTO memo_fts(memo_fts) VALUES ('rebuild')");
    }
  }

  // 목록 — 걸러서, 잘라서, 요약으로. 인자는 라우터가 쿼리스트링에서 검증해 넘긴 것만 들어온다.
  //
  // `total` 은 필터를 적용한 뒤, limit 을 적용하기 전의 개수다. 이 값이 없으면 소비자는 20건을
  // 받고 그것이 전부인지 첫 장인지 구분할 수 없다.
  //
  // `q` 는 제목과 본문 **양쪽**을 FTS5 로 본다. 걸리면 결과에 `snippet` 이 붙는다 — 왜 맞았는지
  // 를 전문 없이 보여 주는 한 줄이고, 이 보드에서는 그게 판정 근거다.
  list(options = {}) {
    const {
      status = null, q = "", author = "", user = "",
      full = false, limit = LIST_LIMIT.default, offset = 0,
    } = options;

    // q 가 있으면 색인과 조인한다. 이때 title/body 가 양쪽 테이블에 다 있으므로 칼럼은 전부
    // memo. 로 못 박는다 — 안 그러면 ambiguous 로 죽거나, 더 나쁘게는 색인 사본을 읽는다.
    const from = q ? "memo_fts JOIN memo ON memo.id = memo_fts.rowid" : "memo";
    const where = [];
    const params = [];
    if (q) { where.push("memo_fts MATCH ?"); params.push(toMatchQuery(q)); }
    if (status && status.length) {
      where.push(`memo.status IN (${status.map(() => "?").join(", ")})`);
      params.push(...status);
    }
    if (author) { where.push("memo.author LIKE ? ESCAPE '\\'"); params.push(likeContains(author)); }
    // user 는 서버가 토큰에서 찍은 값이라 부분 일치가 아니라 정확 일치다 — "kim" 이 "kimura" 를
    // 끌고 오면 귀속이 무너진다.
    if (user) { where.push("memo.user = ?"); params.push(user); }
    const clause = where.length ? ` WHERE ${where.join(" AND ")}` : "";

    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM ${from}${clause}`).get(...params).n;
    // 요약일 때는 body 를 SELECT 하지 않는다. 20000자를 읽어다 버리면 아낀 것은 대역폭뿐이다.
    const columns = full ? "memo.*" : `
      memo.id, memo.title, memo.status, memo.author, memo.user, memo.updated_by,
      memo.created_at, memo.updated_at,
      substr(memo.body, 1, ${PREVIEW_CHARS}) AS body_preview, length(memo.body) AS body_length`;
    // 검색은 관련도순(bm25 는 음수이고 작을수록 좋다), 그냥 목록은 최신순. 정렬 키가 created_at
    // 이 아니라 id 인 이유: 같은 초의 두 건은 시각으로 순서가 안 선다.
    const rows = this.db.prepare(`
      SELECT ${columns}${q ? `, snippet(memo_fts, 1, '[', ']', '…', 12) AS snippet` : ""}
      FROM ${from}${clause}
      ORDER BY ${q ? "bm25(memo_fts), memo.id DESC" : "memo.id DESC"}
      LIMIT ? OFFSET ?`).all(...params, limit, offset);

    return {
      total,
      memos: rows.map((row) => {
        const memo = full ? toMemo(row) : toSummary(row);
        if (row.snippet !== undefined) memo.snippet = row.snippet;
        return memo;
      }),
    };
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
