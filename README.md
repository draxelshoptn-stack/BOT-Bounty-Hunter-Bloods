🤖 Discord Bot — Complete
A self-hosted Discord bot with a built-in web control panel.

Features
/announce [message] — DM all server members instantly
/botvoice [channel_id] — Lock bot to a voice channel 24/7 (auto-reconnects if kicked)
/leavevoice — Leave the voice channel
Web dashboard — Send broadcasts, view history, manage voice — all from the browser
Quick Start
git clone https://github.com/YOUR_NAME/discord-bot.git
cd discord-bot
npm install
cp .env.example .env       # then fill in your token
npm start

Open http://localhost:3000 to see the dashboard.

Discord Setup
Go to discord.com/developers/applications
New Application → name it → go to Bot
Click Reset Token → copy it → paste into .env
Enable under Privileged Gateway Intents:
✅ Server Members Intent
✅ Message Content Intent
OAuth2 → URL Generator → scopes: bot + applications.commands → permissions: Administrator → open the invite link to add the bot to your server
Hosting (Railway — easiest)
Push this folder to a GitHub repo
Go to railway.app → New Project → Deploy from GitHub
Select the repo
Variables tab → add:
DISCORD_BOT_TOKEN = your token
ADMIN_SECRET = a password for the dashboard (optional but recommended)
Done — Railway runs it 24/7 automatically
Hosting (VPS / Linux)
# Install Node 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt install -y nodejs
# Clone & install
git clone https://github.com/YOUR_NAME/discord-bot.git && cd discord-bot
npm install
cp .env.example .env && nano .env   # fill in your token
# Run forever with PM2
npm install -g pm2
pm2 start index.js --name bot
pm2 save && pm2 startup

Environment Variables
Variable	Required	Description
DISCORD_BOT_TOKEN	✅ Yes	Bot token from Developer Portal
GUILD_ID	No	Register commands to one guild instantly (testing)
ADMIN_SECRET	No	Password to protect the web dashboard
PORT	No	Web server port (default: 3000)
Files
├── index.js        ← Bot + API server (single file)
├── public/
│   └── index.html  ← Web control panel (no build step)
├── package.json
├── .env.example
├── .gitignore
└── config.json     ← Auto-created; stores voice channel & announcement history
