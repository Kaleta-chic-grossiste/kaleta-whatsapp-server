const express = require('express');
const http = require('http');
const fs = require('fs');
const { execSync, exec } = require('child_process');
const { Server } = require('socket.io');
const cors = require('cors');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');

const app = express();
const server = http.createServer(app);

const ADMIN_ORIGIN = process.env.ADMIN_ORIGIN || '*';
const io = new Server(server, {
  cors: { origin: ADMIN_ORIGIN, methods: ['GET', 'POST'] },
});
app.use(cors({ origin: ADMIN_ORIGIN }));
app.use(express.json());

// ── STATE ─────────────────────────────────────────────
let whatsappClient = null;
let isReady = false;
let qrCodeData = null;
let initLock = false; // Empêche les initialisations simultanées
const messages = [];
const MAX_MESSAGES = 200;

// ── UTILS ─────────────────────────────────────────────
function detectType(body = '') {
  const text = body.toLowerCase();
  if (text.includes('réserv') || text.includes('reserv') || text.includes('table') || text.includes('place')) return 'RÉSERVATION';
  if (text.includes('commande') || text.includes('commander') || text.includes('livr') || text.includes('menu') || text.includes('plat')) return 'COMMANDE';
  return 'MESSAGE';
}

function formatMessage(msg, contact, toNumber = null, toName = null) {
  const from = msg.fromMe ? (toNumber || msg.to) : msg.from;
  const name = msg.fromMe
    ? (toName || toNumber?.replace('@c.us', '') || 'Inconnu')
    : (contact?.pushname || contact?.name || from.replace('@c.us', ''));
  return {
    id: msg.id._serialized || msg.id.id,
    from,
    fromName: name,
    fromNumber: from.replace('@c.us', ''),
    body: msg.body,
    timestamp: msg.timestamp * 1000,
    isFromMe: msg.fromMe,
    type: msg.fromMe ? 'ENVOYÉ' : detectType(msg.body),
    hasMedia: msg.hasMedia,
    isRead: true,
  };
}

// ── KILL CHROME + CLEAN SESSION ───────────────────────
async function killChromeAndClean() {
  return new Promise((resolve) => {
    console.log('🔪 Fermeture de Chrome...');

    // Tuer tous les processus Chrome
    try { execSync('taskkill /F /IM chrome.exe /T 2>nul', { stdio: 'ignore' }); } catch (_) {}
    try { execSync('taskkill /F /IM chromedriver.exe /T 2>nul', { stdio: 'ignore' }); } catch (_) {}

    // Attendre que Chrome soit bien fermé
    setTimeout(() => {
      try {
        if (fs.existsSync('./whatsapp-session')) {
          fs.rmSync('./whatsapp-session', { recursive: true, force: true });
          console.log('🗑️ Session supprimée');
        }
      } catch (e) {
        console.log('Erreur nettoyage:', e.message);
      }
      resolve();
    }, 2000); // 2 secondes pour que Chrome se ferme
  });
}

// ── DESTROY CLIENT ────────────────────────────────────
async function destroyClient() {
  if (!whatsappClient) return;
  try {
    await whatsappClient.destroy();
  } catch (_) {}
  whatsappClient = null;
  isReady = false;
}

