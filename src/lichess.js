const axios = require('axios');

class LichessClient {
    constructor(token) {
        this.token = token;
        this.baseURL = 'https://lichess.org/api';
        this.headers = { 'Authorization': `Bearer ${token}` };
        this.myUsername = null;
    }

    async getProfile() {
        try {
            const res = await axios.get(`${this.baseURL}/account`, { headers: this.headers });
            this.myUsername = res.data.id; // Store our username
            console.log(`👤 [Lichess] Logged in as: ${this.myUsername}`);
            return this.myUsername;
        } catch (e) { console.error("⚠️ Failed to fetch profile"); return null; }
    }

    async streamEvents() {
        try {
            const res = await axios.get(`${this.baseURL}/stream/event`, {
                headers: this.headers,
                responseType: 'stream'
            });
            return res.data;
        } catch (error) { throw new Error(`Stream Connection Failed: ${error.message}`); }
    }

    async streamGame(gameId) {
        try {
            const res = await axios.get(`${this.baseURL}/board/game/stream/${gameId}`, {
                headers: this.headers,
                responseType: 'stream'
            });
            return res.data;
        } catch (error) { return null; }
    }

    async makeMove(gameId, move) {
        try {
            await axios.post(`${this.baseURL}/board/game/${gameId}/move/${move}`, {}, { headers: this.headers });
            return true;
        } catch (error) { return false; }
    }

    async createChallenge(username, timeLimit) {
        try {
            const res = await axios.post(`${this.baseURL}/challenge/${username}`, 
                { clock: { limit: parseInt(timeLimit), increment: 0 }, color: 'random', variant: 'standard' }, 
                { headers: this.headers }
            );
            return { success: true, id: res.data.id };
        } catch (error) { return { success: false, error: error.message }; }
    }

    // [NEW] Resign & Draw
    async resignGame(gameId) {
        try {
            await axios.post(`${this.baseURL}/board/game/${gameId}/resign`, {}, { headers: this.headers });
            return true;
        } catch (e) { return false; }
    }

    async offerDraw(gameId) {
        try {
            await axios.post(`${this.baseURL}/board/game/${gameId}/draw/yes`, {}, { headers: this.headers });
            return true;
        } catch (e) { return false; }
    }
}

module.exports = LichessClient;