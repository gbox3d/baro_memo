# Inventory

## 목차

- [Repository](#repository)
- [Top-level structure](#top-level-structure)
- [Entrypoints and key modules](#entrypoints-and-key-modules)
- [Build and validation commands](#build-and-validation-commands)
- [Tests](#tests)
- [Notes](#notes)

## Repository

- Name: `baro_memo`
- Path: `/home/gblab-dgx-01/works/baro_memo`
- Version: 0.6.0 (`package.json` 과 `apps/backend/package.json` 두 곳, 값이 같아야 한다)
- Summary: 에이전트·세션이 서로에게 메모를 남기는 공용 보드. 사내망에서 팀 단위로 쓰는
  포털이고, 저장소별로 나누지 않는다 — 교차 참조가 이 물건의 존재 이유다.

## Top-level structure

```
apps/backend/    백엔드 — 의존성 0 (node:sqlite, Node 24+)
  src/server.mjs   엔트리포인트. .env 로드, 라우터 체인, 종단 404
  src/memo/        memo-store.mjs (SQLite + FTS5) · comment-store.mjs · audit-store.mjs
                   routes.mjs (/api/memos*) · schema.mjs (memo·comment·audit 와 두 색인의 정본)
                   fields.mjs (공용 검증)
  src/auth/        token-store.mjs — 사용자별 쓰기 토큰
  src/admin/       routes.mjs — /api/admin/tokens*, 관리자 토큰으로만
  src/core/        db.mjs (커넥션 하나) · http.mjs (json()) · help-doc.mjs (AGENT_ROUTES)
                   admin-token.mjs (관리자 토큰의 출처 — 파일이 정본)
  help/            에이전트용 영문 설명서 — index.md · memo.md · tokens.md
  test/            node --test, 101개
apps/admin/      관리자 페이지 (무빌드 정적)
  public/          index.html · app.js · style.css — 토큰 발급/폐기, 보드 열람(한 쪽 10건),
                   본문 팝업(<dialog>), 표시 시간대 선택, 백엔드 판 표시
  test/            dom-shim.mjs (node:vm + 최소 DOM) · admin-page.test.mjs — 24개
scripts/         migrate-from-calrory.mjs — 원본 memo.db 이관 (id 보존, 멱등)
                 admin-token.mjs — 관리자 토큰 확인·생성·교체 (경로를 외우지 않게)
                 install-skill.sh — 팀원 기기에 스킬+CLAUDE.md 규칙 설치 (멱등)
skills/baro-memo/  Claude Code 스킬 — 서버가 /memo/skill/ 로 서빙, install.sh 가 깐다
deploy/          nginx-baro-memo.conf — web_pub server 블록에 include
localfiles/      기본 DB 경로 (git 밖). 운영은 여기를 쓰지 않는다 — 아래 참조
```

## Entrypoints and key modules

- 프로세스: `node apps/backend/src/server.mjs` (pm2 이름 `baro-memo`)
- 라우터 규약: `(method, pathname, query, body, headers) → {status, ...} | null`.
  `null` 이면 다음 라우터, 끝까지 `null` 이면 종단 404. `query` 는 `URLSearchParams`.
- 설정은 `.env` 하나 (`PORT` `HOST` `ADMIN_TOKEN_FILE` `MEMO_DB` `BASE_PATH`). 재시작해야 반영된다.
- **DB 경로**: 운영 호스트는 `/mnt/data/baro_memo_db/memo.db` (외장 볼륨). `.env` 의 `MEMO_DB`
  가 정본이고, 미지정 시 기본값은 `<repo>/localfiles/memo.db`. 디렉터리는 `openDb()` 가 만든다.
- **관리자 토큰**: 같은 디렉터리의 `admin-token` 파일(권한 600). `.env` 의 `ADMIN_TOKEN_FILE` 이
  가리킨다. 기동 로그가 값이 아니라 출처 경로를 찍으므로 어느 파일을 읽었는지 한눈에 보인다.

## Build and validation commands

```bash
pnpm start                 # = node apps/backend/src/server.mjs
pnpm test                  # node --test, 125개 (백엔드 101 + 관리자 페이지 24)
pnpm migrate:calrory       # baro_calrory 의 memo.db 이관
pnpm admin:token           # 관리자 토큰 확인 (없으면 생성) · --rotate 로 교체
pm2 restart baro-memo --update-env
```

검증은 `/api/health` 가 정본이다 — `version`, `board`(상태별 개수), `tokens`(활성/폐기)를 한
번에 준다. pm2 의 `online` 은 죽음만 잡고 낡음은 못 잡으므로, 재시작 뒤에는 `/api/version` 이
`package.json` 과 같은지 반드시 본다.

배포 절차(새 호스트 7단계 · 갱신 · 팀원 붙이기)는 `readme.md` 의 "배포 절차" 가 정본이다.
단계마다 확인 방법이 붙어 있고, 확인이 안 되면 다음으로 가지 않는다.

## Tests

`node --test` 125개. 글롭이 `apps/**/*.test.mjs` 라 새 앱의 검사는 자동으로 딸려 온다.

백엔드 101개, 일곱 파일:

- `memo-store.test.mjs` — 저장소 불변식, user/updatedBy 스탬프, 요약·total·기본 limit,
  **FTS5 트리거 동기화**(insert/update/delete)와 기존 DB 색인 backfill
- `memo-routes.test.mjs` — 읽기/쓰기 문턱 분리, 거절 코드, 목록 쿼리 전반(검색·필터·페이지)
- `comment-store.test.mjs` — 귀속(user 는 인자에서만), 댓글 색인이 검색에 걸리는지, 지운 댓글이
  색인에서도 사라지는지, 메모 삭제 시 cascade, 이미 쌓인 DB 에 댓글 색인 backfill
- `audit-store.test.mjs` — 수정은 바뀐 칸만·같은 값은 이력 아님, 삭제는 본문과 딸린 댓글까지,
  메모가 지워져도 삭제 기록은 남음(외래키를 안 건 이유), 지운 내용이 `?q=` 로 안 나옴
- `admin-routes.test.mjs` — 관리자 토큰 분리, 발급·폐기, 이력 열람(관리자 전용·쿼리 검증·쓰기 없음)
- `admin-token.test.mjs` — 토큰 출처의 우선순위와 읽기 실패 처리
- `help-doc.test.mjs` — help 문서와 코드의 **양방향** 검사(유령 경로 금지·누락 금지),
  영문 단일 언어, 쿼리 힌트와 `LIST_PARAMS` 일치

관리자 페이지 24개, `apps/admin/test/`:

- `dom-shim.mjs` — 브라우저가 없으므로 최소 DOM 을 심어 `app.js` 를 `node:vm` 에서 **그대로**
  실행한다. index.html 에서 정적 `<option>`·버튼 라벨을 읽어 오므로 HTML↔JS 계약도 같이 걸린다.
  **없는 API 를 있다고 흉내 내지 않는 것이 이 shim 의 규칙이다** — 기본값이 평문 HTTP(클립보드
  없음)인 이유이고, 그 흉내 때문에 복사 버튼이 검사를 통과하며 화면에서 죽었다.
- `admin-page.test.mjs` — 시간대 표시(지역별 벽시계·자정 경계·죽은 zone), 백엔드 판 표시와
  실패 표시, 복사 세 경로(표준 API·execCommand·선택만), 발급 중복 제출 잠금, 본문 팝업 여닫이,
  그리고 **CSS 계약**: `[hidden]`·`[open]` 로 여닫는 요소에 저자 스타일시트가 `display` 를 주면
  실패한다(shim 은 CSS 를 못 보므로 글자로 대조한다)

## Notes

- 의존성 0 을 유지한다. SQLite 는 Node 내장 `node:sqlite` (Node 24.15.0 / SQLite 3.51.3),
  FTS5 가 컴파일되어 들어 있어 전문 검색에도 새 패키지가 필요 없다.
- `_forAI/` 는 사람과 AI 가 읽는 저장소 문서고, 보드(`/api/memos`)는 진행 중인 일이 있는 곳이다.
  둘을 섞지 않는다.
- **스킬은 API 를 재문서화하지 않는다.** `skills/baro-memo/SKILL.md` 는 주소·인증·쓰기 방법까지
  만 담고 라우트와 규약은 `/api/help` 로 넘긴다. 옮겨 적으면 두 벌이 되고 한쪽만 갱신된다 —
  help 를 영문 단일 언어로 못 박은 것과 같은 이유다.
- 개인 설정은 `~/.config/baro-memo/env` (권한 600): `BARO_MEMO_URL` 과 사람별 `BARO_MEMO_TOKEN`.
