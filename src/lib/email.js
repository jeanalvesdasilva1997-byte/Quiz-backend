// =====================================================================
// lib/email.js — Envio de e-mail transacional via Resend
// =====================================================================
// Quem chama essas funções (convite de admin, reset de senha) não muda —
// só o corpo desta função, então trocar de provedor no futuro continua
// sendo um arquivo só.
//
// Sem RESEND_API_KEY configurada (ex: ambiente local sem conta criada
// ainda), cai de volta pro comportamento antigo — só imprime o link no
// log — pra não travar o fluxo de quem está testando sem uma conta Resend.
// Falha de envio (ex: chave inválida, domínio do remetente não verificado)
// também nunca derruba o fluxo que chamou: o convite/reset já foi gravado
// no banco antes disso, e-mail é só a notificação.
// =====================================================================

const { Resend } = require("resend");

const REMETENTE = process.env.EMAIL_REMETENTE || "acesso@conforto-habitat.com.br";
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

async function enviarConviteAdmin(email, linkAtivacao) {
  const assunto = "Convite — Conversas de Conforto Habitat by Cebrace";
  const corpoTexto = `Você foi convidado a administrar o portal Conversas de Conforto Habitat by Cebrace.\n\nDefina sua senha em: ${linkAtivacao}`;
  const corpoHtml = `
    <p>Você foi convidado a administrar o portal <strong>Conversas de Conforto Habitat by Cebrace</strong>.</p>
    <p><a href="${linkAtivacao}">Definir minha senha</a></p>
    <p style="color:#8A8377;font-size:12px;">Se você não esperava este convite, pode ignorar este e-mail.</p>
  `;

  if (!resend) {
    console.log(`\n[e-mail não enviado — RESEND_API_KEY ausente] De: ${REMETENTE} Para: ${email}`);
    console.log(`${corpoTexto}\n`);
    return;
  }

  const { error } = await resend.emails.send({
    from: REMETENTE,
    to: email,
    subject: assunto,
    text: corpoTexto,
    html: corpoHtml,
  });

  if (error) {
    console.error("Falha ao enviar e-mail via Resend:", error);
  }
}

module.exports = { enviarConviteAdmin };
