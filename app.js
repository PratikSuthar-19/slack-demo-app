// app.js
const { App, ExpressReceiver } = require("@slack/bolt");
const { google } = require("googleapis");
const pool = require('./db');
const vader = require('vader-sentiment');
const generateSlackStats = require('./analytics');
const cron = require('node-cron')
const fs = require("fs");
const Sentiment = require("sentiment");
const emojiSentiment = require("emoji-sentiment");
const emoji = require("node-emoji");
// const emojiSentiment =require("emoji-sentiment");
// const emoji  =require("emoji-dictionary");

// const sentiment = require("sentiment");
//const emojiSentiment = require("emoji-sentiment");
const emojiLib = require("emoji-dictionary"); 
const emojiEmotion = require("emoji-emotion");
// const fetch = require ("node-fetch");



const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));


const sentiment = new Sentiment();
require("dotenv").config();


// 1️⃣ Express receiver
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

// 2️⃣ Initialize Bolt app
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

// 3️⃣ Google Sheets setup
const auth = new google.auth.GoogleAuth({
  keyFile: "credentials.json",
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

// 4️⃣ Expose /slack/events
receiver.router.post("/slack/events", (req, res) => {
  res.status(200).send();
});


(async () => {
  try {
    const res = await pool.query('SELECT NOW()');
    console.log('Connected to DB:', res.rows[0]);
  } catch (err) {
    console.error('DB Connection Error:', err);
  }
})();



// async function analyzeSentiment(text) {
//   const result = sentiment.analyze(text);
//   // result.score = -ve for negative, +ve for positive
//   // result.comparative = normalized score
//   return result.score;
// }




// helper: save to DB
async function saveToDB(channelId, stats) {
  const q = `INSERT INTO daily_stats (channel_id, total_messages, total_reactions, total_users, most_active_user, top_emoji)
             VALUES ($1,$2,$3,$4,$5,$6)`;
  const values = [
    channelId,
    stats.totalMessages,
    stats.totalReactions,
    stats.totalUsers,
    stats.mostActiveUser,
    stats.topEmoji
  ];
  await pool.query(q, values);
}

// helper: format and post
async function postSummary(channelId, stats, client, title = 'Last 24 hours report') {
  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${title}*\n\n💬 *Messages:* ${stats.totalMessages}\n😀 *Reactions:* ${stats.totalReactions}\n👥 *Active users:* ${stats.totalUsers}\n${stats.mostActiveUser ? `🏆 *Top user:* <@${stats.mostActiveUser}>\n` : ''}${stats.topEmoji ? `🔥 *Top emoji:* :${stats.topEmoji}:\n` : ''}`
      }
    }
  ];

  await client.chat.postMessage({
    channel: channelId,
    text: `${title} — summary`,
    blocks
  });
}



// ----------------------------------------------
// SHORTCUT: Sentiment Analysis
// ----------------------------------------------

async function analyzeSentiment(text, reactions) {

  // --- TEXT SCORE ---
  const baseScore = sentiment.analyze(text).score;
  console.log("text score", baseScore);


  // --- EMOJI SCORE (emoji names → text) ---
  let emojiScore = 0;

  reactions.forEach(r => {
    try {
      // Convert slack emoji name → normal words
      const words = r.name.replace(/_/g, " ");

   

      // Analyze like normal English text
      const score = sentiment.analyze(words).score;

      console.log(`emoji: ${r.name} → "${words}" → score: ${score} `)

      // Multiply by count
      emojiScore += score * r.count;

    } catch (err) {
      console.error("Emoji sentiment error:", err);
    }
  });

  console.log("emoji score", emojiScore);


  // ----- FINAL SCORE -----
  const finalScore = baseScore + emojiScore;

  return {
    score: finalScore,
    label:
      finalScore > 0 ? "Positive" :
      finalScore < 0 ? "Negative" :
      "Neutral",
    emoji:
      finalScore > 0 ? "🟢" :
      finalScore < 0 ? "🔴" :
      "🟡"
  };
}




// --------------------------------------------------
// SENTIMENT ANALYSIS (input = combinedText + reactions)
// --------------------------------------------------
async function analyzeSentimentSimple(combinedText, reactions = []) {
  try {
    // Convert emoji → words
    let emojiWords = [];
    reactions.forEach(r => {
      const words = r.name.replace(/_/g, " ");
      for (let i = 0; i < r.count; i++) {
        emojiWords.push(words);
      }
    });

    const finalText = [
      combinedText || "",
      ...emojiWords,
    ].join(" ");

    console.log("Final text sent to AI model:", finalText);

    // HF API CALL
    const hfRes = await fetch(
      "https://router.huggingface.co/hf-inference/models/cardiffnlp/twitter-roberta-base-sentiment-latest",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.HF_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ inputs: finalText })
      }
    );

    const data = await hfRes.json();
    console.log("HF raw response:", data);

    if (!hfRes.ok) {
      console.error("HF API error:", data);
      return { score: 0, label: "Neutral", emoji: "🟡" };
    }

    // -------------------------------------------
    // SAFE EXTRACTION (Handles ALL HF formats)
    // -------------------------------------------

    let predictions = null;

    if (Array.isArray(data)) {
      // Format A → [[{label,score},..]]
      if (Array.isArray(data[0])) {
        predictions = data[0];
      }
      // Format B → [{label,score},..]
      else if (data[0].label) {
        predictions = data;
      }
    }

    if (!predictions) {
      console.error("Unexpected HF output:", data);
      return { score: 0, label: "Neutral", emoji: "🟡" };
    }

    // Find highest score
    const result = predictions.sort((a, b) => b.score - a.score)[0];
    const predicted = result.label.toUpperCase();
    const confidence = result.score;

    // numeric 5-point scale
    const score =
      predicted === "POSITIVE" ? confidence * 5 :
      predicted === "NEGATIVE" ? confidence * -5 :
      0;

    return {
      score,
      label: predicted,
      emoji:
        predicted === "POSITIVE" ? "🟢" :
        predicted === "NEGATIVE" ? "🔴" :
        "🟡"
    };

  } catch (err) {
    console.error("Sentiment error:", err);
    return { score: 0, label: "Neutral", emoji: "🟡" };
  }
}


// async function analyzeSentiment(text, reactions) {
//   // Text sentiment
//   const baseScore = sentiment.analyze(text).score;

//   console.log("text score" , baseScore);

//   // Emoji sentiment
//   let emojiScore = 0;

//   reactions.forEach(r => {
//     try {
//       // const es = emojiSentiment(r.name); // r.name = "thumbsup", "crying", etc.
//       console.log(r.name);
//         const es = sentiment.analyze(r.name).score; // r.name = "thumbsup", "crying", etc.
//           console.log(es);
//       emojiScore += (es ? es.score : 0) * r.count;
//     } catch (_) {}
//   });

//   console.log("emogi score" , emojiScore);

//   // Final combined score
//   const finalScore = baseScore + emojiScore;

//   return {
//     score: finalScore,
//     label:
//       finalScore > 0 ? "Positive" :
//       finalScore < 0 ? "Negative" :
//       "Neutral",
//     emoji:
//       finalScore > 0 ? "🟢" :
//       finalScore < 0 ? "🔴" :
//       "🟡"
//   };
// }

app.shortcut("sentiment_analysis_shortcut", async ({ shortcut, ack, client }) => {

  // 1️⃣ ACK IMMEDIATELY
  await ack();

  // 2️⃣ OPEN LOADING MODAL
  const modal = await client.views.open({
    trigger_id: shortcut.trigger_id,
    view: {
      type: "modal",
      title: { type: "plain_text", text: "Sentiment Analysis" },
      close: { type: "plain_text", text: "Close" },
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: "⏳ *Analyzing sentiment… please wait...*" }
        }
      ]
    },
  });

  // 3️⃣ DO WORK ASYNC (avoid Slack 3 sec timeout)
  setTimeout(async () => {
    try {
      const channelId = shortcut.channel.id;
      const messageTs = shortcut.message.ts;

      // Fetch original post
      const messageRes = await client.conversations.history({
        channel: channelId,
        latest: messageTs,
        inclusive: true,
        limit: 1,
      });
      const mainMessage = messageRes.messages[0];

      // Fetch all comments
      const repliesRes = await client.conversations.replies({
        channel: channelId,
        ts: messageTs,
      });
      const threadMessages = repliesRes.messages.slice(1).map(m => m.text);
      const threadCount = threadMessages.length;

      // Reactions
      const reactions = mainMessage.reactions || [];
      console.log("all reactions " , reactions);

      // Combine text + comments + emoji names
      const combinedText = [
        mainMessage.text || "",
        ...threadMessages,
        reactions.map(r => r.name.repeat(r.count)).join(" ")
      ].join(" ");

      // SENTIMENT SCORE
      const result = await analyzeSentiment(combinedText, reactions);
      //const result = await analyzeSentimentSimple(combinedText , reactions);
      console.log(result);
      const { score, label, emoji } = result;

      // UPSERT INTO DB
      await pool.query(
        `INSERT INTO sentiment_analysis 
          (slack_post_id, channel_id, sentiment_score, sentiment_label, total_comments, total_reactions)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (slack_post_id)
         DO UPDATE SET 
            sentiment_score = EXCLUDED.sentiment_score,
            sentiment_label = EXCLUDED.sentiment_label,
            total_comments = EXCLUDED.total_comments,
            total_reactions = EXCLUDED.total_reactions;`,
        [
          messageTs,
          channelId,
          score,
          label,
          threadCount,
          reactions.reduce((sum, r) => sum + r.count, 0)
        ]
      );

      // Build UI summary
      const reactionSummary =
        reactions.length === 0
          ? "No reactions"
          : reactions.map(r => `• *${r.name}* × ${r.count}`).join("\n");

      const commentsSummary =
        threadCount > 0 ? `${threadCount} comments analyzed` : "No comments";

      // 4️⃣ UPDATE MODAL WITH FINAL RESULT
      await client.views.update({
        view_id: modal.view.id,
        hash: modal.view.hash,
        view: {
          type: "modal",
          title: { type: "plain_text", text: "Sentiment Report" },
          close: { type: "plain_text", text: "Close" },
          blocks: [
            {
              type: "header",
              text: { type: "plain_text", text: `${emoji} Sentiment Result` }
            },
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `*Overall Sentiment:* ${emoji} *${label}*\n*Score:* \`${score.toFixed(2)}\``
              }
            },
            { type: "divider" },
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `*Message Insights*\n• ${commentsSummary}\n• Reactions:\n${reactionSummary}`
              }
            },
            { type: "divider" },
            {
              type: "context",
              elements: [
                {
                  type: "mrkdwn",
                  text: "_Sentiment score includes main text, thread comments & emoji reactions._"
                }
              ]
            }
          ]
        }
      });

    } catch (err) {
      console.error("Error inside sentiment analysis:", err);
    }
  }, 10);
});


