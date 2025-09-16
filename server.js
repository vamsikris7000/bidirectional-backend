const express = require('express');
const cors = require('cors');
const axios = require('axios');
const http = require('http');
const WebSocket = require('ws');

// Load environment variables (works with both .env file and Railway environment variables)
if (process.env.NODE_ENV !== 'production') {
    require('dotenv').config();
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Store WebSocket connections for each escalation
const escalationWebSockets = new Map(); // escalation_key -> Set of WebSocket connections
const generalWebSockets = new Set(); // General WebSocket connections for SMS/WhatsApp replies

// WebSocket connection handling
wss.on('connection', (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname.split('/').pop();
    
    console.log('🔌 WebSocket connected for path:', path);
    
    if (path === 'general') {
        // General connection for SMS/WhatsApp replies
        generalWebSockets.add(ws);
        console.log('✅ Added general WebSocket connection. Total general clients:', generalWebSockets.size);
        
        ws.on('close', () => {
            console.log('🔌 General WebSocket disconnected');
            generalWebSockets.delete(ws);
            console.log('📊 Remaining general clients:', generalWebSockets.size);
        });
        
        ws.on('error', (error) => {
            console.error('🔌 General WebSocket error:', error);
            generalWebSockets.delete(ws);
        });
        
    } else if (path && path.startsWith('escalation_')) {
        // Escalation-specific connection
        const escalationKey = path;
        
        // Add this WebSocket to the escalation's connection set
        if (!escalationWebSockets.has(escalationKey)) {
            escalationWebSockets.set(escalationKey, new Set());
        }
        escalationWebSockets.get(escalationKey).add(ws);
        
        ws.on('close', () => {
            console.log('🔌 WebSocket disconnected for escalation:', escalationKey);
            if (escalationWebSockets.has(escalationKey)) {
                escalationWebSockets.get(escalationKey).delete(ws);
                if (escalationWebSockets.get(escalationKey).size === 0) {
                    escalationWebSockets.delete(escalationKey);
                }
            }
        });
        
        ws.on('error', (error) => {
            console.error('🔌 WebSocket error for escalation:', escalationKey, error);
        });
    }
});

// Function to broadcast message to all connected clients for an escalation
function broadcastToEscalation(escalationKey, message) {
    if (escalationWebSockets.has(escalationKey)) {
        const connections = escalationWebSockets.get(escalationKey);
        const messageStr = JSON.stringify(message);
        
        connections.forEach(ws => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(messageStr);
                console.log('📡 Broadcasted message via WebSocket to escalation:', escalationKey);
            }
        });
    }
}

const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Dify API configuration
const DIFY_API_URL = process.env.DIFY_API_URL;
const DEFAULT_API_KEY = process.env.DIFY_API_KEY;

// Validate Dify configuration
if (!DIFY_API_URL || !DEFAULT_API_KEY) {
    console.error('❌ Missing required Dify environment variables in .env file:');
    console.error('   DIFY_API_URL:', DIFY_API_URL || 'MISSING');
    console.error('   DIFY_API_KEY:', DEFAULT_API_KEY ? '[SET]' : 'MISSING');
    process.exit(1);
}

// Chatwoot configuration (will be fetched dynamically from Dify API)
let CHATWOOT_CONFIG = {
    url: process.env.CHATWOOT_URL,
    api_access_token: process.env.CHATWOOT_API_KEY,
    account_id: process.env.CHATWOOT_ACCOUNT_ID,
    inbox_id: process.env.CHATWOOT_INBOX_ID,
    auth_type: 'api_key' // Use API key authentication
};

// Validate that required environment variables are set
if (!CHATWOOT_CONFIG.url || !CHATWOOT_CONFIG.api_access_token || !CHATWOOT_CONFIG.account_id || !CHATWOOT_CONFIG.inbox_id) {
    console.error('❌ Missing required Chatwoot environment variables in .env file:');
    console.error('   CHATWOOT_URL:', CHATWOOT_CONFIG.url || 'MISSING');
    console.error('   CHATWOOT_API_KEY:', CHATWOOT_CONFIG.api_access_token ? '[SET]' : 'MISSING');
    console.error('   CHATWOOT_ACCOUNT_ID:', CHATWOOT_CONFIG.account_id || 'MISSING');
    console.error('   CHATWOOT_INBOX_ID:', CHATWOOT_CONFIG.inbox_id || 'MISSING');
    process.exit(1);
}

// Fetch Chatwoot configuration from Dify API
async function fetchChatwootConfig() {
    try {
        console.log('🔍 Fetching Chatwoot configuration from Dify API...');
        
        const response = await axios.get(`${DIFY_API_URL.replace('/v1', '')}/chatwoot/config`, {
            timeout: 5000
        });
        
        if (response.data && response.data.chatwoot) {
            const config = response.data.chatwoot;
            CHATWOOT_CONFIG = {
                url: config.url || CHATWOOT_CONFIG.url,
                api_access_token: config.api_access_token || CHATWOOT_CONFIG.api_access_token,
                account_id: config.account_id || CHATWOOT_CONFIG.account_id,
                inbox_id: config.inbox_id || CHATWOOT_CONFIG.inbox_id,
                auth_type: config.auth_type || CHATWOOT_CONFIG.auth_type
            };
            
            console.log('✅ Chatwoot configuration updated from Dify API:');
            console.log('   URL:', CHATWOOT_CONFIG.url);
            console.log('   Account ID:', CHATWOOT_CONFIG.account_id);
            console.log('   Inbox ID:', CHATWOOT_CONFIG.inbox_id);
            
            return true;
        } else {
            console.log('⚠️ No Chatwoot config found in Dify API response, using defaults');
            return false;
        }
    } catch (error) {
        console.log('⚠️ Could not fetch Chatwoot config from Dify API, using defaults:', error.message);
        return false;
    }
}

