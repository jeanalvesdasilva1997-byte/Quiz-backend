// =====================================================================
// handlers/participanteAuth.js — Login do participante (e-mail + senha)
// =====================================================================
// O e-mail pré-cadastrado pelo organizador (lista da turma ou cadastro
// no dia) já é a barreira de acesso — decisão explícita da equipe
// Cebrace de dispensar código por e-mail. No primeiro acesso, a própria
// pessoa cria a senha; ninguém, nem o admin, chega a vê-la.
// =====================================================================

const db = require("../lib/db");
const auth = require("../lib/auth");
const http = require("../lib/http");

// Aceita turma 'ativa' (treinamento em andamento) ou 'encerrada' — depois
// de encerrada, o participante ainda consegue entrar por 12h (pra ver o
// pódio final), passado isso o acesso se encerra de vez. Turma 'agendada'
// (ainda não começou) sempre bloqueia o acesso.
async function buscarParticipanteAtivo(emailInformado) {
  const res = await db.query(
    `SELECT p.* FROM participantes p
     JOIN turmas t ON t.id = p.turma_id
     WHERE lower(p.email) = lower($1)
       AND (t.status = 'ativa' OR (t.status = 'encerrada' AND now() <= t.janela_fim + interval '12 hours'))
     LIMIT 1`,
    [emailInformado]
  );
  return res.rows[0] || null;
}

// Cria a sessão e marca o início da janela de 24h — compartilhado entre
// o primeiro acesso (definir-senha) e os acessos seguintes (login).
async function efetuarLogin(participante) {
  const primeiroLogin = participante.primeiro_login_em || new Date();
  const novoStatus = ["convite_pendente", "nao_iniciado"].includes(participante.status) ? "em_curso" : participante.status;

  await db.query(
    `UPDATE participantes SET primeiro_login_em = $1, status = $2 WHERE id = $3`,
    [primeiroLogin, novoStatus, participante.id]
  );

  const token = auth.gerarTokenOpaco();
  const tokenHash = auth.hashTokenSessao(token);
  const expiraEm = new Date(new Date(primeiroLogin).getTime() + 24 * 60 * 60 * 1000);

  await db.query(
    `INSERT INTO participante_sessoes (participante_id, token_hash, expira_em) VALUES ($1, $2, $3)`,
    [participante.id, tokenHash, expiraEm]
  );

  await db.query(
    `INSERT INTO log_auditoria (admin_nome_snapshot, acao, alvo) VALUES ($1, $2, $3)`,
    [participante.nome, "Login confirmado (e-mail + senha)", participante.email]
  );

  return http.ok(
    { mensagem: "Login confirmado." },
    { "Set-Cookie": auth.cookieDeSessao("habitat_participante_sessao", token, expiraEm) }
  );
}

// POST /participante/verificar-email   { email }
// Decide qual tela mostrar em seguida: criar senha (primeiro acesso) ou
// digitar senha (acessos seguintes).
//
// Sempre responde 200, encontrado ou não — status code diferente (404)
// era um oráculo trivial pra enumerar e-mails cadastrados na turma (um
// bot conseguia confirmar quem está na lista só olhando o código HTTP,
// sem nem tentar senha). O front decide a mensagem a partir do campo
// `encontrado`, não mais de uma exceção lançada pelo cliente HTTP.
async function verificarEmail(event) {
  try {
    const { email: emailInformado } = JSON.parse(event.body || "{}");
    if (!emailInformado) return http.badRequest("Informe o e-mail.");

    const participante = await buscarParticipanteAtivo(emailInformado.trim());
    if (!participante) {
      return http.ok({ encontrado: false });
    }

    return http.ok({ encontrado: true, primeiroAcesso: participante.senha_hash === null });
  } catch (err) {
    return http.serverError(err);
  }
}

// POST /participante/definir-senha   { email, senha }
async function definirSenha(event) {
  try {
    const { email: emailInformado, senha } = JSON.parse(event.body || "{}");
    if (!emailInformado || !senha) return http.badRequest("Informe e-mail e senha.");
    if (senha.length < 6) return http.badRequest("A senha deve ter pelo menos 6 caracteres.");

    const participante = await buscarParticipanteAtivo(emailInformado.trim());
    if (!participante) return http.unauthorized("E-mail não encontrado.");
    if (participante.senha_hash !== null) return http.conflict("Este e-mail já tem senha definida. Faça login normalmente.");

    const senhaHash = await auth.hash(senha);
    await db.query(`UPDATE participantes SET senha_hash = $1 WHERE id = $2`, [senhaHash, participante.id]);

    return efetuarLogin(participante);
  } catch (err) {
    return http.serverError(err);
  }
}

// POST /participante/login   { email, senha }
async function login(event) {
  try {
    const { email: emailInformado, senha } = JSON.parse(event.body || "{}");
    if (!emailInformado || !senha) return http.badRequest("Informe e-mail e senha.");

    const participante = await buscarParticipanteAtivo(emailInformado.trim());
    if (!participante || !participante.senha_hash) return http.unauthorized("E-mail ou senha incorretos.");

    const senhaCorreta = await auth.verificarHash(senha, participante.senha_hash);
    if (!senhaCorreta) return http.unauthorized("E-mail ou senha incorretos.");

    return efetuarLogin(participante);
  } catch (err) {
    return http.serverError(err);
  }
}

module.exports = { verificarEmail, definirSenha, login };
