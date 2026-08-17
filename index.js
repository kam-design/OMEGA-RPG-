import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import { Groq } from 'groq-sdk';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import express from 'express';
import pino from 'pino';
import fs from 'fs';
import 'dotenv/config';

const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('OMEGA RPG Bot Active'));
app.listen(PORT);

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const gameRules = fs.existsSync('./rules.txt') ? fs.readFileSync('./rules.txt', 'utf-8') : '';

// Static Game Data
const SPELLS = {
  'minor heal': { name: 'Minor Heal', tier: 'Basic', level: 1, cost: 10, power: 20, type: 'heal' },
  'fire blast': { name: 'Fire Blast', tier: 'Basic', level: 1, cost: 10, power: 20, type: 'damage' },
  'water slash': { name: 'Water Slash', tier: 'Basic', level: 1, cost: 10, power: 20, type: 'damage' },
  'air blast': { name: 'Air Blast', tier: 'Basic', level: 1, cost: 10, power: 20, type: 'damage' },
  'earth hurl': { name: 'Earth Hurl', tier: 'Basic', level: 1, cost: 10, power: 20, type: 'damage' },
  'hellfire cannon': { name: 'Hellfire Cannon', tier: 'Mid', level: 20, cost: 30, power: 40, type: 'damage' },
  'ice dragon strike': { name: 'Ice Dragon Strike', tier: 'Mid', level: 20, cost: 30, power: 40, type: 'damage' },
  'gale vortex': { name: 'Gale Vortex', tier: 'Mid', level: 20, cost: 30, power: 40, type: 'damage' },
  'seismic crush': { name: 'Seismic Crush', tier: 'Mid', level: 20, cost: 30, power: 40, type: 'damage' },
  'amaterasu': { name: 'Amaterasu', tier: 'God', level: 60, cost: 50, power: 80, type: 'damage' },
  'domain expansion': { name: 'Domain Expansion', tier: 'God', level: 60, cost: 50, power: 80, type: 'damage' },
  'divine judgment': { name: 'Divine Judgment', tier: 'God', level: 60, cost: 50, power: 80, type: 'damage' },
  'planet devastation': { name: 'Planet Devastation', tier: 'God', level: 60, cost: 50, power: 80, type: 'damage' }
};

const WEAPONS = {
  'iron sword': { name: 'Iron Sword', tier: 'Basic', level: 1, price: 50, power: 20 },
  'steel hammer': { name: 'Steel Hammer', tier: 'Basic', level: 1, price: 50, power: 20 },
  'hunting bow': { name: 'Hunting Bow', tier: 'Basic', level: 1, price: 50, power: 20 },
  'steel scythe': { name: 'Steel Scythe', tier: 'Basic', level: 1, price: 50, power: 20 },
  'spear': { name: 'Spear', tier: 'Basic', level: 1, price: 50, power: 20 },
  'mythril blade': { name: 'Mythril Blade', tier: 'Mid', level: 20, price: 300, power: 40 },
  'orichalcum warhammer': { name: 'Orichalcum Warhammer', tier: 'Mid', level: 20, price: 300, power: 40 },
  'shadow bow': { name: 'Shadow Bow', tier: 'Mid', level: 20, price: 300, power: 40 },
  'rune spear': { name: 'Rune Spear', tier: 'Mid', level: 20, price: 300, power: 40 },
  'excalibur': { name: 'Excalibur', tier: 'God', level: 60, price: 1500, power: 80 },
  'dragonslayer': { name: 'Dragonslayer', tier: 'God', level: 60, price: 1500, power: 80 },
  'enuma elish': { name: 'Enuma Elish', tier: 'God', level: 60, price: 1500, power: 80 },
  'muramasa': { name: 'Muramasa', tier: 'God', level: 60, price: 1500, power: 80 }
};

async function askOmegaGuide(prompt, player) {
  try {
    const sysPrompt = `You are OMEGA, an RPG AI guide. Rules:\n${gameRules}\nPlayer: ${player.name} (${player.race}, Lvl ${player.level}). Keep answers under 3 sentences!`;
    const res = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'system', content: sysPrompt }, { role: 'user', content: prompt }],
      max_tokens: 100
    });
    return res.choices[0]?.message?.content || 'No answer.';
  } catch (e) { return `Error: ${e.message}`; }
}

