// 팀 — 보드 접근의 격리 단위 (0.13.0). 소속이 **명시**가 된 판이 0.14.0 이다.
//
// **분류가 아니라 기밀이다.** 이 보드의 원칙("찾는 수단은 분류가 아니라 검색, 보드는 하나")은
// 그대로다 — 팀은 노이즈를 정리하려는 축이 아니라, 비밀 프로젝트를 그 구성원 밖의 눈에서
// 격리하려는 축이다. 다만 그 격리를 **누가 자동으로 통과하는가**가 0.14.0 에서 뒤집혔다.
//
// 규칙 넷, 전부 여기서 결정된다:
//   1. **소속은 행이다. 암묵 소속은 없다** — 0.13.x 까지 team-n 은 행 없이 전원 소속이었고,
//      그래서 토큰을 받은 사람은 곧 보드 전체를 받았다. 지금은 행이 없는 사용자가 보는 팀도
//      쓰는 팀도 0 개다(visibleTeams 가 빈 배열). 운영자가 팀을 하나 지정해 주기 전까지 그
//      사람에게 보드는 없다 — 토큰 발급과 접근 허가가 두 동작으로 갈렸다.
//   2. **super 는 전 팀 보기·쓰기다.** visibleTeams 가 null(=전부)을 돌려주는 유일한 사용자
//      부류이고, null 은 SQL 필터를 아예 만들지 않는다는 뜻이다.
//   3. **소속은 사람(user)에 걸린다, 토큰이 아니라.** 한 사람의 토큰은 기기마다 있고
//      폐기·재발급이 잦다 — 소속이 토큰을 따라가면 재발급이 곧 강등이 된다.
//   4. **내장 팀 둘은 지울 수 없고, 팀 삭제 경로 자체가 없다.** 팀을 지우면 그 팀의 글이
//      고아가 되거나(안 보임) 노출되거나(기본팀으로 승격) 둘 중 하나인데, 양쪽 다 사고다.
//      필요해지는 날 글의 거취와 함께 설계한다.
//
// team-n 은 이제 **이름이 남은 평범한 팀**이다. 지울 수 없고(내장), 팀이 생기기 전의 글이
// 전부 거기 있고, 새 사용자를 넣을 기본 자리다 — 그뿐이다. 특권은 없다.
import { fail } from "../memo/fields.mjs";
import { ensureSchema } from "../memo/schema.mjs";

export const DEFAULT_TEAM = "team-n";
export const SUPER_TEAM = "super";

// 내장 둘. 비고는 **코드가 소유한다** — 화면에 뜨는 한 줄이 규칙을 설명하는 자리라, 규칙이
// 바뀐 날 DB 에 남은 옛 문장이 운영자에게 거짓말을 한다(0.13.x 의 "모든 사용자가 소속"이 그랬다).
const BUILTIN = Object.freeze([
  [DEFAULT_TEAM, "기본팀 — 새 사용자를 넣을 자리(자동 소속이 아닙니다)"],
  [SUPER_TEAM, "전 팀 보기·쓰기"],
]);

// 팀 이름은 슬러그다. URL 경로·쿼리에 그대로 실리고 관리자 페이지에서 손으로 치는 값이라,
// 공백·대문자·유니코드를 받으면 "왜 안 맞지"가 만들어진다.
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const NOTE_MAX = 200;  // 토큰의 note 와 같은 상한 — 같은 자리에 같은 성격의 값이다
// 슬러그로는 적법하지만 팀 이름으로 두면 로그·화면에서 "값이 없음"과 구분되지 않는 낱말들.
// 값이 null 인 본문이 문자열로 저장되던 결함이 있었고, 그때 이 이름의 팀이 존재했다면 잃어버린
// 글이 남의 팀에서 읽혔다. 결함은 고쳤지만 이름 쪽 함정은 따로 닫아 둔다.
const RESERVED = new Set(["null", "undefined", "none", "nan"]);

// 이 DB 가 어느 규칙으로 세워졌는가. SQLite 의 user_version 은 이 파일에서 쓰인 적이 없는
// 칸이라(0 이 곧 "0.13.x 이하"다) 표식으로 쓴다.
const SCHEMA_VERSION = 1;

/**
 * 암묵 소속을 행으로 굳힌다 — 0.13.x → 0.14.0 의 유일한 이관.
 *
 * 규칙 1이 뒤집히는 순간 **기존 사용자 전원의 소속 행이 0 개**가 된다. 그대로 두면 재기동
 * 다음 요청부터 보드가 통째로 닫히고, 정책 변경이 장애로 보인다. 있던 사람에게는 있던 것을
 * 행으로 남긴다 — 이관 뒤의 접근 범위는 이관 전과 정확히 같고, 거기서부터 운영자가 뺀다.
 *
 * **한 번만 돈다.** 매 기동 "team-n 이 비었으면 채운다"로 하면 운영자가 일부러 비운 팀이
 * 재기동마다 되살아난다 — 재기동이 조용히 권한을 돌려주는 것이 이 종류에서 가장 나쁜 실패다.
 *
 * 폐기된 토큰의 사람도 넣는다. 기기를 바꿔 재발급받는 것이 이 보드의 일상이고, 그 사이에
 * 소속이 사라지면 재발급이 곧 강등이 된다(소속을 사람에 건 이유 그대로다).
 */
