// Main entry point for the Worker

export default {
    /**
     * Handles all incoming HTTP requests.
     */
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        // Serve the HTML frontend
        if (url.pathname === '/') {
            return new Response(chatFrontendHtml, { headers: { "content-type": "text/html" } });
        }

        // Handle WebSocket upgrade requests for chat rooms
        if (url.pathname.startsWith('/room/')) {
            const roomId = url.pathname.split('/')[2]; // Extract room ID from path like /room/abc123
            if (!roomId) {
                return new Response("Room ID is required", { status: 400 });
            }

            // Check if it's a WebSocket upgrade request
            if (request.headers.get("Upgrade") !== "websocket") {
                return new Response("Expected WebSocket", { status: 426 });
            }

            // Get the Durable Object stub for the specific room
            const id = env.ROOM.idFromName(roomId);
            const stub = env.ROOM.get(id);

            // Forward the WebSocket upgrade request to the Durable Object
            return await stub.fetch(request);
        }

        // Default 404 for other paths
        return new Response("Not Found", { status: 404 });
    },
};

// --- Durable Object Definition ---
// This class manages the state and WebSocket connections for a single chat room.
export class ChatRoom {
    constructor(state, env) {
        this.state = state;
        this.env = env;
        this.roomId = state.id.toString();
        this.sessions = new Map(); // Store active WebSocket sessions {clientId -> WebSocket}

        // Restore state from storage if available
        this.state.blockConcurrencyWhile(async () => {
            this.messages = await this.state.storage.get('messages') || [];
            this.usernames = await this.state.storage.get('usernames') || {}; // Map {clientId -> username}
        });
    }

    async fetch(request) {
        const url = new URL(request.url);
        const headers = request.headers;

        // Expect WebSocket upgrade
        if (headers.get("Upgrade") !== "websocket") {
            return new Response("Expected WebSocket", { status: 426 });
        }

        // Create WebSocket pair
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);

        // Handle the session lifecycle
        await this.handleSession(server);

        // Return the client WebSocket
        return new Response(null, { status: 101, webSocket: client });
    }

    async handleSession(webSocket) {
        webSocket.accept(); // Accept the WebSocket connection

        let clientId = null;
        let username = null;

        // Listen for the initial registration message from the client
        const initialMessagePromise = new Promise((resolve, reject) => {
            webSocket.addEventListener('message', (event) => {
                try {
                    const data = JSON.parse(event.data);
                    if (data.type === 'register') {
                        clientId = data.clientId;
                        username = data.username || `Guest_${Math.floor(Math.random() * 10000)}`;
                        
                        // Store the username associated with the client ID
                        this.usernames[clientId] = username;
                        // Add the session
                        this.sessions.set(clientId, webSocket);

                        // Send history to the new client
                        webSocket.send(JSON.stringify({ type: 'history', messages: this.messages }));
                        // Send updated member list
                        webSocket.send(JSON.stringify({ type: 'members', members: Array.from(this.usernames.values()) }));

                        // Broadcast that a new user joined
                        this.broadcast({
                            type: 'user_join',
                            user: username,
                            members: Array.from(this.usernames.values())
                        }, clientId);

                        console.log(`User ${username} (${clientId}) joined room ${this.roomId}`);
                        resolve();
                    } else {
                        webSocket.close(1011, "Expected registration message first.");
                    }
                } catch (e) {
                    webSocket.close(1003, "Invalid message format"); // Unsupported Data
                }
            });

            webSocket.addEventListener('error', (err) => {
                console.error('WebSocket error during registration:', err);
                reject(err);
            });
        });

        try {
            await initialMessagePromise;
        } catch (e) {
            console.error("Failed to register client:", e);
            return; // Connection already closed by client or error handling above
        }

        // Listen for incoming messages from this client
        webSocket.addEventListener('message', (event) => {
            try {
                const data = JSON.parse(event.data);
                if (data.type === 'send_message' && data.text) {
                    const messageObj = {
                        user: username, // Use the registered username
                        text: data.text,
                        timestamp: new Date().toISOString(),
                        clientId: clientId // Include sender's ID
                    };

                    // Add to message history
                    this.messages.push(messageObj);
                    // Limit history size to prevent excessive memory usage
                    if (this.messages.length > 100) {
                        this.messages = this.messages.slice(-100);
                    }

                    // Broadcast the message to all other clients in the room
                    this.broadcast(messageObj, clientId);

                    // Persist changes
                    this.persistState();
                }
            } catch (e) {
                console.error("Error processing message:", e);
                // Optionally close the connection
                // webSocket.close(1003, "Invalid message format");
            }
        });

        // Handle client disconnect
        webSocket.addEventListener('close', (event) => {
            if (clientId && this.sessions.has(clientId)) {
                this.sessions.delete(clientId);
                delete this.usernames[clientId]; // Clean up username mapping

                // Broadcast that a user left
                this.broadcast({
                    type: 'user_leave',
                    user: username,
                    members: Array.from(this.usernames.values())
                });

                console.log(`User ${username} (${clientId}) left room ${this.roomId}`);

                // Persist changes
                this.persistState();
            }
        });

        webSocket.addEventListener('error', (event) => {
            console.error('WebSocket error:', event);
            // Treat error similarly to close
             if (clientId && this.sessions.has(clientId)) {
                this.sessions.delete(clientId);
                delete this.usernames[clientId];
                this.broadcast({
                    type: 'user_leave',
                    user: username,
                    members: Array.from(this.usernames.values())
                });
                this.persistState();
            }
        });
    }

    // Broadcast a message to all connected clients except the sender
    broadcast(message, excludeClientId = null) {
        const messageString = JSON.stringify(message);
        for (let [id, ws] of this.sessions) {
            if (id !== excludeClientId && ws.readyState === WebSocket.OPEN) {
                try {
                    ws.send(messageString);
                } catch (e) {
                    console.warn("Failed to send message to client:", id, e);
                    // If sending fails, remove the broken connection
                    this.sessions.delete(id);
                    delete this.usernames[id];
                }
            }
        }
    }

    // Persist current state (messages, usernames) to durable storage
    async persistState() {
        await this.state.storage.put('messages', this.messages);
        await this.state.storage.put('usernames', this.usernames);
    }
}