// Active escalations tracking with monitoring
const activeEscalations = new Map(); // escalation_key -> escalation_info
const escalationMonitors = new Map(); // escalation_key -> interval_id

// Background monitoring function for Chatwoot messages
function startChatwootMonitoring(escalationKey, escalationInfo) {
    if (escalationMonitors.has(escalationKey)) {
        console.log('🔄 Monitor already running for escalation:', escalationKey);
        return;
    }
    
    console.log('🎯 Starting Chatwoot monitoring for escalation:', escalationKey);
    
    const monitorInterval = setInterval(async () => {
        try {
            const chatwootConfig = escalationInfo.chatwoot_config || CHATWOOT_CONFIG;
            const conversationId = escalationInfo.chatwoot_conversation_id;
            const escalationTimestamp = escalationInfo.escalation_timestamp;
            
            if (!conversationId) {
                console.log('⚠️ No conversation ID for escalation:', escalationKey);
                return;
            }
            
            // Fetch new messages from Chatwoot
            const apiUrl = `${chatwootConfig.url}/api/v1/accounts/${chatwootConfig.account_id}/conversations/${conversationId}/messages`;
            
            const headers = {};
            if (chatwootConfig.auth_type === 'api_key' && chatwootConfig.api_access_token) {
                headers['api_access_token'] = chatwootConfig.api_access_token;
            } else {
                headers['access-token'] = chatwootConfig.access_token;
                headers['client'] = chatwootConfig.client;
                headers['uid'] = chatwootConfig.uid;
                headers['token-type'] = chatwootConfig.token_type;
                headers['expiry'] = chatwootConfig.expiry;
            }
            
            // Debug the request details
            console.log(`🔍 Making Chatwoot API request:`);
            console.log(`   URL: ${apiUrl}`);
            console.log(`   Headers:`, headers);
            console.log(`   Token being used: ${chatwootConfig.api_access_token}`);
            
            const response = await axios.get(apiUrl, { headers });
            
            console.log(`🔍 Monitoring check for ${escalationKey}: Found ${response.data?.payload?.length || 0} total messages`);
            console.log(`🕐 Escalation timestamp: ${escalationTimestamp} (${new Date(escalationTimestamp).toISOString()})`);
            
            if (response.data?.payload && response.data.payload.length > 0) {
                // Log all messages for debugging
                response.data.payload.forEach((msg, index) => {
                    const messageTimestamp = msg.created_at * 1000;
                    const isAfterEscalation = messageTimestamp > escalationTimestamp;
                    const isAgentMessage = msg.message_type === 1;
                    const hasContent = msg.content && msg.content.trim().length > 0;
                    
                    console.log(`📨 Message ${index + 1}: ID=${msg.id}, type=${msg.message_type}, time=${new Date(messageTimestamp).toISOString()}, after_escalation=${isAfterEscalation}, is_agent=${isAgentMessage}, has_content=${hasContent}, content="${msg.content?.substring(0, 50)}..."`);
                });
                
                // Filter messages after escalation timestamp and from agents only
                const newMessages = response.data.payload.filter(msg => {
                    const messageTimestamp = msg.created_at * 1000; // Convert to milliseconds
                    const isAfterEscalation = messageTimestamp > escalationTimestamp;
                    const isAgentMessage = msg.message_type === 1; // Outgoing messages from agents
                    const hasContent = msg.content && msg.content.trim().length > 0;
                    
                    return isAfterEscalation && isAgentMessage && hasContent;
                });
                
                if (newMessages.length > 0) {
                    console.log(`📡 Found ${newMessages.length} new agent messages for escalation:`, escalationKey);
                    
                    // Broadcast each new message via WebSocket
                    newMessages.forEach(msg => {
                        const broadcastMessage = {
                            type: 'new_agent_message',
                            message: {
                                id: msg.id,
                                content: msg.content,
                                sender: msg.sender?.name || 'Agent',
                                timestamp: msg.created_at * 1000,
                                source: 'chatwoot'
                            }
                        };
                        
                        // Broadcast to escalation-specific WebSocket connections
                        broadcastToEscalation(escalationKey, broadcastMessage);
                        
                        // Also broadcast to general WebSocket connections for redundancy
                        const messageStr = JSON.stringify(broadcastMessage);
                        generalWebSockets.forEach(ws => {
                            if (ws.readyState === WebSocket.OPEN) {
                                ws.send(messageStr);
                                console.log('📡 Broadcasted agent message to general WebSocket clients');
                            }
                        });
                    });
                    
                    // Update escalation timestamp to avoid re-processing
                    const latestTimestamp = Math.max(...newMessages.map(msg => msg.created_at * 1000));
                    escalationInfo.escalation_timestamp = latestTimestamp + 1;
                    console.log(`⏰ Updated escalation timestamp to: ${escalationInfo.escalation_timestamp}`);
                }
            }
            
        } catch (error) {
            console.error('❌ Chatwoot monitoring error for', escalationKey, ':', error.message);
        }
    }, 2000); // Check every 2 seconds
    
    escalationMonitors.set(escalationKey, monitorInterval);
    console.log('✅ Chatwoot monitoring started for escalation:', escalationKey);
}