async function startBot() {
  const db = await open({ filename: './database.sqlite', driver: sqlite3.Database });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS players (
      jid TEXT PRIMARY KEY, name TEXT, race TEXT DEFAULT 'None', level INTEGER DEFAULT 1,
      exp INTEGER DEFAULT 0, coins INTEGER DEFAULT 100, hp INTEGER DEFAULT 300,
      aether INTEGER DEFAULT 300, kingdom TEXT DEFAULT 'None', weapon TEXT DEFAULT 'Fists'
    );
    CREATE TABLE IF NOT EXISTS player_magic (
      jid TEXT, spell_name TEXT, rank TEXT DEFAULT 'Novice', PRIMARY KEY (jid, spell_name)
    );
  `);

  const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
  const sock = makeWASocket({ auth: state, logger: pino({ level: 'silent' }), printQRInTerminal: false });

  if (!sock.authState.creds.registered) {
    setTimeout(async () => {
      const code = await sock.requestPairingCode("26378 779 4041");
      console.log(`\n🔑 WHATSAPP PAIRING CODE: ${code}\n`);
    }, 3000);
  }

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    const msg = messages[0];
    if (!msg.message) return;

    const chatId = msg.key.remoteJid;
    const sender = msg.key.participant || msg.key.remoteJid;
    const pushName = msg.pushName || 'Player';
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

    if (!text.startsWith('#')) return;

    const args = text.trim().split(' ');
    const command = args[0].toLowerCase();
    let player = await db.get('SELECT * FROM players WHERE jid = ?', [sender]);
    const userTag = `@${sender.split('@')[0]}`;

    // #start
    if (command === '#start') {
      if (!player) {
        await db.run('INSERT INTO players (jid, name) VALUES (?, ?)', [sender, pushName]);
      } else if (player.race !== 'None') {
        return sock.sendMessage(chatId, { text: `⚠️ ${userTag}, you are already registered as a *${player.race}*!`, mentions: [sender] });
      }

      const startMsg = `⚔️ *Welcome to Aeternum, ${userTag}!*\n\n` +
                       `Choose your race: *(Permanent)*\n\n` +
                       `👤 *#human*\nJack of all trades. Learns magic & weapons (Slower XP gain).\n\n` +
                       `🧝 *#elf*\nMagic Masters. Fast spell learning, weapons capped at Novice.\n\n` +
                       `⛏️ *#dwarf*\nMelee Masters. Cannot learn magic except Minor Heal.\n\n` +
                       `👹 *#orc*\nBalanced growth. Bonus coin generation.`;
      return sock.sendMessage(chatId, { text: startMsg, mentions: [sender] });
    }

    // Race Selection
    if (['#human', '#elf', '#dwarf', '#orc'].includes(command)) {
      if (!player) return sock.sendMessage(chatId, { text: `❌ Type \`#start\` first!`, mentions: [sender] });
      if (player.race !== 'None') return sock.sendMessage(chatId, { text: `❌ Already a *${player.race}*.`, mentions: [sender] });

      let raceName, kingdom;
      if (command === '#human') { raceName = 'Human'; kingdom = 'Kingdom of Eldoria'; }
      if (command === '#elf') { raceName = 'Elf'; kingdom = 'Kingdom of Sylvaris'; }
      if (command === '#dwarf') { raceName = 'Dwarf'; kingdom = 'Village of Stonebridge'; }
      if (command === '#orc') { raceName = 'Orc'; kingdom = 'Orcish Badlands'; }

      await db.run('UPDATE players SET race = ?, kingdom = ? WHERE jid = ?', [raceName, kingdom, sender]);
      await db.run('INSERT OR IGNORE INTO player_magic (jid, spell_name) VALUES (?, ?)', [sender, 'Minor Heal']);

      return sock.sendMessage(chatId, { text: `✅ ${userTag}, you are now an *${raceName}* of *${kingdom}*!\nGranted default spell: *Minor Heal*.`, mentions: [sender] });
    }

    // #profile
    if (command === '#profile') {
      if (!player || player.race === 'None') return sock.sendMessage(chatId, { text: `❌ Register with \`#start\` first!`, mentions: [sender] });
      
      const magicList = await db.all('SELECT spell_name, rank FROM player_magic WHERE jid = ?', [sender]);
      const magicStr = magicList.map(m => `• ${m.spell_name} [${m.rank}]`).join('\n') || 'None';
      const xpReq = player.race === 'Human' ? 750 : 500;

      const profileMsg = `📜 *PROFILE: ${userTag}*\n━━━━━━━━━━━━━━━━━━\n` +
                         `📛 *Name:* ${player.name}\n` +
                         `🧬 *Race:* ${player.race}\n` +
                         `🏰 *Origin:* ${player.kingdom}\n\n` +
                         `📊 *Level:* ${player.level} (${player.exp}/${xpReq} XP)\n` +
                         `🪙 *Coins:* ${player.coins}\n` +
                         `⚔️ *Equipped Weapon:* ${player.weapon}\n\n` +
                         `❤️ *HP:* ${player.hp}/300\n` +
                         `🌀 *Aether:* ${player.aether}/300\n\n` +
                         `🪄 *LEARNED MAGIC:*\n${magicStr}`;
      return sock.sendMessage(chatId, { text: profileMsg, mentions: [sender] });
    }

    // #magic
    if (command === '#magic') {
      const magicDirectory = `🪄 *AETERNUM SPELLBOOK*\n━━━━━━━━━━━━━━━━━━\n` +
        `🟢 *BASIC (Lvl 1 | 10 Aether)*\n• Minor Heal\n• Fire Blast\n• Water Slash\n• Air Blast\n• Earth Hurl\n\n` +
        `🟡 *MID (Lvl 20 | 30 Aether)*\n• Hellfire Cannon\n• Ice Dragon Strike\n• Gale Vortex\n• Seismic Crush\n\n` +
        `🔴 *GOD (Lvl 60 | 50 Aether)*\n• Amaterasu\n• Domain Expansion\n• Divine Judgment\n• Planet Devastation\n\n` +
        `Type \`#learn [spell_name]\` to learn a spell.`;
      return sock.sendMessage(chatId, { text: magicDirectory, mentions: [sender] });
    }

    // #learn [spell]
    if (command === '#learn') {
      if (!player || player.race === 'None') return sock.sendMessage(chatId, { text: `❌ Choose a race first!`, mentions: [sender] });
      const spellQuery = args.slice(1).join(' ').toLowerCase();
      const spell = SPELLS[spellQuery];

      if (!spell) return sock.sendMessage(chatId, { text: `❌ Unknown spell! Check \`#magic\`.`, mentions: [sender] });
      if (player.level < spell.level) return sock.sendMessage(chatId, { text: `❌ Requires Level ${spell.level}!`, mentions: [sender] });
      if (player.race === 'Dwarf' && spell.name !== 'Minor Heal') return sock.sendMessage(chatId, { text: `❌ Dwarves cannot learn magic except Minor Heal!`, mentions: [sender] });

      await db.run('INSERT OR IGNORE INTO player_magic (jid, spell_name) VALUES (?, ?)', [sender, spell.name]);
      return sock.sendMessage(chatId, { text: `✨ ${userTag} learned *${spell.name}* [${spell.tier}]!`, mentions: [sender] });
    }

    // #weapon
    if (command === '#weapon') {
      const weaponDirectory = `⚔️ *ARMORY DIRECTORY*\n━━━━━━━━━━━━━━━━━━\n` +
        `🟢 *BASIC (Lvl 1 | 50 Coins)*\n• Iron Sword\n• Steel Hammer\n• Hunting Bow\n• Steel Scythe\n• Spear\n\n` +
        `🟡 *MID (Lvl 20 | 300 Coins)*\n• Mythril Blade\n• Orichalcum Warhammer\n• Shadow Bow\n• Rune Spear\n\n` +
        `🔴 *GOD (Lvl 60 | 1500 Coins)*\n• Excalibur\n• Dragonslayer\n• Enuma Elish\n• Muramasa\n\n` +
        `Type \`#buyweapon [weapon_name]\` to purchase and equip.`;
      return sock.sendMessage(chatId, { text: weaponDirectory, mentions: [sender] });
    }

    // #buyweapon [weapon]
    if (command === '#buyweapon') {
      if (!player || player.race === 'None') return sock.sendMessage(chatId, { text: `❌ Choose a race first!`, mentions: [sender] });
      const weaponQuery = args.slice(1).join(' ').toLowerCase();
      const weapon = WEAPONS[weaponQuery];

      if (!weapon) return sock.sendMessage(chatId, { text: `❌ Unknown weapon! Check \`#weapon\`.`, mentions: [sender] });
      if (player.level < weapon.level) return sock.sendMessage(chatId, { text: `❌ Requires Level ${weapon.level}!`, mentions: [sender] });
      if (player.coins < weapon.price) return sock.sendMessage(chatId, { text: `❌ You need ${weapon.price} coins!`, mentions: [sender] });

      await db.run('UPDATE players SET coins = coins - ?, weapon = ? WHERE jid = ?', [weapon.price, weapon.name, sender]);
      return sock.sendMessage(chatId, { text: `⚔️ ${userTag} purchased and equipped *${weapon.name}*!`, mentions: [sender] });
    }

    // #omega
    if (command === '#omega') {
      if (!player || player.race === 'None') return sock.sendMessage(chatId, { text: `❌ Register with \`#start\` first.`, mentions: [sender] });
      const userPrompt = args.slice(1).join(' ');
      if (!userPrompt) return sock.sendMessage(chatId, { text: `🔮 Usage: \`#omega [question]\``, mentions: [sender] });

      await sock.sendPresenceUpdate('composing', chatId);
      const aiReply = await askOmegaGuide(userPrompt, player);
      return sock.sendMessage(chatId, { text: `🔮 *OMEGA GUIDE:*\n\n${aiReply}`, mentions: [sender] });
    }
  });
}

startBot();