// --- Frontend HTML & JavaScript ---
// This is embedded directly in the Worker script and served as the main page.
const chatFrontendHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Real-time Chat on Cloudflare Workers</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 0; padding: 0; height: 100vh; display: flex; flex-direction: column; }
        #chatContainer { display: flex; flex: 1; }
        #sidebar { width: 250px; border-right: 1px solid #ccc; padding: 10px; display: flex; flex-direction: column; }
        #chatArea { flex: 1; display: flex; flex-direction: column; }
        #messages { flex: 1; overflow-y: auto; padding: 10px; }
        .message { margin-bottom: 10px; }
        .userJoinLeave { font-style: italic; color: #666; text-align: center; }
        #inputContainer { display: flex; padding: 10px; border-top: 1px solid #ccc; }
        #messageInput { flex: 1; padding: 8px; }
        #sendButton { padding: 8px 15px; margin-left: 10px; cursor: pointer; }
        #membersList { flex: 1; overflow-y: auto; }
        #usernameInput, #roomIdInput { padding: 5px; margin-right: 5px; width: 150px; }
        #joinButton { padding: 5px 10px; cursor: pointer; }
        #status { padding: 5px 10px; background-color: #f0f0f0; font-size: 0.8em; }
    </style>
</head>
<body>
    <div id="chatContainer">
        <div id="sidebar">
            <h3>Join Room</h3>
            <input type="text" id="usernameInput" placeholder="Your Name" />
            <input type="text" id="roomIdInput" placeholder="Room ID" value="general" />
            <button id="joinButton">Join</button>
            
            <h3>Members</h3>
            <div id="membersList"></div>
        </div>
        <div id="chatArea">
            <div id="messages"></div>
            <div id="inputContainer">
                <input type="text" id="messageInput" placeholder="Type a message..." disabled />
                <button id="sendButton" disabled>Send</button>
            </div>
        </div>
    </div>
    <div id="status">Ready to join a room.</div>

    <script>
        let ws = null;
        let clientId = null;
        let currentUsername = null;
        let currentRoomId = null;

        const messagesDiv = document.getElementById('messages');
        const messageInput = document.getElementById('messageInput');
        const sendButton = document.getElementById('sendButton');
        const usernameInput = document.getElementById('usernameInput');
        const roomIdInput = document.getElementById('roomIdInput');
        const joinButton = document.getElementById('joinButton');
        const membersListDiv = document.getElementById('membersList');
        const statusDiv = document.getElementById('status');

        // Generate a unique ID for this browser session
        function generateClientId() {
            return 'client_' + Math.random().toString(36).substr(2, 9);
        }

        joinButton.addEventListener('click', () => {
            const username = usernameInput.value.trim();
            const roomId = roomIdInput.value.trim();
            if (!username || !roomId) {
                statusDiv.textContent = 'Please enter both Username and Room ID.';
                return;
            }
            currentUsername = username;
            currentRoomId = roomId;
            connectToRoom(roomId, username);
        });

        sendButton.addEventListener('click', sendMessage);
        messageInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') sendMessage();
        });

        function connectToRoom(roomId, username) {
            if (ws) ws.close(); // Close any existing connection

            clientId = generateClientId();
            const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
            const wsUrl = \`\${protocol}//\${location.host}/room/\${encodeURIComponent(roomId)}\`;

            statusDiv.textContent = \`Connecting to room: \${roomId}...\`;
            ws = new WebSocket(wsUrl);

            ws.onopen = () => {
                console.log('Connected to room:', roomId);
                statusDiv.textContent = \`Connected to room: \${roomId}\`;
                messageInput.disabled = false;
                sendButton.disabled = false;
                
                // Send initial registration message
                ws.send(JSON.stringify({
                    type: 'register',
                    clientId: clientId,
                    username: username
                }));
            };

            ws.onmessage = (event) => {
                const data = JSON.parse(event.data);
                switch (data.type) {
                    case 'history':
                        messagesDiv.innerHTML = ''; // Clear old messages
                        data.messages.forEach(msg => addMessageToDOM(msg.user, msg.text, msg.timestamp));
                        break;
                    case 'chat_message':
                        addMessageToDOM(data.user, data.text, data.timestamp);
                        break;
                    case 'user_join':
                        addSystemMessage(\`\${data.user} joined the room.\`);
                        updateMembersList(data.members);
                        break;
                    case 'user_leave':
                        addSystemMessage(\`\${data.user} left the room.\`);
                        updateMembersList(data.members);
                        break;
                    case 'members':
                        updateMembersList(data.members);
                        break;
                }
            };

            ws.onclose = (event) => {
                console.log('Disconnected from room:', currentRoomId, event.code, event.reason);
                statusDiv.textContent = \`Disconnected from room: \${currentRoomId} (\${event.code}: \${event.reason})\`;
                messageInput.disabled = true;
                sendButton.disabled = true;
                updateMembersList([]); // Clear members list on disconnect
            };

            ws.onerror = (error) => {
                console.error('WebSocket error:', error);
                statusDiv.textContent = 'Connection error occurred.';
            };
        }

        function sendMessage() {
            const text = messageInput.value.trim();
            if (text && ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'send_message', text: text }));
                messageInput.value = '';
            }
        }

        function addMessageToDOM(user, text, timestamp) {
            const messageElement = document.createElement('div');
            messageElement.className = 'message';
            const time = new Date(timestamp).toLocaleTimeString();
            messageElement.innerHTML = \`<strong>\${user}</strong>: \${text} <small>(\${time})</small>\`;
            messagesDiv.appendChild(messageElement);
            messagesDiv.scrollTop = messagesDiv.scrollHeight;
        }

        function addSystemMessage(text) {
            const messageElement = document.createElement('div');
            messageElement.className = 'message userJoinLeave';
            messageElement.textContent = text;
            messagesDiv.appendChild(messageElement);
            messagesDiv.scrollTop = messagesDiv.scrollHeight;
        }

        function updateMembersList(members) {
            membersListDiv.innerHTML = '';
            members.forEach(member => {
                const p = document.createElement('p');
                p.textContent = member;
                membersListDiv.appendChild(p);
            });
        }
    </script>
</body>
</html>
`;
