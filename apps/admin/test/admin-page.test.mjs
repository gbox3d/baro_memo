// 관리자 페이지 검사 — 시간대 표시와 백엔드 판 표시.
//
// 이 페이지에서 사람 눈에만 보이던 것들을 잡는다. 브라우저는 없다(dom-shim.mjs 참고).
import assert from "node:assert/strict";
import test from "node:test";

import { loadAdminPage, publicFile, staticZoneOptions, zonePicked } from "./dom-shim.mjs";

// 서머타임 경계에서 날짜가 넘어가는 순간. UTC 로는 13일 저녁, 서울로는 14일 새벽이다.
const INSTANT = "2026-08-13T16:22:33.004Z";

test("시간대 항목은 HTML 에 있다 — 스크립트가 죽어도 상자는 보인다", () => {
  const options = staticZoneOptions();
  assert.ok(options.length >= 2, "정적 <option> 이 없으면 빈 <select> 가 실오라기로 접혀 사라진다");
  assert.ok(options.some((o) => o.value === ""), "브라우저 기본 항목이 있어야 한다");
  assert.ok(options.some((o) => o.value === "UTC"), "서버·로그와 맞춰 볼 UTC 가 있어야 한다");
});

test("전체 목록은 전체다 — 위에 있는 이름도 빼지 않는다", () => {
  const page = loadAdminPage();
  const groups = page.tz.children.filter((c) => c.tagName === "optgroup");
  const all = groups.find((g) => g.label === "전체");
  assert.ok(all, "IANA 전체 그룹이 있어야 한다");
  assert.ok(all.children.length > 300, `전체 목록이 ${all.children.length}개뿐이다`);

  // 중복을 지우면 훑는 사람에게는 Asia/Tokyo 는 있는데 Asia/Seoul 만 없는 목록이 된다.
  for (const zone of ["Asia/Seoul", "Asia/Tokyo"]) {
    assert.ok(all.children.some((o) => o.value === zone), `${zone} 이 전체 목록에 없다`);
  }
  assert.ok(
    groups.find((g) => g.label === "자주 쓰는")?.children.length === staticZoneOptions().length,
    "HTML 의 지름길 항목이 그대로 묶여야 한다",
  );
});

test("고른 지역이 저장되고, 기본으로 되돌리면 지워진다", () => {
  const page = loadAdminPage();
  zonePicked(page, "America/New_York");
  assert.equal(page.store.get("baro-memo-tz"), "America/New_York");
  zonePicked(page, "");
  assert.equal(page.store.has("baro-memo-tz"), false, "기본값은 저장하지 않는다");
});

test("저장된 지역이 살아 있으면 그대로, 죽은 이름이면 기본으로 되돌아온다", () => {
  assert.equal(loadAdminPage({ storedTz: "Europe/Berlin" }).tz.value, "Europe/Berlin");
  // 기기를 옮겼거나 zone 이 사라진 경우. 화면이 멎는 대신 조용히 기본값이다.
  assert.equal(loadAdminPage({ storedTz: "Mars/Olympus" }).tz.value, "");
});

test("같은 순간이 고른 지역의 벽시계로 찍힌다", () => {
  const page = loadAdminPage();
  const { stamp } = page.sandbox;

  zonePicked(page, "UTC");
  assert.equal(stamp(INSTANT), "2026-08-13 16:22");
  assert.equal(stamp(INSTANT, false), "2026-08-13", "토큰 목록은 날짜만 — 경계도 같이 넘어가야 한다");

  zonePicked(page, "Asia/Seoul");
  assert.equal(stamp(INSTANT), "2026-08-14 01:22");
  assert.equal(stamp(INSTANT, false), "2026-08-14");

  zonePicked(page, "America/New_York");
  assert.equal(stamp(INSTANT), "2026-08-13 12:22");

  // 자정은 00:00 이다. h12 면 오전/오후가 붙고, h24 면 24:00 이 된다.
  zonePicked(page, "Asia/Seoul");
  assert.equal(stamp("2026-08-13T15:00:00.000Z"), "2026-08-14 00:00");
});

test("tooltip 은 지역과 원본 UTC 를 같이 들고 있다", () => {
  const page = loadAdminPage();
  zonePicked(page, "Asia/Seoul");
  const title = page.sandbox.stampTitle(INSTANT);
  assert.match(title, /Asia\/Seoul/);
  assert.match(title, /2026-08-14 01:22:33/);
  assert.ok(title.includes(INSTANT), "화면 값과 서버·로그 값이 다르게 보이는 것이 이 축의 함정이다");
});

