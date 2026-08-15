// 업로드 세션과 완성본의 장부 + 바이트 파일의 수명.
//
// 디스크 배치 (FILES_ROOT):
//   files.db      이 장부
//   tmp/<id>      진행 중인 세션의 본체. 세션 생성 때 선언 크기로 ftruncate 해 두고(희소 파일),
//                 청크는 그 자리(offset)에 바로 쓴다 — DWarf 의 조각파일+병합은 피크 디스크를
//                 두 배로 만들고 병합 패스를 요구한다. 여기서는 둘 다 없다.
//   store/<sha256>  완성본. finalize 가 해시를 검증한 뒤 rename 으로 옮긴다(같은 파일시스템
//                 이라 원자적). nginx 가 이 디렉터리를 alias 로 직접 서빙한다 — 그래서
//                 파일 권한이 계약이다(0644, www-data 가 읽는다).
import { randomBytes, createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, chmod, mkdir, open, readdir, rename, rm, stat, statfs } from "node:fs/promises";
import { join } from "node:path";

import { fail } from "../core/http.mjs";
import { ensureSchema } from "./schema.mjs";

export const LIMITS = Object.freeze({
  // 한 파일 상한. 릴리스 zip 은 ~3GB 이고, 상한 없는 업로드는 상한 없는 디스크 약속이다.
  maxFileBytes: 50 * 1024 ** 3,
  // 청크 상한 — DWarf 와 같은 100MiB. nginx 의 client_max_body_size(120m)가 이 값보다 커야 한다.
  maxChunkBytes: 100 * 1024 ** 2,
  // 이 밑으로는 받지 않는다. 이 볼륨에는 보드 DB 도 산다 — 프로세스를 갈랐어도 디스크는
  // 공유라, 여유를 지키는 것은 아티팩트 쪽의 의무다.
  reserveBytes: 20 * 1024 ** 3,
  // 사람당 상한(완성본 + 진행 중 선언 크기의 합).
  userQuotaBytes: 1024 ** 4, // 1 TiB
  // 마지막 청크로부터 이 시간이 지난 세션은 유령이다. 연구실 간 링크는 몇 시간씩 정체될 수
  // 있으므로 넉넉히 둔다.
  sessionTtlMs: 48 * 3600 * 1000,
});

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const SHA_PATTERN = /^[0-9a-f]{64}$/;

function toUpload(row) {
  if (!row) return null;
  return {
    id: row.id, user: row.user, name: row.name, size: row.size, sha256: row.sha256,
    state: row.state, createdAt: row.created_at, lastActivity: row.last_activity,
  };
}

function toArtifact(row) {
  if (!row) return null;
  return { sha256: row.sha256, name: row.name, size: row.size, user: row.user, createdAt: row.created_at };
}

