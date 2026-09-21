// =====================================================================
// server.js — App Express (adapta os handlers Lambda existentes, sem
// reescrever a lógica de negócio de cada um). Roda tanto localmente/EC2
// (node src/server.js escuta uma porta) quanto no Vercel (api/index.js
// importa o `app` exportado aqui e o Vercel chama como função serverless,
// sem precisar de app.listen — ver bloco no fim do arquivo).
// =====================================================================
// Por que esse arquivo existe: os handlers em src/handlers/*.js foram
// escritos no formato Lambda + API Gateway (event) => {statusCode,
// headers, body}. A forma mais simples de reaproveitar 100% da lógica já
// escrita, seja atrás de EC2/Nginx ou de função serverless do Vercel, é
// "traduzir" cada requisição HTTP normal (Express req/res) para o formato
// de "event" que os handlers já esperam, e traduzir o retorno de volta.
//
// Nenhuma regra de negócio muda — só a camada de entrada/saída.
// =====================================================================

require("dotenv").config();

const express = require("express");
const rateLimit = require("express-rate-limit");

const participanteAuth = require("./handlers/participanteAuth");
const participanteJornada = require("./handlers/participanteJornada");
const quizAoVivo = require("./handlers/quizAoVivo");
const adminAuth = require("./handlers/adminAuth");
const turmas = require("./handlers/turmas");
const participantesAdmin = require("./handlers/participantesAdmin");
const monitoramento = require("./handlers/monitoramento");
const conteudo = require("./handlers/conteudo");
const relatorio = require("./handlers/relatorio");
const acesso = require("./handlers/acesso");

const app = express();

// Nginx faz proxy reverso na frente do Express (1 salto) — sem isso,
// express-rate-limit enxergaria sempre o IP do Nginx e trataria todo
// mundo atrás dele como um usuário só.
app.set("trust proxy", 1);

app.use(express.json());

const ORIGENS_PERMITIDAS = (process.env.FRONTEND_ORIGIN || "https://treinamento.conforto-habitat.com.br")
  .split(",")
  .map((o) => o.trim());

// CORS + cookies cross-origin (frontend e backend em subdomínios diferentes)
app.use((req, res, next) => {
  if (ORIGENS_PERMITIDAS.includes(req.headers.origin)) {
    res.header("Access-Control-Allow-Origin", req.headers.origin);
  }
  res.header("Access-Control-Allow-Credentials", "true");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// -----------------------------------------------------------------
// Rate limiting — dois níveis:
// - geral: barra abuso/DoS grosseiro, mas generoso o bastante pra não
//   atrapalhar o polling normal do quiz ao vivo (participante e admin
//   consultam o estado a cada 2-4s).
// - login: bem mais estrito, só nas rotas de autenticação/senha, que
//   são o alvo real de força bruta.
// -----------------------------------------------------------------
const limitadorGeral = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({ erro: "Muitas requisições. Aguarde um instante e tente novamente." });
  },
});

const limitadorLogin = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({ erro: "Muitas tentativas. Aguarde alguns minutos antes de tentar novamente." });
  },
});

app.use(limitadorGeral);

// -----------------------------------------------------------------
// Adaptador: transforma (req, res) em chamada ao handler no formato
// Lambda, e devolve a resposta do handler como resposta HTTP normal.
// -----------------------------------------------------------------
function adaptar(handler) {
  return async (req, res) => {
    const event = {
      body: JSON.stringify(req.body || {}),
      headers: req.headers, // já inclui "cookie" em minúsculo, como o parseCookies espera
      pathParameters: req.params,
      queryStringParameters: req.query,
    };

    let resultado;
    try {
      resultado = await handler(event);
    } catch (err) {
      // Rede de segurança — nenhum handler deveria deixar escapar um
      // erro não tratado, mas se acontecer, não derruba o processo.
      console.error("Erro não tratado no handler:", err);
      return res.status(500).json({ erro: "Erro interno. Tente novamente em instantes." });
    }

    res.status(resultado.statusCode);
    if (resultado.headers) {
      for (const [chave, valor] of Object.entries(resultado.headers)) {
        if (chave.toLowerCase() === "set-cookie") {
          res.append("Set-Cookie", valor);
        } else {
          res.set(chave, valor);
        }
      }
    }
    res.send(resultado.body);
  };
}

// =====================================================================
// Rotas — mesmo mapeamento que estava em serverless.yml, só que aqui
// direto no Express (chaves {id} do API Gateway viram :id no Express).
// =====================================================================