// app.shortcut("sentiment_analysis_shortcut", async ({ shortcut, ack, client }) => {
//   try {
//     await ack();

//     // STEP 1: Show loading modal
//     const modal = await client.views.open({
//       trigger_id: shortcut.trigger_id,
//       view: {
//         type: "modal",
//         callback_id: "sentiment_modal",
//         title: { type: "plain_text", text: "Sentiment Analysis" },
//         close: { type: "plain_text", text: "Close" },
//         blocks: [
//           {
//             type: "section",
//             text: { type: "mrkdwn", text: "🔍 *Analyzing sentiment… please wait*" },
//           },
//           { type: "divider" },
//           {
//             type: "context",
//             elements: [
//               { type: "mrkdwn", text: "_This may take a few seconds..._" }
//             ]
//           }
//         ],
//       },
//     });

//     // STEP 2: Fetch original message
//     const channelId = shortcut.channel.id;
//     const messageTs = shortcut.message.ts;

//     const messageRes = await client.conversations.history({
//       channel: channelId,
//       latest: messageTs,
//       inclusive: true,
//       limit: 1,
//     });

//     const mainMessage = messageRes.messages[0];

//     // STEP 3: Fetch replies
//     const repliesRes = await client.conversations.replies({
//       channel: channelId,
//       ts: messageTs,
//     });

