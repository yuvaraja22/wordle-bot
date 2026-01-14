import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import qrcode from 'qrcode-terminal';
import axios from 'axios';
import cron from 'node-cron';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';

// === CONFIG ===
const BOT_NUMBER = '919011111111'; // bot's own number to exclude from pending
const TARGET_GROUP_NAME = 'Project Minu'; // replace with your group name
const DAILY_WORD_GROUP_NAME = 'Wordle 2.0'; // Group to send daily words to
const LEETCODE_USER = 'mathanika';
const DB_PATH = '/home/yuvarajacoc/var/lib/wordle-bot-data/bot.db';

// === SIMPLE TIMESTAMPED LOGGER ===
const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const CURRENT_LEVEL = process.env.LOG_LEVEL ? LOG_LEVELS[process.env.LOG_LEVEL] ?? LOG_LEVELS.INFO : LOG_LEVELS.INFO;
function log(level, ...args) {
  const lvl = String(level).toUpperCase();
  if ((LOG_LEVELS[lvl] ?? 0) < CURRENT_LEVEL) return;
  const ts = new Date().toISOString();
  const prefix = `${ts} ${lvl}`;
  if (lvl === 'ERROR') console.error(prefix, ...args);
  else if (lvl === 'WARN') console.warn(prefix, ...args);
  else console.log(prefix, ...args);
}

