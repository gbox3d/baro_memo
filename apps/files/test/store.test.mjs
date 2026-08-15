// FileStore — 장부와 바이트의 수명. 주제는 셋이다.
//
//  1) **구간 산수가 재개의 전부다.** received/missing 이 틀리면 클라이언트는 멀쩡한 구간을
//     다시 보내거나(느림), 빠진 구간을 안 보낸다(영원히 incomplete).
//  2) **finalize 는 검증이다.** 커버리지 → 해시 → 대조. 불일치가 세션을 지우면 2.8GB 를
//     처음부터 다시 올리게 된다 — 그게 이 축의 최악이라, 세션은 남아야 한다.
//  3) **상한들이 저장소에 있다.** 이름·크기·해시·쿼터·여유 공간 — 라우터를 안 거치는 경로가
//     생겨도 불변식은 지켜진다.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "../src/core/db.mjs";
import { FileStore, LIMITS, mergeRanges, missingRanges } from "../src/files/store.mjs";

async function rig(limits = {}) {
  const root = await mkdtemp(join(tmpdir(), "baro-files-test-"));
  const store = new FileStore(openDb(":memory:"), { root, limits: { ...LIMITS, ...limits } });
  await store.init();
  test.after(() => rm(root, { recursive: true, force: true }));
  return { root, store };
}

const sha = (buf) => createHash("sha256").update(buf).digest("hex");

// 파일 조각을 tmp 본체의 제자리에 써 넣는다 — server.mjs 의 스트림이 하는 일의 축약.
async function put(store, id, buf, start) {
  const { open } = await import("node:fs/promises");
  const fd = await open(store.tmpPath(id), "r+");
  try { await fd.write(buf, 0, buf.length, start); } finally { await fd.close(); }
  store.recordRange(id, start, start + buf.length);
}

test("구간 병합 — 재전송·인접·겹침이 행을 늘리지 않는다", () => {
  assert.deepEqual(mergeRanges([[0, 10], [10, 20]]), [[0, 20]], "인접은 하나다");
  assert.deepEqual(mergeRanges([[0, 10], [5, 15]]), [[0, 15]], "겹침도 하나다");
  assert.deepEqual(mergeRanges([[20, 30], [0, 10]]), [[0, 10], [20, 30]], "순서는 정렬된다");
  assert.deepEqual(mergeRanges([[0, 10], [0, 10]]), [[0, 10]], "재전송은 무해하다");
});

test("빈 구간 — 서버가 계산해 주므로 클라이언트는 장부가 필요 없다", () => {
  assert.deepEqual(missingRanges([], 100), [[0, 100]]);
  assert.deepEqual(missingRanges([[0, 40]], 100), [[40, 100]]);
  assert.deepEqual(missingRanges([[10, 40], [60, 100]], 100), [[0, 10], [40, 60]]);
  assert.deepEqual(missingRanges([[0, 100]], 100), []);
});

test("세션 생성이 선언을 검증한다 — 이름·크기·해시", async () => {
  const { store } = await rig();
  const good = { name: "sim_v1.zip", size: 10, sha256: "a".repeat(64) };

  await assert.rejects(store.createUpload(good, ""), { code: "user_required" });
  await assert.rejects(store.createUpload({ ...good, name: ".hidden" }, "kim"), { code: "invalid_name" });
  await assert.rejects(store.createUpload({ ...good, name: "한글.zip" }, "kim"), { code: "invalid_name" });
  await assert.rejects(store.createUpload({ ...good, size: 0 }, "kim"), { code: "invalid_size" });
  await assert.rejects(store.createUpload({ ...good, size: 1.5 }, "kim"), { code: "invalid_size" });
  await assert.rejects(store.createUpload({ ...good, sha256: "xyz" }, "kim"), { code: "invalid_sha256" });

  const up = await store.createUpload(good, "kim");
  assert.equal(up.user, "kim");
  assert.deepEqual(up.missing, [[0, 10]]);
  // 본체가 선언 크기로 미리 서 있다(희소) — 어느 offset 이든 바로 앉는다.
  assert.equal((await stat(store.tmpPath(up.id)).then((s) => s.size)), 10);
  // 대문자 해시는 소문자로 눕는다 — 비교가 대소문자에 걸려 넘어지지 않게.
  const upper = await store.createUpload({ ...good, sha256: "A".repeat(64) }, "kim");
  assert.equal(upper.sha256, "a".repeat(64));
});

