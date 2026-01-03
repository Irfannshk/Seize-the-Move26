require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const { Chess } = require('chess.js');
const path = require('path');

// --- SETUP SERVER ---
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// [NEW] Middleware for JSON (Required for Challenge API)
app.use(express.json());

// FORCE CORRECT PATH
const publicPath = path.join(__dirname, 'public');
console.log(`📂 Serving UI from: ${publicPath}`);
app.use(express.static(publicPath));

// Fallback: If index.html isn't found, tell us why
app.get('/', (req, res) => {
    res.send(`<h1>Error: Frontend not found</h1><p>Expected file at: ${publicPath}/index.html</p>`);
});

// --- CONFIGURATION ---
const TOKEN = process.env.LICHESS_TOKEN;
const PORT_NAME = process.env.SERIAL_PORT;
const BAUD_RATE = parseInt(process.env.BAUD_RATE) || 115200;

// --- ROBOT CONSTANTS ---
const STEPS_PER_SQUARE = 200; 
const HALF_SQUARE = STEPS_PER_SQUARE / 2;
const MARGIN_X = 50;          
const MARGIN_Y = 50;          
const BOARD_WIDTH_STEPS = 8 * STEPS_PER_SQUARE; 
const LEFT_GUTTER_X = 10;                
const RIGHT_GUTTER_X = BOARD_WIDTH_STEPS + 50; 

// --- GLOBAL STATE ---
const gameLogic = new Chess(); 
let arduinoPort = null;
let currentGameId = null;
let pendingMove = { from: null, to: null }; // [NEW] For detecting physical moves

// --- HELPER: SEND LOGS TO UI ---
function systemLog(message) {
    console.log(message); // Keep terminal log
    io.emit('log', { msg: message }); // Send to Browser
}

// =========================================================
//  MODULE 1: ARDUINO COMMUNICATION (UPDATED)
// =========================================================
function connectArduino() {
    systemLog(`🔌 FYP2026: Connecting to Arduino on ${PORT_NAME}...`);
    try {
        arduinoPort = new SerialPort({ path: PORT_NAME, baudRate: BAUD_RATE });
        const parser = arduinoPort.pipe(new ReadlineParser({ delimiter: '\n' }));

        arduinoPort.on('open', () => {
            systemLog("✅ ARDUINO CONNECTED! Ready.");
            io.emit('status', { arduino: 'online' });
        });
        
        // [UPDATED] Listen for MATRIX events from hardware
        parser.on('data', (data) => {
            const line = data.toString().trim();
            
            // 1. SENSOR UPDATE (e.g., "MATRIX:e2:0")
            if (line.startsWith('MATRIX:')) {
                const parts = line.split(':');
                const square = parts[1].toLowerCase();
                const status = parts[2]; // "1"=Place, "0"=Lift
                
                // Update UI Visuals
                io.emit('matrix_update', { square, status });
                
                // Run Logic
                detectChessMove(square, status);
            } 
            // 2. ROBOT STATUS
            else {
                systemLog(`🤖 ROBOT: ${line}`);
            }
        });
        
        arduinoPort.on('error', (err) => {
            systemLog(`⚠️ Arduino Error: ${err.message}`);
            io.emit('status', { arduino: 'offline' });
        });

    } catch (err) {
        systemLog("⚠️ Arduino not found. RUNNING IN SIMULATION MODE.");
        io.emit('status', { arduino: 'sim' });
    }
}

