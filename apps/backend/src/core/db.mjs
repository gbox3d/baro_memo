// SQLite 열기 — memo 와 token 이 **한 파일**을 쓰기 위한 단일 진입점.
//
// 저장소마다 커넥션을 열면 같은 프로세스 안에서도 쓰기끼리 SQLITE_BUSY 를 만날 수 있다.
// 커넥션은 서버가 하나 열어서 두 스토어에 나눠 준다 — 테스트는 ":memory:" 를 하나 열어 같은
// 방식으로 나눠 쓰면 된다.
//
// 드라이버가 Node 내장 `node:sqlite` 인 이유는 원본(baro_calrory)과 같다: 네이티브 모듈을
// 들이면 배포 호스트마다 컴파일러가 필요해지는데, 이 저장소는 pm2 로 소스를 그대로 돌린다.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function openDb(path) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  return new DatabaseSync(path);
}