test("순서 없는 청크 → 완성 → 해시 검증 → store 로", async () => {
  const { store } = await rig();
  const body = Buffer.from("0123456789abcdefghij"); // 20 bytes
  const up = await store.createUpload({ name: "f.bin", size: 20, sha256: sha(body) }, "kim");

  await put(store, up.id, body.subarray(10, 20), 10); // 뒤부터
  assert.deepEqual(store.inventory(up.id).missing, [[0, 10]]);
  await put(store, up.id, body.subarray(0, 10), 0);
  assert.equal(store.inventory(up.id).complete, true);

  const { artifact, deduplicated } = await store.finalize(up.id);
  assert.equal(deduplicated, false);
  assert.equal(artifact.sha256, sha(body));
  assert.equal(artifact.user, "kim");
  assert.deepEqual(await readFile(store.storePath(artifact.sha256)), body);
  // 세션은 정리됐다 — 유령이 안 남는다.
  assert.equal(store.getUpload(up.id), null);
  // nginx(www-data)가 읽어야 한다 — 파일 권한이 곧 다운로드 가용성이다.
  const mode = (await stat(store.storePath(artifact.sha256))).mode & 0o777;
  assert.equal(mode & 0o044, 0o044, `others/group 읽기가 없다: ${mode.toString(8)}`);
});

test("구멍이 있으면 finalize 가 첫 구멍을 말하고, 해시 불일치는 세션을 지키며 재전송으로 회복된다", async () => {
  const { store } = await rig();
  const body = Buffer.from("0123456789");
  const up = await store.createUpload({ name: "f.bin", size: 10, sha256: sha(body) }, "kim");

  await put(store, up.id, body.subarray(5, 10), 5);
  await assert.rejects(store.finalize(up.id), (e) => {
    assert.equal(e.code, "upload_incomplete");
    assert.match(e.message, /byte 0/, "첫 구멍의 위치가 문장에 있어야 한다");
    return true;
  });

  // 틀린 바이트로 채우면 커버리지는 차지만 해시가 다르다.
  await put(store, up.id, Buffer.from("XXXXX"), 0);
  await assert.rejects(store.finalize(up.id), { code: "sha256_mismatch" });
  assert.ok(store.getUpload(up.id), "불일치가 세션을 지우면 전체 재업로드가 된다");
  assert.equal(store.getUpload(up.id).state, "open", "다시 청크를 받을 수 있어야 한다");

  // 맞는 바이트로 그 구간만 다시 → 이번엔 통과.
  await put(store, up.id, body.subarray(0, 5), 0);
  const { artifact } = await store.finalize(up.id);
  assert.equal(artifact.sha256, sha(body));
});

test("같은 바이트의 재발행은 기존 완성본을 돌려준다 — 전량을 올린 뒤에만", async () => {
  const { store } = await rig();
  const body = Buffer.from("same-bytes");
  const first = await store.createUpload({ name: "a.bin", size: body.length, sha256: sha(body) }, "kim");
  await put(store, first.id, body, 0);
  await store.finalize(first.id);

  const second = await store.createUpload({ name: "b.bin", size: body.length, sha256: sha(body) }, "lee");
  await put(store, second.id, body, 0);
  const { artifact, deduplicated } = await store.finalize(second.id);
  assert.equal(deduplicated, true);
  assert.equal(artifact.user, "kim", "정체는 첫 발행이다 — 이름도 귀속도 덮이지 않는다");
  assert.equal(store.getUpload(second.id), null, "두 번째 세션도 정리된다");
});

test("쿼터는 완성본 + 진행 중 선언 크기의 합이다", async () => {
  const { store } = await rig({ userQuotaBytes: 100 });
  const a = await store.createUpload({ name: "a.bin", size: 60, sha256: "a".repeat(64) }, "kim");
  await assert.rejects(
    store.createUpload({ name: "b.bin", size: 50, sha256: "b".repeat(64) }, "kim"),
    { code: "quota_exceeded" },
  );
  // 남의 몫과는 무관하다.
  await store.createUpload({ name: "c.bin", size: 90, sha256: "c".repeat(64) }, "lee");
  // 세션을 버리면 몫이 돌아온다.
  await store.abandonUpload(a.id);
  await store.createUpload({ name: "d.bin", size: 90, sha256: "d".repeat(64) }, "kim");
});

