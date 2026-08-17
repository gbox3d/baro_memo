// `/api/memos*` 의 HTTP 계약. 이 파일의 주제는 둘이다.
//
//  1) **문턱은 하나이고 쓰기에 하나 더 붙는다.** 0.5.0 부터 읽기도 토큰이 필요하고, 쓰기는
//     거기에 더해 **사람** 토큰이어야 한다 — 서버가 user 를 찍어야 하기 때문이다. 본문으로는
//     user 를 사칭할 수 없어야 한다.
//  2) **거절은 원인마다 다른 상태여야 한다.** 토큰 0개(운영자가 고칠 일)와 토큰 불일치
//     (부르는 쪽이 고칠 일)를 같은 401 로 뭉개면, 운영자는 영영 맞는 값을 찾아 헤맨다.
import assert from "node:assert/strict";
import test from "node:test";

import { openDb } from "../src/core/db.mjs";
import { MemoStore } from "../src/memo/memo-store.mjs";
import { CommentStore } from "../src/memo/comment-store.mjs";
import { VoteStore } from "../src/memo/vote-store.mjs";
import { AuditStore } from "../src/memo/audit-store.mjs";
import { TokenStore } from "../src/auth/token-store.mjs";
import { createMemoRoutes } from "../src/memo/routes.mjs";

// 라우터 하나만 세운다. users 에 적은 사용자마다 토큰을 발급해 돌려준다.
//
// 라우터의 진짜 서명은 (method, pathname, query, body, headers) 다. 쿼리를 쓰지 않는 검사가
// 대부분이라 손잡이를 둘로 나눈다: handle 은 쿼리 없는 호출, list 는 쿼리를 거는 목록 호출.
function rig(users = ["kim"], { adminToken = "adm_test_value" } = {}) {
  const db = openDb(":memory:");
  const memoStore = new MemoStore(db);
  const commentStore = new CommentStore(db);
  const tokenStore = new TokenStore(db);
  const tokens = Object.fromEntries(users.map((u) => [u, tokenStore.issue({ user: u }).token]));
  const voteStore = new VoteStore(db);
  const auditStore = new AuditStore(db);
  const router = createMemoRoutes({ memoStore, tokenStore, commentStore, voteStore, auditStore, adminToken });
  // 읽기도 토큰이 필요해졌으므로 기본 헤더가 있다. 문턱 자체를 보는 검사는 `{}` 를 명시해 끈다.
  const reader = users.length ? { "x-memo-token": tokens[users[0]] } : {};
  return {
    handle: (method, path, body = {}, headers = reader) => router(method, path, null, body, headers),
    list: (query = "", headers = reader) => router("GET", "/api/memos", query, {}, headers),
    adminToken, memoStore, commentStore, voteStore, auditStore, tokenStore, tokens,
  };
}

test("이 축의 경로가 아니면 null — 다음 라우터로 넘어간다", async () => {
  const { handle } = rig();
  assert.equal(await handle("GET", "/api/health"), null);
  assert.equal(await handle("GET", "/api/memoranda"), null); // 접두사만 닮은 남의 경로
});

test("읽기에도 토큰이 필요하다 — 이 보드는 밖에서 닿는 주소로 열려 있다", async () => {
  const { list, memoStore } = rig();
  memoStore.create({ body: "first" }, "kim");

  const anonymous = await list("", {});
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.json.code, "memo_token_invalid");
  assert.match(anonymous.json.error, /reads as well as writes/, "왜 막혔는지가 문장에 있어야 한다");
  assert.equal((await list("", { "x-memo-token": "bm_wrong" })).status, 401);

  const res = await list();
  assert.equal(res.status, 200);
  assert.equal(res.json.count, 1);
  assert.equal(res.json.total, 1);
  assert.equal(res.json.memos[0].bodyPreview, "first");
});

test("관리자 토큰은 읽기까지 — 쓰기는 사람 토큰이어야 한다", async () => {
  const { handle, list, adminToken, memoStore } = rig();
  memoStore.create({ body: "first" }, "kim");
  const asOperator = { "x-memo-token": adminToken };

  // 관리자 페이지가 든 것이 이 값이다. 막으면 운영자가 자기 보드를 못 읽는다.
  assert.equal((await list("", asOperator)).status, 200);

  // 그러나 쓰기는 안 된다 — 이 값에는 사람이 없어서 user 에 찍을 것이 없다.
  const write = await handle("POST", "/api/memos", { body: "x" }, asOperator);
  assert.equal(write.status, 403);
  assert.equal(write.json.code, "admin_token_cannot_write");
});

