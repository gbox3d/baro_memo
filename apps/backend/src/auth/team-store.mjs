// 팀 — 보드 접근의 격리 단위 (0.13.0).
//
// **분류가 아니라 기밀이다.** 이 보드의 원칙("찾는 수단은 분류가 아니라 검색, 보드는 하나")은
// 그대로다 — 팀은 노이즈를 정리하려는 축이 아니라, 비밀 프로젝트를 그 구성원 밖의 눈에서
// 격리하려는 축이다. 그래서 기본은 여전히 보드 하나(team-n)이고, 팀은 예외를 위해 존재한다.
//
// 규칙 넷, 전부 여기서 결정된다:
//   1. **모든 사용자는 기본팀(team-n) 소속이다** — 행 없이, 암묵으로. 행으로 만들면 "행이
//      빠진 사용자"라는 있어서는 안 될 상태가 생기고, 그 사용자는 보드 전체를 잃는다.
//   2. **super 는 전 팀 보기·쓰기다.** visibleTeams 가 null(=전부)을 돌려주는 유일한 사용자
//      부류이고, null 은 SQL 필터를 아예 만들지 않는다는 뜻이다.
//   3. **소속은 사람(user)에 걸린다, 토큰이 아니라.** 한 사람의 토큰은 기기마다 있고
//      폐기·재발급이 잦다 — 소속이 토큰을 따라가면 재발급이 곧 강등이 된다.
//   4. **내장 팀 둘은 지울 수 없고, 팀 삭제 경로 자체가 없다.** 팀을 지우면 그 팀의 글이
//      고아가 되거나(안 보임) 노출되거나(기본팀으로 승격) 둘 중 하나인데, 양쪽 다 사고다.
//      필요해지는 날 글의 거취와 함께 설계한다.
import { fail, text } from "../memo/fields.mjs";
import { ensureSchema } from "../memo/schema.mjs";

export const DEFAULT_TEAM = "team-n";
export const SUPER_TEAM = "super";

// 팀 이름은 슬러그다. URL 경로·쿼리에 그대로 실리고 관리자 페이지에서 손으로 치는 값이라,
// 공백·대문자·유니코드를 받으면 "왜 안 맞지"가 만들어진다.
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

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
    seed.run(DEFAULT_TEAM, "기본팀 — 모든 사용자가 소속", new Date().toISOString());
    seed.run(SUPER_TEAM, "전 팀 보기·쓰기", new Date().toISOString());
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
    if (this.get(name)) throw fail("team_exists", `Team "${name}" already exists.`);
    this.db.prepare("INSERT INTO team (name, note, builtin, created_at) VALUES (?, ?, 0, ?)")
      .run(name, text(input.note ?? "", "title"), new Date().toISOString());
    return { ...this.get(name), members: [] };
  }

  membersOf(team) {
    return this.db.prepare("SELECT user FROM team_member WHERE team = ? ORDER BY user")
      .all(String(team || "")).map((r) => r.user);
  }

  // 멱등 — 이미 소속이면 false 를 돌려주고 아무것도 바꾸지 않는다. 관리자 페이지의 재클릭이
  // 에러가 되면 안 된다. 기본팀에 넣는 것은 거절한다: 암묵 소속에 행을 만들면 규칙이 두 벌이 된다.
  addMember(team, user) {
    const t = this.get(team);
    if (!t) throw fail("team_not_found", `No such team: "${team}".`);
    const u = String(user || "").trim();
    if (!u) throw fail("empty_user", "user cannot be empty.");
    if (t.name === DEFAULT_TEAM) {
      throw fail("default_team_implicit", `Everyone already belongs to "${DEFAULT_TEAM}" — membership rows are not kept for it.`);
    }
    return this.db.prepare("INSERT OR IGNORE INTO team_member (team, user, added_at) VALUES (?, ?, ?)")
      .run(t.name, u, new Date().toISOString()).changes > 0;
  }

  removeMember(team, user) {
    const t = this.get(team);
    if (!t) throw fail("team_not_found", `No such team: "${team}".`);
    return this.db.prepare("DELETE FROM team_member WHERE team = ? AND user = ?")
      .run(t.name, String(user || "").trim()).changes > 0;
  }

  /** 한 사람의 소속 — 기본팀 포함, 이름순. whoami 와 /api/teams 가 이 모양을 내보낸다. */
  teamsOf(user) {
    const u = String(user || "").trim();
    const rows = u
      ? this.db.prepare("SELECT team FROM team_member WHERE user = ? ORDER BY team").all(u).map((r) => r.team)
      : [];
    return [DEFAULT_TEAM, ...rows.filter((t) => t !== DEFAULT_TEAM)];
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
   */
  visibleTeams(user, { operator = false } = {}) {
    if (operator) return null;
    if (this.isSuper(user)) return null;
    return this.teamsOf(user);
  }

  /** 쓰기(글 만들기·팀 이동의 목적지) 허용 — 보이는 팀이면 쓸 수 있다는 같은 규칙의 다른 면. */
  canPost(user, team) {
    if (team === DEFAULT_TEAM) return true;
    if (this.isSuper(user)) return !!this.get(team);
    return this.db.prepare("SELECT 1 FROM team_member WHERE team = ? AND user = ?")
      .get(String(team || ""), String(user || "").trim()) !== undefined;
  }
}
