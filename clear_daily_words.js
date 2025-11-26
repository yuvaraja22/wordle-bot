import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'path';

const DB_PATH = '/home/yuvarajacoc/var/lib/wordle-bot-data/bot.db';

async function clearWords() {
    let db;
    try {
        console.log('Opening database...');
        db = await open({ filename: DB_PATH, driver: sqlite3.Database });

        console.log('Deleting all words from daily_words table...');
        const result = await db.run(`DELETE FROM daily_words`);

        // Reset auto-increment counter
        await db.run(`DELETE FROM sqlite_sequence WHERE name='daily_words'`);

        console.log(`✅ Deleted ${result.changes} words.`);

    } catch (err) {
        console.error('Error clearing words:', err);
    } finally {
        if (db) await db.close();
    }
}

clearWords();
