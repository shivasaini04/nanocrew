import { io } from 'socket.io-client';

const AGENT_ID = process.argv[2] || `worker-${Math.random().toString(36).slice(2, 7)}`;
const SERVER_URL = 'http://localhost:3000/workers'; // Assuming default port 3000

console.log(`[${AGENT_ID}] Connecting to ${SERVER_URL}...`);

const socket = io(SERVER_URL);

socket.on('connect', () => {
    console.log(`[${AGENT_ID}] Connected. Registering...`);
    socket.emit('worker:register', { agentId: AGENT_ID });
});

socket.on('worker:registered', (data) => {
    console.log(`[${AGENT_ID}] Successfully registered!`, data);
    
    // Send a test log
    socket.emit('worker:log', {
        agentId: AGENT_ID,
        level: 'info',
        message: 'Hello from mock worker!',
        timestamp: new Date().toISOString()
    });
});

socket.on('worker:task:start', (data) => {
    console.log(`[${AGENT_ID}] Received task:`, data);
    
    // Simulate work
    setTimeout(() => {
        console.log(`[${AGENT_ID}] Task complete!`);
        socket.emit('worker:task:complete', {
            agentId: AGENT_ID,
            taskId: data.taskId,
            result: { message: `Completed ${data.taskType}`, data: [1, 2, 3] }
        });
    }, 2000);
});

socket.on('disconnect', () => {
    console.log(`[${AGENT_ID}] Disconnected.`);
});

socket.on('connect_error', (error) => {
    console.error(`[${AGENT_ID}] Connection error:`, error.message);
});
