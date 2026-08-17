// 필드 정규화 — memo 와 comment 가 같은 규칙을 쓴다.
//
// 따로 두면 갈라진다. 댓글 본문만 30000자를 받아 주는 순간 "왜 이건 되고 저건 안 되나"가
// 생기고, 그 답은 코드 두 곳을 읽어야 나온다.
export const LIMITS = Object.freeze({ title: 200, body: 20000, author: 100, status: 100 });

export function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

// 트림 + 상한. 숫자·객체는 문자열로 뭉개지 않고 거절한다: body 에 객체가 들어오면
// "[object Object]" 가 저장되고 그건 조용한 데이터 손실이다.
export function text(value, field) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw fail("invalid_field", `${field} must be a string.`);
  const s = value.trim();
  if (s.length > LIMITS[field]) throw fail("too_long", `${field} exceeds the cap (${LIMITS[field]} chars).`);
  // **언어는 여기서 판정하지 않는다.** 0.10.0~0.11.1 에 영어 전용을 이 자리에서 집행했다가
  // 0.12.0 에 걷어냈다 — 쓰기 경로마다 검사를 지나야 하고, 정당한 인용을 거절할 위험을 지며,
  // 정작 비켜 가는 모양(문턱 아래 섞기·로마자)은 못 잡았다. 규칙은 남았고 자리가 바뀌었다:
  // help 와 스킬이 말하고, 지키는 것은 쓰는 쪽이다. 되살리고 싶어지면 그때 다시 재는 것은
  // "무엇을 막았나" 가 아니라 "무엇을 잘못 막았나" 다.
  return s;
}

// URL 조각 → id. 라우터가 `/api/memos/<무엇이든>` 을 받으므로 여기서 한 번에 거른다.
export function toId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}
