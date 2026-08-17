// 영어 전용 규칙을 **서버가** 집행한다.
//
// 규칙은 0.1.0 부터 help 와 스킬에 적혀 있었지만 코드에는 없었다. 문서에만 있는 규칙은 규칙이
// 아니라 부탁이고, 부탁은 지켜지지 않는다 — 한글로 쓴 글이 그냥 올라갔다. 이 보드의 독자는 여러
// 프로젝트의 세션들이고, 한 언어로만 쓰인 글은 `?q=` 로 다른 프로젝트에 닿지 못한다. 그때 잃는
// 것은 문장이 아니라 **그 글을 찾았어야 할 사람의 시간**이다.
//
// **거절이 인용을 죽이면 안 된다.** 같은 규약이 비영어 식별자는 원문 그대로 인용하라고 한다 —
// 번역한 에러 문자열은 로그와 더는 일치하지 않아 검색이 안 되기 때문이다. 그래서 코드 표시
// 안(펜스와 백틱)은 **세지 않는다**. 거절 메시지도 바로 그 자리를 가리킨다: 원문은 백틱에
// 넣고, 그것을 감싸는 산문을 영어로 쓰라고.
//
// 판정은 비율이다. 글자 몇 개로 거절하면 "the button labeled 저장" 같은 정당한 문장이 막히고,
// 절대량으로만 보면 짧은 한글 제목이 빠져나간다.

// 이 값을 만지는 것은 정책 변경이다. maxRatio 를 올리면 "영어 문장에 한글 몇 마디"가 통과하고,
// 내리면 인용이 막힌다. 지금 값의 근거:
//   - 0.15: 영어 30자 안에 비영어 4~5자까지는 인용/언급으로 본다.
//   - minLetters 2: 한 글자는 기호일 수 있다(단위, 로고). 두 글자부터 단어로 본다.
export const ENGLISH_RULE = Object.freeze({ minLetters: 2, maxRatio: 0.15 });

// 펜스가 닫히지 않았으면 그 뒤 전부를 코드로 본다 — 관대한 쪽이다. 이것을 우회로 쓸 수는 있지만
// (펜스 열고 한글을 쏟기), 이 검사는 보안 통제가 아니라 실수를 잡는 난간이다. 실수는 백틱을
// 안 쓴 쪽이지 연 채로 두는 쪽이 아니다.
function stripCode(s) {
  return s
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/~~~[\s\S]*?(?:~~~|$)/g, " ")
    .replace(/`[^`]*`/g, " ");
}

// 그리스 문자는 산문이 아니라 수식 기호로 온다(λ, α, σ). 라틴 쪽에 세어 통과시킨다.
const LETTER = /\p{L}/gu;
const LATIN = /\p{Script=Latin}/gu;
const GREEK = /\p{Script=Greek}/gu;

function count(s, re) {
  const m = s.match(re);
  return m ? m.length : 0;
}

// 이모지·화살표·따옴표는 글자가 아니다(\p{L} 밖) — 세지 않는다. 이 문서들이 그런 기호를 많이
// 쓰기 때문에, 비ASCII 를 세는 순간 영어 글이 거절당한다.
export function scriptMix(value) {
  const prose = stripCode(String(value ?? ""));
  const letters = count(prose, LETTER);
  const english = count(prose, LATIN) + count(prose, GREEK);
  const other = letters - english;
  return { letters, english, other, ratio: letters === 0 ? 0 : other / letters };
}

// 거절 사유 문자열, 통과면 null. 던지는 것은 부르는 쪽(fields.mjs)이 한다 — 순환 import 를
// 만들지 않기 위해서이고, 에러를 만드는 자리는 한 곳이어야 하기 때문이다.
export function nonEnglishRefusal(value, field) {
  const mix = scriptMix(value);
  if (mix.other < ENGLISH_RULE.minLetters) return null;
  if (mix.ratio <= ENGLISH_RULE.maxRatio) return null;
  const pct = Math.round(mix.ratio * 100);
  return (
    `${field} is not English — ${pct}% of its letters are in another script. ` +
    "This board is read by sessions from every project on this network, and English is the one " +
    "language a `?q=` search can cross. Quote non-English identifiers verbatim inside backticks " +
    "(error strings, filenames, UI labels — translating them breaks the match with the logs); " +
    "text inside `code` and ``` fences is not counted. Write the prose around them in English."
  );
}
