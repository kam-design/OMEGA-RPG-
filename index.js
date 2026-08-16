import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import { Groq } from 'groq-sdk';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import express from 'express';
import pino from 'pino';
import fs from 'fs';
import 'dotenv/config';

// 1. Health Server for Render
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => res.send('OMEGA RPG Bot is active!'));
app.get('/health', (req, res) => res.status(200).send('OK'));

app.listen(PORT, () => console.log(`🚀 Web server listening on port ${PORT}`));

// 2. Load Rules & Initialize Groq
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const gameRules = fs.existsSync('./rules.txt') ? fs.readFileSync('./rules.txt', 'utf-8') : 'No rules defined yet.';

async function askOmegaGuide(prompt, player) {
  try {
    const systemPrompt = `You are OMEGA, a savage and sarcastic RPG AI guide.
CURRENT GAME RULES:
${gameRules}

PLAYER ASKING THE QUESTION:
Name: ${player.name} | Race: ${player.race} | Kingdom: ${player.kingdom} | Level: ${player.level} | XP: ${player.exp} | Coins: ${player.coins}

CRITICAL RULES FOR YOU:
1. DO NOT hallucinate features, quests, or dungeons that don't exist. Stick strictly to the CURRENT GAME RULES.
2. DO NOT write paragraphs. Keep your reply to 1-3 sentences MAXIMUM.
3. Be direct, address the player by their race or name, and don't sugarcoat anything.`;

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt }
      ],
      max_tokens: 100 // Hard cap on length so it physically cannot write essays
    });
    return completion.choices[0]?.message?.content || 'No response from OMEGA guide.';
  } catch (err) {
    console.error('Groq Error:', err.message);
    return `❌ OMEGA Guide Error: ${err.message}`;
  }
}

