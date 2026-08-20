# 운영 — 배포·재시작·백업·장애

운영자가 손으로 하는 일 전부입니다. 새 호스트에 올리는 절차, 갱신 배포, 무엇이 재시작을
요구하고 무엇이 안 하는지, 백업과 복구, 증상별 대응.

이 문서는 **호스트를 다루는 일**만 맡습니다. API 계약·라우트·거절 코드는 서버가 서빙하는
`GET /memo/api/help`(아티팩트 저장소는 `GET /files/api/help`)가 정본이고, 토큰 발급·확인은
[tokens.md](./tokens.md), 팀 운영은 [teams.md](./teams.md), 팀원과 에이전트를 붙이는 것은
[agents.md](./agents.md), 아티팩트 디스크 관리는 [files.md](./files.md), 왜 이렇게 만들었는지는
[../_forAI/](../_forAI/) 에 있습니다.

**단계마다 확인이 붙어 있습니다. 확인이 안 되면 다음으로 가지 않습니다.**

## 전제

Node 24 이상(`node:sqlite` 와 FTS5 가 여기 들어 있습니다), pnpm, pm2, nginx. 그 밖의 런타임
의존성은 없습니다.

## 새 호스트에 처음 올릴 때

### 1. 받고 설치

```bash
git clone https://github.com/gbox3d/baro_memo.git && cd baro_memo && pnpm install
```

확인: `node --version` 이 v24 이상.

### 2. `.env` 작성

`cp .env.example .env` 후 여섯 값입니다. 각 값의 근거는 [../.env.example](../.env.example) 의
주석에 있고, 여기에는 놓쳤을 때 무엇이 깨지는지만 적습니다.

| 키 | 값 | 놓치면 |
|---|---|---|
| `MEMO_DB` | 저장소 **밖** 절대경로 | 저장소를 다시 받으면 보드가 사라진다 |
| `ADMIN_TOKEN_FILE` | DB 와 같은 디렉터리 | 보드는 남고 관리할 열쇠만 사라진다 |
| `FILES_ROOT` | DB 와 같은 볼륨의 절대경로 | 수 GB 아티팩트가 저장소 안(`localfiles/files`)으로 떨어진다 |
| `PORT` | 비어 있는 번호 | nginx 조각의 `proxy_pass` 와 어긋나면 502 |
| `HOST` | `127.0.0.1` | 이 줄을 지우면 `0.0.0.0` 으로 떨어져 활짝 열린다 |
| `RELEASE_BASE_URL` | 밖에서 닿는 주소 | 관리자 페이지의 초대 메시지가 사내망 주소를 팀원에게 보낸다 |

`.env.example` 의 `PORT=3000` 과 `HOST=0.0.0.0` 은 예시값입니다 — 복사한 채로 두면 위 두 칸이
동시에 걸립니다.

확인: `grep -cv '^[[:space:]]*\(#.*\)\?$' .env` 로 여섯 줄이 다 있는지.

### 3. 관리자 토큰

```bash
pnpm admin:token     # 값과 읽어 온 파일 경로. 없으면 디렉터리째 만들고 권한 600 으로 둔다
```

확인: 찍힌 경로의 파일이 `-rw-------`. 값을 다시 보는 것과 교체는 [tokens.md](./tokens.md).

### 4. 검사

```bash
pnpm test
```

확인: 전부 통과. 하나라도 실패하면 배포하지 않습니다.

### 5. 프로세스

```bash
pm2 startOrReload ecosystem.config.cjs --only baro-memo
pm2 logs baro-memo --lines 20 --nostream
```

확인은 기동 로그 **두 줄**입니다. 둘째 줄이 아티팩트 저장소의 생사이고, 첫 줄의
`admin=configured (…)` 경로가 3단계에서 본 그 경로여야 합니다 — 고친 파일과 서버가 읽은 파일이
다른 것이 이 종류 설정의 가장 흔한 사고입니다.

```
[baro_memo] v0.13.1 listening on 127.0.0.1:3001 · db=/mnt/… · admin=configured (/mnt/…/admin-token)
[baro_memo/files] mounted at /api/files · root=/mnt/…
```

부팅 목록에 넣는 것은 `pm2 save` 인데, 이 명령은 **데몬 전체 덤프를 덮습니다.** 이 데몬은 여러
저장소가 공유하므로 `pm2 ls` 로 등록된 앱이 전부 `online` 인 것을 보고 나서만 칩니다 — 그 순간
빠져 있는 앱은 부팅 목록에서 조용히 사라집니다(실제 사고 기록은
[../ecosystem.config.cjs](../ecosystem.config.cjs) 머리 주석).

확인: `grep -q baro-memo ~/.pm2/dump.pm2 && echo ok`

### 6. nginx — 조각 **둘**