//     const threadMessages = repliesRes.messages.slice(1).map(m => m.text);
//     const threadCount = threadMessages.length;

//     // STEP 4: Reactions
//     const reactions = mainMessage.reactions || [];

//     // STEP 5: Prepare text for sentiment analysis
//     const combinedText = [
//       mainMessage.text || "",
//       ...threadMessages,
//       reactions.map(r => r.name.repeat(r.count)).join(" ")
//     ].join(" ");

//     // STEP 6: Run sentiment
//     const result = await analyzeSentiment(combinedText);
//     const { score, label, emoji } = result;

//     // Reaction summary for UI
//     const reactionSummary =
//       reactions.length === 0
//         ? "No reactions"
//         : reactions.map(r => `• *${r.name}* × ${r.count}`).join("\n");

//     const commentsSummary =
//       threadCount > 0 ? `${threadCount} comments included` : "No comments";

//     // STEP 7: Update modal with final result
//     await client.views.update({
//       view_id: modal.view.id,
//       hash: modal.view.hash,
//       view: {
//         type: "modal",
//         title: { type: "plain_text", text: "Sentiment Report" },
//         close: { type: "plain_text", text: "Close" },
//         blocks: [
//           {
//             type: "header",
//             text: { type: "plain_text", text: `${emoji} Sentiment Result` }
//           },