process.on('uncaughtException', (err) => {
  log('ERROR', 'Uncaught Exception:', err && err.stack ? err.stack : err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  log('ERROR', 'Unhandled Rejection:', reason && reason.stack ? reason.stack : reason);
  process.exit(1);
});
process.on('exit', (code) => log('INFO', `Process exiting with code ${code}`));

// === DB INIT (Refactored for SQLite) ===
let db;
async function ensureDbFileAccessible(pathToFile) {
  try {
    await fsPromises.mkdir(path.dirname(pathToFile), { recursive: true });
    // Try opening with read/write flags (creates file if missing)
    const fh = await fsPromises.open(pathToFile, 'a+');
    await fh.close();
    await fsPromises.access(pathToFile, fs.constants.R_OK | fs.constants.W_OK);
    log('INFO', `DB file verified and accessible at ${pathToFile}`);
  } catch (err) {
    log('ERROR', `DB file not accessible at ${pathToFile}:`, err && err.stack ? err.stack : err);
    throw err;
  }
}

async function initDB() {
  log('INFO', 'Initializing SQLite database...');
  await ensureDbFileAccessible(DB_PATH);

  try {
    db = await open({ filename: DB_PATH, driver: sqlite3.Database });
    log('INFO', 'Connected to SQLite database (bot.db)');

    await db.run(`CREATE TABLE IF NOT EXISTS scores (group_id TEXT, player_name TEXT, score_date DATE, score INT)`);
    await db.run(`CREATE TABLE IF NOT EXISTS scores_archive (group_id TEXT, player_name TEXT, score_date DATE, score INT)`);
    await db.run(`CREATE TABLE IF NOT EXISTS leetcode_stats (stat_date DATE, username TEXT, total INT, easy INT, medium INT, hard INT, PRIMARY KEY (stat_date, username))`);
    await db.run(`CREATE TABLE IF NOT EXISTS daily_words (id INTEGER PRIMARY KEY AUTOINCREMENT, word TEXT UNIQUE, used INTEGER DEFAULT 0)`);
    await db.run(`CREATE TABLE IF NOT EXISTS sent_words (sent_date DATE PRIMARY KEY, word TEXT NOT NULL)`);

    const tables = await db.all(`SELECT name FROM sqlite_master WHERE type='table'`);
    log('DEBUG', 'SQLite tables present:', tables.map(t => t.name));
  } catch (err) {
    log('ERROR', 'Error while initializing DB:', err && err.stack ? err.stack : err);
    throw err;
  }
}

// === UTILS ===
function getParticipantName(p) {
  try { return p.notifyName || p.id._serialized || (p.id && p.id.user ? p.id.user.split('@')[0] : 'unknown'); }
  catch (e) { return 'unknown'; }
}
function formatName(name) {
  return String(name || '').trim().substring(0, 4).padEnd(4);
}
function getISTDateKey(offsetDays = 0) {
  const now = new Date();
  const istMs = now.getTime() + 5.5 * 60 * 60 * 1000;
  const istDate = new Date(istMs);
  istDate.setDate(istDate.getDate() + offsetDays);
  return istDate.toISOString().split('T')[0];
}
function getDateFromWordleNumber(wordleNum) {
  const anchorWordle = 1598;
  const anchorDateStr = '2025-11-03';
  const [ay, am, ad] = anchorDateStr.split('-').map(n => parseInt(n, 10));
  const anchorMs = Date.UTC(ay, am - 1, ad);
  const deltaDays = wordleNum - anchorWordle;
  const targetMs = anchorMs + deltaDays * 24 * 60 * 60 * 1000;
  const target = new Date(targetMs);
  return target.toISOString().slice(0, 10);
}

// === LEADERBOARDS / STATS ===
async function getDailyLeaderboard(groupId) {
  try {
    const today = getISTDateKey(0);
    log('DEBUG', `Fetching daily leaderboard for ${groupId} on ${today}`);
    const rows = await db.all(`SELECT player_name, SUM(score) as total_score FROM scores WHERE group_id = ? AND score_date = ? GROUP BY player_name`, [groupId, today]);
    if (!rows || rows.length === 0) return '📊 No scores submitted today yet!';
    const sorted = rows.sort((a, b) => b.total_score - a.total_score);
    const board = sorted.map((r, i) => `${i + 1}. ${r.player_name} ${r.total_score}`).join('\n');
    return `🏆 *Today's Leaderboard (${today})*\n\n${board}`;
  } catch (err) {
    log('ERROR', 'getDailyLeaderboard failed:', err && err.stack ? err.stack : err);
    return '❌ Error fetching leaderboard';
  }
}

async function getTotalLeaderboard(groupId) {
  try {
    log('DEBUG', `Fetching total leaderboard for ${groupId}`);
    const rows = await db.all(`SELECT player_name, SUM(score) as total_score FROM scores WHERE group_id = ? GROUP BY player_name`, [groupId]);
    if (!rows || rows.length === 0) return '📊 No total scores yet!';
    const sorted = rows.sort((a, b) => b.total_score - a.total_score);
    const board = sorted.map((r, i) => `${i + 1}. ${r.player_name} ${r.total_score}`).join('\n');
    return `🏁 *All-Time Leaderboard*\n\n${board}`;
  } catch (err) {
    log('ERROR', 'getTotalLeaderboard failed:', err && err.stack ? err.stack : err);
    return '❌ Error fetching leaderboard';
  }
}

async function getCombinedLeaderboard(groupId) {
  try {
    const today = getISTDateKey(0);
    log('DEBUG', `Fetching combined leaderboard for ${groupId} on ${today}`);
    const allRows = await db.all(`SELECT player_name, SUM(score) as total_score FROM scores WHERE group_id = ? GROUP BY player_name`, [groupId]);
    const todayRows = await db.all(`SELECT player_name, SUM(score) as total_score FROM scores WHERE group_id = ? AND score_date = ? GROUP BY player_name`, [groupId, today]);
    const allTime = (allRows || []).sort((a, b) => b.total_score - a.total_score);
    const todayList = (todayRows || []).sort((a, b) => b.total_score - a.total_score);

    const maxLen = Math.max(allTime.length, todayList.length);
    let lines = [];
    lines.push("🏆 All-Time  |  🎖️ Today");
    lines.push("-----------------------------");
    for (let i = 0; i < maxLen; i++) {
      const left = allTime[i] ? `${String(i + 1).padStart(2)}. ${formatName(allTime[i].player_name)} ${String(allTime[i].total_score).padStart(2)}` : " ".repeat(14);
      const right = todayList[i] ? `${String(i + 1).padStart(2)}. ${formatName(todayList[i].player_name)} ${String(todayList[i].total_score).padStart(2)}` : "";
      lines.push(`${left}  |  ${right}`);
    }

    return "```\n" + lines.join('\n') + "\n```";
  } catch (err) {
    log('ERROR', 'getCombinedLeaderboard failed:', err && err.stack ? err.stack : err);
    return '❌ Error building leaderboard';
  }
}

async function getOverallLeetcodeProgress(username) {
  try {
    const oldest = await db.get(`SELECT * FROM leetcode_stats WHERE username = ? ORDER BY stat_date ASC LIMIT 1`, [username]);

    const url = `https://leetcode.com/graphql/`;
    const query = {
      query: `query getUserProfile($username: String!) { matchedUser(username: $username) { username submitStats { acSubmissionNum { difficulty count } } } }`,
      variables: { username },
    };

    const res = await axios.post(url, query, { headers: { 'Content-Type': 'application/json' }, timeout: 15000 });
    const user = res.data?.data?.matchedUser;
    if (!user) return `❌ Could not fetch stats for ${username}.`;

    const acArray = user.submitStats.acSubmissionNum || [];
    const getCount = (diff) => acArray.find(d => d.difficulty === diff)?.count || 0;
    const latest = { total: getCount('All'), easy: getCount('Easy'), medium: getCount('Medium'), hard: getCount('Hard') };

    if (!oldest) {
      const today = getISTDateKey(0);
      await db.run(`INSERT INTO leetcode_stats(stat_date, username, total, easy, medium, hard) VALUES (?, ?, ?, ?, ?, ?)`, [today, username, latest.total, latest.easy, latest.medium, latest.hard]);
      const initialOldest = { ...latest, stat_date: today };
      const diff = { Easy: 0, Medium: 0, Hard: 0, total: 0 };
      const formattedDate = new Date(initialOldest.stat_date).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit' });
      let msg = `📈 LeetCode Progress for ${username}\n`;
      msg += `Solved since: ${formattedDate} (Initial Baseline)\n-----------\n`;
      msg += `Easy   : ${diff.Easy}\nMedium : ${diff.Medium}\nHard   : ${diff.Hard}\nTotal  : ${diff.total}`;
      return "```\n" + msg + "\n```";
    }

    const diff = {
      Easy: Math.max(0, latest.easy - oldest.easy),
      Medium: Math.max(0, latest.medium - oldest.medium),
      Hard: Math.max(0, latest.hard - oldest.hard),
      total: Math.max(0, latest.total - oldest.total),
    };

    const sinceDate = new Date(oldest.stat_date);
    const formattedDate = sinceDate.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit' });
    let msg = `📈 LeetCode Progress for ${username}\n`;
    msg += `Solved since: ${formattedDate}\n-----------\n`;
    msg += `Easy   : ${diff.Easy}\nMedium : ${diff.Medium}\nHard   : ${diff.Hard}\nTotal  : ${diff.total}`;
    return "```\n" + msg + "\n```";
  } catch (err) {
    log('ERROR', 'getOverallLeetcodeProgress failed:', err && err.stack ? err.stack : err);
    return `❌ Error fetching overall progress for ${username}`;
  }
}

async function getLeetcodeStats(username) {
  try {
    log('DEBUG', `Fetching LeetCode stats for ${username}`);
    const url = `https://leetcode.com/graphql/`;
    const query = {
      query: `query getUserProfile($username: String!) { matchedUser(username: $username) { username submitStats { acSubmissionNum { difficulty count } } } }`,
      variables: { username },
    };

    const res = await axios.post(url, query, { headers: { 'Content-Type': 'application/json' }, timeout: 15000 });
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
    const prev = await db.get(`SELECT * FROM leetcode_stats WHERE stat_date = ? and username = ?`, [yesterdayKey, username]);
    const prevStats = prev || { total: totalSolved, easy, medium, hard };

    const diff = { Easy: Math.max(0, easy - prevStats.easy), Medium: Math.max(0, medium - prevStats.medium), Hard: Math.max(0, hard - prevStats.hard), total: Math.max(0, totalSolved - prevStats.total) };

    await db.run(`REPLACE INTO leetcode_stats(stat_date, username, total, easy, medium, hard) VALUES (?, ?, ?, ?, ?, ?)`, [today, username, totalSolved, easy, medium, hard]);

    let msg = `LeetCode Stats for ${username}\n\n`;
    msg += `Solved Today |  Overall Solved\n`;
    msg += `------------------------------\n`;
    msg += `Easy   : ${diff.Easy}   |  ${easy}\n`;
    msg += `Medium : ${diff.Medium}   |  ${medium}\n`;
    msg += `Hard   : ${diff.Hard}   |  ${hard}\n`;
    msg += `Total  : ${diff.total}   |  ${totalSolved}`;

    return "```\n" + msg + "\n```";
  } catch (err) {
    log('ERROR', 'getLeetcodeStats failed:', err && err.stack ? err.stack : err);
    return `❌ Error fetching stats for ${username}`;
  }
}

// === DAILY WORD LOGIC ===
async function addWord(word) {
  try {
    await db.run(`INSERT INTO daily_words (word) VALUES (?)`, [word.trim()]);
    return `✅ Word "${word}" added to the list.`;
  } catch (err) {
    if (err.message.includes('UNIQUE constraint failed')) return `⚠️ Word "${word}" already exists.`;
    log('ERROR', 'addWord failed:', err);
    return `❌ Error adding word.`;
  }
}

async function getAndMarkRandomWord() {
  try {
    const row = await db.get(`SELECT * FROM daily_words WHERE used = 0 ORDER BY RANDOM() LIMIT 1`);
    if (!row) return null;
    await db.run(`UPDATE daily_words SET used = 1 WHERE id = ?`, [row.id]);
    return row.word;
  } catch (err) {
    log('ERROR', 'getAndMarkRandomWord failed:', err);
    return null;
  }
}

async function sendDailyWord(client) {
  try {
    log('INFO', 'Running daily word job');
    const word = await getAndMarkRandomWord();
    if (!word) {
      log('WARN', 'No unused words available for daily word.');
      return;
    }

    const chats = await client.getChats();
    const targetChat = chats.find(c => c.isGroup && c.name === DAILY_WORD_GROUP_NAME);
    if (!targetChat) {
      log('WARN', `Daily word: target group '${DAILY_WORD_GROUP_NAME}' not found`);
      return;
    }

    // Record the sent word with today's date
    const today = getISTDateKey(0);
    await db.run(`INSERT OR REPLACE INTO sent_words (sent_date, word) VALUES (?, ?)`, [today, word]);

    await targetChat.sendMessage(`🌟 *Word of the Day* 🌟\n\n${word}`);
    log('INFO', `✅ Daily word "${word}" sent to ${DAILY_WORD_GROUP_NAME}`);
  } catch (err) {
    log('ERROR', 'Error in sendDailyWord:', err);
  }
}

async function getTodaysWord() {
  try {
    const today = getISTDateKey(0);
    const row = await db.get(`SELECT word FROM sent_words WHERE sent_date = ?`, [today]);
    if (!row) return null;
    return row.word;
  } catch (err) {
    log('ERROR', 'getTodaysWord failed:', err);
    return null;
  }
}

// === REMINDER FOR PENDING PARTICIPANTS ===
async function sendWordleReminder(client) {
  try {
    log('INFO', 'Running Wordle reminder job');
    const chats = await client.getChats();
    const targetChat = chats.find(c => c.isGroup && c.name === DAILY_WORD_GROUP_NAME);
    if (!targetChat) {
      log('WARN', `Wordle reminder: target group '${DAILY_WORD_GROUP_NAME}' not found`);
      return;
    }

    const groupId = targetChat.id._serialized;
    const pending = await getPendingParticipants(groupId);
    if (pending.length === 0) {
      log('INFO', 'Wordle reminder: Everyone has submitted today!');
      return;
    }

    let lines = [];
    lines.push("⏰ Wordle Reminder!");
    lines.push("-----------------------------");
    pending.forEach((name, i) => {
      lines.push(`${String(i + 1).padStart(2)}. ${formatName(name)}`);
    });
    lines.push("-----------------------------");
    lines.push("🎯 Don't forget to play!");

    const reminderMsg = "```\n" + lines.join('\n') + "\n```";
    await targetChat.sendMessage(reminderMsg);
    log('INFO', `✅ Wordle reminder sent to ${DAILY_WORD_GROUP_NAME} for ${pending.length} pending members`);
  } catch (err) {
    log('ERROR', 'Error in sendWordleReminder:', err);
  }
}

// === HELPERS FOR PENDING / ARCHIVE ===
async function getPendingParticipants(groupId) {
  try {
    const today = getISTDateKey(0);

    // Get all distinct players who have ever submitted in this group
    const allPlayersRows = await db.all(`SELECT DISTINCT player_name FROM scores WHERE group_id = ?`, [groupId]);
    const allPlayers = allPlayersRows.map(r => r.player_name);

    // Get players who have submitted today
    const submittedRows = await db.all(`SELECT player_name FROM scores WHERE group_id = ? AND score_date = ?`, [groupId, today]);
    const submittedUsers = submittedRows.map(r => r.player_name);

    // Return players who haven't submitted today
    return allPlayers.filter(name => !submittedUsers.includes(name));
  } catch (err) {
    log('ERROR', 'getPendingParticipants failed:', err && err.stack ? err.stack : err);
    return [];
  }
}
async function archiveGroupScores(groupId) {
  try {
    log('INFO', `Archiving scores for group ${groupId}`);
    await db.run(`INSERT INTO scores_archive (group_id, player_name, score_date, score) SELECT group_id, player_name, score_date, score FROM scores WHERE group_id = ?`, [groupId]);
    await db.run(`DELETE FROM scores WHERE group_id = ?`, [groupId]);
    log('INFO', `Archive & delete complete for ${groupId}`);
  } catch (err) {
    log('ERROR', 'archiveGroupScores failed:', err && err.stack ? err.stack : err);
  }
}

// === BOT ===
const CHROME_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.PUPPETEER_EXECUTABLE || null;
const puppeteerOptions = {
  headless: process.env.HEADLESS !== 'false',
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--disable-gpu',
    '--no-zygote'
  ]
};
if (CHROME_PATH) puppeteerOptions.executablePath = CHROME_PATH;