// Function to stop monitoring for an escalation
function stopChatwootMonitoring(escalationKey) {
    if (escalationMonitors.has(escalationKey)) {
        clearInterval(escalationMonitors.get(escalationKey));
        escalationMonitors.delete(escalationKey);
        console.log('🛑 Stopped Chatwoot monitoring for escalation:', escalationKey);
    }
}

console.log('🚀 Server starting...');
console.log('📡 Dify API:', DIFY_API_URL);
console.log('🗨️ Chatwoot API:', CHATWOOT_CONFIG.url);
console.log('🏢 Chatwoot Account ID:', CHATWOOT_CONFIG.account_id);
console.log('📥 Chatwoot Inbox ID:', CHATWOOT_CONFIG.inbox_id);
console.log('🔑 Chatwoot Auth: API Key based authentication');
console.log('🔌 WebSocket support: ENABLED');
console.log('📄 Configuration loaded from .env file');

// Helper function to detect escalation in response
function detectEscalation(responseText, agentThoughts = []) {
    const escalationKeywords = [
        'escalate_to_agent',
        'human agent',
        'transferred you to',
        'connected you with',
        'escalat'
    ];
    
    // Check response content
    const textMatch = escalationKeywords.some(keyword => 
        responseText.toLowerCase().includes(keyword.toLowerCase())
    );
    
    // Check agent thoughts for successful tool usage
    const toolMatch = agentThoughts.some(thought => 
        thought.tool === 'escalate_to_agent' && 
        thought.observation && 
        (thought.observation.includes('✅') || 
         thought.observation.includes('Chatwoot Contact ID:') ||
         thought.observation.includes('Escalated to Human Agent'))
    );
    
    return textMatch || toolMatch;
}

// Extract escalation data from tool execution results
function extractEscalationData(agentThoughts = []) {
    const escalationTool = agentThoughts.find(thought => 
        thought.tool === 'escalate_to_agent' && 
        thought.observation && 
        (thought.observation.includes('✅') || thought.observation.includes('Chatwoot Contact ID:'))
    );
    
    if (!escalationTool || !escalationTool.observation) {
        return null;
    }
    
    const observation = escalationTool.observation;
    console.log('📋 Extracting escalation data from tool result:', observation);
    
    console.log('🔍 Current server Chatwoot config:');
    console.log('   URL:', CHATWOOT_CONFIG.url);
    console.log('   Account ID:', CHATWOOT_CONFIG.account_id);
    console.log('   Inbox ID:', CHATWOOT_CONFIG.inbox_id);
    console.log('   API Token:', CHATWOOT_CONFIG.api_access_token ? '[SET]' : '[MISSING]');
    
    try {
        // First try to parse as JSON if the observation contains JSON
        if (observation.includes('{') && observation.includes('}')) {
            // Try to extract JSON from the observation
            const jsonMatch = observation.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                try {
                    const fullData = JSON.parse(jsonMatch[0]);
                    console.log('✅ Extracted JSON from observation:', fullData);
                    
                    // Check if this is the human-readable escalation response
                    if (fullData.escalate_to_agent && typeof fullData.escalate_to_agent === 'string') {
                        const escalationText = fullData.escalate_to_agent;
                        console.log('🔍 Parsing escalation details from text response');
                        
                        // Extract the actual IDs from the text
                        const contactIdMatch = escalationText.match(/Chatwoot Contact ID:\s*([a-f0-9-]+)/i);
                        const conversationIdMatch = escalationText.match(/Chatwoot Conversation ID:\s*(\d+)/i);
                        const inboxIdMatch = escalationText.match(/Chatwoot Inbox ID:\s*(\d+)/i);
                        
                        if (contactIdMatch && conversationIdMatch) {
                            const escalationData = {
                                chatwoot_contact_id: contactIdMatch[1],
                                chatwoot_conversation_id: conversationIdMatch[1],
                                chatwoot_inbox_id: parseInt(CHATWOOT_CONFIG.inbox_id), // Use inbox ID from .env
                                chat_history_id: conversationIdMatch[1],
                                active: true,
                                created_at: Date.now(),
                                escalation_type: 'chatwoot',
                                // Use the correct Chatwoot authentication from .env
                                chatwoot_auth: {
                                    "api_access_token": CHATWOOT_CONFIG.api_access_token,
                                    "auth_type": "api_key"
                                },
                                chatwoot_config: {
                                    "url": CHATWOOT_CONFIG.url,
                                    "api_access_token": CHATWOOT_CONFIG.api_access_token,
                                    "account_id": CHATWOOT_CONFIG.account_id,
                                    "inbox_id": CHATWOOT_CONFIG.inbox_id,
                                    "auth_type": "api_key",
                                    "created_at": Date.now()
                                }
                            };
                            
                            console.log('✅ Successfully extracted escalation data from text (using .env config):', escalationData);
                            return escalationData;
                        }
                    } else {
                        // This might be the actual structured data
                        console.log('✅ Extracted full escalation data from JSON:', fullData);
                        return fullData;
                    }
                } catch (jsonError) {
                    console.log('⚠️ JSON parse failed, falling back to regex extraction');
                }
            }
        }
        
        // Check if there's tool output or tool input with the escalation data
        if (escalationTool.tool_output) {
            try {
                const toolOutput = typeof escalationTool.tool_output === 'string' 
                    ? JSON.parse(escalationTool.tool_output) 
                    : escalationTool.tool_output;
                console.log('✅ Extracted escalation data from tool_output:', toolOutput);
                return toolOutput;
            } catch (e) {
                console.log('⚠️ Tool output parse failed');
            }
        }
        
        // Fallback: Extract using regex (legacy method)
        const contactIdMatch = observation.match(/Chatwoot Contact ID:\s*([a-f0-9-]+)/i);
        const conversationIdMatch = observation.match(/Chatwoot Conversation ID:\s*([a-f0-9-]+)/i);
        const inboxIdMatch = observation.match(/Chatwoot Inbox ID:\s*(\d+)/i);
        
        if (contactIdMatch && conversationIdMatch) {
            const escalationData = {
                chatwoot_contact_id: contactIdMatch[1],
                chatwoot_conversation_id: conversationIdMatch[1],
                chatwoot_inbox_id: inboxIdMatch ? parseInt(inboxIdMatch[1]) : 1,
                chat_history_id: conversationIdMatch[1], // Use conversation ID as chat history ID
                active: true,
                created_at: Date.now(),
                escalation_type: 'chatwoot'
            };
            
            console.log('✅ Successfully extracted Chatwoot escalation data (regex fallback):', escalationData);
            return escalationData;
        }
    } catch (error) {
        console.error('❌ Error extracting escalation data:', error);
    }
    
    return null;
}