//           {
//             type: "section",
//             text: {
//               type: "mrkdwn",
//               text: `*Overall Sentiment:* ${emoji} *${label}*\n*Score:* \`${score.toFixed(2)}\``
//             }
//           },

//           { type: "divider" },

//           {
//             type: "section",
//             text: {
//               type: "mrkdwn",
//               text: `*Message Insights*\n• ${commentsSummary}\n• Reactions:\n${reactionSummary}`
//             }
//           },

//           { type: "divider" },

//           {
//             type: "context",
//             elements: [
//               {
//                 type: "mrkdwn",
//                 text: "_Sentiment score includes text, comments & emoji reactions._"
//               }
//             ]
//           }
//         ],
//       },
//     });

//   } catch (err) {
//     console.error("[ERROR] Sentiment Shortcut:", err);
//   }
// });

// /**
//  * SENTIMENT ANALYSIS LOGIC
//  */
// async function analyzeSentiment(text) {
//   const sentimentScore = sentiment.analyze(text).score;

//   // Emoji ► sentiment weights
//   const reactionWeights = {
//     "+1": 1,
//     "thumbsup": 1,
//     "heart": 2,
//     "laughing": 1,
//     "grinning": 1,

//     "-1": -2,
//     "thumbsdown": -2,
//     "angry": -2,
//     "rage": -3,
//     "sad": -1,
//   };

//   let reactionScore = 0;
//   const words = text.split(" ");

//   words.forEach(w => {
//     if (reactionWeights[w]) {
//       reactionScore += reactionWeights[w];
//     }
//   });

//   const finalScore = sentimentScore + reactionScore;

//   return {
//     score: finalScore,
//     label:
//       finalScore > 0 ? "Positive" :
//       finalScore < 0 ? "Negative" :
//       "Neutral",
//     emoji:
//       finalScore > 0 ? "🟢" :
//       finalScore < 0 ? "🔴" :
//       "🟡"
//   };
// }

app.event("message", async ({ event, client }) => {
  try {
    // Ignore bot messages
    if (event.subtype === "bot_message") return;

    const text = event.text || "";
    const ts = event.ts;
    const channelId = event.channel;
    const userId = event.user;

    // 🔹 Unique message ID
    const slackMsgId = `${channelId}-${ts}`;

    // 🔹 Get channel name
    let channelName = null;
    try {
      const channelInfo = await client.conversations.info({ channel: channelId });
      channelName = channelInfo.channel?.name || null;
    } catch {}

    // 🔹 Get user info
    let userName = null;
    if (userId) {
      try {
        const u = await client.users.info({ user: userId });
        userName = u.user?.real_name || u.user?.name || null;
      } catch {}
    }

    // 🔹 Sentiment analysis (VADER)
    const intensity = vader.SentimentIntensityAnalyzer.polarity_scores(text);
    const score = intensity.compound;
    let label = "NEUTRAL";
    if (score > 0.25) label = "POSITIVE";
    else if (score < -0.25) label = "NEGATIVE";

    // 🔹 Insert into PostgreSQL
    await pool.query(
      `INSERT INTO slack_messages
      (slack_ts, slack_msg_id, channel_id, channel_name,
       user_id, user_name, text, raw_json,
       processed, sentiment_label, sentiment_score, sentiment_model,
       processed_at, thread_ts)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,$9,$10,'VADER',NOW(),$11)
      ON CONFLICT (slack_msg_id) DO NOTHING`,
      [
        ts,
        slackMsgId,
        channelId,
        channelName,
        userId,
        userName,
        text,
        event,
        label,
        score,
        event.thread_ts || null
      ]
    );

    console.log("💾 Message saved:", text);

  } catch (err) {
    console.error("❌ Error inserting message:", err);
  }
});


