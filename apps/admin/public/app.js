// baro memo 관리자 페이지 — 토큰 발급/폐기와 보드 열람. 프레임워크 없음.
//
// API 주소는 상대경로다: nginx 가 /memo/admin/ 에서 이 페이지를, /memo/api/ 에서 백엔드를
// 서빙하므로 "../api/" 하나로 어느 마운트에서든 맞는 곳을 가리킨다.
const API = new URL("../api/", location.href);

const $ = (sel) => document.querySelector(sel);
const state = { tokens: [], memos: [], selectedToken: null, selectedMemo: null };

// 관리자 토큰은 localStorage 에 둔다 — 이 페이지의 사용자는 운영자 한 사람이고,
// 매 방문 재입력이 이 도구의 마찰 전부이기 때문이다.
const tokenInput = $("#admin-token");
tokenInput.value = localStorage.getItem("baro-memo-admin-token") || "";
tokenInput.addEventListener("change", () => {
  localStorage.setItem("baro-memo-admin-token", tokenInput.value.trim());
  refresh();
});

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
      <td>${t.createdAt.slice(0, 10)}</td>
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
  try {
    const { token } = await call("admin/tokens", {
      method: "POST",
      body: { user: $("#issue-user").value, note: $("#issue-note").value },
    });
    $("#issue-form").reset();
    state.selectedToken = token.id; // 발급 직후 값을 바로 복사할 수 있게 선택 상태로
    await loadTokens();
    say(`발급됨 — ${token.user} 에게 값을 전달하세요.`);
  } catch (err) { sayError(err); }
});

$("#token-copy").addEventListener("click", async () => {
  const sel = state.tokens.find((t) => t.id === state.selectedToken);
  if (!sel) return;
  await navigator.clipboard.writeText(sel.token);
  say("복사됨");
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
      <td>${m.updatedAt.slice(0, 16).replace("T", " ")}</td>`;
    tr.addEventListener("click", () => selectMemo(m.id));
    return tr;
  }));

  const detail = $("#memo-detail");
  const sel = state.memos.find((m) => m.id === state.selectedMemo);
  detail.hidden = !sel;
  if (sel) detail.textContent = sel.body + (sel.updatedBy ? `\n\n— last write: ${sel.updatedBy}` : "");
}

function selectMemo(id) {
  state.selectedMemo = state.selectedMemo === id ? null : id;
  renderMemos();
}

async function loadMemos() {
  try {
    state.memos = (await call("memos")).memos;
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
    admin_token_unset: "서버 .env 에 ADMIN_TOKEN 이 없습니다.",
    admin_token_invalid: "관리자 토큰이 틀립니다.",
  };
  say(hints[err.code] || `${err.status || ""} ${err.message}`.trim(), true);
}

async function refresh() {
  await Promise.all([loadTokens(), loadMemos()]);
}

refresh();
