// 영어 전용 규칙의 집행. 주제는 셋이다.
//
//  1) **거절이 실제로 일어난다.** 이 규칙은 오래 문서에만 있었고, 그동안 한글 글이 그냥 올라갔다.
//     문서에만 있는 규칙은 검사가 없다는 뜻이기도 하다 — 그래서 여기가 첫 자리다.
//  2) **인용은 살아남는다.** 같은 규약이 비영어 식별자를 원문대로 인용하라고 요구한다. 백틱과
//     펜스 안이 세어지는 순간, 규칙 둘이 서로를 막는다.
//  3) **산문에만 건다.** author 는 슬러그, status 는 열거값이다 — 언어가 없는 필드까지 걸면
//     규칙이 아니라 방해다.
import assert from "node:assert/strict";
import test from "node:test";

import { scriptMix, nonEnglishRefusal } from "../src/memo/language.mjs";
import { text } from "../src/memo/fields.mjs";
import { openDb } from "../src/core/db.mjs";
import { MemoStore } from "../src/memo/memo-store.mjs";
import { CommentStore } from "../src/memo/comment-store.mjs";

const KO = "인증 토큰이 만료되면 업로드가 조용히 실패한다. 원인은 캐시였다.";

function refusalOf(fn) {
  try { fn(); return null; }
  catch (error) { return error; }
}

test("한글 산문은 거절된다 — 코드와 메시지가 할 일을 말한다", () => {
  const error = refusalOf(() => text(KO, "body"));
  assert.ok(error, "한글 본문이 통과했다 — 규칙이 다시 문서로만 돌아갔다");
  assert.equal(error.code, "english_only");
  assert.match(error.message, /backticks/, "거절이 대안을 가리키지 않으면 다시 시도할 수 없다");
});

test("한글 제목도 같은 문으로 막힌다 — 본문만 검사하면 제목으로 새어 나간다", () => {
  assert.equal(refusalOf(() => text("업로드 실패 정리", "title"))?.code, "english_only");
});

test("일본어·중국어·러시아어도 같은 규칙이다 — 한글만 막는 것은 규칙이 아니라 반사다", () => {
  for (const sample of [
    "アップロードが静かに失敗する原因はキャッシュだった。",
    "上传静默失败的原因是缓存过期导致的认证问题。",
    "Загрузка молча падает из-за истёкшего токена в кэше.",
  ]) {
    assert.equal(refusalOf(() => text(sample, "body"))?.code, "english_only", sample);
  }
});

// --- 인용은 살아남아야 한다 -----------------------------------------------------------------

test("백틱 안의 원문 인용은 세지 않는다", () => {
  const body = "The upload dies with `인증 토큰이 만료되었습니다` — the token cache went stale.";
  assert.equal(text(body, "body"), body, "인용이 막히면 식별자를 번역하게 되고, 그러면 로그와 안 맞는다");
});

test("펜스 안의 로그 붙여넣기도 세지 않는다", () => {
  const body = [
    "The server answered in Korean, verbatim:",
    "```",
    "오류: 파일을 찾을 수 없습니다 (경로가 존재하지 않음)",
    "업로드 세션이 만료되었습니다",
    "```",
    "The fix was to widen the session TTL.",
  ].join("\n");
  assert.equal(text(body, "body"), body);
});

test("영어 문장 안의 한두 마디 언급은 통과한다 — 비율로 보는 이유", () => {
  const body = "The button labeled 저장 does nothing when the session has already been finalized.";
  assert.equal(text(body, "body"), body);
});

// 이 검사는 **그리스 문자가 라틴 쪽에 세어질 때만** 통과한다. 짧은 수식 댓글이 정확히 그 자리다
// — 긴 문장 안에 λ 하나면 비율에 묻혀 예외가 있으나 없으나 지나가고, 그러면 예외를 지키는
// 검사가 아니라 예외가 있다고 믿게 하는 검사가 된다.
test("수식만 있는 짧은 댓글은 통과한다 — 그리스 문자는 산문이 아니라 기호다", () => {
  const body = "σ ≈ 3 ms, λ ≈ 12 ms";
  assert.equal(text(body, "body"), body);
  assert.ok(scriptMix(body).other === 0, "그리스 문자가 비영어로 세어지면 각도·분산 댓글이 막힌다");
});

test("이모지와 화살표는 글자가 아니다 — 비ASCII 를 세면 영어 글이 거절된다", () => {
  const body = "Range resume works — 160 MB → 320 MB, hashes matched ✓";
  assert.equal(text(body, "body"), body);
});

// --- 경계 -----------------------------------------------------------------------------------

test("산문이 아닌 필드는 언어를 묻지 않는다", () => {
  assert.equal(text("김철수", "author"), "김철수");
  assert.equal(text("열림", "status"), "열림");
});

test("빈 값과 순수 영어는 그대로 지난다", () => {
  assert.equal(text("", "body"), "");
  assert.equal(text("  Chunk 3 never arrived; the ledger still shows the hole.  ", "body"),
    "Chunk 3 never arrived; the ledger still shows the hole.");
});

test("비율은 코드를 걷어낸 뒤의 글자만 센다", () => {
  const mix = scriptMix("ok `한글 인용` fine");
  assert.equal(mix.other, 0, "백틱 안이 세어지면 인용 규칙과 충돌한다");
  assert.equal(nonEnglishRefusal("ok `한글 인용` fine", "body"), null);
});

// 문턱 자체를 못 박아 둔다. 이 값이 바뀌면 정책이 바뀐 것이고, 그때는 이 검사가 먼저 깨져야 한다.
test("문턱: 15% 를 넘겨야 거절이고, 두 글자 미만은 기호로 본다", () => {
  const belowRatio = "a".repeat(40) + " 한글";          // 2/42 ≈ 5%
  assert.equal(nonEnglishRefusal(belowRatio, "body"), null);
  const aboveRatio = "a".repeat(8) + " 한글이 길어지면 거절된다";  // 12/20 = 60%
  assert.ok(nonEnglishRefusal(aboveRatio, "body"));
  assert.equal(nonEnglishRefusal("unit 미", "body"), null, "한 글자는 단위·로고일 수 있다");
});

// --- 저장소를 통과해도 막힌다 ----------------------------------------------------------------

test("글과 댓글 둘 다, 새로 쓸 때도 고칠 때도 막힌다", () => {
  const db = openDb(":memory:");
  const memos = new MemoStore(db);
  const comments = new CommentStore(db);

  assert.equal(refusalOf(() => memos.create({ title: "T", body: KO }, "u"))?.code, "english_only");
  const memo = memos.create({ title: "Upload dies at finalize", body: "The ledger shows a hole." }, "u");
  assert.equal(refusalOf(() => memos.update(memo.id, { body: KO }, "u"))?.code, "english_only",
    "PATCH 가 뚫려 있으면 글을 세운 뒤 갈아 끼우면 그만이다");
  assert.equal(refusalOf(() => comments.add(memo.id, { body: KO }, "u"))?.code, "english_only",
    "댓글이 뚫려 있으면 대화가 통째로 그 언어로 옮겨 간다");
});
