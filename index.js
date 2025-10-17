import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import qrcode from 'qrcode-terminal';
import fs from 'fs';
import path from 'path';

// === CONFIG ===
const DATA_FILE = path.resolve('./scores.json');
const ARCHIVE_DIR = path.resolve('./archives');
const BOT_NUMBER = '919011111111'; // bot's own number to exclude from pending

// === HELPERS ===
function loadScores() {
  if (!fs.existsSync(DATA_FILE)) return {};
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function saveScores(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function getTodayKey() {
  const now = new Date();
  return now.toISOString().split('T')[0]; // YYYY-MM-DD
}

function archiveData(data) {
  if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR);
  const archiveFile = path.join(ARCHIVE_DIR, `scores_${Date.now()}.json`);
  fs.writeFileSync(archiveFile, JSON.stringify(data, null, 2));
}

function getDailyLeaderboard(scores, groupId, today) {
  const groupScores = scores[groupId]?.[today] || {};
  if (Object.keys(groupScores).length === 0) return '📊 No scores submitted today yet!';
  const sorted = Object.entries(groupScores).sort((a, b) => a[1] - b[1]);
  const board = sorted.map(([name, score], i) => `${i + 1}. ${name}: ${score}`).join('\n');
  return `🏆 *Today's Leaderboard (${today})*\n\n${board}`;
}

function getTotalLeaderboard(scores, groupId) {
  const groupData = scores[groupId] || {};
  const totalScores = {};

  for (const date of Object.keys(groupData)) {
    for (const [name, score] of Object.entries(groupData[date])) {
      totalScores[name] = (totalScores[name] || 0) + score;
    }
  }

  if (Object.keys(totalScores).length === 0) return '📊 No total scores recorded yet.';
  const sorted = Object.entries(totalScores).sort((a, b) => a[1] - b[1]);
  const board = sorted.map(([name, score], i) => `${i + 1}. ${name}: ${score}`).join('\n');
  return `🏁 *All-Time Leaderboard*\n\n${board}`;
}

async function getPendingParticipants(chat, scores, groupId) {
  const today = getTodayKey();
  const postedUsers = Object.keys(scores[groupId]?.[today] || {});
  
  const allMembers = (await chat.participants)
    .map(p => {
      // Prefer notifyName, fallback to user ID (number)
      const name = p.notifyName || p.id.user.split('@')[0];
      return name;
    })
    .filter(u => u !== BOT_NUMBER); // exclude bot itself

  const pending = allMembers.filter(u => !postedUsers.includes(u));
  return pending;
}

// === BOT INITIALIZATION ===
const client = new Client({
  authStrategy: new LocalAuth(),
});

client.on('qr', (qr) => {
  qrcode.generate(qr, { small: true });
  console.log('📱 Scan QR code with WhatsApp to login.');
});

client.on('ready', () => {
  console.log('✅ Wordle Bot is ready!');
});

// === MESSAGE HANDLER ===
client.on('message', async (msg) => {
  const chat = await msg.getChat();
  if (!chat.isGroup) return;

  const groupId = chat.id._serialized;
  const senderName = msg._data.notifyName || msg.author || msg.from;
  const text = msg.body.trim();
  let scores = loadScores();
  if (!scores[groupId]) scores[groupId] = {};

  // ===== COMMANDS =====
  if (text === '/current') {
    const today = getTodayKey();
    const response = getDailyLeaderboard(scores, groupId, today);
    await msg.reply(response);
    return;
  }

  if (text === '/total') {
    const response = getTotalLeaderboard(scores, groupId);
    await msg.reply(response);
    return;
  }

  if (text === '/pending') {
    const pending = await getPendingParticipants(chat, scores, groupId);
      if (pending.length === 0) {
      await msg.reply('🎉 Everyone has submitted today’s Wordle!');
      } else {
      // put each user in a new line
      await msg.reply(`⏳ Pending Wordle submissions:\n${pending.join('\n')}`);
      }
      return;
    }

  if (text === '/resetConfirmed') {
    const oldData = loadScores();
    archiveData(oldData);
    saveScores({});
    await msg.reply('🗑️ All scores archived and reset. Fresh start!');
    return;
  }

  // ===== HANDLE WORDLE RESULTS =====
// Handles commas in the game number like "1,581" and "X/6" (score 0)
const wordleMatch = text.match(/Wordle\s+([\d,]+)\s+([X\d])\/6/i);
if (wordleMatch) {
  let [_, gameNumber, attempts] = wordleMatch;
  gameNumber = gameNumber.replace(/,/g, ''); // Remove commas

  // Convert X to 7
  attempts = attempts.toUpperCase() === 'X' ? 7 : parseInt(attempts);

  const today = getTodayKey();
  if (!scores[groupId][today]) scores[groupId][today] = {};

  // Prevent duplicate
  if (scores[groupId][today][senderName] !== undefined) {
    await msg.reply(`⚠️ ${senderName}, you've already submitted today's score.`);
    return;
  }

  // Record score
  scores[groupId][today][senderName] = attempts;
  saveScores(scores);

  // Show updated current leaderboard immediately
  const board = getDailyLeaderboard(scores, groupId, today);
  await msg.reply(board);
}
});

// === START BOT ===
client.initialize();