// app.event("message", async ({ event, client }) => {
//   try {
//     // Ignore bot messages
//     if (event.subtype === "bot_message") return;

//     const text = event.text || "";
//     const ts = event.ts;
//     const channelId = event.channel;
//     const userId = event.user;

//     // 🔹 Get channel name
//     const channelInfo = await client.conversations.info({ channel: channelId });
//     const channelName = channelInfo.channel?.name || null;

//     // 🔹 Fetch user info
//     let userName = null;
//     if (userId) {
//       try {
//         const u = await client.users.info({ user: userId });
//         userName = u.user?.real_name || u.user?.name || null;
//       } catch (e) {
//         userName = null;
//       }
//     }

//     // 🔹 Local sentiment
//     let intensity = vader.SentimentIntensityAnalyzer.polarity_scores(text);
//     let score = intensity.compound;
//     let label = "NEUTRAL";

//     if (score > 0.25) label = "POSITIVE";
//     else if (score < -0.25) label = "NEGATIVE";

//     // 🔹 Insert into DB
//     await pool.query(
//       `INSERT INTO slack_messages
//       (slack_ts, slack_msg_id, channel_id, channel_name,
//        user_id, user_name, text, raw_json,
//        processed, sentiment_label, sentiment_score, sentiment_model,
//        processed_at, thread_ts)
//       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,$9,$10,'VADER',NOW(),$11)
//       ON CONFLICT (slack_ts) DO NOTHING`,
//       [
//         ts,
//         `${channelId}-${ts}`,
//         channelId,
//         channelName,
//         userId,
//         userName,
//         text,
//         event,
//         label,
//         score,
//         event.thread_ts || null
//       ]
//     );

//     console.log("💾 Message saved:", text);

//   } catch (err) {
//     console.error("❌ Error inserting message:", err);
//   }
// });


// SLASH COMMAND: /syncmessages
app.command("/syncmessages", async ({ ack, respond, body, client }) => {
  await ack();

  try {
    const channelId = body.channel_id;

    // 🔹 Get channel name
    const channelInfo = await client.conversations.info({ channel: channelId });
    const channelName = channelInfo.channel?.name || null;

    // 🔹 Fetch last 500 messages (increase if needed)
    const history = await client.conversations.history({
      channel: channelId,
      limit: 500,
    });

    const messages = history.messages || [];
    let processedCount = 0;

    for (let msg of messages) {
      const text = msg.text || "";
      const ts = msg.ts;
      const thread = msg.thread_ts || null;

      // 🔹 Fetch user real name
      let userName = null;
      if (msg.user) {
        try {
          const u = await client.users.info({ user: msg.user });
          userName = u.user?.real_name || u.user?.name || null;
        } catch (err) {
          userName = null;
        }
      }

      // 🔹 LOCAL SENTIMENT
      let intensity = vader.SentimentIntensityAnalyzer.polarity_scores(text);
      let score = intensity.compound;
      let label = "NEUTRAL";

      if (score > 0.25) label = "POSITIVE";
      else if (score < -0.25) label = "NEGATIVE";

      // 🔹 Save to DB
      await pool.query(
        `INSERT INTO slack_messages
        (slack_ts, slack_msg_id, channel_id, channel_name,
         user_id, user_name, text, raw_json,
         processed, sentiment_label, sentiment_score, sentiment_model,
         processed_at, thread_ts)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,$9,$10,'VADER',NOW(),$11)
        ON CONFLICT (slack_ts) DO NOTHING`,
        [
          ts,
          `${channelId}-${ts}`,     // slack_msg_id
          channelId,
          channelName,
          msg.user || null,
          userName,
          text,
          msg,                     // raw JSON
          label,
          score,
          thread
        ]
      );

      processedCount++;
    }

    await respond(`✅ *${processedCount} messages processed and saved to PostgreSQL!*`);

  } catch (err) {
    console.error(err);
    await respond("❌ Error syncing messages. Check logs.");
  }
});


