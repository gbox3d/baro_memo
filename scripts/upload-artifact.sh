#!/usr/bin/env bash
# baro_files 업로드 클라이언트 — 청크·재개·검증까지 한 벌.
#
#   curl -fsSL http://<주소>/files/upload.sh | bash -s -- <파일> [이름]
#   또는:  ./upload-artifact.sh <파일> [이름]
#
# 필요한 환경:
#   BARO_MEMO_TOKEN   보드의 사람 토큰 (에이전트 기기: ~/.config/baro-memo/env)
#   BARO_FILES_URL    스토어 API (기본 http://192.168.0.220/files/api — 밖에서는
#                     http://gobackdev.iptime.org:22030/files/api)
#
# 성질: 같은 파일로 다시 실행하면 **이어서** 올린다(세션 id 를 파일 옆 .baro-upload 에 남겨
# 두고, 서버의 missing 목록만큼만 보낸다). 청크가 끊기면 그 청크만 다시 간다. 세션이 만들어진
# 뒤 파일이 바뀌었으면 그 세션을 버리고 새로 연다 — 낡은 선언에 새 바이트를 부으면 finalize 가
# 해시에서야 거절하고, 그때는 이미 수 GB 를 보낸 뒤다.
set -euo pipefail

FILE="${1:?usage: upload-artifact.sh <file> [name]}"
NAME="${2:-$(basename "$FILE")}"
API="${BARO_FILES_URL:-http://192.168.0.220/files/api}"
TOKEN="${BARO_MEMO_TOKEN:?BARO_MEMO_TOKEN is not set — source ~/.config/baro-memo/env}"
CHUNK=$((80 * 1024 * 1024))
STATE="${FILE}.baro-upload"

[ -f "$FILE" ] || { echo "no such file: $FILE" >&2; exit 1; }
SIZE=$(stat -c %s "$FILE")
echo "sha256 계산 중 ($SIZE bytes)…" >&2
SHA=$(sha256sum "$FILE" | cut -d' ' -f1)

auth=(-H "x-memo-token: $TOKEN")

json_field() { # <json> <field> — 문자열 값 하나를 뽑는다. **없으면 빈 값**이다(실패가 아니다) —
  # grep 의 무매치 반환값(1)이 pipefail·set -e 를 타고 올라오면, 성공 응답(code 필드가 없다)을
  # 받은 순간 스크립트가 죽는다. 실제로 그랬다.
  { echo "$1" | grep -o "\"$2\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; } 2>/dev/null || true
}

new_session() {
  local out
  out=$(curl -sf "${auth[@]}" -X POST "$API/uploads" -H 'content-type: application/json' \
    -d "{\"name\":\"$NAME\",\"size\":$SIZE,\"sha256\":\"$SHA\"}") \
    || { echo "세션 생성 실패 — 토큰과 이름 규칙(^[A-Za-z0-9][A-Za-z0-9._-]*$)을 확인" >&2; exit 1; }
  ID=$(json_field "$out" id)
  echo "$ID" > "$STATE"
}

# 세션 — 이어받을 것이 있으면 그것부터. 단, **그 세션의 선언이 지금 파일과 같을 때만**이다.
ID=""
if [ -f "$STATE" ]; then
  ID=$(cat "$STATE")
  INV=$(curl -sf "${auth[@]}" "$API/uploads/$ID" 2>/dev/null) || ID=""
  if [ -n "$ID" ]; then
    OLD_SHA=$(json_field "$INV" sha256)
    if [ "$OLD_SHA" != "$SHA" ]; then
      echo "세션이 만들어진 뒤 파일이 바뀌었다 — 그 세션을 버리고 새로 연다" >&2
      curl -s "${auth[@]}" -X DELETE "$API/uploads/$ID" >/dev/null || true
      ID=""
    fi
  fi
fi
[ -n "$ID" ] || new_session
echo "session $ID" >&2

send_missing() {
  while :; do
    local inv missing
    inv=$(curl -sf "${auth[@]}" "$API/uploads/$ID")
    missing=$(echo "$inv" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("\n".join(f"{s} {e}" for s,e in d["upload"]["missing"]))')
    [ -n "$missing" ] || break
    echo "$missing" | while read -r S E; do
      POS=$S
      while [ "$POS" -lt "$E" ]; do
        LEN=$((E - POS)); [ "$LEN" -gt "$CHUNK" ] && LEN=$CHUNK
        # 바이트 단위 정확히 자른다. MB 로 어림한 skip 은 경계가 1MiB 배수가 아닐 때 엉뚱한
        # 바이트를 올리고, head 절단은 dd 를 SIGPIPE 로 죽여 pipefail 이 성공을 실패로 읽는다.
        for try in 1 2 3; do
          if dd if="$FILE" iflag=skip_bytes,count_bytes skip="$POS" count="$LEN" 2>/dev/null \
            | curl -sf "${auth[@]}" -X PUT "$API/uploads/$ID/chunks" \
                -H "chunk-start: $POS" -H 'content-type: application/octet-stream' \
                --data-binary @- >/dev/null; then
            break
          fi
          [ "$try" = 3 ] && { echo "청크 $POS 3회 실패 — 다시 실행하면 이어서 간다" >&2; exit 1; }
          sleep 2
        done
        echo "  $POS +$LEN / $SIZE" >&2
        POS=$((POS + LEN))
      done
    done
  done
}

send_missing

# 완성 — 서버가 전체를 다시 해시해 선언과 대조한다. -f 를 쓰지 않는 이유: 409 의 **코드**가
# 다음 행동을 가른다(빠진 구간 / 해시 불일치 / 진행 중), -f 는 그 몸통을 버린다.
finalize() { curl -s "${auth[@]}" -X POST "$API/uploads/$ID/finalize"; }
OUT=$(finalize)
CODE=$(json_field "$OUT" code)

if [ "$CODE" = "sha256_mismatch" ]; then
  # 어느 구간이 상했는지는 아무도 모른다 — 전 구간을 한 번 다시 보내고 재시도한다.
  # (서버는 세션을 지켜 두므로 이 재전송은 제자리 덮어쓰기다.)
  echo "해시 불일치 — 전 구간을 다시 보내고 재시도한다" >&2
  curl -s "${auth[@]}" -X DELETE "$API/uploads/$ID" >/dev/null
  new_session
  send_missing
  OUT=$(finalize)
  CODE=$(json_field "$OUT" code)
fi

if [ "$CODE" = "upload_incomplete" ] || [ "$CODE" = "upload_busy" ] || [ "$CODE" = "finalize_in_progress" ]; then
  echo "finalize 보류($CODE) — 다시 실행하면 이어서 간다" >&2; exit 1
fi
if ! echo "$OUT" | grep -q '"artifact"'; then
  echo "finalize 실패: $OUT" >&2; exit 1
fi

rm -f "$STATE"
echo "$OUT"
echo "완료. 보드에 릴리스 글을 남기세요 — 버전·sha256·다운로드 주소가 검색되는 곳은 보드다." >&2
