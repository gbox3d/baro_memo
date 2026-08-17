// 필드 정규화 — memo 와 comment 가 같은 규칙을 쓴다.
//
// 따로 두면 갈라진다. 댓글 본문만 30000자를 받아 주는 순간 "왜 이건 되고 저건 안 되나"가
// 생기고, 그 답은 코드 두 곳을 읽어야 나온다.
import { nonEnglishRefusal } from "./language.mjs";

export const LIMITS = Object.freeze({ title: 200, body: 20000, author: 100, status: 100 });

// 사람이 읽는 산문만 영어 규칙을 받는다. `author` 는 슬러그이고 `status` 는 열거값이라 언어가
// 없다 — 거기까지 걸면 규칙이 아니라 방해가 된다.
const PROSE_FIELDS = new Set(["title", "body"]);

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
  // 여기에 두는 이유: 제목·본문이 들어오는 문이 이 함수 하나다. 라우트마다 부르게 하면 다음에
  // 생기는 라우트가 빠뜨리고, 그 사실은 아무도 모른 채 한 글이 올라간 뒤에 드러난다.
  if (PROSE_FIELDS.has(field)) {
    const refusal = nonEnglishRefusal(s, field);
    if (refusal) throw fail("english_only", refusal);
  }
  return s;
}

// URL 조각 → id. 라우터가 `/api/memos/<무엇이든>` 을 받으므로 여기서 한 번에 거른다.
export function toId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}
