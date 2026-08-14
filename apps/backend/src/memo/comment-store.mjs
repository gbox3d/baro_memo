// 댓글 저장소.
//
// 메모는 "무엇을 찾았다"는 진술이고 댓글은 그 뒤에 붙는 대화다. 본문에 이어 붙이지 않는
// 이유는 귀속이다 — 서버가 토큰에서 `user` 를 찍는 것이 이 서비스의 존재 이유인데, 남의
// 본문에 이어 붙이면 그 문장의 주인이 누구인지 다시 말할 수 없다.
//
// **수정은 없다(append-only).** 인용되는 글이 조용히 바뀌면 인용이 무의미해진다. 잘못 쓴
// 댓글은 지우고 다시 단다 — 삭제는 있다.
import { fail, text, toId } from "./fields.mjs";
import { ensureSchema } from "./schema.mjs";

export const toCommentId = toId;

function toComment(row) {
  if (!row) return null;
  return {
    id: row.id,
    memoId: row.memo_id,
    body: row.body,
    author: row.author,
    user: row.user,
    createdAt: row.created_at,
  };
}

export class CommentStore {
  constructor(db) {
    this.db = db;
    ensureSchema(db);
  }

  /** 한 메모의 댓글 — 시간순(오래된 것이 위). 대화는 위에서 아래로 읽힌다. */
  listFor(memoId) {
    return this.db
      .prepare("SELECT * FROM comment WHERE memo_id = ? ORDER BY id")
      .all(memoId)
      .map(toComment);
  }

  get(id) {
    return toComment(this.db.prepare("SELECT * FROM comment WHERE id = ?").get(id));
  }

  // user 는 본문이 아니라 인자다 — 라우터가 토큰에서 역산한 값만 들어온다. memo 축과 같은 결.
  add(memoId, input = {}, user = "") {
    const body = text(input.body, "body");
    if (!body) throw fail("empty_body", "body cannot be empty.");
    const { lastInsertRowid } = this.db
      .prepare("INSERT INTO comment (memo_id, body, author, user, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(memoId, body, text(input.author, "author"), user, new Date().toISOString());
    return this.get(Number(lastInsertRowid));
  }

  remove(id) {
    return this.db.prepare("DELETE FROM comment WHERE id = ?").run(id).changes > 0;
  }

  countFor(memoId) {
    return this.db.prepare("SELECT COUNT(*) AS n FROM comment WHERE memo_id = ?").get(memoId).n;
  }
}
