// 보드의 스키마 — memo·comment·vote·audit 과 앞의 둘에 걸리는 전문 검색 색인.
//
// **한 곳에서 세우는 이유**: 목록이 메모마다 `commentCount` 와 `score` 를 싣고 검색이 댓글
// 색인까지 훑는다. 즉 memo 축의 질의가 comment·vote 테이블 없이는 돌지 않는다. 스토어마다
// 자기 테이블만 만들게 두면 "MemoStore 만 만든 코드"가 no such table 로 죽는다.
//
// AUTOINCREMENT: 삭제된 id 를 재사용하지 않는다. 재사용하면 "3번 메모"라고 적어 둔 외부
// 기록이 어느 날 다른 메모를 가리킨다. 댓글도 같다 — 댓글 id 로 지우는 경로가 있다.
const TABLES = `
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

  -- 댓글은 메모 본문에 이어 붙이지 않는다. 본문은 그 메모의 진술이고 댓글은 남의 말이라,
  -- 섞으면 누가 무엇을 썼는지 되물을 수 없다(그 추적이 이 서비스가 분리된 이유다).
  -- 수정은 없다(append-only) — 남의 글이 조용히 바뀌면 인용이 무의미해진다.
  CREATE TABLE IF NOT EXISTS comment (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    memo_id    INTEGER NOT NULL REFERENCES memo(id) ON DELETE CASCADE,
    body       TEXT NOT NULL,
    author     TEXT NOT NULL DEFAULT '',
    user       TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS comment_by_memo ON comment(memo_id, id);

  -- 중요도. 한 사람이 한 글에 1~5 점을 준다.
  --
  -- **카운터 한 칸이 아니라 행이다.** memo.score 를 숫자로 들고 +1 하면 세 가지를 잃는다:
  -- "내가 이미 줬나"에 답할 수 없고(그래서 같은 세션이 재시작마다 또 준다), 1인당 상한을
  -- 스키마가 못 지키고, 5점이 한 사람의 확신인지 다섯 사람의 합의인지 구분이 사라진다.
  -- UNIQUE(memo_id, user) 가 "한 사람 한 표"를 저장소 수준에서 못 박는다 — 다시 주면 자기
  -- 행이 덮이고, 덮이는 것은 언제나 자기 것뿐이다(그래서 이 last-write-wins 는 안전하다).
  --
  -- author(세션)를 두지 않는다. 표는 사람의 것이고, 같은 사람의 두 세션이 두 표가 되면
  -- 그 순간 이 수치는 "몇 명이 중요하다고 했나"가 아니라 "몇 번 눌렸나"가 된다.
  --
  -- CHECK 는 상한을 DB 에도 박는다. **주의**: 이미 만들어진 DB 의 CHECK 는 코드를 고쳐도
  -- 바뀌지 않는다. vote-store.mjs 의 SCORE_LIMIT 을 넓히려면 테이블을 다시 세워야 한다.
  CREATE TABLE IF NOT EXISTS vote (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    memo_id INTEGER NOT NULL REFERENCES memo(id) ON DELETE CASCADE,
    user    TEXT NOT NULL,
    value   INTEGER NOT NULL CHECK (value BETWEEN 1 AND 5),
    at      TEXT NOT NULL,
    UNIQUE (memo_id, user)
  );

  -- 삭제·수정 이력. 사라지거나 덮인 값을 여기 남긴다 — 보드는 여러 세션이 남의 글을 고치고
  -- 지우는 곳이고, "누가 언제 무엇을 지웠나"는 사후에만 물어보게 된다.
  --
  -- **memo_id 에 외래키를 걸지 않는다.** 걸면 메모가 지워질 때 그 삭제 기록이 같이 지워진다 —
  -- 가장 필요한 순간에 없어지는 기록이 된다. 그래서 id 는 숫자로만 들고 있는다.
  -- 색인(FTS)에도 넣지 않는다: 지운 내용이 일반 검색(?q=)으로 되살아나면 지운 것이 아니다.
  -- (이 문자열은 템플릿 리터럴이다 — 주석에도 역따옴표를 쓰지 말 것. 문자열이 거기서 끝난다.)
  CREATE TABLE IF NOT EXISTS audit (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    at         TEXT NOT NULL,
    actor      TEXT NOT NULL DEFAULT '',   -- 토큰에서 역산한 사람. 빈 값이면 스크립트·이관
    action     TEXT NOT NULL,              -- memo_update · memo_delete · comment_delete
    memo_id    INTEGER,
    comment_id INTEGER,
    summary    TEXT NOT NULL DEFAULT '',   -- 사람이 읽는 한 줄 (무엇이 바뀌었나)
    before     TEXT NOT NULL DEFAULT '',   -- JSON: 사라지거나 덮인 값
    after      TEXT NOT NULL DEFAULT ''    -- JSON: 새 값 (수정일 때만)
  );
  CREATE INDEX IF NOT EXISTS audit_by_memo ON audit(memo_id, id);
`;

