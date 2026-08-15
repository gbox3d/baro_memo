// 아티팩트 축의 JSON 라우트 — 청크 스트림(PUT …/chunks)만은 여기 없다. 그 경로는 본문을
// 통째로 받으면 안 되므로 server.mjs 가 라우팅 **전에** 가로챈다. 그 예외가 정확히 하나라는
// 것이 이 서비스가 baro_memo 와 갈라진 이유다(보드는 그 예외를 품을 수 없는 구조다).
//
// 문턱은 보드와 같은 결이다:
//   읽기(목록·조회·verify): 유효한 토큰이면 된다 — 사람 토큰이든 관리자 토큰이든.
//   발행(세션 생성·finalize·삭제): **사람** 토큰만. 관리자 토큰에는 귀속할 사람이 없다.
// 판정은 baro_memo /api/auth/whoami 가 내리고 여기는 캐시로 되묻는다(core/identity.mjs).
import { json } from "../core/http.mjs";

export function presentedToken(headers = {}) {
  const direct = headers["x-memo-token"];
  if (direct) return String(direct).trim();
  const auth = String(headers.authorization || "");
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : "";
}

function badRequest(error) {
  return json(400, { error: error.message, code: error.code || "invalid_request", retryable: false });
}

function refusal(verdict) {
  const messages = {
    memo_token_invalid: "The store needs a board token — header x-memo-token or Authorization: Bearer. Ask the operator for one.",
    no_tokens_issued: "No tokens have been issued on the board — ask the operator.",
    identity_unavailable: "The identity service (baro_memo) is unreachable and no cached verdict exists — try again shortly.",
  };
  return json(verdict.status, {
    error: messages[verdict.code] || "Refused.",
    code: verdict.code, retryable: verdict.code === "identity_unavailable",
  });
}

const CANNOT_PUBLISH = json(403, {
  error: "The admin token can read the store but not publish to it — a publication needs a person to attribute.",
  code: "admin_token_cannot_publish", retryable: false,
});

function intParam(params, name, fallback, min, max) {
  const raw = params?.get?.(name);
  if (raw === null || raw === undefined || String(raw).trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw Object.assign(new Error(`${name} must be an integer in ${min}..${max}.`), { code: "invalid_param" });
  }
  return n;
}

