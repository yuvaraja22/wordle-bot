import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import qrcode from 'qrcode-terminal';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import cron from 'node-cron';
import { Storage } from '@google-cloud/storage';

// === CONFIG ===
const DATA_FILE = path.resolve('./scores.json');
const ARCHIVE_DIR = path.resolve('./archives');
const BOT_NUMBER = '919011111111'; // bot's own number to exclude from pending
const FILE_NAME = 'scores.json'; // main JSON file in bucket
const TARGET_GROUP_NAME = 'Project Minu'; // replace with your group name
const LEETCODE_USER = 'mathanika';
const BUCKET_NAME = 'wordle-bot-storage'; // your GCS bucket name

// === GCS SETUP ===
const storage = new Storage();
const bucket = storage.bucket(BUCKET_NAME);

// === HELPERS ===
async function loadScores() {
  try {
    const file = bucket.file(FILE_NAME);
    const [contents] = await file.download();
    return JSON.parse(contents.toString());
  } catch {
    return {}; // if file doesn't exist
  }
}

async function saveScores(data) {
  const file = bucket.file(FILE_NAME);
  await file.save(JSON.stringify(data, null, 2));
}

function getParticipantName(p) {
  // Use notifyName if exists, else fallback to user ID or number
  return p.notifyName || p.id._serialized || p.id.user.split('@')[0];
}

function getTodayKey() {
  const now = new Date();
  return now.toISOString().split('T')[0]; // YYYY-MM-DD
}

// Archive JSON to GCS in "archives/" folder
async function archiveData(data) {
  const archiveFileName = `archives/scores_${Date.now()}.json`;
  const file = bucket.file(archiveFileName);
  await file.save(JSON.stringify(data, null, 2));
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
              submissions
            }
          }
        }
      }`,
      variables: { username },
    };

    const res = await axios.post(url, query, {
      headers: { 'Content-Type': 'application/json' },
    });

    const user = res.data.data.matchedUser;
    if (!user) return `❌ Could not fetch stats for ${username}`;

    // Total problems solved
    const totalSolved = user.submitStats.acSubmissionNum
      .reduce((sum, d) => sum + d.count, 0);

    // Compose stats message
    let statsMsg = `📊 LeetCode stats for *${username}*:\n`;
    user.submitStats.acSubmissionNum.forEach(d => {
      if(d.difficulty === "All")
        statsMsg += `🏆 Total problems solved: ${d.count}\n`;
      else
        statsMsg += `${d.difficulty}: ${d.count}\n`;
    });

    return statsMsg;

  } catch (err) {
    console.error(err);
    return `❌ Error fetching stats for ${username}`;
  }
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
    .map(getParticipantName)
    .filter(name => name !== BOT_NUMBER); // exclude bot

  const pending = allMembers.filter(name => !postedUsers.includes(name));
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

  // ===== LEETCODE LOGIC (only for TARGET_GROUP_NAME) =====
  if (chat.name === TARGET_GROUP_NAME) {
    if (/^\/minustatus?$/i.test(text)) {
      const stats = await getLeetcodeStats('mathanika');
      await msg.reply(stats);
    }
  }
  // Wait for the data to load from GCS
  let scores = await loadScores();
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
      await msg.reply(`⏳ Pending Wordle submissions:\n${pending.join('\s')}`);
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


// === DAILY 8PM LEETCODE STATS ===
cron.schedule('0 20 * * *', async () => {
  const chats = await client.getChats();
  const targetChat = chats.find(c => c.isGroup && c.name === TARGET_GROUP_NAME);
  if (!targetChat) return console.log('Target group not found.');

  const stats = await getLeetcodeStats(LEETCODE_USER);
  await targetChat.sendMessage(stats);
  console.log('✅ Daily LeetCode stats sent');
});

// === START BOT ===
client.initialize();
