// 팀 — 접근 격리의 검사. 주제는 하나다: **안 보여야 할 글이 새는 경로가 없어야 한다.**
//
// 이 기능에서 편의 실패(멤버가 못 보는 것)는 눈에 띄어 고쳐지지만, 격리 실패(비멤버가 보는
// 것)는 조용하다 — 그래서 검사의 무게가 전부 후자에 실린다. 글 하나가 밖에서 보이는 표면을
// 전부 나열하고(목록·검색·한 건·댓글·점수·이력·스니펫), 각각을 비멤버의 눈으로 두드린다.
import assert from "node:assert/strict";
import test from "node:test";

import { openDb } from "../src/core/db.mjs";
import { MemoStore } from "../src/memo/memo-store.mjs";
import { CommentStore } from "../src/memo/comment-store.mjs";
import { VoteStore } from "../src/memo/vote-store.mjs";
import { AuditStore } from "../src/memo/audit-store.mjs";
import { TokenStore } from "../src/auth/token-store.mjs";
import { TeamStore, DEFAULT_TEAM, SUPER_TEAM } from "../src/auth/team-store.mjs";
import { createVerdict } from "../src/auth/verdict.mjs";
import { createMemoRoutes } from "../src/memo/routes.mjs";
import { createAdminRoutes } from "../src/admin/routes.mjs";
import { createAuthRoutes } from "../src/auth/routes.mjs";

const ADMIN = "adm_team_test";

// 보드 하나를 세운다: 대표(boss)는 secret 팀, 이사(exec)는 super, 사원(staff)은 기본팀만.
function rig() {
  const db = openDb(":memory:");
  const memoStore = new MemoStore(db);
  const commentStore = new CommentStore(db);
  const voteStore = new VoteStore(db);
  const auditStore = new AuditStore(db);
  const tokenStore = new TokenStore(db);
  const teamStore = new TeamStore(db);
  const verdict = createVerdict({ tokenStore, adminToken: ADMIN });

  const tokens = {};
  for (const u of ["boss", "exec", "staff"]) tokens[u] = tokenStore.issue({ user: u }).token;
  teamStore.create({ name: "secret", note: "비밀 프로젝트" });
  teamStore.addMember("secret", "boss");
  teamStore.addMember(SUPER_TEAM, "exec");

  const memoRoutes = createMemoRoutes({ memoStore, tokenStore, commentStore, teamStore, voteStore, auditStore, adminToken: ADMIN });
  const adminRoutes = createAdminRoutes({ tokenStore, teamStore, auditStore, adminToken: ADMIN });
  const authRoutes = createAuthRoutes({ verdict, teamStore });
  const as = (who) => ({ "x-memo-token": who === "admin" ? ADMIN : tokens[who] });
  return {
    db, memoStore, commentStore, voteStore, teamStore, tokens, as,
    memo: (m, p, body, who, query = null) => memoRoutes(m, p, query, body, as(who)),
    admin: (m, p, body) => adminRoutes(m, p, null, body, { "x-memo-token": ADMIN }),
    auth: (who) => authRoutes("GET", "/api/auth/whoami", null, {}, as(who)),
  };
}

// ---- 스토어 규칙 ----------------------------------------------------------------------------

test("내장 둘은 늘 있고 지워졌어도 되살아난다 — 존재가 코드의 전제다", () => {
  const { teamStore, db } = rig();
  assert.ok(teamStore.get(DEFAULT_TEAM).builtin);
  assert.ok(teamStore.get(SUPER_TEAM).builtin);
  // 구성원 행이 FK 로 팀을 물고 있다 — 그 자체가 "팀은 그냥 못 지운다"의 저장소 증명이다.
  assert.throws(() => db.prepare("DELETE FROM team WHERE name = ?").run(SUPER_TEAM), /FOREIGN KEY/);
  db.prepare("DELETE FROM team_member WHERE team = ?").run(SUPER_TEAM);
  db.prepare("DELETE FROM team WHERE name = ?").run(SUPER_TEAM);
  assert.ok(new TeamStore(db).get(SUPER_TEAM), "재기동(재생성)이 내장을 다시 심어야 한다");
});

