// =====================================================================
// lib/email.js — Envio de e-mail via Amazon SES
// =====================================================================
// Decisão de arquitetura: provedor de e-mail é o Amazon SES, no mesmo
// ecossistema da infraestrutura. Antes do primeiro evento real, a conta
// precisa sair do modo sandbox (ver Seção 12 do documento de arquitetura).
//
// Todo envio passa por retry com backoff, porque contas novas no SES
// têm uma taxa inicial de referência (~14 e-mails/segundo) e rajadas
// grandes de convites podem esbarrar nesse limite momentaneamente.
// =====================================================================

const { SESClient, SendEmailCommand } = require("@aws-sdk/client-ses");

const ses = new SESClient({ region: process.env.AWS_REGION || "sa-east-1" });
const REMETENTE = process.env.EMAIL_REMETENTE || "acesso@conforto-habitat.com.br";

async function enviarComRetry(params, tentativas = 3) {
  for (let i = 0; i < tentativas; i++) {
    try {
      return await ses.send(new SendEmailCommand(params));
    } catch (err) {
      const éLimiteDeTaxa = err.name === "Throttling" || err.name === "ThrottlingException";
      if (éLimiteDeTaxa && i < tentativas - 1) {
        const esperaMs = 300 * Math.pow(2, i); // backoff exponencial: 300ms, 600ms, 1200ms...
        await new Promise((r) => setTimeout(r, esperaMs));
        continue;
      }
      // Sem SES configurado (dev local) — imprime o conteúdo no terminal em vez de falhar.
      console.log(`\n[email não enviado — SES indisponível] Para: ${params.Destination.ToAddresses[0]}`);
      console.log(params.Message.Body.Text.Data + "\n");
      return;
    }
  }
}

async function enviarConviteAdmin(email, linkAtivacao) {
  return enviarComRetry({
    Source: REMETENTE,
    Destination: { ToAddresses: [email] },
    Message: {
      Subject: { Data: "Convite — Portal de gerenciamento Conversas de Conforto Habitat" },
      Body: { Text: { Data: `Você foi convidado a administrar o portal Conversas de Conforto Habitat.\n\nDefina sua senha em: ${linkAtivacao}` } },
    },
  });
}

module.exports = { enviarConviteAdmin };
