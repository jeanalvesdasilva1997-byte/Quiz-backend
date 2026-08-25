// =====================================================================
// lib/email.js — Envio de e-mail (sem provedor real por enquanto)
// =====================================================================
// Projeto sem integração com AWS (roda no Vercel, não em EC2 com IAM
// role) — decisão explícita de não usar SES aqui. Enquanto não houver
// um provedor definido, o "envio" só imprime o conteúdo no log do
// servidor; quem chama essas funções (convite de admin, reset de senha)
// não muda, então trocar por um provedor real no futuro é só reescrever
// o corpo desta função, sem tocar nos handlers.
// =====================================================================

const REMETENTE = process.env.EMAIL_REMETENTE || "acesso@conforto-habitat.com.br";

async function enviarConviteAdmin(email, linkAtivacao) {
  console.log(`\n[e-mail não enviado — sem provedor configurado] De: ${REMETENTE} Para: ${email}`);
  console.log(`Você foi convidado a administrar o portal Conversas de Conforto Habitat.\n\nDefina sua senha em: ${linkAtivacao}\n`);
}

module.exports = { enviarConviteAdmin };
