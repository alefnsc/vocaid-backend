/**
 * Test WebSocket Connection to Custom LLM Endpoint
 * This simulates what Retell does when connecting to the backend
 */

const WebSocket = require('ws');

const TEST_CALL_ID = 'test_call_123456';
const WS_URL = `ws://localhost:3001/llm-websocket/${TEST_CALL_ID}`;

console.log('🧪 Testing WebSocket Connection...\n');
console.log(`Connecting to: ${WS_URL}\n`);

const ws = new WebSocket(WS_URL);

ws.on('open', () => {
    console.log('✅ WebSocket connection established!\n');
    
    // Simulate call_started event from Retell
    const callStartedMessage = {
        interaction_type: 'call_started',
        call_id: TEST_CALL_ID,
        transcript: [],
        metadata: {
            first_name: 'John',
            last_name: 'Doe',
            job_title: 'Software Engineer',
            company_name: 'Test Company',
            job_description: 'We are looking for an experienced software engineer...',
            interviewee_cv: 'john_doe_resume.pdf',
            interview_id: 'test_interview_001'
        }
    };
    
    console.log('📤 Sending call_started message...\n');
    ws.send(JSON.stringify(callStartedMessage));
});

ws.on('message', (data) => {
    console.log('📥 Received message from server:');
    try {
        const message = JSON.parse(data.toString());
        console.log(JSON.stringify(message, null, 2));
        console.log('');
    } catch (e) {
        console.log(data.toString());
    }
});

ws.on('error', (error) => {
    console.error('❌ WebSocket error:', error.message);
});

ws.on('close', () => {
    console.log('🔌 WebSocket connection closed');
    process.exit(0);
});

// Close connection after 5 seconds
setTimeout(() => {
    console.log('\n⏱️  Test complete - closing connection...');
    ws.close();
}, 5000);
