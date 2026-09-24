const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

// ===============================
// HEALTH CHECK
// ===============================

app.get("/", (req, res) => {
  res.json({
    status: "online",
    name: "Solana Early Launch Analyzer"
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString()
  });
});

// ===============================
// TELEGRAM ALERT
// ===============================

async function sendTelegram(message) {
  await axios.post(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      chat_id: TELEGRAM_CHAT_ID,
      text: message
    }
  );
}

// ===============================
// TELEGRAM TEST
// ===============================

app.get("/test-telegram", async (req, res) => {
  try {
    await sendTelegram(
      "🚨 SOLANA EARLY LAUNCH ANALYZER\n\n" +
      "Telegram Connection: ✅\n" +
      "Backend: ✅\n" +
      "Status: LIVE\n\n" +
      "Next: Solana scanner connected."
    );

    res.json({
      success: true,
      message: "Telegram test alert sent successfully"
    });

  } catch (error) {
    console.error(error.response?.data || error.message);

    res.status(500).json({
      success: false,
      message: "Telegram alert failed",
      telegram_error: error.response?.data || error.message
    });
  }
});

// ===============================
// HELIUS WEBHOOK
// ===============================

app.post("/webhook/helius", async (req, res) => {
  try {
    const events = Array.isArray(req.body)
      ? req.body
      : [req.body];

    for (const event of events) {

      const tokenTransfers = event.tokenTransfers || [];

      if (tokenTransfers.length === 0) {
        continue;
      }

      const mint = tokenTransfers[0].mint;

      if (!mint) {
        continue;
      }

      const message =
        "🚨 NEW SOLANA TOKEN DETECTED\n\n" +
        `Mint: ${mint}\n\n` +
        "🔍 Status: Waiting for market analysis...\n" +
        "⏳ Next: MC / Liquidity / Holders / Volume / Security";

      await sendTelegram(message);

      console.log("New token detected:", mint);
    }

    res.status(200).json({
      success: true
    });

  } catch (error) {

    console.error(
      "Helius webhook error:",
      error.response?.data || error.message
    );

    res.status(500).json({
      success: false
    });
  }
});

// ===============================
// SERVER
// ===============================

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
