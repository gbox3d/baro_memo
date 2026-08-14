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
  return s;
}

// URL 조각 → id. 라우터가 `/api/memos/<무엇이든>` 을 받으므로 여기서 한 번에 거른다.
export function toId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}
