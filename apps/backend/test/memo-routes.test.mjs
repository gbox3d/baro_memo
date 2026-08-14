// `/api/memos*` 의 HTTP 계약. 이 파일의 주제는 둘이다.
//
//  1) **쓰기와 읽기의 문턱이 다르다.** 읽기는 열려 있고, 쓰기는 사용자 토큰에서 user 를
//     역산해 찍는다 — 본문으로는 user 를 사칭할 수 없어야 한다.
//  2) **거절은 원인마다 다른 상태여야 한다.** 토큰 0개(운영자가 고칠 일)와 토큰 불일치
//     (부르는 쪽이 고칠 일)를 같은 401 로 뭉개면, 운영자는 영영 맞는 값을 찾아 헤맨다.
import assert from "node:assert/strict";
import test from "node:test";

import { openDb } from "../src/core/db.mjs";
import { MemoStore } from "../src/memo/memo-store.mjs";
import { CommentStore } from "../src/memo/comment-store.mjs";
import { TokenStore } from "../src/auth/token-store.mjs";
import { createMemoRoutes } from "../src/memo/routes.mjs";

// 라우터 하나만 세운다. users 에 적은 사용자마다 토큰을 발급해 돌려준다.
//
// 라우터의 진짜 서명은 (method, pathname, query, body, headers) 다. 쿼리를 쓰지 않는 검사가
// 대부분이라 손잡이를 둘로 나눈다: handle 은 쿼리 없는 호출, list 는 쿼리를 거는 목록 호출.
function rig(users = ["kim"]) {
  const db = openDb(":memory:");
  const memoStore = new MemoStore(db);
  const commentStore = new CommentStore(db);
  const tokenStore = new TokenStore(db);
  const tokens = Object.fromEntries(users.map((u) => [u, tokenStore.issue({ user: u }).token]));
  const router = createMemoRoutes({ memoStore, tokenStore, commentStore });
  return {
    handle: (method, path, body = {}, headers = {}) => router(method, path, null, body, headers),
    list: (query = "") => router("GET", "/api/memos", query, {}, {}),
    memoStore, commentStore, tokenStore, tokens,
  };
}

test("이 축의 경로가 아니면 null — 다음 라우터로 넘어간다", async () => {
  const { handle } = rig();
  assert.equal(await handle("GET", "/api/health"), null);
  assert.equal(await handle("GET", "/api/memoranda"), null); // 접두사만 닮은 남의 경로
});

test("읽기는 토큰 없이 열려 있다", async () => {
  const { list, memoStore } = rig();
  memoStore.create({ body: "first" }, "kim");
  const res = await list();
  assert.equal(res.status, 200);
  assert.equal(res.json.count, 1);
  assert.equal(res.json.total, 1);
  assert.equal(res.json.memos[0].bodyPreview, "first");
});

test("토큰 0개는 401 이 아니라 503 — 고칠 사람이 다르다", async () => {
  const { handle } = rig([]);
  const res = await handle("POST", "/api/memos", { body: "x" }, { "x-memo-token": "bm_anything" });
  assert.equal(res.status, 503);
  assert.equal(res.json.code, "no_tokens_issued");
  // 읽기는 계속 된다.
  assert.equal((await handle("GET", "/api/memos", {}, {})).status, 200);
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
    { body: "밤에 실패", author: "claude/night" }, { "x-memo-token": tokens.kim });
  assert.equal(made.status, 201);
  assert.equal(made.json.memo.user, "kim");
  assert.equal(made.json.memo.updatedBy, "kim");
  assert.equal(made.json.memo.author, "claude/night");
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
  const made = await handle("POST", "/api/memos", { title: "야간 판독", body: "3번 면 실패" }, auth);
  const { id } = made.json.memo;

  const got = await handle("GET", `/api/memos/${id}`, {}, {});
  assert.equal(got.json.memo.title, "야간 판독");

  const patched = await handle("PATCH", `/api/memos/${id}`, { status: "done" }, auth);
  assert.equal(patched.json.memo.status, "done");
  assert.equal(patched.json.memo.body, "3번 면 실패"); // 안 보낸 필드는 그대로

  const gone = await handle("DELETE", `/api/memos/${id}`, {}, auth);
  assert.equal(gone.json.deleted, true);
  assert.equal((await handle("GET", `/api/memos/${id}`, {}, {})).status, 404);
});

test("없는 id 와 숫자가 아닌 id 는 똑같이 404", async () => {
  const { handle } = rig();
  for (const id of ["999", "abc", "1.5", "-2"]) {
    const res = await handle("GET", `/api/memos/${id}`, {}, {});
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
// 문턱은 메모 축과 같다(읽기는 열려 있고 쓰기는 토큰). 여기서 따로 지켜야 하는 것은 **경로가
// 사실과 맞는가** 다 — 댓글은 늘 어떤 메모의 것이고, 경로가 거짓이면 지운 사람은 자기가 무엇을
// 지웠는지 모른다.

test("한 건은 문서다 — 메모와 댓글을 함께 준다", async () => {
  const { handle, tokens } = rig();
  const auth = { "x-memo-token": tokens.kim };
  const { json: made } = await handle("POST", "/api/memos", { title: "t", body: "b" }, auth);

  await handle("POST", `/api/memos/${made.memo.id}/comments`, { body: "먼저" }, auth);
  await handle("POST", `/api/memos/${made.memo.id}/comments`, { body: "나중", author: "claude/x" }, auth);

  const res = await handle("GET", `/api/memos/${made.memo.id}`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.comments.map((c) => c.body), ["먼저", "나중"]);
  assert.equal(res.json.memo.commentCount, 2, "개수는 목록에서도 같은 이름으로 보인다");
});

test("댓글 읽기는 열려 있고 쓰기는 토큰에서 user 를 찍는다", async () => {
  const { handle, tokens } = rig(["kim"]);
  const auth = { "x-memo-token": tokens.kim };
  const { json: made } = await handle("POST", "/api/memos", { body: "b" }, auth);
  const path = `/api/memos/${made.memo.id}/comments`;

  const open = await handle("GET", path);
  assert.equal(open.status, 200);
  assert.deepEqual(open.json, { count: 0, memoId: made.memo.id, comments: [] });

  const noToken = await handle("POST", path, { body: "x" });
  assert.equal(noToken.status, 401);
  assert.equal(noToken.json.code, "memo_token_invalid");

  const posted = await handle("POST", path, { body: "달았다", author: "claude/x" }, auth);
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
  const { json: made } = await handle("POST", `/api/memos/${a.memo.id}/comments`, { body: "지울 것" }, auth);

  const wrongPath = await handle("DELETE", `/api/memos/${b.memo.id}/comments/${made.comment.id}`, {}, auth);
  assert.equal(wrongPath.status, 404);
  assert.equal(wrongPath.json.code, "comment_not_found");

  const noToken = await handle("DELETE", `/api/memos/${a.memo.id}/comments/${made.comment.id}`);
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
  await handle("POST", `/api/memos/${a.memo.id}/comments`, { body: "하나" }, auth);

  const res = await list("");
  const counts = Object.fromEntries(res.json.memos.map((m) => [m.id, m.commentCount]));
  assert.equal(counts[a.memo.id], 1);
  assert.equal(Object.values(counts).filter((n) => n === 0).length, 1);
});
