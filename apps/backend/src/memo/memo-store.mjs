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
import { fail, text, toId } from "./fields.mjs";
import { ensureSchema } from "./schema.mjs";

export const MEMO_STATUSES = Object.freeze(["open", "doing", "done"]);

// 스키마(memo·comment 와 두 색인)는 schema.mjs 가 정본이다 — 목록의 commentCount 와 검색이
// 두 테이블에 걸쳐 있어, 한쪽만 세우면 이 파일의 질의가 no such table 로 죽는다.

// trigram 의 하한. 이보다 짧은 질의는 색인에 대응하는 항목 자체가 없다.
export const SEARCH_MIN_CHARS = 3;

// 목록의 기본은 **요약**이다. 이 보드는 모든 세션이 작업 시작 전에 한 번씩 읽는 표면이라,
// 전문을 기본값으로 실으면 게시물 수에 비례해 모든 세션의 토큰이 새어 나간다(4건에 9.5KB
// 였다). 앞 200자면 "이게 내가 찾던 건가"는 판정된다 — 전문은 id 로 한 건만 가져간다.
export const PREVIEW_CHARS = 200;
// 기본 상한이 없으면 "언젠가 느려지는" 라우트가 된다. total 을 늘 함께 주므로 잘렸는지는
// 소비자가 안다 — 조용한 절단이 아니다.
export const LIST_LIMIT = Object.freeze({ default: 50, max: 200 });

function status(value) {
  const s = text(value, "status") || "open";
  if (!MEMO_STATUSES.includes(s)) {
    throw fail("invalid_status", `status must be one of ${MEMO_STATUSES.join(" · ")}.`);
  }
  return s;
}

// URL 조각을 id 로. 라우터가 `/api/memos/<무엇이든>` 을 받으므로 여기서 한 번에 거른다.
export const toMemoId = toId;

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
    // 댓글은 **개수만** 싣는다. 목록이든 한 건이든, 댓글 본문은 그 메모의 댓글 경로로 받는다 —
    // 목록에 전문을 싣지 않는 것과 같은 이유이고, 한 건에서도 대화가 길어지면 같은 세금이 된다.
    commentCount: row.comment_count ?? 0,
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
    commentCount: row.comment_count ?? 0,
  };
}

// 메모마다 붙는 댓글 수. 상관 서브쿼리 한 줄이면 되는 규모다(보드는 수천 건 단위이고
// comment_by_memo 색인이 있다). 목록에서 이 값을 빼면 "댓글이 있는지" 를 알려고 게시물마다
// 한 번씩 더 부르게 되고, 그게 정확히 목록을 요약 색인으로 만든 이유의 반대다.
const COMMENT_COUNT = "(SELECT COUNT(*) FROM comment WHERE comment.memo_id = memo.id) AS comment_count";

// 검색 적중 한 벌. 두 색인(메모 제목·본문 / 댓글 본문)의 적중을 합치고, 메모마다 관련도가
// 가장 좋은 한 줄만 남긴다(ROW_NUMBER). 한 메모가 본문과 댓글 양쪽에서 걸리면 결과가 두
// 줄이 되는데, 목록의 소비자에게 그건 같은 메모가 두 번 나오는 것으로 보인다.
//
// bm25 값은 테이블이 다르면 엄밀히 비교 가능한 수치가 아니다. 그래도 순서를 정하는 데는 쓸
// 만하고, 대안(한쪽을 늘 앞에 두기)은 "답이 댓글에만 있는 메모"를 구조적으로 뒤로 민다.
const HIT_SOURCE = `(
  SELECT memo_id, rank, snippet, matched_in,
         ROW_NUMBER() OVER (PARTITION BY memo_id ORDER BY rank) AS rn
  FROM (
    SELECT memo_fts.rowid AS memo_id, bm25(memo_fts) AS rank,
           snippet(memo_fts, 1, '[', ']', '…', 12) AS snippet, 'memo' AS matched_in
    FROM memo_fts WHERE memo_fts MATCH ?
    UNION ALL
    SELECT comment.memo_id AS memo_id, bm25(comment_fts) AS rank,
           snippet(comment_fts, 0, '[', ']', '…', 12) AS snippet, 'comment' AS matched_in
    FROM comment_fts JOIN comment ON comment.id = comment_fts.rowid
    WHERE comment_fts MATCH ?
  )
)`;

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
    ensureSchema(db);
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

    // q 가 있으면 두 색인(메모·댓글)의 적중을 합쳐 메모에 붙인다. 칼럼은 전부 memo. 로 못
    // 박는다 — 안 그러면 ambiguous 로 죽거나, 더 나쁘게는 색인 사본을 읽는다.
    const from = q ? `${HIT_SOURCE} hit JOIN memo ON memo.id = hit.memo_id` : "memo";
    const where = [];
    const params = [];
    // 한 메모가 본문과 댓글 양쪽에서 걸리면 두 줄이 된다. 관련도가 좋은 쪽 한 줄만 남긴다.
    if (q) { where.push("hit.rn = 1"); params.push(toMatchQuery(q), toMatchQuery(q)); }
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
      SELECT ${columns}, ${COMMENT_COUNT}${q ? ", hit.snippet AS snippet, hit.matched_in AS matched_in" : ""}
      FROM ${from}${clause}
      ORDER BY ${q ? "hit.rank, memo.id DESC" : "memo.id DESC"}
      LIMIT ? OFFSET ?`).all(...params, limit, offset);

    return {
      total,
      memos: rows.map((row) => {
        const memo = full ? toMemo(row) : toSummary(row);
        if (row.snippet !== undefined) memo.snippet = row.snippet;
        // 어디서 맞았는지 말해 준다. 본문에 없는 낱말로 걸린 메모를 받으면 소비자는 검색이
        // 고장 난 줄 안다 — 답이 댓글에 있다는 것이 이 필드가 전하는 사실이다.
        if (row.matched_in !== undefined) memo.matchedIn = row.matched_in;
        return memo;
      }),
    };
  }

  get(id) {
    return toMemo(this.db.prepare(`SELECT memo.*, ${COMMENT_COUNT} FROM memo WHERE id = ?`).get(id));
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