test("토큰 0개는 401 이 아니라 503 — 고칠 사람이 다르다", async () => {
  const { handle } = rig([]);
  const res = await handle("POST", "/api/memos", { body: "x" }, { "x-memo-token": "bm_anything" });
  assert.equal(res.status, 503);
  assert.equal(res.json.code, "no_tokens_issued");
  // 읽기도 같은 처지다. 발급된 토큰이 하나도 없으면 어떤 값을 넣어도 읽을 수 없다 —
  // 401(네 값이 틀렸다)로 답하면 운영자는 영영 맞는 값을 찾아 헤맨다.
  const read = await handle("GET", "/api/memos", {}, {});
  assert.equal(read.status, 503);
  assert.equal(read.json.code, "no_tokens_issued");
});

test("쓰기는 토큰 없이 401, 틀린 토큰도 401", async () => {
  const { handle } = rig();
  const none = await handle("POST", "/api/memos", { body: "x" }, {});
  assert.equal(none.status, 401);
  assert.equal(none.json.code, "memo_token_invalid");
  assert.equal((await handle("POST", "/api/memos", { body: "x" }, { "x-memo-token": "bm_wrong" })).status, 401);
});

test("폐기된 토큰은 그 순간부터 401", async () => {
  const { handle, tokenStore, tokens } = rig(["kim"]);
  tokenStore.issue({ user: "lee" }); // 폐기 뒤에도 활성 토큰이 남아 503 으로 새지 않게
  const rec = tokenStore.list().find((t) => t.user === "kim");
  tokenStore.revoke(rec.id);
  const res = await handle("POST", "/api/memos", { body: "x" }, { "x-memo-token": tokens.kim });
  assert.equal(res.status, 401);
});

test("user 는 토큰에서 찍힌다 — 본문의 author 와는 별개다", async () => {
  const { handle, tokens } = rig(["kim"]);
  const made = await handle("POST", "/api/memos",
    { body: "fails at night", author: "claude/night" }, { "x-memo-token": tokens.kim });
  assert.equal(made.status, 201);
  assert.equal(made.json.memo.user, "kim");
  assert.equal(made.json.memo.updatedBy, "kim");
  assert.equal(made.json.memo.author, "claude/night");
});

// 규칙이 저장소에서만 서면 부르는 쪽은 500 을 본다 — "서버가 고장났다"로 읽히고, 고칠 사람이
// 자기라는 것을 모른다. 400 과 코드가 그 귀속을 정한다.
test("한글 글은 400 english_only 로 돌아온다 — 500 이면 고칠 사람을 잘못 가리킨다", async () => {
  const { handle, tokens } = rig(["kim"]);
  const auth = { "x-memo-token": tokens.kim };
  const res = await handle("POST", "/api/memos",
    { title: "업로드 실패", body: "토큰이 만료되면 조용히 실패한다." }, auth);
  assert.equal(res.status, 400);
  assert.equal(res.json.code, "english_only");
  assert.match(res.json.error, /backticks/, "거절이 대안을 가리켜야 다시 쓸 수 있다");

  const ok = await handle("POST", "/api/memos",
    { title: "Upload fails silently", body: "The token expired; see `토큰이 만료되었습니다` in the log." }, auth);
  assert.equal(ok.status, 201, "백틱에 담긴 원문 인용까지 막으면 식별자를 번역하게 된다");
});

test("본문으로 user 를 보내면 400 user_readonly — 조용한 무시는 사칭의 반쪽이다", async () => {
  const { handle, tokens } = rig(["kim"]);
  const res = await handle("POST", "/api/memos", { body: "x", user: "lee" }, { "x-memo-token": tokens.kim });
  assert.equal(res.status, 400);
  assert.equal(res.json.code, "user_readonly");
});

test("다른 사용자의 PATCH 는 updatedBy 만 바꾼다 — user 는 만든 사람의 것", async () => {
  const { handle, tokens } = rig(["kim", "lee"]);
  const made = await handle("POST", "/api/memos", { body: "x" }, { "x-memo-token": tokens.kim });
  const { id } = made.json.memo;
  const patched = await handle("PATCH", `/api/memos/${id}`, { status: "done" }, { "x-memo-token": tokens.lee });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.memo.user, "kim");
  assert.equal(patched.json.memo.updatedBy, "lee");
});

test("Authorization: Bearer 로도 통과한다", async () => {
  const { handle, tokens } = rig(["kim"]);
  const res = await handle("POST", "/api/memos", { body: "x" }, { authorization: `Bearer ${tokens.kim}` });
  assert.equal(res.status, 201);
});

test("접수 → 조회 → 부분 갱신 → 삭제 왕복", async () => {
  const { handle, tokens } = rig(["kim"]);
  const auth = { "x-memo-token": tokens.kim };
  const made = await handle("POST", "/api/memos", { title: "night read", body: "face 3 fails" }, auth);
  const { id } = made.json.memo;

  const got = await handle("GET", `/api/memos/${id}`);
  assert.equal(got.json.memo.title, "night read");

  const patched = await handle("PATCH", `/api/memos/${id}`, { status: "done" }, auth);
  assert.equal(patched.json.memo.status, "done");
  assert.equal(patched.json.memo.body, "face 3 fails"); // 안 보낸 필드는 그대로

  const gone = await handle("DELETE", `/api/memos/${id}`, {}, auth);
  assert.equal(gone.json.deleted, true);
  assert.equal((await handle("GET", `/api/memos/${id}`)).status, 404);
});

