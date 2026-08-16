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

// 2. Initialize Groq AI Client
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

async function askOmegaGuide(prompt) {
  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { 
          role: 'system', 
          content: 'You are OMEGA, the official AI guide and assistant for the OMEGA RPG game on WhatsApp. Help players understand game mechanics, lore, commands, and survival strategies in Aeternum. Keep your replies structured, helpful, concise, and in-character as an ancient RPG AI.' 
        },
        { role: 'user', content: prompt }
      ],
      max_tokens: 250
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

  // Updated Database Schema
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
      console.log('✅ OMEGA BOT SUCCESSFULLY CONNECTED TO WHATSAPP!');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    const msg = messages[0];
    if (!msg.message) return;

    const chatId = msg.key.remoteJid;
    const sender = msg.key.participant || msg.key.remoteJid;
    const pushName = msg.pushName || 'Player';

    const text = msg.message.conversation || 
                 msg.message.extendedTextMessage?.text || 
                 msg.message.imageMessage?.caption || '';

    if (!text.startsWith('#')) return; // Ignore non-commands

    console.log(`📩 Received command: "${text}" from ${sender}`);

    const args = text.trim().split(' ');
    const command = args[0].toLowerCase();
    
    // Fetch player data for every command
    const player = await db.get('SELECT * FROM players WHERE jid = ?', [sender]);
    const userTag = `@${sender.split('@')[0]}`;

    // Command: #start
    if (command === '#start') {
      if (!player) {
        await db.run('INSERT INTO players (jid, name) VALUES (?, ?)', [sender, pushName]);
      } else if (player.race !== 'None') {
        return sock.sendMessage(chatId, { 
          text: `⚠️ ${userTag}, you are already registered as a *${player.race}*! Type \`#profile\` to see your stats.`, 
          mentions: [sender] 
        });
      }

      const startMsg = `⚔️ *Welcome to The Land of Aeternum, ${userTag}!*\n\n` +
                       `Before you begin your journey, you must choose your race. *(This is permanent!)*\n\n` +
                       `👤 *#human*\n[Advantage] Versatile. Can learn both magic and warrior skills.\n\n` +
                       `🧝 *#elf*\n[Advantage] High magical affinity. Masters of spellcasting.\n\n` +
                       `⛏️ *#dwarf*\n[Advantage] High durability. Best in melee combat and weapon forging.\n\n` +
                       `Reply with your chosen race command to lock it in.`;
      
      return sock.sendMessage(chatId, { text: startMsg, mentions: [sender] });
    }

    // Command: Race Selection
    if (['#human', '#elf', '#dwarf'].includes(command)) {
      if (!player) {
        return sock.sendMessage(chatId, { text: `❌ ${userTag}, type \`#start\` first to begin!`, mentions: [sender] });
      }
      if (player.race !== 'None') {
        return sock.sendMessage(chatId, { text: `❌ ${userTag}, you are already a *${player.race}*. No going back now.`, mentions: [sender] });
      }

      let raceName, kingdom;
      if (command === '#human') { raceName = 'Human'; kingdom = 'Kingdom of Eldoria'; }
      if (command === '#elf') { raceName = 'Elf'; kingdom = 'Kingdom of Sylvaris'; }
      if (command === '#dwarf') { raceName = 'Dwarf'; kingdom = 'Village of Stonebridge'; }

      await db.run('UPDATE players SET race = ?, kingdom = ? WHERE jid = ?', [raceName, kingdom, sender]);

      return sock.sendMessage(chatId, { 
        text: `✅ ${userTag}, you are now a *${raceName}* of the *${kingdom}*!\nType \`#profile\` to view your stats.`,
        mentions: [sender]
      });
    }

    // Command: #profile
    if (command === '#profile') {
      if (!player || player.race === 'None') {
        return sock.sendMessage(chatId, { text: `❌ ${userTag}, you haven't fully registered yet. Type \`#start\` and choose a race!`, mentions: [sender] });
      }

      const profileMsg = `📜 *PROFILE: ${userTag}*\n` +
                         `━━━━━━━━━━━━━━━━━━\n` +
                         `📛 *Name:* ${player.name}\n` +
                         `🩸 *Family Name:* ${player.family_name}\n` +
                         `🧬 *Race:* ${player.race}\n` +
                         `🏰 *Origin:* ${player.kingdom}\n\n` +
                         `📊 *Level:* ${player.level}\n` +
                         `✨ *XP:* ${player.exp}\n` +
                         `🪙 *Coins:* ${player.coins}\n\n` +
                         `❤️ *HP:* ${player.hp} / 300\n` +
                         `🌀 *Aether:* ${player.aether} / 300`;

      return sock.sendMessage(chatId, { text: profileMsg, mentions: [sender] });
    }

    // Command: #map
    if (command === '#map') {
      try {
        const mapPath = './map.png';
        if (!fs.existsSync(mapPath)) {
          return await sock.sendMessage(chatId, { text: `❌ ${userTag}, Map image file not found on server.`, mentions: [sender] });
        }

        const mapCaption = `🗺️ *WORLD MAP OF AETERNUM*\n\n` +
          `🏰 *Kingdoms:*\n` +
          `• Kingdom of Eldoria\n` +
          `• Kingdom of Sylvaris\n\n` +
          `🏡 *Villages:*\n` +
          `• Village of Stonebridge\n` +
          `• Village of Oakwood\n\n` +
          `🔥 *Danger Zones:*\n` +
          `• Demon's Hollow (Demon Zone)\n` +
          `• The Blackwood (Dark Forest)`;

        await sock.sendMessage(chatId, { image: fs.readFileSync(mapPath), caption: mapCaption });
      } catch (err) {
        console.error('Error sending map:', err.message);
      }
      return;
    }

    // Command: #omega
    if (command === '#omega') {
      const userPrompt = args.slice(1).join(' ');
      if (!userPrompt) {
        return sock.sendMessage(chatId, { 
          text: `🔮 *OMEGA RPG GUIDE*\n\nUsage: \`#omega [question]\`\nExample: \`#omega how do I level up fast?\``,
          mentions: [sender]
        });
      }

      try {
        await sock.sendPresenceUpdate('composing', chatId);
        const aiReply = await askOmegaGuide(userPrompt);
        await sock.sendMessage(chatId, { text: `🔮 *OMEGA GUIDE for ${userTag}:*\n\n${aiReply}`, mentions: [sender] });
      } catch (err) {
        console.error('AI Error:', err.message);
      }
      return;
    }
  });
}

startBot();
