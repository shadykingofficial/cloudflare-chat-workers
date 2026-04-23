export default {
    /**
     * Handles incoming HTTP requests.
     * @param {Request} request The incoming request object.
     * @param {Object} env Environment variables, including bindings.
     * @param {Object} ctx The execution context.
     * @returns {Response} The HTTP response.
     */
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        // Route for serving the HTML frontend
        if (url.pathname === '/' || url.pathname === '/index.html') {
            return new Response(frontendHtml, {
                headers: { 'Content-Type': 'text/html' }
            });
        }

        // Route for handling WebSocket connections to the ChatRoom Durable Object
        if (url.pathname === '/chat') {
            const roomId = url.searchParams.get('room_id');
            const clientId = url.searchParams.get('client_id'); // Client-generated ID

            if (!roomId || !clientId) {
                return new Response('Missing room_id or client_id query parameter', { status: 400 });
            }

            // Get the Durable Object stub for the specific room
            const id = env.CHAT_ROOM.idFromName(roomId);
            const stub = env.CHAT_ROOM.get(id);

            // Forward the request to the Durable Object
            return await stub.fetch(request);
        }

        // Default response for unknown paths
        return new Response('Not Found', { status: 404 });
    },
};

// --- Frontend HTML Page ---
// This is served when accessing the root URL.
// It contains the chat interface and JavaScript logic to connect via WebSocket.
const frontendHtml = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Cloudflare Durable Objects 聊天室</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
            margin: 0;
            padding: 0;
            background-color: #f0f2f5;
            display: flex;
            flex-direction: column;
            height: 100vh;
        }

        .header {
            background-color: #24292e;
            color: white;
            padding: 15px 20px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .header h1 {
            margin: 0;
            font-size: 1.5em;
        }

        .room-id-display {
            font-size: 0.9em;
            opacity: 0.8;
        }

        .chat-container {
            display: flex;
            flex: 1;
            overflow: hidden;
        }

        .sidebar {
            width: 250px;
            background-color: #eef3f8;
            border-right: 1px solid #ccc;
            padding: 15px;
            display: flex;
            flex-direction: column;
        }

        .join-room-section {
            margin-bottom: 20px;
        }

        .join-room-section input {
            width: calc(100% - 10px);
            padding: 8px;
            margin-top: 5px;
            margin-bottom: 5px;
            border: 1px solid #ccc;
            border-radius: 4px;
        }

        .join-room-section button {
            width: 100%;
            padding: 10px;
            background-color: #007bff;
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
        }

        .join-room-section button:hover {
            background-color: #0056b3;
        }

        .members-list-title {
            font-weight: bold;
            margin-bottom: 10px;
        }

        .members-list {
            list-style: none;
            padding: 0;
            flex: 1;
            overflow-y: auto;
        }

        .members-list li {
            padding: 5px 0;
            border-bottom: 1px solid #d1d5da;
        }

        .chat-area {
            flex: 1;
            display: flex;
            flex-direction: column;
            background-color: white;
        }

        .messages {
            flex: 1;
            padding: 20px;
            overflow-y: auto;
            display: flex;
            flex-direction: column;
        }

        .message {
            margin-bottom: 15px;
            max-width: 75%;
            word-wrap: break-word;
        }

         .message.own {
            align-self: flex-end;
            background-color: #dcf8c6; /* Green for own messages */
        }

        .message.other {
            align-self: flex-start;
            background-color: #ffffff;
            border: 1px solid #e5e5ea;
        }

        .message-sender {
            font-weight: bold;
            font-size: 0.85em;
            margin-bottom: 3px;
            color: #666;
        }

        .message-text {
            font-size: 1em;
            line-height: 1.4;
        }

        .message-time {
            font-size: 0.7em;
            color: #999;
            text-align: right;
            margin-top: 3px;
        }

        .input-area {
            display: flex;
            padding: 15px;
            border-top: 1px solid #e5e5ea;
            background-color: white;
        }

        #messageInput {
            flex: 1;
            padding: 12px;
            border: 1px solid #ccc;
            border-radius: 20px;
            resize: none;
            outline: none;
            font-size: 1em;
        }

        #sendButton {
            margin-left: 10px;
            padding: 10px 20px;
            background-color: #007bff;
            color: white;
            border: none;
            border-radius: 20px;
            cursor: pointer;
            font-weight: bold;
        }

        #sendButton:hover {
            background-color: #0056b3;
        }

        .status-bar {
            padding: 5px 15px;
            background-color: #f8f9fa;
            border-top: 1px solid #dee2e6;
            font-size: 0.85em;
            color: #6c757d;
            text-align: center;
        }

        .error {
            color: red;
            font-size: 0.9em;
        }

        .info {
            color: #007bff;
            font-size: 0.9em;
        }
    </style>
