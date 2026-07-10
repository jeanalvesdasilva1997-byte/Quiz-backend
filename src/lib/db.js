// =====================================================================
// lib/db.js — Conexão com o banco (Amazon RDS / PostgreSQL)
// =====================================================================
// Em Lambda, o pool é reaproveitado entre invocações "quentes" do
// mesmo container — por isso ele é criado fora do handler.
// Credenciais vêm de variáveis de ambiente (nunca hardcoded).
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
      ssl: { rejectUnauthorized: true }, // RDS exige TLS
      max: 3, // Lambda: manter baixo, cada execução concorrente abre seu próprio pool
      idleTimeoutMillis: 30000,
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
