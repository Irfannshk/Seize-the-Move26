const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const EventEmitter = require('events');

class HardwareBridge extends EventEmitter {
    constructor(portPath, baudRate) {
        super();
        this.portPath = portPath;
        this.baudRate = baudRate;
        this.port = null;
        this.init();
    }

    init() {
        console.log(`🔌 [Hardware] Attempting connection on ${this.portPath}...`);
        
        try {
            // Initialize connection to ESP32
            this.port = new SerialPort({ path: this.portPath, baudRate: this.baudRate });
            const parser = this.port.pipe(new ReadlineParser({ delimiter: '\n' }));

            this.port.on('open', () => {
                console.log('✅ [Hardware] Serial Link Established');
                this.emit('status', 'online');
            });

            // Listen for data from the microcontroller
            parser.on('data', (data) => {
                const line = data.toString().trim();
                
                // We only care about MATRIX events (Sensor data)
                // Format expected: MATRIX:e2:1 (Square:Status)
                if (line.startsWith('MATRIX:')) {
                    const parts = line.split(':');
                    this.emit('sensor', { 
                        square: parts[1].toLowerCase(), 
                        status: parts[2] // "1" = Place, "0" = Lift
                    });
                } else {
                    // Log other messages (like debug info from ESP32)
                    this.emit('log', `🤖 Robot: ${line}`);
                }
            });

            this.port.on('error', (err) => {
                console.error(`⚠️ [Hardware] Connection Error: ${err.message}`);
                this.emit('status', 'offline');
            });

        } catch (err) {
            // Fallback for when the board isn't plugged in
            console.warn('⚠️ [Hardware] Port not found. Starting in SIMULATION MODE.');
            this.emit('status', 'sim');
        }
    }

    // Future-proofing: Function to send G-Code to robot
    sendCommand(cmd) {
        if (this.port && this.port.isOpen) {
            this.port.write(cmd + '\n');
        }
    }
}

module.exports = HardwareBridge;