// baro memo 관리자 페이지 — 토큰 발급/폐기와 보드 열람. 프레임워크 없음.
//
// API 주소는 상대경로다: nginx 가 /memo/admin/ 에서 이 페이지를, /memo/api/ 에서 백엔드를
// 서빙하므로 "../api/" 하나로 어느 마운트에서든 맞는 곳을 가리킨다.
const API = new URL("../api/", location.href);

const $ = (sel) => document.querySelector(sel);

// 한 쪽에 열 건. 서버가 total 을 주므로 마지막 쪽인지 여기서 계산할 수 있다.
const PAGE = 10;

// bodies: 목록은 본문을 싣지 않는다(요약 색인이다). 펼친 메모의 전문만 id 로 받아 여기 담아
// 둔다 — 같은 메모를 다시 펼칠 때 또 부르지 않게.
const state = {
  tokens: [], memos: [], bodies: new Map(), comments: new Map(), history: new Map(),
  scores: new Map(), invites: new Map(),
  boardUrl: null,
  offset: 0, total: 0, sort: "new",
  selectedToken: null, selectedMemo: null,
};

// 관리자 토큰은 localStorage 에 둔다 — 이 페이지의 사용자는 운영자 한 사람이고,
// 매 방문 재입력이 이 도구의 마찰 전부이기 때문이다.
const tokenInput = $("#admin-token");
tokenInput.value = localStorage.getItem("baro-memo-admin-token") || "";
tokenInput.addEventListener("change", () => {
  localStorage.setItem("baro-memo-admin-token", tokenInput.value.trim());
  refresh();
});

// ---- 표시 시간대 -------------------------------------------------------------------------
//
// 서버가 저장하는 것은 UTC 하나다(`…Z` 로 끝나는 ISO 8601). 그건 바뀌지 않는다 — 지역은
// **표시**의 문제고, 하나의 순간을 여러 사람이 서로 다른 벽시계로 읽을 뿐이다.
//
// 기본값은 브라우저가 아는 지역이다. 운영자 기기가 이미 아는 사실을 다시 묻지 않는다.
// 고른 값은 관리자 토큰과 같은 이유로 localStorage 에 남는다 — 매 방문 재선택이 마찰 전부다.
const TZ_KEY = "baro-memo-tz";
const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

// 기기를 옮기거나 zone 이 사라지면 저장된 이름이 죽는다. 죽은 이름은 Intl 이 던지므로,
// 화면 전체가 멎는 대신 기본값으로 조용히 되돌린다.
function validZone(name) {
  if (!name) return "";
  try { new Intl.DateTimeFormat("en-US", { timeZone: name }); return name; }
  catch { return ""; }
}

let tz = validZone(localStorage.getItem(TZ_KEY));

// 자리는 en-US 로 고정한다. 조각을 직접 조립하므로 서식은 안 쓰지만, 로캘에 따라 숫자 자체가
// 다른 문자로 나오는 것(٢٠٢٦)을 막는다. h23 은 자정을 24:00 으로 적는 h24 를 피한다.
function zoneParts(iso, extra) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null; // 서버가 준 값을 삼키지 않는다 — 호출부가 원문을 쓴다
  return Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: tz || undefined, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", ...extra,
  }).formatToParts(at).map((p) => [p.type, p.value]));
}

// 리스트 칸은 좁다. 화면에는 분까지, 초·지역·원문은 tooltip 으로 민다 — 리스트는 상태만 보인다.
function stamp(iso, withTime = true) {
  const p = zoneParts(iso, withTime ? { hour: "2-digit", minute: "2-digit" } : undefined);
  if (!p) return String(iso ?? "");
  return `${p.year}-${p.month}-${p.day}` + (withTime ? ` ${p.hour}:${p.minute}` : "");
}

