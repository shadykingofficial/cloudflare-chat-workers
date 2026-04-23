/**
 * Represents a single chat room as a Durable Object.
 * Manages the room's state (messages, members) and handles WebSocket connections.
 */
export class ChatRoom {
    constructor(state, env) {
        this.state = state;
        this.env = env;
        this.roomId = state.id.toString();

        // `state.storage` provides access to persistent storage for this Durable Object
        // `state.blockConcurrencyWhile()` ensures operations inside the callback run atomically
        this.state.blockConcurrencyWhile(async () => {
            // Retrieve stored state: messages and members
            this.messages = await this.state.storage.get('messages') || [];
            this.members = await this.state.storage.get('members') || {};
        });

        // Timer to periodically save state (in case of inactivity)
        this.saveTimer = null;
    }

    /**
     * Handles HTTP requests forwarded by the main Worker script.
     * Specifically, upgrades the request to a WebSocket connection.
     */
    async fetch(request) {
        const url = new URL(request.url);

        if (request.headers.get('Upgrade') !== 'websocket') {
            // If not a WebSocket upgrade request, return an error
            return new Response('Expected WebSocket upgrade', { status: 426 });
        }

        // Accept the WebSocket connection
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);

        // Call the method to handle the WebSocket connection lifecycle
        await this.handleSession(server);

        // Return the client-side WebSocket to the browser
        return new Response(null, { status: 101, webSocket: client });
    }

    /**
     * Manages the lifecycle of a single client's WebSocket session.
     * @param {WebSocket} ws The server-side WebSocket object for this client.
     */
    async handleSession(ws) {
        // Accept the WebSocket connection on the server side
        ws.accept();

        // Wait for the client to send its initial identification packet
        let initialMessage;
        try {
             initialMessage = await new Promise((resolve, reject) => {
                ws.addEventListener('message', event => {
                    resolve(event.data);
                });
                // Set a timeout to prevent hanging indefinitely
                setTimeout(() => reject(new Error('Client did not send initial message')), 5000);
            });
        } catch (e) {
            console.error("Client failed to send initial message:", e);
            ws.close(1011, "Initial handshake failed");
            return;
        }

        let parsedInit;
        try {
            parsedInit = JSON.parse(initialMessage);
        } catch (e) {
            console.error("Invalid initial message from client:", initialMessage);
            ws.close(1011, "Invalid handshake data");
            return;
        }

        if (parsedInit.type !== 'register') {
             console.error("First message must be 'register'");
             ws.close(1011, "Invalid handshake sequence");
             return;
        }

        const clientId = parsedInit.clientId; // Use the client-provided ID
        if (!clientId) {
            console.error("No clientId provided in register message");
            ws.close(1011, "Missing clientId");
            return;
        }

        // Add the new client to the room's member list
        const memberName = \`User_\${Math.floor(Math.random() * 10000)}\`; // Simple name generation
        this.members[clientId] = { id: clientId, name: memberName, ws: ws };

        // Notify the new client with the room history and current members
        ws.send(JSON.stringify({
            type: 'history',
            messages: this.messages
        }));

        ws.send(JSON.stringify({
            type: 'members_list',
            members: Object.values(this.members)
        }));

        // Broadcast to all OTHER members that someone joined
        this.broadcast({
            type: 'member_join',
            name: memberName,
            members: Object.values(this.members)
        }, clientId); // Exclude the joining client from the broadcast

        console.log(\`Client \${clientId} (\${memberName}) joined room \${this.roomId}. Total members: \${Object.keys(this.members).length}\`);

        // Listen for messages from this specific client
        ws.addEventListener('message', (event) => {
            try {
                const data = JSON.parse(event.data);
                if (data.type === 'send_message') {
                    // Create a new message object
                    const newMessage = {
                        sender: clientId, // Use the client's ID as the sender identifier
                        text: data.text,
                        timestamp: new Date().toISOString()
                    };

                    // Add the message to the room's message history
                    this.messages.push(newMessage);
                    // Keep only the last N messages to prevent memory bloat (optional)
                    if (this.messages.length > 100) {
                        this.messages = this.messages.slice(-100);
                    }

                    // Broadcast the new message to ALL members in the room
                    this.broadcast({
                        type: 'chat_message',
                        ...newMessage
                    });
                    console.log(\`Message from \${clientId} in \${this.roomId}: \${data.text}\`);

                    // Schedule a save operation
                    this.scheduleSave();
                }
            } catch (e) {
                console.error("Error parsing message from client:", e);
                // Optionally close the connection on malformed data
                // ws.close(1003, "Invalid message format");
            }
        });

        // Listen for when the client closes the connection
        ws.addEventListener('close', (event) => {
            // Remove the client from the members list
            delete this.members[clientId];

            // Broadcast to remaining members that someone left
            this.broadcast({
                type: 'member_leave',
                name: memberName,
                members: Object.values(this.members)
            });

            console.log(\`Client \${clientId} (\${memberName}) left room \${this.roomId}. Remaining members: \${Object.keys(this.members).length}\`);

            // Schedule a save operation
            this.scheduleSave();
        });

        ws.addEventListener('error', (event) => {
            console.error('WebSocket error for client', clientId, ':', event);
            // Treat errors similarly to close events
             delete this.members[clientId];
             this.broadcast({
                type: 'member_leave',
                name: memberName,
                members: Object.values(this.members)
            });
             this.scheduleSave();
        });
    }

    /**
     * Sends a message to all currently connected WebSocket clients in the room,
     * except the one specified by excludeId.
     * @param {Object} message The message object to broadcast.
     * @param {string} excludeId Optional client ID to exclude from the broadcast.
     */
    broadcast(message, excludeId = null) {
        const messageString = JSON.stringify(message);
        for (const [id, member] of Object.entries(this.members)) {
            if (id !== excludeId) {
                try {
                    // Check if the WebSocket is still open before sending
                    if (member.ws.readyState === WebSocket.OPEN) {
                         member.ws.send(messageString);
                    } else {
                        // If not open, remove it from the list (cleanup)
                        delete this.members[id];
                    }
                } catch (e) {
                    console.warn('Failed to send message to client', id, e);
                    // If sending fails, remove it from the list (cleanup)
                    delete this.members[id];
                }
            }
        }
    }

    /**
     * Schedules a delayed save operation to persist the room's state.
     * This prevents saving too frequently during bursts of activity.
     */
    scheduleSave() {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer); // Cancel previous scheduled save
        }
        this.saveTimer = setTimeout(() => {
            this.state.storage.put('messages', this.messages);
            this.state.storage.put('members', this.members);
            console.log(\`Saved state for room \${this.roomId}\`);
        }, 1000); // Save after 1 second of inactivity
    }
}