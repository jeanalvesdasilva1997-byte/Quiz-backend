// =====================================================================
// handlers/acesso.js — Gestão de administradores (Owner) e log de auditoria
// =====================================================================

const db = require("../lib/db");
const auth = require("../lib/auth");
const email = require("../lib/email");
const http = require("../lib/http");
const sessao = require("../lib/sessao");

function exigirOwner(admin) {
  return admin.papel === "owner";
}

// GET /admin/equipe
async function listarEquipe(event) {
  try {
    const admin = await sessao.adminAutenticado(event);
    if (!admin) return http.unauthorized();
    if (!exigirOwner(admin)) return http.forbidden("Disponível apenas para Owner.");

    const res = await db.query(`SELECT id, nome, email, papel, status, criado_em FROM admins ORDER BY criado_em`);
    return http.ok({ equipe: res.rows });
  } catch (err) {
    return http.serverError(err);
  }
}

// POST /admin/equipe/convidar   { email, papel }
async function convidar(event) {
  try {
    const admin = await sessao.adminAutenticado(event);
    if (!admin) return http.unauthorized();
    if (!exigirOwner(admin)) return http.forbidden("Disponível apenas para Owner.");

    let { email: emailConvidado, papel } = JSON.parse(event.body || "{}");
    if (!emailConvidado || !["owner", "operador"].includes(papel)) return http.badRequest("Informe e-mail e papel válido.");
    emailConvidado = emailConvidado.trim();

    const existente = await db.query(`SELECT id FROM admins WHERE lower(email) = lower($1)`, [emailConvidado]);
    if (existente.rows.length > 0) return http.conflict("Já existe um administrador com este e-mail.");

    // Senha temporária aleatória — será substituída quando a pessoa
    // definir a própria senha ao aceitar o convite (fluxo de ativação).
    const senhaTemporariaHash = await auth.hash(auth.gerarTokenOpaco());
    const novoAdmin = await db.query(
      `INSERT INTO admins (nome, email, senha_hash, papel, status, convidado_por)
       VALUES ($1, $2, $3, $4, 'convite_pendente', $5) RETURNING *`,
      [emailConvidado.split("@")[0], emailConvidado, senhaTemporariaHash, papel, admin.admin_id]
    );

    const tokenAtivacao = auth.gerarTokenOpaco();
    const link = `${process.env.FRONTEND_ORIGIN}/ativar-convite?token=${tokenAtivacao}&email=${encodeURIComponent(emailConvidado)}`;
    await email.enviarConviteAdmin(emailConvidado, link);

    await db.query(`INSERT INTO log_auditoria (admin_id, admin_nome_snapshot, acao, alvo) VALUES ($1, $2, $3, $4)`, [
      admin.admin_id, admin.nome, "Convidou administrador", `${emailConvidado} (${papel})`,
    ]);

    return http.created({ admin: novoAdmin.rows[0] });
  } catch (err) {
    return http.serverError(err);
  }
}

// DELETE /admin/equipe/:id
async function remover(event) {
  try {
    const admin = await sessao.adminAutenticado(event);
    if (!admin) return http.unauthorized();
    if (!exigirOwner(admin)) return http.forbidden("Disponível apenas para Owner.");

    const idRemover = event.pathParameters && event.pathParameters.id;
    if (idRemover === admin.admin_id) return http.badRequest("Você não pode remover a própria conta.");

    const res = await db.query(`DELETE FROM admins WHERE id = $1 RETURNING email`, [idRemover]);
    if (res.rows.length === 0) return http.notFound("Administrador não encontrado.");

    await db.query(`INSERT INTO log_auditoria (admin_id, admin_nome_snapshot, acao, alvo) VALUES ($1, $2, $3, $4)`, [
      admin.admin_id, admin.nome, "Removeu administrador", res.rows[0].email,
    ]);

    return http.ok({ mensagem: "Administrador removido." });
  } catch (err) {
    return http.serverError(err);
  }
}

// GET /admin/log-auditoria?limite=50
async function logAuditoria(event) {
  try {
    const admin = await sessao.adminAutenticado(event);
    if (!admin) return http.unauthorized();
    if (!exigirOwner(admin)) return http.forbidden("Disponível apenas para Owner.");

    const limite = Math.min(Number((event.queryStringParameters || {}).limite) || 50, 200);
    const res = await db.query(
      `SELECT admin_nome_snapshot AS quem, acao, alvo, quando FROM log_auditoria ORDER BY quando DESC LIMIT $1`,
      [limite]
    );
    return http.ok({ log: res.rows });
  } catch (err) {
    return http.serverError(err);
  }
}

module.exports = { listarEquipe, convidar, remover, logAuditoria };
