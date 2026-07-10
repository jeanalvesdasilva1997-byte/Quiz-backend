// =====================================================================
// server.js — Servidor Express para EC2 (adapta os handlers Lambda
// existentes, sem reescrever a lógica de negócio de cada um).
// =====================================================================
// Por que esse arquivo existe: os handlers em src/handlers/*.js foram
// escritos no formato Lambda + API Gateway (event) => {statusCode,
// headers, body}. Depois de migrar de Lambda/API Gateway para uma
// instância EC2 única (decisão tomada por custo), a forma mais simples
// de reaproveitar 100% da lógica já escrita é "traduzir" cada
// requisição HTTP normal (Express req/res) para o formato de "event"
// que os handlers já esperam, e traduzir o retorno de volta.
//
// Nenhuma regra de negócio muda — só a camada de entrada/saída.
// =====================================================================

const express = require("express");

const participanteAuth = require("./handlers/participanteAuth");
const participanteJornada = require("./handlers/participanteJornada");
const adminAuth = require("./handlers/adminAuth");
const turmas = require("./handlers/turmas");
const participantesAdmin = require("./handlers/participantesAdmin");
const monitoramento = require("./handlers/monitoramento");
const conteudo = require("./handlers/conteudo");
const relatorio = require("./handlers/relatorio");
const acesso = require("./handlers/acesso");

const app = express();
app.use(express.json());

const ORIGEM_PERMITIDA = process.env.FRONTEND_ORIGIN || "https://treinamento.neratreinamento.com.br";

// CORS + cookies cross-origin (frontend e backend em subdomínios diferentes)
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", ORIGEM_PERMITIDA);
  res.header("Access-Control-Allow-Credentials", "true");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

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
app.post("/participante/solicitar-codigo", adaptar(participanteAuth.solicitarCodigo));
app.post("/participante/confirmar-codigo", adaptar(participanteAuth.confirmarCodigo));
app.get("/participante/painel", adaptar(participanteJornada.painel));
app.get("/participante/questao-atual", adaptar(participanteJornada.questaoAtual));
app.post("/participante/responder", adaptar(participanteJornada.responder));

// ---------------- Admin — autenticação ----------------
app.post("/admin/login", adaptar(adminAuth.login));
app.post("/admin/confirmar-2fa", adaptar(adminAuth.confirmar2fa));
app.post("/admin/solicitar-reset-senha", adaptar(adminAuth.solicitarResetSenha));
app.post("/admin/redefinir-senha", adaptar(adminAuth.redefinirSenha));

// ---------------- Admin — turmas ----------------
app.get("/admin/turmas", adaptar(turmas.listar));
app.post("/admin/turmas/conferir", adaptar(turmas.conferir));
app.post("/admin/turmas", adaptar(turmas.criar));

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

// ---------------- Admin — relatório ----------------
app.get("/admin/relatorio/:turmaId", adaptar(relatorio.gerar));
app.get("/admin/relatorio/:turmaId/csv", adaptar(relatorio.exportarCsv));
app.post("/admin/relatorio/:turmaId/enviar-rh", adaptar(relatorio.enviarAoRh));

// ---------------- Admin — gestão de acesso (Owner) ----------------
app.get("/admin/equipe", adaptar(acesso.listarEquipe));
app.post("/admin/equipe/convidar", adaptar(acesso.convidar));
app.delete("/admin/equipe/:id", adaptar(acesso.remover));
app.get("/admin/log-auditoria", adaptar(acesso.logAuditoria));

// Healthcheck simples — útil para o smoke test do dia do evento
app.get("/health", (req, res) => res.json({ status: "ok" }));

const PORTA = process.env.PORT || 3000;
app.listen(PORTA, () => {
  console.log(`Servidor rodando na porta ${PORTA}`);
});
