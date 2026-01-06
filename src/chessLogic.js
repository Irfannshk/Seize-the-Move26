const { Chess } = require('chess.js');

class GameState {
    constructor() {
        this.game = new Chess();
        this.pendingMove = { from: null, to: null };
        this.currentGameId = null;
    }

    // Called when a new Lichess game starts
    reset(gameId) {
        this.game.reset();
        this.currentGameId = gameId;
        this.pendingMove = { from: null, to: null };
        console.log(`♟️ [Logic] New Game Initialized: ${gameId}`);
    }

    // Syncs our internal board with Lichess (e.g., after opponent moves)
    updateBoard(fen) {
        this.game.load(fen);
    }

    // The "Detective" Logic: Translates Physical Sensors -> Chess Moves
    processSensor(square, status) {
        // CASE A: User Lifts a Piece (Status "0")
        if (status === "0") {
            const piece = this.game.get(square);
            
            // Logic: You can only move your own pieces!
            if (piece && piece.color === this.game.turn()) {
                this.pendingMove.from = square;
                return { type: 'LIFT', square };
            }
        }
        
        // CASE B: User Places a Piece (Status "1")
        else if (status === "1") {
            // We only care about placing if we are already holding a piece (pendingMove.from)
            if (this.pendingMove.from) {
                this.pendingMove.to = square;
                
                // Validate the move using a temporary board state
                // We don't want to break the real game state if the move is illegal
                const tempGame = new Chess(this.game.fen());
                try {
                    const move = tempGame.move({ 
                        from: this.pendingMove.from, 
                        to: this.pendingMove.to, 
                        promotion: 'q' // Auto-promote to Queen for now (MVP feature)
                    });

                    if (move) {
                        // It's a legal move! Return the details so we can send it to Lichess
                        const moveLAN = move.lan; 
                        this.pendingMove = { from: null, to: null }; // Reset state
                        return { type: 'MOVE', lan: moveLAN, fen: tempGame.fen() };
                    }
                } catch (e) {
                    // Move was illegal (e.g., placing knight on top of own pawn). Ignore it.
                }
            }
        }
        return null; // No significant event happened
    }
}

module.exports = GameState;