require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ChannelType,
  Events,
} = require("discord.js");

const {
  joinVoiceChannel,
  VoiceConnectionStatus,
  entersState,
} = require("@discordjs/voice");

const express = require("express");
const path    = require("path");
const fs      = require("fs");

// ─── Persistence (config.json) ───────────────────────────────────────────────
const CONFIG_FILE = path.join(__dirname, "config.json");

function loadConfig() {
  try { if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")); }
  catch {}
  return { announcements: [] };
}

function saveConfig(patch) {
  const data = loadConfig();
  const merged = { ...data, ...patch };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2));
  return merged;
}

// ─── Bot state ───────────────────────────────────────────────────────────────
let botClient       = null;
let voiceConnection = null;
let lockedChannelId = null;
let lockedGuildId   = null;
let lockedChannelName = null;
let reconnectTimer  = null;
let startTime       = null;

function scheduleReconnect(delayMs = 4000) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(async () => {
    if (lockedChannelId && lockedGuildId && botClient) {
      console.log("[Voice] Reconnecting...");
      try { await joinAndLockVoice(lockedChannelId, lockedGuildId); }
      catch (e) { console.error("[Voice] Reconnect failed:", e.message); scheduleReconnect(15000); }
    }
  }, delayMs);
}

async function joinAndLockVoice(channelId, guildId) {
  const guild   = await botClient.guilds.fetch(guildId);
  const channel = await botClient.channels.fetch(channelId);
  if (!channel || channel.type !== ChannelType.GuildVoice)
    throw new Error("Channel not found or not a voice channel");

  if (voiceConnection) { voiceConnection.destroy(); voiceConnection = null; }

  voiceConnection = joinVoiceChannel({
    channelId, guildId,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: true, selfMute: true,
  });

  voiceConnection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(voiceConnection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(voiceConnection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      console.warn("[Voice] Dropped — scheduling reconnect");
      scheduleReconnect();
    }
  });

  lockedChannelId   = channelId;
  lockedGuildId     = guildId;
  lockedChannelName = channel.name;
  saveConfig({ voiceChannelId: channelId, voiceGuildId: guildId, voiceChannelName: channel.name });
  console.log(`[Voice] Locked to: #${channel.name}`);
}

function leaveVoice() {
  if (voiceConnection) { voiceConnection.destroy(); voiceConnection = null; }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  lockedChannelId = null; lockedGuildId = null; lockedChannelName = null;
  saveConfig({ voiceChannelId: null, voiceGuildId: null, voiceChannelName: null });
}

async function dmAllMembers(guild, message) {
  const members = await guild.members.fetch();
  let sent = 0, failed = 0;
  for (const [, m] of members) {
    if (m.user.bot) continue;
    try { await m.send(message); sent++; } catch { failed++; }
  }
  return { sent, failed, total: sent + failed };
}

// ─── Slash commands ───────────────────────────────────────────────────────────
const slashCommands = [
  new SlashCommandBuilder()
    .setName("announce")
    .setDescription("Send a DM to all server members")
    .addStringOption(o => o.setName("message").setDescription("Message text (max 2000 chars)").setRequired(true).setMaxLength(2000))
    .setDefaultMemberPermissions(8),

  new SlashCommandBuilder()
    .setName("botvoice")
    .setDescription("Lock the bot to a voice channel permanently")
    .addStringOption(o => o.setName("channel_id").setDescription("Voice channel ID").setRequired(true))
    .setDefaultMemberPermissions(8),

  new SlashCommandBuilder()
    .setName("leavevoice")
    .setDescription("Leave the voice channel")
    .setDefaultMemberPermissions(8),
];

// ─── Discord client ───────────────────────────────────────────────────────────
async function startBot() {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) { console.error("[Bot] DISCORD_BOT_TOKEN not set — skipping bot start"); return; }

  botClient = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.DirectMessages,
    ],
  });

  botClient.once(Events.ClientReady, async (ready) => {
    console.log(`[Bot] Logged in as ${ready.user.tag}`);
    startTime = new Date();

    // Register slash commands
    const rest = new REST({ version: "10" }).setToken(token);
    const guildId = process.env.GUILD_ID;
    const route   = guildId
      ? Routes.applicationGuildCommands(ready.user.id, guildId)
      : Routes.applicationCommands(ready.user.id);
    await rest.put(route, { body: slashCommands.map(c => c.toJSON()) });
    console.log(`[Bot] Slash commands registered${guildId ? ` for guild ${guildId}` : " globally"}`);

    // Restore voice from last session
    const cfg = loadConfig();
    if (cfg.voiceChannelId && cfg.voiceGuildId) {
      console.log("[Voice] Restoring from saved config...");
      try { await joinAndLockVoice(cfg.voiceChannelId, cfg.voiceGuildId); }
      catch (e) { console.error("[Voice] Restore failed:", e.message); }
    }
  });

  botClient.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "announce") {
      const message = interaction.options.getString("message", true);
      await interaction.deferReply({ ephemeral: true });
      try {
        const result = await dmAllMembers(interaction.guild, message);
        saveAnnouncementToConfig(message, result);
        await interaction.editReply(`✅ Done! Sent: **${result.sent}** | Failed: **${result.failed}** | Total: **${result.total}**`);
      } catch (e) {
        console.error("[Bot] Announce error:", e.message);
        await interaction.editReply("❌ An error occurred while sending. Please try again.");
      }
    }

    if (interaction.commandName === "botvoice") {
      const channelId = interaction.options.getString("channel_id", true);
      await interaction.deferReply({ ephemeral: true });
      try {
        await joinAndLockVoice(channelId, interaction.guildId);
        await interaction.editReply("🔒 Bot is now locked to the voice channel!");
      } catch (e) {
        console.error("[Bot] Voice error:", e.message);
        await interaction.editReply(`❌ Failed to join: ${e.message}`);
      }
    }

    if (interaction.commandName === "leavevoice") {
      leaveVoice();
      await interaction.reply({ content: "👋 Left the voice channel.", ephemeral: true });
    }
  });

  botClient.on(Events.VoiceStateUpdate, async (oldState) => {
    if (lockedChannelId && botClient?.user && oldState.member?.id === botClient.user.id && !oldState.channelId) {
      console.warn("[Voice] Bot was kicked — reconnecting...");
      scheduleReconnect();
    }
  });

  await botClient.login(token);
}

