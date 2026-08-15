// SQLite 열기 — baro_memo core/db.mjs 와 같은 단일 진입점.
// 커넥션은 서버가 하나 열어 스토어에 나눠 준다. 드라이버는 Node 내장 node:sqlite —
// 네이티브 모듈을 들이면 배포 호스트마다 컴파일러가 필요해진다(의존성 0 유지).
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function openDb(path) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  return new DatabaseSync(path);
}
