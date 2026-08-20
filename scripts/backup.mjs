// 백업 — 살아 있는 것 넷을 저장소 밖으로 뜬다.
//
//   pnpm backup                  전부 (DB 둘 · 관리자 토큰 · .env · 아티팩트 바이트)
//   pnpm backup --skip-store     장부만. 바이트는 크고 느리다
//   pnpm backup --dest /어디     목적지 지정 (기본은 아래 DEFAULT_DEST)
//
// **도는 중에 cp 하지 않는다.** SQLite 파일을 쓰기 도중 복사하면 찢어진 사본이 된다. 여기서는
// `VACUUM INTO` 를 쓴다 — SQLite 가 스스로 일관된 사본을 만들고, 서버를 멈출 필요가 없다.
// (sqlite3 CLI 의 `.backup` 과 같은 일이고, 이쪽은 Node 내장이라 새로 깔 것이 없다.)
//
// **아티팩트는 내용 주소다**(store/<sha256>). 파일 이름이 곧 내용이라 한 번 복사한 것은 영원히
// 같다 — 그래서 증분 규칙이 "없는 것만 복사"로 끝난다. rsync 도 타임스탬프 비교도 필요 없다.
//
// **자동으로 돌지 않는다.** 시킬 때만 도는 명령이다 — cron 도 pm2 도 걸지 않는다. 백업이
// 저절로 돌면 목적지가 조용히 차고, 그 사실은 디스크가 가득 찬 날에야 드러난다.
//
// **루트 디스크에는 뜨지 않는다.** 이 호스트의 루트는 NVMe 916G 이고 아티팩트 볼륨은 11T 다 —
// 거기에 백업을 쌓으면 언젠가 루트가 차고, 루트가 차면 보드만이 아니라 호스트가 멎는다.
// 목적지는 별도 디스크를 마운트한 자리여야 한다. 아래 검사가 그것을 강제한다(경고가 아니라
// 거부다: 경고는 바쁜 날 읽히지 않는다).
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, chmodSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
try { process.loadEnvFile(join(repoRoot, ".env")); } catch { /* 없으면 기본값으로 간다 */ }

const DEFAULT_DEST = "/mnt/baro_memo_backup";

const args = process.argv.slice(2);
const skipStore = args.includes("--skip-store");
const destArg = args.find((a) => a.startsWith("--dest="))?.slice(7)
  || (args.includes("--dest") ? args[args.indexOf("--dest") + 1] : null);
const DEST = destArg || process.env.BACKUP_DIR || DEFAULT_DEST;

const abs = (p, fallback) => {
  const v = p || fallback;
  return isAbsolute(v) ? v : join(repoRoot, v);
};
const MEMO_DB = abs(process.env.MEMO_DB, "localfiles/memo.db");
const FILES_ROOT = abs(process.env.FILES_ROOT, "localfiles/files");
const ADMIN_TOKEN_FILE = process.env.ADMIN_TOKEN_FILE || "";

const stamp = new Date().toISOString().slice(0, 10);
const snapshot = join(DEST, stamp);

