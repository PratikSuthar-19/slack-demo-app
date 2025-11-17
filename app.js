// app.js
const { App, ExpressReceiver } = require("@slack/bolt");
const { google } = require("googleapis");
const pool = require('./db');
const generateSlackStats = require('./analytics');
const cron = require('node-cron')
const fs = require("fs");
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