const client = new Client({ authStrategy: new LocalAuth(), puppeteer: puppeteerOptions });

client.on('qr', (qr) => {
  log('INFO', 'QR code received — display in terminal');
  try { qrcode.generate(qr, { small: true }); } catch (e) { log('WARN', 'Failed to display QR in terminal:', e); }
});
client.on('authenticated', () => {
  log('INFO', 'WhatsApp authenticated successfully');
  log('INFO', 'Waiting for ready event...');
});
client.on('auth_failure', (msg) => log('ERROR', 'Authentication failure:', msg));

// Track if ready event has fired
let isReady = false;

// Shared initialization logic
async function onBotReady() {
  if (isReady) return; // Prevent double initialization
  isReady = true;
  log('INFO', 'Wordle Bot ready!');
}

client.on('loading_screen', async (percent, message) => {
  log('INFO', `loading_screen ${percent}%: ${message}`);
  // Fallback: if loading_screen reaches 100% and ready hasn't fired, trigger manually
  if (percent === 100 && !isReady) {
    log('INFO', 'loading_screen at 100%, triggering ready fallback after delay...');
    setTimeout(() => {
      if (!isReady) {
        log('INFO', 'Ready event did not fire, using fallback initialization');
        onBotReady();
      }
    }, 5000); // 5 second delay to give WhatsApp store time to initialize
  }
});
client.on('change_state', (state) => log('INFO', 'WhatsApp client state changed:', state));
client.on('disconnected', (reason) => log('WARN', 'WhatsApp client disconnected:', reason));