// ── INIT WHATSAPP ─────────────────────────────────────
async function initWhatsApp(retry = 0, cleanSession = false) {
  // Empêcher les initialisations simultanées
  if (initLock && retry === 0) {
    console.log('⏳ Initialisation déjà en cours...');
    return;
  }
  initLock = true;

  await destroyClient();

  if (cleanSession) {
    await killChromeAndClean();
  }

  console.log(`🔄 Initialisation WhatsApp (tentative ${retry + 1})...`);

  whatsappClient = new Client({
    authStrategy: new LocalAuth({ dataPath: './whatsapp-session' }),
    puppeteer: {
      headless: true,
      executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-default-apps',
        '--mute-audio',
        '--no-default-browser-check',
        '--disable-web-security',
      ],
      timeout: 90000,
      protocolTimeout: 90000,
    },
  });

  // QR CODE
  whatsappClient.on('qr', async (qr) => {
    console.log('📱 QR Code prêt — scannez depuis l\'admin');
    qrCodeData = await qrcode.toDataURL(qr);
    isReady = false;
    io.emit('qr', qrCodeData);
    io.emit('status', { connected: false, message: 'Scannez le QR code avec WhatsApp' });
  });

  // PRÊT
  whatsappClient.on('ready', async () => {
    console.log('✅ WhatsApp connecté !');
    isReady = true;
    initLock = false;
    qrCodeData = null;
    const info = whatsappClient.info;
    io.emit('status', {
      connected: true,
      message: 'Connecté',
      phone: info?.wid?.user || '',
      name: info?.pushname || 'Kaleta',
    });
    await loadRecentMessages();
  });

  // AUTHENTIFIÉ
  whatsappClient.on('authenticated', () => {
    console.log('🔐 Authentifié avec succès');
  });

  // ERREUR AUTH
  whatsappClient.on('auth_failure', async (msg) => {
    console.log('❌ Échec authentification:', msg);
    initLock = false;
    await killChromeAndClean();
    setTimeout(() => initWhatsApp(0, false), 3000);
  });

  // DÉCONNECTÉ
  whatsappClient.on('disconnected', async (reason) => {
    console.log('❌ WhatsApp déconnecté:', reason);
    isReady = false;
    initLock = false;
    io.emit('status', { connected: false, message: 'Déconnecté — reconnexion...' });
    await destroyClient();
    setTimeout(() => initWhatsApp(0, false), 5000);
  });

  // NOUVEAU MESSAGE
  whatsappClient.on('message', async (msg) => {
    if (msg.fromMe) return;
    if (msg.from === 'status@broadcast') return;
    if (msg.from.endsWith('@g.us')) return;
    try {
      const contact = await msg.getContact();
      const formatted = formatMessage(msg, contact);
      messages.unshift(formatted);
      if (messages.length > MAX_MESSAGES) messages.pop();
      io.emit('new_message', formatted);
      console.log(`📩 ${formatted.fromName}: ${formatted.body.slice(0, 60)}`);
    } catch (e) {
      console.log('Erreur message:', e.message);
    }
  });

  // MESSAGE ENVOYÉ
  whatsappClient.on('message_create', async (msg) => {
    if (!msg.fromMe) return;
    try {
      let toName = null;
      try {
        const contact = await whatsappClient.getContactById(msg.to);
        toName = contact?.pushname || contact?.name || null;
      } catch (_) {}
      const formatted = formatMessage(msg, null, msg.to, toName);
      messages.unshift(formatted);
      if (messages.length > MAX_MESSAGES) messages.pop();
      io.emit('message_sent', formatted);
    } catch (e) {}
  });

  // INITIALISER avec gestion d'erreur
  try {
    await whatsappClient.initialize();
  } catch (e) {
    console.log(`❌ Erreur init (tentative ${retry + 1}):`, e.message);
    await destroyClient();
    initLock = false;

    if (retry < 2) {
      console.log('🔄 Nettoyage et nouvel essai dans 5s...');
      await killChromeAndClean();
      setTimeout(() => initWhatsApp(retry + 1, false), 5000);
    } else {
      console.log('⚠️ Échec après 3 tentatives.');
      console.log('💡 Solution : fermez Chrome manuellement et relancez le serveur.');
      io.emit('status', { connected: false, message: 'Erreur — fermez Chrome et relancez' });
    }
  }
}