test("소속은 사람의 것 — 기본팀은 행 없이 암묵이고, 행으로 만드는 것은 거절된다", () => {
  const { teamStore } = rig();
  assert.deepEqual(teamStore.teamsOf("staff"), [DEFAULT_TEAM], "아무 행이 없어도 기본팀 소속이다");
  assert.deepEqual(teamStore.teamsOf("boss"), [DEFAULT_TEAM, "secret"]);
  assert.throws(() => teamStore.addMember(DEFAULT_TEAM, "staff"), { code: "default_team_implicit" },
    "암묵 소속에 행이 생기면 규칙이 두 벌이 된다");
  // 멱등 — 재클릭이 에러가 아니다.
  assert.equal(teamStore.addMember("secret", "boss"), false);
  assert.equal(teamStore.removeMember("secret", "nobody"), false);
});

test("팀 이름은 슬러그다 — URL 에 실리는 값이라 여기서 걸러야 한다", () => {
  const { teamStore } = rig();
  for (const bad of ["", "한글팀", "UPPER", "a b", "-lead", "x".repeat(33)]) {
    assert.throws(() => teamStore.create({ name: bad }), { code: "invalid_team_name" }, JSON.stringify(bad));
  }
  assert.throws(() => teamStore.create({ name: "secret" }), { code: "team_exists" });
  assert.throws(() => teamStore.create({ name: SUPER_TEAM }), { code: "team_exists" }, "내장 이름도 점유돼 있다");
});

test("visibleTeams: null 만이 전부다 — super 와 운영자", () => {
  const { teamStore } = rig();
  assert.equal(teamStore.visibleTeams("exec"), null, "super 는 전부");
  assert.equal(teamStore.visibleTeams("", { operator: true }), null, "운영자는 전부");
  assert.deepEqual(teamStore.visibleTeams("staff"), [DEFAULT_TEAM]);
});

// ---- 격리 — 글 하나가 밖에서 보이는 모든 표면 ------------------------------------------------

test("비밀 글은 비멤버에게 어느 표면으로도 없다 — 있는 글과 없는 글이 같은 404 다", async () => {
  const { memo } = rig();
  const { json: made } = await memo("POST", "/api/memos",
    { title: "acquisition", body: "the confidential plan mentions zzconfidential", team: "secret" }, "boss");
  const id = made.memo.id;
  await memo("POST", `/api/memos/${id}/comments`, { body: "zzthread reply" }, "boss");

  // 멤버·super·운영자는 본다.
  for (const who of ["boss", "exec", "admin"]) {
    assert.equal((await memo("GET", `/api/memos/${id}`, {}, who)).status, 200, who);
  }

  // 사원은 못 본다 — 표면 전부.
  const surfaces = [
    ["GET", `/api/memos/${id}`], ["GET", `/api/memos/${id}/comments`],
    ["GET", `/api/memos/${id}/score`], ["PATCH", `/api/memos/${id}`, { status: "done" }],
    ["DELETE", `/api/memos/${id}`], ["PUT", `/api/memos/${id}/score`, { value: 5 }],
    ["POST", `/api/memos/${id}/comments`, { body: "should not land" }],
  ];
  for (const [m, p, b = {}] of surfaces) {
    const res = await memo(m, p, b, "staff");
    assert.equal(res.status, 404, `${m} ${p} 가 ${res.status} 를 돌려줬다`);
    assert.match(res.json.code, /not_found/, `${m} ${p} — 403 은 "있긴 하다"를 말해 준다`);
  }

  // 목록·검색·스니펫으로도 새지 않는다.
  const list = await memo("GET", "/api/memos", {}, "staff", "");
  assert.equal(list.json.total, 0, "총계까지 0 이어야 한다 — 개수는 존재를 센다");
  const search = await memo("GET", "/api/memos", {}, "staff", "q=zzconfidential");
  assert.equal(search.json.total, 0, "본문 검색");
  const inComment = await memo("GET", "/api/memos", {}, "staff", "q=zzthread");
  assert.equal(inComment.json.total, 0, "댓글 색인 경유도 막혀야 한다 — 스니펫이 새는 자리다");

  // 멤버의 검색은 걸린다 — 격리가 검색 자체를 죽인 것이 아니라는 확인.
  const mine = await memo("GET", "/api/memos", {}, "boss", "q=zzconfidential");
  assert.equal(mine.json.total, 1);
});