client.on('ready', async () => {
  await onBotReady();
});

client.on('message', async (msg) => {
  try {
    const chat = await msg.getChat();
    if (!chat.isGroup) return;

    const groupId = chat.id._serialized;
    const senderName = msg._data?.notifyName || msg.author || msg.from || 'unknown';
    const text = (msg.body || '').trim();
    // log('DEBUG', `Message received in ${groupId} from ${senderName}: ${text.substring(0, 200)}`);

    if (chat.name === TARGET_GROUP_NAME && /^\/minustatus?$/i.test(text)) {
      const stats = await getLeetcodeStats(LEETCODE_USER);
      await msg.reply(stats);
    }

    if (/^\/status\s+/i.test(text)) {
      const username = text.split(' ')[1]?.trim();
      if (!username) { await msg.reply('❌ Please provide a username.\nExample: `/status yuva`'); return; }
      const stats = await getOverallLeetcodeProgress(username);
      await msg.reply(stats);
      return;
    }

    if (text === '/current') { await msg.reply(await getDailyLeaderboard(groupId)); return; }
    if (text === '/total') { await msg.reply(await getTotalLeaderboard(groupId)); return; }
    if (text === '/all') { await msg.reply(await getCombinedLeaderboard(groupId)); return; }
    if (text === '/pending') { const pending = await getPendingParticipants(groupId); await msg.reply(pending.length === 0 ? '🎉 Everyone submitted today!' : `⏳ Pending submissions:\n${pending.join('\n')}`); return; }
    if (text === '/resetConfirmed') { await archiveGroupScores(groupId); await msg.reply('🗑️ Scores for this group archived and reset.'); return; }

    if (text.startsWith('/addword ')) {
      const word = text.substring(9).trim();
      if (!word) { await msg.reply('❌ Please provide a word.'); return; }
      const res = await addWord(word);
      await msg.reply(res);
      return;
    }

    if (text === '/testdailyword') {
      await sendDailyWord(client);
      // await msg.reply('Attempted to send daily word. Check logs if nothing appeared.');
      return;
    }

    if (text === '/testreminder') {
      await sendWordleReminder(client);
      return;
    }

    if (text === '/word') {
      const word = await getTodaysWord();
      if (word) {
        await msg.reply(`📝 *Today's Word:* ${word}`);
      } else {
        await msg.reply(`❌ No word has been sent today yet.`);
      }
      return;
    }

    const wordleMatch = text.match(/(?:Wordle|easy mathler)\s+([\d,]+)\s+([X\d])\/6/i);
    if (wordleMatch) {
      let [_, gameNumber, attempts] = wordleMatch;
      gameNumber = gameNumber.replace(/,/g, '');
      let score = attempts.toUpperCase() === 'X' ? 0 : 7 - parseInt(attempts);
      const wordleDate = getDateFromWordleNumber(parseInt(gameNumber));

      const existing = await db.get(`SELECT * FROM scores WHERE group_id = ? AND player_name = ? AND score_date = ?`, [groupId, senderName, wordleDate]);
      if (existing) { await msg.reply(`⚠️ ${senderName}, you've already submitted for Wordle #${gameNumber} (${wordleDate}).`); return; }

      await db.run(`INSERT INTO scores (group_id, player_name, score_date, score) VALUES (?, ?, ?, ?)`, [groupId, senderName, wordleDate, score]);
      log('INFO', `Inserted score for ${senderName} (group=${groupId}, date=${wordleDate}, score=${score})`);

      const leaderboardMsg = await getCombinedLeaderboard(groupId);
      await msg.reply(leaderboardMsg);
    }
  } catch (err) {
    log('ERROR', 'Error handling message:', err && err.stack ? err.stack : err);
    // don't crash the process for a single message failure
  }
});