test("없는 id 와 숫자가 아닌 id 는 똑같이 404", async () => {
  const { handle } = rig();
  for (const id of ["999", "abc", "1.5", "-2"]) {
    const res = await handle("GET", `/api/memos/${id}`);
    assert.equal(res.status, 404, `id=${id}`);
    assert.equal(res.json.code, "memo_not_found");
  }
});

test("잘못된 본문은 400 + 코드 (인증을 통과한 뒤의 이야기다)", async () => {
  const { handle, tokens } = rig(["kim"]);
  const auth = { "x-memo-token": tokens.kim };
  const empty = await handle("POST", "/api/memos", { body: "  " }, auth);
  assert.equal(empty.status, 400);
  assert.equal(empty.json.code, "empty_body");

  const made = await handle("POST", "/api/memos", { body: "x" }, auth);
  const noop = await handle("PATCH", `/api/memos/${made.json.memo.id}`, { tilte: "오타" }, auth);
  assert.equal(noop.status, 400);
  assert.equal(noop.json.code, "no_fields");
});

// ---- 목록 쿼리 ---------------------------------------------------------------------------
//
// 이 축의 주제: **목록은 색인이고 전문은 문서다.** 보드는 모든 세션이 작업 전에 읽는 표면이라
// 목록이 전문을 실으면 게시물 수만큼 모든 세션의 토큰이 샌다.

function board(memoStore) {
  memoStore.create({ title: "night plates", body: "n".repeat(500), author: "claude/lpr" }, "kim");
  memoStore.create({
    title: "tunnel URL churn", status: "doing", author: "claude/tunnel",
    // 제목에 없는 낱말을 본문에 심어 둔다 — 교차 검색의 실제 상황이 이 모양이다.
    body: "cloudflared quick tunnel hands out a new URL on every restart",
  }, "lee");
  memoStore.create({ title: "sim console", body: "install and update shipped", status: "done", author: "claude/sim" }, "kim");
}

test("목록은 요약이다 — body 는 아예 없고 미리보기와 길이가 온다", async () => {
  const { list, memoStore } = rig();
  memoStore.create({ body: "x".repeat(500) }, "kim");
  const [memo] = (await list()).json.memos;
  assert.equal(memo.body, undefined, "목록이 전문을 실었습니다");
  assert.equal(memo.bodyPreview.length, 200);
  assert.equal(memo.bodyLength, 500);
  // 요약에도 귀속은 남는다 — 누가 썼는지 보려고 전문을 받아야 하면 절약이 아니다.
  assert.equal(memo.user, "kim");
});

test("?full=1 이면 전문이 온다 — 값 없는 ?full 도 같다", async () => {
  const { list, memoStore } = rig();
  memoStore.create({ body: "whole thing" }, "kim");
  for (const query of ["full=1", "full=true", "full"]) {
    const [memo] = (await list(query)).json.memos;
    assert.equal(memo.body, "whole thing", query);
    assert.equal(memo.bodyPreview, undefined, `${query}: 두 모양이 섞였습니다`);
  }
  assert.equal((await list("full=0")).json.memos[0].body, undefined);
});

test("status 는 콤마 목록 — '지금 살아 있는 일'이 한 번의 호출이다", async () => {
  const { list, memoStore } = rig();
  board(memoStore);
  assert.deepEqual((await list("status=open")).json.memos.map((m) => m.title), ["night plates"]);
  assert.deepEqual(
    (await list("status=open,doing")).json.memos.map((m) => m.title),
    ["tunnel URL churn", "night plates"], // 최신순
  );
  const bad = await list("status=보류");
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, "invalid_status");
});

test("q 는 제목과 본문 양쪽을 본다 · author 는 부분, user 는 정확 일치", async () => {
  const { list, memoStore } = rig();
  board(memoStore);
  assert.deepEqual((await list("q=tunnel")).json.memos.map((m) => m.title), ["tunnel URL churn"]);
  assert.equal((await list("q=TUNNEL")).json.count, 1, "대소문자를 가렸습니다");
  // 제목에 없고 본문에만 있는 문자열 — 프로젝트를 가로질러 찾을 때의 그 상황이다.
  assert.deepEqual((await list("q=cloudflared")).json.memos.map((m) => m.title), ["tunnel URL churn"]);
  assert.equal((await list("author=claude/")).json.count, 3);
  assert.equal((await list("user=kim")).json.count, 2);
  assert.equal((await list("user=ki")).json.count, 0, "user 가 부분 일치했습니다");
  // 필터는 겹쳐서 걸린다 (AND) — 검색과도 겹친다.
  assert.equal((await list("user=kim&status=done")).json.count, 1);
  assert.equal((await list("q=console&status=open")).json.count, 0);
});