test("댓글 id 를 맞혀도 비밀 글의 댓글은 지울 수 없다 — 경로 우회 차단", async () => {
  const { memo } = rig();
  const { json: made } = await memo("POST", "/api/memos", { body: "b", team: "secret" }, "boss");
  const { json: c } = await memo("POST", `/api/memos/${made.memo.id}/comments`, { body: "reply" }, "boss");
  const res = await memo("DELETE", `/api/memos/${made.memo.id}/comments/${c.comment.id}`, {}, "staff");
  assert.equal(res.status, 404);
});

test("이력은 사건 당시의 팀을 따른다 — 지워진 비밀 글의 이력도 비멤버에게 없다", async () => {
  const { memo } = rig();
  const { json: made } = await memo("POST", "/api/memos", { body: "b", team: "secret" }, "boss");
  const id = made.memo.id;
  await memo("PATCH", `/api/memos/${id}`, { status: "done" }, "boss");
  await memo("DELETE", `/api/memos/${id}`, {}, "boss");

  // 멤버와 운영자는 이력을 본다 — "그 메모 어디 갔나"의 답이 이 축이다.
  assert.equal((await memo("GET", `/api/memos/${id}/history`, {}, "boss")).json.total, 2);
  assert.equal((await memo("GET", `/api/memos/${id}/history`, {}, "admin")).json.total, 2);
  // 사원에게는 이력 자체가 빈 모양이다 — 404 가 아니라 0건인 이유: 이력 라우트는 지워진 id 에
  // 늘 200 을 주므로, 여기만 404 면 그 차이가 "비밀 글이 있었다"를 말해 준다.
  const res = await memo("GET", `/api/memos/${id}/history`, {}, "staff");
  assert.equal(res.status, 200);
  assert.equal(res.json.total, 0);
});

test("팀 이동: 목적지 소속이 필요하고, 비밀→기본팀 이동은 그날로 전체 공개다", async () => {
  const { memo } = rig();
  const { json: made } = await memo("POST", "/api/memos", { body: "b", team: "secret" }, "boss");
  const id = made.memo.id;

  // 멤버가 아닌 팀으로는 못 옮긴다 — 팀의 존재도 말하지 않는다.
  const { teamStore } = rig(); // 별도 rig 의 스토어가 아니라 이름 검증용
  assert.ok(teamStore);
  const denied = await memo("PATCH", `/api/memos/${id}`, { team: "board" }, "boss");
  assert.equal(denied.status, 404, "없는 팀");
  assert.equal(denied.json.code, "team_not_found");

  const out = await memo("PATCH", `/api/memos/${id}`, { team: DEFAULT_TEAM }, "boss");
  assert.equal(out.status, 200);
  assert.equal(out.json.memo.team, DEFAULT_TEAM);
  assert.equal((await memo("GET", `/api/memos/${id}`, {}, "staff")).status, 200, "이동 즉시 모두에게 보인다");

  // 사원은 비밀 팀으로 옮길 수 없다(목적지 소속 없음) — 이동으로 남의 글을 숨기는 경로 차단.
  const hide = await memo("PATCH", `/api/memos/${id}`, { team: "secret" }, "staff");
  assert.equal(hide.status, 404);
});

