// 관리자 페이지를 브라우저 없이 돌리기 위한 최소 DOM.
//
// 이 페이지는 무빌드 정적 파일이라 검사가 없었고, 그 사각지대에서 결함 둘이 나왔다:
// 빈 <select> 가 실오라기로 접혀 "컨트롤이 사라지고", 전체 목록에서 중복을 지우다 Asia/Seoul 만
// 없는 목록이 됐다. 둘 다 사람이 화면을 봐야만 보이는 종류였다 — 그래서 여기까지 내린다.
//
// 흉내 내는 것은 **app.js 가 실제로 쓰는 것**뿐이다. 레이아웃·CSS·이벤트 전파는 못 본다.
// 대신 index.html 의 정적 <option> 을 파일에서 읽어 심는다 — HTML 과 JS 의 계약(스크립트가
// 죽어도 상자는 보인다)을 검사가 같이 잡아야 하기 때문이다.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

function el(tag = "div") {
  const e = {
    tagName: tag, children: [], attrs: {}, style: {}, _parent: null,
    textContent: "", innerHTML: "", value: "", label: "", title: "",
    hidden: false, className: "", disabled: false, _on: {}, _selected: false,
    select() { e._selected = true; },
    removeChild(k) { e.children = e.children.filter((c) => c !== k); k._parent = null; return k; },
    // DOM 과 같게 **옮긴다**. 이걸 흉내 내지 않으면 optgroup 으로 묶는 코드가 여기서만
    // 항목을 두 배로 만들고, 검사는 없는 문제를 보게 된다.
    appendChild(k) {
      if (k._parent) k._parent.children = k._parent.children.filter((c) => c !== k);
      k._parent = e;
      e.children.push(k);
      return k;
    },
    append(...kids) { for (const k of kids) e.appendChild(k); },
    replaceChildren(...kids) { e.children = kids; },
    addEventListener(type, fn) { e._on[type] = fn; },
    setAttribute(k, v) { e.attrs[k] = v; },
    querySelector() { return el(); },
    reset() {},
  };
  return e;
}

// 원문 그대로. CSS 는 shim 이 해석하지 못하므로, 계약을 글자로 대조하는 검사가 따로 있다.
export function publicFile(name) {
  return readFileSync(join(publicDir, name), "utf8");
}

function indexHtml() {
  return publicFile("index.html");
}

// 버튼 라벨은 HTML 에 있다. app.js 가 그것을 읽어 두었다가 되돌리므로(복사 확인 표시),
// shim 이 빈 라벨을 주면 "되돌아왔다"가 빈 칸이 되어 검사가 거짓으로 통과한다.
function staticButtons() {
  return [...indexHtml().matchAll(/<button id="([^"]+)"[^>]*>([^<]*)<\/button>/g)]
    .map((m) => ({ id: m[1], label: m[2] }));
}

// index.html 의 <select id="tz"> 에 박힌 항목. 여기가 비면 스크립트가 멎었을 때 상자가 사라진다.
export function staticZoneOptions() {
  const html = indexHtml();
  const block = html.match(/<select id="tz"[^>]*>([\s\S]*?)<\/select>/);
  if (!block) return [];
  return [...block[1].matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)]
    .map((m) => ({ value: m[1], text: m[2] }));
}

function makeSelect(options) {
  const sel = el("select");
  for (const { value, text } of options) {
    const o = el("option");
    o.value = value;
    o.textContent = text;
    sel.appendChild(o);
  }
  // options 는 optgroup 을 펼쳐 센다. value 는 목록에 없는 값을 넣으면 "" 로 떨어진다 —
  // 브라우저의 그 동작이 app.js 의 분기 조건("목록에 없으면 칸을 만들어 붙인다")이다.
  Object.defineProperty(sel, "options", {
    get: () => sel.children.flatMap((c) => (c.tagName === "optgroup" ? c.children : [c])),
  });
  let value = "";
  Object.defineProperty(sel, "value", {
    get: () => value,
    set: (v) => { value = sel.options.some((o) => o.value === v) ? v : ""; },
  });
  return sel;
}

// 경로별 응답. 실제 백엔드의 모양만 맞춘다(version·tokens·memos).
// 요청은 전부 기록한다 — "몇 번 나갔는가"가 검사할 값인 경우가 있다(중복 발급).
function makeFetch({ version, fail, tokens, memos, requests }) {
  return async (url, options = {}) => {
    const path = String(url);
    const method = options.method || "GET";
    requests.push({ method, path, body: options.body });
    if (fail) throw new Error("network down");
    if (method === "POST" && path.includes("/admin/tokens")) {
      const issued = { id: 99, user: "new", note: "", token: "tok_new", createdAt: "2026-08-14T00:00:00.000Z", revokedAt: null };
      return { ok: true, status: 201, json: async () => ({ token: issued }) };
    }
    const one = path.match(/\/memos\/(\d+)$/);
    const body = path.includes("/version") ? { version }
      : path.includes("/admin/tokens") ? { count: tokens.length, tokens }
        : one ? (() => { const m = memos.find((x) => String(x.id) === one[1]); return { memo: m, comments: m?.comments || [] }; })()
          : { count: memos.length, total: memos.length, limit: 10, offset: 0, memos };
    return { ok: true, status: 200, json: async () => body };
  };
}

