// =====================================================================
// handlers/relatorio.js — Estatísticas da turma + exportação XLSX
// =====================================================================
// O XLSX exportado inclui TODOS os participantes da turma (ex: 200
// linhas), não apenas o pódio — a tela mostra o pódio como prévia,
// mas o arquivo é completo. Exportação visível somente para Owner.
// =====================================================================

const ExcelJS = require("exceljs");
const db = require("../lib/db");
const http = require("../lib/http");
const sessao = require("../lib/sessao");

const STATUS_LABEL = {
  concluido: "Concluído",
  em_curso: "Em curso",
  nao_iniciado: "Não iniciado",
  convite_pendente: "Convite pendente",
};

// Ranking final ordena pela Fase 2 — não existe soma das duas fases,
// a pontuação total não tem relevância pra classificação. Fase 1 e
// Fase 2 continuam expostas lado a lado só como acompanhamento.
// conclusao_em = horário da última resposta da Fase 2 (quando a pessoa
// respondeu a última pergunta pendente) — só existe pra quem chegou a
// concluir; os demais vêm NULL.
async function carregarParticipantesOrdenados(turmaId) {
  const res = await db.query(
    `SELECT p.nome, p.email, p.empresa, p.cnpj, p.xp_fase1, p.xp_fase2, p.melhor_streak, p.status,
            (SELECT MAX(r.respondido_em) FROM respostas r WHERE r.participante_id = p.id AND r.fase = 2) AS conclusao_em
     FROM participantes p WHERE p.turma_id = $1
     ORDER BY p.xp_fase2 DESC, p.melhor_streak DESC`,
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

// GET /admin/relatorio/:turmaId/xlsx   — somente Owner (controle formatado)
async function gerarXlsxBuffer(turmaNome, dataEvento, participantes) {
  const GOLD = "FFB5966A";
  const DARK = "FF1A1A1A";
  const LIGHT_ROW = "FFF7F6F3";
  const GREEN = "FF7FA66B";
  const GRAY = "FF8A8377";

  const wb = new ExcelJS.Workbook();
  wb.creator = "Nera Treinamento";
  wb.created = new Date();

  const sheet = wb.addWorksheet("Participantes", { views: [{ state: "frozen", ySplit: 3 }] });

  sheet.columns = [
    { key: "ranking", width: 10 },
    { key: "nome", width: 26 },
    { key: "email", width: 32 },
    { key: "empresa", width: 26 },
    { key: "status", width: 18 },
    { key: "fase1", width: 13 },
    { key: "fase2", width: 13 },
    { key: "streak", width: 15 },
    { key: "conclusao", width: 20 },
  ];

  sheet.mergeCells("A1:I1");
  const titulo = sheet.getCell("A1");
  titulo.value = `Nera Treinamento | Controle de Participantes | ${turmaNome}`;
  titulo.font = { name: "Arial", size: 16, bold: true, color: { argb: DARK } };
  titulo.alignment = { vertical: "middle" };
  sheet.getRow(1).height = 30;

  sheet.mergeCells("A2:I2");
  const subtitulo = sheet.getCell("A2");
  const dataFormatada = dataEvento ? new Date(dataEvento).toLocaleDateString("pt-BR") : "—";
  subtitulo.value = `Data do evento: ${dataFormatada} — Gerado em ${new Date().toLocaleString("pt-BR")} — ${participantes.length} participante(s)`;
  subtitulo.font = { name: "Arial", size: 10, italic: true, color: { argb: GRAY } };
  sheet.getRow(2).height = 18;

  const headerRow = sheet.addRow(["Ranking", "Nome", "E-mail", "Empresa", "Status", "Pontuação Fase 1", "Pontuação Fase 2", "Melhor Streak", "Concluiu em"]);
  headerRow.height = 24;
  headerRow.eachCell((cell) => {
    cell.font = { name: "Arial", bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: GOLD } };
    cell.alignment = { vertical: "middle", horizontal: "center" };
  });

  participantes.forEach((p, i) => {
    const ranking = i + 1;
    // Só é "conclusão" de fato se a pessoa terminou as 10 perguntas
    // (status concluido) — senão o horário existe (última resposta dada)
    // mas não representa ter finalizado.
    const conclusaoTexto = p.status === "concluido" && p.conclusao_em
      ? new Date(p.conclusao_em).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })
      : "—";
    const row = sheet.addRow([
      ranking,
      p.nome,
      p.email,
      p.empresa || "—",
      STATUS_LABEL[p.status] || p.status,
      p.xp_fase1,
      p.xp_fase2,
      p.melhor_streak,
      conclusaoTexto,
    ]);
    row.height = 20;

    const zebra = i % 2 === 1;
    const colunasCentralizadas = [1, 6, 7, 8, 9];
    row.eachCell((cell, colNumber) => {
      cell.font = { name: "Arial", size: 11, color: { argb: DARK } };
      cell.alignment = { vertical: "middle", horizontal: colunasCentralizadas.includes(colNumber) ? "center" : "left" };
      cell.border = { bottom: { style: "hair", color: { argb: "FFE3E0D9" } } };
      if (zebra) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: LIGHT_ROW } };
    });

    const statusCell = row.getCell(5);
    if (p.status === "concluido") {
      statusCell.font = { name: "Arial", size: 11, bold: true, color: { argb: GREEN } };
    } else if (p.status === "em_curso") {
      statusCell.font = { name: "Arial", size: 11, bold: true, color: { argb: GOLD } };
    } else {
      statusCell.font = { name: "Arial", size: 11, color: { argb: GRAY } };
    }

    if (ranking <= 3) {
      row.getCell(1).font = { name: "Arial", bold: true, color: { argb: GOLD } };
      row.getCell(7).font = { name: "Arial", bold: true, color: { argb: DARK } }; // Fase 2 — critério do ranking
    }
  });

  sheet.autoFilter = { from: "A3", to: "I3" };

  return wb.xlsx.writeBuffer();
}

async function exportarXlsx(event) {
  try {
    const admin = await sessao.adminAutenticado(event);
    if (!admin) return http.unauthorized();
    if (admin.papel !== "owner") return http.forbidden("Exportação disponível apenas para o papel Owner.");

    const turmaId = event.pathParameters && event.pathParameters.turmaId;
    const turmaRes = await db.query(`SELECT nome, data_evento FROM turmas WHERE id = $1`, [turmaId]);
    if (turmaRes.rows.length === 0) return http.notFound("Turma não encontrada.");

    const participantes = await carregarParticipantesOrdenados(turmaId);
    const buffer = await gerarXlsxBuffer(turmaRes.rows[0].nome, turmaRes.rows[0].data_evento, participantes);

    await db.query(`INSERT INTO log_auditoria (admin_id, admin_nome_snapshot, acao, alvo) VALUES ($1, $2, $3, $4)`, [
      admin.admin_id, admin.nome, `Exportou controle XLSX com ${participantes.length} participantes`, turmaRes.rows[0].nome,
    ]);

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="controle_${turmaRes.rows[0].nome.replace(/\s+/g, "_")}.xlsx"`,
      },
      body: Buffer.from(buffer),
    };
  } catch (err) {
    return http.serverError(err);
  }
}

module.exports = { gerar, exportarXlsx };