test("깨진 시각은 삼키지 않고 원문을 보여 준다", () => {
  const page = loadAdminPage();
  assert.equal(page.sandbox.stamp("not-a-date"), "not-a-date");
  assert.equal(page.sandbox.stampTitle("not-a-date"), "");
});

test("백엔드 판을 화면에 찍는다 — 페이지와 서버는 따로 늙는다", async () => {
  const page = loadAdminPage({ version: "9.9.9" });
  await page.settled;
  assert.equal(page.node("#ver").textContent, "v9.9.9");
});

test("백엔드에 못 닿으면 빈 자리가 아니라 이유를 남긴다", async () => {
  const page = loadAdminPage({ fail: true });
  await page.settled;
  assert.equal(page.node("#ver").textContent, "v?", "빈 자리는 '버전이 없다'가 아니라 '안 물어봤다'로 읽힌다");
  assert.match(page.node("#ver").title, /닿지 못했습니다/);
});

// 여닫이는 shim 에서 그냥 불리언이라, 화면에서 정말 사라지는지는 CSS 를 글자로 대조해야 안다.
// 실제로 `.detail { display: flex }` 가 UA 의 `[hidden] { display: none }` 을 이겨, 토큰을
// 아무것도 고르지 않아도 값 상자와 복사·폐기 버튼이 첫 페인트부터 떠 있었다. <dialog> 의
// `:not([open])` 도 같은 UA 규칙이라 같은 함정이 있다 — 그래서 둘을 한 검사로 묶는다.
test("UA 가 감추는 요소를 CSS 의 display 가 되살리지 않는다", () => {
  const html = publicFile("index.html");
  const attrsOf = (attrs, guard) => ({
    guard,
    id: (attrs.match(/id="([^"]+)"/) || [])[1],
    classes: ((attrs.match(/class="([^"]+)"/) || [])[1] || "").split(/\s+/).filter(Boolean),
  });
  const targets = [
    ...[...html.matchAll(/<[a-z]+\b([^>]*\bhidden\b[^>]*)>/g)].map((m) => attrsOf(m[1], "[hidden]")),
    ...[...html.matchAll(/<dialog\b([^>]*)>/g)].map((m) => attrsOf(m[1], "[open]")),
  ];
  assert.ok(targets.length, "여닫는 요소가 없으면 이 검사는 아무것도 지키지 않는다");

  // 주석을 먼저 걷어낸다 — 이 규칙을 설명하는 주석 안에 `{ display: none }` 이 그대로 들어 있어
  // 파서가 주석을 규칙으로 읽으면 검사가 자기 설명문에 걸려 넘어진다.
  const css = publicFile("style.css").replace(/\/\*[\s\S]*?\*\//g, "");
  // 마지막 복합선택자만 본다. `#memo-dialog header` 가 주는 display 는 dialog 가 아니라
  // 그 안의 머리에 걸리므로 이 계약과 무관하다.
  const subject = (part) => part.trim().split(/[\s>+~]+/).pop() || "";

  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/(^|[;\s])display\s*:/.test(body)) continue;
    for (const part of selector.split(",")) {
      const last = subject(part);
      for (const t of targets) {
        if (last.includes(t.guard)) continue; // 가드가 붙어 있으면 통과
        const hit = (t.id && last.includes(`#${t.id}`))
          || t.classes.some((c) => new RegExp(`\\.${c}(?![\\w-])`).test(last));
        assert.ok(!hit,
          `\`${part.trim()}\` 가 ${t.guard} 로 여닫는 요소(${t.id || t.classes.join(".")})에 display 를 준다 — `
          + `저자 스타일시트는 UA 의 숨김 규칙을 이기므로 닫아도 화면에 남는다`);
      }
    }
  }
});

// ---- 본문 팝업 ---------------------------------------------------------------------------

const MEMO = {
  id: 12, status: "open", user: "paimon", author: "claude/sim", title: "긴 글",
  bodyPreview: "앞부분만", bodyLength: 999, updatedAt: INSTANT, updatedBy: null,
  body: "본문 전문이다",
};

const drain = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };

test("메모 줄을 누르면 팝업이 열리고 전문을 받아 채운다", async () => {
  const page = loadAdminPage({ memos: [MEMO] });
  await page.settled;
  page.pickMemoRow();

  assert.equal(page.dialog.open, true, "본문은 팝업으로 연다");
  // 전문이 도착하기 전에는 미리보기로 자리를 채운다 — 빈 칸은 "본문이 없다"로 읽힌다.
  assert.match(page.node("#memo-detail").textContent, /앞부분만/);
  assert.match(page.node("#memo-dialog-title").textContent, /#12/);

  await drain();
  assert.equal(page.node("#memo-detail").textContent, MEMO.body, "전문이 도착하면 갈아 끼운다");
});

test("닫기 버튼으로 닫으면 선택도 풀린다 — 다시 누르면 다시 열린다", async () => {
  const page = loadAdminPage({ memos: [MEMO] });
  await page.settled;
  page.pickMemoRow();
  await drain();

  page.node("#memo-dialog-close")._on.click();
  assert.equal(page.dialog.open, false);

  // 선택이 남아 있으면 같은 줄을 누를 때 토글로 꺼져 팝업이 안 열린다.
  page.pickMemoRow();
  assert.equal(page.dialog.open, true, "닫은 뒤 같은 줄을 누르면 다시 열려야 한다");
});

test("Esc·가림막으로 닫아도 같은 자리로 돌아온다", async () => {
  const page = loadAdminPage({ memos: [MEMO] });
  await page.settled;
  page.pickMemoRow();
  await drain();

  page.dialog.close(); // Esc 로 닫으면 브라우저가 close 이벤트만 준다
  assert.equal(page.dialog.open, false);
  page.pickMemoRow();
  assert.equal(page.dialog.open, true);

  page.dialog._on.click({ target: page.dialog }); // 가림막(본문 바깥) 클릭
  assert.equal(page.dialog.open, false);
});

test("팝업에 댓글이 시간순으로 붙고, 없으면 구획 자체가 안 보인다", async () => {
  const talked = {
    ...MEMO, id: 13, commentCount: 2,
    comments: [
      { id: 1, memoId: 13, body: "먼저 온 말", user: "kim", author: "claude/a", createdAt: INSTANT },
      { id: 2, memoId: 13, body: "나중 온 말", user: "lee", author: "", createdAt: INSTANT },
    ],
  };
  const page = loadAdminPage({ memos: [talked, MEMO] });
  await page.settled;
  page.pickMemoRow(0);
  await drain();

  const box = page.node("#memo-comments");
  assert.equal(box.hidden, false);
  assert.deepEqual(box.children.map((c) => c.children[1].textContent), ["먼저 온 말", "나중 온 말"]);
  // user 는 사람, author 는 그 사람의 세션이다. author 가 없으면 user 만 적는다.
  assert.equal(box.children[0].children[0].children[0].textContent, "kim · claude/a");
  assert.equal(box.children[1].children[0].children[0].textContent, "lee");
  assert.match(page.node("#memo-dialog-title").textContent, /댓글 2/);

  // 댓글 없는 메모로 옮기면 구획이 닫힌다 — 빈 구획은 "고장 났나"로 읽힌다.
  page.node("#memo-dialog-close")._on.click();
  page.pickMemoRow(1);
  await drain();
  assert.equal(page.node("#memo-comments").hidden, true);
  assert.equal(page.node("#memo-dialog-title").textContent.includes("댓글"), false);
});

test("같은 줄을 다시 누르면 닫힌다", async () => {
  const page = loadAdminPage({ memos: [MEMO] });
  await page.settled;
  page.pickMemoRow();
  await drain();
  page.pickMemoRow();
  assert.equal(page.dialog.open, false);
});

// ---- 발급 -------------------------------------------------------------------------------

test("발급은 두 번 눌러도 한 번만 나간다", async () => {
  // POST /api/admin/tokens 는 멱등하지 않다. 두 번 나가면 같은 사람에게 활성 토큰이 둘 생기고,
  // 운영자는 하나만 전달하므로 주인 없는 쓰기 자격증명이 남는다.
  const page = loadAdminPage({ adminToken: "adm_x" });
  await page.settled;
  const submit = () => page.node("#issue-form")._on.submit({ preventDefault() {} });
  await Promise.all([submit(), submit()]);

  assert.equal(page.requests.filter((r) => r.method === "POST").length, 1);
  assert.equal(page.node("#issue-submit").disabled, false, "끝났으면 다시 눌릴 수 있어야 한다");
});

test("발급이 실패해도 버튼은 다시 열리고 폼은 그대로다", async () => {
  const page = loadAdminPage({ adminToken: "adm_x", fail: true });
  await page.settled;
  await page.node("#issue-form")._on.submit({ preventDefault() {} });
  assert.equal(page.node("#issue-submit").disabled, false, "잠긴 채로 남으면 다시 발급할 수 없다");
});

// ---- 복사 -------------------------------------------------------------------------------
//
// 이 보드는 평문 HTTP 로 열린다 — navigator.clipboard 는 보안 컨텍스트에만 있으므로 **없다**.
// 없는 것을 부르다 TypeError 로 죽었고, 화면에는 아무 일도 없는 것처럼 보였다.
const TOKEN = { id: 7, user: "paimon", token: "tok_verysecret", note: "", createdAt: "2026-08-13T16:22:33.004Z", revokedAt: null };

async function pickedPage(options) {
  const page = loadAdminPage({ adminToken: "adm_x", tokens: [TOKEN], ...options });
  await page.settled;
  page.pickTokenRow();
  return page;
}

test("평문 HTTP 에서도 복사가 된다 — 클립보드 API 가 없으면 옛 길로 내려간다", async () => {
  const page = await pickedPage({ clipboard: false, execCommand: true });
  await page.node("#token-copy")._on.click();
  assert.deepEqual(page.execCopied, [TOKEN.token], "textarea 를 붙이고 select 한 뒤 복사해야 한다");
  assert.equal(page.status(), "복사되었습니다.");
  assert.equal(page.body.children.filter((c) => c.tagName === "textarea").length, 0,
    "임시 textarea 를 문서에 남기면 다음 복사가 엉뚱한 것을 집는다");
});

test("보안 컨텍스트면 표준 API 를 쓴다", async () => {
  const page = await pickedPage({ clipboard: true });
  await page.node("#token-copy")._on.click();
  assert.deepEqual(page.copied, [TOKEN.token]);
  assert.equal(page.execCopied.length, 0, "표준 경로가 됐으면 옛 길로 내려가지 않는다");
});

test("둘 다 막히면 값을 선택해 주고, 막혔다고 말한다", async () => {
  const page = await pickedPage({ clipboard: false, execCommand: false });
  await page.node("#token-copy")._on.click();
  assert.deepEqual(page.selectedRanges, [page.node("#token-value")],
    "사람이 직접 복사할 수 있게 토큰 값을 선택해 줘야 한다");
  assert.match(page.status(), /직접 복사/);
});

test("복사 확인은 누른 자리에 뜨고, 잠시 뒤 원래 라벨로 돌아온다", async (t) => {
  // 클립보드는 결과가 눈에 안 보이는 동작이다. 상태줄은 화면 맨 아래라 휴대폰에서는
  // 누른 손가락 밖이고, 그래서 "복사가 됐는지 모르겠다"가 된다.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const page = loadAdminPage({ adminToken: "adm_x", tokens: [TOKEN] });
  await page.settled;
  page.pickTokenRow();

  const btn = page.node("#token-copy");
  assert.equal(btn.textContent, "복사", "HTML 의 라벨이 출발점이다");

  await btn._on.click();
  assert.equal(btn.textContent, "복사됨");
  assert.equal(page.status(), "복사되었습니다.");

  t.mock.timers.tick(1500);
  assert.equal(btn.textContent, "복사", "라벨이 굳으면 다음 복사가 됐는지 알 수 없다");
});

test("연타해도 라벨이 굳지 않는다", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const page = loadAdminPage({ adminToken: "adm_x", tokens: [TOKEN] });
  await page.settled;
  page.pickTokenRow();

  const btn = page.node("#token-copy");
  await btn._on.click();
  t.mock.timers.tick(1000);   // 아직 되돌아오기 전에
  await btn._on.click();      // 다시 누른다 — 앞 타이머가 남아 있으면 500ms 뒤 라벨이 어긋난다
  t.mock.timers.tick(1000);
  assert.equal(btn.textContent, "복사됨", "두 번째 누름의 확인이 첫 타이머에 지워지면 안 된다");
  t.mock.timers.tick(500);
  assert.equal(btn.textContent, "복사");
});

test("복사가 막히면 버튼도 그렇게 말한다", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const page = loadAdminPage({ adminToken: "adm_x", tokens: [TOKEN], clipboard: false, execCommand: false });
  await page.settled;
  page.pickTokenRow();

  await page.node("#token-copy")._on.click();
  assert.equal(page.node("#token-copy").textContent, "복사 실패");
  assert.match(page.status(), /직접 복사/);
});

test("고른 토큰이 없으면 복사 버튼은 조용하다", async () => {
  const page = loadAdminPage({ adminToken: "adm_x", tokens: [TOKEN] });
  await page.settled;
  await page.node("#token-copy")._on.click(); // 아무것도 고르지 않은 상태
  assert.equal(page.execCopied.length + page.copied.length, 0);
  assert.equal(page.status(), "");
});