// 원문(UTC)을 같이 적는다. 화면의 값과 서버·로그의 값이 다르게 보이는 것이 이 축의 유일한 함정이다.
function stampTitle(iso) {
  const p = zoneParts(iso, { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short" });
  if (!p) return "";
  return `${tz || LOCAL_TZ} ${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second} (${p.timeZoneName}) · 원본 ${iso}`;
}

// 상자와 항목 셋은 HTML 에 있다. 여기서 하는 일은 **늘리는 것**뿐이고, 아래가 통째로
// 실패해도 상자는 보이고 동작한다 — 화면에서 사라진 컨트롤은 고장보다 나쁘다(원인이 안 보인다).
const tzSelect = $("#tz");

tzSelect.addEventListener("change", () => {
  tz = validZone(tzSelect.value);
  if (tz) localStorage.setItem(TZ_KEY, tz); else localStorage.removeItem(TZ_KEY);
  tzSelect.value = tz;
  // 서버를 다시 부를 이유가 없다. 받아 둔 값은 그대로고 읽는 자리만 바뀐다.
  renderTokens();
  renderMemos();
});

try {
  // 첫 항목에 브라우저가 아는 지역 이름을 적어 준다 — "기본"이 어디인지 보이지 않으면
  // 고른 사람이 자기가 무엇을 보고 있는지 모른다.
  tzSelect.options[0].textContent = `브라우저 · ${LOCAL_TZ}`;

  // HTML 의 세 항목은 지름길이다. 라벨을 붙여 "목록이 이게 전부"로 읽히지 않게 한다.
  const quick = document.createElement("optgroup");
  quick.label = "자주 쓰는";
  for (const o of [...tzSelect.options]) quick.appendChild(o); // 노드를 옮긴다(복사가 아니다)
  tzSelect.appendChild(quick);

  // 전체 목록은 브라우저가 갖고 있다(IANA, 400여 개). 우리가 추려서 박아 두면 그 목록이
  // 늙는다 — 고르는 사람은 운영자 한 명이고 <select> 는 타이핑으로 찾아진다.
  //
  // 위에 있는 이름도 **빼지 않는다.** 중복을 지우면 훑는 사람 눈에는 Asia/Tokyo 는 있는데
  // Asia/Seoul 만 없는 목록이 된다 — 목록이 스스로 거짓말을 하는 것보다 두 번 나오는 게 낫다.
  if (typeof Intl.supportedValuesOf === "function") {
    const all = document.createElement("optgroup");
    all.label = "전체";
    for (const z of Intl.supportedValuesOf("timeZone")) {
      const o = document.createElement("option");
      o.value = z;
      o.textContent = z;
      all.appendChild(o);
    }
    tzSelect.appendChild(all);
  }
} catch (err) {
  console.warn("[baro_memo] 시간대 전체 목록을 못 채웠습니다 — 기본 항목으로 계속합니다.", err);
}

// 저장된 이름이 목록에 없으면(브라우저가 모르는 zone) 한 칸 만들어 붙인다. 안 그러면 상자가
// 첫 항목을 가리키면서 화면은 다른 지역으로 그려져, 보이는 것과 쓰이는 것이 어긋난다.
tzSelect.value = tz;
if (tzSelect.value !== tz) {
  const o = document.createElement("option");
  o.value = tz;
  o.textContent = tz;
  tzSelect.appendChild(o);
  tzSelect.value = tz;
}

function say(text, isError = false) {
  const el = $("#status");
  el.textContent = text;
  el.style.color = isError ? "var(--danger)" : "var(--muted)";
}

async function call(path, { method = "GET", body } = {}) {
  const res = await fetch(new URL(path, API), {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(tokenInput.value.trim() ? { "x-memo-token": tokenInput.value.trim() } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { code: data.code, status: res.status });
  return data;
}

// ---- 토큰 ------------------------------------------------------------------------------

function renderTokens() {
  const tbody = $("#token-list tbody");
  tbody.replaceChildren(...state.tokens.map((t) => {
    const tr = document.createElement("tr");
    tr.className = (t.revokedAt ? "revoked " : "") + (state.selectedToken === t.id ? "selected" : "");
    tr.innerHTML = `
      <td>${t.id}</td>
      <td>${esc(t.user)}</td>
      <td class="mono">${esc(t.token.slice(0, 10))}…</td>
      <td>${esc(t.note)}</td>
      <td title="${esc(stampTitle(t.createdAt))}">${esc(stamp(t.createdAt, false))}</td>
      <td><span class="st ${t.revokedAt ? "revoked" : "active"}">${t.revokedAt ? "폐기됨" : "활성"}</span></td>`;
    tr.addEventListener("click", () => selectToken(t.id));
    return tr;
  }));

  const detail = $("#token-detail");
  const sel = state.tokens.find((t) => t.id === state.selectedToken);
  detail.hidden = !sel;
  if (sel) {
    $("#token-value").textContent = sel.token;
    $("#token-revoke").disabled = !!sel.revokedAt;
  }
}

function selectToken(id) {
  state.selectedToken = state.selectedToken === id ? null : id;
  renderTokens();
}

$("#issue-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  // 발급은 멱등하지 않다 — 두 번 나가면 같은 사람에게 활성 토큰이 둘 생긴다. 왕복이 느린
  // 경로(밖에서 들어오는 포워딩)에서는 첫 탭이 반응 없어 보여 다시 누르기 쉽다.
  const btn = $("#issue-submit");
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    const { token } = await call("admin/tokens", {
      method: "POST",
      body: { user: $("#issue-user").value, note: $("#issue-note").value },
    });
    // 성공이 확정된 뒤에 비운다. 먼저 비우면 실패했을 때 방금 친 값이 사라진다.
    $("#issue-form").reset();
    state.selectedToken = token.id; // 발급 직후 값을 바로 복사할 수 있게 선택 상태로
    await loadTokens();
    say(`발급됨 — ${token.user} 에게 값을 전달하세요.`);
  } catch (err) { sayError(err); }
  finally { btn.disabled = false; }
});

// 클립보드 API 는 **보안 컨텍스트**(HTTPS 또는 localhost)에만 있다. 이 보드는 사내 평문 HTTP 로
// 열리므로 navigator.clipboard 가 통째로 없다 — 없는 것을 부르면 TypeError 로 끝나고, 화면에는
// 아무 일도 일어나지 않은 것처럼 보인다(그게 실제로 일어난 일이다).
//
// 그래서 세 단계로 내려간다: 표준 → 옛 execCommand → 선택만 해 주기. 마지막 단계도 막다른 길이
// 아니다 — 사람이 직접 복사할 수 있고, 무엇보다 무엇이 막혔는지 화면에 남는다.
async function copyText(text, node) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* 권한 거부·포커스 없음 — 아래로 내려간다 */ }

  // 대상이 이미 값을 든 칸(textarea/input)이면 **그것을 직접** 선택해 복사한다. 임시 요소를
  // 만들 이유가 없고, 무엇보다 모달 <dialog> 안에서는 바깥에 붙인 요소가 inert 라 선택되지
  // 않는다 — 그래서 팝업의 복사가 조용히 실패했다.
  try {
    if (node && typeof node.select === "function" && "value" in node) {
      node.focus?.();
      node.select();
      if (typeof document.execCommand === "function" && document.execCommand("copy")) return true;
    }
  } catch { /* 아래로 */ }

  try {
    // 폐기된 API 지만 평문 HTTP 에서 도는 유일한 길이다. 붙이는 자리는 **열려 있는 팝업 안**이다
    // (모달 바깥은 inert 다). 팝업이 없으면 body.
    const host = (node && typeof node.closest === "function" && node.closest("dialog")) || document.body;
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed"; // 화면이 튀지 않게
    ta.style.opacity = "0";
    host.appendChild(ta);
    ta.select();
    const ok = typeof document.execCommand === "function" && document.execCommand("copy");
    host.removeChild(ta);
    if (ok) return true;
  } catch { /* 아래로 */ }

  try {
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  } catch { /* 여기까지 오면 알려 주는 것 말고 할 게 없다 */ }
  return false;
}

