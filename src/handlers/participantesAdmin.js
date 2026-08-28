// =====================================================================
// handlers/participantesAdmin.js — Cadastro no dia e liberação manual
// =====================================================================

const db = require("../lib/db");
const email = require("../lib/email");
const http = require("../lib/http");
const sessao = require("../lib/sessao");

// POST /admin/cadastro-no-dia   { turmaId, nome, email, empresa, cnpj }
// A turma é sempre selecionada explicitamente — correção do bug apontado
// (antes o cadastro não deixava claro em qual turma o participante entrava).
async function cadastroNoDia(event) {
  try {
    const admin = await sessao.adminAutenticado(event);
    if (!admin) return http.unauthorized();

    const { turmaId, nome, email: emailParticipante, empresa, cnpj } = JSON.parse(event.body || "{}");
    if (!turmaId || !nome || !emailParticipante) return http.badRequest("Informe turma, nome e e-mail.");

    const nomeTrim = nome.trim();
    const emailTrim = emailParticipante.trim();
    const empresaTrim = (empresa || "").trim();
    const cnpjTrim = (cnpj || "").trim();

    const dup = await db.query(
      `SELECT id FROM participantes WHERE turma_id = $1 AND lower(email) = lower($2)`,
      [turmaId, emailTrim]
    );
    if (dup.rows.length > 0) return http.conflict("Esse e-mail já está cadastrado nesta turma.");

    // Grava primeiro, confirma, só então envia o e-mail — nunca na ordem
    // inversa (evita mandar um link válido para um cadastro que falhou ao salvar).
    const participante = await db.withTransaction(async (client) => {
      const res = await client.query(
        `INSERT INTO participantes (turma_id, nome, email, empresa, cnpj, origem, status)
         VALUES ($1, $2, $3, $4, $5, 'no_dia', 'nao_iniciado') RETURNING *`,
        [turmaId, nomeTrim, emailTrim, empresaTrim || null, cnpjTrim || null]
      );
      return res.rows[0];
    });

    const turmaRes = await db.query(`SELECT nome, data_evento FROM turmas WHERE id = $1`, [turmaId]);
    const linkPortal = process.env.PARTICIPANT_FRONTEND_URL;
    if (!linkPortal) {
      console.warn("PARTICIPANT_FRONTEND_URL ausente — e-mail de acesso não enviado ao participante.");
    } else {
      await email.enviarLinkPortalParticipante(emailTrim, nomeTrim, turmaRes.rows[0].nome, turmaRes.rows[0].data_evento, linkPortal);
    }

    await db.query(`INSERT INTO log_auditoria (admin_id, admin_nome_snapshot, acao, alvo) VALUES ($1, $2, $3, $4)`, [
      admin.admin_id, admin.nome, "Adicionou participante (cadastro no dia)", `${nomeTrim} — ${turmaRes.rows[0].nome}`,
    ]);

    return http.created({ participante });
  } catch (err) {
    return http.serverError(err);
  }
}

// POST /admin/liberar-manualmente   { participanteId }
// Plano de contingência: se o e-mail falhar, o admin libera o acesso
// direto, sem depender do código — sempre registrado em auditoria.
async function liberarManualmente(event) {
  try {
    const admin = await sessao.adminAutenticado(event);
    if (!admin) return http.unauthorized();

    const { participanteId } = JSON.parse(event.body || "{}");
    const res = await db.query(
      `UPDATE participantes SET status = 'em_curso', primeiro_login_em = COALESCE(primeiro_login_em, now())
       WHERE id = $1 RETURNING nome, email`,
      [participanteId]
    );
    if (res.rows.length === 0) return http.notFound("Participante não encontrado.");

    await db.query(`INSERT INTO log_auditoria (admin_id, admin_nome_snapshot, acao, alvo) VALUES ($1, $2, $3, $4)`, [
      admin.admin_id, admin.nome, "Liberação manual de acesso (contingência)", res.rows[0].email,
    ]);

    return http.ok({ mensagem: "Acesso liberado manualmente." });
  } catch (err) {
    return http.serverError(err);
  }
}

module.exports = { cadastroNoDia, liberarManualmente };
