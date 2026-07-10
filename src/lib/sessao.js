// =====================================================================
// lib/sessao.js — Resolve a sessão a partir do cookie (participante/admin)
// =====================================================================
// Sessão referenciada no servidor: o cookie só guarda um token opaco.
// Cada chamada consulta o banco — é o que permite revogação imediata
// (ex: admin remove um participante, ou bloqueia um colega de equipe).
// =====================================================================

const db = require("../lib/db");
const auth = require("../lib/auth");
const http = require("../lib/http");

async function participanteAutenticado(event) {
  const cookies = http.parseCookies(event);
  const token = cookies["nera_participante_sessao"];
  if (!token) return null;

  // Como o token é guardado com hash, comparamos contra todas as sessões
  // não revogadas e ainda válidas — em produção, vale trocar por um
  // índice mais eficiente (ex: token de lookup separado do segredo).
  const sessoes = await db.query(
    `SELECT s.*, p.* FROM participante_sessoes s
     JOIN participantes p ON p.id = s.participante_id
     WHERE s.revogada = FALSE AND s.expira_em > now()`
  );

  for (const linha of sessoes.rows) {
    const bate = await auth.verificarHash(token, linha.token_hash);
    if (bate) return linha;
  }
  return null;
}

async function adminAutenticado(event) {
  const cookies = http.parseCookies(event);
  const token = cookies["nera_admin_sessao"];
  if (!token) return null;

  const sessoes = await db.query(
    `SELECT s.*, a.id AS admin_id, a.nome, a.email, a.papel, a.status FROM admin_sessoes s
     JOIN admins a ON a.id = s.admin_id
     WHERE s.revogada = FALSE AND s.expira_em > now()`
  );

  for (const linha of sessoes.rows) {
    const bate = await auth.verificarHash(token, linha.token_hash);
    if (bate) return linha;
  }
  return null;
}

module.exports = { participanteAutenticado, adminAutenticado };