test("검색 결과에는 snippet 이 붙는다 — 왜 맞았는지가 전문 없이 보이게", async () => {
  const { list, memoStore } = rig();
  board(memoStore);
  const [hit] = (await list("q=cloudflared")).json.memos;
  assert.match(hit.snippet, /\[cloudflared\]/i);
  // 검색이 아닐 때는 붙지 않는다 — 없는 칸을 만들지 않는다.
  assert.equal((await list()).json.memos[0].snippet, undefined);
});

test("낱말 여럿은 AND — 검색창의 상식대로", async () => {
  const { list, memoStore } = rig();
  board(memoStore);
  assert.equal((await list("q=cloudflared tunnel")).json.count, 1);
  assert.equal((await list("q=cloudflared console")).json.count, 0, "OR 로 동작했습니다");
});

test("FTS5 문법 문자가 든 검색어도 500 이 아니라 결과다", async () => {
  const { list, memoStore } = rig();
  memoStore.create({ title: "toolchain", body: "built with C++ and node-gyp; see title:foo" }, "kim");
  for (const q of ["C%2B%2B", "node-gyp", "title%3Afoo", "%22unbalanced"]) {
    const res = await list(`q=${q}`);
    assert.equal(res.status, 200, `${q} 가 500 이 됐습니다`);
  }
  assert.equal((await list("q=C%2B%2B")).json.count, 1);
  assert.equal((await list("q=node-gyp")).json.count, 1);
});

test("trigram 하한보다 짧은 검색어는 조용한 0건이 아니라 400", async () => {
  const { list, memoStore } = rig();
  board(memoStore);
  const res = await list("q=UI");
  assert.equal(res.status, 400);
  assert.equal(res.json.code, "query_too_short");
  // 긴 낱말에 짧은 낱말이 섞여도 마찬가지 — 조용히 버리면 결과가 거짓말이 된다.
  assert.equal((await list("q=tunnel UI")).json.code, "query_too_short");
});

test("limit·offset 은 자르되 total 로 잘렸음을 알린다", async () => {
  const { list, memoStore } = rig();
  board(memoStore);
  const first = await list("limit=2");
  assert.equal(first.json.count, 2);
  assert.equal(first.json.total, 3, "total 이 없으면 첫 장인지 전부인지 알 수 없다");
  assert.equal(first.json.limit, 2);
  const second = await list("limit=2&offset=2");
  assert.equal(second.json.count, 1);
  assert.equal(second.json.total, 3);
  assert.equal(second.json.memos[0].title, "night plates");
  // total 은 필터 뒤·자르기 전이다.
  assert.equal((await list("status=done&limit=1")).json.total, 1);
});

test("망가진 limit·offset·full 은 400 invalid_param", async () => {
  const { list } = rig();
  for (const query of ["limit=0", "limit=201", "limit=abc", "limit=1.5", "offset=-1", "full=maybe"]) {
    const res = await list(query);
    assert.equal(res.status, 400, query);
    assert.equal(res.json.code, "invalid_param", query);
  }
});

test("모르는 쿼리 이름은 400 — 오타가 '필터 걸림'으로 읽히지 않게", async () => {
  const { list, memoStore } = rig();
  board(memoStore);
  const res = await list("staus=open");
  assert.equal(res.status, 400);
  assert.equal(res.json.code, "unknown_param");
  assert.match(res.json.error, /staus/);
});

test("지원하지 않는 메서드는 405 — 종단 404 로 흘리면 '경로가 없다'는 거짓말이 된다", async () => {
  const { handle, tokens } = rig(["kim"]);
  const auth = { "x-memo-token": tokens.kim };
  const made = await handle("POST", "/api/memos", { body: "x" }, auth);
  assert.equal((await handle("PUT", `/api/memos/${made.json.memo.id}`, { body: "y" }, auth)).status, 405);
});

// ---- 댓글 --------------------------------------------------------------------------------
//
// 문턱은 메모 축과 같다(읽기도 토큰, 쓰기는 사람 토큰). 여기서 따로 지켜야 하는 것은 **경로가
// 사실과 맞는가** 다 — 댓글은 늘 어떤 메모의 것이고, 경로가 거짓이면 지운 사람은 자기가 무엇을
// 지웠는지 모른다.

test("한 건은 문서다 — 메모와 댓글을 함께 준다", async () => {
  const { handle, tokens } = rig();
  const auth = { "x-memo-token": tokens.kim };
  const { json: made } = await handle("POST", "/api/memos", { title: "t", body: "b" }, auth);

  await handle("POST", `/api/memos/${made.memo.id}/comments`, { body: "first" }, auth);
  await handle("POST", `/api/memos/${made.memo.id}/comments`, { body: "second", author: "claude/x" }, auth);

  const res = await handle("GET", `/api/memos/${made.memo.id}`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.comments.map((c) => c.body), ["first", "second"]);
  assert.equal(res.json.memo.commentCount, 2, "개수는 목록에서도 같은 이름으로 보인다");
});