// --------------------------------------
// /syncmessages - Fetch and save all messages
// --------------------------------------
// app.command('/syncmessages', async ({ ack, body, client, respond }) => {
//   await ack();

//   const channelId = body.channel_id;

//   try {
//     await respond(`🔄 Sync started for <#${channelId}>...`);

//     let cursor;
//     let allMessages = [];

//     // Fetch messages with pagination
//     do {
//       const result = await client.conversations.history({
//         channel: channelId,
//         cursor: cursor,
//         limit: 200
//       });

//       allMessages.push(...result.messages);
//       cursor = result.response_metadata?.next_cursor;
//     } while (cursor);

//     console.log(`Fetched ${allMessages.length} messages`);

//     // Save messages to DB
//     for (const msg of allMessages) {
//       await pool.query(
//         `INSERT INTO slack_messages 
//           (slack_ts, slack_msg_id, channel_id, text, user_id, raw_json)
//          VALUES ($1, $2, $3, $4, $5, $6)
//          ON CONFLICT DO NOTHING`,
//         [
//           msg.ts,
//           `${channelId}-${msg.ts}`,
//           channelId,
//           msg.text || '',
//           msg.user || null,
//           msg
//         ]
//       );
//     }

//     await respond(`✅ Sync complete! Saved ${allMessages.length} messages.`);
//   } catch (error) {
//     console.error("Sync error:", error);
//     await respond(`❌ Sync failed: ${error.message}`);
//   }
// });

// ------------------ Slash command handler ------------------
app.command('/dailyreport', async ({ ack, body, client }) => {
  await ack();

  const channelId = body.channel_id;

  try {
    const stats = await generateSlackStats(channelId, client);
    await saveToDB(channelId, stats);
    await postSummary(channelId, stats, client, 'Last 24 hours report (slash)');
  } catch (err) {
    console.error('Slash /dailyreport error', err);
    await client.chat.postMessage({
      channel: channelId,
      text: `⚠️ Failed to generate report: ${err.message}`
    });
  }
});

// ------------------ Cron: daily at 09:00 Asia/Kolkata ------------------
const reportChannel = process.env.CHANNEL_TO_REPORT;
if (!reportChannel) console.warn('CHANNEL_TO_REPORT not set in .env — cron will not run until set.');

cron.schedule('0 9 * * *', async () => {
  if (!reportChannel) return;
  console.log('Running scheduled daily report...');
  try {
    const stats = await generateSlackStats(reportChannel, app.client);
    await saveToDB(reportChannel, stats);
    await postSummary(reportChannel, stats, app.client, 'Daily automated 24h report');
  } catch (err) {
    console.error('Cron job error', err);
  }
}, { timezone: 'Asia/Kolkata' });



// List of motivational quotes
const quotes = [
  "Believe in yourself! 💪",
  "Keep pushing, success is near! 🚀",
  "Every day is a new opportunity. 🌅",
  "Stay positive, work hard, make it happen! ✨",
  "You are capable of amazing things! 🔥"
];



// Slash command handler
app.command('/motivate', async ({ command, ack, respond }) => {
  await ack();

  // Pick a random quote
  const randomQuote = quotes[Math.floor(Math.random() * quotes.length)];

  // Respond in the channel
  await respond({
    response_type: 'in_channel', // visible to everyone
    text: `<@${command.user_id}> ${randomQuote}`
  });
});


app.command("/hello", async ({ command, ack, say }) => {
  await ack();
  await say({
    blocks: [
      {
        type: "section", 
        text: { type: "mrkdwn", text: `👋 Hello, *${command.user_name}*!` },
      },
      { type: "divider" },
      {
        type: "section",
        text: { type: "mrkdwn", text: "Welcome to your first Slack app 🚀" },
      },
    ],
  });
});



