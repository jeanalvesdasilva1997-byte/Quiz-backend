// =====================================================================
// lib/db.js — Conexão com o banco (Postgres — Neon)
// =====================================================================
// Em ambiente serverless (Vercel), o pool é reaproveitado entre
// invocações "quentes" da mesma função — por isso ele é criado fora
// do handler. Credenciais vêm de variáveis de ambiente (nunca hardcoded).
// =====================================================================

const { Pool } = require("pg");

let pool;

function getPool() {
  if (!pool) {
    pool = new Pool({
      host: process.env.DB_HOST,
      port: process.env.DB_PORT || 5432,
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      ssl: { rejectUnauthorized: true }, // Neon exige TLS
      max: 3, // serverless: manter baixo, cada execução concorrente abre seu próprio pool
      idleTimeoutMillis: 30000,
    });

    // Sem esse listener, um cliente ocioso derrubado pelo lado do banco
    // (comportamento normal do Neon) vira uma exceção não tratada e
    // derruba o processo inteiro — não é erro de query, é erro de fundo
    // do pool, então só logamos e seguimos.
    pool.on("error", (err) => {
      console.error("Erro inesperado em cliente ocioso do pool do Postgres:", err.message);
    });
  }
  return pool;
}

async function query(text, params) {
  const client = await getPool().connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

// Helper para transações (usado em fluxos que precisam de "tudo ou nada",
// como confirmar upload de turma, ou o cadastro no dia + envio de código)
async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { query, withTransaction, getPool };
