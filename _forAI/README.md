# _forAI Guide

## 목차

- [한 줄 요약](#한-줄-요약)
- [읽는 순서](#읽는-순서)
- [문서 역할](#문서-역할)
- [현재 스냅샷](#현재-스냅샷)
- [유지 규칙](#유지-규칙)

## 한 줄 요약

이 디렉터리는 `baro_memo` 작업을 이어받을 때 필요한 AI 작업 문맥을 정리해 두는 곳이다.

## 읽는 순서

1. `README.md`
2. `inventory.md`
3. `memo.md`
4. `dev_log.md`
5. `plan.md`

## 문서 역할

- `inventory.md`: 저장소에 실제로 있는 구조, 엔트리포인트, 빌드/검증 명령을 기록한다.
- `plan.md`: 앞으로 진행할 개발 계획과 우선순위만 기록한다.
- `memo.md`: 프로토콜, 핀맵, 기본값, 디버깅 교훈 같은 참고 메모를 모은다.
- `dev_log.md`: 날짜별 작업 이력과 `_forAI` 정리 내역을 남긴다.

## 현재 스냅샷

- 저장소 경로: `/home/gblab-dgx-01/works/baro_memo`
- 대상 플랫폼: Node 24 + pm2 (`baro-memo` **하나**), 사내망. 외부 접점은 nginx `/memo/`(게시판)
  와 `/files/`(아티팩트 저장소), 그리고 터널. 두 표면을 한 프로세스가 든다
- 현재 버전: 0.11.0 — 아티팩트 저장소를 보드 프로세스의 마운트(`/api/files`)로 합쳤다.
  앞선 축: 읽기도 토큰(0.5.0), 이력이 두 층으로(0.6.0/0.7.0), 중요도 점수(0.8.0),
  `/api/auth/whoami`(0.9.0), 영어 전용을 서버가 집행(0.10.0, 400 `english_only`)
- 메인 엔트리포인트: `apps/backend/src/server.mjs` (`pnpm start`)
- 관리자 페이지: `apps/admin/public/` — nginx 가 디스크에서 바로 서빙한다(빌드도 재시작도 없다).
  검사는 `apps/admin/test/` 에서 브라우저 없이 돈다
- 검사: `pnpm test` 218개 (백엔드 141 + 관리자 페이지 40 + 아티팩트 저장소 37)
- DB: `/mnt/data/baro_memo_db/memo.db` — 저장소 밖이다. `.env` 의 `MEMO_DB` 가 정본
- 아티팩트 바이트: `/mnt/data/baro_memo_files/` — 같은 볼륨, `.env` 의 `FILES_ROOT`. 파일은
  그냥 파일이고 DB 에는 장부만 있다
- 분리 원본: `/home/gblab-dgx-01/works/baro_calrory` 의 memo 축 (분리 완료)

## 유지 규칙

- 계획이 아닌 참고 정보는 `plan.md`가 아니라 `memo.md`에 둔다.
- 저장소 구조나 실행 명령이 바뀌면 `inventory.md`를 먼저 갱신한다.
- 작업 이력은 날짜를 붙여 `dev_log.md`에만 남긴다.
- 새 작업을 시작할 때는 `inventory.md`와 `memo.md`를 먼저 읽고, 실제 할 일은 `plan.md`에서 확인한다.
- 모든 문서에는 제목 바로 아래에 `## 목차` 섹션을 둔다.
- 사용자 동의 없이 git commit을 하지 않는다.
- 사용자 동의 없이 `_forAI/` 문서를 수정하지 않는다.
