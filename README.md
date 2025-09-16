# Bidirectional Communications Backend

Node.js backend server for the bidirectional AI-Human customer interface system.

## 🚀 Quick Deploy to Railway

### 1. Fork this Repository
Fork this repository to your GitHub account.

### 2. Deploy to Railway
1. Go to [railway.app](https://railway.app)
2. Sign up with GitHub
3. Click "New Project" → "Deploy from GitHub repo"
4. Select your forked repository
5. Railway will automatically deploy your backend

### 3. Configure Environment Variables
In Railway dashboard, go to your project → Variables tab and add:

```env
CHATWOOT_URL=https://d1o0hms5bruuwu.cloudfront.net
CHATWOOT_API_KEY=your_chatwoot_api_key_here
CHATWOOT_ACCOUNT_ID=1
CHATWOOT_INBOX_ID=1
DIFY_API_URL=https://d22yt2oewbcglh.cloudfront.net/v1
DIFY_API_KEY=your_dify_api_key_here
TWILIO_ACCOUNT_SID=your_twilio_account_sid_here
TWILIO_AUTH_TOKEN=your_twilio_auth_token_here
```

### 4. Get Your Backend URL
After deployment, Railway will give you a URL like:
`https://your-backend-name.railway.app`

## 🔧 Local Development

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment
Copy `.env.example` to `.env` and fill in your credentials:
```bash
cp .env.example .env
```

### 3. Start Server
```bash
npm start
```

## 📡 API Endpoints

### Health Check
- `GET /api/health` - Server health status

### Chat
- `POST /api/chat/stream` - Streaming chat with Dify AI
- `POST /api/escalation/store` - Store escalation session

### Chatwoot Integration
- `POST /api/chatwoot/send-message` - Send message to human agent

### SMS/WhatsApp (Optional)
- `POST /api/sms-whatsapp/send` - Send SMS/WhatsApp message
- `POST /api/sms-whatsapp/webhook` - Receive incoming messages
- `GET /api/sms-whatsapp/replies/:phone_number` - Get pending replies

### WebSocket
- `WebSocket /{escalation_key}` - Real-time agent messages

## 🛠️ Required Services

### Dify AI
- Sign up at [dify.ai](https://dify.ai)
- Create a chat application
- Get your API key and URL

### Chatwoot
- Sign up at [chatwoot.com](https://chatwoot.com)
- Create an account and inbox
- Get your API key, account ID, and inbox ID

### Twilio (Optional)
- Sign up at [twilio.com](https://twilio.com)
- Get your Account SID and Auth Token
- Configure phone numbers for SMS/WhatsApp

## 🔒 Security

- All sensitive credentials are stored as environment variables
- CORS is configured for cross-origin requests
- Input validation and sanitization
- Rate limiting (recommended for production)

## 📱 Features

- ✅ Real-time AI chat with Dify
- ✅ Automatic human escalation via Chatwoot
- ✅ WebSocket support for real-time messaging
- ✅ SMS/WhatsApp integration via Twilio
- ✅ Multi-channel communication
- ✅ Conversation history and context
- ✅ Error handling and logging

## 🚀 Production Deployment

### Railway (Recommended)
- Free tier available
- Automatic deployments from GitHub
- Environment variable management
- HTTPS enabled by default

### Render
- Free tier available
- Easy Node.js deployment
- Automatic SSL certificates

### Heroku
- Paid plans only
- Easy deployment
- Add-on ecosystem

## 📞 Support

For issues or questions:
1. Check the server logs
2. Verify environment variables
3. Test API endpoints
4. Review the documentation

---

**Made with ❤️ for seamless AI-Human customer interactions**
