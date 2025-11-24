// db.js
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  user: process.env.PG_USER || 'postgres',
  host: process.env.PG_HOST || 'localhost',
  database: process.env.PG_DATABASE || 'slackdb',
  password: process.env.PG_PASSWORD || '',
  port: process.env.PG_PORT ? Number(process.env.PG_PORT) : 5432,
//    ssl: {
//     rejectUnauthorized: false, // needed for Render cloud
//   },
});

async function initDailyStats() {
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

async function initSentimentTable() {
  const create = `
    CREATE TABLE IF NOT EXISTS sentiment_analysis (
  id SERIAL PRIMARY KEY,
  slack_post_id TEXT UNIQUE,
  channel_id TEXT NOT NULL,
  channel_name TEXT,
  sentiment_score NUMERIC,
  sentiment_label TEXT,
  total_comments INT,
  total_reactions INT,
  analyzed_at TIMESTAMP NOT NULL DEFAULT NOW()
);
  `;
  await pool.query(create);
  console.log("✅ slack_sentiment_logs table ready");
}

// Create slack_messages table
async function initSlackMessages() {

const create = `
    CREATE TABLE IF NOT EXISTS slack_messages (
      id BIGSERIAL PRIMARY KEY,
      slack_ts TEXT NOT NULL,
      slack_msg_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      channel_name TEXT,
      user_id TEXT,
      user_name TEXT,
      text TEXT,
      raw_json JSONB,
      received_at TIMESTAMPTZ DEFAULT NOW(),
      processed BOOLEAN DEFAULT FALSE,
      sentiment_label TEXT,
      sentiment_score REAL,
      sentiment_model TEXT,
      processed_at TIMESTAMPTZ,
      thread_ts TEXT,
      
      -- Unique constraint for ON CONFLICT
      CONSTRAINT unique_slack_msg_id UNIQUE (slack_msg_id)
    );

    CREATE INDEX IF NOT EXISTS idx_slack_messages_channel 
      ON slack_messages(channel_id);

    CREATE INDEX IF NOT EXISTS idx_slack_messages_processed 
      ON slack_messages(processed);
  `;

//   const create = `
//     CREATE TABLE IF NOT EXISTS slack_messages (
//       id BIGSERIAL PRIMARY KEY,
//       slack_ts TEXT NOT NULL,
//       slack_msg_id TEXT,
//       channel_id TEXT NOT NULL,
//       channel_name TEXT,
//       user_id TEXT,
//       user_name TEXT,
//       text TEXT,
//       raw_json JSONB,
//       received_at TIMESTAMPTZ DEFAULT NOW(),
//       processed BOOLEAN DEFAULT FALSE,
//       sentiment_label TEXT,
//       sentiment_score REAL,
//       sentiment_model TEXT,
//       processed_at TIMESTAMPTZ,
//       thread_ts TEXT,
      
//       -- ⭐ REQUIRED FOR ON CONFLICT(slack_ts)
//       CONSTRAINT unique_slack_ts UNIQUE (slack_ts)
//     );

//     CREATE INDEX IF NOT EXISTS idx_slack_messages_channel 
//       ON slack_messages(channel_id);

//     CREATE INDEX IF NOT EXISTS idx_slack_messages_processed 
//       ON slack_messages(processed);
//   `;


  await pool.query(create);
  console.log('✅ slack_messages table ready');
}

// initDB().catch(err => {
//   console.error('DB init error', err);
//   process.exit(1);
// });

async function initDB() {
  await initDailyStats();
  await initSlackMessages();
  await initSentimentTable();
}

initDB().catch(err => {
  console.error('DB init error', err);
  process.exit(1);
});

module.exports = pool;