// Serve frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Chatwoot communication endpoints
app.post('/api/chatwoot/send-message', async (req, res) => {
    try {
        const { conversation_id, message, escalation_key } = req.body;
        
        if (!escalation_key || !activeEscalations.has(escalation_key)) {
            return res.status(400).json({ error: 'Invalid or expired escalation session' });
        }
        
        const escalationData = activeEscalations.get(escalation_key);
        
        // Use stored Chatwoot config for this escalation session
        const chatwootConfig = escalationData.chatwoot_config || CHATWOOT_CONFIG;
        
        console.log('📤 Sending message to Chatwoot:', {
            conversation_id: escalationData.chatwoot_conversation_id,
            message: message.substring(0, 50) + '...'
        });
        
        // Debug the request details
        console.log('🔍 Message sending request details:');
        console.log(`   URL: ${chatwootConfig.url}/api/v1/accounts/${chatwootConfig.account_id}/conversations/${escalationData.chatwoot_conversation_id}/messages`);
        console.log(`   Token being used: ${chatwootConfig.api_access_token}`);
        console.log(`   Account ID: ${chatwootConfig.account_id}`);
        console.log(`   Conversation ID: ${escalationData.chatwoot_conversation_id}`);
        
        const response = await axios.post(
            `${chatwootConfig.url}/api/v1/accounts/${chatwootConfig.account_id}/conversations/${escalationData.chatwoot_conversation_id}/messages`,
            {
                content: message,
                message_type: 'incoming'
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'api_access_token': chatwootConfig.api_access_token
                }
            }
        );
        
        console.log('✅ Message sent to Chatwoot successfully');
        res.json({ success: true, message_id: response.data?.id });
        
    } catch (error) {
        console.error('❌ Error sending message to Chatwoot:', error.response?.data || error.message);
        res.status(500).json({ 
            error: 'Failed to send message to Chatwoot',
            details: error.response?.data || error.message 
        });
    }
});

