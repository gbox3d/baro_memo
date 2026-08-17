// 마운트의 두 가지: **접두사로 갈리는가**, 그리고 **저장소가 없을 때 보드까지 죽지 않는가**.
//
// 둘째가 이 파일의 이유다. 프로세스를 합치면서 새로 생길 수 있었던 실패가 정확히 그것이다 —
// 외장 볼륨이 안 붙은 아침에 게시판까지 502 가 되는 것. 그러면 "왜 안 되지"를 물어볼 자리가
// 같이 사라진다. 마운트는 그때 503 만 답하고 보드는 평소대로 돌아야 한다.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFilesMount, FILES_PREFIX } from "../src/mount.mjs";

const anyone = () => ({ ok: true, user: "kim", admin: false });

test("접두사 밖은 이 마운트의 것이 아니다 — 보드 라우터가 가져간다", async () => {
  const root = await mkdtemp(join(tmpdir(), "baro-files-mount-"));
  const mount = await createFilesMount({ root, repoRoot: root, resolveToken: anyone, version: "t" });

  assert.equal(mount.owns("/api/memos"), false, "보드 경로를 삼키면 게시판이 사라진다");
  assert.equal(mount.owns("/api/health"), false);
  assert.equal(mount.owns("/api/filesX/uploads"), false, "접두사는 경계까지 맞아야 한다");
  assert.equal(mount.owns(`${FILES_PREFIX}/health`), true);
  assert.equal(await mount.handle("GET", "/api/memos", null, {}, {}), null, "남의 경로에는 null 로 비켜선다");

  // 스트리밍 판정도 접두사 안에서만. 보드의 같은 이름 경로가 본문을 빼앗기면 안 된다.
  assert.equal(mount.streamingId("/api/uploads/up_x/chunks"), null);
  assert.equal(mount.streamingId(`${FILES_PREFIX}/uploads/up_x/chunks`), "up_x");
  mount.close();
});

test("볼륨이 없으면 마운트만 503 이다 — 보드는 이 실패를 물려받지 않는다", async () => {
  // 디렉터리가 있어야 할 자리에 파일을 둔다 = 열 수 없는 뿌리.
  const dir = await mkdtemp(join(tmpdir(), "baro-files-broken-"));
  const root = join(dir, "not-a-dir");
  await writeFile(root, "이 자리는 디렉터리여야 한다");

  const mount = await createFilesMount({ root, repoRoot: dir, resolveToken: anyone, version: "t" });
  assert.equal(mount.ok, false, "열지 못했으면 스스로 그렇다고 말해야 한다");
  assert.ok(mount.failure, "이유가 없으면 운영자가 무엇을 고칠지 모른다");

  const health = await mount.handle("GET", `${FILES_PREFIX}/health`, null, {}, {});
  assert.equal(health.status, 503);
  assert.equal(health.json.code, "store_unavailable");
  assert.equal(health.json.retryable, true, "볼륨을 붙이면 되는 일이다 — 재시도 가능이라고 말한다");

  const upload = await mount.handle("POST", `${FILES_PREFIX}/uploads`, null, { name: "a.bin" }, {});
  assert.equal(upload.status, 503, "저장소가 없는데 세션을 열어 주면 그 뒤가 전부 거짓말이 된다");
  mount.close();
});