[../deploy/nginx-baro-memo.conf](../deploy/nginx-baro-memo.conf) 와
[../deploy/nginx-baro-files.conf](../deploy/nginx-baro-files.conf) 를 같은 server 블록 안에
include 합니다(절차는 각 파일 머리 주석). 저장소 조각을 빠뜨리면 `/files/…` 가 통째로 안 열립니다.

두 값이 파일 두 곳에서 맞아야 하고, 둘 다 한쪽만 바꾸면 조용히 깨집니다:

- 두 조각의 `proxy_pass` 포트 = `.env` 의 `PORT` — 어긋나면 502
- 저장소 조각의 `alias` 뿌리 = `.env` 의 `FILES_ROOT` — 어긋나면 다운로드만 404

```bash
sudo nginx -t && sudo systemctl reload nginx
curl -s -o /dev/null -w '%{http_code}\n' http://<호스트>/memo/api/health
curl -s -o /dev/null -w '%{http_code}\n' http://<호스트>/files/api/health
```

확인: 둘 다 200. **reload 직후 몇 초는 옛 워커가 받습니다** — 404 가 나오면 설정을 의심하기
전에 잠깐 두고 다시 칩니다.

이 단계는 건너뛸 수 없습니다. `/memo/admin/` · `/memo/skill/` · `/memo/install.sh` ·
`/files/dl/…` 는 nginx 가 디스크에서 직접 서빙하는 것이라 **백엔드 포트로는 404** 입니다.
help 가 안내하는 설치 한 줄도 nginx 뒤에서만 200 입니다.

### 7. 데이터 이관 (원본이 있을 때만)

```bash
node scripts/migrate-from-calrory.mjs <원본 memo.db> <MEMO_DB 경로>
```

두 경로를 다 적습니다 — 인자를 생략하면 대상이 `<저장소>/localfiles/memo.db` 라 운영 DB 가
아닙니다. id 를 보존하고 멱등이라 몇 번을 다시 돌려도 안전합니다.

확인: `/memo/api/health` 의 `board.total` 이 이관 건수만큼 늘었는지.

### 8. 사람 붙이기

쓰기 토큰 발급은 [tokens.md](./tokens.md), 팀원 기기에 스킬을 까는 것은
[agents.md](./agents.md) 입니다. 팀원에게 건네는 것은 주소 하나입니다.

## 열리는 주소

사람이 브라우저나 셸에서 직접 가는 곳입니다. API 라우트 전량은 여기 적지 않습니다 — 기계
인덱스가 `GET /memo/api/help?format=json` 에 있고, 그것이 정본입니다.

| 주소 | 무엇 | 누가 서빙하나 |
|---|---|---|
| `/memo/admin/` | 관리자 페이지 — 토큰 발급·폐기, 팀 관리, 보드 열람, 팀원용 안내 메시지 | nginx (워킹트리 직접) |
| `/memo/install.sh` | 팀원 기기에 스킬 까는 한 줄 (`curl -fsSL … \| sh`) | nginx |
| `/memo/skill/` | 스킬 원문 — 돌고 있는 서버와 같은 판 | nginx |
| `/files/dl/<sha256>/<이름>` | 완성본 다운로드 — Range 지원, 토큰 필요 | nginx (인증만 백엔드에 묻는다) |
| `/memo/api/help` · `/files/api/help` | 에이전트용 사용법(영문). 계약의 정본 | 백엔드 |
| `/files/upload.sh` | 업로드 클라이언트 — 받아 간 주소가 박혀서 나온다 | 백엔드 |
| `/memo/api/health` · `/files/api/health` | 생사·판 번호·보드 집계·저장소 상태 | 백엔드 |

표의 위 네 줄은 백엔드 포트에 아예 없습니다 — nginx 가 디스크에서 직접 서빙합니다. 직접
포트로 확인할 수 있는 것은 `/api/…` 뿐입니다.

## 갱신 배포

**먼저 전송 중인 업로드를 봅니다.** 보드를 재시작하면 흐르던 청크가 끊깁니다 — 재개가 있어
대가는 "그 구간 다시"지만, 남의 몇 분짜리 전송입니다. `openUploads` 가 0인 창을 고릅니다
(포트는 `.env` 의 `PORT`, 이 호스트는 3001):

```bash
curl -s localhost:3001/api/files/health    # {"ok":true,…,"store":{…,"openUploads":0,…}}
```

0 이 아니면 열린 세션이 있다는 뜻입니다 — 지금 바이트가 흐르는 중일 수도, 그냥 열어만 둔
것일 수도 있습니다. 가려내는 방법은 [files.md](./files.md).

```bash
git pull && pnpm test
pm2 restart baro-memo --update-env
curl -s localhost:3001/api/version         # package.json 과 같아야 한다
```