test("댓글도 읽기에 토큰이 필요하고, 쓰기는 토큰에서 user 를 찍는다", async () => {
  const { handle, tokens } = rig(["kim"]);
  const auth = { "x-memo-token": tokens.kim };
  const { json: made } = await handle("POST", "/api/memos", { body: "b" }, auth);
  const path = `/api/memos/${made.memo.id}/comments`;

  assert.equal((await handle("GET", path, {}, {})).status, 401, "댓글 읽기도 문턱 위에 있다");
  const open = await handle("GET", path);
  assert.equal(open.status, 200);
  assert.deepEqual(open.json, { count: 0, memoId: made.memo.id, comments: [] });

  const noToken = await handle("POST", path, { body: "x" }, {});
  assert.equal(noToken.status, 401);
  assert.equal(noToken.json.code, "memo_token_invalid");

  const posted = await handle("POST", path, { body: "added", author: "claude/x" }, auth);
  assert.equal(posted.status, 201);
  assert.equal(posted.json.comment.user, "kim");
  assert.equal(posted.json.comment.author, "claude/x");
  assert.equal(posted.json.comment.memoId, made.memo.id);

  // 본문으로 user 를 선언하는 길은 메모와 마찬가지로 막혀 있다.
  const spoof = await handle("POST", path, { body: "x", user: "lee" }, auth);
  assert.equal(spoof.status, 400);
  assert.equal(spoof.json.code, "user_readonly");
});

test("없는 메모의 댓글은 404 — 조용히 떠도는 글을 만들지 않는다", async () => {
  const { handle, tokens } = rig();
  const auth = { "x-memo-token": tokens.kim };
  for (const [method, body] of [["GET", {}], ["POST", { body: "x" }]]) {
    const res = await handle(method, "/api/memos/999/comments", body, auth);
    assert.equal(res.status, 404);
    assert.equal(res.json.code, "memo_not_found");
  }
  const bad = await handle("GET", "/api/memos/abc/comments");
  assert.equal(bad.status, 404, "숫자가 아닌 id 도 '그런 메모는 없다'다");
});

test("댓글 삭제는 경로가 맞아야 한다 — 남의 메모 밑으로는 못 지운다", async () => {
  const { handle, tokens } = rig();
  const auth = { "x-memo-token": tokens.kim };
  const { json: a } = await handle("POST", "/api/memos", { body: "a" }, auth);
  const { json: b } = await handle("POST", "/api/memos", { body: "b" }, auth);
  const { json: made } = await handle("POST", `/api/memos/${a.memo.id}/comments`, { body: "to delete" }, auth);

  const wrongPath = await handle("DELETE", `/api/memos/${b.memo.id}/comments/${made.comment.id}`, {}, auth);
  assert.equal(wrongPath.status, 404);
  assert.equal(wrongPath.json.code, "comment_not_found");

  const noToken = await handle("DELETE", `/api/memos/${a.memo.id}/comments/${made.comment.id}`, {}, {});
  assert.equal(noToken.status, 401);

  const ok = await handle("DELETE", `/api/memos/${a.memo.id}/comments/${made.comment.id}`, {}, auth);
  assert.equal(ok.status, 200);
  assert.equal(ok.json.deleted, true);
  assert.equal((await handle("GET", `/api/memos/${a.memo.id}/comments`)).json.count, 0);
});

test("댓글에는 수정이 없다 — PATCH 는 405 이고 404 로 흘리지 않는다", async () => {
  const { handle, tokens } = rig();
  const auth = { "x-memo-token": tokens.kim };
  const { json: made } = await handle("POST", "/api/memos", { body: "b" }, auth);
  const { json: c } = await handle("POST", `/api/memos/${made.memo.id}/comments`, { body: "x" }, auth);

  const patchOne = await handle("PATCH", `/api/memos/${made.memo.id}/comments/${c.comment.id}`, { body: "y" }, auth);
  assert.equal(patchOne.status, 405, "404 로 흘리면 '경로가 없다'는 거짓말이 된다");

  const patchList = await handle("PATCH", `/api/memos/${made.memo.id}/comments`, { body: "y" }, auth);
  assert.equal(patchList.status, 405);
});

test("목록은 메모마다 commentCount 를 싣는다 — 있는지 보려고 한 번 더 부르지 않게", async () => {
  const { handle, list, tokens } = rig();
  const auth = { "x-memo-token": tokens.kim };
  const { json: a } = await handle("POST", "/api/memos", { body: "a" }, auth);
  await handle("POST", "/api/memos", { body: "b" }, auth);
  await handle("POST", `/api/memos/${a.memo.id}/comments`, { body: "one" }, auth);

  const res = await list("");
  const counts = Object.fromEntries(res.json.memos.map((m) => [m.id, m.commentCount]));
  assert.equal(counts[a.memo.id], 1);
  assert.equal(Object.values(counts).filter((n) => n === 0).length, 1);
});

