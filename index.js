require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const { Chess } = require('chess.js');

// --- SETUP SERVER ---
// --- SETUP SERVER ---
const path = require('path'); // Add this line
const app = express();
const server = http.createServer(app);
const io = new Server(server);

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

// --- HELPER: SEND LOGS TO UI ---
function systemLog(message) {
    console.log(message); // Keep terminal log
    io.emit('log', { msg: message }); // Send to Browser
}

// =========================================================
//  MODULE 1: ARDUINO COMMUNICATION
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
        
        parser.on('data', (data) => systemLog(`🤖 ROBOT: ${data.toString().trim()}`));
        
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
                        
                        // Update UI Board
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
    } else {
        // Just log to simulation
        // systemLog(`   (SIM) -> ${cmd}`); // Optional: Comment out to keep logs clean
    }
}

// START SERVER
server.listen(3000, () => {
    console.log('-------------------------------------------');
    console.log('🚀 UI SERVER STARTED: http://localhost:3000');
    console.log('-------------------------------------------');
    connectArduino();
    streamLichessEvents();
});