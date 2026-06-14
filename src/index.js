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
const SERIAL_PORT = process.env.SERIAL_PORT || "COM12";
const LICHESS_TOKEN = process.env.LICHESS_TOKEN;

// Matched to Arduino Serial.begin(9600)
const hardware = new HardwareBridge(SERIAL_PORT, 9600); 
const lichess = new LichessClient(LICHESS_TOKEN);
const chessLogic = new GameState();

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Fetch username on startup
lichess.getProfile().then(username => {
    if(!username) console.warn("⚠️ Could not fetch Lichess Username.");
});

// --- HARDWARE EVENTS (Future Reed Switches) ---
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

    let whiteId = null;
    let blackId = null;
    let amIWhite = false;
    
    // THE BUG FIX: Track exactly how many moves we've executed so we don't spam the Arduino
    let processedMoveCount = 0; 

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
                    amIWhite = (lichess.myUsername === whiteId);

                    const startFen = update.initialFen === 'startpos' ? 
                        'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1' : update.initialFen;
                    chessLogic.game.load(startFen);
                    
                    // If we rejoin a game in progress, sync the tracker so it doesn't try to replay all past moves at once
                    if (update.state && update.state.moves) {
                        const initialMoves = update.state.moves.split(' ');
                        processedMoveCount = initialMoves[0] === "" ? 0 : initialMoves.length;
                    }
                    
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
                
                // 2. GAME STATE (Move / End / Clock Tick)
                if (update.type === 'gameState') {
                    if (update.status && update.status !== 'started') {
                        console.log(`🏁 Game Over: ${update.status}`);
                        let resultText = "Game Over";
                        if (update.status === 'mate') resultText = "Checkmate";
                        if (update.status === 'resign') resultText = "Resignation";
                        if (update.status === 'draw' || update.status === 'stalemate') resultText = "Draw";
                        if (update.status === 'outoftime') resultText = "Time Out";

                        io.emit('game_over', { result: resultText, winner: update.winner });
                    }

                    const opponentOffered = amIWhite ? update.bdraw : update.wdraw;
                    if (opponentOffered) {
                        console.log("🤝 Opponent offered draw");
                        io.emit('draw_offered');
                    }

                    if (update.moves) {
                        const moves = update.moves.split(' ');
                        
                        // THE FIX: Only fire if the move list is longer than what we already processed!
                        if (moves.length > processedMoveCount) {
                            const lastMove = moves[moves.length - 1]; 
                            
                            // Update internal game logic
                            chessLogic.game.move(lastMove);
                            
                            // FORMAT THE STRING: "d2d4" -> "d2 d4"
                            const formattedMove = `${lastMove.substring(0, 2)} ${lastMove.substring(2, 4)}`;
                            console.log(`🤖 Executing Physical Move: ${lastMove}. Transmitting to Arduino as: [${formattedMove}]`);
                            
                            // Send to hardware bridge (Fires for BOTH White and Black moves now)
                            hardware.write(`${formattedMove}\n`);

                            // Update the tracker so we don't send it again
                            processedMoveCount = moves.length;
                        }

                        // Update the Website UI
                        io.emit('boardUpdate', { 
                            fen: chessLogic.game.fen(), 
                            wtime: update.wtime,
                            btime: update.btime,
                            activeColor: chessLogic.game.turn()
                        });
                    }
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
        if (chessLogic.currentGameId) {
            await lichess.makeMove(chessLogic.currentGameId, m);
        }
    });
    
    socket.on('resign', async () => {
        if (chessLogic.currentGameId) await lichess.resignGame(chessLogic.currentGameId);
    });
    socket.on('offer_draw', async () => {
        if (chessLogic.currentGameId) await lichess.offerDraw(chessLogic.currentGameId);
    });
    socket.on('accept_draw', async () => {
        if (chessLogic.currentGameId) await lichess.offerDraw(chessLogic.currentGameId);
    });
});

server.listen(PORT, () => {
    console.log(`🚀 WARDOM SYSTEM ONLINE: http://localhost:${PORT}`);
    startLichessStream();
});