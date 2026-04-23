/**
 * Cloudflare Workers 实时聊天应用
 * 技术栈: Workers + WebSocket + KV (存储文本和Base64媒体)
 */

// --- 前端 HTML/CSS/JS 部分 ---
const htmlContent = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>匿名在线聊天室</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
    <style>
        /* 自定义滚动条美化 */
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: #f1f1f1; }
        ::-webkit-scrollbar-thumb { background: #c1c1c1; border-radius: 3px; }
        ::-webkit-scrollbar-thumb:hover { background: #a8a8a8; }
        .glass { background: rgba(255, 255, 255, 0.95); backdrop-filter: blur(10px); }
        .fade-in { animation: fadeIn 0.3s ease-in-out; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
    </style>
</head>
<body class="bg-gradient-to-br from-gray-900 to-gray-800 h-screen flex items-center justify-center p-4 font-sans">

    <div class="w-full max-w-3xl h-[85vh] glass rounded-2xl shadow-2xl overflow-hidden flex flex-col border border-white/20">
        <!-- 头部 -->
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
            <button id="clear-btn" class="text-xs bg-red-500/80 hover:bg-red-600 px-3 py-1.5 rounded-lg transition backdrop-blur-sm">
                <i class="fas fa-trash"></i> 清空
            </button>
        </div>

        <!-- 消息列表 -->
        <div id="message-container" class="flex-1 overflow-y-auto p-6 space-y-4 bg-gray-50/50">
            <!-- 消息由 JS 生成 -->
        </div>

        <!-- 输入区域 -->
        <div class="p-4 bg-white border-t border-gray-100">
            <!-- 文件预览 -->
            <div id="preview-area" class="hidden mb-3 flex items-center gap-3 p-2 bg-gray-50 rounded-lg border border-gray-200">
                <img id="preview-thumb" class="h-12 w-12 rounded object-cover border border-gray-200">
                <span id="preview-name" class="text-sm text-gray-600 flex-1 truncate"></span>
                <button id="cancel-upload" class="text-gray-400 hover:text-red-500"><i class="fas fa-times"></i></button>
            </div>

            <div class="flex gap-3 items-end">
                <!-- 附件按钮 -->
                <label class="cursor-pointer text-gray-400 hover:text-indigo-600 transition p-2 rounded-full hover:bg-gray-100">
                    <i class="fas fa-image text-xl"></i>
                    <input type="file" id="file-input" class="hidden" accept="image/*,video/*">
                </label>
                
                <!-- 文本框 -->
                <div class="flex-1 relative">
                    <textarea id="msg-input" rows="1" class="w-full bg-gray-100 text-gray-800 rounded-xl pl-4 pr-4 py-3 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 transition resize-none" placeholder="输入消息..."></textarea>
                </div>
                
                <!-- 发送按钮 -->
                <button id="send-btn" class="bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl px-5 py-3 transition shadow-lg shadow-indigo-200 flex items-center justify-center">
                    <i class="fas fa-paper-plane"></i>
                </button>
            </div>
        </div>
    </div>

    <script>
        // --- 前端逻辑 ---
        const container = document.getElementById('message-container');
        const input = document.getElementById('msg-input');
        const fileInput = document.getElementById('file-input');
        const previewArea = document.getElementById('preview-area');
        const previewThumb = document.getElementById('preview-thumb');
        const previewName = document.getElementById('preview-name');
        const cancelBtn = document.getElementById('cancel-upload');
        
        let ws;
        let currentFile = null;

        // 自动调整高度
        input.addEventListener('input', function() {
            this.style.height = 'auto';
            this.style.height = (this.scrollHeight) + 'px';
            if(!this.value) this.style.height = 'auto';
        });

        // 文件处理
        fileInput.addEventListener('change', (e) => {
            if(e.target.files && e.target.files[0]) {
                currentFile = e.target.files[0];
                const reader = new FileReader();
                reader.onload = (e) => {
                    previewThumb.src = e.target.result;
                    previewName.innerText = currentFile.name;
                    previewArea.classList.remove('hidden');
                };
                reader.readAsDataURL(currentFile); // 读取为 Base64
            }
        });

        cancelBtn.addEventListener('click', () => {
            currentFile = null;
            fileInput.value = '';
            previewArea.classList.add('hidden');
        });

        // 发送逻辑
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
                // 将 Base64 包含在消息中
                payload.media = previewThumb.src; 
                payload.mediaType = currentFile.type.startsWith('video') ? 'video' : 'image';
            }

            if(ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify(payload));
            }

            // 重置
            input.value = '';
            input.style.height = 'auto';
            currentFile = null;
            previewArea.classList.add('hidden');
            fileInput.value = '';
        }

        document.getElementById('send-btn').addEventListener('click', send);
        input.addEventListener('keypress', e => { if(e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }});

        // 渲染消息
        function render(msg) {
            const isMe = msg.user.includes('User_'); // 简单判断
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

        // 连接 WebSocket
        function connect() {
            const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
            ws = new WebSocket(\`\${protocol}//\${location.host}/ws\`);
            
            ws.onopen = () => console.log('Connected');
            ws.onmessage = (e) => render(JSON.parse(e.data));
            ws.onclose = () => setTimeout(connect, 3000);
        }

        // 加载历史
        fetch('/history').then(r => r.json()).then(msgs => msgs.forEach(render));
        connect();
    </script>
</body>
</html>
`;

// --- 后端 Worker 逻辑 ---
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. 返回主页
    if (url.pathname === '/') {
      return new Response(htmlContent, {
        headers: { 'content-type': 'text/html;charset=UTF-8' },
      });
    }

    // 2. 处理 WebSocket 连接
    if (url.pathname === '/ws') {
      // 获取 Durable Object 的 ID (这里使用固定的 "global-chat" 让所有人都在一个房间)
      const id = env.CHAT_ROOM.idFromName("global-chat");
      const stub = env.CHAT_ROOM.get(id);
      return stub.fetch(request);
    }

    // 3. 获取历史消息 (从 KV)
    if (url.pathname === '/history') {
      // 从 KV 读取最后 50 条消息
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