test("여유 공간 예약 — 이 볼륨에는 보드도 산다", async () => {
  // 실제 디스크의 여유는 시험 호스트마다 다르므로, 예약을 여유보다 크게 주입해 "어떤 크기도
  // 예약을 깬다"는 상황을 만든다 — 검사하는 것은 산수가 아니라 **검사가 존재한다는 사실**이다.
  const { store } = await rig({ reserveBytes: Number.MAX_SAFE_INTEGER });
  await assert.rejects(
    store.createUpload({ name: "big.bin", size: 1024, sha256: "e".repeat(64) }, "kim"),
    { code: "insufficient_storage" },
  );
});

test("유령 세션 정리 — 완성본은 절대 건드리지 않는다", async () => {
  let clock = Date.parse("2026-08-15T00:00:00Z");
  const root = await mkdtemp(join(tmpdir(), "baro-files-reap-"));
  test.after(() => rm(root, { recursive: true, force: true }));
  const store = new FileStore(openDb(":memory:"), { root, now: () => new Date(clock) });
  await store.init();

  const body = Buffer.from("keep-me");
  const done = await store.createUpload({ name: "done.bin", size: body.length, sha256: sha(body) }, "kim");
  await put(store, done.id, body, 0);
  await store.finalize(done.id);
  const stale = await store.createUpload({ name: "stale.bin", size: 10, sha256: "f".repeat(64) }, "kim");

  clock += LIMITS.sessionTtlMs + 1;
  assert.equal(await store.reapStale(), 1);
  assert.equal(store.getUpload(stale.id), null);
  assert.ok(store.getArtifact(sha(body)), "완성본이 살아 있어야 한다");
  await assert.rejects(stat(store.tmpPath(stale.id)), { code: "ENOENT" });
});

test("목록·조회·삭제 — 삭제는 파일까지 간다", async () => {
  const { store } = await rig();
  const body = Buffer.from("to-be-deleted");
  const up = await store.createUpload({ name: "del.bin", size: body.length, sha256: sha(body) }, "kim");
  await put(store, up.id, body, 0);
  const { artifact } = await store.finalize(up.id);

  assert.equal(store.listArtifacts().total, 1);
  assert.equal(store.listArtifacts({ q: "del" }).total, 1);
  assert.equal(store.listArtifacts({ q: "%" }).total, 0, "LIKE 와일드카드는 글자다");

  assert.equal(await store.removeArtifact(artifact.sha256), true);
  assert.equal(store.getArtifact(artifact.sha256), null);
  await assert.rejects(stat(store.storePath(artifact.sha256)), { code: "ENOENT" });
  assert.equal(await store.removeArtifact(artifact.sha256), false, "재삭제는 이미 원하는 상태다");
});

// ---- 크래시 화해와 진행 계수 — 검토에서 실증된 두 결함의 회귀 자리 ----------------------

test("흐르는 청크가 있으면 finalize 가 upload_busy 로 물러난다 — 발행본 오염의 그 창", async () => {
  const { store } = await rig();
  const body = Buffer.from("busy-guard!");
  const up = await store.createUpload({ name: "busy.bin", size: body.length, sha256: sha(body) }, "kim");
  await put(store, up.id, body, 0);

  const held = store.beginChunk(up.id);
  assert.ok(held, "open 세션은 자리를 내준다");
  await assert.rejects(store.finalize(up.id), { code: "upload_busy" });
  assert.equal(store.getUpload(up.id).state, "open", "물러날 때 상태를 되돌린다 — 아니면 세션이 고착된다");

  store.endChunk(up.id);
  const { artifact } = await store.finalize(up.id);
  assert.equal(artifact.sha256, sha(body));
});

test("finalizing 중에는 beginChunk 가 자리를 안 준다", async () => {
  const { store } = await rig();
  const up = await store.createUpload({ name: "f.bin", size: 4, sha256: "a".repeat(64) }, "kim");
  store.setState(up.id, "finalizing");
  assert.equal(store.beginChunk(up.id), null);
  assert.equal(store.beginChunk("up_none"), null);
});

