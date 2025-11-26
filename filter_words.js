import fs from 'fs/promises';
import path from 'path';

const OLD_WORDS_FILE = 'old_words.txt';
const NEW_WORDS_FILE = 'new_words.txt';

const FILTERED_WORDS_FILE = 'filtered_words.txt';

async function filterWords() {
    try {
        // Read files
        const oldContent = await fs.readFile(OLD_WORDS_FILE, 'utf-8');
        const newContent = await fs.readFile(NEW_WORDS_FILE, 'utf-8');

        // Parse old words (space separated, potentially uppercase)
        // Remove punctuation like '.' if present at the end
        const oldWords = new Set(
            oldContent
                .replace(/\./g, '')
                .split(/\s+/)
                .map(w => w.trim().toLowerCase())
                .filter(w => w.length > 0)
        );

        console.log(`Found ${oldWords.size} words in ${OLD_WORDS_FILE}`);

        // Parse new words (newline separated)
        const newWordsLines = newContent.split(/\r?\n/);
        const filteredWords = [];
        let removedCount = 0;

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
            } else {
                filteredWords.push(word);
            }
        }

        // Write to new file
        await fs.writeFile(FILTERED_WORDS_FILE, filteredWords.join('\n') + '\n');

        console.log(`Processed ${newWordsLines.length} lines in ${NEW_WORDS_FILE}`);
        console.log(`Removed ${removedCount} words (duplicates, length != 5, or repeating letters).`);
        console.log(`Remaining words written to ${FILTERED_WORDS_FILE}: ${filteredWords.length}`);

    } catch (err) {
        console.error('Error filtering words:', err);
    }
}

filterWords();
