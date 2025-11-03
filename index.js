import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import qrcode from 'qrcode-terminal';
import axios from 'axios';
import cron from 'node-cron';

// === New SQLite Imports ===
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

// === CONFIG ===
const BOT_NUMBER = '919011111111'; // bot's own number to exclude from pending
const TARGET_GROUP_NAME = 'Project Minu'; // replace with your group name
const LEETCODE_USER = 'mathanika';

// === Error Handling (Kept for PM2 restarts) ===
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
  process.exit(1); // Forces PM2 to restart
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection:', reason);
  process.exit(1);
});

// === DB INIT (Refactored for SQLite) ===
let db;

async function initDB() {
  console.log('📦 Initializing SQLite database...');
  
  db = await open({
    filename: '/home/yuvarajacoc/var/lib/wordle-bot-data/bot.db', 
    driver: sqlite3.Database
  });

  console.log('✅ Connected to SQLite database (bot.db)');

  // Note: All db.execute changed to db.run
  await db.run(`
    CREATE TABLE IF NOT EXISTS scores (
      group_id TEXT,
      player_name TEXT,
      score_date DATE,
      score INT
    )
  `);

  await db.run(`
    CREATE TABLE IF NOT EXISTS scores_archive (
      group_id TEXT,
      player_name TEXT,
      score_date DATE,
      score INT
    )
  `);

  // FIXED: Changed PRIMARY KEY to be composite (stat_date, username)
  await db.run(`
    CREATE TABLE IF NOT EXISTS leetcode_stats (
      stat_date DATE,
      username TEXT,
      total INT,
      easy INT,
      medium INT,
      hard INT,
      PRIMARY KEY (stat_date, username) 
    )
  `);
}

// === UTILS ===
function getParticipantName(p) {
  return p.notifyName || p.id._serialized || p.id.user.split('@')[0];
}

function formatName(name) {
  return name.trim().substring(0, 4).padEnd(4);
}

// Helper to get IST date string (YYYY-MM-DD)
function getISTDateKey(offsetDays = 0) {
  const now = new Date();
  // convert to IST (+5:30)
  const istTime = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
  istTime.setDate(istTime.getDate() + offsetDays);
  return istTime.toISOString().split('T')[0];
}


// === LEADERBOARDS ===
async function getDailyLeaderboard(groupId) {
  const today = getISTDateKey(0);
  // db.execute changed to db.all
  const rows = await db.all(
    `SELECT player_name, SUM(score) as total_score FROM scores WHERE group_id = ? AND score_date = ? GROUP BY player_name`,
    [groupId, today]
  );

  if (rows.length === 0) return '📊 No scores submitted today yet!';
  const sorted = rows.sort((a, b) => b.total_score - a.total_score);
  const board = sorted.map((r, i) => `${i + 1}. ${r.player_name} ${r.total_score}`).join('\n');
  return `🏆 *Today's Leaderboard (${today})*\n\n${board}`;
}

async function getTotalLeaderboard(groupId) {
  // db.execute changed to db.all
  const rows = await db.all(
    `SELECT player_name, SUM(score) as total_score FROM scores WHERE group_id = ? GROUP BY player_name`,
    [groupId]
  );

  if (rows.length === 0) return '📊 No total scores yet!';
  const sorted = rows.sort((a, b) => b.total_score - a.total_score);
  const board = sorted.map((r, i) => `${i + 1}. ${r.player_name} ${r.total_score}`).join('\n');
  return `🏁 *All-Time Leaderboard*\n\n${board}`;
}

// === COMBINED LEADERBOARD ===
async function getCombinedLeaderboard(groupId) {
  const today = getISTDateKey(0);

  // db.execute changed to db.all
  const allRows = await db.all(
    `SELECT player_name, SUM(score) as total_score FROM scores WHERE group_id = ? GROUP BY player_name`,
    [groupId]
  );

  // db.execute changed to db.all
  const todayRows = await db.all(
    `SELECT player_name, SUM(score) as total_score FROM scores WHERE group_id = ? AND score_date = ? GROUP BY player_name`,
    [groupId, today]
  );

  const allTime = allRows.sort((a, b) => b.total_score - a.total_score);
  const todayList = todayRows.sort((a, b) => b.total_score - a.total_score);
  const maxLen = Math.max(allTime.length, todayList.length);

  let lines = [];
  lines.push("🏆 All-Time  |  🎖️ Today");
  lines.push("-----------------------------");
  for (let i = 0; i < maxLen; i++) {
    const left = allTime[i]
      ? `${String(i + 1).padStart(2)}. ${formatName(allTime[i].player_name)} ${String(allTime[i].total_score).padStart(2)}`
      : " ".repeat(14);
    const right = todayList[i]
      ? `${String(i + 1).padStart(2)}. ${formatName(todayList[i].player_name)} ${String(todayList[i].total_score).padStart(2)}`
      : "";
    lines.push(`${left}  |  ${right}`);
  }

  return "```\n" + lines.join("\n") + "\n```";
}


