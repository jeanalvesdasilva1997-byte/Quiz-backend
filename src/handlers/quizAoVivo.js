// =====================================================================
// handlers/quizAoVivo.js — Quiz ao vivo conduzido pelo admin/tutor
// =====================================================================
// Uma pergunta ativa por vez, para a turma toda (estilo Kahoot) — o
// estado mora em turmas (quiz_fase, quiz_estado, quiz_indice_atual,
// quiz_questao_id, quiz_iniciada_em), não mais por participante.
//
// Fase 1: perguntas conduzidas durante a apresentação do conteúdo.
// Fase 2: as mesmas perguntas, liberadas manualmente pelo admin depois
// que o conteúdo termina, para validar retenção. Pódio 1 = ranking da
// Fase 1; Pódio 2 (final) = ranking da Fase 2 — cada fase é ranqueada
// isoladamente, a pontuação somada das duas fases não é relevante.
// =====================================================================

const db = require("../lib/db");
const http = require("../lib/http");
const sessao = require("../lib/sessao");
const gam = require("../lib/gamificacao");

async function buscarTurma(turmaId) {
  const res = await db.query(
    `SELECT id, nome, status, data_evento, quiz_fase, quiz_estado, quiz_indice_atual, quiz_questao_id, quiz_iniciada_em,
            podio1_liberado, podio2_liberado
     FROM turmas WHERE id = $1`,
    [turmaId]
  );
  return res.rows[0] || null;
}

// Fase 2 "cada um no seu ritmo" (22/09) — sem host, ver gamificacao.js.
// Independe de turma.quiz_estado/quiz_questao_id (que ficam inertes
// nesse modo); cada participante progride pela lista conforme o que já
// respondeu em respostas (fase = 2).
async function proximaQuestaoFase2(participanteId) {
  const lista = await gam.listaFlatDeQuestoes();
  const respondidasRes = await db.query(
    `SELECT questao_id FROM respostas WHERE participante_id = $1 AND fase = 2`,
    [participanteId]
  );
  const respondidas = new Set(respondidasRes.rows.map((r) => r.questao_id));
  return lista.find((q) => !respondidas.has(q.id)) || null;
}

// =====================================================================
// ADMIN — condução ao vivo
// =====================================================================