function human(n) {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i += 1; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

// 살아 있는 DB 를 멈추지 않고 일관되게 뜬다. 사본은 원본과 같은 행 수여야 한다 — 안 맞으면
// 조용히 반쪽짜리를 남기지 않고 여기서 죽는다(백업의 유일한 실패 모드는 "있는 줄 알았다"다).
//
// **임시 이름으로 뜨고 검증한 뒤에 제자리로 옮긴다.** 두 가지를 이 순서가 해결한다:
// `VACUUM INTO` 는 이미 있는 파일에 쓰지 않으므로(SQL logic error) 같은 날 두 번째 실행이나
// 실패 후 재시도가 막히고, 제자리에 바로 쓰면 실패한 실행이 **멀쩡하던 어제 사본을 반쪽으로
// 만든다.** 옮기기는 같은 디렉터리 안이라 원자적이다.
function copyDb(src, out, table) {
  if (!existsSync(src)) return null;
  const tmp = `${out}.tmp`;
  rmSync(tmp, { force: true });
  const db = new DatabaseSync(src, { readOnly: true });
  try {
    db.exec(`VACUUM INTO '${tmp.replaceAll("'", "''")}'`);
    const before = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    const copy = new DatabaseSync(tmp, { readOnly: true });
    const after = copy.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    copy.close();
    if (before !== after) throw new Error(`행 수가 다르다: 원본 ${before} vs 사본 ${after}`);
    renameSync(tmp, out);
    return { rows: after, bytes: statSync(out).size };
  } catch (error) {
    rmSync(tmp, { force: true }); // 반쪽을 남기지 않는다
    throw error;
  } finally { db.close(); }
}

// 내용 주소라 **없는 것만** 복사하면 그게 곧 증분이다. 이름이 같으면 내용도 같다.
function mirrorStore(srcDir, outDir) {
  if (!existsSync(srcDir)) return { copied: 0, skipped: 0, bytes: 0 };
  mkdirSync(outDir, { recursive: true });
  let copied = 0, skipped = 0, bytes = 0;
  for (const name of readdirSync(srcDir)) {
    const from = join(srcDir, name);
    const to = join(outDir, name);
    const size = statSync(from).size;
    if (existsSync(to) && statSync(to).size === size) { skipped += 1; continue; }
    copyFileSync(from, to);
    copied += 1; bytes += size;
  }
  return { copied, skipped, bytes };
}

if (!existsSync(DEST)) {
  console.error(`목적지가 없습니다: ${DEST}`);
  console.error("별도 디스크를 그 자리에 마운트하고 다시 실행하세요. 디렉터리를 자동으로 만들지");
  console.error("않는 이유는 두 가지입니다: 오타 난 경로에 쌓인 백업은 없는 것과 같고, 마운트가");
  console.error("안 된 자리에 만들면 그 밑은 루트 디스크입니다.");
  process.exit(1);
}

// 루트와 같은 장치면 거부한다. statSync().dev 가 파일시스템(장치)을 가리키므로, 마운트가
// 안 된 자리는 루트와 같은 값이 나온다 — 그게 정확히 막아야 할 경우다.
if (statSync(DEST).dev === statSync("/").dev) {
  console.error(`목적지가 루트 디스크입니다: ${DEST}`);
  console.error("거기에는 백업하지 않습니다. 별도 디스크를 그 자리에 마운트한 뒤 다시 실행하세요");
  console.error("(마운트 확인: df -h " + DEST + " 가 / 와 다른 파일시스템을 보여야 합니다).");
  process.exit(1);
}

// 데이터와 같은 장치면 도는 것은 막지 않되 사실은 말한다 — 실수로 지운 것에는 듣지만
// 디스크가 죽는 날에는 함께 죽는 백업이다.
if (existsSync(MEMO_DB) && statSync(DEST).dev === statSync(MEMO_DB).dev) {
  console.warn("주의: 목적지가 데이터와 같은 디스크입니다. 실수 삭제에는 듣지만 디스크 고장에는");
  console.warn("      안 듣습니다.\n");
}
mkdirSync(snapshot, { recursive: true });

console.log(`백업 → ${snapshot}`);
const memo = copyDb(MEMO_DB, join(snapshot, "memo.db"), "memo");
console.log(memo ? `  memo.db      ${memo.rows}건 · ${human(memo.bytes)}` : "  memo.db      (원본 없음)");

const files = copyDb(join(FILES_ROOT, "files.db"), join(snapshot, "files.db"), "artifact");
console.log(files ? `  files.db     ${files.rows}건 · ${human(files.bytes)}` : "  files.db     (원본 없음)");

if (ADMIN_TOKEN_FILE && existsSync(ADMIN_TOKEN_FILE)) {
  const out = join(snapshot, "admin-token");
  copyFileSync(ADMIN_TOKEN_FILE, out);
  chmodSync(out, 0o600); // 지키는 대상과 같은 권한으로 — 백업본이 더 헐거우면 백업이 구멍이다
  console.log("  admin-token  복사됨 (600)");
} else {
  console.log("  admin-token  (설정 없음 — 이 배포는 토큰 발급이 막혀 있습니다)");
}

if (existsSync(join(repoRoot, ".env"))) {
  const out = join(snapshot, "env");
  copyFileSync(join(repoRoot, ".env"), out);
  chmodSync(out, 0o600);
  console.log("  .env         복사됨 (600) — 위 셋의 경로를 아는 유일한 파일입니다");
}

if (skipStore) {
  console.log("  store/       건너뜀 (--skip-store)");
} else {
  const s = mirrorStore(join(FILES_ROOT, "store"), join(DEST, "store"));
  console.log(`  store/       새로 ${s.copied}개(${human(s.bytes)}) · 이미 있던 ${s.skipped}개`);
}

// 자동으로 지우지 않는다. 지우는 것은 사람이 보고 정하는 일이고, 스크립트가 조용히 지운 백업은
// 필요해진 날에야 없다는 것을 알게 된다. 대신 얼마나 쌓였는지는 매번 말해 준다.
const snaps = readdirSync(DEST).filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n)).sort();
console.log(`\n스냅샷 ${snaps.length}개 (${snaps[0]} … ${snaps.at(-1)})`);
console.log(`복구 절차: docs/operations.md 「백업과 복구」`);