// Store escalation session
app.post('/api/escalation/store', async (req, res) => {
    try {
        const { escalation_data } = req.body;
        
        if (!escalation_data || !escalation_data.chatwoot_conversation_id) {
            return res.status(400).json({ error: 'Invalid escalation data' });
        }
        
        // Fetch fresh Chatwoot configuration from Dify API
        console.log('🔄 Fetching fresh Chatwoot configuration for escalation...');
        await fetchChatwootConfig();
        
        // Generate a unique key for this escalation session
        const escalation_key = `escalation_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        // Store escalation data with timestamp and current Chatwoot config
        const escalationInfo = {
            ...escalation_data,
            stored_at: Date.now(),
            escalation_timestamp: Date.now(), // Mark when escalation happened
            last_message_check: Date.now(),
            websocket: null, // Will store the WebSocket connection
            chatwoot_config: { ...CHATWOOT_CONFIG } // Store the config snapshot
        };
        
        activeEscalations.set(escalation_key, escalationInfo);
        
        // Start WebSocket monitoring for this escalation
        startChatwootMonitoring(escalation_key, escalationInfo);
        
        console.log('✅ Escalation session stored and monitoring started:', escalation_key);
        console.log('📡 Using Chatwoot config:', {
            url: CHATWOOT_CONFIG.url,
            account_id: CHATWOOT_CONFIG.account_id,
            auth_type: CHATWOOT_CONFIG.auth_type
        });
        
        // If we have a pubsub_token, establish WebSocket connection to Chatwoot
        if (escalation_data.pubsub_token) {
            setupChatwootWebSocket(escalation_key, escalation_data);
        } else {
            console.log('⚠️ No pubsub_token available - falling back to polling');
        }
        
        // Auto-cleanup after 24 hours
        setTimeout(() => {
            const escalation = activeEscalations.get(escalation_key);
            if (escalation && escalation.websocket) {
                escalation.websocket.close();
            }
            activeEscalations.delete(escalation_key);
            console.log('🗑️ Cleaned up expired escalation session:', escalation_key);
        }, 24 * 60 * 60 * 1000);
        
        res.json({ escalation_key, stored: true, websocket_supported: !!escalation_data.pubsub_token });
        
    } catch (error) {
        console.error('❌ Error storing escalation session:', error);
        res.status(500).json({ error: 'Failed to store escalation session' });
    }
});

// WebSocket connection to Chatwoot for real-time messaging
function setupChatwootWebSocket(escalation_key, escalation_data) {
    try {
        const escalation = activeEscalations.get(escalation_key);
        const chatwootConfig = escalation?.chatwoot_config || CHATWOOT_CONFIG;
        
        // Use Chatwoot's WebSocket URL
        const wsUrl = `${chatwootConfig.url.replace('https://', 'wss://').replace('http://', 'ws://')}/cable`;
        console.log('🔌 Connecting to Chatwoot WebSocket:', wsUrl);
        
        const ws = new WebSocket(wsUrl);
        
        ws.on('open', () => {
            console.log('✅ Connected to Chatwoot WebSocket');
            
            // Subscribe to the contact's conversation using pubsub_token
            const subscribeMessage = {
                command: "subscribe",
                identifier: JSON.stringify({
                    channel: "RoomChannel",
                    pubsub_token: escalation_data.pubsub_token
                })
            };
            
            ws.send(JSON.stringify(subscribeMessage));
            console.log('📡 Subscribed to Chatwoot room with pubsub_token');
            
            // Store WebSocket connection
            const escalation = activeEscalations.get(escalation_key);
            if (escalation) {
                escalation.websocket = ws;
            }
        });
        
        ws.on('message', (data) => {
            try {
                const message = JSON.parse(data.toString());
                console.log('📥 Received WebSocket message from Chatwoot:', message);
                
                // Handle different message types
                if (message.type === 'confirm_subscription') {
                    console.log('✅ Subscription confirmed to Chatwoot WebSocket');
                } else if (message.message) {
                    handleChatwootWebSocketMessage(escalation_key, message.message);
                }
            } catch (error) {
                console.error('❌ Error parsing WebSocket message:', error);
            }
        });
        
        ws.on('error', (error) => {
            console.error('❌ Chatwoot WebSocket error:', error);
        });
        
        ws.on('close', () => {
            console.log('🔌 Chatwoot WebSocket connection closed');
            // Remove WebSocket reference
            const escalation = activeEscalations.get(escalation_key);
            if (escalation) {
                escalation.websocket = null;
            }
        });
        
    } catch (error) {
        console.error('❌ Error setting up Chatwoot WebSocket:', error);
    }
}

// Handle incoming WebSocket messages from Chatwoot
function handleChatwootWebSocketMessage(escalation_key, message) {
    console.log('🎯 Handling Chatwoot WebSocket message:', message);
    
    // Check if it's a new message from an agent
    if (message.event === 'message.created' && 
        message.data && 
        message.data.message_type === 'outgoing' && 
        message.data.content) {
        
        console.log('📨 New agent message received via WebSocket:', message.data.content);
        
        // Store the message for the frontend to retrieve
        const escalation = activeEscalations.get(escalation_key);
        if (escalation) {
            if (!escalation.pending_messages) {
                escalation.pending_messages = [];
            }
            
            escalation.pending_messages.push({
                id: message.data.id,
                content: message.data.content,
                created_at: message.data.created_at,
                sender: message.data.sender?.name || 'Agent',
                timestamp: new Date(message.data.created_at).getTime(),
                source: 'websocket'
            });
            
            console.log('💾 Stored pending message for frontend retrieval');
            
            // Broadcast the message in real-time to connected clients
            const broadcastMessage = {
                type: 'new_agent_message',
                message: {
                    id: message.data.id,
                    content: message.data.content,
                    sender: message.data.sender?.name || 'Agent',
                    timestamp: new Date(message.data.created_at).getTime(),
                    source: 'websocket'
                }
            };
            
            // Broadcast to escalation-specific WebSocket connections
            broadcastToEscalation(escalation_key, broadcastMessage);
            
            // Also broadcast to general WebSocket connections for redundancy
            const messageStr = JSON.stringify(broadcastMessage);
            generalWebSockets.forEach(ws => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(messageStr);
                    console.log('📡 Broadcasted real-time agent message to general WebSocket clients');
                }
            });
        }
    }
}

// Chat endpoint - Blocking mode
app.post('/api/chat', async (req, res) => {
    try {
        const {
            query,
            inputs = {},
            user = 'test-user',
            conversation_id = '',
            files = [],
            api_key = DEFAULT_API_KEY,
            channel,
            channel_metadata
        } = req.body;

        console.log('📤 Sending to Dify API:', {
            query,
            inputs,
            response_mode: 'blocking',
            user,
            conversation_id: conversation_id || '',
            files,
            auto_generate_name: true,
            channel,
            channel_metadata
        });

        const requestData = {
            query,
            inputs,
            response_mode: 'blocking',
            user,
            conversation_id,
            files,
            auto_generate_name: true,
            channel,
            channel_metadata
        };

        const response = await axios.post(`${DIFY_API_URL}/chat-messages`, requestData, {
            headers: {
                'Authorization': `Bearer ${api_key}`,
                'Content-Type': 'application/json'
            }
        });

        const responseData = response.data;
        console.log('✅ Dify API response received');

        // Check for escalation
        const isEscalated = detectEscalation(
            responseData.answer || '',
            responseData.metadata?.agent_thoughts || []
        );

        if (isEscalated) {
            console.log('🚨 ESCALATION DETECTED! Extracting escalation data from tool results...');
            
            // Extract escalation data from agent thoughts
            const escalationData = extractEscalationData(responseData.metadata?.agent_thoughts || []);
            
            if (escalationData) {
                responseData.escalated = true;
                responseData.escalation_info = {
                    customer_id: escalationData.chatwoot_contact_id,
                    conversation_id: escalationData.chatwoot_conversation_id,
                    agent_id: escalationData.chatwoot_inbox_id,
                    chat_history_id: escalationData.chat_history_id,
                    dcc_websocket_url: `wss://dcc-test.xpectrum-ai.com/api/v1/ws/customer/${escalationData.chatwoot_contact_id}`,
                    message: 'Successfully connected to human agent via escalation service'
                };
                console.log('🎯 Added escalation info to response:', responseData.escalation_info);
            } else {
                console.log('⚠️ Failed to extract escalation data from tool results');
            }
        }

        res.json(responseData);
    } catch (error) {
        console.error('❌ Error calling Dify API:', error.response?.data || error.message);
        
        const errorData = error.response?.data || {};
        let errorMessage = 'Failed to get response from Dify API';
        let suggestion = '';

        // Provide specific guidance based on error type
        if (errorData.code === 'unauthorized') {
            errorMessage = 'Invalid API Key';
            suggestion = 'Please check your Dify API key in the configuration panel.';
        } else if (errorData.code === 'invalid_param' && errorData.message?.includes('Agent Chat App does not support blocking mode')) {
            errorMessage = 'Agent apps require Streaming mode';
            suggestion = 'Please switch to "Streaming" mode in the Response Mode dropdown. Agent Chat Apps do not support blocking mode.';
        } else if (errorData.code === 'invalid_param') {
            errorMessage = 'Invalid parameters';
            suggestion = 'Please check your input parameters. Common issues: invalid JSON in inputs/files, missing required fields.';
        } else if (errorData.code === 'app_unavailable') {
            errorMessage = 'App configuration unavailable';
            suggestion = 'The Dify app is not properly configured or not published. Please check your app settings in Dify.';
        } else if (errorData.code === 'provider_not_initialize') {
            errorMessage = 'No model credentials configured';
            suggestion = 'Please configure model credentials in your Dify app settings.';
        } else if (errorData.code === 'provider_quota_exceeded') {
            errorMessage = 'Model usage quota exceeded';
            suggestion = 'You have exceeded your model usage quota. Please check your billing or upgrade your plan.';
        } else if (errorData.code === 'model_currently_not_support') {
            errorMessage = 'Current model unavailable';
            suggestion = 'The selected model is currently not available. Please try again later or use a different model.';
        } else if (errorData.code === 'completion_request_error') {
            errorMessage = 'Text generation failed';
            suggestion = 'The AI model failed to generate a response. Please try rephrasing your question or try again.';
        } else if (error.response?.status === 404) {
            errorMessage = 'Conversation not found';
            suggestion = 'The conversation ID does not exist. Please start a new conversation or check the conversation ID.';
        } else if (error.response?.status === 500) {
            errorMessage = 'Internal server error';
            suggestion = 'An internal error occurred. Please try again or contact support if the issue persists.';
        } else if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
            errorMessage = 'Cannot connect to Dify API';
            suggestion = 'Please ensure Dify is running on http://127.0.0.1:5001 and is accessible.';
        }

        res.status(error.response?.status || 500).json({
            error: errorMessage,
            suggestion: suggestion,
            details: errorData,
            originalError: error.response?.data || error.message
        });
    }
});