// GET /admin/turmas/:id/quiz
async function estadoAoVivo(event) {
  try {
    const admin = await sessao.adminAutenticado(event);
    if (!admin) return http.unauthorized();

    const turmaId = event.pathParameters && event.pathParameters.id;
    const turma = await buscarTurma(turmaId);
    if (!turma) return http.notFound("Turma não encontrada.");

    const lista = await gam.listaFlatDeQuestoes();
    const totalPerguntas = lista.length;

    if (turma.quiz_fase === 2) {
      const totalParticipantesRes = await db.query(`SELECT COUNT(*)::int AS total FROM participantes WHERE turma_id = $1`, [turmaId]);
      const progressoRes = await db.query(
        `SELECT participante_id, COUNT(*)::int AS respondidas FROM respostas
         WHERE fase = 2 AND participante_id IN (SELECT id FROM participantes WHERE turma_id = $1)
         GROUP BY participante_id`,
        [turmaId]
      );
      const emAndamento = progressoRes.rows.filter((r) => r.respondidas > 0 && r.respondidas < totalPerguntas).length;
      const concluidos = progressoRes.rows.filter((r) => r.respondidas >= totalPerguntas).length;

      return http.ok({
        turma: { id: turma.id, nome: turma.nome, status: turma.status },
        fase: 2,
        modoAutoPaced: true,
        prazo: gam.prazoFase2(turma.data_evento).toISOString(),
        totalPerguntas,
        totalParticipantes: totalParticipantesRes.rows[0].total,
        emAndamento,
        concluidos,
        podio2Liberado: turma.podio2_liberado,
      });
    }

    let questaoAtual = null;
    let respostas = { responderam: 0, corretas: 0 };
    if (turma.quiz_estado === "pergunta_ativa" && turma.quiz_questao_id) {
      const q = lista[turma.quiz_indice_atual];
      if (q) {
        const semente = gam.semeadorAtivacao(turmaId, turma.quiz_questao_id, turma.quiz_iniciada_em);
        const ordem = gam.ordemAlternativas(q.alternativas.length, semente);
        questaoAtual = {
          id: q.id,
          topico: q.topico,
          cenario: q.cenario,
          pergunta: q.pergunta,
          alternativas: ordem.map((i) => q.alternativas[i]),
          correta: ordem.indexOf(q.correta), // visão do host — já na ordem exibida, só aqui é liberado
        };
      }

      const contagem = await db.query(
        `SELECT COUNT(*)::int AS responderam, COUNT(*) FILTER (WHERE correta)::int AS corretas
         FROM respostas WHERE questao_id = $1 AND fase = $2
           AND participante_id IN (SELECT id FROM participantes WHERE turma_id = $3)`,
        [turma.quiz_questao_id, turma.quiz_fase, turmaId]
      );
      respostas = contagem.rows[0];
    }

    const totalParticipantesRes = await db.query(`SELECT COUNT(*)::int AS total FROM participantes WHERE turma_id = $1`, [turmaId]);

    return http.ok({
      turma: { id: turma.id, nome: turma.nome, status: turma.status },
      fase: turma.quiz_fase,
      quizEstado: turma.quiz_estado,
      indiceAtual: turma.quiz_indice_atual,
      totalPerguntas,
      questaoAtual,
      iniciadaEm: turma.quiz_iniciada_em,
      tempoLimiteSegundos: gam.tempoLimiteSegundos(turma.quiz_fase),
      totalParticipantes: totalParticipantesRes.rows[0].total,
      responderam: respostas.responderam,
      corretas: respostas.corretas,
      podio1Liberado: turma.podio1_liberado,
      podio2Liberado: turma.podio2_liberado,
    });
  } catch (err) {
    return http.serverError(err);
  }
}

// POST /admin/turmas/:id/quiz/iniciar-fase1
// Apesar do nome (legado), funciona pra iniciar a fase que a turma já
// estiver marcada (quiz_fase) — normalmente 0 (vira 1, fluxo padrão),
// mas também aceita turmas preparadas direto na Fase 2 (ex: quando a
// Fase 1 é pulada por decisão operacional), sem forçar fase 1.
async function iniciarFase1(event) {
  try {
    const admin = await sessao.adminAutenticado(event);
    if (!admin) return http.unauthorized();

    const turmaId = event.pathParameters && event.pathParameters.id;
    const turma = await buscarTurma(turmaId);
    if (!turma) return http.notFound("Turma não encontrada.");
    if (turma.status !== "ativa") return http.conflict("A turma precisa estar Ativa para iniciar o quiz.");
    if (turma.quiz_estado !== "aguardando") return http.conflict("O quiz já foi iniciado para esta turma.");

    const lista = await gam.listaFlatDeQuestoes();
    if (lista.length === 0) return http.conflict("Não há perguntas cadastradas.");

    const faseAlvo = turma.quiz_fase === 0 ? 1 : turma.quiz_fase;

    const res = await db.query(
      `UPDATE turmas SET quiz_fase = $1, quiz_estado = 'pergunta_ativa', quiz_indice_atual = 0,
              quiz_questao_id = $2, quiz_iniciada_em = now()
       WHERE id = $3 RETURNING quiz_fase, quiz_estado, quiz_indice_atual, quiz_iniciada_em`,
      [faseAlvo, lista[0].id, turmaId]
    );

    await db.query(`INSERT INTO log_auditoria (admin_id, admin_nome_snapshot, acao, alvo) VALUES ($1, $2, $3, $4)`, [
      admin.admin_id, admin.nome, `Iniciou a Fase ${faseAlvo} do quiz ao vivo`, turma.nome,
    ]);

    return http.ok({ turma: res.rows[0] });
  } catch (err) {
    return http.serverError(err);
  }
}

