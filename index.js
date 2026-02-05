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

/* =========================================================
   CONFIG
========================================================= */
const BOT_NUMBER = '919011111111';
const TARGET_GROUP_NAME = 'Project Minu';
const DAILY_WORD_GROUP_NAME = 'Wordle 2.0';
const LEETCODE_USER = 'mathanika';
const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data', 'bot.db');

/* =========================================================
   LOGGER
========================================================= */
const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const CURRENT_LEVEL = process.env.LOG_LEVEL
  ? LOG_LEVELS[process.env.LOG_LEVEL] ?? LOG_LEVELS.INFO
  : LOG_LEVELS.INFO;

function log(level, ...args) {
  const lvl = level.toUpperCase();
  if ((LOG_LEVELS[lvl] ?? 0) < CURRENT_LEVEL) return;
  const ts = new Date().toISOString();
  const prefix = `${ts} ${lvl}`;
  lvl === 'ERROR' ? console.error(prefix, ...args)
    : lvl === 'WARN' ? console.warn(prefix, ...args)
    : console.log(prefix, ...args);
}

/* =========================================================
   PROCESS SAFETY
========================================================= */
process.on('uncaughtException', (err) => {
  log('ERROR', 'Uncaught Exception:', err?.stack || err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  log('ERROR', 'Unhandled Rejection:', reason?.stack || reason);
  process.exit(1);
});

/* =========================================================
   DB INIT
========================================================= */
let db;

async function ensureDbFileAccessible(pathToFile) {
  await fsPromises.mkdir(path.dirname(pathToFile), { recursive: true });
  const fh = await fsPromises.open(pathToFile, 'a+');
  await fh.close();
  await fsPromises.access(pathToFile, fs.constants.R_OK | fs.constants.W_OK);
}

async function initDB() {
  await ensureDbFileAccessible(DB_PATH);
  db = await open({ filename: DB_PATH, driver: sqlite3.Database });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS scores (
      group_id TEXT,
      player_name TEXT,
      score_date DATE,
      score INT
    );

    CREATE TABLE IF NOT EXISTS scores_archive (
      group_id TEXT,
      player_name TEXT,
      score_date DATE,
      score INT
    );

    CREATE TABLE IF NOT EXISTS leetcode_stats (
      stat_date DATE,
      username TEXT,
      total INT,
      easy INT,
      medium INT,
      hard INT,
      PRIMARY KEY (stat_date, username)
    );

    CREATE TABLE IF NOT EXISTS daily_words (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      word TEXT UNIQUE,
      used INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS sent_words (
      sent_date DATE PRIMARY KEY,
      word TEXT NOT NULL
    );
  `);

  log('INFO', 'DB initialized');
}

/* =========================================================
   DATE UTILS
========================================================= */
function getISTDateKey(offsetDays = 0) {
  const d = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().split('T')[0];
}

/* =========================================================
   WHATSAPP CLIENT SETUP
========================================================= */
const puppeteerOptions = {
  headless: process.env.HEADLESS !== 'false',
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu'
  ]
};

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: puppeteerOptions
});

/* =========================================================
   READY STATE CONTROL (CRITICAL)
========================================================= */
let isReady = false;

client.on('ready', () => {
  isReady = true;
  log('INFO', '✅ WhatsApp client READY');
});

client.on('qr', qr => {
  log('INFO', 'QR received');
  qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => log('INFO', 'Authenticated'));
client.on('auth_failure', msg => {
  log('ERROR', 'Auth failure:', msg);
  process.exit(1);
});

/* 🔥 HARD EXIT ON DISCONNECT */
client.on('disconnected', reason => {
  log('ERROR', 'WhatsApp disconnected:', reason);
  process.exit(1);
});

/* =========================================================
   SAFE GET CHATS (CRITICAL FIX)
========================================================= */
async function safeGetChats() {
  if (!isReady) throw new Error('Client not ready');

  try {
    return await client.getChats();
  } catch (err) {
    if (err.message?.includes('reading \'update\'')) {
      log('ERROR', 'Fatal WhatsApp state corruption detected');
      process.exit(1);
    }
    throw err;
  }
}

/* =========================================================
   DAILY WORD
========================================================= */
async function getAndMarkRandomWord() {
  const row = await db.get(
    `SELECT * FROM daily_words WHERE used = 0 ORDER BY RANDOM() LIMIT 1`
  );
  if (!row) return null;
  await db.run(`UPDATE daily_words SET used = 1 WHERE id = ?`, row.id);
  return row.word;
}

async function sendDailyWord() {
  if (!isReady) return;

  const word = await getAndMarkRandomWord();
  if (!word) {
    log('WARN', 'No unused words available');
    return;
  }

  const chats = await safeGetChats();
  const group = chats.find(c => c.isGroup && c.name === DAILY_WORD_GROUP_NAME);
  if (!group) return;

  await group.sendMessage(`🌟 *Word of the Day* 🌟\n\n${word}`);
}

/* =========================================================
   WORDLE REMINDER
========================================================= */
async function sendWordleReminder() {
  if (!isReady) return;

  const chats = await safeGetChats();
  const group = chats.find(c => c.isGroup && c.name === DAILY_WORD_GROUP_NAME);
  if (!group) return;

  await group.sendMessage('⏰ Wordle Reminder!');
}

/* =========================================================
   CRON JOBS (GUARDED)
========================================================= */
cron.schedule('0 20 * * *', async () => {
  if (!isReady) return;
  const chats = await safeGetChats();
  const group = chats.find(c => c.isGroup && c.name === TARGET_GROUP_NAME);
  if (!group) return;

  const stats = 'LeetCode stats here';
  await group.sendMessage(stats);
}, { timezone: 'Asia/Kolkata' });

cron.schedule('0 0 * * *', sendDailyWord, { timezone: 'Asia/Kolkata' });
cron.schedule('30 23 * * *', sendWordleReminder, { timezone: 'Asia/Kolkata' });

/* =========================================================
   STARTUP
========================================================= */
(async () => {
  await initDB();

  log('INFO', 'Initializing WhatsApp client...');
  await Promise.race([
    client.initialize(),
    new Promise((_, r) =>
      setTimeout(() => r(new Error('client.initialize timeout')), 60000)
    )
  ]);

})();
