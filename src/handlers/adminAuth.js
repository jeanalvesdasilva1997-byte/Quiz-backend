// =====================================================================
// handlers/adminAuth.js — Login do admin (senha + 2FA), bloqueio e reset
// =====================================================================

const db = require("../lib/db");
const auth = require("../lib/auth");
const email = require("../lib/email");
const http = require("../lib/http");

// POST /admin/login   { email, senha }
// 1º fator. Após 3 tentativas erradas, bloqueia até reset de senha —
// sem escalonamento progressivo (decisão explícita do time Nera).
async function login(event) {
  try {
    const { email: emailInformado, senha } = JSON.parse(event.body || "{}");
    if (!emailInformado || !senha) return http.badRequest("Informe e-mail e senha.");

    const res = await db.query(`SELECT * FROM admins WHERE lower(email) = lower($1)`, [emailInformado]);
    if (res.rows.length === 0) return http.unauthorized("E-mail ou senha incorretos.");
    const admin = res.rows[0];

    if (admin.bloqueado) {
      return http.forbidden("Conta bloqueada após 3 tentativas incorretas. Redefina sua senha pelo link enviado ao seu e-mail.");
    }

    const senhaCorreta = await auth.verificarHash(senha, admin.senha_hash);
    if (!senhaCorreta) {
      const tentativas = admin.tentativas_senha + 1;
      const bloquear = tentativas >= auth.MAX_TENTATIVAS_SENHA_ADMIN;
      await db.query(`UPDATE admins SET tentativas_senha = $1, bloqueado = $2 WHERE id = $3`, [tentativas, bloquear, admin.id]);
      if (bloquear) {
        return http.forbidden("Conta bloqueada após 3 tentativas incorretas. Redefina sua senha pelo link enviado ao seu e-mail.");
      }
      return http.unauthorized(`E-mail ou senha incorretos. ${auth.MAX_TENTATIVAS_SENHA_ADMIN - tentativas} tentativa(s) restante(s).`);
    }

    await db.query(`UPDATE admins SET tentativas_senha = 0 WHERE id = $1`, [admin.id]);

    // 1º fator OK — dispara o 2º fator (código por e-mail)
    const codigo = auth.gerarCodigoOtp();
    const codigoHash = await auth.hash(codigo);
    await db.query(
      `INSERT INTO admin_2fa_codigos (admin_id, codigo_hash, expira_em) VALUES ($1, $2, $3)`,
      [admin.id, codigoHash, auth.otpExpiraEm()]
    );
    await email.enviarCodigoAdmin(admin.email, codigo);

    return http.ok({ mensagem: "Senha confirmada. Verifique seu e-mail para o código de confirmação.", proximaEtapa: "2fa" });
  } catch (err) {
    return http.serverError(err);
  }
}

// POST /admin/confirmar-2fa   { email, codigo }
async function confirmar2fa(event) {
  try {
    const { email: emailInformado, codigo } = JSON.parse(event.body || "{}");
    const res = await db.query(`SELECT * FROM admins WHERE lower(email) = lower($1)`, [emailInformado]);
    if (res.rows.length === 0) return http.unauthorized();
    const admin = res.rows[0];

    const codigoRes = await db.query(
      `SELECT * FROM admin_2fa_codigos WHERE admin_id = $1 AND usado = FALSE AND expira_em > now()
       ORDER BY criado_em DESC LIMIT 1`,
      [admin.id]
    );
    if (codigoRes.rows.length === 0) return http.unauthorized("Código inválido ou expirado.");
    const registro = codigoRes.rows[0];

    const codigoCorreto = await auth.verificarHash(codigo, registro.codigo_hash);
    if (!codigoCorreto) {
      await db.query(`UPDATE admin_2fa_codigos SET tentativas = tentativas + 1 WHERE id = $1`, [registro.id]);
      return http.unauthorized("Código incorreto.");
    }

    await db.query(`UPDATE admin_2fa_codigos SET usado = TRUE WHERE id = $1`, [registro.id]);
    if (admin.status === "convite_pendente") {
      await db.query(`UPDATE admins SET status = 'ativo' WHERE id = $1`, [admin.id]);
    }

    const token = auth.gerarTokenOpaco();
    const tokenHash = await auth.hash(token);
    const expiraEm = auth.sessaoExpiraEm("admin");
    await db.query(`INSERT INTO admin_sessoes (admin_id, token_hash, expira_em) VALUES ($1, $2, $3)`, [admin.id, tokenHash, expiraEm]);

    await db.query(`INSERT INTO log_auditoria (admin_id, admin_nome_snapshot, acao) VALUES ($1, $2, $3)`, [
      admin.id, admin.nome, "Login realizado (2FA confirmado)",
    ]);

    return http.ok(
      { nome: admin.nome, papel: admin.papel },
      { "Set-Cookie": auth.cookieDeSessao("nera_admin_sessao", token, expiraEm) }
    );
  } catch (err) {
    return http.serverError(err);
  }
}

