require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const HardwareBridge = require('./hardware');
const LichessClient = require('./lichess');
const GameState = require('./chessLogic');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3000;
const SERIAL_PORT = process.env.SERIAL_PORT || "COM3";
const LICHESS_TOKEN = process.env.LICHESS_TOKEN;

const hardware = new HardwareBridge(SERIAL_PORT, 115200);
const lichess = new LichessClient(LICHESS_TOKEN);
const chessLogic = new GameState();

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Fetch username on startup
lichess.getProfile().then(username => {
    if(!username) console.warn("⚠️ Could not fetch Lichess Username.");
});

// --- HARDWARE EVENTS ---
hardware.on('sensor', async (data) => {
    io.emit('matrix_update', data);
    const result = chessLogic.processSensor(data.square, data.status);
    
    if (result && result.type === 'MOVE') {
        io.emit('log', { msg: `✅ Move: ${result.lan}` });
        chessLogic.updateBoard(result.fen);
        io.emit('boardUpdate', { fen: result.fen, id: chessLogic.currentGameId });
        await lichess.makeMove(chessLogic.currentGameId, result.lan);
    }
});

// --- LICHESS STREAM ---
async function startLichessStream() {
    try {
        const stream = await lichess.streamEvents();
        io.emit('status', { lichess: 'online' });
        stream.on('data', (chunk) => {
            const data = chunk.toString().trim();
            if (!data) return;
            try {
                const event = JSON.parse(data);
                if (event.type === 'gameStart') handleNewGame(event.game.id);
            } catch (e) {}
        });
    } catch (e) { io.emit('status', { lichess: 'offline' }); }
}

async function handleNewGame(gameId) {
    console.log(`⚔️ [Game] Started: ${gameId}`);
    chessLogic.reset(gameId);
    
    const stream = await lichess.streamGame(gameId);
    if (!stream) return;

    // Local state to track players for Draw Logic
    let whiteId = null;
    let blackId = null;

    stream.on('data', (chunk) => {
        const lines = chunk.toString().split('\n');
        lines.forEach(line => {
            if (!line.trim()) return;
            try {
                const update = JSON.parse(line);
                
                // 1. GAME FULL (Initial Load)
                if (update.type === 'gameFull') {
                    whiteId = update.white.id;
                    blackId = update.black.id;

                    const startFen = update.initialFen === 'startpos' ? 
                        'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1' : update.initialFen;
                    chessLogic.game.load(startFen);
                    
                    io.emit('gameFull', {
                        id: gameId,
                        fen: chessLogic.game.fen(),
                        white: update.white,
                        black: update.black,
                        wtime: update.state.wtime,
                        btime: update.state.btime,
                        activeColor: chessLogic.game.turn(),
                        me: lichess.myUsername
                    });
                }
                
                // 2. GAME STATE (Move / End)
                if (update.type === 'gameState') {
                    // --- A. GAME OVER DETECTION ---
                    if (update.status && update.status !== 'started') {
                        console.log(`🏁 Game Over: ${update.status}`);
                        let resultText = "Game Over";
                        if (update.status === 'mate') resultText = "Checkmate";
                        if (update.status === 'resign') resultText = "Resignation";
                        if (update.status === 'draw' || update.status === 'stalemate') resultText = "Draw";
                        if (update.status === 'outoftime') resultText = "Time Out";

                        io.emit('game_over', { result: resultText, winner: update.winner });
                    }

                    // --- B. DRAW OFFER DETECTION ---
                    // Logic: Only alert if the OPPONENT offers (not us)
                    const amIWhite = (lichess.myUsername === whiteId);
                    const opponentOffered = amIWhite ? update.bdraw : update.wdraw;
                    
                    if (opponentOffered) {
                        console.log("🤝 Opponent offered draw");
                        io.emit('draw_offered');
                    }

                    // --- C. MOVE UPDATES ---
                    const moves = update.moves.split(' ');
                    const lastMove = moves[moves.length - 1];
                    chessLogic.game.move(lastMove);
                    
                    io.emit('boardUpdate', { 
                        fen: chessLogic.game.fen(), 
                        wtime: update.wtime,
                        btime: update.btime,
                        activeColor: chessLogic.game.turn()
                    });
                }
            } catch(e) {}
        });
    });
}

// --- API ---
app.post('/api/challenge', async (req, res) => {
    const result = await lichess.createChallenge(req.body.username, req.body.time);
    res.json(result);
});

// --- SOCKETS ---
io.on('connection', (socket) => {
    socket.on('simulate_sensor', (d) => hardware.emit('sensor', d));
    socket.on('manual_move', async (m) => {
        if (chessLogic.currentGameId) await lichess.makeMove(chessLogic.currentGameId, m);
    });
    
    // Actions
    socket.on('resign', async () => {
        if (chessLogic.currentGameId) await lichess.resignGame(chessLogic.currentGameId);
    });
    socket.on('offer_draw', async () => {
        if (chessLogic.currentGameId) await lichess.offerDraw(chessLogic.currentGameId);
    });
    socket.on('accept_draw', async () => {
        if (chessLogic.currentGameId) await lichess.offerDraw(chessLogic.currentGameId); // "Yes" to draw
    });
});

server.listen(PORT, () => {
    console.log(`🚀 WARDOM SYSTEM ONLINE: http://localhost:${PORT}`);
    startLichessStream();
});