// POST /admin/turmas/:id/quiz/proxima
async function proximaPergunta(event) {
  try {
    const admin = await sessao.adminAutenticado(event);
    if (!admin) return http.unauthorized();

    const turmaId = event.pathParameters && event.pathParameters.id;
    const turma = await buscarTurma(turmaId);
    if (!turma) return http.notFound("Turma não encontrada.");
    if (turma.status !== "ativa") return http.conflict("A turma está encerrada — não é mais possível conduzir o quiz.");
    if (turma.quiz_estado !== "pergunta_ativa") return http.conflict("Não há pergunta ativa para avançar.");

    const lista = await gam.listaFlatDeQuestoes();
    const proximoIndice = turma.quiz_indice_atual + 1;

    if (proximoIndice < lista.length) {
      const res = await db.query(
        `UPDATE turmas SET quiz_indice_atual = $1, quiz_questao_id = $2, quiz_iniciada_em = now()
         WHERE id = $3 RETURNING quiz_fase, quiz_estado, quiz_indice_atual, quiz_iniciada_em`,
        [proximoIndice, lista[proximoIndice].id, turmaId]
      );
      return http.ok({ turma: res.rows[0] });
    }

    const novoEstado = turma.quiz_fase === 1 ? "fase1_concluida" : "fase2_concluida";
    const res = await db.query(
      `UPDATE turmas SET quiz_estado = $1, quiz_questao_id = NULL, quiz_iniciada_em = NULL
       WHERE id = $2 RETURNING quiz_fase, quiz_estado, quiz_indice_atual`,
      [novoEstado, turmaId]
    );

    if (novoEstado === "fase2_concluida") {
      await db.query(`UPDATE participantes SET status = 'concluido' WHERE turma_id = $1`, [turmaId]);
    }

    await db.query(`INSERT INTO log_auditoria (admin_id, admin_nome_snapshot, acao, alvo) VALUES ($1, $2, $3, $4)`, [
      admin.admin_id, admin.nome, `Concluiu a ${turma.quiz_fase === 1 ? "Fase 1" : "Fase 2"} do quiz ao vivo`, turma.nome,
    ]);

    return http.ok({ turma: res.rows[0] });
  } catch (err) {
    return http.serverError(err);
  }
}

// POST /admin/turmas/:id/quiz/liberar-fase2
async function liberarFase2(event) {
  try {
    const admin = await sessao.adminAutenticado(event);
    if (!admin) return http.unauthorized();

    const turmaId = event.pathParameters && event.pathParameters.id;
    const turma = await buscarTurma(turmaId);
    if (!turma) return http.notFound("Turma não encontrada.");
    if (turma.status !== "ativa") return http.conflict("A turma está encerrada — não é mais possível conduzir o quiz.");
    if (turma.quiz_estado !== "fase1_concluida") return http.conflict("A Fase 1 ainda não foi concluída.");

    const lista = await gam.listaFlatDeQuestoes();
    if (lista.length === 0) return http.conflict("Não há perguntas cadastradas.");

    const res = await db.withTransaction(async (client) => {
      await client.query(`UPDATE participantes SET streak_fase = 0 WHERE turma_id = $1`, [turmaId]);
      return client.query(
        `UPDATE turmas SET quiz_fase = 2, quiz_estado = 'pergunta_ativa', quiz_indice_atual = 0,
                quiz_questao_id = $1, quiz_iniciada_em = now()
         WHERE id = $2 RETURNING quiz_fase, quiz_estado, quiz_indice_atual, quiz_iniciada_em`,
        [lista[0].id, turmaId]
      );
    });

    await db.query(`INSERT INTO log_auditoria (admin_id, admin_nome_snapshot, acao, alvo) VALUES ($1, $2, $3, $4)`, [
      admin.admin_id, admin.nome, "Liberou a Fase 2 do quiz ao vivo (pós-conteúdo)", turma.nome,
    ]);

    return http.ok({ turma: res.rows[0] });
  } catch (err) {
    return http.serverError(err);
  }
}