test("작성: 팀 지정은 소속이 있어야 하고, 기본은 team-n 이다", async () => {
  const { memo } = rig();
  const plain = await memo("POST", "/api/memos", { body: "b" }, "staff");
  assert.equal(plain.json.memo.team, DEFAULT_TEAM);

  assert.equal((await memo("POST", "/api/memos", { body: "b", team: "secret" }, "staff")).status, 404);
  assert.equal((await memo("POST", "/api/memos", { body: "b", team: "ghost" }, "boss")).status, 404);
  assert.equal((await memo("POST", "/api/memos", { body: "b", team: "secret" }, "exec")).status, 201,
    "super 는 모든 팀에 쓴다");
});

test("?team= 은 자기 팀 안에서의 좁히기 — 남의 팀 이름은 존재를 말하지 않는다", async () => {
  const { memo } = rig();
  await memo("POST", "/api/memos", { body: "open one" }, "staff");
  await memo("POST", "/api/memos", { body: "secret one", team: "secret" }, "boss");

  const mine = await memo("GET", "/api/memos", {}, "boss", "team=secret");
  assert.equal(mine.json.total, 1);
  assert.equal(mine.json.memos[0].team, "secret");

  const denied = await memo("GET", "/api/memos", {}, "staff", "team=secret");
  assert.equal(denied.status, 404, "200 빈 목록은 '그 팀은 비어 있다'는 다른 사실이 된다");
  assert.equal((await memo("GET", "/api/memos", {}, "staff", "team=ghost")).status, 404, "없는 팀과 같은 답");
});

test("/api/teams 는 자기에게 보이는 팀까지만 — 명단은 어디에도 없다", async () => {
  const { memo } = rig();
  const staff = await memo("GET", "/api/teams", {}, "staff");
  assert.deepEqual(staff.json.teams.map((t) => t.name), [DEFAULT_TEAM]);

  const boss = await memo("GET", "/api/teams", {}, "boss");
  assert.deepEqual(boss.json.teams.map((t) => t.name), [DEFAULT_TEAM, "secret"]);
  assert.ok(boss.json.teams.every((t) => t.members === undefined), "명단은 관리자 축의 것이다");

  const all = await memo("GET", "/api/teams", {}, "exec");
  assert.ok(all.json.teams.map((t) => t.name).includes("secret"), "super 는 전부 본다");
  assert.ok(all.json.teams.every((t) => t.members === undefined));
});

test("whoami 가 소속을 싣는다 — 에이전트가 어디에 쓸 수 있는지 한 번에 안다", async () => {
  const { auth } = rig();
  assert.deepEqual((await auth("boss")).json.teams, [DEFAULT_TEAM, "secret"]);
  assert.deepEqual((await auth("staff")).json.teams, [DEFAULT_TEAM]);
  assert.equal((await auth("admin")).json.teams, null, "운영자에게 소속은 없다 — 전부다");
});

// ---- 관리자 축 -------------------------------------------------------------------------------

test("관리자 축: 생성·명단·구성원 넣고 빼기, 그리고 그 축만 명단을 안다", async () => {
  const { admin, memo } = rig();
  const made = await admin("POST", "/api/admin/teams", { name: "lab-x", note: "새 프로젝트" });
  assert.equal(made.status, 201);

  const added = await admin("POST", "/api/admin/teams/lab-x/members", { user: "staff" });
  assert.equal(added.json.added, true);
  assert.deepEqual(added.json.members, ["staff"]);
  // 즉시 반영 — 소속이 생기면 다음 요청부터 보인다.
  assert.equal((await memo("POST", "/api/memos", { body: "b", team: "lab-x" }, "staff")).status, 201);

  const removed = await admin("DELETE", "/api/admin/teams/lab-x/members", { user: "staff" });
  assert.equal(removed.json.removed, true);
  assert.equal((await memo("POST", "/api/memos", { body: "b", team: "lab-x" }, "staff")).status, 404,
    "빠지면 다음 요청부터 없다 — 캐시가 없으므로 즉시다");

  const list = await admin("GET", "/api/admin/teams", {});
  const names = list.json.teams.map((t) => t.name);
  assert.ok(names.includes(DEFAULT_TEAM) && names.includes(SUPER_TEAM) && names.includes("lab-x"));

  assert.equal((await admin("POST", "/api/admin/teams/ghost/members", { user: "x" })).status, 404);
});