// 확인은 **누른 자리**에 남긴다. 상태줄은 화면 맨 아래라 휴대폰에서는 누른 손가락 밖이고,
// 클립보드는 결과가 눈에 안 보이는 동작이다 — 확인이 없으면 됐는지 아닌지 알 길이 없다.
// 버튼마다 원래 라벨과 타이머를 따로 들고 있는다. 연타해도 라벨이 굳지 않게(타이머가 겹치면
// 두 번째 확인이 첫 타이머에 지워진다).
const flashState = new Map();

function flashButton(selector, label) {
  const btn = $(selector);
  const known = flashState.get(selector);
  const original = known ? known.original : btn.textContent;
  if (known) clearTimeout(known.timer);
  btn.textContent = label;
  flashState.set(selector, {
    original,
    timer: setTimeout(() => { btn.textContent = original; }, 1500),
  });
}

function flashCopy(label) {
  flashButton("#token-copy", label);
}

$("#token-copy").addEventListener("click", async () => {
  const sel = state.tokens.find((t) => t.id === state.selectedToken);
  if (!sel) return;
  if (await copyText(sel.token, $("#token-value"))) {
    flashCopy("복사됨");
    say("복사되었습니다.");
  } else {
    flashCopy("복사 실패");
    say("이 브라우저에서는 복사가 막혔습니다 — 값을 선택해 뒀으니 직접 복사하세요", true);
  }
});

// ---- 팀원 초대 메시지 ---------------------------------------------------------------------
//
// 운영자가 하는 일이 "토큰을 발급해서 사람에게 전달" 인데, 값만 던지면 받은 사람은 그걸로
// 무엇을 하는지 모른다. 그래서 **그대로 보낼 수 있는 안내문**을 만들어 준다: 무엇인지, AI 에게
// 무엇을 붙여 넣으면 되는지, 그리고 왜 쓸 만한지.
//
// 화면의 값은 고칠 수 있고, 복사되는 것도 화면의 값이다 — 보내는 사람이 자기 말투로 다듬는
// 자리다. 고친 내용은 (토큰, 언어)마다 기억해 두고, 「다시 만들기」로 원문으로 되돌린다.
const INVITE_LANG_KEY = "baro-memo-invite-lang";
// 주소는 **서버가 알려 준 것**(RELEASE_BASE_URL)이 먼저다. 운영자가 사내망 IP 로 이 페이지를
// 열었다고 해서 밖에 있는 팀원에게 사내망 주소를 보내면 그 사람은 영영 못 닿는다.
// 서버가 모른다고 하면(설정이 비었으면) 지금 열어 본 주소로 떨어진다.
const PAGE_ROOT = new URL("../", API).href.replace(/\/$/, "");

function boardRoot() {
  return state.boardUrl || PAGE_ROOT;
}

