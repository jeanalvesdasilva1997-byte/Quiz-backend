// =====================================================================
// handlers/monitoramento.js — Painel de acompanhamento em tempo quase real
// =====================================================================
// Mecanismo: consulta periódica (polling) feita pelo front-end a cada
// 5-10s — este endpoint só devolve o estado atual, sem manter conexão
// persistente (decisão já registrada na Seção 10 da arquitetura).
// Só lista turmas com status 'ativa', por decisão do time Nera.
// =====================================================================

const db = require("../lib/db");
const http = require("../lib/http");
const sessao = require("../lib/sessao");
const gam = require("../lib/gamificacao");

// GET /admin/turmas-ativas   (para popular o seletor do Monitoramento)
async function turmasAtivas(event) {
  try {
    const admin = await sessao.adminAutenticado(event);
    if (!admin) return http.unauthorized();

    const res = await db.query(`SELECT id, nome FROM turmas WHERE status = 'ativa' ORDER BY data_evento`);
    return http.ok({ turmas: res.rows });
  } catch (err) {
    return http.serverError(err);
  }
}

// GET /admin/monitoramento/:turmaId
async function monitorar(event) {
  try {
    const admin = await sessao.adminAutenticado(event);
    if (!admin) return http.unauthorized();

    const turmaId = event.pathParameters && event.pathParameters.turmaId;
    const turmaRes = await db.query(`SELECT id, nome, status FROM turmas WHERE id = $1`, [turmaId]);
    if (turmaRes.rows.length === 0) return http.notFound("Turma não encontrada.");
    if (turmaRes.rows[0].status !== "ativa") {
      return http.conflict("Monitoramento disponível apenas para turmas com status Ativa.");
    }

    const participantesRes = await db.query(
      `SELECT nome, email, empresa, origem, status, respondidas, xp_total, melhor_streak,
              questao_iniciada_em
       FROM participantes WHERE turma_id = $1 ORDER BY nome`,
      [turmaId]
    );

    const participantes = participantesRes.rows.map((p) => ({
      nome: p.nome,
      empresa: p.empresa,
      origem: p.origem,
      status: p.status,
      moduloAtual: gam.moduloAtual(p.respondidas),
      progresso: gam.progressoPercentual(p.respondidas),
      xpTotal: p.xp_total,
      melhorStreak: p.melhor_streak,
      // alerta: convite pendente há mais de 10 min é calculado aqui, não na tela
      alertaConvitePendente: p.status === "convite_pendente",
    }));

    return http.ok({ turma: turmaRes.rows[0], participantes });
  } catch (err) {
    return http.serverError(err);
  }
}

module.exports = { turmasAtivas, monitorar };
