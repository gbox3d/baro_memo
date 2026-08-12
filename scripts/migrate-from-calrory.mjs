// baro_calrory 의 memo.db 에서 메모를 이 서비스로 이관한다.
//
//   node scripts/migrate-from-calrory.mjs [원본.db] [대상.db]
//
// id 를 **보존**한다 — 외부 메모·대화가 "3번 메모"라고 적어 뒀다면 이관 뒤에도 같은 것을
// 가리켜야 한다. 그래서 대상에 같은 id 가 이미 있으면 그 행은 건너뛰고 보고한다(덮어쓰지
// 않는다 — 이관은 몇 번을 다시 돌려도 안전해야 한다).
//
// 원본에는 user/updated_by 가 없다(공유 토큰 시절). 빈 문자열로 둔다 — help/memo.md 가
// "migrated posts carry user: ''" 라고 이미 약속했다.
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { openDb } from "../apps/backend/src/core/db.mjs";
import { MemoStore } from "../apps/backend/src/memo/memo-store.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = process.argv[2] || "/home/gblab-dgx-01/works/baro_calrory/localfiles/memo.db";
const targetPath = process.argv[3] || join(repoRoot, "localfiles", "memo.db");

if (!existsSync(sourcePath)) {
  console.error(`원본이 없습니다: ${sourcePath}`);
  process.exit(1);
}

const source = new DatabaseSync(sourcePath, { readOnly: true });
const targetDb = openDb(targetPath);
new MemoStore(targetDb); // 스키마 생성은 저장소가 안다 — 여기서 CREATE TABLE 을 반복하지 않는다

const rows = source.prepare("SELECT * FROM memo ORDER BY id").all();
const insert = targetDb.prepare(
  "INSERT INTO memo (id, title, body, status, author, user, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, '', '', ?, ?)",
);

let copied = 0;
const skipped = [];
for (const r of rows) {
  if (targetDb.prepare("SELECT 1 FROM memo WHERE id = ?").get(r.id)) { skipped.push(r.id); continue; }
  insert.run(r.id, r.title, r.body, r.status, r.author, r.created_at, r.updated_at);
  copied++;
}

// AUTOINCREMENT 시퀀스를 이관된 최대 id 위로 올린다 — 명시 id 삽입은 시퀀스를 안 건드리는
// 경우가 있어, 다음 신규 메모가 이관본과 같은 id 를 받으면 "재사용 금지" 약속이 깨진다.
const maxId = targetDb.prepare("SELECT MAX(id) AS m FROM memo").get().m || 0;
const seq = targetDb.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'memo'").get();
if (!seq) targetDb.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('memo', ?)").run(maxId);
else if (seq.seq < maxId) targetDb.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'memo'").run(maxId);

console.log(`원본 ${rows.length}건 중 ${copied}건 이관 → ${targetPath}`);
if (skipped.length) console.log(`이미 있어 건너뜀: id ${skipped.join(", ")}`);

source.close();
targetDb.close();