export function createFileRoutes(ctx) {
  const { store, identity, basePathOf = () => "" } = ctx;

  const downloadPath = (artifact, headers) =>
    `${basePathOf(headers)}/dl/${artifact.sha256}/${artifact.name}`;

  return async function handleFiles(method, pathname, query, body, headers) {
    if (!pathname.startsWith("/api/")) return null;

    // ---- verify — nginx auth_request 가 다운로드마다 부르는 자리. 몸통 없음, 답은 상태뿐. --
    if (pathname === "/api/verify") {
      if (method !== "GET") return json(405, { error: "Method not supported.", method, pathname });
      const verdict = await identity.resolve(presentedToken(headers));
      if (!verdict.ok) return refusal(verdict);
      return json(200, { user: verdict.user, admin: verdict.admin });
    }

    // ---- 업로드 세션 ---------------------------------------------------------------------
    if (pathname === "/api/uploads") {
      const verdict = await identity.resolve(presentedToken(headers));
      if (!verdict.ok) return refusal(verdict);

      if (method === "GET") {
        // 자기 것만. 관리자는 전부 — 유령 세션을 치우는 사람이라서다.
        const uploads = store.listUploads(verdict.admin ? null : verdict.user);
        return json(200, { count: uploads.length, uploads });
      }
      if (method === "POST") {
        if (verdict.user === null) return CANNOT_PUBLISH;
        try {
          const upload = await store.createUpload(body || {}, verdict.user);
          return json(201, { upload, chunkPath: `/api/uploads/${upload.id}/chunks` });
        } catch (error) {
          if (error.code === "insufficient_storage") return json(507, { error: error.message, code: error.code, retryable: false });
          if (error.code === "quota_exceeded") return json(403, { error: error.message, code: error.code, retryable: false });
          return badRequest(error);
        }
      }
      return json(405, { error: "Method not supported.", method, pathname });
    }

    const uploadItem = pathname.match(/^\/api\/uploads\/([A-Za-z0-9_-]+)$/);
    if (uploadItem) {
      const verdict = await identity.resolve(presentedToken(headers));
      if (!verdict.ok) return refusal(verdict);
      const inv = store.inventory(uploadItem[1]);
      if (!inv) return json(404, { error: "No such upload.", code: "upload_not_found", id: uploadItem[1] });
      // 남의 세션은 보이지도 않는다 — 존재 여부도 정보다.
      if (!verdict.admin && inv.user !== verdict.user) {
        return json(404, { error: "No such upload.", code: "upload_not_found", id: uploadItem[1] });
      }
      if (method === "GET") return json(200, { upload: inv });
      if (method === "DELETE") {
        return json(200, { deleted: await store.abandonUpload(inv.id), id: inv.id });
      }
      return json(405, { error: "Method not supported.", method, pathname });
    }

    const finalize = pathname.match(/^\/api\/uploads\/([A-Za-z0-9_-]+)\/finalize$/);
    if (finalize) {
      if (method !== "POST") return json(405, { error: "Method not supported.", method, pathname });
      const verdict = await identity.resolve(presentedToken(headers));
      if (!verdict.ok) return refusal(verdict);
      if (verdict.user === null) return CANNOT_PUBLISH;
      const upload = store.getUpload(finalize[1]);
      if (!upload || upload.user !== verdict.user) {
        return json(404, { error: "No such upload.", code: "upload_not_found", id: finalize[1] });
      }
      try {
        const { artifact, deduplicated } = await store.finalize(upload.id);
        return json(201, { artifact, deduplicated, download: downloadPath(artifact, headers) });
      } catch (error) {
        // 넷 다 409 다: 지금은 안 되지만 **같은 요청을 나중에 다시** 하면 된다 — 그 사실이
        // retryable 로 실린다(400 으로 새면 클라이언트는 요청 자체를 고치려 든다).
        if (["sha256_mismatch", "upload_incomplete", "upload_busy", "finalize_in_progress"].includes(error.code)) {
          return json(409, { error: error.message, code: error.code, retryable: true });
        }
        return badRequest(error);
      }
    }

    // ---- 완성본 --------------------------------------------------------------------------
    if (pathname === "/api/artifacts") {
      if (method !== "GET") return json(405, { error: "Method not supported.", method, pathname });
      const verdict = await identity.resolve(presentedToken(headers));
      if (!verdict.ok) return refusal(verdict);
      try {
        const limit = intParam(query, "limit", 50, 1, 200);
        const offset = intParam(query, "offset", 0, 0, Number.MAX_SAFE_INTEGER);
        const q = String(query?.get?.("q") || "").trim();
        const { total, artifacts } = store.listArtifacts({ q, limit, offset });
        return json(200, {
          count: artifacts.length, total, limit, offset,
          artifacts: artifacts.map((a) => ({ ...a, download: downloadPath(a, headers) })),
        });
      } catch (error) { return badRequest(error); }
    }

    const artifactItem = pathname.match(/^\/api\/artifacts\/([0-9a-fA-F]{64})$/);
    if (artifactItem) {
      const verdict = await identity.resolve(presentedToken(headers));
      if (!verdict.ok) return refusal(verdict);
      const artifact = store.getArtifact(artifactItem[1]);
      if (!artifact) return json(404, { error: "No such artifact.", code: "artifact_not_found", sha256: artifactItem[1].toLowerCase() });
      if (method === "GET") return json(200, { artifact, download: downloadPath(artifact, headers) });
      if (method === "DELETE") {
        // 발행자 본인 또는 운영자. 릴리스 삭제는 남의 파이프라인을 부수는 일이라 좁게 연다.
        if (verdict.user !== artifact.user && !verdict.admin) {
          return json(403, { error: "Only the publisher or the operator can remove an artifact.", code: "not_your_artifact", retryable: false });
        }
        return json(200, { deleted: await store.removeArtifact(artifact.sha256), sha256: artifact.sha256 });
      }
      return json(405, { error: "Method not supported.", method, pathname });
    }

    return null;
  };
}
