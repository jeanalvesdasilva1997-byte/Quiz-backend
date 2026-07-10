// =====================================================================
// handlers/participanteAuth.js — Login do participante (e-mail + OTP)
// =====================================================================

const db = require("../lib/db");
const auth = require("../lib/auth");
const email = require("../lib/email");
const http = require("../lib/http");

// POST /participante/solicitar-codigo   { email }
// Sempre responde 200 com a mesma mensagem genérica — não revela se o
// e-mail existe na base, para não permitir enumerar participantes.
async function solicitarCodigo(event) {
  try {
    const { email: emailInformado } = JSON.parse(event.body || "{}");
    if (!emailInformado) return http.badRequest("Informe o e-mail.");

    const resultado = await db.query(
      `SELECT p.id, t.nome AS turma_nome FROM participantes p
       JOIN turmas t ON t.id = p.turma_id
       WHERE lower(p.email) = lower($1) AND t.status = 'ativa'
       LIMIT 1`,
      [emailInformado]
    );

    if (resultado.rows.length > 0) {
      const participante = resultado.rows[0];
      const codigo = auth.gerarCodigoOtp();
      const codigoHash = await auth.hash(codigo);

      await db.query(
        `INSERT INTO participante_codigos_otp (participante_id, codigo_hash, expira_em)
         VALUES ($1, $2, $3)`,
        [participante.id, codigoHash, auth.otpExpiraEm()]
      );

      await email.enviarCodigoParticipante(emailInformado, codigo, participante.turma_nome);
    }

    // Mensagem idêntica nos dois casos (achou ou não achou o e-mail)
    return http.ok({ mensagem: "Se o e-mail informado estiver na lista de uma turma ativa, você receberá um código por e-mail em instantes." });
  } catch (err) {
    return http.serverError(err);
  }
}

// POST /participante/confirmar-codigo   { email, codigo }
async function confirmarCodigo(event) {
  try {
    const { email: emailInformado, codigo } = JSON.parse(event.body || "{}");
    if (!emailInformado || !codigo) return http.badRequest("Informe e-mail e código.");

    const participanteRes = await db.query(
      `SELECT p.* FROM participantes p
       JOIN turmas t ON t.id = p.turma_id
       WHERE lower(p.email) = lower($1) AND t.status = 'ativa' LIMIT 1`,
      [emailInformado]
    );
    if (participanteRes.rows.length === 0) return http.unauthorized("Código inválido ou expirado.");
    const participante = participanteRes.rows[0];

    const otpRes = await db.query(
      `SELECT * FROM participante_codigos_otp
       WHERE participante_id = $1 AND usado = FALSE AND expira_em > now()
       ORDER BY criado_em DESC LIMIT 1`,
      [participante.id]
    );
    if (otpRes.rows.length === 0) return http.unauthorized("Código inválido ou expirado.");
    const otp = otpRes.rows[0];

    if (otp.tentativas >= 5) return http.unauthorized("Limite de tentativas excedido. Solicite um novo código.");

    const codigoCorreto = await auth.verificarHash(codigo, otp.codigo_hash);
    if (!codigoCorreto) {
      await db.query(`UPDATE participante_codigos_otp SET tentativas = tentativas + 1 WHERE id = $1`, [otp.id]);
      return http.unauthorized("Código incorreto.");
    }

    await db.query(`UPDATE participante_codigos_otp SET usado = TRUE WHERE id = $1`, [otp.id]);

    // Primeiro login desta pessoa nesta turma? Marca o início da janela de 24h.
    const primeiroLogin = participante.primeiro_login_em || new Date();
    const novoStatus = ["convite_pendente", "nao_iniciado"].includes(participante.status) ? "em_curso" : participante.status;

    await db.query(
      `UPDATE participantes SET primeiro_login_em = $1, status = $2 WHERE id = $3`,
      [primeiroLogin, novoStatus, participante.id]
    );

    const token = auth.gerarTokenOpaco();
    const tokenHash = await auth.hash(token);
    const expiraEm = new Date(new Date(primeiroLogin).getTime() + 24 * 60 * 60 * 1000);

    await db.query(
      `INSERT INTO participante_sessoes (participante_id, token_hash, expira_em) VALUES ($1, $2, $3)`,
      [participante.id, tokenHash, expiraEm]
    );

    await db.query(
      `INSERT INTO log_auditoria (admin_nome_snapshot, acao, alvo) VALUES ($1, $2, $3)`,
      [participante.nome, "Login confirmado (e-mail + código)", participante.email]
    );

    return http.ok(
      { mensagem: "Login confirmado." },
      { "Set-Cookie": auth.cookieDeSessao("nera_participante_sessao", token, expiraEm) }
    );
  } catch (err) {
    return http.serverError(err);
  }
}

module.exports = { solicitarCodigo, confirmarCodigo };
