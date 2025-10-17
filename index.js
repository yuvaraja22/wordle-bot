import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import qrcode from 'qrcode-terminal';
import mysql from 'mysql2/promise';
import axios from 'axios';
import cron from 'node-cron';

// === CONFIG ===
const BOT_NUMBER = '919011111111'; // bot's own number to exclude from pending
const TARGET_GROUP_NAME = 'Project Minu'; // replace with your group name
const LEETCODE_USER = 'mathanika';

// === CLOUD SQL CONFIG ===
const dbConfig = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER || 'user',
  password: process.env.DB_PASSWORD,   // pulled from environment variable
  database: process.env.DB_NAME || 'wordle_bot',
};


// === UTILS ===
function getParticipantName(p) {
  return p.notifyName || p.id._serialized || p.id.user.split('@')[0];
}

// IST date helper
function getTodayKey() {
  const now = new Date();
  const istTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  return istTime.toISOString().split('T')[0];
}

// === DB INIT ===
let db;
async function initDB() {
  db = await mysql.createConnection(dbConfig);

  // Current scores table
  await db.execute(`
    CREATE TABLE IF NOT EXISTS scores (
      group_id VARCHAR(255),
      player_name VARCHAR(255),
      score_date DATE,
      score INT
    )
  `);

  // Archive table
  await db.execute(`
    CREATE TABLE IF NOT EXISTS scores_archive (
      group_id VARCHAR(255),
      player_name VARCHAR(255),
      score_date DATE,
      score INT
    )
  `);

  // LeetCode stats table
  await db.execute(`
    CREATE TABLE IF NOT EXISTS leetcode_stats (
      stat_date DATE PRIMARY KEY,
      total INT,
      easy INT,
      medium INT,
      hard INT
    )
  `);
}