// 전문 검색. 이 보드는 프로젝트를 가로질러 읽히는 물건이라, 찾는 쪽은 저장소도 제목도 모르고
// **증상 문자열**(`X-Forwarded-Prefix`, `no_tokens_issued`) 하나만 안다.
//
//   content='...'   : 본문을 복사하지 않는다. 색인만 갖고 텍스트는 원본 테이블을 참조한다 —
//                     복사하면 정본이 두 벌이 되고, 어느 쪽이 진짜인가가 생긴다.
//   tokenize=trigram: 3글자 창을 색인한다. `memo_store.mjs` 같은 식별자를 부분으로 잡고 한글도
//                     걸린다. 값은 색인 크기와 순위의 무딤, 그리고 3글자 하한이다.
//
// 외부 콘텐츠 색인은 자동으로 따라오지 않는다 — 테이블마다 트리거 셋이 동기화의 전부이고,
// 하나가 빠지면 색인이 조용히 어긋난다. 증상은 "왜 이 글이 안 잡히지"로 몇 주 뒤에 나온다.
const MEMO_FTS = `
  CREATE VIRTUAL TABLE memo_fts USING fts5(
    title, body, content='memo', content_rowid='id', tokenize='trigram'
  );
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

// 댓글에도 색인을 다는 이유: 답은 본문이 아니라 댓글에 쌓인다. 검색에 안 걸리는 답은
// 이 보드에서는 없는 답이다("찾는 수단은 분류가 아니라 검색"이 이 서비스의 전제다).
// UPDATE 트리거도 둔다 — 지금은 수정 경로가 없지만, 생기는 날 색인만 조용히 뒤처진다.
const COMMENT_FTS = `
  CREATE VIRTUAL TABLE comment_fts USING fts5(
    body, content='comment', content_rowid='id', tokenize='trigram'
  );
  CREATE TRIGGER IF NOT EXISTS comment_fts_ai AFTER INSERT ON comment BEGIN
    INSERT INTO comment_fts(rowid, body) VALUES (new.id, new.body);
  END;
  CREATE TRIGGER IF NOT EXISTS comment_fts_ad AFTER DELETE ON comment BEGIN
    INSERT INTO comment_fts(comment_fts, rowid, body) VALUES ('delete', old.id, old.body);
  END;
  CREATE TRIGGER IF NOT EXISTS comment_fts_au AFTER UPDATE ON comment BEGIN
    INSERT INTO comment_fts(comment_fts, rowid, body) VALUES ('delete', old.id, old.body);
    INSERT INTO comment_fts(rowid, body) VALUES (new.id, new.body);
  END;
`;

// 색인은 **없을 때만** 세우고 그때 기존 행을 한 번에 채운다('rebuild'). 매 기동 rebuild 는
// 보드가 커진 뒤 아무도 안 보는 곳에서 느려지는 비용이다. 이미 쌓인 DB 에 댓글 색인을
// 얹는 경로가 이 분기다 — 0.4.0 로 올라가는 운영 DB 가 정확히 그 경우다.
function ensureIndex(db, name, ddl) {
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(name)) return;
  db.exec(ddl);
  db.exec(`INSERT INTO ${name}(${name}) VALUES ('rebuild')`);
}

/** 두 스토어 어느 쪽을 만들어도 같은 스키마가 선다. 여러 번 불러도 안전하다. */
export function ensureSchema(db) {
  db.exec(TABLES);
  ensureIndex(db, "memo_fts", MEMO_FTS);
  ensureIndex(db, "comment_fts", COMMENT_FTS);
}
