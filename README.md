# 🚀 Kaleta WhatsApp Server — Déploiement sur Render

## Étapes

### 1. Pusher sur GitHub
```bash
cd kaleta-whatsapp-server
git init
git add .
git commit -m "init kaleta whatsapp server"
git branch -M main
git remote add origin https://github.com/TON_USERNAME/kaleta-whatsapp-server.git
git push -u origin main
```

### 2. Déployer sur Render
1. Va sur https://render.com
2. New → Web Service
3. Connecte ton repo GitHub `kaleta-whatsapp-server`
4. Configure :
   - **Name** : kaleta-whatsapp-server
   - **Runtime** : Node
   - **Build Command** : `npm install`
   - **Start Command** : `node server.js`
5. Variables d'environnement :
   - `ADMIN_ORIGIN` = URL de ton admin (ex: https://kaleta-admin.netlify.app)
6. Clique **Create Web Service**

### 3. Configurer l'admin
Dans `kaleta-admin/.env` :
```
VITE_WA_SERVER_URL=https://TON-SERVICE.onrender.com
```

### 4. Installer socket.io-client dans l'admin
```bash
cd kaleta-admin
npm install socket.io-client
```

### 5. Scanner le QR Code
- Ouvre l'admin → onglet WhatsApp
- Scanne le QR avec le téléphone du restaurant
- C'est bon ! Les messages s'affichent en temps réel

## Notes
- Le serveur Render gratuit s'endort après 15min d'inactivité
- Premier message après inactivité : délai de 30-60s de réveil
- La session WhatsApp est sauvegardée → pas besoin de rescanner à chaque fois
