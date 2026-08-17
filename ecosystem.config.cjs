// pm2 process manifest for baro_memo. CommonJS (.cjs) because package.json is
// "type":"module". 저장소 루트에서:
//
//   pm2 startOrReload ecosystem.config.cjs --only baro-memo
//   pm2 logs baro-memo
//   pm2 restart baro-memo
//
// **이 파일이 생긴 이유(2026-08-14).** 그전까지 baro-memo 는 pm2 공유 덤프에만 등록돼
// 있었다 — 저장소에 기동 근거가 없었다는 뜻이다. 그러다 다른 앱을 정리하다 함께 지워졌고,
// 그 뒤 `pm2 save` 가 한 번 돌면서 dump.pm2 와 dump.pm2.bak **양쪽에서** 사라졌다. 게시판이
// 502 로 죽었고 부팅 목록에도 없어 다음 재부팅에도 안 올라올 상태였다. 형제 저장소들
// (baro_calrory·baro_tunnel·baro_inference_gateway)이 각자 매니페스트를 갖는 이유가 이것이다:
// **등록처가 공유 덤프 하나뿐이면 복구할 근거가 남지 않는다.**
//
// 이 pm2 데몬은 여러 저장소가 공유한다. 명령은 **이름으로** 지목하고, `pm2 save`·`pm2 kill`
// 은 데몬 전체에 걸린다는 것을 알고 쓴다 — save 직전에는 등록된 앱이 **전부 online** 인지
// 본다(그 순간 빠져 있는 것은 부팅 목록에서 조용히 사라진다. 위의 사고가 정확히 그것이다).
//
// 접속·경로 값은 여기 적지 않는다. `apps/backend/src/server.mjs` 가 부팅 때 저장소 루트의
// `.env` 를 스스로 읽는다(process.loadEnvFile) — PORT·HOST·MEMO_DB·ADMIN_TOKEN_FILE 이
// 거기 있고, 그 파일은 git 밖이다. 여기에 사본을 두면 두 벌이 되어 한쪽만 낡는다.
// **cwd 와 무관하게 읽힌다** — repoRoot 를 모듈 경로에서 되짚기 때문이다.
const { join } = require("node:path");
const ROOT = __dirname;

module.exports = {
  apps: [
    {
      name: "baro-memo",
      script: join(ROOT, "apps/backend/src/server.mjs"),
      cwd: ROOT,
      interpreter: "node",
      autorestart: true,
      max_restarts: 10,
      // 로그는 pm2 기본 위치(~/.pm2/logs/baro-memo-*.log)에 그대로 둔다 — 이 파일이 생기기
      // 전의 이력이 거기 쌓여 있고, 복구하면서 그 연속성까지 끊을 이유가 없다.
      merge_logs: true,
      time: true,
    },
  ],
};

// **앱이 하나인 이유(0.11.0).** 0.10.0 까지는 여기 `baro-files`(:3002)가 한 줄 더 있었다.
// 가른 근거로 적어 두었던 것은 "보드는 본문을 통째로 메모리에 올린 뒤 라우팅하므로 수 GB
// 스트리밍을 심을 수 없다" 였는데, 코드를 다시 읽으니 절반이 틀렸다 — 청크 경로는 본문을 읽기
// **전에** 가로채므로 라우팅 구조와 무관하고, Node 의 I/O 는 소켓을 잡을 뿐 이벤트 루프를 막지
// 않는다. 가른 대가로 실제로 치른 것은 정체성 HTTP 홉과 그 캐시(=토큰 폐기가 몇 분 늦게 닿음),
// 그리고 "무엇이 배포됐나"가 두 질문이 되는 버전 두 벌이었다.
//
// 합치면서 잃은 것 하나는 적어 둔다: **보드를 재시작하면 전송 중 업로드가 끊긴다.** 재개가
// 그 대가를 "명령 한 번 다시"로 낮추므로 받아들였다. 배포는 전송이 없는 창을 골라서 한다.
//
// 프로세스 안에서 둘은 마운트 접두사로 갈린다(`/api/files`). 밖에서 보이는 주소는 그대로다.
