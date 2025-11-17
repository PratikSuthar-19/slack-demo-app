// db.js
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  user: process.env.PG_USER || 'postgres',
  host: process.env.PG_HOST || 'localhost',
  database: process.env.PG_DATABASE || 'slackdb',
  password: process.env.PG_PASSWORD || '',
  port: process.env.PG_PORT ? Number(process.env.PG_PORT) : 5432,
});

async function initDB() {
  const create = `
    CREATE TABLE IF NOT EXISTS daily_stats (
      id SERIAL PRIMARY KEY,
      report_time TIMESTAMP NOT NULL DEFAULT NOW(),
      channel_id TEXT NOT NULL,
      total_messages INT,
      total_reactions INT,
      total_users INT,
      most_active_user TEXT,
      top_emoji TEXT
    );
  `;
  await pool.query(create);
  console.log('✅ daily_stats table ready');
}

initDB().catch(err => {
  console.error('DB init error', err);
  process.exit(1);
});

module.exports = pool;
