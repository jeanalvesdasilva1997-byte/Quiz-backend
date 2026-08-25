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
  const token = cookies["habitat_participante_sessao"];
  if (!token) return null;

  // Busca indexada por token_hash (hash rápido e determinístico — ver
  // auth.hashTokenSessao) em vez de varrer todas as sessões ativas
  // comparando uma a uma com bcrypt.
  //
  // Depois que a turma é encerrada, o acesso do participante ainda vale
  // por 12h (pra dar tempo de ver o pódio final) — passado isso, a sessão
  // para de ser reconhecida aqui, mesmo que o cookie em si ainda não
  // tenha expirado.
  const tokenHash = auth.hashTokenSessao(token);
  const sessoes = await db.query(
    `SELECT s.*, p.* FROM participante_sessoes s
     JOIN participantes p ON p.id = s.participante_id
     JOIN turmas t ON t.id = p.turma_id
     WHERE s.token_hash = $1 AND s.revogada = FALSE AND s.expira_em > now()
       AND (t.status != 'encerrada' OR now() <= t.janela_fim + interval '12 hours')`,
    [tokenHash]
  );

  return sessoes.rows[0] || null;
}

async function adminAutenticado(event) {
  const cookies = http.parseCookies(event);
  const token = cookies["habitat_admin_sessao"];
  if (!token) return null;

  const tokenHash = auth.hashTokenSessao(token);
  const sessoes = await db.query(
    `SELECT s.*, a.id AS admin_id, a.nome, a.email, a.papel, a.status FROM admin_sessoes s
     JOIN admins a ON a.id = s.admin_id
     WHERE s.token_hash = $1 AND s.revogada = FALSE AND s.expira_em > now()`,
    [tokenHash]
  );

  return sessoes.rows[0] || null;
}

module.exports = { participanteAutenticado, adminAutenticado };