// ---------------- Participante ----------------
app.post("/participante/verificar-email", limitadorLogin, adaptar(participanteAuth.verificarEmail));
app.post("/participante/definir-senha", limitadorLogin, adaptar(participanteAuth.definirSenha));
app.post("/participante/login", limitadorLogin, adaptar(participanteAuth.login));
app.get("/participante/painel", adaptar(participanteJornada.painel));
app.post("/participante/consentimento-nera", adaptar(participanteJornada.registrarConsentimentoNera));
app.get("/participante/quiz-estado", adaptar(quizAoVivo.estadoParticipante));
app.post("/participante/responder", adaptar(quizAoVivo.responder));

// ---------------- Admin — autenticação ----------------
app.post("/admin/login", limitadorLogin, adaptar(adminAuth.login));
app.post("/admin/solicitar-reset-senha", limitadorLogin, adaptar(adminAuth.solicitarResetSenha));
app.post("/admin/redefinir-senha", limitadorLogin, adaptar(adminAuth.redefinirSenha));

// ---------------- Admin — turmas ----------------
app.get("/admin/turmas", adaptar(turmas.listar));
app.post("/admin/turmas/conferir", adaptar(turmas.conferir));
app.post("/admin/turmas", adaptar(turmas.criar));
app.post("/admin/turmas/:id/ativar", adaptar(turmas.ativar));
app.post("/admin/turmas/:id/encerrar", adaptar(turmas.encerrar));

// ---------------- Admin — quiz ao vivo (condução da prova) ----------------
app.get("/admin/turmas/:id/quiz", adaptar(quizAoVivo.estadoAoVivo));
app.post("/admin/turmas/:id/quiz/iniciar-fase1", adaptar(quizAoVivo.iniciarFase1));
app.post("/admin/turmas/:id/quiz/proxima", adaptar(quizAoVivo.proximaPergunta));
app.post("/admin/turmas/:id/quiz/liberar-fase2", adaptar(quizAoVivo.liberarFase2));
app.post("/admin/turmas/:id/quiz/liberar-podio1", adaptar(quizAoVivo.liberarPodio1));
app.post("/admin/turmas/:id/quiz/liberar-podio2", adaptar(quizAoVivo.liberarPodio2));

// ---------------- Admin — cadastro no dia / liberação manual ----------------
app.post("/admin/cadastro-no-dia", adaptar(participantesAdmin.cadastroNoDia));
app.post("/admin/liberar-manualmente", adaptar(participantesAdmin.liberarManualmente));

// ---------------- Admin — monitoramento ----------------
app.get("/admin/turmas-ativas", adaptar(monitoramento.turmasAtivas));
app.get("/admin/monitoramento/:turmaId", adaptar(monitoramento.monitorar));

// ---------------- Admin — conteúdo ----------------
app.get("/admin/conteudo", adaptar(conteudo.listar));
app.post("/admin/conteudo", adaptar(conteudo.criar));
app.put("/admin/conteudo/:id", adaptar(conteudo.editar));
app.post("/admin/modulos", adaptar(conteudo.criarModulo));

// ---------------- Admin — relatório ----------------
app.get("/admin/relatorio/:turmaId", adaptar(relatorio.gerar));
app.get("/admin/relatorio/:turmaId/xlsx", adaptar(relatorio.exportarXlsx));

// ---------------- Admin — gestão de acesso (Owner) ----------------
app.get("/admin/equipe", adaptar(acesso.listarEquipe));
app.post("/admin/equipe/convidar", adaptar(acesso.convidar));
app.delete("/admin/equipe/:id", adaptar(acesso.remover));
app.get("/admin/log-auditoria", adaptar(acesso.logAuditoria));

// Healthcheck simples — útil para o smoke test do dia do evento
app.get("/health", (req, res) => res.json({ status: "ok" }));

// No Vercel, quem recebe a requisição é a função serverless (api/index.js),
// não este processo — chamar app.listen() ali não faz sentido (não existe
// porta pra abrir) e o próprio Vercel seta a env var VERCEL nesse ambiente.
// Local/EC2 continuam subindo normalmente com `node src/server.js`.
if (!process.env.VERCEL) {
  const PORTA = process.env.PORT || 3000;
  app.listen(PORTA, () => {
    console.log(`Servidor rodando na porta ${PORTA}`);
  });
}

module.exports = app;
