const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');

const app = express();
const server = http.createServer(app);

// ── CORS ──────────────────────────────────────────────
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

// Stockage en mémoire des messages (max 200)
const messages = [];
const MAX_MESSAGES = 200;

// ── DÉTECTION DU TYPE DE MESSAGE ──────────────────────
function detectType(body = '') {
  const text = body.toLowerCase();
  if (text.includes('réserv') || text.includes('reserv') || text.includes('table') || text.includes('place')) return 'RÉSERVATION';
  if (text.includes('commande') || text.includes('commander') || text.includes('livr') || text.includes('menu') || text.includes('plat')) return 'COMMANDE';
  if (text.includes('bonjour') || text.includes('info') || text.includes('horaire') || text.includes('ouvert')) return 'INFO';
  return 'GÉNÉRAL';
}

function formatMessage(msg, contact) {
  return {
    id: msg.id._serialized || msg.id.id,
    from: msg.from,
    fromName: contact?.pushname || contact?.name || msg.from.replace('@c.us', ''),
    fromNumber: msg.from.replace('@c.us', ''),
    body: msg.body,
    timestamp: msg.timestamp * 1000,
    isFromMe: msg.fromMe,
    type: msg.fromMe ? 'ENVOYÉ' : detectType(msg.body),
    hasMedia: msg.hasMedia,
    isRead: msg.fromMe,
  };
}

// ── WHATSAPP CLIENT ───────────────────────────────────
function initWhatsApp() {
  if (whatsappClient) {
    whatsappClient.destroy();
    whatsappClient = null;
    isReady = false;
  }

  whatsappClient = new Client({
    authStrategy: new LocalAuth({ dataPath: './whatsapp-session' }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
      ],
    },
  });

  // QR CODE
  whatsappClient.on('qr', async (qr) => {
    console.log('📱 QR Code généré — scannez depuis l\'admin');
    qrCodeData = await qrcode.toDataURL(qr);
    isReady = false;
    io.emit('qr', qrCodeData);
    io.emit('status', { connected: false, message: 'Scannez le QR code' });
  });

  // CONNECTÉ
  whatsappClient.on('ready', async () => {
    console.log('✅ WhatsApp connecté !');
    isReady = true;
    qrCodeData = null;
    const info = whatsappClient.info;
    io.emit('status', {
      connected: true,
      message: 'Connecté',
      phone: info?.wid?.user || '',
      name: info?.pushname || 'Kaleta',
    });

    // Charger les derniers messages
    await loadRecentMessages();
  });

  // DÉCONNECTÉ
  whatsappClient.on('disconnected', (reason) => {
    console.log('❌ WhatsApp déconnecté:', reason);
    isReady = false;
    io.emit('status', { connected: false, message: 'Déconnecté — rechargez' });
    // Réinitialiser après 3 secondes
    setTimeout(initWhatsApp, 3000);
  });

  // NOUVEAU MESSAGE REÇU
  whatsappClient.on('message', async (msg) => {
    if (msg.fromMe) return; // Ignorer nos propres messages
    try {
      const contact = await msg.getContact();
      const formatted = formatMessage(msg, contact);
      messages.unshift(formatted);
      if (messages.length > MAX_MESSAGES) messages.pop();
      io.emit('new_message', formatted);
      console.log(`📩 Message de ${formatted.fromName}: ${formatted.body.slice(0, 50)}`);
    } catch (e) {
      console.log('Erreur traitement message:', e.message);
    }
  });

  // MESSAGE ENVOYÉ PAR NOUS
  whatsappClient.on('message_create', async (msg) => {
    if (!msg.fromMe) return;
    try {
      const formatted = formatMessage(msg, null);
      messages.unshift(formatted);
      if (messages.length > MAX_MESSAGES) messages.pop();
      io.emit('message_sent', formatted);
    } catch (e) {}
  });

  whatsappClient.initialize();
}

// Charger les messages récents au démarrage
async function loadRecentMessages() {
  try {
    const chats = await whatsappClient.getChats();
    const recent = chats.slice(0, 20); // 20 dernières conversations
    for (const chat of recent) {
      const chatMessages = await chat.fetchMessages({ limit: 10 });
      for (const msg of chatMessages) {
        const contact = await msg.getContact();
        const formatted = formatMessage(msg, contact);
        if (!messages.find(m => m.id === formatted.id)) {
          messages.push(formatted);
        }
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

  // Envoyer l'état actuel
  if (isReady) {
    const info = whatsappClient?.info;
    socket.emit('status', {
      connected: true,
      message: 'Connecté',
      phone: info?.wid?.user || '',
      name: info?.pushname || 'Kaleta',
    });
    socket.emit('messages_loaded', messages);
  } else if (qrCodeData) {
    socket.emit('qr', qrCodeData);
    socket.emit('status', { connected: false, message: 'Scannez le QR code' });
  } else {
    socket.emit('status', { connected: false, message: 'Initialisation...' });
  }

  // ENVOYER UN MESSAGE
  socket.on('send_message', async ({ to, message }) => {
    if (!isReady) return socket.emit('error', 'WhatsApp non connecté');
    try {
      const number = to.replace(/\D/g, '');
      const chatId = number.includes('@c.us') ? number : `${number}@c.us`;
      await whatsappClient.sendMessage(chatId, message);
      socket.emit('message_sent_ok', { to, message });
    } catch (e) {
      socket.emit('error', `Erreur envoi: ${e.message}`);
    }
  });

  // MARQUER COMME LU
  socket.on('mark_read', async ({ chatId }) => {
    try {
      const chat = await whatsappClient.getChatById(chatId);
      await chat.sendSeen();
      messages.filter(m => m.from === chatId).forEach(m => m.isRead = true);
      socket.emit('marked_read', { chatId });
    } catch (e) {}
  });

  // DÉCONNECTER WHATSAPP
  socket.on('disconnect_whatsapp', async () => {
    if (whatsappClient) {
      await whatsappClient.logout();
      isReady = false;
      messages.length = 0;
      io.emit('status', { connected: false, message: 'Déconnecté' });
    }
  });

  // RECONNECTER
  socket.on('reconnect_whatsapp', () => {
    initWhatsApp();
  });

  socket.on('disconnect', () => {
    console.log('🔌 Admin déconnecté');
  });
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

// ── START ─────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 Kaleta WhatsApp Server → port ${PORT}`);
  initWhatsApp();
});