app.command('/performance', async ({ ack, body, client }) => {
  await ack();

  try {
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'performance_modal',
        title: { type: 'plain_text', text: 'Performance Review' },
        submit: { type: 'plain_text', text: 'Submit' },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks: [
          {
            type: 'input',
            block_id: 'productivity',
            label: { type: 'plain_text', text: 'How productive were you this week? (1–5)' },
            element: {
              type: 'static_select',
              action_id: 'productivity_select',
              options: [1, 2, 3, 4, 5].map(n => ({
                text: { type: 'plain_text', text: n.toString() },
                value: n.toString()
              }))
            }
          },
          {
            type: 'input',
            block_id: 'achievement',
            label: { type: 'plain_text', text: 'Biggest achievement this week' },
            element: { type: 'plain_text_input', action_id: 'achievement_input', multiline: true }
          },
          {
            type: 'input',
            block_id: 'challenges',
            label: { type: 'plain_text', text: 'What challenges or blockers did you face?' },
            element: { type: 'plain_text_input', action_id: 'challenges_input', multiline: true }
          },
          {
            type: 'input',
            block_id: 'collaboration',
            label: { type: 'plain_text', text: 'Rate team collaboration' },
            element: {
              type: 'static_select',
              action_id: 'collaboration_select',
              options: ['Excellent', 'Good', 'Average', 'Poor'].map(opt => ({
                text: { type: 'plain_text', text: opt },
                value: opt
              }))
            }
          },
          {
            type: 'input',
            block_id: 'suggestions',
            label: { type: 'plain_text', text: 'Any suggestions for next week?' },
            element: { type: 'plain_text_input', action_id: 'suggestions_input', multiline: true }
          }
        ]
      }
    });
  } catch (error) {
    console.error('❌ Error opening modal:', error);
  }
});


app.view('performance_modal', async ({ ack, body, view, client }) => {
  await ack();

  const user = `<@${body.user.id}>`;
  const productivity = view.state.values.productivity.productivity_select.selected_option.value;
  const achievement = view.state.values.achievement.achievement_input.value;
  const challenges = view.state.values.challenges.challenges_input.value;
  const collaboration = view.state.values.collaboration.collaboration_select.selected_option.value;
  const suggestions = view.state.values.suggestions.suggestions_input.value;

  const timestamp = new Date().toISOString();

  try {
    const { google } = require('googleapis');
    const auth = new google.auth.GoogleAuth({
      keyFile: 'credentials.json',
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    const sheets = google.sheets({ version: 'v4', auth });

    const spreadsheetId = process.env.GOOGLE_SHEET_ID; // 🔥 replace with your Google Sheet ID
    const range = 'Sheet1!A:G';

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range,
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [[timestamp, user, productivity, achievement, challenges, collaboration, suggestions]]
      }
    });

    await client.chat.postMessage({
      channel: body.user.id,
      text: 'Your performance review has been submitted successfully!'
    });

  } catch (error) {
    console.error('Google Sheets Error:', error);
    await client.chat.postMessage({
      channel: body.user.id,
      text: '⚠️ Failed to save your review. Please contact the admin.'
    });
  }
});




app.command("/mood", async ({ ack, say }) => {
  await ack();

  await say({
    text: "Mood Tracker",
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: "💭 *How are you feeling today?*" },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "😊 Good" },
            value: "Good",
            action_id: "mood_good",
          },
          {
            type: "button",
            text: { type: "plain_text", text: "😐 Okay" },
            value: "Okay",
            action_id: "mood_okay",
          },
          {
            type: "button",
            text: { type: "plain_text", text: "😞 Bad" },
            value: "Bad",
            action_id: "mood_bad",
          },
        ],
      },
    ],
  });
});


app.action(/mood_.*/, async ({ body, ack, say }) => {
  await ack();
  const mood = body.actions[0].value;
  const user = `<@${body.user.id}>`;
  await say(`Thanks ${user}! You’re feeling *${mood}* today.`);
});




(async () => {
  await app.start(process.env.PORT || 3000);
  console.log("⚡️ Slack App is running on port 3000!");
})();