// === GITHUB STATS ===
async function getLeetcodeStats(username) {
  try {
    const url = `https://leetcode.com/graphql/`;
    const query = {
      query: `query getUserProfile($username: String!) {
        matchedUser(username: $username) {
          username
          submitStats {
            acSubmissionNum {
              difficulty
              count
            }
          }
        }
      }`,
      variables: { username },
    };

    const res = await axios.post(url, query, { headers: { 'Content-Type': 'application/json' } });
    const user = res.data?.data?.matchedUser;
    if (!user) return `❌ Could not fetch stats for ${username}.`;

    const acArray = user.submitStats.acSubmissionNum || [];
    const getCount = (diff) => acArray.find(d => d.difficulty === diff)?.count || 0;
    const totalSolved = getCount('All');
    const easy = getCount('Easy');
    const medium = getCount('Medium');
    const hard = getCount('Hard');

    // Load yesterday
    const today = getTodayKey();
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayKey = yesterday.toISOString().split('T')[0];

    const [rows] = await db.execute(`SELECT * FROM leetcode_stats WHERE stat_date = ?`, [yesterdayKey]);
    const prev = rows[0] || { total: totalSolved, easy, medium, hard };

    const diff = {
      Easy: Math.max(0, easy - prev.easy),
      Medium: Math.max(0, medium - prev.medium),
      Hard: Math.max(0, hard - prev.hard),
      total: Math.max(0, totalSolved - prev.total),
    };

    // Save today's stats
    await db.execute(
      `REPLACE INTO leetcode_stats(stat_date, username, total, easy, medium, hard)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [today, username, totalSolved, easy, medium, hard]
    );

    let msg = `*LeetCode Stats for ${username}*\n\n`;
    msg += `Solved Today:\n-> Easy   : *${diff.Easy}*\n-> Medium : *${diff.Medium}*\n-> Hard   : *${diff.Hard}*\n-> Total  : *${diff.total}*\n\n`;
    msg += `Overall Solved:\n-> Easy   : *${easy}*\n-> Medium : *${medium}*\n-> Hard   : *${hard}*\n-> Total  : *${totalSolved}*`;

    return msg;
  } catch (err) {
    console.error(err);
    return `❌ Error fetching stats for ${username}`;
  }
}

// === LEADERBOARDS ===
async function getDailyLeaderboard(groupId) {
  const today = getTodayKey();
  const [rows] = await db.execute(`SELECT player_name, score FROM scores WHERE group_id = ? AND score_date = ?`, [groupId, today]);
  if (rows.length === 0) return '📊 No scores submitted today yet!';

  const sorted = rows.sort((a,b) => a.score - b.score);
  const board = sorted.map((r,i)=>`${i+1}. ${r.player_name}: ${r.score}`).join('\n');
  return `🏆 *Today's Leaderboard (${today})*\n\n${board}`;
}

async function getTotalLeaderboard(groupId) {
  const [rows] = await db.execute(`SELECT player_name, SUM(score) as total_score FROM scores WHERE group_id = ? GROUP BY player_name`, [groupId]);
  if (rows.length === 0) return '📊 No total scores recorded yet.';
  const sorted = rows.sort((a,b)=>a.total_score - b.total_score);
  const board = sorted.map((r,i)=>`${i+1}. ${r.player_name}: ${r.total_score}`).join('\n');
  return `🏁 *All-Time Leaderboard*\n\n${board}`;
}

// Pending participants
async function getPendingParticipants(chat) {
  const today = getTodayKey();
  const groupId = chat.id._serialized;

  const [submittedRows] = await db.execute(`SELECT player_name FROM scores WHERE group_id = ? AND score_date = ?`, [groupId, today]);
  const submittedUsers = submittedRows.map(r => r.player_name);

  const allMembers = (await chat.participants).map(getParticipantName).filter(name => name !== BOT_NUMBER);
  return allMembers.filter(name => !submittedUsers.includes(name));
}

// Archive group scores
async function archiveGroupScores(groupId) {
  await db.execute(
    `INSERT INTO scores_archive (group_id, player_name, score_date, score) 
     SELECT group_id, player_name, score_date, score FROM scores WHERE group_id = ?`, [groupId]
  );
  await db.execute(`DELETE FROM scores WHERE group_id = ?`, [groupId]);
}

// === BOT INIT ===
const client = new Client({ authStrategy: new LocalAuth() });

client.on('qr', qr => qrcode.generate(qr, { small: true }));
client.on('ready', () => console.log('✅ Wordle Bot ready!'));

// === MESSAGE HANDLER ===
client.on('message', async msg => {
  const chat = await msg.getChat();
  if (!chat.isGroup) return;

  const groupId = chat.id._serialized;
  const senderName = msg._data.notifyName || msg.author || msg.from;
  const text = msg.body.trim();

  // LeetCode stats for target group
  if (chat.name === TARGET_GROUP_NAME && /^\/minustatus?$/i.test(text)) {
    const stats = await getLeetcodeStats(LEETCODE_USER);
    await msg.reply(stats);
  }

  // Commands
  if (text === '/current') { await msg.reply(await getDailyLeaderboard(groupId)); return; }
  if (text === '/total') { await msg.reply(await getTotalLeaderboard(groupId)); return; }

  if (text === '/pending') {
    const pending = await getPendingParticipants(chat);
    await msg.reply(pending.length === 0 ? '🎉 Everyone submitted today!' : `⏳ Pending submissions:\n${pending.join('\n')}`);
    return;
  }

  if (text === '/resetConfirmed') {
    await archiveGroupScores(groupId);
    await msg.reply('🗑️ Scores for this group archived and reset.');
    return;
  }

  // Handle Wordle submission
  const wordleMatch = text.match(/Wordle\s+([\d,]+)\s+([X\d])\/6/i);
  if (wordleMatch) {
    let [_, gameNumber, attempts] = wordleMatch;
    gameNumber = gameNumber.replace(/,/g,'');
    attempts = attempts.toUpperCase() === 'X' ? 7 : parseInt(attempts);

    const today = getTodayKey();
    const [existing] = await db.execute(`SELECT * FROM scores WHERE group_id = ? AND player_name = ? AND score_date = ?`, [groupId, senderName, today]);
    if (existing.length > 0) {
      await msg.reply(`⚠️ ${senderName}, you've already submitted today's score.`);
      return;
    }

    await db.execute(`INSERT INTO scores (group_id, player_name, score_date, score) VALUES (?, ?, ?, ?)`, [groupId, senderName, today, attempts]);
    await msg.reply(await getDailyLeaderboard(groupId));
  }
});

// Daily 8PM IST LeetCode stats
cron.schedule('0 20 * * *', async () => {
  const chats = await client.getChats();
  const targetChat = chats.find(c => c.isGroup && c.name === TARGET_GROUP_NAME);
  if (!targetChat) return;

  const stats = await getLeetcodeStats(LEETCODE_USER);
  await targetChat.sendMessage(stats);
  console.log('✅ Daily LeetCode stats sent');
});

// Start DB + Bot
(async () => { await initDB(); client.initialize(); })();
