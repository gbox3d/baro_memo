// 라우터 계층의 공용 HTTP 조각 — baro_calrory core/http.mjs 의 json() 과 같은 모양.
// 라우터는 {status, contentType, json|body} 를 돌려주고, 실제 응답은 server.mjs 가 쓴다.
export function json(status, data) {
  return { status, contentType: "application/json", json: data };
}