// === OVERALL PROGRESS (API + DB MIX) ===
async function getOverallLeetcodeProgress(username) {
  try {
    // Step 1: Fetch oldest record from DB (db.execute changed to db.get)
    // ORDER BY ASC LIMIT 1 is sufficient for db.get
    const oldest = await db.get(
      `SELECT * FROM leetcode_stats WHERE username = ? ORDER BY stat_date ASC LIMIT 1`,
      [username]
    );

    // Step 2: Fetch latest stats directly from LeetCode API
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

    const res = await axios.post(url, query, {
      headers: { 'Content-Type': 'application/json' },
    });

    const user = res.data?.data?.matchedUser;
    if (!user) return `❌ Could not fetch stats for ${username}.`;

    const acArray = user.submitStats.acSubmissionNum || [];
    const getCount = (diff) => acArray.find((d) => d.difficulty === diff)?.count || 0;

    const latest = {
      total: getCount('All'),
      easy: getCount('Easy'),
      medium: getCount('Medium'),
      hard: getCount('Hard'),
    };

    // Step 3: If no oldest record exists, save current stats as baseline
    if (!oldest) {
      const today = getISTDateKey(0);
      // db.execute changed to db.run
      await db.run(
        `INSERT INTO leetcode_stats(stat_date, username, total, easy, medium, hard)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [today, username, latest.total, latest.easy, latest.medium, latest.hard]
      );
      // Create a mock oldest object from latest for diff calculation
      const initialOldest = { ...latest, stat_date: today };
      
      // Compute difference based on initial baseline (will be 0, but provides a date)
      const diff = {
        Easy: 0, Medium: 0, Hard: 0, total: 0
      };
      
      // Use the formatted date from the initial record
      const formattedDate = new Date(initialOldest.stat_date).toLocaleDateString('en-GB', {
          day: '2-digit',
          month: '2-digit',
          year: '2-digit'
      });
      
      let msg = `📈 LeetCode Progress for ${username}\n`;
      msg += `Solved since: ${formattedDate} (Initial Baseline)\n`;
      msg += `-----------\n`;
      msg += `Easy   : ${diff.Easy}\n`;
      msg += `Medium : ${diff.Medium}\n`;
      msg += `Hard   : ${diff.Hard}\n`;
      msg += `Total  : ${diff.total}`;
      
      return "```\n" + msg + "\n```";
    }

    // Step 4: Compute difference
    const diff = {
      Easy: Math.max(0, latest.easy - oldest.easy),
      Medium: Math.max(0, latest.medium - oldest.medium),
      Hard: Math.max(0, latest.hard - oldest.hard),
      total: Math.max(0, latest.total - oldest.total),
    };

    const sinceDate = new Date(oldest.stat_date);
    const formattedDate = sinceDate.toLocaleDateString('en-GB', {
      day: '2-digit',
      month: '2-digit',
      year: '2-digit'
    });
    // Step 5: Format message
    let msg = `📈 LeetCode Progress for ${username}\n`;
    msg += `Solved since: ${formattedDate}\n`;
    msg += `-----------\n`;
    msg += `Easy   : ${diff.Easy}\n`;
    msg += `Medium : ${diff.Medium}\n`;
    msg += `Hard   : ${diff.Hard}\n`;
    msg += `Total  : ${diff.total}`;

    return "```\n" + msg + "\n```";
  } catch (err) {
    console.error(err);
    return `❌ Error fetching overall progress for ${username}`;
  }
}


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

    const today = getISTDateKey(0);
    const yesterdayKey = getISTDateKey(-1);

    // db.execute changed to db.get
    const prev = await db.get(`SELECT * FROM leetcode_stats WHERE stat_date = ? and username = ?`, [yesterdayKey, username]);
    const prevStats = prev || { total: totalSolved, easy, medium, hard };

    const diff = {
      Easy: Math.max(0, easy - prevStats.easy),
      Medium: Math.max(0, medium - prevStats.medium),
      Hard: Math.max(0, hard - prevStats.hard),
      total: Math.max(0, totalSolved - prevStats.total),
    };

    // db.execute changed to db.run
    await db.run(
      `REPLACE INTO leetcode_stats(stat_date, username, total, easy, medium, hard)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [today, username, totalSolved, easy, medium, hard]
    );

    let msg = `LeetCode Stats for ${username}\n\n`;
    msg += `Solved Today |  Overall Solved\n`;
    msg += `------------------------------\n`;
    msg += `Easy   : ${diff.Easy}   |  ${easy}\n`;
    msg += `Medium : ${diff.Medium}   |  ${medium}\n`;
    msg += `Hard   : ${diff.Hard}   |  ${hard}\n`;
    msg += `Total  : ${diff.total}   |  ${totalSolved}`;
    
    return "```\n" + msg + "\n```";
  } catch (err) {
    console.error(err);
    return `❌ Error fetching stats for ${username}`;
  }
}

function getDateFromWordleNumber(wordleNum) {
  // Wordle #1 = 2021-06-19 UTC
  const startUTC = new Date(Date.UTC(2021, 5, 19, 0, 0, 0)); // months are 0-indexed
  // target in UTC
  const targetUTC = new Date(startUTC.getTime() + (wordleNum - 1) * 24 * 60 * 60 * 1000);
  // convert UTC -> IST by adding 5.5 hours (5*60 + 30 minutes)
  const istOffsetMs = (5 * 60 + 30) * 60 * 1000;
  const targetIST = new Date(targetUTC.getTime() + istOffsetMs);

  // return YYYY-MM-DD
  return targetIST.toISOString().split('T')[0];
}

// === HELPERS ===
async function getPendingParticipants(chat) {
  const today = getISTDateKey(0);
  const groupId = chat.id._serialized;
  // db.execute changed to db.all
  const submittedRows = await db.all(
    `SELECT player_name FROM scores WHERE group_id = ? AND score_date = ?`,
    [groupId, today]
  );
  const submittedUsers = submittedRows.map(r => r.player_name);
  const allMembers = (await chat.participants).map(getParticipantName).filter(name => name !== BOT_NUMBER);
  return allMembers.filter(name => !submittedUsers.includes(name));
}

async function archiveGroupScores(groupId) {
  // db.execute changed to db.run
  await db.run(
    `INSERT INTO scores_archive (group_id, player_name, score_date, score)
     SELECT group_id, player_name, score_date, score FROM scores WHERE group_id = ?`,
    [groupId]
  );
  // db.execute changed to db.run
  await db.run(`DELETE FROM scores WHERE group_id = ?`, [groupId]);
}

// === BOT ===
const client = new Client({ authStrategy: new LocalAuth() });
client.on('qr', qr => qrcode.generate(qr, { small: true }));
client.on('ready', () => console.log('✅ Wordle Bot ready!'));

client.on('message', async msg => {
  const chat = await msg.getChat();
  if (!chat.isGroup) return;

  const groupId = chat.id._serialized;
  const senderName = msg._data.notifyName || msg.author || msg.from;
  const text = msg.body.trim();

  if (chat.name === TARGET_GROUP_NAME && /^\/minustatus?$/i.test(text)) {
    const stats = await getLeetcodeStats(LEETCODE_USER);
    await msg.reply(stats);
  }

  if (/^\/status\s+/i.test(text)) {
    const username = text.split(' ')[1]?.trim();
    if (!username) {
      await msg.reply('❌ Please provide a username.\nExample: `/status yuva`');
      return;
    }
    const stats = await getOverallLeetcodeProgress(username);
    await msg.reply(stats);
    return;
  }

  if (text === '/current') {
    await msg.reply(await getDailyLeaderboard(groupId));
    return;
  }

  if (text === '/total') {
    await msg.reply(await getTotalLeaderboard(groupId));
    return;
  }

  if (text === '/all') {
    await msg.reply(await getCombinedLeaderboard(groupId));
    return;
  }

  if (text === '/pending') {
    const pending = await getPendingParticipants(chat);
    await msg.reply(
      pending.length === 0
        ? '🎉 Everyone submitted today!'
        : `⏳ Pending submissions:\n${pending.join('\n')}`
    );
    return;
  }

  if (text === '/resetConfirmed') {
    await archiveGroupScores(groupId);
    await msg.reply('🗑️ Scores for this group archived and reset.');
    return;
  }

  // === Wordle submission ===
  const wordleMatch = text.match(/Wordle\s+([\d,]+)\s+([X\d])\/6/i);
  if (wordleMatch) {
    let [_, gameNumber, attempts] = wordleMatch;
    gameNumber = gameNumber.replace(/,/g, '');
    let score = attempts.toUpperCase() === 'X' ? 0 : 7 - parseInt(attempts);

    const wordleDate = getDateFromWordleNumber(parseInt(gameNumber));

    // const today = getISTDateKey(0);
    // db.execute changed to db.get
    const existing = await db.get(
      `SELECT * FROM scores WHERE group_id = ? AND player_name = ? AND score_date = ?`,
      [groupId, senderName, wordleDate]
    );

    // existing.length > 0 changed to if (existing)
    if (existing) {
      await msg.reply(`⚠️ ${senderName}, you've already submitted for Wordle #${gameNumber} (${wordleDate}).`);
      return;
    }

    // db.execute changed to db.run
    await db.run(
      `INSERT INTO scores (group_id, player_name, score_date, score) VALUES (?, ?, ?, ?)`,
      [groupId, senderName, wordleDate, score]
    );

    const leaderboardMsg = await getCombinedLeaderboard(groupId);
    await msg.reply(leaderboardMsg);
  }
});

// === DAILY CRON ===
cron.schedule(
  '0 20 * * *',
  async () => {
    const chats = await client.getChats();
    const targetChat = chats.find(c => c.isGroup && c.name === TARGET_GROUP_NAME);
    if (!targetChat) return;
    const stats = await getLeetcodeStats(LEETCODE_USER);
    await targetChat.sendMessage(stats);
    console.log('✅ Daily LeetCode stats sent');
  },
  { timezone: 'Asia/Kolkata' }
);

// === START ===
(async () => { await initDB(); client.initialize(); })();
