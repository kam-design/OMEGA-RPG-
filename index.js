import baileys from '@whiskeysockets/baileys';
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = baileys;
import { Groq } from 'groq-sdk';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import express from 'express';
import pino from 'pino';
import 'dotenv/config';

// 1. Health Server for Render
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => res.send('OMEGA RPG Bot is active!'));
app.get('/health', (req, res) => res.status(200).send('OK'));

app.listen(PORT, () => console.log(`🚀 Web server listening on port ${PORT}`));

// 2. Initialize Groq AI Client
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// 3. Setup SQLite Database
const db = await open({
  filename: './database.sqlite',
  driver: sqlite3.Database
});

await db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    jid TEXT PRIMARY KEY,
    name TEXT,
    power TEXT,
    exp INTEGER DEFAULT 0,
    gold INTEGER DEFAULT 0
  )
`);

async function testGroq(prompt) {
  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: 'You are OMEGA, a savage, sarcastic RPG AI bot. Keep replies short.' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 150
    });
    return completion.choices[0]?.message?.content || 'No response from Groq.';
  } catch (err) {
    console.error('Groq Error:', err.message);
    return `❌ AI Error: ${err.message}`;
  }
}

// 4. Start Baileys Bot with Pairing Code
async function startBot() {
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
    if (!msg.message || msg.key.fromMe) return;

    const chatId = msg.key.remoteJid;
    const sender = msg.key.participant || msg.key.remoteJid;
    const pushName = msg.pushName || 'Noob';
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

    const args = text.trim().split(' ');
    const command = args[0].toLowerCase();

    if (command === '#start') {
      await db.run(
        `INSERT INTO players (jid, name, power) VALUES (?, ?, ?) 
         ON CONFLICT(jid) DO UPDATE SET name=excluded.name`,
        [sender, pushName, 'Shadow Monarch']
      );

      return sock.sendMessage(chatId, {
        text: `🔥 Welcome @${sender.split('@')[0]}! Registered in SQLite.\nPower: *Shadow Monarch*\nTest AI with: \`#testai [prompt]\``,
        mentions: [sender]
      });
    }

    if (command === '#testai') {
      const userPrompt = args.slice(1).join(' ');
      if (!userPrompt) return sock.sendMessage(chatId, { text: '❌ Usage: `#testai roast me`' });

      await sock.sendPresenceUpdate('composing', chatId);
      const aiReply = await testGroq(userPrompt);

      return sock.sendMessage(chatId, { text: `🤖 *OMEGA AI:*\n${aiReply}` });
    }
  });
}

startBot();
