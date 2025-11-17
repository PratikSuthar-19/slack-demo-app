// analytics.js
module.exports = async function generateSlackStats(channelId, client) {
  // fetch last 24 hours (oldest is UNIX seconds)
  const oldest = Math.floor(Date.now() / 1000) - (24 * 60 * 60);

  // get conversation history - may need pagination if many messages
  const messages = [];
  let cursor;
  do {
    const res = await client.conversations.history({
      channel: channelId,
      oldest,
      limit: 200,
      cursor
    });
    if (res.messages && res.messages.length) messages.push(...res.messages);
    cursor = res.response_metadata && res.response_metadata.next_cursor ? res.response_metadata.next_cursor : undefined;
  } while (cursor);

  // compute stats
  const totalMessages = messages.length;
  const usersSet = new Set();
  let totalReactions = 0;
  const emojiCount = {};
  const userActivity = {};

  for (const m of messages) {
    if (m.user) {
      usersSet.add(m.user);
      userActivity[m.user] = (userActivity[m.user] || 0) + 1;
    }
    if (m.reactions) {
      for (const r of m.reactions) {
        totalReactions += r.count || 0;
        emojiCount[r.name] = (emojiCount[r.name] || 0) + (r.count || 0);
      }
    }
  }

  const totalUsers = usersSet.size;
  const mostActiveUser = Object.keys(userActivity).length ? Object.keys(userActivity).reduce((a,b) => userActivity[a] > userActivity[b] ? a : b) : null;
  const topEmoji = Object.keys(emojiCount).length ? Object.keys(emojiCount).reduce((a,b) => emojiCount[a] > emojiCount[b] ? a : b) : null;

  return {
    totalMessages,
    totalReactions,
    totalUsers,
    mostActiveUser,
    topEmoji
  };
};
