// =====================================================================
// lib/http.js — Helpers de resposta para Lambda + API Gateway (proxy)
// =====================================================================

function jsonResponse(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      // CORS (Access-Control-Allow-Origin/Credentials) é aplicado centralmente
      // pelo middleware em server.js, com base na origem da requisição.
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

function ok(body, extraHeaders) {
  return jsonResponse(200, body, extraHeaders);
}

function created(body, extraHeaders) {
  return jsonResponse(201, body, extraHeaders);
}

function badRequest(mensagem) {
  return jsonResponse(400, { erro: mensagem });
}

function unauthorized(mensagem = "Não autenticado.") {
  return jsonResponse(401, { erro: mensagem });
}

function forbidden(mensagem = "Sem permissão para esta ação.") {
  return jsonResponse(403, { erro: mensagem });
}

function notFound(mensagem = "Recurso não encontrado.") {
  return jsonResponse(404, { erro: mensagem });
}

function conflict(mensagem) {
  return jsonResponse(409, { erro: mensagem });
}

function serverError(err) {
  console.error(err); // vai para o CloudWatch — nunca vaza detalhe interno pro cliente
  return jsonResponse(500, { erro: "Erro interno. Tente novamente em instantes." });
}

// Parser de cookies do header (API Gateway entrega como string única)
function parseCookies(event) {
  const header = (event.headers && (event.headers.cookie || event.headers.Cookie)) || "";
  return Object.fromEntries(
    header.split(";").filter(Boolean).map((p) => {
      const [k, ...v] = p.trim().split("=");
      return [k, v.join("=")];
    })
  );
}

module.exports = { ok, created, badRequest, unauthorized, forbidden, notFound, conflict, serverError, parseCookies };
