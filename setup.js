const fs = require('fs');
const path = require('path');

// 1. PASTE YOUR *NEW* TOKEN HERE
const NEW_TOKEN = "paste_your_new_token_here"; 

const envContent = `LICHESS_TOKEN=${NEW_TOKEN}
SERIAL_PORT=COM3
BAUD_RATE=115200`;

const filePath = path.join(__dirname, '.env');

try {
    fs.writeFileSync(filePath, envContent, { encoding: 'utf8' });
    console.log("✅ SUCCESS: .env file created correctly!");
    console.log("   Location: " + filePath);
    console.log("   Content written:");
    console.log(envContent);
} catch (err) {
    console.error("❌ ERROR writing file:", err);
}