// =====================================================================
// lib/gamificacao.js — Regras de pontuação, streak e a lista de perguntas
// =====================================================================
// Quiz ao vivo, conduzido pelo admin/tutor: uma pergunta ativa por vez
// para a turma toda (não é mais por participante). A "lista flat" abaixo
// define a ordem 0..N-1 usada em turmas.quiz_indice_atual — dinâmica,
// então não há número de perguntas fixo no código.
// =====================================================================

const db = require("./db");

const TEMPO_LIMITE_SEGUNDOS = 60; // autoridade do servidor, por pergunta

async function contarModulos() {
  const res = await db.query(`SELECT COUNT(*)::int AS total FROM modulos`);
  return res.rows[0].total;
}

// Ordem canônica das perguntas do quiz — o índice desse array (0, 1, 2...)
// é o que turmas.quiz_indice_atual referencia.
async function listaFlatDeQuestoes() {
  const res = await db.query(
    `SELECT id, modulo_id, ordem, topico, cenario, pergunta, alternativas, correta, explicacao
     FROM questoes ORDER BY modulo_id, ordem`
  );
  return res.rows;
}

// Pontuação por streak: 1º acerto = 100, 2º consecutivo = 150,
// 3º ou mais consecutivos = 200 (teto). Erro/timeout = 0 e reinicia o streak.
function calcularPontuacao(streakAnterior, acertou) {
  if (!acertou) return { pontos: 0, novoStreak: 0 };
  const novoStreak = streakAnterior + 1;
  const pontos = novoStreak >= 3 ? 200 : novoStreak === 2 ? 150 : 100;
  return { pontos, novoStreak };
}

// Verifica se o prazo da pergunta ao vivo estourou, comparando com o
// relógio do servidor — nunca confiando em nada vindo do cliente.
function tempoEstourado(quizIniciadaEm) {
  if (!quizIniciadaEm) return true;
  const decorridoMs = Date.now() - new Date(quizIniciadaEm).getTime();
  return decorridoMs / 1000 >= TEMPO_LIMITE_SEGUNDOS;
}

module.exports = {
  TEMPO_LIMITE_SEGUNDOS,
  contarModulos,
  listaFlatDeQuestoes,
  calcularPontuacao,
  tempoEstourado,
};
