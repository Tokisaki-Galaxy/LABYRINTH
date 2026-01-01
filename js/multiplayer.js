let supabaseClient = null;

const Multiplayer = {
    currentRoom: null,
    roomPassword: null,
    rooms: [],
    processedMessageIds: new Set(), // Track processed message IDs to avoid duplicates

    showLobby() {
        App.mode = 'multi';
        document.getElementById('btnSingle').classList.remove('primary');
        document.getElementById('btnMulti').classList.add('primary');
        document.getElementById('singlePlayerMenu').style.display = 'none';
        document.getElementById('multiplayerLobby').style.display = 'flex';
        this.refreshRooms();
    },

    async refreshRooms() {
        if (!supabaseClient) return alert("请先配置 Supabase URL 和 Key");
        // 仅选择已授权的列，避免 42501 权限错误
        const { data, error } = await supabaseClient.from('rooms')
            .select('id, name, status, is_private, created_at')
            .order('created_at', { ascending: false });

        if (error) return console.error(error);
        this.rooms = data;
        this.renderRooms();
    },

    renderRooms() {
        const el = document.getElementById('roomList');
        el.innerHTML = '';
        if (this.rooms.length === 0) {
            el.innerHTML = '<div style="text-align:center; color:var(--text-muted); padding:20px;">暂无房间，快去创建一个吧！</div>';
            return;
        }
        this.rooms.forEach(room => {
            const d = document.createElement('div');
            d.className = 'history-item';
            d.innerHTML = `
                <div class="history-emoji">${room.is_private ? '🔒' : '🌐'}</div>
                <div style="flex:1">
                    <div style="font-weight:700;">${room.name}</div>
                    <div style="font-size:0.75rem; color:var(--text-muted);">${room.status === 'playing' ? '游戏中' : '等待中'}</div>
                </div>
                <button class="btn" onclick="Multiplayer.joinRoom('${room.id}', ${!!room.is_private})">加入</button>
            `;
            el.appendChild(d);
        });
    },

    openCreateModal() {
        document.getElementById('roomModal').classList.add('active');
    },

    closeCreateModal() {
        document.getElementById('roomModal').classList.remove('active');
    },

    async confirmCreateRoom() {
        if(!Api.cfg.base || !Api.cfg.key || !Api.cfg.storyModel) {
            alert("请先配置 API Key");
            Api.open();
            return;
        }
        if(!Api.isVerified) {
            alert("创建房间前，请先在 API 设置中通过故事模型的“测试思考”验证模型支持思考模式。");
            Api.open();
            return;
        }
        const name = document.getElementById('roomNameInput').value;
        const password = document.getElementById('roomPassInput').value;
        if (!name) return alert("请输入房间名");

        const { data, error } = await supabaseClient.from('rooms').insert([{
            name,
            password,
            config: Api.cfg,
            status: 'waiting',
            created_at: new Date()
        }]).select('id'); // 仅选择 id，避免因权限问题导致创建失败

        if (error) return alert("创建失败: " + error.message);
        this.closeCreateModal();
        this.roomPassword = password; // 保存新创建房间的密码
        this.joinRoom(data[0].id, password);
    },

    async joinRoom(roomId, passOrHasPass) {
        let pass = ""; 
        if (typeof passOrHasPass === 'string') {
            pass = passOrHasPass;
        } else if (passOrHasPass === true) {
            const p = prompt("请输入房间密码:");
            if (p === null) return; 
            pass = p;
        }

        // 使用新的安全 RPC 函数获取房间数据
        // 只有密码正确，数据库才会返回包含 config (API Key) 的数据
        const { data: rooms, error } = await supabaseClient.rpc('join_room_secure', {
            id_param: roomId,
            pass_param: pass
        });

        if (error || !rooms || rooms.length === 0) {
            return alert("密码错误或无法加入房间");
        }

        const room = rooms[0];
        this.currentRoom = roomId;
        this.roomPassword = pass;
        
        // 清空已处理的消息 ID 集合，准备加载新房间的消息
        this.processedMessageIds.clear();

        // 如果本地没有完整配置，则使用房间的 API 配置
        const hasLocalConfig = Api.cfg.base && Api.cfg.key && Api.cfg.storyModel;
        if (!hasLocalConfig && room.config && room.config.base) {
            Api.cfg = room.config;
            Api.isVerified = true; 
            if (Api.cfg) Api.cfg.isVerified = true; // 房主已验证过，加入者直接标记为已验证
        }

        // 订阅消息
        supabaseClient.channel(`room:${roomId}`)
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `room_id=eq.${roomId}` },
                payload => this.handleNewMessage(payload.new))
            .subscribe();

        // 获取历史消息
        const { data: msgs } = await supabaseClient.from('messages')
            .select('*')
            .eq('room_id', roomId)
            .order('created_at', { ascending: true });

        if (msgs) {
            document.getElementById('chatList').innerHTML = '';
            Game.state.history = [];
            msgs.forEach(m => this.handleNewMessage(m));
        }

        // 如果房间已经在游戏中，加载状态
        if (room.status === 'playing' && room.game_state) {
            Game.state = room.game_state;

            // 初始化游戏 UI
            document.getElementById('gameTitle').innerText = Game.state.puzzle.title;
            document.getElementById('gameTags').innerHTML = Game.state.tags.join(' / ') + ` <span class="diff-badge">${Game.state.diff}</span>`;
            document.getElementById('gamePuzzle').innerText = Game.state.puzzle.puzzle;
            document.getElementById('gamePuzzle').style.display = 'block';
            document.getElementById('gameContainer').className = 'game-container state-active';
            document.getElementById('inputWrapper').style.opacity = '1';

            Game.updateTitleWithEmoji(Game.state.puzzle.title, Game.state.puzzle.emoji || '🎭', true);
            Game.updateStats();

            App.switchPage('page-game');
        } else {
            // 如果是等待中，留在主页进行选词
            this.showRoomSetup(room);
        }
    },

    showRoomSetup(room) {
        App.mode = 'multi';
        document.getElementById('singlePlayerMenu').style.display = 'flex';
        document.getElementById('multiplayerLobby').style.display = 'none';

        // 修改开始按钮文字
        const startBtn = document.querySelector('#singlePlayerMenu .btn.primary');
        startBtn.innerHTML = `<span class="iconify" data-icon="lucide:play"></span> 在房间中开始`;

        // 显示当前房间信息
        let infoEl = document.getElementById('roomInfoBar');
        if (!infoEl) {
            infoEl = document.createElement('div');
            infoEl.id = 'roomInfoBar';
            infoEl.style = 'background:var(--primary); color:white; padding:8px 15px; border-radius:12px; margin-bottom:15px; display:flex; justify-content:space-between; align-items:center; font-size:0.9rem;';
            const menu = document.getElementById('singlePlayerMenu');
            menu.insertBefore(infoEl, menu.firstChild);
        }
        infoEl.innerHTML = `
            <span><span class="iconify" data-icon="lucide:home"></span> 房间: <strong>${room.name}</strong></span>
            <button class="btn" style="padding:2px 8px; font-size:0.75rem; background:rgba(255,255,255,0.2); border:none;" onclick="location.reload()">退出房间</button>
        `;
    },

    async sendMessage(type, content) {
        if (!this.currentRoom) return;
        await supabaseClient.from('messages').insert([{
            room_id: this.currentRoom,
            type,
            content,
            sender: 'user', // 实际应用中可以加入用户名
            created_at: new Date()
        }]);
    },

    handleNewMessage(msg) {
        // 使用消息 ID 进行去重，避免重复显示
        if (msg.id && this.processedMessageIds.has(msg.id)) {
            return;
        }
        if (msg.id) {
            this.processedMessageIds.add(msg.id);
        }

        if (msg.type === 'story_init') {
            const data = JSON.parse(msg.content);
            Game.applyGeneratedPuzzle(data);
        } else if (msg.type === 'chat') {
            const isUser = msg.content.includes('[提问]') || msg.content.includes('[猜谜]');
            const role = isUser ? (msg.content.includes('[提问]') ? 'user-ask' : 'user-guess') : 'ai';
            const isHtml = !isUser && msg.content.trim().startsWith('<div');
            const displayContent = isUser
                ? msg.content.replace(/^\[提问\]\s*/, '').replace(/^\[猜谜\]\s*/, '')
                : msg.content;

            UI.addMsg(role, displayContent, null, isHtml);

            // 同步到本地历史记录
            Game.state.history.push({
                role: isUser ? 'user' : 'assistant',
                content: msg.content
            });
        }
    },

    async syncGameState() {
        // 同步游戏状态到数据库
        if (!this.currentRoom) return;

        // 优化：先获取最新状态进行合并，防止覆盖其他玩家的更新
        const { data: room } = await supabaseClient.from('rooms')
            .select('game_state')
            .eq('id', this.currentRoom)
            .single();

        if (room && room.game_state) {
            const remoteState = room.game_state;
            
            // 合并已找到的要点
            if (remoteState.foundPoints) {
                const mergedPoints = [...new Set([...Game.state.foundPoints, ...remoteState.foundPoints])];
                Game.state.foundPoints = mergedPoints;
            }
            
            // 轮次和提示取最大值
            Game.state.turnsUsed = Math.max(Game.state.turnsUsed, remoteState.turnsUsed || 0);
            Game.state.hintsUsed = Math.max(Game.state.hintsUsed, remoteState.hintsUsed || 0);
            
            // 最高分取最大值
            Game.state.highestScore = Math.max(Game.state.highestScore, remoteState.highestScore || 0);
        }

        let query = supabaseClient.from('rooms').update({
            game_state: Game.state,
            status: Game.state.status === 'completed' ? 'completed' : 'playing'
        }).eq('id', this.currentRoom);

        await query;
    }
};