test("reaper 는 흐르는 세션을 건너뛰고, 활동 표식은 청크 시작 시점이다", async () => {
  let clock = Date.parse("2026-08-15T00:00:00Z");
  const root = await mkdtemp(join(tmpdir(), "baro-files-reap2-"));
  test.after(() => rm(root, { recursive: true, force: true }));
  const store = new FileStore(openDb(":memory:"), { root, now: () => new Date(clock) });
  await store.init();

  const up = await store.createUpload({ name: "slow.bin", size: 10, sha256: "b".repeat(64) }, "kim");
  clock += LIMITS.sessionTtlMs + 1;
  store.inflight.set(up.id, 1); // 몇 시간째 흐르는 스트림 — 연구실 간 링크에서는 정상 운행이다
  assert.equal(await store.reapStale(), 0, "흐르는 세션을 지우면 바이트는 유령 inode 로 가고 장부는 FK 로 죽는다");
  store.inflight.delete(up.id);

  // beginChunk 가 활동 표식을 **시작** 시점에 찍는다 — 완료 시점만 찍으면 긴 스트림이 잡힌다.
  store.beginChunk(up.id);
  store.endChunk(up.id);
  assert.equal(await store.reapStale(), 0, "방금 시작한 세션은 신선하다");
  clock += LIMITS.sessionTtlMs + 1;
  assert.equal(await store.reapStale(), 1);
});

test("크래시 화해: rename 뒤에 죽었으면 장부를 마저 적는다", async () => {
  const root = await mkdtemp(join(tmpdir(), "baro-files-recover1-"));
  test.after(() => rm(root, { recursive: true, force: true }));
  const db = openDb(":memory:");
  const store = new FileStore(db, { root });
  await store.init();

  const body = Buffer.from("crashed-after-rename");
  const up = await store.createUpload({ name: "cr.bin", size: body.length, sha256: sha(body) }, "kim");
  await put(store, up.id, body, 0);
  // finalize 가 rename 까지 하고 죽은 모양을 손으로 만든다.
  store.setState(up.id, "finalizing");
  const { rename } = await import("node:fs/promises");
  await rename(store.tmpPath(up.id), store.storePath(sha(body)));

  // 재시작 = 같은 db·root 로 새 스토어 + init().
  const revived = new FileStore(db, { root });
  await revived.init();
  assert.ok(revived.getArtifact(sha(body)), "검증을 통과한 바이트다 — 장부만 마저 적으면 된다");
  assert.equal(revived.getUpload(up.id), null, "세션은 정리된다");
  assert.deepEqual(await readFile(revived.storePath(sha(body))), body);
});

test("크래시 화해: rename 전에 죽었으면 세션이 open 으로 돌아온다", async () => {
  const root = await mkdtemp(join(tmpdir(), "baro-files-recover2-"));
  test.after(() => rm(root, { recursive: true, force: true }));
  const db = openDb(":memory:");
  const store = new FileStore(db, { root });
  await store.init();

  const up = await store.createUpload({ name: "half.bin", size: 10, sha256: "c".repeat(64) }, "kim");
  store.setState(up.id, "finalizing"); // 해시 도중 죽었다 — tmp 는 그대로다

  const revived = new FileStore(db, { root });
  await revived.init();
  assert.equal(revived.getUpload(up.id).state, "open", "고착된 finalizing 은 영원한 409 다");
  assert.ok(revived.beginChunk(up.id), "다시 청크를 받을 수 있어야 재개다");
  revived.endChunk(up.id);
});

test("크래시 화해: 어느 장부도 가리키지 않는 store 파일은 유령이다 — 지운다", async () => {
  const root = await mkdtemp(join(tmpdir(), "baro-files-recover3-"));
  test.after(() => rm(root, { recursive: true, force: true }));
  const db = openDb(":memory:");
  const store = new FileStore(db, { root });
  await store.init();
  const ghost = "9".repeat(64);
  await writeFile(store.storePath(ghost), Buffer.from("ghost-bytes"));

  const revived = new FileStore(db, { root });
  await revived.init();
  await assert.rejects(stat(revived.storePath(ghost)), { code: "ENOENT" },
    "보이지 않는데 다운로드만 되는 바이트가 최악이다 — 내용 주소라 재업로드로 복원된다");
});

test("완성본 권한은 umask 와 무관하게 0644 다 — nginx(www-data)가 읽는 것이 계약이다", async () => {
  const prev = process.umask(0o077); // 가장 인색한 umask 밑에서도
  try {
    const { store } = await rig();
    const body = Buffer.from("perm-check");
    const up = await store.createUpload({ name: "perm.bin", size: body.length, sha256: sha(body) }, "kim");
    await put(store, up.id, body, 0);
    const { artifact } = await store.finalize(up.id);
    assert.equal((await stat(store.storePath(artifact.sha256))).mode & 0o777, 0o644);
    assert.equal((await stat(join(store.root, "store"))).mode & 0o777, 0o755, "디렉터리 x 가 없으면 전부 403 이다");
  } finally { process.umask(prev); }
});