</head>
<body>

<div class="header">
    <h1>?? 实时聊天室</h1>
    <div class="room-id-display">房间: <span id="currentRoomId">未加入</span></div>
</div>

<div class="chat-container">
    <div class="sidebar">
        <div class="join-room-section">
            <label for="roomIdInput">加入房间:</label>
            <input type="text" id="roomIdInput" placeholder="输入房间ID" value="default_room">
            <button id="joinButton">进入房间</button>
            <div id="joinError" class="error"></div>
        </div>
        <div class="members-section">
            <div class="members-list-title">在线成员 (<span id="memberCount">0</span>):</div>
            <ul class="members-list" id="membersList">
                <!-- Members will be listed here dynamically -->
            </ul>
        </div>
    </div>

    <div class="chat-area">
        <div class="messages" id="messagesContainer">
            <!-- Messages will appear here dynamically -->
        </div>
        <div class="input-area">
            <textarea id="messageInput" placeholder="输入消息..." rows="1"></textarea>
            <button id="sendButton">发送</button>
        </div>
    </div>
</div>

<div class="status-bar" id="statusBar">
    状态: 就绪
</div>

<script>
    let ws = null; // WebSocket instance
    let currentRoomId = null;
    let clientId = null; // Unique ID generated for this client session

    const messagesContainer = document.getElementById('messagesContainer');
    const membersList = document.getElementById('membersList');
    const memberCount = document.getElementById('memberCount');
    const messageInput = document.getElementById('messageInput');
    const sendButton = document.getElementById('sendButton');
    const roomIdInput = document.getElementById('roomIdInput');
    const joinButton = document.getElementById('joinButton');
    const joinError = document.getElementById('joinError');
    const currentRoomIdDisplay = document.getElementById('currentRoomId');
    const statusBar = document.getElementById('statusBar');

    // Generate a simple unique client ID for this session
    function generateClientId() {
        return 'client_' + Math.random().toString(36).substr(2, 9);
    }

    // Join a specific room
    joinButton.addEventListener('click', () => {
        const newRoomId = roomIdInput.value.trim();
        if (!newRoomId) {
            joinError.textContent = '请输入房间ID';
            return;
        }
        joinError.textContent = '';
        if (ws) {
            ws.close(); // Close existing connection if any
        }
        connectToRoom(newRoomId);
    });

    // Send message handler
    sendButton.addEventListener('click', sendMessage);
    messageInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { // Enter to send, Shift+Enter for new line
            e.preventDefault();
            sendMessage();
        }
    });

    // Function to establish WebSocket connection to a room
    function connectToRoom(roomId) {
        // Ensure we have a client ID
        if (!clientId) {
            clientId = generateClientId();
        }

        // Construct the WebSocket URL based on the current page's origin
        const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = \`\${wsProtocol}//\${location.host}/chat?room_id=\${encodeURIComponent(roomId)}&client_id=\${encodeURIComponent(clientId)}\`;

        try {
            ws = new WebSocket(wsUrl);

            ws.onopen = () => {
                console.log('Connected to room:', roomId);
                currentRoomId = roomId;
                currentRoomIdDisplay.textContent = roomId;
                statusBar.textContent = \`已连接到房间: \${roomId}\`;
                joinError.textContent = '';
            };

            ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    handleWsMessage(data);
                } catch (e) {
                    console.error("Failed to parse WebSocket message:", event.data, e);
                }
            };

            ws.onclose = (event) => {
                console.log('Disconnected from room:', currentRoomId, event.code, event.reason);
                currentRoomId = null;
                currentRoomIdDisplay.textContent = '未加入';
                statusBar.textContent = \`已断开连接 (\${event.code}: \${event.reason})\`;
                 // Clear members list on disconnect
                membersList.innerHTML = '';
                memberCount.textContent = '0';
            };

            ws.onerror = (error) => {
                console.error('WebSocket error:', error);
                statusBar.textContent = '连接错误';
            };

        } catch (e) {
            console.error("Failed to create WebSocket connection:", e);
            statusBar.textContent = '连接失败';
        }
    }

    // Handle different types of messages received over WebSocket
    function handleWsMessage(data) {
        switch(data.type) {
            case 'history':
                // Load message history
                messagesContainer.innerHTML = ''; // Clear existing messages first
                data.messages.forEach(msg => {
                     addMessageToDom(msg.sender, msg.text, msg.timestamp, false); // Assume history messages are not from 'self'
                });
                break;
            case 'member_join':
                // A new member joined
                updateMembersList(data.members);
                statusBar.textContent = \`用户 \${data.name} 加入了房间\`;
                setTimeout(() => { if(statusBar.textContent.startsWith('用户')) statusBar.textContent = \`已在房间: \${currentRoomId}\`; }, 3000);
                break;
            case 'member_leave':
                // A member left
                updateMembersList(data.members);
                 statusBar.textContent = \`用户 \${data.name} 离开了房间\`;
                 setTimeout(() => { if(statusBar.textContent.startsWith('用户')) statusBar.textContent = \`已在房间: \${currentRoomId}\`; }, 3000);
                break;
            case 'members_list':
                // Received initial or updated list of members
                updateMembersList(data.members);
                break;
            case 'chat_message':
                // Received a new chat message
                addMessageToDom(data.sender, data.text, data.timestamp, data.sender === clientId); // Check if it's the current client's message
                break;
            case 'system_message':
                // Received a system message
                addSystemMessage(data.text);
                break;
            default:
                console.warn("Unknown message type received:", data);
        }
    }

    // Update the members list UI
    function updateMembersList(membersArray) {
        membersList.innerHTML = ''; // Clear the list first
        if (membersArray && Array.isArray(membersArray)) {
            membersArray.forEach(member => {
                const listItem = document.createElement('li');
                listItem.textContent = member.name || member.id || 'Unknown';
                membersList.appendChild(listItem);
            });
            memberCount.textContent = membersArray.length;
        } else {
             memberCount.textContent = '0';
        }
    }

    // Add a regular chat message to the DOM
    function addMessageToDom(sender, text, timestamp, isOwnMessage) {
        const messageDiv = document.createElement('div');
        messageDiv.className = \`message \${isOwnMessage ? 'own' : 'other'}\`;

        const senderDiv = document.createElement('div');
        senderDiv.className = 'message-sender';
        senderDiv.textContent = isOwnMessage ? '我' : (sender || 'Someone');

        const textDiv = document.createElement('div');
        textDiv.className = 'message-text';
        textDiv.textContent = text;

        const timeDiv = document.createElement('div');
        timeDiv.className = 'message-time';
        timeDiv.textContent = formatTime(timestamp);

        messageDiv.appendChild(senderDiv);
        messageDiv.appendChild(textDiv);
        messageDiv.appendChild(timeDiv);

        messagesContainer.appendChild(messageDiv);
        messagesContainer.scrollTop = messagesContainer.scrollHeight; // Scroll to bottom
    }

     // Add a system message to the DOM
    function addSystemMessage(text) {
        const messageDiv = document.createElement('div');
        messageDiv.className = 'message system';
        messageDiv.style.alignSelf = 'center';
        messageDiv.style.backgroundColor = '#f1f1f1';
        messageDiv.style.fontStyle = 'italic';
        messageDiv.style.color = '#666';
        messageDiv.style.fontSize = '0.9em';
        messageDiv.style.padding = '8px 12px';

        const textDiv = document.createElement('div');
        textDiv.className = 'message-text';
        textDiv.textContent = text;

        messageDiv.appendChild(textDiv);
        messagesContainer.appendChild(messageDiv);
        messagesContainer.scrollTop = messagesContainer.scrollHeight; // Scroll to bottom
    }

    // Format timestamp for display
    function formatTime(timestampStr) {
        const date = new Date(timestampStr);
        // Example format: HH:MM AM/PM
        return date.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
    }

    // Send a message via WebSocket
    function sendMessage() {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            alert('WebSocket 未连接。请先加入一个房间。');
            return;
        }

        const text = messageInput.value.trim();
        if (text) {
            const messagePacket = {
                type: 'send_message',
                text: text
            };
            ws.send(JSON.stringify(messagePacket));
            messageInput.value = ''; // Clear input after sending
        }
    }

    // Initialize with a default room if desired, or wait for user action
    // connectToRoom('default_room'); 

</script>

</body>
</html>
`;