function migrateImplicitMembership(db) {
  if ((db.prepare("PRAGMA user_version").get()?.user_version ?? 0) >= SCHEMA_VERSION) return 0;
  // **표식 하나에 걸지 않는다.** user_version 은 DB 헤더의 값이라 `sqlite3 .dump | sqlite3` 로
  // 다시 세운 파일에서는 0 으로 돌아온다(VACUUM·VACUUM INTO 는 보존한다 — 백업 경로는 안전하다).
  // 그 창에서 이관이 다시 돌면 운영자가 빼 둔 사람이 되살아난다. 두 번째 조건이 그것을 막는다:
  // team-n 에 행이 하나라도 있으면 이 DB 는 이미 새 규칙을 지난 것이다 — 0.13.x 에서는 그 행이
  // 만들어질 수 없었기 때문에(addMember 가 거절했다) 있다는 사실 자체가 증거다.
  if (db.prepare("SELECT 1 FROM team_member WHERE team = ?").get(DEFAULT_TEAM)) {
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    return 0;
  }
  // 스토어를 단독으로 세운 경우(검사·스크립트) token 테이블이 아직 없을 수 있다 — 그때는
  // 옮길 사람도 없다. 표식은 그래도 찍는다: 사람이 없는 DB 는 새 DB 이고, 새 DB 의 규칙은 새 규칙이다.
  const hasTokens = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'token'").get();
  let moved = 0;
  if (hasTokens) {

    const add = db.prepare("INSERT OR IGNORE INTO team_member (team, user, added_at) VALUES (?, ?, ?)");
    const now = new Date().toISOString();
    for (const { user } of db.prepare("SELECT DISTINCT user FROM token WHERE user <> ''").all()) {
      moved += add.run(DEFAULT_TEAM, user, now).changes;
    }
  }
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  return moved;
}

function toRecord(row) {
  if (!row) return null;
  return { name: row.name, note: row.note, builtin: !!row.builtin, createdAt: row.created_at };
}

export class TeamStore {
  constructor(db) {
    this.db = db;
    ensureSchema(db);
    // 내장 둘을 심는다. INSERT OR IGNORE 라 재기동마다 안전하고, 지워졌어도 되살아난다 —
    // 이 둘의 존재는 코드의 전제라서 DB 상태가 그것을 부정할 수 없어야 한다.
    const seed = this.db.prepare(
      "INSERT OR IGNORE INTO team (name, note, builtin, created_at) VALUES (?, ?, 1, ?)");
    const renote = this.db.prepare("UPDATE team SET note = ? WHERE name = ? AND builtin = 1 AND note <> ?");
    for (const [name, note] of BUILTIN) {
      seed.run(name, note, new Date().toISOString());
      renote.run(note, name, note);
    }
    // 이관은 내장 팀이 선 **뒤에**다 — team_member 가 team(name) 을 FK 로 물고 있다.
    this.migrated = migrateImplicitMembership(this.db);
  }

  /** 전 팀, 이름순 — 내장이 먼저. 관리자 화면의 목록이 이 모양 그대로다. */
  list() {
    return this.db
      .prepare("SELECT * FROM team ORDER BY builtin DESC, name")
      .all()
      .map((row) => ({ ...toRecord(row), members: this.membersOf(row.name) }));
  }

  get(name) {
    return toRecord(this.db.prepare("SELECT * FROM team WHERE name = ?").get(String(name || "")));
  }

  create(input = {}) {
    const name = String(input.name || "").trim();
    if (!NAME_RE.test(name)) {
      throw fail("invalid_team_name", "team name must match ^[a-z0-9][a-z0-9_-]{0,31}$ — lowercase slug, it travels in URLs.");
    }
    if (RESERVED.has(name)) {
      throw fail("invalid_team_name", `"${name}" cannot be a team name — it reads as a missing value.`);
    }
    if (this.get(name)) throw fail("team_exists", `Team "${name}" already exists.`);
    // 상한은 여기서 잰다. memo 의 text() 를 빌려 쓰면 거절 메시지가 남의 칸 이름을 부른다
    // ("title exceeds the cap") — 고칠 사람이 무엇을 줄여야 하는지 모르게 된다. 다만 그때
    // 타입 검사까지 같이 잃었다: 객체를 넣으면 "[object Object]" 가 조용히 저장됐다.
    if (input.note !== undefined && input.note !== null && typeof input.note !== "string") {
      throw fail("invalid_field", "note must be a string.");
    }
    const note = String(input.note ?? "").trim();
    if (note.length > NOTE_MAX) throw fail("too_long", `note exceeds the cap (${NOTE_MAX} chars).`);
    this.db.prepare("INSERT INTO team (name, note, builtin, created_at) VALUES (?, ?, 0, ?)")
      .run(name, note, new Date().toISOString());
    return { ...this.get(name), members: [] };
  }

