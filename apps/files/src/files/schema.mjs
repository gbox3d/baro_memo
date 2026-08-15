// 아티팩트 저장소의 스키마 — 업로드 세션과 완성본.
//
// **바이트는 여기 없다.** 이 DB 는 장부다: 진행 중인 세션이 어느 구간을 받았고, 완성본이
// 어떤 해시로 어디 있는가. 바이트는 FILES_ROOT/{tmp,store} 의 파일이고, 다운로드는 nginx 가
// 디스크에서 직접 서빙한다 — 이 프로세스는 다운로드 바이트를 만지지 않는다.
//
// upload.id 는 **서버가 발급한다.** DWarf 는 클라이언트가 upload-id 를 고르는데, 그건 신뢰되는
// LAN 의 단일 사용자 가정이다. WAN 멀티테넌트에서는 남의 세션 id 를 추측해 청크를 꽂는 길이
// 된다 — 서버 발급 난수 id 에 소유자를 묶으면 그 길 자체가 없다.
const TABLES = `
  CREATE TABLE IF NOT EXISTS upload (
    id            TEXT PRIMARY KEY,
    user          TEXT NOT NULL,
    name          TEXT NOT NULL,
    size          INTEGER NOT NULL,
    sha256        TEXT NOT NULL,             -- 클라이언트가 선언한 기대값. finalize 가 검증한다
    state         TEXT NOT NULL DEFAULT 'open',  -- open · finalizing
    created_at    TEXT NOT NULL,
    last_activity TEXT NOT NULL              -- 청크가 올 때마다 갱신 — 유령 세션 GC 의 기준
  );

  -- 받은 구간. [start, end) 반개구간. 겹치면 스토어가 병합해 두므로 행 수는 "구멍 수 + 1" 을
  -- 넘지 않는다 — 재전송이 행을 늘리지 않는다.
  CREATE TABLE IF NOT EXISTS upload_range (
    upload_id TEXT NOT NULL REFERENCES upload(id) ON DELETE CASCADE,
    start     INTEGER NOT NULL,
    end       INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS range_by_upload ON upload_range(upload_id, start);

  -- 완성본. 정체가 곧 내용이다 — sha256 이 키이고, 같은 바이트를 두 번 발행하면 두 번째는
  -- 기존 행을 돌려받는다(전량을 다시 올린 뒤에야 — 해시만 대고 바이트를 건너뛰는 경로는
  -- 만들지 않는다. 그건 해시를 내용 존재 오라클로 바꾼다).
  CREATE TABLE IF NOT EXISTS artifact (
    sha256     TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    size       INTEGER NOT NULL,
    user       TEXT NOT NULL,                -- 발행자. 토큰에서 역산된 값만 들어온다
    created_at TEXT NOT NULL
  );
`;

export function ensureSchema(db) {
  db.exec(TABLES);
}