// Chat endpoint - Streaming mode with escalation detection
app.post('/api/chat/stream', async (req, res) => {
    try {
        const {
            query,
            inputs = {},
            user = 'test-user',
            conversation_id = '',
            files = [],
            api_key = DEFAULT_API_KEY,
            channel,
            channel_metadata
        } = req.body;

        console.log('📤 Starting stream to Dify API:', {
            query,
            inputs,
            response_mode: 'streaming',
            user,
            conversation_id: conversation_id || '',
            files,
            channel,
            channel_metadata
        });

        const requestData = {
            query,
            inputs,
            response_mode: 'streaming',
            user,
            conversation_id,
            files,
            auto_generate_name: true,
            channel,
            channel_metadata
        };

        // Set headers for Server-Sent Events
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Cache-Control'
        });

        const response = await axios.post(`${DIFY_API_URL}/chat-messages`, requestData, {
            headers: {
                'Authorization': `Bearer ${api_key}`,
                'Content-Type': 'application/json'
            },
            responseType: 'stream'
        });

        console.log('✅ Streaming response started');

        let escalationDetected = false;
        let streamData = { metadata: { agent_thoughts: [] } };

        // Forward the stream to the client
        response.data.on('data', async (chunk) => {
            const chunkStr = chunk.toString();
            const lines = chunkStr.split('\n');
            
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    try {
                        const data = JSON.parse(line.slice(6));
                        
                        // Collect stream data for escalation detection
                        if (data.event === 'agent_thought') {
                            if (!streamData.metadata.agent_thoughts) {
                                streamData.metadata.agent_thoughts = [];
                            }
                            streamData.metadata.agent_thoughts.push(data);
                        }
                        
                        // Check for successful escalation
                        if (data.event === 'agent_thought' && 
                            data.tool === 'escalate_to_agent' && 
                            data.observation && 
                            (data.observation.includes('✅') || data.observation.includes('Chatwoot Contact ID:'))) {
                            
                            console.log('🚨 Successful escalation detected in stream!');
                            console.log('🔍 Full agent_thought data:', JSON.stringify(data, null, 2));
                            escalationDetected = true;
                            
                            // Try to extract escalation data for backend storage
                            const escalationData = extractEscalationData([data]);
                            if (escalationData) {
                                console.log('📋 Extracted detailed escalation data for backend storage');
                                
                                // Automatically store the escalation session
                                const escalation_key = `escalation_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
                                const escalationInfo = {
                                    ...escalationData,
                                    // Use the escalation data's Chatwoot config (from Dify) which has the correct token
                                    chatwoot_config: escalationData.chatwoot_config || CHATWOOT_CONFIG,
                                    stored_at: Date.now(),
                                    escalation_timestamp: Date.now(), // When escalation started
                                    last_message_check: Date.now(),
                                    websocket: null
                                };
                                
                                activeEscalations.set(escalation_key, escalationInfo);
                                
                                // Start WebSocket monitoring for this escalation  
                                startChatwootMonitoring(escalation_key, escalationInfo);
                                
                                console.log('💾 Automatically stored escalation session:', escalation_key);
                                
                                // Send escalation success event with the escalation key
                                const escalationEvent = {
                                    event: 'escalation_success',
                                    escalation_info: {
                                        message: 'Successfully connected to human agent via Chatwoot',
                                        escalation_key: escalation_key,
                                        chatwoot_contact_id: escalationData.chatwoot_contact_id,
                                        chatwoot_conversation_id: escalationData.chatwoot_conversation_id,
                                        chatwoot_inbox_id: escalationData.chatwoot_inbox_id
                                    }
                                };
                                
                                res.write(`data: ${JSON.stringify(escalationEvent)}\n\n`);
                                console.log('📡 Sent escalation success event with key:', escalation_key);
                                
                                // Auto-cleanup after 24 hours
                                setTimeout(() => {
                                    const escalation = activeEscalations.get(escalation_key);
                                    if (escalation && escalation.websocket) {
                                        escalation.websocket.close();
                                    }
                                    activeEscalations.delete(escalation_key);
                                    console.log('🗑️ Cleaned up expired escalation session:', escalation_key);
                                }, 24 * 60 * 60 * 1000);
                                
                            } else {
                                // Send simple escalation success event like the old app
                                const escalationEvent = {
                                    event: 'escalation_success',
                                    escalation_info: {
                                        message: 'Successfully connected to human agent via Chatwoot'
                                    }
                                };
                                
                                res.write(`data: ${JSON.stringify(escalationEvent)}\n\n`);
                                console.log('📡 Sent escalation success event (simple format - no data extracted)');
                            }
                        }
                    } catch (e) {
                        // Ignore JSON parse errors for non-JSON lines
                    }
                }
            }
            
            // Forward the original chunk to frontend
            res.write(chunk);
        });

        response.data.on('end', () => {
            console.log('✅ Streaming response completed');
            res.end();
        });

        response.data.on('error', (error) => {
            console.error('❌ Stream error:', error);
            res.write(`data: ${JSON.stringify({ error: 'Stream error occurred' })}\n\n`);
            res.end();
        });

    } catch (error) {
        console.error('❌ Error calling Dify API:', error.response?.data || error.message);
        
        const errorData = error.response?.data || {};
        let errorMessage = 'Failed to get response from Dify API';
        let suggestion = '';
        
        // Provide specific guidance based on error type
        if (errorData.code === 'unauthorized') {
            errorMessage = 'Invalid API Key';
            suggestion = 'Please check your Dify API key in the configuration panel.';
        } else if (errorData.code === 'invalid_param') {
            errorMessage = 'Invalid parameters';
            suggestion = 'Please check your input parameters. Common issues: invalid JSON in inputs/files, missing required fields.';
        } else if (errorData.code === 'app_unavailable') {
            errorMessage = 'App configuration unavailable';
            suggestion = 'The Dify app is not properly configured or not published. Please check your app settings in Dify.';
        } else if (errorData.code === 'provider_not_initialize') {
            errorMessage = 'No model credentials configured';
            suggestion = 'Please configure model credentials in your Dify app settings.';
        } else if (errorData.code === 'provider_quota_exceeded') {
            errorMessage = 'Model usage quota exceeded';
            suggestion = 'You have exceeded your model usage quota. Please check your billing or upgrade your plan.';
        } else if (errorData.code === 'model_currently_not_support') {
            errorMessage = 'Current model unavailable';
            suggestion = 'The selected model is currently not available. Please try again later or use a different model.';
        } else if (errorData.code === 'completion_request_error') {
            errorMessage = 'Text generation failed';
            suggestion = 'The AI model failed to generate a response. Please try rephrasing your question or try again.';
        } else if (error.response?.status === 404) {
            errorMessage = 'Conversation not found';
            suggestion = 'The conversation ID does not exist. Please start a new conversation or check the conversation ID.';
        } else if (error.response?.status === 500) {
            errorMessage = 'Internal server error';
            suggestion = 'An internal error occurred. Please try again or contact support if the issue persists.';
        } else if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
            errorMessage = 'Cannot connect to Dify API';
            suggestion = 'Please ensure Dify is running on http://127.0.0.1:5001 and is accessible.';
        }

        // Safely serialize error details to avoid circular references in SSE
        let detailsSafe;
        try {
            if (Buffer.isBuffer(errorData)) {
                detailsSafe = errorData.toString();
            } else if (errorData && typeof errorData === 'object' && typeof errorData.pipe === 'function') {
                detailsSafe = 'Stream error';
            } else if (errorData && typeof errorData === 'object') {
                const { code, message, status, error: err } = errorData;
                const compact = { code, message, status, error: err };
                // Attempt to clone to ensure serializability
                detailsSafe = JSON.parse(JSON.stringify(compact));
            } else {
                detailsSafe = errorData || error.message;
            }
        } catch (_) {
            detailsSafe = error.message || 'Unknown error';
        }

        res.write(`data: ${JSON.stringify({ event: 'error', error: errorMessage, suggestion, details: detailsSafe })}\n\n`);
        res.end();
    }
});

// SMS/WhatsApp Integration - Add after the existing routes

// Store for SMS/WhatsApp conversation mappings
const smsWhatsappMappings = new Map(); // phone_number -> conversation_id
const pendingReplies = new Map(); // phone_number -> array of replies

// Webhook endpoint for SMS/WhatsApp replies
app.post('/api/sms-whatsapp/webhook', express.urlencoded({ extended: true }), (req, res) => {
    const { From, Body } = req.body;
    
    console.log(`📱 SMS/WhatsApp webhook - From: ${From}, Body: ${Body}`);
    
    // Check if this phone number has an active conversation
    const conversationId = smsWhatsappMappings.get(From);
    
    if (conversationId) {
        console.log(`🔗 Found conversation mapping: ${From} → ${conversationId}`);
        
        // Store the reply for the frontend to retrieve
        if (!pendingReplies.has(From)) {
            pendingReplies.set(From, []);
        }
        
        pendingReplies.get(From).push({
            message: Body,
            timestamp: Date.now(),
            conversation_id: conversationId,
            processed: false
        });
        
        console.log(`💾 Stored reply for conversation ${conversationId}: ${Body}`);
        
        // Notify connected WebSocket clients about the new reply
        const notification = {
            type: 'sms_whatsapp_reply',
            phone_number: From,
            message: Body,
            conversation_id: conversationId,
            timestamp: Date.now()
        };
        
        // Broadcast to general WebSocket clients (for SMS/WhatsApp replies)
        generalWebSockets.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(notification));
            }
        });
        
        console.log(`📡 Broadcasted reply notification to ${generalWebSockets.size} general clients`);
    } else {
        console.log(`⚠️ No conversation mapping found for ${From}`);
    }
    
    res.send('OK');
});

// Register conversation mapping endpoint
app.post('/api/sms-whatsapp/register', (req, res) => {
    const { phone_number, conversation_id, context } = req.body;
    
    console.log(`📋 Registering SMS/WhatsApp mapping: ${phone_number} → ${conversation_id}`);
    console.log(`📝 Context: ${context}`);
    
    smsWhatsappMappings.set(phone_number, conversation_id);
    
    res.json({
        success: true,
        phone_number,
        conversation_id,
        message: 'Mapping registered successfully'
    });
});

// Get pending replies endpoint
app.get('/api/sms-whatsapp/replies/:phone_number', (req, res) => {
    const phoneNumber = req.params.phone_number;
    const replies = pendingReplies.get(phoneNumber) || [];
    const unprocessed = replies.filter(reply => !reply.processed);
    
    if (unprocessed.length > 0) {
        // Mark as processed
        unprocessed.forEach(reply => reply.processed = true);
        
        res.json({
            success: true,
            phone_number: phoneNumber,
            replies: unprocessed,
            count: unprocessed.length
        });
    } else {
        res.json({
            success: false,
            phone_number: phoneNumber,
            message: 'No new replies found'
        });
    }
});

// Send SMS/WhatsApp message endpoint
app.post('/api/sms-whatsapp/send', async (req, res) => {
    const { phone_number, message, channel = 'auto', conversation_id } = req.body;
    
    try {
        // Register conversation mapping if provided
        if (conversation_id) {
            smsWhatsappMappings.set(phone_number, conversation_id);
            console.log(`📋 Auto-registered mapping: ${phone_number} → ${conversation_id}`);
        }
        
        // Determine channel and from number
        let from_number, to_number;
        
        if (channel === 'whatsapp' || phone_number.startsWith('whatsapp:')) {
            from_number = 'whatsapp:+15558207167';
            to_number = phone_number.startsWith('whatsapp:') ? phone_number : `whatsapp:${phone_number}`;
        } else {
            from_number = '+13613062290';
            to_number = phone_number.replace('whatsapp:', '');
        }
        
        // Send via Twilio
        const twilioAccountSid = process.env.TWILIO_ACCOUNT_SID;
        const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN;
        
        if (!twilioAccountSid || !twilioAuthToken) {
            throw new Error('Twilio credentials not configured');
        }
        
        const response = await axios.post(
            `https://api.twilio.com/2010-04-01/Accounts/${twilioAccountSid}/Messages.json`,
            new URLSearchParams({
                From: from_number,
                To: to_number,
                Body: message
            }),
            {
                auth: {
                    username: twilioAccountSid,
                    password: twilioAuthToken
                }
            }
        );
        
        console.log(`📤 Message sent via ${channel}: ${to_number}`);
        
        res.json({
            success: true,
            message_id: response.data.sid,
            channel: channel,
            to_number: to_number,
            from_number: from_number,
            status: response.data.status
        });
        
    } catch (error) {
        console.error('❌ Error sending SMS/WhatsApp:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Start the server with WebSocket support
server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🔌 WebSocket server ready for real-time messaging`);
    console.log(`🌐 Frontend URL: http://localhost:${PORT}`);
    console.log(`📡 WebSocket URL: ws://localhost:${PORT}/escalation_key`);
});