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
  tokens: [], memos: [], bodies: new Map(),
  offset: 0, total: 0,
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

  try {
    // 폐기된 API 지만 평문 HTTP 에서 도는 유일한 길이다.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed"; // 화면이 튀지 않게
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = typeof document.execCommand === "function" && document.execCommand("copy");
    document.body.removeChild(ta);
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
const COPY_LABEL = $("#token-copy").textContent;
let copyTimer = null;

function flashCopy(label) {
  const btn = $("#token-copy");
  clearTimeout(copyTimer); // 연타해도 원래 라벨로 돌아온다(타이머가 겹치면 라벨이 굳는다)
  btn.textContent = label;
  copyTimer = setTimeout(() => { btn.textContent = COPY_LABEL; }, 1500);
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
  $("#memo-dialog-title").textContent = `#${sel.id} · ${sel.status} · ${sel.title || "(제목 없음)"}`;
  // 전문이 아직 없으면 미리보기로 자리를 채운다 — 빈 칸은 "본문이 없다"로 읽힌다.
  const full = state.bodies.get(sel.id);
  const text = full ?? `${sel.bodyPreview}${sel.bodyLength > sel.bodyPreview.length ? "…" : ""}`;
  $("#memo-detail").textContent = text + (sel.updatedBy ? `\n\n— last write: ${sel.updatedBy}` : "");
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
    state.bodies.set(id, (await call(`memos/${id}`)).memo.body);
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

async function loadMemos() {
  try {
    // 새로고침은 캐시를 버린다 — 남겨 두면 남이 고친 본문을 옛날 것으로 보여 준다.
    state.bodies.clear();
    // 요약 색인 한 쪽만 받는다. 보드가 커져도 이 페이지가 무거워지지 않는다.
    const page = await call(`memos?limit=${PAGE}&offset=${state.offset}`);
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
  };
  say(hints[err.code] || `${err.status || ""} ${err.message}`.trim(), true);
}

// 이 페이지는 정적 파일이고 백엔드는 pm2 가 돌린다 — 둘은 따로 늙는다. pm2 의 online 은 죽음만
// 잡고 낡음은 못 잡으므로, 배포 뒤 확인하는 그 값(`GET /api/version`)을 화면에 띄워 둔다.
// 토큰은 필요 없다. 실패는 감추지 않는다 — 빈 자리는 "버전이 없다"가 아니라 "안 물어봤다"로 읽힌다.
async function loadVersion() {
  const el = $("#ver");
  try {
    const { version } = await call("version");
    el.textContent = version ? `v${version}` : "";
    el.title = "돌고 있는 백엔드 판";
  } catch (err) {
    el.textContent = "v?";
    el.title = `백엔드에 닿지 못했습니다 — ${err.status || ""} ${err.message}`.trim();
  }
}

async function refresh() {
  await Promise.all([loadVersion(), loadTokens(), loadMemos()]);
}

refresh();