// ---- 이력 --------------------------------------------------------------------------------
//
// 사용자 축의 이력은 **사실만** 준다. 자기 글이 고쳐졌는데 본인만 모르는 상태를 만들지 않으면서,
// 덮인 본문과 지워진 제목은 관리자 축에만 남긴다 — 그 경계가 이 검사의 주제다.

test("이력은 언제·누가·무엇을 말하고, 내용은 말하지 않는다", async () => {
  const { handle, tokens } = rig(["kim", "lee"]);
  const mine = { "x-memo-token": tokens.kim };
  const theirs = { "x-memo-token": tokens.lee };
  const { json: made } = await handle("POST", "/api/memos", { title: "my post", body: "original body" }, mine);

  await handle("PATCH", `/api/memos/${made.memo.id}`, { body: "body someone else overwrote", status: "doing" }, theirs);

  const res = await handle("GET", `/api/memos/${made.memo.id}/history`, {}, mine);
  assert.equal(res.status, 200);
  assert.equal(res.json.total, 1);
  const [entry] = res.json.history;
  assert.equal(entry.action, "memo_update");
  assert.equal(entry.actor, "lee", "누가 고쳤는지는 당사자가 알아야 한다");
  assert.ok(entry.at, "언제인지도");
  assert.deepEqual(entry.fields, ["body", "status"], "무엇이 바뀌었는지는 칸 이름까지");

  // 내용은 없다. 있으면 "관리자 전용" 이 이름뿐이 된다.
  assert.equal(entry.before, undefined);
  assert.equal(entry.after, undefined);
  assert.equal(entry.summary, undefined);
  assert.equal(JSON.stringify(res.json).includes("original body"), false);
  assert.equal(JSON.stringify(res.json).includes("body someone else overwrote"), false);
});

test("메모가 지워져도 이력은 답한다 — 그게 이 축이 있는 이유다", async () => {
  const { handle, tokens } = rig(["kim", "lee"]);
  const mine = { "x-memo-token": tokens.kim };
  const { json: made } = await handle("POST", "/api/memos", { title: "about to vanish", body: "b" }, mine);
  await handle("POST", `/api/memos/${made.memo.id}/comments`, { body: "a comment" }, mine);
  await handle("DELETE", `/api/memos/${made.memo.id}`, {}, { "x-memo-token": tokens.lee });

  assert.equal((await handle("GET", `/api/memos/${made.memo.id}`, {}, mine)).status, 404, "메모는 없다");

  const res = await handle("GET", `/api/memos/${made.memo.id}/history`, {}, mine);
  assert.equal(res.status, 200, "이력까지 404 면 '그 메모 어디 갔나'를 물어볼 곳이 없다");
  const [entry] = res.json.history;
  assert.equal(entry.action, "memo_delete");
  assert.equal(entry.actor, "lee");
  assert.equal(entry.memoOwner, "kim");
  assert.equal(entry.commentsRemoved, 1);
  assert.equal(JSON.stringify(res.json).includes("about to vanish"), false, "지워진 제목도 내용이다");
});

test("이력에도 토큰이 필요하고, 쓰기 경로는 없다", async () => {
  const { handle, tokens } = rig();
  const { json: made } = await handle("POST", "/api/memos", { body: "b" }, { "x-memo-token": tokens.kim });
  assert.equal((await handle("GET", `/api/memos/${made.memo.id}/history`, {}, {})).status, 401);
  assert.equal((await handle("POST", `/api/memos/${made.memo.id}/history`, {}, {})).status, 401);
  assert.equal((await handle("POST", `/api/memos/${made.memo.id}/history`, {})).status, 405);
  assert.equal((await handle("GET", "/api/memos/abc/history")).status, 404);
});

test("아무도 손대지 않은 글의 이력은 비어 있다 — 없는 것과 잃은 것은 다르다", async () => {
  const { handle, tokens } = rig();
  const { json: made } = await handle("POST", "/api/memos", { body: "b" }, { "x-memo-token": tokens.kim });
  // 같은 값으로 덮은 PATCH 는 이력이 아니다.
  await handle("PATCH", `/api/memos/${made.memo.id}`, { body: "b" }, { "x-memo-token": tokens.kim });
  const res = await handle("GET", `/api/memos/${made.memo.id}/history`);
  assert.deepEqual(res.json, { count: 0, total: 0, memoId: made.memo.id, history: [] });
});

// ---- 중요도 -------------------------------------------------------------------------------
//
// 이 축의 계약은 하나로 요약된다: **쓰는 것은 언제나 자기 점수 하나**다. 그래서 PUT 이고
// (멱등하다), 그래서 남의 표가 사라지는 경로가 없고, 그래서 이력이 필요 없다.