  membersOf(team) {
    return this.db.prepare("SELECT user FROM team_member WHERE team = ? ORDER BY user")
      .all(String(team || "")).map((r) => r.user);
  }

  // 멱등 — 이미 소속이면 false 를 돌려주고 아무것도 바꾸지 않는다. 관리자 페이지의 재클릭이
  // 에러가 되면 안 된다. **기본팀도 예외가 아니다**(0.14.0): 여기 넣는 것이 그 사람에게 보드를
  // 여는 동작이고, 안 넣으면 안 열린다.
  addMember(team, user) {
    const t = this.get(team);
    if (!t) throw fail("team_not_found", `No such team: "${team}".`);
    const u = String(user || "").trim();
    if (!u) throw fail("empty_user", "user cannot be empty.");
    return this.db.prepare("INSERT OR IGNORE INTO team_member (team, user, added_at) VALUES (?, ?, ?)")
      .run(t.name, u, new Date().toISOString()).changes > 0;
  }

  removeMember(team, user) {
    const t = this.get(team);
    if (!t) throw fail("team_not_found", `No such team: "${team}".`);
    // 넣기와 같은 문턱이다. 빈 값에 200 removed:false 를 주면 운영자는 "그 사람은 원래
    // 없었다"로 읽는데, 실제로는 이름을 안 보낸 것이다 — 다른 사실이다.
    const u = String(user || "").trim();
    if (!u) throw fail("empty_user", "user cannot be empty.");
    return this.db.prepare("DELETE FROM team_member WHERE team = ? AND user = ?")
      .run(t.name, u).changes > 0;
  }

  /**
   * 한 사람의 소속 — 행이 전부다, 이름순. **빈 배열은 "보드에 접근이 없다"** 이지 기본값이
   * 아니다(0.13.x 까지는 여기서 team-n 을 무조건 앞에 붙였고, 그것이 암묵 소속의 정체였다).
   */
  teamsOf(user) {
    const u = String(user || "").trim();
    if (!u) return [];
    return this.db.prepare("SELECT team FROM team_member WHERE user = ? ORDER BY team").all(u)
      .map((r) => r.team);
  }

  isSuper(user) {
    const u = String(user || "").trim();
    if (!u) return false;
    return !!this.db.prepare("SELECT 1 FROM team_member WHERE team = ? AND user = ?").get(SUPER_TEAM, u);
  }

  /**
   * 이 사람에게 보이는 팀 — **null 은 "전부"다**(super·운영자). 라우터는 이 값 하나로 목록·
   * 검색·한 건·댓글·이력 전부를 거른다. 배열이면 그 안의 팀만 존재한다: 밖의 팀은 글도,
   * 팀 이름 자체도 404 다 — 비밀 프로젝트는 이름이 새는 것부터가 노출이다.
   *
   * **빈 배열과 null 을 섞지 말 것.** 하나는 "아무것도 안 보인다", 하나는 "전부 보인다"이고,
   * 사이에 falsy 검사(`if (!visible)`)를 두면 소속 없는 사용자가 보드를 통째로 얻는다.
   */
  visibleTeams(user, { operator = false } = {}) {
    if (operator) return null;
    if (this.isSuper(user)) return null;
    return this.teamsOf(user);
  }

  /**
   * 팀을 안 고른 글이 갈 곳 — 쓸 수 있는 팀이 **정확히 하나**일 때 그 팀, 아니면 null.
   *
   * **super 는 언제나 null 이다.** 처음에는 소속 목록에서 super 만 빼고 셌는데, 그러면
   * {super, team-n} 인 사람 — super 를 얹는 가장 흔한 모양이다 — 이 team-n 하나로 세어져
   * 조용한 기본값을 받았다. 이 문턱의 근거가 "쓸 수 있는 팀이 여럿이면 서버가 대신 고르지
   * 않는다"인데, super 는 정의상 **모든 팀**에 쓸 수 있다(canPost 가 그렇다). 즉 비밀
   * 프로젝트를 전부 아는 바로 그 사람만 문턱 밖에 서 있었다 — 실수의 대가가 가장 큰 자리다.
   */
  defaultTeamFor(user) {
    if (this.isSuper(user)) return null;
    const mine = this.teamsOf(user);
    return mine.length === 1 ? mine[0] : null;
  }


  /** 쓰기(글 만들기·팀 이동의 목적지) 허용 — 보이는 팀이면 쓸 수 있다는 같은 규칙의 다른 면. */
  canPost(user, team) {
    if (this.isSuper(user)) return !!this.get(team);
    return this.db.prepare("SELECT 1 FROM team_member WHERE team = ? AND user = ?")
      .get(String(team || ""), String(user || "").trim()) !== undefined;
  }
}
