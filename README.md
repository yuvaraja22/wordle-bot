DB location  
~/var/lib/wordle-bot-data$ sqlite3 bot.db  

To see the schema  
> .schema scores  

CREATE TABLE scores (  
      group_id TEXT,  
      player_name TEXT,  
      score_date DATE,  
      score INT  
      );  
      
Sample data  
120363404178341234@g.us|Dheva|2025-11-03|4  
120363404178341234@g.us|Vinoth|2025-11-03|3  
120363402205142075@g.us|Yuvaraja P|2025-11-02|3  
120363402205142075@g.us|Karisni|2025-11-02|3  
120363402205142075@g.us|Yuvaraja P|2025-11-03|3  
120363402205142075@g.us|Yuvaraja P|2025-11-04|3  

To update any date  
UPDATE scores  
SET score_date = '2025-11-02'  
WHERE group_id = '120363404178341234@g.us'  
  AND player_name = 'Kishore'  
  AND score_date = '2025-11-03'  
  AND score = 3;  

PM2 COMMANDS  
To register initially  
pm2 start index.js --name wordle-bot  

To monitor the bot  
pm2 show or pm2 list  

To start the bot  
pm2 start wordle-bot or pm2 restart wordle-bot  

To stop the bot  
pm2 stop wordle-bot  

To see logs  
pm2 logs or pm2 logs wordle-bot  

