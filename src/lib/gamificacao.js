// =====================================================================
// lib/gamificacao.js — Regras de pontuação, streak e a lista de perguntas
// =====================================================================
// Quiz ao vivo, conduzido pelo admin/tutor: uma pergunta ativa por vez
// para a turma toda (não é mais por participante). A "lista flat" abaixo
// define a ordem 0..N-1 usada em turmas.quiz_indice_atual — dinâmica,
// então não há número de perguntas fixo no código.
// =====================================================================

const db = require("./db");

// Autoridade do servidor, por pergunta — Fase 2 tem mais tempo que a Fase 1
// (mesmas perguntas, mas respondidas sem o apoio da apresentação ao vivo).
const TEMPO_LIMITE_FASE1_SEGUNDOS = 60;
const TEMPO_LIMITE_FASE2_SEGUNDOS = 120;

function tempoLimiteSegundos(fase) {
  return fase === 2 ? TEMPO_LIMITE_FASE2_SEGUNDOS : TEMPO_LIMITE_FASE1_SEGUNDOS;
}

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
function tempoEstourado(quizIniciadaEm, fase) {
  if (!quizIniciadaEm) return true;
  const decorridoMs = Date.now() - new Date(quizIniciadaEm).getTime();
  return decorridoMs / 1000 >= tempoLimiteSegundos(fase);
}

// =====================================================================
// Ordem embaralhada das alternativas — pra quem responde numa segunda
// rodada não conseguir só colar a letra que alguém postou no chat.
//
// Não guarda nada novo no banco: a ordem é derivada de forma
// determinística de (turma, pergunta, momento em que essa pergunta foi
// ativada). Isso dá duas propriedades ao mesmo tempo:
//   - Todo mundo vendo a MESMA ativação da pergunta vê a MESMA ordem
//     (senão a letra "B" significaria coisas diferentes pra cada um e a
//     correção quebraria).
//   - A MESMA pergunta ativada de novo depois (segunda rodada) recebe
//     outra ordem, porque quiz_iniciada_em muda — a resposta "B" da
//     primeira rodada não serve mais de cola.
// =====================================================================

function hashSemente(texto) {
  let h = 2166136261 >>> 0; // FNV-1a
  for (let i = 0; i < texto.length; i++) {
    h ^= texto.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pseudoAleatorio(semente) {
  let a = semente;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function semeadorAtivacao(turmaId, questaoId, iniciadaEm) {
  const carimbo = iniciadaEm instanceof Date ? iniciadaEm.toISOString() : String(iniciadaEm);
  return `${turmaId}:${questaoId}:${carimbo}`;
}

// Retorna um array de tamanho N: ordem[posiçãoExibida] = índiceOriginal.
function ordemAlternativas(tamanho, semente) {
  const rand = pseudoAleatorio(hashSemente(semente));
  const ordem = Array.from({ length: tamanho }, (_, i) => i);
  for (let i = ordem.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [ordem[i], ordem[j]] = [ordem[j], ordem[i]];
  }
  return ordem;
}

// =====================================================================
// Fase 2 "cada um no seu ritmo" (22/09) — sem host, sem pergunta única
// pra turma toda: cada participante avança sozinho pela lista, na hora
// que quiser, até o prazo abaixo. Prazo = 23:59:59 do dia de
// turmas.data_evento, no horário de Brasília (UTC-3, fixo — sem horário
// de verão desde 2019).
// =====================================================================
function prazoFase2(dataEvento) {
  const d = new Date(dataEvento);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23 + 3, 59, 59));
}

module.exports = {
  TEMPO_LIMITE_FASE1_SEGUNDOS,
  TEMPO_LIMITE_FASE2_SEGUNDOS,
  tempoLimiteSegundos,
  contarModulos,
  listaFlatDeQuestoes,
  calcularPontuacao,
  tempoEstourado,
  semeadorAtivacao,
  ordemAlternativas,
  prazoFase2,
};