**세 번째 줄이 절차의 일부입니다.** pm2 의 `online` 은 죽음만 잡고 낡음은 못 잡습니다.
`deploy/` 조각을 건드렸으면 nginx 도 `-t` 후 reload 합니다.

재시작하는 몇 초 동안은 다운로드 인증도 못 지나가 `/files/dl/…` 이 503
`identity_unavailable` 을 답합니다(`Retry-After: 5`). 정상이고, 재시도가 답입니다.

## 재시작이 필요한 것과 아닌 것

| 고친 것 | 반영 |
|---|---|
| `apps/backend`·`apps/files` 의 코드 | pm2 재시작 |
| `.env` | pm2 재시작 — 서버가 부팅 때 한 번 읽는다 |
| 관리자 토큰 파일 (`pnpm admin:token --rotate`) | pm2 재시작. **그전까지는 옛 값이 계속 통하고 새 값이 401 입니다** |
| `apps/*/help/*.md` | 없음 — 요청마다 파일을 읽어 서빙한다 (라우트 인덱스 `AGENT_ROUTES` 는 코드라 재시작) |
| `scripts/upload-artifact.sh` | 없음 — 요청마다 읽어 받는 쪽 주소를 박아 내보낸다 |
| `apps/admin/public/` (관리자 페이지) | 없음 — nginx 가 워킹트리를 그대로 서빙하고 캐시가 꺼져 있다 |
| `skills/baro-memo/` · `scripts/install-skill.sh` | 없음 — nginx alias |
| `deploy/*.conf` | `sudo nginx -t && sudo systemctl reload nginx` |

관리자 페이지가 재시작 없이 갱신되기 때문에 창이 하나 생깁니다: `git pull` 만 하고 재시작 전이면
**페이지가 백엔드보다 새것**입니다. 배포가 낡았는지 보러 연 그 화면이 통째로 비면 이 창을
의심합니다(설계상의 방어는 [../_forAI/memo.md](../_forAI/memo.md) 의 「반복 금지」).

## 백업과 복구

저장소는 백업하지 않습니다 — 다시 받으면 됩니다. 살아 있는 것은 넷이고 전부 저장소 밖입니다.

| 무엇 | 안에 든 것 |
|---|---|
| `MEMO_DB` (`memo.db`) | 글·댓글·점수·이력·토큰·팀 전부 |
| `ADMIN_TOKEN_FILE` (`admin-token`) | 관리자 열쇠. 권한 600 |
| `FILES_ROOT/files.db` 와 `FILES_ROOT/store/` | 아티팩트 장부와 바이트 |
| `.env` | git 밖이고, 위 셋의 경로를 아는 유일한 파일 |

`FILES_ROOT/tmp/` 는 대상이 아닙니다 — 진행 중 세션의 본체라 복구본에서는 어차피 재개되지
않습니다(마지막 활동으로부터 48시간이 지나면 리퍼가 치웁니다).

**도는 중에 `cp` 하지 않습니다.** SQLite 파일은 쓰기 도중에 복사하면 찢어진 사본이 됩니다.
그래서 명령 하나로 심어 두었습니다:

```bash
pnpm backup                 # 목적지 기본값 /mnt/baro_memo_backup
pnpm backup --skip-store    # 장부만. 바이트가 커졌을 때
pnpm backup --dest /어디    # 목적지를 바꿔서
```

하는 일과 그 근거:

- DB 둘은 `VACUUM INTO` 로 뜹니다 — SQLite 가 스스로 일관된 사본을 만들므로 **서버를 멈출
  필요가 없습니다.** 임시 이름으로 뜨고 행 수를 원본과 맞춰 본 뒤에 제자리로 옮깁니다. 그래서
  실패한 실행이 어제의 멀쩡한 사본을 반쪽으로 만들지 않고, 같은 날 다시 돌려도 됩니다.
- `admin-token` 과 `.env` 는 권한 600 으로 복사합니다 — 백업본이 원본보다 헐거우면 백업이
  구멍입니다.
- `store/` 는 **없는 것만** 복사합니다. 내용 주소(파일 이름이 곧 sha256)라 한 번 복사한 것은
  영원히 같아서, 그 규칙 하나가 곧 증분입니다.
- 스냅샷은 날짜 디렉터리로 쌓이고 **자동으로 지우지 않습니다.** 지우는 것은 사람이 보고 정하는
  일입니다 — 스크립트가 조용히 지운 백업은 필요해진 날에야 없다는 것을 알게 됩니다. 대신 몇 개가
  쌓였는지 매번 찍습니다.

