// 사용자별 쓰기 토큰 — 이 서비스가 baro_calrory 의 memo 축과 갈라선 지점이다.
//
// 원본은 config.json 의 공유 토큰 하나였고, 그래서 author 가 자기 신고였다. 여기서는 관리자가
// 사용자마다 토큰을 발급하고, 쓰기 요청의 토큰에서 사용자를 역산한다 — 메모의 `user` 는
// 사칭할 수 없는 값이 된다.
//
// 폐기는 소프트다(revoked_at 만 찍는다). 행을 지우면 "이 메모를 쓴 사용자의 토큰이 언제
// 발급되고 언제 죽었나"라는 추적 질문에 답할 수 없게 된다 — 추적이 이 저장소의 존재 이유다.
//
// 토큰은 평문으로 둔다. 해시하면 관리자 페이지에서 재조회가 안 되는데, 이 툴의 소비자는
// "토큰을 나중에 사용자에게 다시 전달하는 관리자"다. DB 파일은 백엔드 호스트 밖으로 나가지
// 않는다(.gitignore 의 localfiles/).
import { randomBytes, timingSafeEqual } from "node:crypto";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS token (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    token      TEXT NOT NULL UNIQUE,
    user       TEXT NOT NULL,
    note       TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    revoked_at TEXT
  );
`;

const LIMITS = Object.freeze({ user: 100, note: 200 });

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

function text(value, field) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw fail("invalid_field", `${field} must be a string.`);
  const s = value.trim();
  if (s.length > LIMITS[field]) throw fail("too_long", `${field} exceeds the cap (${LIMITS[field]} chars).`);
  return s;
}

export function toTokenId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function toRecord(row) {
  if (!row) return null;
  return {
    id: row.id,
    token: row.token,
    user: row.user,
    note: row.note,
    createdAt: row.created_at,
    revokedAt: row.revoked_at || null,
  };
}

// 같은 길이일 때만 timingSafeEqual 이 성립한다. 길이가 다르면 그 자체가 불일치다.
function matches(expected, presented) {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(presented, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export class TokenStore {
  constructor(db) {
    this.db = db;
    this.db.exec(SCHEMA);
  }

  list() {
    return this.db.prepare("SELECT * FROM token ORDER BY id DESC").all().map(toRecord);
  }

  get(id) {
    return toRecord(this.db.prepare("SELECT * FROM token WHERE id = ?").get(id));
  }

  counts() {
    const active = this.db.prepare("SELECT COUNT(*) AS n FROM token WHERE revoked_at IS NULL").get().n;
    const revoked = this.db.prepare("SELECT COUNT(*) AS n FROM token WHERE revoked_at IS NOT NULL").get().n;
    return { active, revoked };
  }

  issue(input = {}) {
    const user = text(input.user, "user");
    if (!user) throw fail("empty_user", "user cannot be empty.");
    // base64url 24바이트 — URL·헤더·셸 어디에 넣어도 이스케이프가 필요 없는 문자만 나온다.
    const token = `bm_${randomBytes(24).toString("base64url")}`;
    const { lastInsertRowid } = this.db
      .prepare("INSERT INTO token (token, user, note, created_at) VALUES (?, ?, ?, ?)")
      .run(token, user, text(input.note, "note"), new Date().toISOString());
    return this.get(Number(lastInsertRowid));
  }

  // 폐기된 토큰의 재폐기는 조용히 false — 이미 원하는 상태다.
  revoke(id) {
    return this.db
      .prepare("UPDATE token SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .run(new Date().toISOString(), id).changes > 0;
  }

  // 토큰 → 사용자. 활성 토큰 전부와 상수시간 비교한다 — 발급 수가 수십 건 규모라는 전제이고,
  // SQL 로 찾으면 문자열 비교 시간이 토큰 내용에 물린다.
  userFor(presented) {
    const p = String(presented || "").trim();
    if (!p) return null;
    let found = null;
    for (const row of this.db.prepare("SELECT token, user FROM token WHERE revoked_at IS NULL").all()) {
      if (matches(row.token, p)) found = row.user; // 찾아도 끝까지 돈다 — 순회 길이로 새는 것을 막는다
    }
    return found;
  }
}