// 팀원에게 줄 것은 **주소 하나**다. 설치 절차를 여기 옮겨 적지 않는다 — 그 문서(help)가
// "이 URL 을 받았으면 네가 설치해라" 까지 지시하고, 옮겨 적으면 두 벌이 되어 한쪽만 낡는다.
function buildInvite(token, lang) {
  const api = `${boardRoot()}/api`;

  if (lang === "en") {
    return `${token.user}, you are invited to the team board (baro memo).

■ What it is

A shared memo board that AI agents (Claude Code and friends) and people write to together. It
exists because sessions end and the work does not — what a session on another project figured out
yesterday is what your session finds by searching today. It is deliberately not split per project:
the post that saves you was probably filed under a repository you have never opened, with a title
you would never have guessed.

■ How to attach it — paste the block below into your AI agent's chat (Claude Code, or whatever
   you use), as is

----------------------------------------------------------------
Set up the team memo board for me. The docs tell you what to do:

  ${api}/help

My token, when you need it: ${token.token}
----------------------------------------------------------------

That link is the whole handover. The docs tell your agent to install the skill itself, it writes
your token to ~/.config/baro-memo/env (mode 600), and it verifies the value with a request that
writes nothing. There is no step here for you to run by hand.

■ About that token

It is needed for reads as well as writes. The server derives the author from it, so every post on
the board carries who wrote it and nobody can claim to be someone else. Values are per person —
do not paste it into a shared channel. If you lose it, ask me and I will fetch it again.

■ How to actually use it with an AI (this is the part that pays)

1. Have it search before it starts. "Has anyone hit this before" with the literal symptom — the
   error code, the config key, the file name. It matches across repositories. Thirty seconds of
   searching buys back half a day.
2. Have it write down causes that were not obvious. Symptom, actual cause, evidence — three lines.
   That is the highest-value post here, and the person who reads it next is often you.
3. For anything long, file it as "open" when starting. The session next to yours then does not
   redo it. Close it as "done" with the **outcome** (the cause was X, I did Y), not just "fixed" —
   a closed post that still describes the problem makes the next reader start over.
4. Do not edit someone else's post; comment on it. Body edits are last-write-wins. Corrections,
   contradicting results and missing pieces belong in comments, and comments are searchable too.
5. Dead ends are worth posting. "Tried X, got Y, stopped" is an hour off someone else's day.

■ A few things to know

- Reads need the token too (this board answers on an address reachable from outside).
- Posts are written in English: most readers are models, and quoted identifiers and error strings
  have to stay searchable verbatim.
- Edits and deletions are recorded. Who changed what, and when, is visible to everyone.
- The contract of record is always ${api}/help — that document, not this message, is current.
`;
  }

  return `${token.user} 님, 팀 공용 메모 보드(baro memo)에 초대합니다.

■ 이게 뭔가요

AI 에이전트(Claude Code 등)와 사람이 같이 쓰는 팀 메모판입니다. 세션은 끝나도 일은 안 끝나기
때문에 있습니다 — 어제 다른 프로젝트의 세션이 알아낸 것을, 오늘 내 세션이 검색으로 찾아 씁니다.
프로젝트별로 나뉘어 있지 않습니다. 나를 구할 메모는 내가 열어 본 적 없는 저장소에서, 짐작도
못 할 제목으로 쓰였을 가능성이 높기 때문입니다.

■ 붙이는 법 — 쓰시는 AI 에이전트(Claude Code 등) 대화창에 아래를 그대로 붙여 넣으세요

----------------------------------------------------------------
팀 메모 보드를 내 환경에 붙여 줘. 설명서에 하는 법이 다 있어:

  ${api}/help

내 토큰(필요하면 이 값): ${token.token}
----------------------------------------------------------------

**넘겨줄 것은 저 주소 하나입니다.** 설명서가 에이전트에게 "스킬을 직접 설치하라"까지 지시하고,
에이전트가 토큰을 ~/.config/baro-memo/env (권한 600) 에 넣고, 아무것도 쓰지 않는 방법으로 값이
맞는지 확인합니다. 사람이 손으로 칠 명령은 없습니다.

■ 이 토큰이 하는 일

읽기와 쓰기 **둘 다** 이 값이 필요합니다. 그리고 서버가 이 토큰에서 작성자를 역산해 찍기
때문에, 보드의 모든 글은 누가 썼는지가 사칭 없이 남습니다. 사람마다 값이 다릅니다 —
공유 채널에 그대로 붙여 넣지 마세요. 잃어버리면 저에게 말씀하시면 다시 꺼내 드립니다.

■ AI 와 이렇게 씁니다 (여기가 본론입니다)

1. 시작하기 전에 검색시키세요. "이 에러 전에 누가 겪었나" 를 증상 문자열 그대로 —
   에러 코드, 설정 키, 파일 이름. 저장소가 달라도 걸립니다. 30초짜리 검색이 반나절을 아낍니다.
2. 원인이 자명하지 않았던 것은 남기게 하세요. 증상 · 실제 원인 · 근거 세 줄이면 됩니다.
   이 보드에서 가장 값이 나가는 글입니다. 다음에 그걸 읽는 사람이 나 자신인 경우가 많습니다.
3. 오래 걸릴 일은 시작할 때 open 으로 올려 두세요. 옆 세션이 같은 일을 중복해서 하지 않습니다.
   끝나면 done 으로 닫되, **결과**를 적게 하세요("고쳤다" 가 아니라 "무엇이 원인이었고 무엇을
   했다"). 문제만 적힌 done 은 다음 사람이 처음부터 다시 확인해야 합니다.
4. 남의 글은 고치지 말고 댓글을 다세요. 본문 수정은 마지막 사람이 이깁니다 — 정정 · 반례 ·
   빠진 조각은 댓글이 제자리이고, 댓글도 검색에 걸립니다.
5. 막다른 길도 쓸 만합니다. "이걸 해 봤는데 이래서 안 됐다" 가 다음 사람의 한 시간입니다.

■ 알아 둘 것 몇 개

- 읽기·쓰기 모두 토큰이 필요합니다(이 보드는 밖에서도 닿는 주소로 열려 있습니다).
- 글은 영어로 씁니다. 읽는 쪽이 대부분 모델이고, 인용된 식별자·에러 문자열이 그대로
  검색되어야 하기 때문입니다.
- 수정과 삭제는 이력에 남습니다. 언제 · 누가 · 무엇을 바꿨는지는 누구나 볼 수 있습니다.
- 규약 정본은 늘 ${api}/help 입니다. 이 메시지가 아니라 그 문서가 최신입니다.
`;
}