// POST /admin/turmas/:id/quiz/liberar-podio1
// O pódio da Fase 1 só aparece pro participante depois que o admin libera
// explicitamente — mesmo com a fase já concluída para todo mundo, ninguém
// vê o resultado até esse clique (evita alguém ver antes da hora certa,
// ex: enquanto o tutor ainda está comentando os acertos ao vivo).
async function liberarPodio1(event) {
  try {
    const admin = await sessao.adminAutenticado(event);
    if (!admin) return http.unauthorized();

    const turmaId = event.pathParameters && event.pathParameters.id;
    const turma = await buscarTurma(turmaId);
    if (!turma) return http.notFound("Turma não encontrada.");
    if (turma.quiz_estado !== "fase1_concluida") return http.conflict("A Fase 1 ainda não foi concluída.");

    const res = await db.query(`UPDATE turmas SET podio1_liberado = TRUE WHERE id = $1 RETURNING podio1_liberado`, [turmaId]);

    await db.query(`INSERT INTO log_auditoria (admin_id, admin_nome_snapshot, acao, alvo) VALUES ($1, $2, $3, $4)`, [
      admin.admin_id, admin.nome, "Liberou o pódio da Fase 1", turma.nome,
    ]);

    return http.ok({ podio1Liberado: res.rows[0].podio1_liberado });
  } catch (err) {
    return http.serverError(err);
  }
}

// POST /admin/turmas/:id/quiz/liberar-podio2
async function liberarPodio2(event) {
  try {
    const admin = await sessao.adminAutenticado(event);
    if (!admin) return http.unauthorized();

    const turmaId = event.pathParameters && event.pathParameters.id;
    const turma = await buscarTurma(turmaId);
    if (!turma) return http.notFound("Turma não encontrada.");
    if (turma.quiz_estado !== "fase2_concluida") return http.conflict("A Fase 2 ainda não foi concluída.");

    const res = await db.query(`UPDATE turmas SET podio2_liberado = TRUE WHERE id = $1 RETURNING podio2_liberado`, [turmaId]);

    await db.query(`INSERT INTO log_auditoria (admin_id, admin_nome_snapshot, acao, alvo) VALUES ($1, $2, $3, $4)`, [
      admin.admin_id, admin.nome, "Liberou o pódio final (Fase 2)", turma.nome,
    ]);

    return http.ok({ podio2Liberado: res.rows[0].podio2_liberado });
  } catch (err) {
    return http.serverError(err);
  }
}

// =====================================================================
// PARTICIPANTE
// =====================================================================