// 3. Start Baileys Bot & Database Connection
async function startBot() {
  const db = await open({
    filename: './database.sqlite',
    driver: sqlite3.Database
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS players (
      jid TEXT PRIMARY KEY,
      name TEXT,
      race TEXT DEFAULT 'None',
      family_name TEXT DEFAULT 'Unknown',
      level INTEGER DEFAULT 1,
      exp INTEGER DEFAULT 0,
      coins INTEGER DEFAULT 0,
      hp INTEGER DEFAULT 300,
      aether INTEGER DEFAULT 300,
      kingdom TEXT DEFAULT 'None'
    )
  `);

  const { state, saveCreds } = await useMultiFileAuthState('./auth_info');

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false
  });

  if (!sock.authState.creds.registered) {
    const phoneNumber = "263719558719";
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(phoneNumber);
        console.log(`\n==================================`);
        console.log(`🔑 WHATSAPP PAIRING CODE: ${code}`);
        console.log(`==================================\n`);
      } catch (err) {
        console.error('Error generating pairing code:', err.message);
      }
    }, 3000);
  }

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Connection closed. Reconnecting:', shouldReconnect);
      if (shouldReconnect) startBot();
    } else if (connection === 'open') {
      console.log('✅ OMEGA BOT SUCCESSFULLY CONNECTED!');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    const msg = messages[0];
    if (!msg.message) return;

    const chatId = msg.key.remoteJid;
    const sender = msg.key.participant || msg.key.remoteJid;
    const pushName = msg.pushName || 'Player';
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || '';

    if (!text.startsWith('#')) return;

    const args = text.trim().split(' ');
    const command = args[0].toLowerCase();
    const player = await db.get('SELECT * FROM players WHERE jid = ?', [sender]);
    const userTag = `@${sender.split('@')[0]}`;

    // #start
    if (command === '#start') {
      if (!player) {
        await db.run('INSERT INTO players (jid, name) VALUES (?, ?)', [sender, pushName]);
      } else if (player.race !== 'None') {
        return sock.sendMessage(chatId, { text: `⚠️ ${userTag}, you are already registered as a *${player.race}*! Type \`#profile\`.`, mentions: [sender] });
      }

      const startMsg = `⚔️ *Welcome to The Land of Aeternum, ${userTag}!*\n\n` +
                       `Before you begin your journey, choose your race. *(Permanent!)*\n\n` +
                       `👤 *#human*\n[Advantage] Versatile. Can learn both magic and warrior skills.\n\n` +
                       `🧝 *#elf*\n[Advantage] High magical affinity. Masters of spellcasting.\n\n` +
                       `⛏️ *#dwarf*\n[Advantage] High durability. Best in melee combat.\n\n` +
                       `Reply with your chosen race command.`;
      return sock.sendMessage(chatId, { text: startMsg, mentions: [sender] });
    }

    // Race Selection
    if (['#human', '#elf', '#dwarf'].includes(command)) {
      if (!player) return sock.sendMessage(chatId, { text: `❌ ${userTag}, type \`#start\` first!`, mentions: [sender] });
      if (player.race !== 'None') return sock.sendMessage(chatId, { text: `❌ ${userTag}, you are already a *${player.race}*.`, mentions: [sender] });

      let raceName, kingdom;
      if (command === '#human') { raceName = 'Human'; kingdom = 'Kingdom of Eldoria'; }
      if (command === '#elf') { raceName = 'Elf'; kingdom = 'Kingdom of Sylvaris'; }
      if (command === '#dwarf') { raceName = 'Dwarf'; kingdom = 'Village of Stonebridge'; }

      await db.run('UPDATE players SET race = ?, kingdom = ? WHERE jid = ?', [raceName, kingdom, sender]);
      return sock.sendMessage(chatId, { text: `✅ ${userTag}, you are now a *${raceName}* of the *${kingdom}*!`, mentions: [sender] });
    }

    // #profile
    if (command === '#profile') {
      if (!player || player.race === 'None') return sock.sendMessage(chatId, { text: `❌ ${userTag}, type \`#start\` and choose a race!`, mentions: [sender] });
      
      const profileMsg = `📜 *PROFILE: ${userTag}*\n━━━━━━━━━━━━━━━━━━\n📛 *Name:* ${player.name}\n🩸 *Family Name:* ${player.family_name}\n🧬 *Race:* ${player.race}\n🏰 *Origin:* ${player.kingdom}\n\n📊 *Level:* ${player.level}\n✨ *XP:* ${player.exp}\n🪙 *Coins:* ${player.coins}\n\n❤️ *HP:* ${player.hp} / 300\n🌀 *Aether:* ${player.aether} / 300`;
      return sock.sendMessage(chatId, { text: profileMsg, mentions: [sender] });
    }

    // #map
    if (command === '#map') {
      const mapPath = './map.png';
      if (!fs.existsSync(mapPath)) {
        return await sock.sendMessage(chatId, { text: `❌ ${userTag}, Map image file not found on server. Did you git add map.png?`, mentions: [sender] });
      }
      const mapCaption = `🗺️ *WORLD MAP OF AETERNUM*\n\n🏰 *Kingdoms:*\n• Kingdom of Eldoria\n• Kingdom of Sylvaris\n\n🏡 *Villages:*\n• Village of Stonebridge\n• Village of Oakwood\n\n🔥 *Danger Zones:*\n• Demon's Hollow\n• The Blackwood`;
      return await sock.sendMessage(chatId, { image: fs.readFileSync(mapPath), caption: mapCaption });
    }

    // #omega
    if (command === '#omega') {
      if (!player || player.race === 'None') return sock.sendMessage(chatId, { text: `❌ ${userTag}, register with \`#start\` first so I know who I'm talking to.`, mentions: [sender] });
      
      const userPrompt = args.slice(1).join(' ');
      if (!userPrompt) return sock.sendMessage(chatId, { text: `🔮 Usage: \`#omega [question]\``, mentions: [sender] });

      try {
        await sock.sendPresenceUpdate('composing', chatId);
        const aiReply = await askOmegaGuide(userPrompt, player);
        await sock.sendMessage(chatId, { text: `🔮 *OMEGA GUIDE:*\n\n${aiReply}`, mentions: [sender] });
      } catch (err) {
        console.error('AI Error:', err.message);
      }
    }
  });
}

startBot();
