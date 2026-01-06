const socket = io();

const client = {
    board: null,
    virtualSensors: {},
    gameActive: false,
    timers: { white: 0, black: 0 },
    activeColor: 'w',
    clockInterval: null,

    init: function() {
        this.board = Chessboard('myBoard', {
            position: 'start',
            pieceTheme: 'https://chessboardjs.com/img/chesspieces/wikipedia/{piece}.png'
        });
        this.buildGrid();
        this.setupSockets();
        this.clockInterval = setInterval(() => this.tickClock(), 1000);
    },

    // --- ACTIONS ---
    sendChallenge: function() {
        const user = document.getElementById('username').value || 'stockfish';
        const time = document.getElementById('timeControl').value;
        fetch('/api/challenge', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ username: user, time: time })
        });
    },

    resign: function() { if(confirm("Resign?")) socket.emit('resign'); },
    offerDraw: function() { socket.emit('offer_draw'); },
    manualMove: function() {
        const move = document.getElementById('manualMove').value;
        if(move) { socket.emit('manual_move', move); document.getElementById('manualMove').value = ''; }
    },

    // --- ALERTS ---
    showAlert: function(msg, btnText = null, btnAction = null) {
        const el = document.getElementById('game-alert');
        document.getElementById('alert-msg').innerText = msg;
        el.style.display = 'block';
        
        const btn = document.getElementById('alert-btn');
        if(btnText) {
            btn.style.display = 'inline-block';
            btn.innerText = btnText;
            btn.onclick = () => {
                btnAction();
                el.style.display = 'none';
            };
        } else {
            btn.style.display = 'none';
        }
    },

    // --- CLOCKS ---
    updateClocks: function(wtime, btime, activeColor) {
        this.timers.white = wtime;
        this.timers.black = btime;
        this.activeColor = activeColor;
        this.renderClocks();
    },

    tickClock: function() {
        if (!this.gameActive) return;
        if (this.activeColor === 'w') this.timers.white -= 1000;
        else this.timers.black -= 1000;
        this.renderClocks();
    },

    renderClocks: function() {
        const fmt = (ms) => {
            if (ms < 0) ms = 0;
            const m = Math.floor(ms / 60000);
            const s = Math.floor((ms % 60000) / 1000);
            return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
        };
        const wEl = document.getElementById('clock-white');
        const bEl = document.getElementById('clock-black');
        wEl.innerText = fmt(this.timers.white);
        bEl.innerText = fmt(this.timers.black);
        
        if (this.activeColor === 'w') {
            wEl.classList.add('clock-active'); bEl.classList.remove('clock-active');
        } else {
            bEl.classList.add('clock-active'); wEl.classList.remove('clock-active');
        }
    },

    // --- GRID ---
    buildGrid: function() {
        const grid = document.getElementById('sensor-grid');
        const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
        for (let r = 8; r >= 1; r--) {
            for (let f = 0; f < 8; f++) {
                const sq = files[f] + r;
                const btn = document.createElement('div');
                btn.className = 'sensor-btn'; // Uses CSS from previous style or style.css
                btn.style.background = '#333'; btn.style.border = '1px solid #444'; btn.style.aspectRatio = '1';
                btn.onclick = () => {
                    const isActive = !this.virtualSensors[sq];
                    this.virtualSensors[sq] = isActive;
                    btn.style.background = isActive ? '#c5a059' : '#333';
                    socket.emit('simulate_sensor', { square: sq, status: isActive ? "1" : "0" });
                };
                grid.appendChild(btn);
            }
        }
    },

    // --- SOCKETS ---
    setupSockets: function() {
        socket.on('log', (d) => {
            const win = document.getElementById('log-window');
            const div = document.createElement('div');
            div.className = 'log-entry';
            div.innerText = `> ${d.msg}`;
            win.appendChild(div);
            win.scrollTop = win.scrollHeight;
        });

        socket.on('status', (d) => {
            if (d.lichess) document.getElementById('lichess-status').className = `dot ${d.lichess}`;
            if (d.arduino) document.getElementById('arduino-status').className = `dot ${d.arduino}`;
        });

        socket.on('gameFull', (d) => {
            this.gameActive = true;
            this.board.position(d.fen);
            if (d.black.id === d.me) this.board.orientation('black');
            else this.board.orientation('white');
            this.updateClocks(d.wtime, d.btime, d.activeColor);
            document.getElementById('player-names').innerText = `${d.white.name || 'Opponent'} vs ${d.black.name || 'Opponent'}`;
        });

        socket.on('boardUpdate', (d) => {
            this.board.position(d.fen);
            if (d.wtime) this.updateClocks(d.wtime, d.btime, d.activeColor);
        });

        socket.on('game_over', (d) => {
            this.gameActive = false;
            this.showAlert(`${d.result} - Winner: ${d.winner || 'None'}`);
        });

        socket.on('draw_offered', () => {
            this.showAlert("Opponent offered a draw.", "Accept", () => {
                socket.emit('accept_draw');
            });
        });
    }
};

client.init();