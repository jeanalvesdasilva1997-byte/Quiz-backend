// =====================================================================
// lib/auth.js — OTP, sessão referenciada no servidor, senha e 2FA
// =====================================================================
// Decisões de arquitetura aplicadas aqui:
//  - Sessão é um token opaco guardado no banco (não JWT autocontido),
//    para que uma revogação pelo admin tenha efeito imediato.
//  - Código OTP: 6 dígitos, validade de 10 minutos, uso único.
//  - Senha do admin: 3 tentativas, depois bloqueia até reset por e-mail.
//  - Nunca comparar hash em texto puro — sempre com bcrypt / timing-safe.
// =====================================================================

const crypto = require("crypto");
const bcrypt = require("bcryptjs");

const OTP_TTL_MINUTOS = 10;
const OTP_TAMANHO = 6;
const SESSAO_HORAS_PARTICIPANTE = 24;
const SESSAO_HORAS_ADMIN = 12; // sessão do admin não segue a janela de 24h do evento
const MAX_TENTATIVAS_SENHA_ADMIN = 3;

function gerarCodigoOtp() {
  const min = 10 ** (OTP_TAMANHO - 1);
  const max = 10 ** OTP_TAMANHO - 1;
  const codigo = crypto.randomInt(min, max).toString();
  return codigo;
}

function gerarTokenOpaco() {
  return crypto.randomBytes(32).toString("hex");
}

async function hash(valor) {
  return bcrypt.hash(valor, 12);
}

async function verificarHash(valor, hashArmazenado) {
  return bcrypt.compare(valor, hashArmazenado);
}

function otpExpiraEm() {
  return new Date(Date.now() + OTP_TTL_MINUTOS * 60 * 1000);
}

function sessaoExpiraEm(tipo) {
  const horas = tipo === "participante" ? SESSAO_HORAS_PARTICIPANTE : SESSAO_HORAS_ADMIN;
  return new Date(Date.now() + horas * 60 * 60 * 1000);
}

// Cookie httpOnly + secure — o navegador nunca expõe isso a JavaScript,
// reduzindo a superfície de roubo de sessão via XSS.
function cookieDeSessao(nome, token, expiraEm) {
  const maxAge = Math.floor((expiraEm.getTime() - Date.now()) / 1000);
  return `${nome}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}

module.exports = {
  OTP_TTL_MINUTOS,
  MAX_TENTATIVAS_SENHA_ADMIN,
  gerarCodigoOtp,
  gerarTokenOpaco,
  hash,
  verificarHash,
  otpExpiraEm,
  sessaoExpiraEm,
  cookieDeSessao,
};
