// 관리자 토큰을 확인·발급·교체한다.
//
//   pnpm admin:token            값을 보여 준다. 파일이 없으면 만들어서 보여 준다
//   pnpm admin:token --rotate   새 값으로 바꾼다 (**재시작해야 반영된다** — server.mjs 는
//                               부팅 때 한 번만 읽는다. 재시작 전까지는 옛 값이 통하고 새 값이
//                               401 이다. 아래 38행이 찍는 문장이 그 사실이다)
//
// 경로를 외워서 cat 하는 절차를 없애려고 있는 스크립트다. 정본은 `.env` 의 ADMIN_TOKEN_FILE
// 이고, 이 스크립트는 서버와 **같은 방식으로** 그 값을 읽는다 — 서버가 읽는 파일과 운영자가
// 보는 파일이 갈라지면 이 스크립트는 없느니만 못하다.
import { randomBytes } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
try { process.loadEnvFile(join(repoRoot, ".env")); } catch { /* .env 없음 */ }

const file = String(process.env.ADMIN_TOKEN_FILE || "").trim();
if (!file) {
  console.error("ADMIN_TOKEN_FILE 이 .env 에 없습니다. (.env.example 참고)");
  console.error("환경변수 ADMIN_TOKEN 을 직접 쓰는 배포라면 이 스크립트는 쓰지 않습니다.");
  process.exit(1);
}

const rotate = process.argv.includes("--rotate");

function write(token) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  chmodSync(file, 0o600); // 이미 있던 파일은 mode 옵션이 무시된다
  return token;
}

let token = "";
let note = "";
if (rotate) {
  token = write(`adm_${randomBytes(21).toString("base64url")}`);
  note = "교체됨 — 서버 재시작 뒤부터 옛 값은 401 입니다.";
} else {
  try {
    token = readFileSync(file, "utf8").trim();
  } catch { /* 아래에서 만든다 */ }
  if (!token) {
    token = write(`adm_${randomBytes(21).toString("base64url")}`);
    note = "새로 만들었습니다 — 서버를 재시작해야 반영됩니다.";
  }
}

// 호스트는 찍지 않는다. 이 스크립트는 어느 기기에서 도는지 모르고(사내망 IP·터널 주소·
// localhost 가 다 맞다), 박아 두면 옮긴 날부터 거짓말이 된다. 마운트 경로까지가 아는 사실이다.
const base = process.env.BASE_PATH || "/memo";
console.log(`관리자 토큰: ${token}`);
console.log(`파일:        ${file}`);
console.log(`관리자 페이지: ${base}/admin/`);
if (note) console.log(note);