test("PUT 은 자기 점수를 놓는다 — 두 번 보내도 두 배가 되지 않는다", async () => {
  const { handle, tokens } = rig(["kim", "lee"]);
  const asKim = { "x-memo-token": tokens.kim };
  const asLee = { "x-memo-token": tokens.lee };
  const { json: made } = await handle("POST", "/api/memos", { body: "b" }, asKim);
  const path = `/api/memos/${made.memo.id}/score`;

  const first = await handle("PUT", path, { value: 4 }, asKim);
  assert.equal(first.status, 200);
  assert.equal(first.json.score, 4);
  assert.equal(first.json.voters, 1);
  assert.equal(first.json.myScore, 4);

  // 재시도는 안전해야 한다 — 이 성질이 없으면 점수는 열의(熱意)를 재게 된다.
  const again = await handle("PUT", path, { value: 4 }, asKim);
  assert.equal(again.json.score, 4, "같은 값을 다시 보내는 것은 아무 일도 아니다");

  const changed = await handle("PUT", path, { value: 1 }, asKim);
  assert.equal(changed.json.score, 1, "덮이는 것은 자기 값이다");

  const other = await handle("PUT", path, { value: 5 }, asLee);
  assert.equal(other.json.score, 6);
  assert.equal(other.json.voters, 2);
  assert.equal(other.json.myScore, 5, "myScore 는 부르는 토큰의 값이다");
  assert.deepEqual(other.json.scores.map((s) => [s.user, s.value]), [["lee", 5], ["kim", 1]]);
});

test("점수는 1..5 이고, 0 은 취소하는 길을 가리킨다", async () => {
  const { handle, tokens } = rig();
  const mine = { "x-memo-token": tokens.kim };
  const { json: made } = await handle("POST", "/api/memos", { body: "b" }, mine);
  const path = `/api/memos/${made.memo.id}/score`;

  for (const value of [6, -1, 2.5, "x", null]) {
    const res = await handle("PUT", path, { value }, mine);
    assert.equal(res.status, 400, `통과하면 안 된다: ${String(value)}`);
    assert.equal(res.json.code, "invalid_score");
  }
  const zero = await handle("PUT", path, { value: 0 }, mine);
  assert.equal(zero.json.code, "invalid_score");
  assert.match(zero.json.error, /DELETE/, "0 을 보낸 사람이 다음에 무엇을 할지가 그 문장에 있어야 한다");
  // 본문 자체가 없는 것도 같은 거절이다 — 조용히 1 로 떨어지지 않는다.
  assert.equal((await handle("PUT", path, {}, mine)).json.code, "invalid_score");
});

test("DELETE 는 자기 표만 거둔다 — 남의 표는 그대로다", async () => {
  const { handle, tokens } = rig(["kim", "lee"]);
  const asKim = { "x-memo-token": tokens.kim };
  const asLee = { "x-memo-token": tokens.lee };
  const { json: made } = await handle("POST", "/api/memos", { body: "b" }, asKim);
  const path = `/api/memos/${made.memo.id}/score`;
  await handle("PUT", path, { value: 5 }, asKim);
  await handle("PUT", path, { value: 3 }, asLee);

  const gone = await handle("DELETE", path, {}, asKim);
  assert.equal(gone.json.deleted, true);
  assert.equal(gone.json.score, 3);
  assert.equal(gone.json.myScore, 0);
  assert.deepEqual(gone.json.scores.map((s) => s.user), ["lee"]);

  const twice = await handle("DELETE", path, {}, asKim);
  assert.equal(twice.json.deleted, false, "없던 표를 거두는 것은 실패가 아니다 — 이미 원하는 상태다");
  assert.equal(twice.json.score, 3);
});

test("관리자 토큰은 점수를 볼 수는 있어도 줄 수는 없다", async () => {
  const { handle, tokens, adminToken } = rig();
  const asOperator = { "x-memo-token": adminToken };
  const { json: made } = await handle("POST", "/api/memos", { body: "b" }, { "x-memo-token": tokens.kim });
  const path = `/api/memos/${made.memo.id}/score`;
  await handle("PUT", path, { value: 4 }, { "x-memo-token": tokens.kim });

  const read = await handle("GET", path, {}, asOperator);
  assert.equal(read.status, 200);
  assert.equal(read.json.score, 4);
  assert.equal(read.json.myScore, 0, "그 값에는 사람이 없으니 표도 없다");

  // 쓰기는 사람 토큰만이다 — 찍을 사람이 없는 표는 귀속이 없다.
  assert.equal((await handle("PUT", path, { value: 5 }, asOperator)).json.code, "admin_token_cannot_write");
  assert.equal((await handle("DELETE", path, {}, asOperator)).json.code, "admin_token_cannot_write");
  assert.equal((await handle("GET", path, {}, {})).status, 401, "읽기에도 토큰이 필요하다");
});

