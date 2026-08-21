#!/bin/sh
# baro_memo 스킬 설치. 팀원 기기에서 한 번 돌린다.
#
#   서버에서:   curl -fsSL http://<보드주소>/memo/install.sh | sh
#   저장소에서: ./scripts/install-skill.sh
#
# 이 스크립트가 하는 일은 **파일**뿐이다. 토큰은 묻지 않는다 — 처음 쓸 때 Claude 가 물어보고
# ~/.config/baro-memo/env 에 직접 쓴다. 자격증명이 설치 스크립트를 거치면 셸 히스토리와
# 스크롤백에 남고, 사람마다 다른 값이라 스크립트가 대신 정할 수도 없다.
#
# 두 번 돌려도 안전하다.
set -eu

BOARD="${BARO_MEMO_BOARD:-http://192.168.0.220/memo}"
SKILL_DIR="${HOME}/.claude/skills/baro-memo"
CLAUDE_MD="${HOME}/.claude/CLAUDE.md"
here=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

# 저장소 안에서 돌리면 심볼릭 링크 — git pull 이 곧 갱신이다(개발자용).
# 밖에서 돌리면 서버에서 받는다 — 돌고 있는 서버와 같은 판이 온다(팀원용).
if [ -f "${here}/skills/baro-memo/SKILL.md" ]; then
  mkdir -p "$(dirname "$SKILL_DIR")"
  rm -rf "$SKILL_DIR"
  ln -sfn "${here}/skills/baro-memo" "$SKILL_DIR"
  echo "스킬: ${SKILL_DIR} -> ${here}/skills/baro-memo (심볼릭 링크, git pull 로 갱신)"
else
  mkdir -p "${SKILL_DIR}/scripts"
  if ! curl -fsSL "${BOARD}/skill/SKILL.md" -o "${SKILL_DIR}/SKILL.md"; then
    echo "스킬을 받지 못했습니다: ${BOARD}/skill/SKILL.md" >&2
    echo "보드 주소가 다르면 BARO_MEMO_BOARD=http://<주소>/memo 로 지정하세요." >&2
    exit 1
  fi
  # 자격증명 헬퍼. SKILL.md 가 이 경로를 참조하므로 같이 받아야 한다 — 없어도 스킬은
  # 프로필 파일을 직접 소싱하는 갈래로 돌지만, 여러 보드를 다루는 명령은 여기 있다.
  if ! curl -fsSL "${BOARD}/skill/scripts/baro-memo.sh" -o "${SKILL_DIR}/scripts/baro-memo.sh"; then
    echo "헬퍼를 받지 못했습니다: ${BOARD}/skill/scripts/baro-memo.sh" >&2
    echo "보드가 옛 판이면 SKILL.md 만으로도 동작합니다(프로필 파일을 직접 소싱)." >&2
    rmdir "${SKILL_DIR}/scripts" 2>/dev/null || true
  else
    chmod +x "${SKILL_DIR}/scripts/baro-memo.sh"
  fi
  echo "스킬: ${SKILL_DIR}/SKILL.md (${BOARD} 에서 받음)"
fi

# 의무는 항상 컨텍스트에 있어야 한다. 스킬은 설명이 매칭될 때만 로드되므로, "스스로 판단해서
# 남긴다"는 여기 없으면 일어나지 않는다. 표시자로 감싸 두 번 돌려도 겹치지 않게 한다.
mkdir -p "$(dirname "$CLAUDE_MD")"
touch "$CLAUDE_MD"
if grep -q 'baro-memo:begin' "$CLAUDE_MD"; then
  sed -i '/<!-- baro-memo:begin -->/,/<!-- baro-memo:end -->/d' "$CLAUDE_MD"
fi
cat >> "$CLAUDE_MD" <<EOF
<!-- baro-memo:begin -->

## 팀 보드 (baro_memo)

저장소를 가로지르는 공용 메모판이 ${BOARD}/api 에 있다. 여기 세션들이 서로에게 남긴 것이
쌓여 있고, 나를 구할 메모는 열어 본 적 없는 저장소에서 짐작 못 할 제목으로 쓰였을 가능성이 높다.

- **비자명한 작업을 시작하기 전에 검색한다** — \`?q=<에러 문자열>\`. 분류가 아니라 증상으로 찾는다.
- **원인이 자명하지 않았던 것, 막다른 길, 남이 의존하는 계약의 변경은 남긴다.** 다음 세션이
  같은 시간을 다시 쓰지 않게.
- 쓰는 절차와 토큰 위치는 \`baro-memo\` 스킬에, 규약 정본은 \`GET ${BOARD}/api/help\` 에 있다.
<!-- baro-memo:end -->
EOF
echo "규칙: ${CLAUDE_MD} 의 baro-memo 블록 갱신"

if [ -f "${HOME}/.config/baro-memo/env" ]; then
  echo "설정: ~/.config/baro-memo/env 이미 있음 (그대로 둠)"
else
  echo
  echo "쓰기 토큰은 아직 없습니다. Claude Code 에서 \"바로메모\" 라고 부르면 주소와 토큰을"
  echo "물어보고 ~/.config/baro-memo/env 에 넣습니다. 토큰은 ${BOARD}/admin/ 에서 운영자가"
  echo "사람마다 발급합니다. 토큰이 없으면 읽기·검색도 안 됩니다 — 이 보드는 밖에서 닿는"
  echo "주소로 열려 있어 0.5.0 부터 읽기에도 토큰이 필요합니다."
fi