// =========================================================
//  [NEW] MODULE 1.5: SENSOR LOGIC (THE DETECTIVE)
// =========================================================
function detectChessMove(square, status) {
    // A. PIECE LIFTED (Source)
    if (status === "0") {
        const piece = gameLogic.get(square);
        // Only if piece exists and belongs to active player
        if (piece && piece.color === gameLogic.turn()) {
            pendingMove.from = square;
            systemLog(`🔍 Source Detected: ${square}`);
        }
    }

    // B. PIECE PLACED (Destination)
    else if (status === "1") {
        if (pendingMove.from) {
            pendingMove.to = square;
            
            // Validate Logic Locally First
            const tempGame = new Chess(gameLogic.fen());
            try {
                const moveResult = tempGame.move({ from: pendingMove.from, to: pendingMove.to, promotion: 'q' });
                
                if (moveResult) {
                    systemLog(`✅ Valid Move: ${pendingMove.from}${pendingMove.to}`);
                    sendMoveToLichess(moveResult.lan);
                    pendingMove = { from: null, to: null }; // Reset
                } else {
                    systemLog(`❌ Illegal: ${pendingMove.from} -> ${pendingMove.to}`);
                }
            } catch (e) { }
        }
    }
}

async function sendMoveToLichess(moveLan) {
    if (!currentGameId) return;
    try {
        await axios.post(
            `https://lichess.org/api/board/game/${currentGameId}/move/${moveLan}`,
            {},
            { headers: { Authorization: `Bearer ${TOKEN}` } }
        );
        systemLog("🚀 Sent to Lichess!");
    } catch (err) {
        systemLog(`❌ Lichess Rejected: ${err.message}`);
    }
}

// =========================================================
//  MODULE 2: LICHESS STREAM
// =========================================================
async function streamLichessEvents() {
    systemLog("☁️  Listening for challenges...");
    try {
        const res = await axios.get('https://lichess.org/api/stream/event', {
            headers: { 'Authorization': `Bearer ${TOKEN}` },
            responseType: 'stream'
        });
        
        io.emit('status', { lichess: 'online' });

        res.data.on('data', (chunk) => {
            const data = chunk.toString().trim();
            if (!data) return;
            try {
                const event = JSON.parse(data);
                if (event.type === 'gameStart') {
                    systemLog(`⚔️ GAME STARTED! ID: ${event.game.id}`);
                    streamGameMoves(event.game.id);
                }
            } catch (e) {}
        });
    } catch (err) { 
        systemLog(`❌ Lichess Error: ${err.message}`); 
        io.emit('status', { lichess: 'offline' });
    }
}

async function streamGameMoves(gameId) {
    if (currentGameId === gameId) return; 
    currentGameId = gameId;
    gameLogic.reset(); 
    
    systemLog(`👀 WATCHING GAME ${gameId}...`);

    try {
        const res = await axios.get(`https://lichess.org/api/board/game/stream/${gameId}`, {
            headers: { 'Authorization': `Bearer ${TOKEN}` },
            responseType: 'stream'
        });

        res.data.on('data', (chunk) => {
            const lines = chunk.toString().split('\n');
            lines.forEach(line => {
                if (!line.trim()) return;
                try {
                    const update = JSON.parse(line);
                    
                    if (update.type === 'gameFull') {
                        systemLog(`⚪ ${update.white.name} vs ⚫ ${update.black.name}`);
                        const moves = update.state.moves.split(' ');
                        moves.forEach(m => { if(m) gameLogic.move(m); });
                        
                        io.emit('boardUpdate', { 
                            fen: gameLogic.fen(), 
                            id: gameId, 
                            white: update.white.name, 
                            black: update.black.name 
                        });
                    }

                    if (update.type === 'gameState') {
                        const moves = update.moves.split(' ');
                        const lastMove = moves[moves.length - 1];
                        const moveResult = gameLogic.move(lastMove); 
                        
                        if (moveResult) {
                            systemLog(`♟️ MOVE: ${lastMove} (${moveResult.color})`);
                            io.emit('boardUpdate', { fen: gameLogic.fen(), id: gameId }); // Sync UI
                            sendToRobot(moveResult); 
                        }
                    }
                } catch (e) {}
            });
        });

    } catch (err) { systemLog("❌ Game Stream Error"); }
}

// =========================================================
//  MODULE 3: ROBOT PATHFINDER
// =========================================================
function getSquareCoordinates(square) {
    const file = square.charCodeAt(0) - 97; 
    const rank = parseInt(square[1]) - 1;   
    return { 
        x: MARGIN_X + (file * STEPS_PER_SQUARE), 
        y: MARGIN_Y + (rank * STEPS_PER_SQUARE),
        file: file
    };
}