목적지는 `/mnt/baro_memo_backup` 이고, **거기에 별도 디스크가 마운트돼 있어야 합니다.**
마운트가 안 된 자리에 쓰면 그 밑은 루트 디스크(NVMe 916G)이고, 아티팩트 볼륨은 11T 입니다 —
언젠가 루트가 차고, 루트가 차면 보드만이 아니라 호스트가 멎습니다. 그래서 스크립트가 경고가
아니라 **거부**합니다(경고는 바쁜 날 읽히지 않습니다):

- 목적지가 없으면: 만들지 않고 멈춥니다. 마운트가 안 된 자리에 디렉터리를 만들면 그게 곧 루트에
  쌓는 것이고, 오타 난 경로에 쌓인 백업은 없는 것과 같습니다.
- 목적지가 루트와 같은 장치면: 멈춥니다. `df -h <목적지>` 가 `/` 와 다른 파일시스템을 보여야
  합니다.
- 목적지가 데이터와 같은 장치면: 돌되 사실을 말합니다 — 실수로 지운 것에는 듣지만 디스크가
  죽는 날에는 함께 죽는 백업입니다.

**자동으로 돌지 않습니다.** cron 도 pm2 도 걸지 않았습니다 — 시킬 때만 도는 명령입니다.
저절로 도는 백업은 목적지를 조용히 채우고, 그 사실은 디스크가 가득 찬 날에야 드러납니다.

확인: 사본이 열리고 건수가 맞는지는 스크립트가 이미 봤습니다(안 맞으면 거기서 죽습니다).
아티팩트는 이름이 곧 해시라 자기검증이 됩니다 —
`cd /mnt/baro_memo_backup/store && sha256sum -c <(for f in *; do echo "$f  $f"; done)`.

복구는 새 호스트 절차 그대로이고, 4단계 전에 백업본을 제자리에 놓는 것만 다릅니다. 하나
주의할 것은 권한입니다: `store/` 는 nginx(`www-data`)가 직접 읽으므로 디렉터리 755 · 파일 644
여야 하고(`rsync -a` 가 보존합니다), 서버는 **자기가 만든 파일에만** 그 권한을 챙깁니다.
확인: 완성본 하나를 `/files/dl/<sha256>/<이름>` 으로 받아 봅니다(토큰이 필요합니다 —
[files.md](./files.md)).

## 장애 대응

| 증상 | 먼저 볼 것 | 대개의 원인 |
|---|---|---|
| `/memo/api/`·`/files/api/` 가 502 | 몇 초 뒤 다시 → `pm2 ls` → `curl -s localhost:3001/api/version` | 재시작 창. 계속되면 프로세스가 죽었거나 `proxy_pass` 포트 ≠ `.env` 의 `PORT` |
| reload 직후 404 | 잠깐 두고 다시 | 옛 워커가 아직 받는다 |
| 고친 것이 안 보인다 | `/api/version` vs `package.json` | 재시작을 안 했다. pm2 `online` 은 낡음을 못 잡는다 |
| 관리자 페이지가 통째로 빔 | 같은 두 값 | 페이지만 새것인 창(위 표) |
| 보드는 되는데 `/files/` 만 503 `store_unavailable` | 기동 로그 둘째 줄 · `/memo/api/health` 의 `files` 칸 | `FILES_ROOT` 볼륨이 안 붙었다. 보드는 설계상 그대로 선다 |
| 다운로드가 503 `identity_unavailable` | 재시도 | 백엔드가 그 순간 안 답한다(재시작 창) |
| 업로드가 507 `insufficient_storage` | `df -h` · `/files/api/health` 의 `freeBytes` | 여유가 예약분(20 GiB) 밑. 같은 볼륨에 보드 DB 가 살아서, 보드까지 멎기 전에 막는 문턱이다 — 지우는 창구는 [files.md](./files.md) |
| 관리자 토큰이 401 인데 파일 값은 맞다 | 기동 로그 첫 줄의 시각 | 교체하고 재시작을 안 했다 |
| 재부팅 뒤 보드만 안 올라옴 | `grep -q baro-memo ~/.pm2/dump.pm2` | 덤프에서 빠졌다. `pm2 startOrReload ecosystem.config.cjs --only baro-memo` → 전부 online 확인 → `pm2 save`. 부팅 등록 자체는 systemd `pm2-<사용자>.service` |

로그는 `pm2 logs baro-memo` (파일은 `~/.pm2/logs/baro-memo-*.log`). 기동 두 줄이 판 번호·DB
경로·관리자 토큰 출처·저장소 뿌리를 한 번에 말하므로, 설정 사고는 대개 그 두 줄에서 끝납니다.

앱이 왜 하나인지, 왜 "재시작이 전송 중 업로드를 끊는다"를 절차로 감당하기로 했는지는
[../ecosystem.config.cjs](../ecosystem.config.cjs) 의 주석과
[../_forAI/inventory.md](../_forAI/inventory.md) 에 있습니다.
