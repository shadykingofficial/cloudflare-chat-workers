/**
 * Cloudflare Workers 实时聊天应用
 * 合并了前端、Worker 逻辑和 Durable Object 定义
 */

// --- 1. Durable Object 类定义 (必须在这里导出) ---
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

    // 存储到 KV
    const key = Date.now().toString();
    await this.env.CHAT_KV.put(key, message);

    // 广播给所有在线用户
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

// --- 2. 前端 HTML/CSS/JS (保持不变) ---
const htmlContent = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Cloudflare 极简聊天室</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
    <style>
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: #f1f1f1; }
        ::-webkit-scrollbar-thumb { background: #c1c1c1; border-radius: 3px; }
        .glass { background: rgba(255, 255, 255, 0.95); backdrop-filter: blur(10px); }
        .fade-in { animation: fadeIn 0.3s ease-in-out; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
    </style>
</head>
<body class="bg-gradient-to-br from-gray-900 to-gray-800 h-screen flex items-center justify-center p-4 font-sans">
    <div class="w-full max-w-3xl h-[85vh] glass rounded-2xl shadow-2xl overflow-hidden flex flex-col border border-white/20">
        <div class="bg-gradient-to-r from-indigo-600 to-purple-600 p-4 flex justify-between items-center text-white shadow-lg">
            <div class="flex items-center gap-3">
                <div class="w-10 h-10 rounded-full bg-white/20 flex items-center justify-center backdrop-blur-sm">
                    <i class="fas fa-bolt text-xl"></i>
                </div>
                <div>
                    <h1 class="font-bold text-lg tracking-wide">即时通讯</h1>
                    <p class="text-xs text-indigo-200 flex items-center gap-1">
                        <span class="w-2 h-2 bg-green-400 rounded-full animate-pulse"></span> 全球在线
                    </p>
                </div>
            </div>
        </div>
        <div id="message-container" class="flex-1 overflow-y-auto p-6 space-y-4 bg-gray-50/50"></div>
        <div class="p-4 bg-white border-t border-gray-100">
            <div id="preview-area" class="hidden mb-3 flex items-center gap-3 p-2 bg-gray-50 rounded-lg border border-gray-200">
                <img id="preview-thumb" class="h-12 w-12 rounded object-cover border border-gray-200">
                <span id="preview-name" class="text-sm text-gray-600 flex-1 truncate"></span>
                <button id="cancel-upload" class="text-gray-400 hover:text-red-500"><i class="fas fa-times"></i></button>
            </div>
            <div class="flex gap-3 items-end">
                <label class="cursor-pointer text-gray-400 hover:text-indigo-600 transition p-2 rounded-full hover:bg-gray-100">
                    <i class="fas fa-image text-xl"></i>
                    <input type="file" id="file-input" class="hidden" accept="image/*,video/*">
                </label>
                <textarea id="msg-input" rows="1" class="w-full bg-gray-100 text-gray-800 rounded-xl pl-4 pr-4 py-3 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 transition resize-none" placeholder="输入消息..."></textarea>
                <button id="send-btn" class="bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl px-5 py-3 transition shadow-lg shadow-indigo-200 flex items-center justify-center">
                    <i class="fas fa-paper-plane"></i>
                </button>
            </div>
        </div>
    </div>
    <script>
        const container = document.getElementById('message-container');
        const input = document.getElementById('msg-input');
        const fileInput = document.getElementById('file-input');
        const previewArea = document.getElementById('preview-area');
        const previewThumb = document.getElementById('preview-thumb');
        const previewName = document.getElementById('preview-name');
        const cancelBtn = document.getElementById('cancel-upload');
        
        let ws;
        let currentFile = null;

        input.addEventListener('input', function() {
            this.style.height = 'auto';
            this.style.height = (this.scrollHeight) + 'px';
            if(!this.value) this.style.height = 'auto';
        });

        fileInput.addEventListener('change', (e) => {
            if(e.target.files && e.target.files[0]) {
                currentFile = e.target.files[0];
                const reader = new FileReader();
                reader.onload = (e) => {
                    previewThumb.src = e.target.result;
                    previewName.innerText = currentFile.name;
                    previewArea.classList.remove('hidden');
                };
                reader.readAsDataURL(currentFile);
            }
        });

        cancelBtn.addEventListener('click', () => {
            currentFile = null;
            fileInput.value = '';
            previewArea.classList.add('hidden');
        });

        async function send() {
            const text = input.value.trim();
            if(!text && !currentFile) return;

            let payload = {
                type: 'message',
                text: text,
                user: 'User_' + Math.floor(Math.random() * 1000),
                timestamp: Date.now()
            };

            if(currentFile) {
                payload.media = previewThumb.src; 
                payload.mediaType = currentFile.type.startsWith('video') ? 'video' : 'image';
            }

            if(ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify(payload));
            }

            input.value = '';
            input.style.height = 'auto';
            currentFile = null;
            previewArea.classList.add('hidden');
            fileInput.value = '';
        }

        document.getElementById('send-btn').addEventListener('click', send);
        input.addEventListener('keypress', e => { if(e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }});

        function render(msg) {
            const isMe = msg.user.includes('User_');
            const div = document.createElement('div');
            div.className = \`flex \${isMe ? 'justify-end' : 'justify-start'} fade-in\`;
            
            let mediaHtml = '';
            if(msg.media) {
                if(msg.mediaType === 'image') {
                    mediaHtml = \`<img src="\${msg.media}" class="max-w-xs rounded-lg mt-2 cursor-pointer hover:opacity-90" onclick="window.open(this.src)">\`;
                } else {
                    mediaHtml = \`<video controls class="max-w-xs rounded-lg mt-2"><source src="\${msg.media}"></video>\`;
                }
            }

            const bubbleClass = isMe 
                ? 'bg-indigo-600 text-white rounded-l-2xl rounded-tr-2xl' 
                : 'bg-white border border-gray-200 text-gray-800 rounded-r-2xl rounded-tl-2xl';

            div.innerHTML = \`
                <div class="max-w-[75%] p-3 shadow-sm \${bubbleClass}">
                    <div class="flex flex-col">
                        \${mediaHtml}
                        \${msg.text ? \`<p class="text-sm \${isMe ? 'text-white' : 'text-gray-800'}">\${msg.text}</p>\` : ''}
                    </div>
                    <div class="text-[10px] opacity-70 text-right mt-1">
                        \${msg.user} • \${new Date(msg.timestamp).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}
                    </div>
                </div>
            \`;
            container.appendChild(div);
            container.scrollTop = container.scrollHeight;
        }

        function connect() {
            const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
            ws = new WebSocket(\`\${protocol}//\${location.host}/ws\`);
            ws.onopen = () => console.log('Connected');
            ws.onmessage = (e) => render(JSON.parse(e.data));
            ws.onclose = () => setTimeout(connect, 3000);
        }

        fetch('/history').then(r => r.json()).then(msgs => msgs.forEach(render));
        connect();
    </script>
</body>
</html>
`;

// --- 3. Worker 主入口逻辑 ---
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/') {
      return new Response(htmlContent, {
        headers: { 'content-type': 'text/html;charset=UTF-8' },
      });
    }

    if (url.pathname === '/ws') {
      const id = env.CHAT_ROOM.idFromName("global-chat");
      const stub = env.CHAT_ROOM.get(id);
      return stub.fetch(request);
    }

    if (url.pathname === '/history') {
      const list = await env.CHAT_KV.list({ limit: 50, reverse: true });
      const messages = [];
      for (const key of list.keys) {
        const val = await env.CHAT_KV.get(key.name);
        if (val) messages.push(JSON.parse(val));
      }
      return Response.json(messages.reverse());
    }

    return new Response('Not Found', { status: 404 });
  },
};
