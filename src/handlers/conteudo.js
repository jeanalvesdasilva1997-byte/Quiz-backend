// =====================================================================
// handlers/conteudo.js — Módulos e questões: listar, criar, editar
// =====================================================================
// Edição/criação bloqueada enquanto existir qualquer turma "ativa"
// (janela crítica) — decisão explícita do time Nera, aplicada aqui
// como trava real, não só como combinado operacional.
// =====================================================================

const db = require("../lib/db");
const http = require("../lib/http");
const sessao = require("../lib/sessao");

async function existeTurmaAtiva() {
  const res = await db.query(`SELECT 1 FROM turmas WHERE status = 'ativa' LIMIT 1`);
  return res.rows.length > 0;
}

// GET /admin/conteudo
async function listar(event) {
  try {
    const admin = await sessao.adminAutenticado(event);
    if (!admin) return http.unauthorized();

    const res = await db.query(
      `SELECT q.*, m.nome AS modulo_nome FROM questoes q
       JOIN modulos m ON m.id = q.modulo_id
       ORDER BY q.modulo_id, q.ordem`
    );
    return http.ok({ questoes: res.rows, bloqueadoParaEdicao: await existeTurmaAtiva() });
  } catch (err) {
    return http.serverError(err);
  }
}

// POST /admin/conteudo   { moduloId, topico, cenario, pergunta, alternativas, correta }
async function criar(event) {
  try {
    const admin = await sessao.adminAutenticado(event);
    if (!admin) return http.unauthorized();
    if (await existeTurmaAtiva()) return http.forbidden("Edição bloqueada: existe turma com status Ativa.");

    const { moduloId, topico, cenario, pergunta, alternativas, correta, explicacao } = JSON.parse(event.body || "{}");
    if (!moduloId || !topico || !pergunta || !Array.isArray(alternativas) || alternativas.length < 2) {
      return http.badRequest("Preencha módulo, tópico, pergunta e ao menos 2 alternativas.");
    }
    if (correta == null || correta < 0 || correta >= alternativas.length) {
      return http.badRequest("Índice da alternativa correta é inválido.");
    }

    const ordemRes = await db.query(`SELECT COALESCE(MAX(ordem), -1) + 1 AS proxima FROM questoes WHERE modulo_id = $1`, [moduloId]);
    const proximaOrdem = ordemRes.rows[0].proxima;

    const res = await db.query(
      `INSERT INTO questoes (modulo_id, ordem, topico, cenario, pergunta, alternativas, correta, explicacao, criado_por)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [moduloId, proximaOrdem, topico, cenario || null, pergunta, JSON.stringify(alternativas), correta, explicacao || "", admin.admin_id]
    );

    await db.query(`INSERT INTO log_auditoria (admin_id, admin_nome_snapshot, acao, alvo) VALUES ($1, $2, $3, $4)`, [
      admin.admin_id, admin.nome, "Criou nova questão de conteúdo", topico,
    ]);

    return http.created({ questao: res.rows[0] });
  } catch (err) {
    return http.serverError(err);
  }
}

// PUT /admin/conteudo/:id   { pergunta, cenario, alternativas, correta }
async function editar(event) {
  try {
    const admin = await sessao.adminAutenticado(event);
    if (!admin) return http.unauthorized();
    if (await existeTurmaAtiva()) return http.forbidden("Edição bloqueada: existe turma com status Ativa.");

    const questaoId = event.pathParameters && event.pathParameters.id;
    const { pergunta, cenario, alternativas, correta, explicacao } = JSON.parse(event.body || "{}");

    const res = await db.query(
      `UPDATE questoes SET
         pergunta = COALESCE($1, pergunta),
         cenario = COALESCE($2, cenario),
         alternativas = COALESCE($3, alternativas),
         correta = COALESCE($4, correta),
         explicacao = COALESCE($5, explicacao),
         atualizado_em = now()
       WHERE id = $6 RETURNING *`,
      [pergunta, cenario, alternativas ? JSON.stringify(alternativas) : null, correta, explicacao, questaoId]
    );
    if (res.rows.length === 0) return http.notFound("Questão não encontrada.");

    await db.query(`INSERT INTO log_auditoria (admin_id, admin_nome_snapshot, acao, alvo) VALUES ($1, $2, $3, $4)`, [
      admin.admin_id, admin.nome, "Editou questão de conteúdo", res.rows[0].topico,
    ]);

    return http.ok({ questao: res.rows[0] });
  } catch (err) {
    return http.serverError(err);
  }
}

module.exports = { listar, criar, editar };
