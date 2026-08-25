// Entrypoint da função serverless do Vercel — tudo que existe é reexportar
// o app Express já configurado em src/server.js (rotas, CORS, rate limit).
// O vercel.json manda toda requisição pra cá, então o próprio Express
// resolve as rotas internamente a partir de req.url.
module.exports = require("../src/server");
