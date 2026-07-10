// =====================================================================
// handlers/turmas.js — Turmas: listar (com filtro), criar via upload
// =====================================================================

const db = require("../lib/db");
const http = require("../lib/http");
const sessao = require("../lib/sessao");

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// GET /admin/turmas?status=ativa   (status é opcional — Todas / Ativa / Agendada / Encerrada)
async function listar(event) {
  try {
    const admin = await sessao.adminAutenticado(event);
    if (!admin) return http.unauthorized();

    const status = event.queryStringParameters && event.queryStringParameters.status;
    const params = [];
    let where = "";
    if (status && ["agendada", "ativa", "encerrada"].includes(status)) {
      where = "WHERE t.status = $1";
      params.push(status);
    }

    const res = await db.query(
      `SELECT t.id, t.nome, t.data_evento, t.status,
              COUNT(p.id) AS participantes,
              COUNT(DISTINCT p.empresa) AS empresas
       FROM turmas t
       LEFT JOIN participantes p ON p.turma_id = t.id
       ${where}
       GROUP BY t.id
       ORDER BY t.data_evento DESC`,
      params
    );

    return http.ok({ turmas: res.rows });
  } catch (err) {
    return http.serverError(err);
  }
}

// POST /admin/turmas/conferir   { linhas: [{nome, email, empresa, cnpj}] }
// Só valida — não grava nada ainda. É o passo de "conferência" antes de confirmar.
async function conferir(event) {
  try {
    const admin = await sessao.adminAutenticado(event);
    if (!admin) return http.unauthorized();

    const { linhas } = JSON.parse(event.body || "{}");
    if (!Array.isArray(linhas)) return http.badRequest("Formato inválido.");

    const validos = [];
    const erros = [];
    const vistos = new Set();

    linhas.forEach((linha, idx) => {
      const nome = (linha.nome || "").trim();
      const emailLinha = (linha.email || "").trim();
      const empresa = (linha.empresa || "").trim();
      const cnpj = (linha.cnpj || "").trim();

      if (!nome || !EMAIL_REGEX.test(emailLinha)) {
        erros.push({ linha: idx + 1, nome, email: emailLinha, motivo: !EMAIL_REGEX.test(emailLinha) ? "e-mail inválido" : "linha incompleta" });
        return;
      }
      const chave = emailLinha.toLowerCase();
      if (vistos.has(chave)) {
        erros.push({ linha: idx + 1, nome, email: emailLinha, motivo: "e-mail duplicado" });
        return;
      }
      vistos.add(chave);
      validos.push({ nome, email: emailLinha, empresa: empresa || null, cnpj: cnpj || null });
    });

    return http.ok({ validos, erros });
  } catch (err) {
    return http.serverError(err);
  }
}

// POST /admin/turmas   { nome, dataEvento, participantes: [...] }
// Confirma a turma depois da conferência — tudo em uma transação.
async function criar(event) {
  try {
    const admin = await sessao.adminAutenticado(event);
    if (!admin) return http.unauthorized();

    const { nome, dataEvento, participantes } = JSON.parse(event.body || "{}");
    if (!nome || !dataEvento) return http.badRequest("Informe nome e data da turma.");

    const turma = await db.withTransaction(async (client) => {
      const turmaRes = await client.query(
        `INSERT INTO turmas (nome, data_evento, status, criada_por) VALUES ($1, $2, 'agendada', $3) RETURNING *`,
        [nome, dataEvento, admin.admin_id]
      );
      const novaTurma = turmaRes.rows[0];

      for (const p of participantes || []) {
        await client.query(
          `INSERT INTO participantes (turma_id, nome, email, empresa, cnpj, origem, status)
           VALUES ($1, $2, $3, $4, $5, 'lista', 'nao_iniciado')`,
          [novaTurma.id, p.nome, p.email, p.empresa, p.cnpj]
        );
      }
      return novaTurma;
    });

    await db.query(`INSERT INTO log_auditoria (admin_id, admin_nome_snapshot, acao, alvo) VALUES ($1, $2, $3, $4)`, [
      admin.admin_id, admin.nome, "Criou turma via upload de lista", nome,
    ]);

    return http.created({ turma });
  } catch (err) {
    return http.serverError(err);
  }
}

module.exports = { listar, conferir, criar };