test("관리자 팀 축도 관리자 토큰만 — 사용자 토큰으로 명단을 읽을 수 없다", async () => {
  const { tokens } = rig();
  const db = openDb(":memory:");
  const routes = createAdminRoutes({ tokenStore: new TokenStore(db), teamStore: new TeamStore(db), adminToken: ADMIN });
  const res = await routes("GET", "/api/admin/teams", null, {}, { "x-memo-token": tokens.boss });
  assert.equal(res.status, 401);
  assert.equal(res.json.code, "admin_token_invalid");
});

// ---- 이관 ------------------------------------------------------------------------------------

test("0.13.0 이전 DB 에 열이 얹히고, 기존 글은 전부 기본팀이 된다", () => {
  const db = openDb(":memory:");
  // 옛 모양을 손으로 만든다 — team 열이 없는 memo/audit.
  db.exec(`
    CREATE TABLE memo (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open', author TEXT NOT NULL DEFAULT '', user TEXT NOT NULL DEFAULT '',
      updated_by TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL, memo_id INTEGER, comment_id INTEGER,
      summary TEXT NOT NULL DEFAULT '', before TEXT NOT NULL DEFAULT '', after TEXT NOT NULL DEFAULT '');
    INSERT INTO memo (body, created_at, updated_at) VALUES ('legacy post', 't', 't');
    INSERT INTO audit (at, action, memo_id) VALUES ('t', 'memo_update', 1);
  `);
  const store = new MemoStore(db); // ensureSchema 가 이관을 수행한다
  assert.equal(store.get(1).team, DEFAULT_TEAM, "팀이 생기기 전의 글은 기본팀의 글이다");
  assert.equal(db.prepare("SELECT team FROM audit WHERE id = 1").get().team, DEFAULT_TEAM);
  // 이관 뒤에도 격리가 돈다 — 열이 있기만 하고 필터가 안 걸리는 상태를 배제.
  assert.equal(store.list({ teams: [DEFAULT_TEAM] }).total, 1);
  assert.equal(store.list({ teams: ["secret"] }).total, 0);
  assert.equal(store.list({ teams: [] }).total, 0, "빈 배열은 전부가 아니라 아무것도 아니다");
});

// ---- 검토에서 나온 두 결함 (0.13.0 배포 전 확인) ---------------------------------------------
//
// 넷 중 세 렌즈가 독립적으로 같은 것을 찾았다: **이동 이력이 "그 글은 아직 있다"를 말한다.**
// 격리의 규칙은 "안 보이는 글은 없는 글과 구분되지 않는다"이므로, 그 한 줄이 규칙을 깬다.

test("비밀 팀으로 옮긴 사실이 이력으로 새지 않는다 — 이력의 팀은 도착지다", async () => {
  const { memo } = rig();
  const { json: made } = await memo("POST", "/api/memos", { title: "public plan", body: "everyone" }, "boss");
  const id = made.memo.id;
  await memo("PATCH", `/api/memos/${id}`, { team: "secret" }, "boss");

  // 사원에게는 글도 이력도 없다 — 애초에 없던 글과 같은 모양이어야 한다.
  assert.equal((await memo("GET", `/api/memos/${id}`, {}, "staff")).status, 404);
  const hidden = await memo("GET", `/api/memos/${id}/history`, {}, "staff");
  assert.equal(hidden.json.total, 0, "이동 한 줄이 '그 글은 아직 있고 누가 옮겼다'를 말한다");

  // 멤버에게는 그대로 남는다 — 감추는 것은 밖이지 안이 아니다.
  assert.equal((await memo("GET", `/api/memos/${id}/history`, {}, "boss")).json.total, 1);

  // 반대 방향(비밀 → 기본팀)은 보인다. 공개한 사실은 공개돼도 된다.
  await memo("PATCH", `/api/memos/${id}`, { team: DEFAULT_TEAM }, "boss");
  assert.equal((await memo("GET", `/api/memos/${id}/history`, {}, "staff")).json.total, 1);
});