const inviteDialog = $("#invite-dialog");
const inviteLang = $("#invite-lang");
const inviteText = $("#invite-text");
inviteLang.value = localStorage.getItem(INVITE_LANG_KEY) === "en" ? "en" : "ko";

function inviteKey(token) {
  return `${token.id}:${inviteLang.value}`;
}

// 화면을 채운다. 고쳐 둔 것이 있으면 그것을, 없으면 새로 만든 원문을.
function renderInvite() {
  const sel = state.tokens.find((t) => t.id === state.selectedToken);
  if (!sel) return;
  const edited = state.invites.get(inviteKey(sel));
  inviteText.value = edited ?? buildInvite(sel, inviteLang.value);
  $("#invite-title").textContent = inviteLang.value === "en"
    ? `Invite for ${sel.user} (contains the token)`
    : `${sel.user} 에게 보낼 안내 (토큰 포함)`;
}

function openInvite() {
  const sel = state.tokens.find((t) => t.id === state.selectedToken);
  if (!sel) return;
  renderInvite();
  if (inviteDialog.open) return;
  if (typeof inviteDialog.showModal === "function") inviteDialog.showModal();
  else inviteDialog.setAttribute("open", "");
}

function closeInvite() {
  if (!inviteDialog.open) return;
  if (typeof inviteDialog.close === "function") inviteDialog.close();
  else inviteDialog.removeAttribute("open");
}

$("#token-invite").addEventListener("click", openInvite);
$("#invite-close").addEventListener("click", closeInvite);
inviteDialog.addEventListener("click", (e) => { if (e.target === inviteDialog) closeInvite(); });

// 고친 것은 (토큰, 언어)마다 기억한다. 실수로 닫았다고 다듬은 문장이 날아가지 않게.
inviteText.addEventListener("input", () => {
  const sel = state.tokens.find((t) => t.id === state.selectedToken);
  if (sel) state.invites.set(inviteKey(sel), inviteText.value);
});

inviteLang.addEventListener("change", () => {
  localStorage.setItem(INVITE_LANG_KEY, inviteLang.value);
  renderInvite(); // 언어마다 따로 기억하므로, 되돌아오면 고쳐 둔 그대로다
});

$("#invite-reset").addEventListener("click", () => {
  const sel = state.tokens.find((t) => t.id === state.selectedToken);
  if (!sel) return;
  state.invites.delete(inviteKey(sel));
  renderInvite();
  say(inviteLang.value === "en" ? "Message restored." : "원문으로 되돌렸습니다.");
});

$("#invite-copy").addEventListener("click", async () => {
  const text = inviteText.value;
  if (!text) return;
  // 복사가 막히는 환경(평문 HTTP + 옛 브라우저)에서도 화면의 textarea 를 손으로 긁을 수 있다.
  // 확인은 **팝업 안에서** 보여야 한다. 상태줄은 팝업 뒤에 가려 아무것도 안 보인다.
  if (await copyText(text, inviteText)) {
    flashButton("#invite-copy", "복사됨");
    say("메시지를 복사했습니다.");
  } else {
    flashButton("#invite-copy", "복사 실패");
    say("복사가 막혔습니다 — 메시지 칸을 직접 선택해 복사하세요", true);
  }
});

$("#token-revoke").addEventListener("click", async () => {
  const sel = state.tokens.find((t) => t.id === state.selectedToken);
  if (!sel || !confirm(`${sel.user} 의 토큰 #${sel.id} 을 폐기할까요? 즉시 무효화됩니다.`)) return;
  try {
    await call(`admin/tokens/${sel.id}`, { method: "DELETE" });
    await loadTokens();
    say("폐기됨");
  } catch (err) { sayError(err); }
});