// [start,end) 구간 병합 — 재전송·인접 청크가 행을 늘리지 않게.
export function mergeRanges(ranges) {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

// 받은 구간의 여집합 — 클라이언트가 장부를 들고 다니지 않아도 재개할 수 있게 서버가 계산한다.
export function missingRanges(received, size) {
  const gaps = [];
  let cursor = 0;
  for (const [s, e] of received) {
    if (s > cursor) gaps.push([cursor, s]);
    cursor = Math.max(cursor, e);
  }
  if (cursor < size) gaps.push([cursor, size]);
  return gaps;
}

export class FileStore {
  constructor(db, { root, limits = LIMITS, now = () => new Date() } = {}) {
    this.db = db;
    this.root = root;
    this.limits = limits;
    this.now = now;
    // 진행 중인 청크 스트림의 수. **finalize 와 reaper 가 활성 쓰기를 보는 유일한 창**이다 —
    // 이 수를 세지 않으면 해시 중에 이미 흐르던 청크가 발행본(같은 inode)에 계속 써진다.
    this.inflight = new Map();
    ensureSchema(db);
  }

  async init() {
    await mkdir(join(this.root, "tmp"), { recursive: true });
    // nginx(www-data)가 store 를 직접 읽는다 — 디렉터리 x, 파일 r 이 다운로드의 전제다.
    await mkdir(join(this.root, "store"), { recursive: true, mode: 0o755 });
    await chmod(join(this.root, "store"), 0o755);
    await this.recover();
  }

  /**
   * 크래시 화해. finalize 는 (해시 → rename → 장부 트랜잭션) 순서라, 죽는 지점마다 남는
   * 모양이 다르다 — 재시작이 그 모양을 읽고 마저 하거나 되돌린다. 이게 없으면 finalizing
   * 에 고착된 세션은 영원히 409 만 답하고, rename 은 됐는데 장부가 없는 완성본은 목록에
   * 안 보이는 채로 다운로드만 되는 유령이 된다(검토에서 실증된 두 결함).
   */
  async recover() {
    const exists = (p) => access(p).then(() => true, () => false);

    for (const row of this.db.prepare("SELECT * FROM upload WHERE state = 'finalizing'").all()) {
      const inStore = await exists(this.storePath(row.sha256));
      const inTmp = await exists(this.tmpPath(row.id));
      const published = this.getArtifact(row.sha256);
      if (published) {
        // dedupe 경로에서 죽었다 — 완성본은 이미 있었고 세션 정리만 남았었다.
        await rm(this.tmpPath(row.id), { force: true });
        this.db.prepare("DELETE FROM upload WHERE id = ?").run(row.id);
      } else if (inStore) {
        // rename 이후·장부 전에 죽었다. rename 은 해시 일치 **직후**의 다음 연산이라 이
        // 파일은 검증된 바이트다 — 장부만 마저 적는다.
        this.db.exec("BEGIN");
        try {
          this.db.prepare("INSERT INTO artifact (sha256, name, size, user, created_at) VALUES (?, ?, ?, ?, ?)")
            .run(row.sha256, row.name, row.size, row.user, this.now().toISOString());
          this.db.prepare("DELETE FROM upload WHERE id = ?").run(row.id);
          this.db.exec("COMMIT");
        } catch (error) { this.db.exec("ROLLBACK"); throw error; }
        await chmod(this.storePath(row.sha256), 0o644);
        console.error(`[baro_files] recover: adopted ${row.sha256} (crash after rename)`);
      } else if (inTmp) {
        // 해시·rename 전에 죽었다 — 세션을 되살린다. 받은 구간은 장부에 그대로 있다.
        this.setState(row.id, "open");
      } else {
        // 본체가 어디에도 없다 — 되살릴 것이 없다.
        this.db.prepare("DELETE FROM upload WHERE id = ?").run(row.id);
      }
    }

    // 유령 소탕: 어느 장부도 가리키지 않는 store 파일. 보이지 않는데 다운로드만 되는 바이트가
    // 최악이라 지운다 — 내용 주소라 필요하면 재업로드로 그대로 복원된다.
    for (const name of await readdir(join(this.root, "store"))) {
      if (!/^[0-9a-f]{64}$/.test(name)) continue;
      if (!this.getArtifact(name)) {
        await rm(this.storePath(name), { force: true });
        console.error(`[baro_files] recover: removed ghost ${name}`);
      }
    }
  }

  /**
   * 청크 스트림의 시작 표식 — **동기다.** 상태 확인과 계수 증가 사이에 await 가 끼면
   * finalize 가 그 틈에 앉는다(단일 스레드의 동기 블록이 곧 잠금이다).
   * null 이면 세션이 없거나 지금은 받을 수 없다 — 호출자가 404/409 로 답한다.
   */
  beginChunk(id) {
    const upload = this.getUpload(id);
    if (!upload || upload.state !== "open") return null;
    this.inflight.set(id, (this.inflight.get(id) || 0) + 1);
    // 활동 표식은 **시작** 시점이다. 완료 시점에만 찍으면 몇 시간짜리 스트림이 도중에
    // reaper 에 잡힌다 — 연구실 간 링크에서는 그게 정상 운행이다.
    this.db.prepare("UPDATE upload SET last_activity = ? WHERE id = ?").run(this.now().toISOString(), id);
    return upload;
  }

  endChunk(id) {
    const n = (this.inflight.get(id) || 0) - 1;
    if (n <= 0) this.inflight.delete(id); else this.inflight.set(id, n);
  }

  tmpPath(id) { return join(this.root, "tmp", id); }
  storePath(sha256) { return join(this.root, "store", sha256); }

  async freeBytes() {
    const s = await statfs(this.root);
    return s.bavail * s.bsize;
  }

  // 사람의 몫: 완성본 + 진행 중 세션의 **선언** 크기. 받은 만큼이 아니라 선언 크기로 세는
  // 이유: 희소 파일은 나중에 차오르므로, 선언을 기준으로 막아야 상한이 약속이 된다.
  usedBy(user) {
    const done = this.db.prepare("SELECT COALESCE(SUM(size),0) AS n FROM artifact WHERE user = ?").get(user).n;
    const open = this.db.prepare("SELECT COALESCE(SUM(size),0) AS n FROM upload WHERE user = ?").get(user).n;
    return done + open;
  }

  /** 세션을 연다. 파일을 선언 크기로 미리 뚫어 두므로(희소) 청크는 어디든 바로 앉는다. */
  async createUpload({ name, size, sha256 }, user) {
    if (!user) throw fail("user_required", "an upload belongs to a person — no user was stamped.");
    if (typeof name !== "string" || !NAME_PATTERN.test(name)) {
      throw fail("invalid_name", "name must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$ — it becomes the download filename.");
    }
    if (!Number.isSafeInteger(size) || size <= 0 || size > this.limits.maxFileBytes) {
      throw fail("invalid_size", `size must be an integer in 1..${this.limits.maxFileBytes} bytes.`);
    }
    const sha = typeof sha256 === "string" ? sha256.toLowerCase() : "";
    if (!SHA_PATTERN.test(sha)) {
      throw fail("invalid_sha256", "sha256 must be 64 hex chars — the hash of the finished file, declared up front.");
    }
    if (await this.freeBytes() - size < this.limits.reserveBytes) {
      // 이 디스크에는 보드도 산다. 아티팩트가 볼륨을 바닥내면 보드가 같이 죽는다 — 그래서
      // 거절은 운영자 몫의 503 이다(부르는 쪽이 고칠 수 있는 일이 아니다).
      throw fail("insufficient_storage", "not enough free space to accept a file of this size.");
    }
    if (this.usedBy(user) + size > this.limits.userQuotaBytes) {
      throw fail("quota_exceeded", "this would exceed your storage quota — delete old artifacts or abandoned uploads first.");
    }

    const id = `up_${randomBytes(12).toString("base64url")}`;
    const at = this.now().toISOString();
    const fd = await open(this.tmpPath(id), "w");
    try { await fd.truncate(size); } finally { await fd.close(); }
    this.db.prepare("INSERT INTO upload (id, user, name, size, sha256, state, created_at, last_activity) VALUES (?, ?, ?, ?, ?, 'open', ?, ?)")
      .run(id, user, name, size, sha, at, at);
    return this.inventory(id);
  }

  getUpload(id) {
    return toUpload(this.db.prepare("SELECT * FROM upload WHERE id = ?").get(id));
  }

  /** 받은 구간과 빈 구간 — 재개의 전부. 클라이언트 장부를 요구하지 않는다. */
  inventory(id) {
    const upload = this.getUpload(id);
    if (!upload) return null;
    const rows = this.db.prepare("SELECT start, end FROM upload_range WHERE upload_id = ? ORDER BY start").all(id);
    const received = mergeRanges(rows.map((r) => [r.start, r.end]));
    const missing = missingRanges(received, upload.size);
    return { ...upload, received, missing, complete: missing.length === 0 };
  }

  /** 청크 수신 완료를 장부에 적는다. 파일 쓰기는 server.mjs 의 스트림이 이미 끝낸 뒤다. */
  recordRange(id, start, end) {
    const tx = this.db;
    tx.exec("BEGIN");
    try {
      tx.prepare("INSERT INTO upload_range (upload_id, start, end) VALUES (?, ?, ?)").run(id, start, end);
      const rows = tx.prepare("SELECT start, end FROM upload_range WHERE upload_id = ? ORDER BY start").all(id);
      const merged = mergeRanges(rows.map((r) => [r.start, r.end]));
      tx.prepare("DELETE FROM upload_range WHERE upload_id = ?").run(id);
      const ins = tx.prepare("INSERT INTO upload_range (upload_id, start, end) VALUES (?, ?, ?)");
      for (const [s, e] of merged) ins.run(id, s, e);
      tx.prepare("UPDATE upload SET last_activity = ? WHERE id = ?").run(this.now().toISOString(), id);
      tx.exec("COMMIT");
    } catch (error) {
      tx.exec("ROLLBACK");
      throw error;
    }
  }

  setState(id, state) {
    this.db.prepare("UPDATE upload SET state = ?, last_activity = ? WHERE id = ?")
      .run(state, this.now().toISOString(), id);
  }

  /**
   * 완성. 커버리지 검사 → 파일 전체를 스트림으로 해시 → 선언값과 대조 → store 로 rename.
   *
   * 해시 불일치는 세션을 **지우지 않는다**(409). 어느 구간이 상했는지 서버도 모르지만,
   * 클라이언트는 의심 구간만 다시 보내고 finalize 를 다시 부를 수 있다 — 2.8GB 를 처음부터
   * 다시 올리게 만드는 것이 이 축의 최악이다.
   */
  async finalize(id) {
    const inv = this.inventory(id);
    if (!inv) return null;
    if (inv.state === "finalizing") throw fail("finalize_in_progress", "finalize is already running for this upload.");
    if (!inv.complete) {
      throw fail("upload_incomplete", `missing ${inv.missing.length} range(s), first at byte ${inv.missing[0][0]}.`);
    }

    // finalizing 동안 새 청크를 거절한다(beginChunk 의 상태 확인). 그러나 그 확인은 **이미
    // 흐르고 있는** 청크를 못 막는다 — 열린 fd 는 rename 을 따라가므로, 해시가 끝난 발행본에
    // 늦은 바이트가 앉는다(검토에서 실증). 그래서 상태 전환과 계수 확인을 한 동기 블록에
    // 붙인다: 이 둘 사이에 어떤 청크도 끼어들 수 없다(단일 스레드).
    this.setState(id, "finalizing");
    if ((this.inflight.get(id) || 0) > 0) {
      this.setState(id, "open");
      throw fail("upload_busy", "chunks are still in flight — let them finish and finalize again.");
    }
    try {
      const digest = await new Promise((resolve, reject) => {
        const hash = createHash("sha256");
        createReadStream(this.tmpPath(id))
          .on("data", (c) => hash.update(c))
          .on("end", () => resolve(hash.digest("hex")))
          .on("error", reject);
      });
      if (digest !== inv.sha256) {
        this.setState(id, "open");
        throw fail("sha256_mismatch", `file hashes to ${digest}, session declared ${inv.sha256} — re-send the suspect ranges and finalize again.`);
      }

      const existing = this.getArtifact(inv.sha256);
      if (existing) {
        // 같은 바이트가 이미 있다 — 전량을 올린 뒤에만 닿는 자리이므로 오라클이 아니다.
        await rm(this.tmpPath(id), { force: true });
        this.db.prepare("DELETE FROM upload WHERE id = ?").run(id);
        return { artifact: existing, deduplicated: true };
      }

      await rename(this.tmpPath(id), this.storePath(inv.sha256));
      await chmod(this.storePath(inv.sha256), 0o644); // nginx(www-data)가 읽는다
      // 장부 두 줄은 한 트랜잭션이다 — 사이에서 죽으면 "완성본은 있는데 세션도 남은" 상태와
      // "세션은 갔는데 완성본 장부가 없는" 상태가 생기고, 뒤엣것이 유령이다. rename 과 이
      // 트랜잭션 사이의 크래시는 recover() 가 장부를 마저 적는 것으로 화해한다.
      this.db.exec("BEGIN");
      try {
        this.db.prepare("INSERT INTO artifact (sha256, name, size, user, created_at) VALUES (?, ?, ?, ?, ?)")
          .run(inv.sha256, inv.name, inv.size, inv.user, this.now().toISOString());
        this.db.prepare("DELETE FROM upload WHERE id = ?").run(id);
        this.db.exec("COMMIT");
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
      return { artifact: this.getArtifact(inv.sha256), deduplicated: false };
    } catch (error) {
      if (this.getUpload(id)?.state === "finalizing") this.setState(id, "open");
      throw error;
    }
  }

  async abandonUpload(id) {
    const upload = this.getUpload(id);
    if (!upload) return false;
    await rm(this.tmpPath(id), { force: true });
    this.db.prepare("DELETE FROM upload WHERE id = ?").run(id);
    return true;
  }

  listUploads(user = null) {
    const rows = user
      ? this.db.prepare("SELECT * FROM upload WHERE user = ? ORDER BY created_at DESC").all(user)
      : this.db.prepare("SELECT * FROM upload ORDER BY created_at DESC").all();
    return rows.map((r) => this.inventory(r.id));
  }

  getArtifact(sha256) {
    return toArtifact(this.db.prepare("SELECT * FROM artifact WHERE sha256 = ?").get(String(sha256).toLowerCase()));
  }

  listArtifacts({ q = "", limit = 50, offset = 0 } = {}) {
    const where = q ? " WHERE name LIKE ? ESCAPE '\\'" : "";
    const params = q ? [`%${String(q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`] : [];
    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM artifact${where}`).get(...params).n;
    const rows = this.db.prepare(`SELECT * FROM artifact${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset);
    return { total, artifacts: rows.map(toArtifact) };
  }

  async removeArtifact(sha256) {
    const artifact = this.getArtifact(sha256);
    if (!artifact) return false;
    await rm(this.storePath(artifact.sha256), { force: true });
    this.db.prepare("DELETE FROM artifact WHERE sha256 = ?").run(artifact.sha256);
    return true;
  }

  counts() {
    const a = this.db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(size),0) AS bytes FROM artifact").get();
    const u = this.db.prepare("SELECT COUNT(*) AS n FROM upload").get();
    return { artifacts: a.n, bytes: a.bytes, openUploads: u.n };
  }

  /**
   * 유령 세션 정리 — 마지막 청크 **시작**으로부터 TTL 이 지난 것. 완성본은 여기서 절대
   * 지우지 않고, 지금 스트림이 흐르는 세션도 건너뛴다(활성 쓰기 밑에서 본체를 지우면
   * 그 바이트는 unlink 된 inode 로 사라지고 장부는 FK 로 죽는다).
   */
  async reapStale() {
    const cutoff = new Date(this.now().getTime() - this.limits.sessionTtlMs).toISOString();
    const stale = this.db.prepare("SELECT id FROM upload WHERE last_activity < ?").all(cutoff)
      .filter(({ id }) => !this.inflight.has(id));
    for (const { id } of stale) await this.abandonUpload(id);
    return stale.length;
  }
}