test("남의 글은 팀으로 끌고 갈 수 없다 — 이동은 편집이 아니라 소유의 문제다", async () => {
  const { memo } = rig();
  // staff 의 공개 글에 staff 의 댓글과 점수가 달려 있다.
  const { json: made } = await memo("POST", "/api/memos", { body: "staff's own post" }, "staff");
  const id = made.memo.id;
  await memo("POST", `/api/memos/${id}/comments`, { body: "staff comment" }, "staff");
  await memo("PUT", `/api/memos/${id}/score`, { value: 3 }, "staff");

  // 비밀 팀 멤버라도 남의 글은 못 옮긴다. 옮기면 글쓴이가 자기 글·댓글·점수를 전부 잃는다.
  const grab = await memo("PATCH", `/api/memos/${id}`, { team: "secret" }, "boss");
  assert.equal(grab.status, 403);
  assert.equal(grab.json.code, "team_move_not_owner");
  assert.equal((await memo("GET", `/api/memos/${id}`, {}, "staff")).status, 200, "글은 그대로 staff 의 것이다");

  // 주인은 옮길 수 있고, super 도 옮길 수 있다(운영상 필요한 손).
  assert.equal((await memo("PATCH", `/api/memos/${id}`, { team: DEFAULT_TEAM }, "staff")).status, 200);
  const bySuper = await memo("PATCH", `/api/memos/${id}`, { team: "secret" }, "exec");
  assert.equal(bySuper.status, 200);
  assert.equal(bySuper.json.memo.team, "secret");

  // 팀 아닌 칸의 PATCH 는 여전히 아무나 한다 — 이 보드의 규약은 그대로다.
  assert.equal((await memo("PATCH", `/api/memos/${id}`, { status: "done" }, "boss")).status, 200);
});

test("whoami 의 teams 는 실제로 쓸 수 있는 팀이다 — super 가 자기 권한을 좁게 알면 안 된다", async () => {
  const { auth, memo } = rig();
  const teams = (await auth("exec")).json.teams;
  assert.ok(teams.includes("secret"), "super 는 모든 팀에 쓸 수 있고, 그 사실이 이 값에 있어야 한다");
  // 값이 실제 권한과 맞는지 — 목록이 말한 팀에 실제로 써진다.
  for (const t of teams) {
    assert.equal((await memo("POST", "/api/memos", { body: "b", team: t }, "exec")).status, 201, t);
  }
  // 그리고 GET /api/teams 와 같은 집합이다.
  const listed = (await memo("GET", "/api/teams", {}, "exec")).json.teams.map((t) => t.name);
  assert.deepEqual([...teams].sort(), [...listed].sort());
});

// ---- 2판 검토: 수정이 만든 결함 (v0.13.1) ---------------------------------------------------
//
// 1판의 수정 넷 중 하나가 **치명적 결함을 새로 만들었다.** 라우터는 팀을 `!= null` 로 걸렀는데
// 저장소는 `!== undefined` 로 썼다 — 같은 값을 두 곳에서 다르게 읽었고, 그 틈으로 팀이 null 인
// 본문이 문턱 둘(목적지 소속·주인 확인)을 통째로 건너뛰어 문자열 "null" 로 저장됐다.
// 결과는 유출이 아니라 **파괴**였다: 아무 토큰이나 남의 글을 아무도 못 보는 곳으로 보내고,
// 주인은 되돌릴 수도 이력을 볼 수도 없었다(이력의 팀도 "null" 로 찍히므로).
//
// 고침은 조건 맞추기가 아니라 **출처 하나로**다 — create() 가 애초에 안전했던 이유가 그것이고
// (본문의 team 을 읽지 않고 검증된 인자만 받는다), update() 도 같은 모양으로 맞췄다.