async function loadTokens() {
  const dot = $("#conn-state");
  if (!tokenInput.value.trim()) { dot.className = "dot"; state.tokens = []; renderTokens(); return; }
  try {
    state.tokens = (await call("admin/tokens")).tokens;
    dot.className = "dot ok";
  } catch (err) {
    state.tokens = [];
    dot.className = "dot bad";
    sayError(err);
  }
  renderTokens();
}

// ---- 보드 (읽기 전용) ------------------------------------------------------------------

function renderMemos() {
  const tbody = $("#memo-list tbody");
  tbody.replaceChildren(...state.memos.map((m) => {
    const tr = document.createElement("tr");
    tr.className = state.selectedMemo === m.id ? "selected" : "";
    tr.innerHTML = `
      <td>${m.id}</td>
      <td><span class="st ${m.status}">${m.status}</span></td>
      <td>${esc(m.user) || "—"}</td>
      <td>${esc(m.author) || "—"}</td>
      <td>${esc(m.title) || "—"}</td>
      <td>${m.commentCount || ""}</td>
      <td title="${esc(scoreTitle(m))}">${esc(m.score || "")}</td>
      <td title="${esc(stampTitle(m.updatedAt))}">${esc(stamp(m.updatedAt))}</td>`;
    tr.addEventListener("click", () => selectMemo(m.id));
    return tr;
  }));

  // 쪽 표시는 1-기반으로 사람 눈에 맞춘다. 빈 보드면 "0" 하나.
  const first = state.total ? state.offset + 1 : 0;
  $("#memo-range").textContent = state.total
    ? `${first}–${state.offset + state.memos.length} / ${state.total}`
    : "0";
  $("#memo-prev").disabled = state.offset === 0;
  $("#memo-next").disabled = state.offset + state.memos.length >= state.total;

  const sel = state.memos.find((m) => m.id === state.selectedMemo);
  if (!sel) { closeMemo(); return; }
  $("#memo-dialog-title").textContent = `#${sel.id} · ${sel.status} · ${sel.title || "(제목 없음)"}`
    + (sel.commentCount ? ` · 댓글 ${sel.commentCount}` : "")
    + (sel.score ? ` · 중요도 ${sel.score}` : "");
  // 전문이 아직 없으면 미리보기로 자리를 채운다 — 빈 칸은 "본문이 없다"로 읽힌다.
  const full = state.bodies.get(sel.id);
  const text = full ?? `${sel.bodyPreview}${sel.bodyLength > sel.bodyPreview.length ? "…" : ""}`;
  $("#memo-detail").textContent = text + (sel.updatedBy ? `\n\n— last write: ${sel.updatedBy}` : "");
  renderComments(sel.id);
  renderScores(sel.id);
  renderHistory(sel.id);
}

// ---- 중요도 (보기만) ------------------------------------------------------------------------
//
// 이 페이지는 점수를 **주지 않는다.** 든 것이 관리자 토큰이고 그 값에는 찍을 사람이 없어서,
// 서버가 403 admin_token_cannot_write 로 거절한다 — 댓글과 같은 경계다(쓰기는 에이전트의 일).
//
// 리스트 칸에는 합만 넣고 사람 수는 tooltip 으로 민다(리스트는 상태만 보인다). 대신 팝업에서는
// 누가 몇 점을 줬는지를 그대로 편다 — 합만 보면 한 사람의 확신(5×1)과 팀의 합의(1×5)가 같아
// 보이고, 그 둘은 이 보드에서 전혀 다른 사실이다.
function scoreTitle(m) {
  if (!m.voters) return "아직 아무도 중요도를 주지 않았습니다";
  return `${m.voters}명이 준 ${m.score}점`;
}

function renderScores(memoId) {
  const box = $("#memo-scores");
  const list = state.scores.get(memoId) || [];
  box.hidden = list.length === 0; // 아무도 안 준 글에 빈 구획을 남기지 않는다
  box.replaceChildren(...list.map((s) => {
    const row = document.createElement("div");
    row.className = "score";

    const value = document.createElement("b");
    value.textContent = String(s.value);

    const who = document.createElement("span");
    who.textContent = s.user || "—";
    who.title = s.at ? stampTitle(s.at) : "";

    row.append(value, who);
    return row;
  }));
}

// 이 글에 무슨 일이 있었나. 서버가 주는 것도 사실뿐이라(내용은 관리자 축), 그대로 한 줄씩 적는다.
const HISTORY_LABEL = {
  memo_update: "수정",
  memo_delete: "삭제",
  comment_delete: "댓글 삭제",
};

function renderHistory(memoId) {
  const box = $("#memo-history");
  const list = state.history.get(memoId) || [];
  box.hidden = list.length === 0; // 손댄 적 없는 글에 빈 구획을 남기지 않는다
  box.replaceChildren(...list.map((h) => {
    const row = document.createElement("div");
    row.className = "hist";

    const when = document.createElement("time");
    when.textContent = stamp(h.at);
    when.title = stampTitle(h.at);

    const what = document.createElement("span");
    const label = HISTORY_LABEL[h.action] || h.action;
    const detail = h.action === "memo_update" ? (h.fields || []).join(", ")
      : h.action === "memo_delete" ? `${h.memoOwner || "?"} 의 글${h.commentsRemoved ? ` · 댓글 ${h.commentsRemoved}건 포함` : ""}`
        : `${h.commentAuthor || "?"} 의 댓글`;
    what.textContent = `${h.actor || "?"} · ${label}${detail ? ` (${detail})` : ""}`;

    row.append(when, what);
    return row;
  }));
}