// === DAILY CRON ===
try {
  cron.schedule('0 20 * * *', async () => {
    try {
      log('INFO', 'Running daily cron job: sending LeetCode stats');
      const chats = await client.getChats();
      const targetChat = chats.find(c => c.isGroup && c.name === TARGET_GROUP_NAME);
      if (!targetChat) { log('WARN', `Daily cron: target group '${TARGET_GROUP_NAME}' not found`); return; }
      const stats = await getLeetcodeStats(LEETCODE_USER);
      await targetChat.sendMessage(stats);
      log('INFO', '✅ Daily LeetCode stats sent');
    } catch (err) {
      log('ERROR', 'Error in daily cron job:', err && err.stack ? err.stack : err);
    }
  }, { timezone: 'Asia/Kolkata' });

  // Daily Word at 12 AM
  cron.schedule('0 0 * * *', async () => {
    await sendDailyWord(client);
  }, { timezone: 'Asia/Kolkata' });

  // Wordle Reminder at 11:30 PM IST
  cron.schedule('30 23 * * *', async () => {
    await sendWordleReminder(client);
  }, { timezone: 'Asia/Kolkata' });
} catch (err) {
  log('ERROR', 'Failed to schedule cron job:', err && err.stack ? err.stack : err);
}

// === START Helpers ===
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms))
  ]);
}

(async () => {
  try {
    await initDB();
    log('INFO', 'Initialization complete. Calling client.initialize()');

    try {
      await withTimeout(client.initialize(), 60000, 'client.initialize()');
      log('INFO', 'client.initialize() completed');
    } catch (initErr) {
      log('ERROR', 'client.initialize() failed or timed out:', initErr && initErr.stack ? initErr.stack : initErr);
      // give a hint to operator instead of retrying automatically
      log('INFO', 'If this was due to network/CDN outage, retry after connectivity is restored. To debug visually set HEADLESS=false and ensure PUPPETEER_EXECUTABLE_PATH points to a valid Chrome/Chromium binary.');
      throw initErr;
    }

  } catch (err) {
    log('ERROR', 'Startup failed:', err && err.stack ? err.stack : err);
    process.exit(1);
  }
})();

// === ADDITIONAL DIAGNOSTIC EXPORTS ===
export const _internalDiagnostics = {
  DB_PATH,
  getDbHandle: () => db,
  getLogLevel: () => process.env.LOG_LEVEL || 'INFO',
  puppeteerOptions
};