test("team:null 은 이동이 아니다 — 문턱을 건너뛰지도, 글을 삼키지도 않는다", async () => {
  const { memo } = rig();
  const { json: made } = await memo("POST", "/api/memos", { title: "public", body: "everyone" }, "staff");
  const id = made.memo.id;

  // 남이 보내도 팀은 그대로다. 예전에는 여기서 memo.team 이 "null" 이 됐다.
  const attack = await memo("PATCH", `/api/memos/${id}`, { team: null, status: "done" }, "boss");
  assert.equal(attack.status, 200);
  assert.equal(attack.json.memo.team, DEFAULT_TEAM, "null 이 팀 자리에 저장되면 글이 사라진다");
  assert.equal((await memo("GET", `/api/memos/${id}`, {}, "staff")).status, 200, "주인이 자기 글을 계속 본다");

  // 주인의 읽고-고쳐-쓰기(빈 칸을 null 로 직렬화하는 흔한 클라이언트)도 자기 글을 안 잃는다.
  const rmw = await memo("PATCH", `/api/memos/${id}`, { title: "renamed", team: null }, "staff");
  assert.equal(rmw.json.memo.team, DEFAULT_TEAM);

  // team 만 null 로 보낸 PATCH 는 바꿀 것이 없는 요청이다 — 200 으로 성공을 흉내 내지 않는다.
  assert.equal((await memo("PATCH", `/api/memos/${id}`, { team: null }, "staff")).json.code, "no_fields");
});

test("저장소는 팀을 인자로만 받는다 — 본문이 저장소까지 흘러도 팀은 안 바뀐다", () => {
  const { memoStore } = rig();
  const made = memoStore.create({ body: "b" }, "kim");
  // 라우터를 건너뛴 호출을 흉내 낸다: patch 에 team 이 들어 있어도 무시돼야 한다.
  const after = memoStore.update(made.id, { body: "b2", team: "secret" }, "kim");
  assert.equal(after.team, DEFAULT_TEAM, "본문에서 팀을 읽으면 라우터의 문턱이 우회된다");
  // 인자로 준 값만 반영된다(라우터가 검증을 마친 값이다).
  assert.equal(memoStore.update(made.id, { body: "b3" }, "kim", "secret").team, "secret");
});

test("값 없음으로 읽히는 이름은 팀이 될 수 없다", () => {
  const { teamStore } = rig();
  for (const bad of ["null", "undefined", "none", "nan"]) {
    assert.throws(() => teamStore.create({ name: bad }), { code: "invalid_team_name" }, bad);
  }
});

// ---- 이력의 오라클 (v0.13.1) -----------------------------------------------------------------
//
// 이동 줄만 감추는 것으로는 부족했다. 이동 **이전**에 쌓인 줄들이 옛 팀 스탬프로 남아 있어서,
// 비밀 팀에 들어간 글이 "줄은 있는데 삭제 기록은 없고 글은 404" 라는 **제 3의 상태**로 보였다.
// 그 차이가 곧 "그 글은 아직 어딘가 살아 있다"는 증명이다. 문을 둘로 나눠 닫는다:
// ① 그 글이 마지막에 있던 팀이 안 보이면 이력도 통째로 없다 ② 남은 줄 중 못 보던 시절은 뺀다.

