import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import fs from 'fs/promises';
import path from 'path';

const DB_PATH = path.join(process.cwd(), 'bot.db');
const NEW_WORDS_FILE = 'new_words.txt';

async function bulkLoad() {
    let db;
    try {
        console.log('Opening database...');
        db = await open({ filename: DB_PATH, driver: sqlite3.Database });

        // Ensure table exists
        await db.run(`CREATE TABLE IF NOT EXISTS daily_words (id INTEGER PRIMARY KEY AUTOINCREMENT, word TEXT UNIQUE, used INTEGER DEFAULT 0)`);

        // Read words
        console.log(`Reading ${NEW_WORDS_FILE}...`);
        const content = await fs.readFile(NEW_WORDS_FILE, 'utf-8');
        const words = content.split(/\r?\n/).map(w => w.trim()).filter(w => w.length > 0);

        console.log(`Found ${words.length} words to process.`);

        let added = 0;
        let skipped = 0;

        for (const word of words) {
            try {
                await db.run(`INSERT INTO daily_words (word) VALUES (?)`, [word]);
                added++;
                if (added % 50 === 0) process.stdout.write('.');
            } catch (err) {
                if (err.message.includes('UNIQUE constraint failed')) {
                    skipped++;
                } else {
                    console.error(`\nError adding "${word}":`, err.message);
                }
            }
        }

        console.log(`\n\nBulk load complete.`);
        console.log(`✅ Added: ${added}`);
        console.log(`⚠️ Skipped (Duplicates): ${skipped}`);

    } catch (err) {
        console.error('Fatal error:', err);
    } finally {
        if (db) await db.close();
    }
}

bulkLoad();
