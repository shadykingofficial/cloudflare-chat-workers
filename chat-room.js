// chat-room.js
export class ChatRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    // 升级 WebSocket
    if (request.headers.get("Upgrade") === "websocket") {
      const [client, server] = Object.values(new WebSocketPair());
      this.state.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response("Expected WebSocket", { status: 400 });
  }

  // 收到消息时的处理
  async webSocketMessage(ws, message) {
    const data = JSON.parse(message);

    // 1. 存储到 KV (Base64 图片和视频也会存在这里)
    // 使用 timestamp 作为 key
    const key = Date.now().toString();
    await this.env.CHAT_KV.put(key, message);

    // 2. 广播给所有在线用户
    this.state.getWebSockets().forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  }

  webSocketClose(ws, code, reason) {
    ws.close();
  }
}