export function loadAdminPage({
  storedTz = null, version = "9.9.9", fail = false,
  // 기본값이 **평문 HTTP** 다. 실제 배포가 그렇고, shim 이 없는 API 를 있다고 흉내 내면
  // "검사는 통과하는데 화면에서는 죽는" 자리가 생긴다 — 복사 버튼이 정확히 그랬다.
  clipboard = false, execCommand = true,
  tokens = [], memos = [], adminToken = "",
} = {}) {
  const store = new Map(storedTz ? [["baro-memo-tz", storedTz]] : []);
  if (adminToken) store.set("baro-memo-admin-token", adminToken);
  const copied = [];       // clipboard 로 실제로 넘어간 값
  const execCopied = [];   // execCommand 경로로 선택된 textarea 의 값
  const requests = [];     // 나간 요청 전부 (method·path)
  const tz = makeSelect(staticZoneOptions());
  const nodes = new Map([["#tz", tz]]);
  for (const { id, label } of staticButtons()) {
    const btn = el("button");
    btn.textContent = label;
    nodes.set(`#${id}`, btn);
  }

  const body = el("body");
  const selectedRanges = [];
  // <dialog> 는 open 속성이 화면을 지배한다(UA 규칙). showModal/close 를 흉내 내되,
  // close 이벤트까지 돌려줘야 "Esc 로 닫으면 선택이 풀린다" 를 검사할 수 있다.
  const dialog = el("dialog");
  dialog.open = false;
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; dialog._on.close?.(); };
  nodes.set("#memo-dialog", dialog);
  const document = {
    body,
    createElement: (tag) => el(tag),
    // range 는 담기만 한다. 세는 것은 selection 에 **실제로 들어간** 것뿐이다 —
    // 양쪽에서 세면 한 번 선택한 것이 두 번으로 보인다.
    createRange: () => { const r = { node: null, selectNodeContents(node) { r.node = node; } }; return r; },
    querySelector: (sel) => {
      if (!nodes.has(sel)) nodes.set(sel, el(sel));
      return nodes.get(sel);
    },
  };
  // execCommand 는 선택된 textarea 를 복사한다. 그 순서(붙이고 → select() → 복사 → 떼기)를
  // 지키는지가 이 경로의 전부라, 선택되지 않은 요소는 복사되지 않은 것으로 친다.
  if (execCommand) {
    document.execCommand = (cmd) => {
      if (cmd !== "copy") return false;
      const ta = body.children.find((c) => c.tagName === "textarea" && c._selected);
      if (!ta) return false;
      execCopied.push(ta.value);
      return true;
    };
  }

  const sandbox = {
    document,
    location: { href: "http://board.test/memo/admin/" },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    fetch: makeFetch({ version, fail, tokens, memos, requests }),
    // 보안 컨텍스트가 아니면 navigator.clipboard 는 **속성 자체가 없다**. undefined 를 넣어
    // 두는 것과 같지만, 실제 브라우저의 모양을 그대로 흉내 낸다.
    navigator: clipboard ? { clipboard: { writeText: async (t) => { copied.push(t); } } } : {},
    window: { getSelection: () => ({ removeAllRanges() {}, addRange(r) { selectedRanges.push(r.node ?? r); } }) },
    confirm: () => false,
    console: { warn() {}, error() {}, log() {} },
    URL, setTimeout, clearTimeout, queueMicrotask,
  };

  runInNewContext(readFileSync(join(publicDir, "app.js"), "utf8"), sandbox, { filename: "app.js" });

  // 화면에 붙는 비동기(refresh)가 끝날 때까지 마이크로태스크를 흘려보낸다. 타이머로 기다리지
  // 않는 이유: 라벨 되돌리기를 재는 검사가 mock timer 를 켜면 그 타이머가 영영 안 돈다.
  const settled = (async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); })();
  return {
    sandbox, store, tz, settled, copied, execCopied, selectedRanges, body, requests,
    node: (sel) => sandbox.document.querySelector(sel),
    status: () => sandbox.document.querySelector("#status").textContent,
    // 리스트에서 한 줄 고르기 — 액션(복사·폐기)은 고른 뒤에만 의미가 있다.
    pickTokenRow: (i = 0) => sandbox.document.querySelector("#token-list tbody").children[i]._on.click(),
    pickMemoRow: (i = 0) => sandbox.document.querySelector("#memo-list tbody").children[i]._on.click(),
    dialog,
  };
}

// vm 에서 `function` 선언은 컨텍스트 전역에 붙는다 — app.js 를 모듈로 쪼개지 않고도
// 순수 함수(stamp/stampTitle)를 그대로 부를 수 있는 이유다.
export function zonePicked(page, zone) {
  page.tz.value = zone;
  page.tz._on.change();
}