test("없는 메모에는 점수를 줄 수 없고, 지워진 글의 점수는 404 다", async () => {
  const { handle, tokens } = rig();
  const mine = { "x-memo-token": tokens.kim };
  assert.equal((await handle("PUT", "/api/memos/9999/score", { value: 3 }, mine)).json.code, "memo_not_found");
  assert.equal((await handle("GET", "/api/memos/abc/score", {}, mine)).json.code, "memo_not_found");

  const { json: made } = await handle("POST", "/api/memos", { body: "b" }, mine);
  const path = `/api/memos/${made.memo.id}/score`;
  await handle("PUT", path, { value: 5 }, mine);
  await handle("DELETE", `/api/memos/${made.memo.id}`, {}, mine);
  // 이력과 다른 판단이다 — 표는 글과 함께 사라졌고, 여기서 0 을 돌려주면 "아무도 중요하다고
  // 안 했다" 는 **다른 사실**이 된다.
  assert.equal((await handle("GET", path, {}, mine)).status, 404);

  // 이 경로에 없는 메서드는 405 다. 404 로 흘리면 "경로가 없다"는 거짓말이 된다.
  const { json: other } = await handle("POST", "/api/memos", { body: "b2" }, mine);
  assert.equal((await handle("POST", `/api/memos/${other.memo.id}/score`, { value: 3 }, mine)).status, 405);
});

test("목록과 한 건이 같은 세 값을 싣고, sort=score 로 중요도순이 된다", async () => {
  const { handle, list, tokens } = rig(["kim", "lee"]);
  const asKim = { "x-memo-token": tokens.kim };
  const asLee = { "x-memo-token": tokens.lee };
  const { json: first } = await handle("POST", "/api/memos", { body: "first" }, asKim);
  const { json: second } = await handle("POST", "/api/memos", { body: "second" }, asKim);
  await handle("PUT", `/api/memos/${first.memo.id}/score`, { value: 5 }, asKim);
  await handle("PUT", `/api/memos/${first.memo.id}/score`, { value: 2 }, asLee);

  const byNew = await list("", asLee);
  assert.deepEqual(byNew.json.memos.map((m) => m.id), [second.memo.id, first.memo.id], "기본은 최신순 그대로다");

  const byScore = await list("sort=score", asLee);
  assert.deepEqual(byScore.json.memos.map((m) => m.id), [first.memo.id, second.memo.id]);
  const [top] = byScore.json.memos;
  assert.equal(top.score, 7);
  assert.equal(top.voters, 2);
  assert.equal(top.myScore, 2, "목록의 myScore 도 부르는 토큰의 값이다");

  // 한 건도 같은 세 값을 준다 — 목록과 한 건이 다르면 소비자가 파서를 둘 두게 된다.
  const one = await handle("GET", `/api/memos/${first.memo.id}`, {}, asLee);
  assert.equal(one.json.memo.score, 7);
  assert.equal(one.json.memo.myScore, 2);
  assert.deepEqual(one.json.scores.map((s) => [s.user, s.value]), [["kim", 5], ["lee", 2]]);

  // 모르는 정렬 이름은 조용히 기본값으로 떨어지지 않는다.
  const bogus = await list("sort=popular", asLee);
  assert.equal(bogus.status, 400);
  assert.equal(bogus.json.code, "invalid_param");
});

test("세 표면이 같은 수를 말한다 — 여러 사람이 **같은 값**을 줬을 때가 갈라지는 자리다", async () => {
  const { handle, list, tokens } = rig(["kim", "lee", "park"]);
  const { json: made } = await handle("POST", "/api/memos", { body: "b" }, { "x-memo-token": tokens.kim });
  const id = made.memo.id;
  // 셋이 **똑같이 1 점씩.** 값이 서로 다르면 "사람 수"와 "서로 다른 값의 수"가 우연히 같아져,
  // 두 수치가 갈라져도 검사가 통과한다(합계·사람 수를 두 곳에서 세면 실제로 갈라진다).
  for (const who of ["kim", "lee", "park"]) {
    await handle("PUT", `/api/memos/${id}/score`, { value: 1 }, { "x-memo-token": tokens[who] });
  }

  const asKim = { "x-memo-token": tokens.kim };
  const fromScore = (await handle("GET", `/api/memos/${id}/score`, {}, asKim)).json;
  const fromOne = (await handle("GET", `/api/memos/${id}`, {}, asKim)).json.memo;
  const fromList = (await list("", asKim)).json.memos.find((m) => m.id === id);

  for (const [where, got] of [["score", fromScore], ["one", fromOne], ["list", fromList]]) {
    assert.equal(got.score, 3, `${where} 의 합계가 다르다`);
    assert.equal(got.voters, 3, `${where} 의 사람 수가 다르다 — 같은 값을 준 세 사람은 세 사람이다`);
    assert.equal(got.myScore, 1, `${where} 의 내 점수가 다르다`);
  }
});
