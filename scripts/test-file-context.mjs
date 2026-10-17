// Tests the full pipeline: send message with #file ref → agent receives file content
import { io } from 'socket.io-client';

const socket = io('http://localhost:3002', { transports: ['websocket'] });
const CHAT_JID = 'dash:default';
const TEST_FILE = 'hello-puppy.txt';
const TEST_REF = `#chat/${TEST_FILE}`;

let responded = false;

socket.on('connect', () => {
    console.log('✅ Connected to socket.io');

    // Listen for bot response
    socket.on('chat:message', (msg) => {
        if (msg.chatJid === CHAT_JID && !msg.text?.startsWith('_Dispatching')) {
            // skip user echo
            if (msg.sender === 'User') return;
            console.log('\n📨 Agent response received:');
            console.log(`   Sender: ${msg.sender}`);
            console.log(`   Text preview: ${msg.text?.slice(0, 300)}`);

            const text = (msg.text || '').toLowerCase();
            const mentionsPuppy = text.includes('puppy') || text.includes('glee') || text.includes('bouncing') || text.includes('wagging');
            console.log(`\n✅ Agent read the file content: ${mentionsPuppy ? 'YES ✓' : 'NO ✗ (file content not in response)'}`);
            responded = true;
            setTimeout(() => { socket.disconnect(); process.exit(mentionsPuppy ? 0 : 1); }, 500);
        }
    });

    // Send message with #file ref
    const message = `Please read the file ${TEST_REF} and summarize its first two lines in one sentence.`;
    console.log(`\n📤 Sending: "${message}"`);
    socket.emit('chat:send', { chatJid: CHAT_JID, message, clientId: 'test-' + Date.now() });
    console.log('⏳ Waiting for agent response (up to 60s)…\n');
});

socket.on('connect_error', (err) => {
    console.error('❌ Connection failed:', err.message);
    process.exit(1);
});

// Timeout
setTimeout(() => {
    if (!responded) {
        console.error('❌ No response after 60s — agent may be busy or file injection failed');
        socket.disconnect();
        process.exit(1);
    }
}, 60000);
