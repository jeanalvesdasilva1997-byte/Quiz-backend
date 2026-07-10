// =====================================================================
// handlers/participanteJornada.js — Painel, questão atual e resposta
// =====================================================================

const db = require("../lib/db");
const http = require("../lib/http");
const sessao = require("../lib/sessao");
const gam = require("../lib/gamificacao");

// GET /participante/painel
// Retorna o estado completo do participante — a mesma fonte que o
// admin usa no Monitoramento (nenhuma duplicação de lógica).
async function painel(event) {
  try {
    const p = await sessao.participanteAutenticado(event);
    if (!p) return http.unauthorized();

    return http.ok({
      nome: p.nome,
      empresa: p.empresa,
      xpTotal: p.xp_total,
      melhorStreak: p.melhor_streak,
      respondidas: p.respondidas,
      moduloAtual: gam.moduloAtual(p.respondidas),
      progresso: gam.progressoPercentual(p.respondidas),
      status: p.status,
    });
  } catch (err) {
    return http.serverError(err);
  }
}

// GET /participante/questao-atual
// Serve a próxima questão e registra o horário de início no servidor —
// é esse timestamp que decide o timeout, nunca o relógio do navegador.
async function questaoAtual(event) {
  try {
    const p = await sessao.participanteAutenticado(event);
    if (!p) return http.unauthorized();
    if (p.respondidas >= gam.TOTAL_QUESTOES) return http.conflict("Treinamento já concluído.");

    const modulo = gam.moduloAtual(p.respondidas);
    const posicao = gam.posicaoNoModulo(p.respondidas);

    const questaoRes = await db.query(
      `SELECT id, topico, cenario, pergunta, alternativas FROM questoes
       WHERE modulo_id = $1 AND ordem = $2 LIMIT 1`,
      [modulo, posicao]
    );
    if (questaoRes.rows.length === 0) return http.serverError(new Error(`Questão não encontrada: módulo ${modulo}, posição ${posicao}`));
    const questao = questaoRes.rows[0];

    const agora = new Date();
    await db.query(
      `UPDATE participantes SET questao_atual_id = $1, questao_iniciada_em = $2 WHERE id = $3`,
      [questao.id, agora, p.id]
    );

    return http.ok({
      questaoId: questao.id,
      modulo,
      posicao,
      topico: questao.topico,
      cenario: questao.cenario,
      pergunta: questao.pergunta,
      alternativas: questao.alternativas, // a alternativa correta NUNCA é enviada ao cliente
      iniciadaEm: agora.toISOString(),
      tempoLimiteSegundos: gam.TEMPO_LIMITE_SEGUNDOS,
    });
  } catch (err) {
    return http.serverError(err);
  }
}

// POST /participante/responder   { questaoId, alternativaSelecionada }
// alternativaSelecionada pode ser null, quando o próprio cliente detecta
// o estouro do timer local — mas o servidor recalcula o timeout de
// qualquer forma, então um cliente malicioso não ganha nada tentando
// mentir sobre isso.
async function responder(event) {
  try {
    const p = await sessao.participanteAutenticado(event);
    if (!p) return http.unauthorized();

    const { questaoId, alternativaSelecionada } = JSON.parse(event.body || "{}");
    if (!p.questao_atual_id || p.questao_atual_id !== questaoId) {
      return http.conflict("Esta não é a questão atual do participante.");
    }

    const estourou = gam.tempoEstourado(p.questao_iniciada_em);

    const questaoRes = await db.query(`SELECT correta, explicacao FROM questoes WHERE id = $1`, [questaoId]);
    if (questaoRes.rows.length === 0) return http.notFound("Questão não encontrada.");
    const { correta: indiceCorreto, explicacao } = questaoRes.rows[0];

    const acertou = !estourou && Number(alternativaSelecionada) === indiceCorreto;
    const { pontos, novoStreak: streakCalculado } = gam.calcularPontuacao(p.streak_modulo, acertou);

    const respondidasDepois = p.respondidas + 1;
    const streakFinal = gam.streakAposResposta(p.respondidas, respondidasDepois, streakCalculado);
    const melhorStreak = Math.max(p.melhor_streak, streakCalculado);
    const novoStatus = respondidasDepois >= gam.TOTAL_QUESTOES ? "concluido" : "em_curso";

    await db.withTransaction(async (client) => {
      await client.query(
        `INSERT INTO respostas (participante_id, questao_id, alternativa_selecionada, correta, pontos, streak_no_momento, tempo_esgotado)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [p.id, questaoId, estourou ? null : alternativaSelecionada, acertou, pontos, streakCalculado, estourou]
      );
      await client.query(
        `UPDATE participantes
         SET respondidas = $1, xp_total = xp_total + $2, streak_modulo = $3, melhor_streak = $4,
             status = $5, questao_atual_id = NULL, questao_iniciada_em = NULL
         WHERE id = $6`,
        [respondidasDepois, pontos, streakFinal, melhorStreak, novoStatus, p.id]
      );
    });

    return http.ok({
      resultado: estourou ? "tempo_esgotado" : acertou ? "correto" : "incorreto",
      pontosGanhos: pontos,
      streakAtual: streakFinal,
      xpTotal: p.xp_total + pontos,
      respondidas: respondidasDepois,
      moduloConcluido: respondidasDepois % gam.QUESTOES_POR_MODULO === 0,
      treinamentoConcluido: respondidasDepois >= gam.TOTAL_QUESTOES,
      alternativaCorreta: indiceCorreto, // liberado só depois de responder, para feedback
      explicacao: !acertou ? explicacao : null, // só enviado quando o participante erra
    });
  } catch (err) {
    return http.serverError(err);
  }
}

module.exports = { painel, questaoAtual, responder };
