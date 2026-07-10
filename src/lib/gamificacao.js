// =====================================================================
// lib/gamificacao.js — Regras de pontuação, streak e progresso
// =====================================================================
// Estas regras já foram validadas nos protótipos de front-end — aqui
// elas viram a versão que manda de verdade (autoridade do servidor).
// =====================================================================

const TOTAL_MODULOS = 3;
const QUESTOES_POR_MODULO = 5;
const TOTAL_QUESTOES = TOTAL_MODULOS * QUESTOES_POR_MODULO;
const TEMPO_LIMITE_SEGUNDOS = 5 * 60; // 5 minutos, autoridade do servidor

function moduloAtual(respondidas) {
  if (respondidas >= TOTAL_QUESTOES) return TOTAL_MODULOS;
  return Math.floor(respondidas / QUESTOES_POR_MODULO) + 1;
}

function posicaoNoModulo(respondidas) {
  return respondidas % QUESTOES_POR_MODULO;
}

function progressoPercentual(respondidas) {
  return Math.round((respondidas / TOTAL_QUESTOES) * 100);
}

// Pontuação por streak: 1º acerto = 100, 2º consecutivo = 150,
// 3º ou mais consecutivos = 200 (teto). Erro/timeout = 0 e reinicia o streak.
function calcularPontuacao(streakAnterior, acertou) {
  if (!acertou) return { pontos: 0, novoStreak: 0 };
  const novoStreak = streakAnterior + 1;
  const pontos = novoStreak >= 3 ? 200 : novoStreak === 2 ? 150 : 100;
  return { pontos, novoStreak };
}

// Verifica se o prazo da questão atual estourou, comparando com o
// relógio do servidor — nunca confiando em nada vindo do cliente.
function tempoEstourado(questaoIniciadaEm) {
  if (!questaoIniciadaEm) return false;
  const decorridoMs = Date.now() - new Date(questaoIniciadaEm).getTime();
  return decorridoMs / 1000 >= TEMPO_LIMITE_SEGUNDOS;
}

// O streak reinicia sempre que a resposta cruza a fronteira de um módulo,
// mesmo que a resposta que cruzou tenha sido um acerto (streak "novo"
// pertence ao próximo módulo, não carrega do anterior).
function streakAposResposta(respondidasAntes, respondidasDepois, streakCalculado) {
  const cruzouModulo = Math.floor(respondidasAntes / QUESTOES_POR_MODULO) !== Math.floor((respondidasDepois - 1) / QUESTOES_POR_MODULO);
  return respondidasDepois % QUESTOES_POR_MODULO === 0 ? 0 : streakCalculado;
}

module.exports = {
  TOTAL_MODULOS,
  QUESTOES_POR_MODULO,
  TOTAL_QUESTOES,
  TEMPO_LIMITE_SEGUNDOS,
  moduloAtual,
  posicaoNoModulo,
  progressoPercentual,
  calcularPontuacao,
  tempoEstourado,
  streakAposResposta,
};
