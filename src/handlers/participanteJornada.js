// =====================================================================
// handlers/participanteJornada.js — Painel do participante
// =====================================================================
// A pergunta ao vivo (fase, timer, resposta) mora em quizAoVivo.js —
// aqui fica só o resumo/pódio que o painel do participante consome.
// =====================================================================

const db = require("../lib/db");
const http = require("../lib/http");
const sessao = require("../lib/sessao");

// GET /participante/painel
async function painel(event) {
  try {
    const p = await sessao.participanteAutenticado(event);
    if (!p) {
      return sessao.participanteTinhaCookie(event)
        ? http.forbidden("Sua sessão foi encerrada.", { acessoExpirado: true })
        : http.unauthorized();
    }

    const turmaRes = await db.query(`SELECT status, quiz_fase, quiz_estado, podio1_liberado, podio2_liberado FROM turmas WHERE id = $1`, [p.turma_id]);
    const turma = turmaRes.rows[0];

    // Não existe pontuação somada entre fases — cada pódio ranqueia só
    // pela fase correspondente (Pódio 1 = Fase 1, Pódio 2 = Fase 2). Além
    // da fase estar concluída, o admin precisa ter liberado explicitamente
    // (podioN_liberado) — senão ninguém vê o ranking antes da hora certa,
    // mesmo já tendo terminado de responder.
    let podio1 = null;
    let podio2 = null;
    if (turma && turma.podio1_liberado) {
      const res1 = await db.query(
        `SELECT nome, empresa, xp_fase1 AS pontos, melhor_streak FROM participantes
         WHERE turma_id = $1 ORDER BY xp_fase1 DESC, melhor_streak DESC LIMIT 3`,
        [p.turma_id]
      );
      podio1 = res1.rows;
    }
    if (turma && turma.podio2_liberado) {
      const res2 = await db.query(
        `SELECT nome, empresa, xp_fase2 AS pontos, melhor_streak FROM participantes
         WHERE turma_id = $1 ORDER BY xp_fase2 DESC, melhor_streak DESC LIMIT 3`,
        [p.turma_id]
      );
      podio2 = res2.rows;
    }

    return http.ok({
      nome: p.nome,
      empresa: p.empresa,
      xpFase1: p.xp_fase1,
      xpFase2: p.xp_fase2,
      melhorStreak: p.melhor_streak,
      fase: turma ? turma.quiz_fase : 0,
      quizEstado: turma ? turma.quiz_estado : "aguardando",
      turmaEncerrada: turma ? turma.status === "encerrada" : false,
      podio1,
      podio2,
      podio1Liberado: turma ? turma.podio1_liberado : false,
      podio2Liberado: turma ? turma.podio2_liberado : false,
      // NULL = ainda não perguntado — é o que decide se o front mostra a
      // tela de autorização antes da sala. TRUE/FALSE = já respondeu.
      consentimentoNera: p.consentimento_nera,
    });
  } catch (err) {
    return http.serverError(err);
  }
}

// POST /participante/consentimento-nera   { autorizou: boolean }
// Registra a autorização (ou não) de contato comercial futuro pela Nera —
// consentimento específico, separado da gestão do treinamento pela
// Cebrace. Responder aqui não afeta o acesso ao treinamento em nenhum
// dos dois sentidos.
async function registrarConsentimentoNera(event) {
  try {
    const p = await sessao.participanteAutenticado(event);
    if (!p) {
      return sessao.participanteTinhaCookie(event)
        ? http.forbidden("Sua sessão foi encerrada.", { acessoExpirado: true })
        : http.unauthorized();
    }

    const { autorizou } = JSON.parse(event.body || "{}");
    if (typeof autorizou !== "boolean") return http.badRequest("Informe se autoriza ou não o contato.");

    await db.query(
      `UPDATE participantes SET consentimento_nera = $1, consentimento_nera_em = now() WHERE id = $2`,
      [autorizou, p.id]
    );

    await db.query(
      `INSERT INTO log_auditoria (admin_nome_snapshot, acao, alvo) VALUES ($1, $2, $3)`,
      [p.nome, autorizou ? "Autorizou contato comercial da Nera" : "Não autorizou contato comercial da Nera", p.email]
    );

    return http.ok({ mensagem: "Preferência registrada." });
  } catch (err) {
    return http.serverError(err);
  }
}

module.exports = { painel, registrarConsentimentoNera };