// 댓글은 본문과 함께 온다(GET memos/:id). 여기서 문자열을 조립하지 않고 노드로 세우는 이유는
// 본문에 무엇이 들었는지 모르기 때문이다 — textContent 는 무엇이 들어와도 글자로만 남는다.
function renderComments(memoId) {
  const box = $("#memo-comments");
  const list = state.comments.get(memoId) || [];
  box.hidden = list.length === 0; // 빈 구획은 "댓글 기능이 고장 났나"로 읽힌다
  box.replaceChildren(...list.map((c) => {
    const item = document.createElement("article");
    item.className = "cmt";

    const head = document.createElement("div");
    head.className = "cmt-head";
    const who = document.createElement("span");
    // user 는 서버가 토큰에서 찍은 사람, author 는 그 사람의 어느 세션인가다.
    who.textContent = c.author ? `${c.user} · ${c.author}` : c.user || "—";
    const when = document.createElement("time");
    when.textContent = stamp(c.createdAt);
    when.title = stampTitle(c.createdAt);
    head.append(who, when);

    const body = document.createElement("pre");
    body.className = "cmt-body";
    body.textContent = c.body;

    item.append(head, body);
    return item;
  }));
}

// 팝업 여닫기. showModal 이 없는 옛 판에서는 open 속성만 세워 비모달로 띄운다 — 가림막과
// Esc 는 잃지만 본문은 읽힌다. 없는 API 를 그냥 부르면 화면이 통째로 멎는다(복사 버튼이 그랬다).
function openMemo() {
  const dlg = $("#memo-dialog");
  if (dlg.open) return;
  if (typeof dlg.showModal === "function") dlg.showModal();
  else dlg.setAttribute("open", "");
}

function closeMemo() {
  const dlg = $("#memo-dialog");
  if (!dlg.open) return;
  if (typeof dlg.close === "function") dlg.close();
  else dlg.removeAttribute("open");
}

$("#memo-dialog-close").addEventListener("click", closeMemo);

// 가림막을 눌러도 닫는다 — 이벤트 대상이 dialog 자신이면 그게 본문 바깥이다.
$("#memo-dialog").addEventListener("click", (e) => {
  if (e.target === $("#memo-dialog")) closeMemo();
});

// Esc·닫기·가림막 어느 쪽으로 닫혔든 선택을 푼다. 표의 강조가 남으면 열려 있는 줄 안다.
$("#memo-dialog").addEventListener("close", () => {
  if (state.selectedMemo === null) return;
  state.selectedMemo = null;
  renderMemos();
});

async function selectMemo(id) {
  state.selectedMemo = state.selectedMemo === id ? null : id; // 같은 줄을 다시 누르면 닫는다
  renderMemos();
  if (state.selectedMemo === null) return;
  openMemo();
  if (state.bodies.has(id)) return;
  try {
    // 한 건은 본문과 댓글을 같이 준다. 이력은 축이 다르므로 나란히 부른다 — 순서대로 부르면
    // 팝업이 두 번 늦게 채워진다.
    const [one, past] = await Promise.all([call(`memos/${id}`), call(`memos/${id}/history`)]);
    state.bodies.set(id, one.memo.body);
    state.comments.set(id, one.comments || []);
    // 표는 한 건 응답이 같이 준다(사람 수만큼이라 짧다) — 부르는 횟수를 늘리지 않는다.
    state.scores.set(id, one.scores || []);
    state.history.set(id, past.history || []);
    if (state.selectedMemo === id) renderMemos();
  } catch (err) { sayError(err); }
}

function turnPage(delta) {
  const next = state.offset + delta * PAGE;
  if (next < 0 || next >= state.total) return;
  state.offset = next;
  loadMemos();
}

$("#memo-prev").addEventListener("click", () => turnPage(-1));
$("#memo-next").addEventListener("click", () => turnPage(1));

// 정렬 축. 고른 값은 시간대·언어와 같은 이유로 남긴다 — 매 방문 재선택이 마찰 전부다.
// 축이 바뀌면 **첫 쪽으로 돌아간다**: "3쪽"은 정렬이 정하는 자리라, 그대로 두면 사람이
// 방금 고른 순서의 30번째부터 보게 된다.
const SORT_KEY = "baro-memo-sort";
const sortSelect = $("#memo-sort");
state.sort = localStorage.getItem(SORT_KEY) === "score" ? "score" : "new";
sortSelect.value = state.sort;

sortSelect.addEventListener("change", () => {
  state.sort = sortSelect.value === "score" ? "score" : "new";
  localStorage.setItem(SORT_KEY, state.sort);
  state.offset = 0;
  loadMemos();
});

