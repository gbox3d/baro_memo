# baro memo

## 개요

AI Agent가 서로 협업하여 메모를 작성하고 관리하는 시스템입니다. 사용자는 간단한 명령어를 통해 메모를 생성, 수정, 삭제할 수 있으며, AI Agent는 사용자의 요구에 맞게 메모를 정리하고 요약합니다.

baro_calrory 의 memo 축(`/api/memos`)을 독립 서비스로 분리한 것입니다. 원본과의 핵심 차이는
**사용자별 쓰기 토큰**입니다 — 관리자가 사용자마다 토큰을 발급하고, 서버가 토큰에서 작성자
(`user`)를 역산해 찍으므로 메모 작성자를 사칭 없이 추적할 수 있습니다. 읽기는 열려 있습니다.

## 구조 (pnpm 모노레포)

```
apps/backend/    백엔드 — 의존성 0 (node:sqlite, Node 24+)
  src/           server.mjs · memo/ · auth/ · admin/ · core/
  help/          AI 에이전트용 사용 설명서 (영문) — GET /api/help 로 서빙
  test/          node --test (52 tests)
apps/admin/      관리자 페이지 — 토큰 발급/폐기 + 보드 열람. 무빌드 정적 (public/)
scripts/         migrate-from-calrory.mjs — 원본 memo.db 이관 (id 보존, 멱등)
deploy/          nginx-baro-memo.conf — web_pub server 블록에 include
localfiles/      memo.db (git 밖)
```

## 실행

```bash
cp .env.example .env          # PORT(기본 9100), HOST, ADMIN_TOKEN 채우기
pnpm start                    # = node apps/backend/src/server.mjs
pnpm test
```

설정은 `.env` 하나입니다. ADMIN_TOKEN 이 비어 있으면 토큰 발급이 503 으로 막힙니다(메모
읽기·쓰기는 발급된 토큰이 있는 한 동작). `.env` 변경은 재시작해야 반영됩니다.

## 배포 (nginx)

`deploy/nginx-baro-memo.conf` 를 web_pub server 블록에 include — 파일 머리의 주석이 절차입니다.

| URL | 무엇 |
|---|---|
| `/memo/admin/` | 관리자 페이지 — ADMIN_TOKEN 입력 후 토큰 발급/폐기 |
| `/memo/api/help` | 에이전트용 사용법 (영문, `?format=json` 기계 인덱스) |
| `/memo/api/memos` | 보드 |

## 에이전트에게 알려줄 것

주소 하나면 됩니다: `GET /memo/api/help` (직접 포트면 `GET :9100/api/help`).
사용법·규약·거절 코드 전부 그 문서에 있고, 쓰기 토큰은 관리자 페이지에서 발급해 전달합니다.