// POST /admin/solicitar-reset-senha   { email }
// Sempre responde com a mesma mensagem — mesmo princípio anti-enumeração do OTP do participante.
async function solicitarResetSenha(event) {
  try {
    const { email: emailInformado } = JSON.parse(event.body || "{}");
    const res = await db.query(`SELECT * FROM admins WHERE lower(email) = lower($1)`, [emailInformado]);
    if (res.rows.length > 0) {
      const admin = res.rows[0];
      const token = auth.gerarTokenOpaco();
      const tokenHash = await auth.hash(token);
      const expiraEm = new Date(Date.now() + 30 * 60 * 1000); // 30 minutos
      await db.query(`INSERT INTO admin_reset_senha (admin_id, token_hash, expira_em) VALUES ($1, $2, $3)`, [admin.id, tokenHash, expiraEm]);
      const link = `${process.env.FRONTEND_ORIGIN}/redefinir-senha?token=${token}&email=${encodeURIComponent(admin.email)}`;
      await email.enviarConviteAdmin(admin.email, link); // reaproveita o mesmo remetente/estrutura de e-mail transacional
    }
    return http.ok({ mensagem: "Se o e-mail existir, um link de redefinição foi enviado." });
  } catch (err) {
    return http.serverError(err);
  }
}

// POST /admin/redefinir-senha   { email, token, novaSenha }
async function redefinirSenha(event) {
  try {
    const { email: emailInformado, token, novaSenha } = JSON.parse(event.body || "{}");
    const res = await db.query(`SELECT * FROM admins WHERE lower(email) = lower($1)`, [emailInformado]);
    if (res.rows.length === 0) return http.unauthorized();
    const admin = res.rows[0];

    const resetRes = await db.query(
      `SELECT * FROM admin_reset_senha WHERE admin_id = $1 AND usado = FALSE AND expira_em > now() ORDER BY criado_em DESC LIMIT 1`,
      [admin.id]
    );
    if (resetRes.rows.length === 0) return http.unauthorized("Link inválido ou expirado.");
    const registro = resetRes.rows[0];

    const tokenValido = await auth.verificarHash(token, registro.token_hash);
    if (!tokenValido) return http.unauthorized("Link inválido ou expirado.");

    const novaSenhaHash = await auth.hash(novaSenha);
    await db.withTransaction(async (client) => {
      await client.query(`UPDATE admins SET senha_hash = $1, tentativas_senha = 0, bloqueado = FALSE WHERE id = $2`, [novaSenhaHash, admin.id]);
      await client.query(`UPDATE admin_reset_senha SET usado = TRUE WHERE id = $1`, [registro.id]);
    });

    return http.ok({ mensagem: "Senha redefinida com sucesso." });
  } catch (err) {
    return http.serverError(err);
  }
}

module.exports = { login, confirmar2fa, solicitarResetSenha, redefinirSenha };
