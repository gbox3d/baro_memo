// 관리자 토큰의 출처 규칙. 주제는 하나다 — **정본이 둘이 되지 않는다.**
//
// 파일을 가리켰는데 못 읽었을 때 환경변수로 몰래 내려가면, 운영자는 자기가 방금 고친 파일이
// 아니라 잊고 있던 환경변수로 인증되는 상황을 만난다. 그건 틀린 값으로 성공하는 것이라
// 실패보다 나쁘다.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readAdminToken } from "../src/core/admin-token.mjs";

const quiet = () => {};

function tempToken(contents) {
  const path = join(mkdtempSync(join(tmpdir(), "baro-memo-")), "admin-token");
  writeFileSync(path, contents);
  return path;
}

test("파일이 없으면 환경변수를 쓴다 — 예전 배포가 그대로 돈다", () => {
  assert.deepEqual(readAdminToken({ ADMIN_TOKEN: "adm_env" }, quiet), { token: "adm_env", source: "env" });
});

test("파일을 가리키면 파일이 정본이고, 환경변수는 무시된다", () => {
  const path = tempToken("adm_file\n");
  const { token, source } = readAdminToken({ ADMIN_TOKEN_FILE: path, ADMIN_TOKEN: "adm_env" }, quiet);
  assert.equal(token, "adm_file", "환경변수가 파일을 이겼습니다");
  assert.equal(source, path);
});

test("파일 끝의 개행·공백은 토큰이 아니다", () => {
  assert.equal(readAdminToken({ ADMIN_TOKEN_FILE: tempToken("  adm_file  \n\n") }, quiet).token, "adm_file");
});

test("파일을 못 읽으면 미설정이다 — 환경변수로 몰래 내려가지 않는다", () => {
  const lines = [];
  const { token } = readAdminToken(
    { ADMIN_TOKEN_FILE: "/nonexistent/baro-memo/admin-token", ADMIN_TOKEN: "adm_env" },
    (m) => lines.push(m),
  );
  assert.equal(token, "", "읽기 실패가 환경변수로 흘렀습니다");
  // 조용히 미설정이 되면 "왜 503 이지"를 처음부터 뒤지게 된다.
  assert.equal(lines.length, 1);
  assert.match(lines[0], /ADMIN_TOKEN_FILE/);
});

test("빈 파일과 미설정 환경변수는 둘 다 '없음' — 관리 라우트가 503 으로 답한다", () => {
  assert.equal(readAdminToken({ ADMIN_TOKEN_FILE: tempToken("\n") }, quiet).token, "");
  assert.equal(readAdminToken({}, quiet).token, "");
});