function saveAnnouncementToConfig(message, result) {
  const cfg = loadConfig();
  const announcements = cfg.announcements || [];
  announcements.unshift({ id: Date.now(), message, sentCount: result.sent, failedCount: result.failed, sentAt: new Date().toISOString() });
  if (announcements.length > 100) announcements.splice(100);
  saveConfig({ announcements });
}

// ─── Express API ──────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Optional admin secret guard
app.use("/api", (req, res, next) => {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return next();
  const auth  = req.headers["authorization"] ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (token !== secret) return res.status(401).json({ error: "Unauthorized" });
  next();
});

// GET /api/status
app.get("/api/status", (_req, res) => {
  if (!botClient || !botClient.isReady()) {
    return res.json({ online: false, botName: "Not Connected", guildName: null, memberCount: 0, voiceChannelName: null, voiceLocked: false, uptimeSeconds: null });
  }
  const guild = botClient.guilds.cache.first();
  res.json({
    online: true,
    botName: botClient.user.tag,
    botId: botClient.user.id,
    guildName: guild?.name ?? null,
    guildId: guild?.id ?? null,
    memberCount: guild?.memberCount ?? 0,
    voiceChannelName: lockedChannelName,
    voiceChannelId: lockedChannelId,
    voiceLocked: !!lockedChannelId,
    uptimeSeconds: startTime ? Math.floor((Date.now() - startTime.getTime()) / 1000) : null,
  });
});

// GET /api/stats
app.get("/api/stats", (_req, res) => {
  const cfg = loadConfig();
  const announcements = cfg.announcements || [];
  const totalSent = announcements.reduce((a, r) => a + (r.sentCount || 0), 0);
  res.json({
    totalAnnouncements: announcements.length,
    membersReached: totalSent,
    lastAnnouncedAt: announcements[0]?.sentAt ?? null,
    uptimeSeconds: startTime ? Math.floor((Date.now() - startTime.getTime()) / 1000) : null,
  });
});

// POST /api/announce
app.post("/api/announce", async (req, res) => {
  if (!botClient?.isReady()) return res.status(503).json({ error: "Bot is not connected" });
  const { message } = req.body;
  if (!message || typeof message !== "string" || !message.trim())
    return res.status(400).json({ error: "message is required" });

  try {
    const guild  = botClient.guilds.cache.first();
    if (!guild) return res.status(503).json({ error: "Bot is not in any guild" });
    const result = await dmAllMembers(guild, message.trim());
    saveAnnouncementToConfig(message.trim(), result);
    res.json({ sent: result.sent, failed: result.failed, total: result.total });
  } catch (e) {
    console.error("[API] Announce error:", e.message);
    res.status(500).json({ error: "Failed to send messages" });
  }
});

// GET /api/announcements
app.get("/api/announcements", (_req, res) => {
  const cfg = loadConfig();
  res.json(cfg.announcements || []);
});

// GET /api/voice
app.get("/api/voice", (_req, res) => {
  const cfg = loadConfig();
  res.json({
    channelId:   cfg.voiceChannelId   ?? null,
    channelName: cfg.voiceChannelName ?? null,
    guildId:     cfg.voiceGuildId     ?? null,
    active:      !!lockedChannelId,
  });
});

// POST /api/voice
app.post("/api/voice", async (req, res) => {
  if (!botClient?.isReady()) return res.status(503).json({ error: "Bot is not connected" });
  const { channelId } = req.body;
  if (!channelId) return res.status(400).json({ error: "channelId is required" });
  const guild = botClient.guilds.cache.first();
  if (!guild) return res.status(503).json({ error: "Bot is not in any guild" });
  try {
    await joinAndLockVoice(channelId, guild.id);
    res.json({ channelId: lockedChannelId, channelName: lockedChannelName, active: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/voice/leave
app.post("/api/voice/leave", (_req, res) => {
  leaveVoice();
  res.json({ active: false, channelId: null });
});

// Fallback → dashboard
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[Server] Listening on port ${PORT}`);
  startBot();
});