function sendToRobot(moveResult) {
    const fromSq = moveResult.from;
    const toSq = moveResult.to;
    const isCapture = moveResult.captured;

    systemLog(`🤖 PLAN: ${fromSq} -> ${toSq}`);

    if (isCapture) {
        systemLog(`   ⚔️ Removing victim at ${toSq}`);
        const victim = getSquareCoordinates(toSq);
        logCommand(`M${victim.x},${victim.y}`); 
        logCommand(`MAG:ON`);
        const streetX = victim.x + HALF_SQUARE;
        const streetY = victim.y + HALF_SQUARE;
        logCommand(`M${streetX},${streetY}`);
        const dumpX = (victim.file < 4) ? LEFT_GUTTER_X : RIGHT_GUTTER_X;
        logCommand(`M${dumpX},${streetY}`);
        logCommand(`MAG:OFF`);
    }

    const start = getSquareCoordinates(fromSq);
    const end = getSquareCoordinates(toSq);
    
    logCommand(`M${start.x},${start.y}`);
    logCommand(`MAG:ON`);
    const streetStartX = start.x + HALF_SQUARE;
    const streetStartY = start.y + HALF_SQUARE;
    logCommand(`M${streetStartX},${streetStartY}`);
    const streetEndX = end.x + HALF_SQUARE;
    const streetEndY = end.y + HALF_SQUARE;
    if (streetStartX !== streetEndX) logCommand(`M${streetEndX},${streetStartY}`);
    if (streetStartY !== streetEndY) logCommand(`M${streetEndX},${streetEndY}`);
    logCommand(`M${end.x},${end.y}`);
    logCommand(`MAG:OFF`);
}

function logCommand(cmd) {
    if (arduinoPort && arduinoPort.isOpen) {
        arduinoPort.write(cmd + '\n');
    }
}

// =========================================================
//  [NEW] MODULE 4: API & DASHBOARD CONTROLS
// =========================================================

// A. Challenge API
app.post('/api/challenge', async (req, res) => {
    const { username, time } = req.body;
    systemLog(`🔥 Sending Challenge to: ${username}`);
    
    try {
        const response = await axios.post(
            `https://lichess.org/api/challenge/${username}`, 
            { 
                clock: { limit: parseInt(time), increment: 0 },
                color: 'random',
                variant: 'standard'
            },
            { headers: { Authorization: `Bearer ${TOKEN}` } }
        );
        systemLog(`✅ Challenge Sent! ID: ${response.data.id}`);
        res.json({ success: true, gameId: response.data.id });
    } catch (error) {
        const errData = error.response?.data?.error || error.message;
        systemLog(`❌ Challenge Failed: ${errData}`);
        res.json({ success: false, error: errData });
    }
});

// B. Socket Listeners for Dashboard
io.on('connection', (socket) => {
    // 1. Manual Override
    socket.on('manual_move', async (moveString) => {
        if (!currentGameId) { systemLog("⚠️ No active game!"); return; }
        systemLog(`⚠️ FORCE MOVE: ${moveString}`);
        try {
            await axios.post(
                `https://lichess.org/api/board/game/${currentGameId}/move/${moveString}`,
                {},
                { headers: { Authorization: `Bearer ${TOKEN}` } }
            );
        } catch (err) { systemLog(`❌ Override Error: ${err.message}`); }
    });

    // 2. Sensor Simulator
    socket.on('simulate_sensor', (data) => {
        const { square, status } = data;
        systemLog(`🖱️ VIRTUAL SENSOR: ${square} -> ${status==="1"?"ON":"OFF"}`);
        io.emit('matrix_update', { square, status }); // Update Visuals
        detectChessMove(square, status); // Run Logic
    });
});

// START SERVER
server.listen(3000, () => {
    console.log('-------------------------------------------');
    console.log('🚀 UI SERVER STARTED: http://localhost:3000');
    console.log('-------------------------------------------');
    connectArduino();
    streamLichessEvents();
});