// GET /participante/quiz-estado
async function estadoParticipante(event) {
  try {
    const p = await sessao.participanteAutenticado(event);
    if (!p) {
      return sessao.participanteTinhaCookie(event)
        ? http.forbidden("Sua sessão foi encerrada.", { acessoExpirado: true })
        : http.unauthorized();
    }

    const turma = await buscarTurma(p.turma_id);
    if (!turma) return http.notFound("Turma não encontrada.");

    if (turma.quiz_fase === 2) {
      const prazo = gam.prazoFase2(turma.data_evento);
      const prazoEncerrado = Date.now() > prazo.getTime();
      const proxima = await proximaQuestaoFase2(p.id);

      let questaoFase2 = null;
      let quizEstadoFase2;
      if (!proxima) {
        quizEstadoFase2 = "fase2_concluida";
      } else if (prazoEncerrado) {
        quizEstadoFase2 = "prazo_encerrado";
      } else {
        quizEstadoFase2 = "pergunta_ativa";
        const ordem = gam.ordemAlternativas(proxima.alternativas.length, `${p.id}:${proxima.id}`);
        questaoFase2 = {
          id: proxima.id,
          topico: proxima.topico,
          cenario: proxima.cenario,
          pergunta: proxima.pergunta,
          alternativas: ordem.map((i) => proxima.alternativas[i]),
        };
      }

      return http.ok({
        fase: 2,
        modoAutoPaced: true,
        quizEstado: quizEstadoFase2,
        questao: questaoFase2,
        prazo: prazo.toISOString(),
        jaRespondida: false,
      });
    }

    let questao = null;
    let jaRespondida = false;
    if (turma.quiz_estado === "pergunta_ativa" && turma.quiz_questao_id) {
      const qRes = await db.query(
        `SELECT id, topico, cenario, pergunta, alternativas FROM questoes WHERE id = $1`,
        [turma.quiz_questao_id]
      );
      if (qRes.rows[0]) {
        const q = qRes.rows[0];
        const semente = gam.semeadorAtivacao(turma.id, turma.quiz_questao_id, turma.quiz_iniciada_em);
        const ordem = gam.ordemAlternativas(q.alternativas.length, semente);
        questao = { ...q, alternativas: ordem.map((i) => q.alternativas[i]) };
      }

      const respondidaRes = await db.query(
        `SELECT 1 FROM respostas WHERE participante_id = $1 AND questao_id = $2 AND fase = $3`,
        [p.id, turma.quiz_questao_id, turma.quiz_fase]
      );
      jaRespondida = respondidaRes.rows.length > 0;
    }

    return http.ok({
      fase: turma.quiz_fase,
      quizEstado: turma.quiz_estado,
      questao,
      iniciadaEm: turma.quiz_iniciada_em,
      tempoLimiteSegundos: gam.tempoLimiteSegundos(turma.quiz_fase),
      jaRespondida,
    });
  } catch (err) {
    return http.serverError(err);
  }
}

// Fase 2 "cada um no seu ritmo" — sem cronômetro por pergunta; o corte é
// o prazo geral (gam.prazoFase2). Ignora turma.quiz_questao_id (não
// existe pergunta "ativa" compartilhada nesse modo).
async function responderFase2AutoPaced(turma, p, questaoId, alternativaSelecionada) {
  const prazo = gam.prazoFase2(turma.data_evento);
  if (Date.now() > prazo.getTime()) return http.conflict("O prazo para responder já encerrou.");

  const jaRespondida = await db.query(
    `SELECT 1 FROM respostas WHERE participante_id = $1 AND questao_id = $2 AND fase = 2`,
    [p.id, questaoId]
  );
  if (jaRespondida.rows.length > 0) return http.conflict("Você já respondeu esta pergunta.");

  const questaoRes = await db.query(`SELECT alternativas, correta FROM questoes WHERE id = $1`, [questaoId]);
  if (questaoRes.rows.length === 0) return http.notFound("Questão não encontrada.");
  const { alternativas, correta: indiceCorreto } = questaoRes.rows[0];

  const ordem = gam.ordemAlternativas(alternativas.length, `${p.id}:${questaoId}`);
  const alternativaOriginal = ordem[Number(alternativaSelecionada)];
  const acertou = alternativaOriginal === indiceCorreto;
  const { pontos, novoStreak } = gam.calcularPontuacao(p.streak_fase, acertou);
  const melhorStreak = Math.max(p.melhor_streak, novoStreak);

  await db.withTransaction(async (client) => {
    await client.query(
      `INSERT INTO respostas (participante_id, questao_id, fase, alternativa_selecionada, correta, pontos, streak_no_momento, tempo_esgotado)
       VALUES ($1, $2, 2, $3, $4, $5, $6, FALSE)`,
      [p.id, questaoId, alternativaOriginal, acertou, pontos, novoStreak]
    );
    await client.query(
      `UPDATE participantes SET xp_fase2 = xp_fase2 + $1, streak_fase = $2, melhor_streak = $3, status = 'em_curso' WHERE id = $4`,
      [pontos, novoStreak, melhorStreak, p.id]
    );
  });

  const restam = await proximaQuestaoFase2(p.id);
  if (!restam) {
    await db.query(`UPDATE participantes SET status = 'concluido' WHERE id = $1`, [p.id]);
  }

  return http.ok({ resultado: acertou ? "correto" : "incorreto", pontosGanhos: pontos });
}

