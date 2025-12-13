import fs from 'fs/promises';
import path from 'path';

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const filter = require('leo-profanity');

const OLD_WORDS_FILE = 'old_words.txt';
const NEW_WORDS_FILE = 'new_words.txt';
const FILTERED_WORDS_FILE = 'filtered_words.txt';

// Custom blocklist for words that might bypass standard filters or are contextually inappropriate
const MANUAL_BLOCKLIST = new Set([
    'nuder',
    // Add other specific words here if needed
]);

async function filterWords() {
    try {
        // Load dictionary (default is usually English)
        filter.loadDictionary();

        // Read files
        const oldContent = await fs.readFile(OLD_WORDS_FILE, 'utf-8');
        const newContent = await fs.readFile(NEW_WORDS_FILE, 'utf-8');

        // Parse old words
        const oldWords = new Set(
            oldContent
                .replace(/\./g, '')
                .split(/\s+/)
                .map(w => w.trim().toLowerCase())
                .filter(w => w.length > 0)
        );

        console.log(`Found ${oldWords.size} words in ${OLD_WORDS_FILE}`);

        // Parse new words
        const newWordsLines = newContent.split(/\r?\n/);
        const filteredWords = [];
        let removedCount = 0;
        let profanityCount = 0;

        for (const line of newWordsLines) {
            const word = line.trim();
            if (!word) continue;

            const lowerWord = word.toLowerCase();
            const isUniqueChars = new Set(lowerWord).size === lowerWord.length;

            if (word.length !== 5) {
                removedCount++;
            } else if (!isUniqueChars) {
                removedCount++;
            } else if (oldWords.has(lowerWord)) {
                removedCount++;
            } else if (filter.check(lowerWord) || MANUAL_BLOCKLIST.has(lowerWord)) {
                profanityCount++;
                // console.log(`Blocked: ${word}`); // Uncomment to see blocked words
            } else {
                filteredWords.push(word);
            }
        }

        // Write to new file
        await fs.writeFile(FILTERED_WORDS_FILE, filteredWords.join('\n') + '\n');

        console.log(`Processed ${newWordsLines.length} lines in ${NEW_WORDS_FILE}`);
        console.log(`Removed ${removedCount} words (duplicates/length/repeating).`);
        console.log(`Blocked ${profanityCount} words (profanity/blocklist).`);
        console.log(`Remaining words written to ${FILTERED_WORDS_FILE}: ${filteredWords.length}`);

    } catch (err) {
        console.error('Error filtering words:', err);
    }
}

filterWords();
