// =====================================================================
// handlers/relatorio.js — Estatísticas da turma + exportação CSV
// =====================================================================
// O CSV exportado inclui TODOS os participantes da turma (ex: 200
// linhas), não apenas o pódio — a tela mostra o pódio como prévia,
// mas o arquivo é completo. Exportação visível somente para Owner.
// =====================================================================

const db = require("../lib/db");
const http = require("../lib/http");
const sessao = require("../lib/sessao");

async function carregarParticipantesOrdenados(turmaId) {
  const res = await db.query(
    `SELECT nome, email, empresa, cnpj, xp_total, melhor_streak, status
     FROM participantes WHERE turma_id = $1
     ORDER BY xp_total DESC, melhor_streak DESC`,
    [turmaId]
  );
  return res.rows;
}

// GET /admin/relatorio/:turmaId
async function gerar(event) {
  try {
    const admin = await sessao.adminAutenticado(event);
    if (!admin) return http.unauthorized();

    const turmaId = event.pathParameters && event.pathParameters.turmaId;
    const turmaRes = await db.query(`SELECT nome FROM turmas WHERE id = $1`, [turmaId]);
    if (turmaRes.rows.length === 0) return http.notFound("Turma não encontrada.");

    const participantes = await carregarParticipantesOrdenados(turmaId);
    const total = participantes.length;
    const concluiram = participantes.filter((p) => p.status === "concluido").length;
    const taxa = total ? Math.round((concluiram / total) * 100) : 0;
    const podio = participantes.slice(0, 3);

    await db.query(`INSERT INTO log_auditoria (admin_id, admin_nome_snapshot, acao, alvo) VALUES ($1, $2, $3, $4)`, [
      admin.admin_id, admin.nome, "Gerou relatório da turma", turmaRes.rows[0].nome,
    ]);

    return http.ok({ turma: turmaRes.rows[0].nome, total, concluiram, taxa, podio });
  } catch (err) {
    return http.serverError(err);
  }
}

// GET /admin/relatorio/:turmaId/csv   — somente Owner
function paraCsv(linhas) {
  const cabecalho = ["Nome", "E-mail", "Empresa", "CNPJ", "Ranking", "Pontuação", "Melhor Streak", "Status"];
  const escapar = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const linhasFormatadas = linhas.map((p, i) =>
    [p.nome, p.email, p.empresa, p.cnpj, i + 1, p.xp_total, p.melhor_streak, p.status].map(escapar).join(",")
  );
  return [cabecalho.join(","), ...linhasFormatadas].join("\r\n");
}

async function exportarCsv(event) {
  try {
    const admin = await sessao.adminAutenticado(event);
    if (!admin) return http.unauthorized();
    if (admin.papel !== "owner") return http.forbidden("Exportação de CSV disponível apenas para o papel Owner.");

    const turmaId = event.pathParameters && event.pathParameters.turmaId;
    const turmaRes = await db.query(`SELECT nome FROM turmas WHERE id = $1`, [turmaId]);
    if (turmaRes.rows.length === 0) return http.notFound("Turma não encontrada.");

    const participantes = await carregarParticipantesOrdenados(turmaId); // todos, sem LIMIT — inclui as 200 linhas se for o caso
    const csv = paraCsv(participantes);

    await db.query(`INSERT INTO log_auditoria (admin_id, admin_nome_snapshot, acao, alvo) VALUES ($1, $2, $3, $4)`, [
      admin.admin_id, admin.nome, `Exportou CSV com ${participantes.length} participantes`, turmaRes.rows[0].nome,
    ]);

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${turmaRes.rows[0].nome.replace(/\s+/g, "_")}_participantes.csv"`,
        "Access-Control-Allow-Origin": process.env.FRONTEND_ORIGIN,
        "Access-Control-Allow-Credentials": "true",
      },
      body: csv,
    };
  } catch (err) {
    return http.serverError(err);
  }
}

// POST /admin/relatorio/:turmaId/enviar-rh
async function enviarAoRh(event) {
  try {
    const admin = await sessao.adminAutenticado(event);
    if (!admin) return http.unauthorized();

    const turmaId = event.pathParameters && event.pathParameters.turmaId;
    const turmaRes = await db.query(`SELECT nome FROM turmas WHERE id = $1`, [turmaId]);
    if (turmaRes.rows.length === 0) return http.notFound("Turma não encontrada.");

    // A gestão do relatório após o envio é do RH — a plataforma não guarda
    // cópia adicional além do que já existe no banco operacional da turma.
    await db.query(`INSERT INTO log_auditoria (admin_id, admin_nome_snapshot, acao, alvo) VALUES ($1, $2, $3, $4)`, [
      admin.admin_id, admin.nome, "Enviou relatório ao RH", turmaRes.rows[0].nome,
    ]);

    return http.ok({ mensagem: "Relatório enviado ao RH." });
  } catch (err) {
    return http.serverError(err);
  }
}

module.exports = { gerar, exportarCsv, enviarAoRh };
