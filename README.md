
# 🧩 Wordle Bot — Setup & Management Guide

## 📂 Database

**Location:**
By default, the database is stored in the `data/` directory within the project folder:
`./data/bot.db`

You can configure this path using the `DB_PATH` environment variable in a `.env` file.

### ⚙️ Configuration (Optional)

You can create a `.env` file to override default settings, but it is not required.

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_PATH` | `./data/bot.db` | Path to the SQLite database |
| `LOG_LEVEL` | `INFO` | Logging verbosity (DEBUG, INFO, WARN, ERROR) |

### 🔍 View Schema

Launch SQLite shell:
```bash
sqlite3 data/bot.db
````

Then inside SQLite:

```sql
.schema scores
```

**Schema:**

```sql
CREATE TABLE scores (
    group_id TEXT,
    player_name TEXT,
    score_date DATE,
    score INT
);
```

---

### 🧪 Sample Data

```
120363404178341234@g.us|Dheva|2025-11-03|4
120363404178341234@g.us|Vinoth|2025-11-03|3
120363402205142075@g.us|Yuvaraja P|2025-11-02|3
120363402205142075@g.us|Karisni|2025-11-02|3
120363402205142075@g.us|Yuvaraja P|2025-11-03|3
120363402205142075@g.us|Yuvaraja P|2025-11-04|3
```

---

### ✏️ Update a Record

To update any specific date:

```sql
UPDATE scores
SET score_date = '2025-11-02'
WHERE group_id = '120363404178341234@g.us'
  AND player_name = 'Kishore'
  AND score_date = '2025-11-03'
  AND score = 3;
```

---

## ⚙️ PM2 Commands

### 🚀 Initial Setup

Start and register the bot:

```bash
pm2 start index.js --name wordle-bot
```

### 📊 Monitor

```bash
pm2 show wordle-bot
# or
pm2 list
```

### ▶️ Start / Restart

```bash
pm2 start wordle-bot
# or
pm2 restart wordle-bot
```

### ⏹ Stop

```bash
pm2 stop wordle-bot
```

### 📜 View Logs

```bash
pm2 logs
# or
pm2 logs wordle-bot
```

---

### 💾 (Optional) Backup & Restore

**Backup the database:**

```bash
cp data/bot.db data/bot_backup.db
```

**Restore from backup:**

```bash
cp data/bot_backup.db data/bot.db
```

---

**Author:** Yuvaraja P
**Last Updated:** January 2026
