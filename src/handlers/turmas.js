// =====================================================================
// handlers/turmas.js — Turmas: listar (com filtro), criar via upload
// =====================================================================

const db = require("../lib/db");
const email = require("../lib/email");
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

    const participantesTrim = [];
    const turma = await db.withTransaction(async (client) => {
      const turmaRes = await client.query(
        `INSERT INTO turmas (nome, data_evento, status, criada_por) VALUES ($1, $2, 'agendada', $3) RETURNING *`,
        [nome, dataEvento, admin.admin_id]
      );
      const novaTurma = turmaRes.rows[0];

      for (const p of participantes || []) {
        const pTrim = { nome: (p.nome || "").trim(), email: (p.email || "").trim(), empresa: (p.empresa || "").trim() || null, cnpj: (p.cnpj || "").trim() || null };
        await client.query(
          `INSERT INTO participantes (turma_id, nome, email, empresa, cnpj, origem, status)
           VALUES ($1, $2, $3, $4, $5, 'lista', 'nao_iniciado')`,
          [novaTurma.id, pTrim.nome, pTrim.email, pTrim.empresa, pTrim.cnpj]
        );
        participantesTrim.push(pTrim);
      }
      return novaTurma;
    });

    await db.query(`INSERT INTO log_auditoria (admin_id, admin_nome_snapshot, acao, alvo) VALUES ($1, $2, $3, $4)`, [
      admin.admin_id, admin.nome, "Criou turma via upload de lista", nome,
    ]);

    // Avisa todo mundo assim que a turma é confirmada — não espera a
    // ativação. A mensagem já deixa claro que o acesso só libera no dia
    // do evento (ver lib/email.js), então não há problema em avisar cedo.
    const linkPortal = process.env.PARTICIPANT_FRONTEND_URL;
    if (!linkPortal) {
      console.warn("PARTICIPANT_FRONTEND_URL ausente — e-mail de acesso não enviado aos participantes da turma.");
    } else {
      await Promise.allSettled(
        participantesTrim.map((p) => email.enviarLinkPortalParticipante(p.email, p.nome, turma.nome, turma.data_evento, linkPortal))
      );
    }

    return http.created({ turma });
  } catch (err) {
    return http.serverError(err);
  }
}

// POST /admin/turmas/:id/ativar
// Abre a janela de acesso dos participantes (24h) e libera a turma pra
// aparecer em Monitoramento/Condução da Prova. Só faz sentido a partir de
// 'agendada' — reativar uma turma já 'encerrada' teria que reabrir a
// janela pra quem já viu o pódio final, então fica de fora por ora.
async function ativar(event) {
  try {
    const admin = await sessao.adminAutenticado(event);
    if (!admin) return http.unauthorized();

    const turmaId = event.pathParameters && event.pathParameters.id;
    const turmaRes = await db.query(`SELECT id, nome, status FROM turmas WHERE id = $1`, [turmaId]);
    if (turmaRes.rows.length === 0) return http.notFound("Turma não encontrada.");
    if (turmaRes.rows[0].status !== "agendada") return http.conflict("Só é possível ativar uma turma que está Agendada.");

    const res = await db.query(
      `UPDATE turmas SET status = 'ativa', janela_inicio = now(), janela_fim = now() + interval '24 hours' WHERE id = $1 RETURNING *`,
      [turmaId]
    );

    await db.query(`INSERT INTO log_auditoria (admin_id, admin_nome_snapshot, acao, alvo) VALUES ($1, $2, $3, $4)`, [
      admin.admin_id, admin.nome, "Ativou a turma", turmaRes.rows[0].nome,
    ]);

    // O aviso por e-mail já saiu na confirmação da turma (criar()) — aqui
    // é só abrir a janela de acesso, sem novo envio.
    return http.ok({ turma: res.rows[0] });
  } catch (err) {
    return http.serverError(err);
  }
}

// POST /admin/turmas/:id/encerrar
// Fecha a turma: impede o admin de continuar conduzindo o quiz ao vivo
// (a turma some da lista de turmas ativas) e trava novas respostas —
// mas o participante continua conseguindo entrar e ver o pódio final
// por 12h a partir de janela_fim (login aceita turma 'ativa' ou
// 'encerrada' dentro da janela — ver participanteAuth.js e sessao.js).
async function encerrar(event) {
  try {
    const admin = await sessao.adminAutenticado(event);
    if (!admin) return http.unauthorized();

    const turmaId = event.pathParameters && event.pathParameters.id;
    const turmaRes = await db.query(`SELECT id, nome, status FROM turmas WHERE id = $1`, [turmaId]);
    if (turmaRes.rows.length === 0) return http.notFound("Turma não encontrada.");
    if (turmaRes.rows[0].status === "encerrada") return http.conflict("Turma já está encerrada.");

    const res = await db.query(
      `UPDATE turmas SET status = 'encerrada', janela_fim = now() WHERE id = $1 RETURNING *`,
      [turmaId]
    );

    await db.query(`INSERT INTO log_auditoria (admin_id, admin_nome_snapshot, acao, alvo) VALUES ($1, $2, $3, $4)`, [
      admin.admin_id, admin.nome, "Encerrou a turma", turmaRes.rows[0].nome,
    ]);

    return http.ok({ turma: res.rows[0] });
  } catch (err) {
    return http.serverError(err);
  }
}

module.exports = { listar, conferir, criar, ativar, encerrar };