// POST /participante/responder   { questaoId, alternativaSelecionada }
async function responder(event) {
  try {
    const p = await sessao.participanteAutenticado(event);
    if (!p) {
      return sessao.participanteTinhaCookie(event)
        ? http.forbidden("Sua sessão foi encerrada.", { acessoExpirado: true })
        : http.unauthorized();
    }

    const { questaoId, alternativaSelecionada } = JSON.parse(event.body || "{}");

    const turma = await buscarTurma(p.turma_id);
    if (!turma) return http.notFound("Turma não encontrada.");
    if (turma.status !== "ativa") return http.conflict("A turma foi encerrada — não é mais possível responder.");

    if (turma.quiz_fase === 2) {
      return responderFase2AutoPaced(turma, p, questaoId, alternativaSelecionada);
    }

    if (turma.quiz_estado !== "pergunta_ativa" || turma.quiz_questao_id !== questaoId) {
      return http.conflict("Esta não é a pergunta ativa no momento.");
    }

    const jaRespondida = await db.query(
      `SELECT 1 FROM respostas WHERE participante_id = $1 AND questao_id = $2 AND fase = $3`,
      [p.id, questaoId, turma.quiz_fase]
    );
    if (jaRespondida.rows.length > 0) return http.conflict("Você já respondeu esta pergunta.");

    const estourou = gam.tempoEstourado(turma.quiz_iniciada_em, turma.quiz_fase);

    const questaoRes = await db.query(`SELECT alternativas, correta FROM questoes WHERE id = $1`, [questaoId]);
    if (questaoRes.rows.length === 0) return http.notFound("Questão não encontrada.");
    const { alternativas, correta: indiceCorreto } = questaoRes.rows[0];

    // alternativaSelecionada veio na ordem embaralhada que o participante
    // viu na tela — precisa voltar pro índice original (o mesmo que
    // questoes.correta usa) antes de comparar e de gravar em respostas,
    // senão a correção fica errada e o histórico vira refém da ordem
    // daquela rodada específica.
    const semente = gam.semeadorAtivacao(turma.id, questaoId, turma.quiz_iniciada_em);
    const ordem = gam.ordemAlternativas(alternativas.length, semente);
    const alternativaOriginal = estourou ? null : ordem[Number(alternativaSelecionada)];

    const acertou = !estourou && alternativaOriginal === indiceCorreto;
    const { pontos, novoStreak } = gam.calcularPontuacao(p.streak_fase, acertou);
    const melhorStreak = Math.max(p.melhor_streak, novoStreak);
    const colunaXp = turma.quiz_fase === 1 ? "xp_fase1" : "xp_fase2";

    await db.withTransaction(async (client) => {
      await client.query(
        `INSERT INTO respostas (participante_id, questao_id, fase, alternativa_selecionada, correta, pontos, streak_no_momento, tempo_esgotado)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [p.id, questaoId, turma.quiz_fase, alternativaOriginal, acertou, pontos, novoStreak, estourou]
      );
      await client.query(
        `UPDATE participantes
         SET ${colunaXp} = ${colunaXp} + $1, streak_fase = $2, melhor_streak = $3
         WHERE id = $4`,
        [pontos, novoStreak, melhorStreak, p.id]
      );
    });

    return http.ok({
      resultado: estourou ? "tempo_esgotado" : acertou ? "correto" : "incorreto",
      pontosGanhos: pontos,
    });
  } catch (err) {
    return http.serverError(err);
  }
}

module.exports = { estadoAoVivo, iniciarFase1, proximaPergunta, liberarFase2, liberarPodio1, liberarPodio2, estadoParticipante, responder };
