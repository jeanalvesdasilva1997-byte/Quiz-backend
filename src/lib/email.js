// =====================================================================
// lib/email.js — Envio de e-mail via Amazon SES
// =====================================================================
// Decisão de arquitetura: provedor de e-mail é o Amazon SES, no mesmo
// ecossistema da infraestrutura. Antes do primeiro evento real, a conta
// precisa sair do modo sandbox (ver Seção 12 do documento de arquitetura).
//
// Todo envio passa por retry com backoff, porque contas novas no SES
// têm uma taxa inicial de referência (~14 e-mails/segundo) e rajadas
// grandes (ex: 200 participantes pedindo código ao mesmo tempo) podem
// esbarrar nesse limite momentaneamente.
// =====================================================================

const { SESClient, SendEmailCommand } = require("@aws-sdk/client-ses");

const ses = new SESClient({ region: process.env.AWS_REGION || "sa-east-1" });
const REMETENTE = process.env.EMAIL_REMETENTE || "acesso@neratreinamento.com.br";

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
      throw err;
    }
  }
}

async function enviarCodigoParticipante(email, codigo, nomeTurma) {
  return enviarComRetry({
    Source: REMETENTE,
    Destination: { ToAddresses: [email] },
    Message: {
      Subject: { Data: `Seu código de acesso — ${nomeTurma}` },
      Body: {
        Text: {
          Data:
            `Seu código de acesso ao treinamento é: ${codigo}\n\n` +
            `Ele é válido por 10 minutos. Se você não solicitou este código, ignore este e-mail.\n\n` +
            `Seu nome e e-mail são usados apenas para o acesso a este treinamento e removidos após a janela de 24h.`,
        },
      },
    },
  });
}

async function enviarCodigoAdmin(email, codigo) {
  return enviarComRetry({
    Source: REMETENTE,
    Destination: { ToAddresses: [email] },
    Message: {
      Subject: { Data: "Código de confirmação — Portal Nera treinamento" },
      Body: { Text: { Data: `Seu código de confirmação é: ${codigo}\n\nVálido por 10 minutos.` } },
    },
  });
}

async function enviarConviteAdmin(email, linkAtivacao) {
  return enviarComRetry({
    Source: REMETENTE,
    Destination: { ToAddresses: [email] },
    Message: {
      Subject: { Data: "Convite — Portal de gerenciamento Nera treinamento" },
      Body: { Text: { Data: `Você foi convidado a administrar o portal Nera treinamento.\n\nDefina sua senha em: ${linkAtivacao}` } },
    },
  });
}

module.exports = { enviarCodigoParticipante, enviarCodigoAdmin, enviarConviteAdmin };