test("이력의 세 상태가 한 답으로 무너진다 — 이동·이동 후 삭제·애초에 없음", async () => {
  const { memo } = rig();
  // boss 의 공개 글에 공개 상태의 수정 한 번(team-n 스탬프 줄이 쌓인다) — 이게 옛 누출의 재료였다.
  const seed = async (body) => {
    const { json } = await memo("POST", "/api/memos", { body }, "boss");
    await memo("PATCH", `/api/memos/${json.memo.id}`, { status: "doing" }, "boss");
    return json.memo.id;
  };
  const probe = async (id) => {
    const g = await memo("GET", `/api/memos/${id}`, {}, "staff");
    const h = await memo("GET", `/api/memos/${id}/history`, {}, "staff");
    return `${g.status}/${h.json.total}`;
  };

  const moved = await seed("one");
  await memo("PATCH", `/api/memos/${moved}`, { team: "secret" }, "boss");

  const gone = await seed("two");
  await memo("PATCH", `/api/memos/${gone}`, { team: "secret" }, "boss");
  await memo("DELETE", `/api/memos/${gone}`, {}, "boss");

  const never = 999999;
  assert.equal(await probe(moved), "404/0", "비밀 팀으로 옮겨진 글");
  assert.equal(await probe(gone), "404/0", "옮긴 뒤 비밀 팀에서 지워진 글");
  assert.equal(await probe(never), "404/0", "애초에 없는 글 — 셋이 같은 답이어야 한다");

  // 반대로 **공개 상태로 지워진 글**은 그대로 말해 준다. 그 글을 보던 사람들의 것이라서다.
  const deletedInPublic = await seed("three");
  await memo("DELETE", `/api/memos/${deletedInPublic}`, {}, "boss");
  assert.equal(await probe(deletedInPublic), "404/2");

  // 기록이 사라진 것도 아니다 — 팀 안에서는 그대로다.
  assert.equal((await memo("GET", `/api/memos/${moved}/history`, {}, "boss")).json.total, 2);
});

test("공개로 나온 글은 공개 이후의 이력만 보인다 — 비밀 시절에 누가 손댔는지는 그 팀의 것", async () => {
  const { memo } = rig();
  const { json: made } = await memo("POST", "/api/memos", { body: "b" }, "boss");
  const id = made.memo.id;
  await memo("PATCH", `/api/memos/${id}`, { team: "secret" }, "boss");
  await memo("PATCH", `/api/memos/${id}`, { title: "edited while confidential" }, "boss");
  await memo("PATCH", `/api/memos/${id}`, { team: DEFAULT_TEAM }, "boss");

  const seen = await memo("GET", `/api/memos/${id}/history`, {}, "staff");
  assert.equal(seen.status, 200);
  assert.equal(JSON.stringify(seen.json.history).includes("title"), false,
    "비밀 시절의 수정이 공개되면 그 팀에 누가 있었는지가 새어 나간다");
  assert.ok((await memo("GET", `/api/memos/${id}/history`, {}, "boss")).json.total > seen.json.total,
    "멤버는 전부 본다");
});

test("팀 비고는 문자열이어야 한다 — 상한을 옮기며 타입 검사를 잃었던 자리", () => {
  const { teamStore } = rig();
  assert.throws(() => teamStore.create({ name: "lab-y", note: { a: 1 } }), { code: "invalid_field" });
  assert.throws(() => teamStore.create({ name: "lab-y", note: "x".repeat(201) }), { code: "too_long" });
  // 거절 메시지가 자기 칸 이름을 불러야 고칠 사람이 무엇을 줄일지 안다.
  try { teamStore.create({ name: "lab-y", note: "x".repeat(201) }); }
  catch (e) { assert.match(e.message, /^note /); }
  assert.equal(teamStore.create({ name: "lab-y" }).note, "", "비고는 선택이다");
});

test("잘못 친 팀 이름은 '없는 팀'이지 '없는 경로'가 아니다 — 관리자 축", async () => {
  const { admin } = rig();
  const res = await admin("POST", "/api/admin/teams/SECRET/members", { user: "staff" });
  assert.equal(res.status, 404);
  assert.equal(res.json.code, "team_not_found", "admin_route_not_found 면 팀 이름을 의심하지 않는다");
  // 빈 사용자는 넣기·빼기 양쪽에서 같은 거절이다.
  for (const method of ["POST", "DELETE"]) {
    assert.equal((await admin(method, "/api/admin/teams/secret/members", { user: "  " })).json.code, "empty_user", method);
  }
});