// ── CHARGER MESSAGES RÉCENTS ──────────────────────────
async function loadRecentMessages() {
  try {
    const chats = await whatsappClient.getChats();
    const recent = chats
      .filter(chat => !chat.isGroup && chat.id._serialized !== 'status@broadcast')
      .slice(0, 20);

    for (const chat of recent) {
      const chatMessages = await chat.fetchMessages({ limit: 10 });
      for (const msg of chatMessages) {
        try {
          const contact = await msg.getContact();
          const formatted = formatMessage(msg, contact);
          if (!messages.find(m => m.id === formatted.id)) {
            messages.push(formatted);
          }
        } catch (_) {}
      }
    }

    messages.sort((a, b) => b.timestamp - a.timestamp);
    if (messages.length > MAX_MESSAGES) messages.splice(MAX_MESSAGES);
    io.emit('messages_loaded', messages);
    console.log(`📦 ${messages.length} messages chargés`);
  } catch (e) {
    console.log('Erreur chargement messages:', e.message);
  }
}

// ── SOCKET.IO ─────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('🔌 Admin connecté');

  if (isReady) {
    const info = whatsappClient?.info;
    socket.emit('status', { connected: true, message: 'Connecté', phone: info?.wid?.user || '', name: info?.pushname || 'Kaleta' });
    socket.emit('messages_loaded', messages);
  } else if (qrCodeData) {
    socket.emit('qr', qrCodeData);
    socket.emit('status', { connected: false, message: 'Scannez le QR code' });
  } else {
    socket.emit('status', { connected: false, message: 'Initialisation en cours...' });
  }

  // ENVOYER MESSAGE
  socket.on('send_message', async ({ to, message }) => {
    if (!isReady) return socket.emit('error', 'WhatsApp non connecté');
    try {
      const number = to.replace(/\D/g, '');
      const chatId = `${number}@c.us`;
      let contactName = number;
      try {
        const contact = await whatsappClient.getContactById(chatId);
        contactName = contact?.pushname || contact?.name || number;
      } catch (_) {}
      await whatsappClient.sendMessage(chatId, message);
      socket.emit('message_sent_ok', { to, message, toName: contactName });
    } catch (e) {
      socket.emit('error', `Erreur envoi: ${e.message}`);
    }
  });

  // MARQUER LU
  socket.on('mark_read', async ({ chatId }) => {
    try {
      const chat = await whatsappClient.getChatById(chatId);
      await chat.sendSeen();
      messages.filter(m => m.from === chatId).forEach(m => m.isRead = true);
      io.emit('messages_updated', messages);
    } catch (e) {}
  });

  // DÉCONNECTER
  socket.on('disconnect_whatsapp', async () => {
    try {
      if (whatsappClient) await whatsappClient.logout();
    } catch (_) {}
    await destroyClient();
    await killChromeAndClean();
    messages.length = 0;
    io.emit('status', { connected: false, message: 'Déconnecté' });
  });

  // RECONNECTER
  socket.on('reconnect_whatsapp', async () => {
    io.emit('status', { connected: false, message: 'Reconnexion...' });
    initWhatsApp(0, true); // Force clean au reconnect manuel
  });

  socket.on('disconnect', () => console.log('🔌 Admin déconnecté'));
});

// ── REST API ──────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', connected: isReady, messages: messages.length });
});

app.get('/messages', (req, res) => {
  const { type, search, limit = 50 } = req.query;
  let filtered = [...messages];
  if (type && type !== 'TOUS') filtered = filtered.filter(m => m.type === type);
  if (search) filtered = filtered.filter(m =>
    m.body?.toLowerCase().includes(search.toLowerCase()) ||
    m.fromName?.toLowerCase().includes(search.toLowerCase()) ||
    m.fromNumber?.includes(search)
  );
  res.json(filtered.slice(0, parseInt(limit)));
});

// ── DÉMARRAGE ─────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, async () => {
  console.log(`🚀 Kaleta WhatsApp Server → port ${PORT}`);
  // Nettoyer Chrome au démarrage pour éviter les conflits
  await killChromeAndClean();
  setTimeout(() => initWhatsApp(0, false), 3000);
});

// Gestion propre de l'arrêt
process.on('SIGINT', async () => {
  console.log('\n🛑 Arrêt du serveur...');
  await destroyClient();
  process.exit(0);
});