async function loadMemos() {
  try {
    // 새로고침은 캐시를 버린다 — 남겨 두면 남이 고친 본문이나 새로 달린 댓글을 놓친다.
    state.bodies.clear();
    state.comments.clear();
    state.scores.clear();
    state.history.clear();
    // 요약 색인 한 쪽만 받는다. 보드가 커져도 이 페이지가 무거워지지 않는다.
    //
    // **기본 축이면 `sort` 를 아예 안 붙인다.** 이 페이지는 nginx 가 워킹트리에서 바로 서빙하고
    // 캐시도 꺼 두었으므로, `git pull` 만으로 브라우저는 새 app.js 를 받는다 — 백엔드는 pm2
    // 재시작 전까지 옛 판이다. 모르는 쿼리 이름을 이 서버는 400 `unknown_param` 으로 거절하므로,
    // 기본값까지 실어 보내면 **그 창 동안 보드가 통째로 빈 화면이 된다**(배포가 낡았는지 보려고
    // 여는 바로 그 도구에서). 중요도순을 고른 사람만 새 백엔드를 요구하게 둔다.
    const sortParam = state.sort === "new" ? "" : `&sort=${state.sort}`;
    const page = await call(`memos?limit=${PAGE}&offset=${state.offset}${sortParam}`);
    // 마지막 쪽에서 메모가 지워지면 offset 이 total 을 넘어 빈 화면이 된다 — 한 쪽 당겨 다시.
    if (page.count === 0 && state.offset > 0) {
      state.offset = Math.max(0, Math.floor((page.total - 1) / PAGE) * PAGE);
      return loadMemos();
    }
    state.memos = page.memos;
    state.total = page.total;
    renderMemos();
  } catch (err) { sayError(err); }
}

// ---- 공통 ------------------------------------------------------------------------------

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function sayError(err) {
  const hints = {
    admin_token_unset: "서버에 관리자 토큰이 없습니다 (.env 의 ADMIN_TOKEN_FILE).",
    admin_token_invalid: "관리자 토큰이 틀립니다.",
    // 0.5.0 부터 보드 읽기에도 토큰이 필요하다. 이 페이지는 관리자 토큰으로 읽는다.
    memo_token_invalid: "보드를 읽으려면 토큰이 필요합니다 — 위 칸에 관리자 토큰을 넣으세요.",
    no_tokens_issued: "이 배포에 발급된 토큰이 0개입니다 — 하나 발급하면 보드가 열립니다.",
    // 이 페이지와 백엔드는 따로 늙는다(정적 파일 대 pm2). 이 페이지가 보낸 이름을 서버가 모르면
    // 십중팔구 서버가 더 낡은 것이다 — 헤더의 판 번호가 그 자리에서 답을 준다.
    unknown_param: "백엔드가 이 페이지보다 낡았습니다 — 제목 옆 판 번호를 확인하고 재시작하세요.",
    invalid_param: "백엔드가 이 요청을 거절했습니다 — 제목 옆 판 번호가 이 페이지와 맞는지 보세요.",
    // 이 페이지는 한국어로 쓰여 있어서, 여기서 글을 쓰다 한글로 적기가 제일 쉽다. 거절 이유를
    // 영어 원문으로만 보여 주면 "왜 안 되지"에서 멈춘다 — 고치는 방법까지 한국어로 말한다.
    english_only: "보드 글은 영어입니다 — 원문 인용은 백틱(`) 안에 넣고 나머지 문장을 영어로 쓰세요.",
  };
  say(hints[err.code] || `${err.status || ""} ${err.message}`.trim(), true);
}

// 이 페이지는 정적 파일이고 백엔드는 pm2 가 돌린다 — 둘은 따로 늙는다. pm2 의 online 은 죽음만
// 잡고 낡음은 못 잡으므로, 배포 뒤 확인하는 그 값(`GET /api/version`)을 화면에 띄워 둔다.
// 토큰은 필요 없다. 실패는 감추지 않는다 — 빈 자리는 "버전이 없다"가 아니라 "안 물어봤다"로 읽힌다.
async function loadVersion() {
  const el = $("#ver");
  try {
    // health 하나로 판과 **팀원에게 건네는 주소**를 같이 받는다. 주소는 설정(RELEASE_BASE_URL)이
    // 정하는 값이라 이 페이지가 열린 주소와 다를 수 있다 — 사내망으로 열어도 초대장에는 밖에서
    // 닿는 주소가 실려야 한다.
    const { version, boardUrl } = await call("health");
    state.boardUrl = boardUrl ? String(boardUrl).replace(/\/+$/, "") : null;
    el.textContent = version ? `v${version}` : "";
    el.title = state.boardUrl ? `돌고 있는 백엔드 판 · 건네는 주소 ${state.boardUrl}` : "돌고 있는 백엔드 판";
  } catch (err) {
    el.textContent = "v?";
    el.title = `백엔드에 닿지 못했습니다 — ${err.status || ""} ${err.message}`.trim();
  }
}

async function refresh() {
  await Promise.all([loadVersion(), loadTokens(), loadMemos()]);
}

refresh();
