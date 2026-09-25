const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

// Prevent the same mint from alerting repeatedly
const seenMints = new Map();
const DUPLICATE_WINDOW = 15 * 60 * 1000; // 15 minutes


// ===============================
// BASIC ROUTES
// ===============================

app.get("/", (req, res) => {
  res.json({
    status: "online",
    name: "Solana Early Launch Analyzer",
    version: "2.0"
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString()
  });
});


// ===============================
// TELEGRAM
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
// HELIUS GET ASSET
// ===============================

async function getHeliusAsset(mint) {
  const url =
    `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

  const response = await axios.post(url, {
    jsonrpc: "2.0",
    id: "1",
    method: "getAsset",
    params: {
      id: mint,
      displayOptions: {
        showFungible: true
      }
    }
  });

  return response.data.result;
}


// ===============================
// MINT SECURITY
// ===============================

async function getMintSecurity(mint) {
  try {
    const url =
      `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

    const response = await axios.post(url, {
      jsonrpc: "2.0",
      id: "1",
      method: "getAccountInfo",
      params: [
        mint,
        {
          encoding: "jsonParsed"
        }
      ]
    });

    const value = response.data.result?.value;

    if (!value?.data?.parsed?.info) {
      return {
        mintAuthority: "UNKNOWN",
        freezeAuthority: "UNKNOWN"
      };
    }

    const info = value.data.parsed.info;

    return {
      mintAuthority: info.mintAuthority ? "ACTIVE" : "REVOKED",
      freezeAuthority: info.freezeAuthority ? "ACTIVE" : "REVOKED"
    };

  } catch (error) {
    console.error(
      "Security check error:",
      error.response?.data || error.message
    );

    return {
      mintAuthority: "UNKNOWN",
      freezeAuthority: "UNKNOWN"
    };
  }
}


// ===============================
// DEXSCREENER MARKET DATA
// ===============================

async function getDexData(mint) {
  const url =
    `https://api.dexscreener.com/token-pairs/v1/solana/${mint}`;

  const response = await axios.get(url);

  const pairs = Array.isArray(response.data)
    ? response.data
    : [];

  if (!pairs.length) {
    return null;
  }

  // Remove pools with no usable liquidity
  const validPairs = pairs.filter(pair => {
    const liquidity = Number(pair.liquidity?.usd || 0);
    return liquidity > 0;
  });

  if (!validPairs.length) {
    console.log("No pool with valid liquidity:", mint);
    return null;
  }

  // Choose the pool with the highest real liquidity
  validPairs.sort((a, b) => {
    const liquidityA =
      Number(a.liquidity?.usd || 0);

    const liquidityB =
      Number(b.liquidity?.usd || 0);

    return liquidityB - liquidityA;
  });

  const bestPair = validPairs[0];

  console.log("Selected pool:", {
    dex: bestPair.dexId,
    pair: bestPair.pairAddress,
    liquidity: bestPair.liquidity?.usd
  });

  return bestPair;
}
  const url =
    `https://api.dexscreener.com/token-pairs/v1/solana/${mint}`;

  const response = await axios.get(url);

  const pairs = response.data || [];

  if (!pairs.length) {
    return null;
  }

  // Choose the pool with the highest liquidity
  pairs.sort((a, b) => {
    const liqA = Number(a.liquidity?.usd || 0);
    const liqB = Number(b.liquidity?.usd || 0);

    return liqB - liqA;
  });

  return pairs[0];
}


// ===============================
// ANALYSIS ENGINE
// ===============================

async function analyzeToken(mint) {

  const [asset, dex, security] = await Promise.all([
    getHeliusAsset(mint),
    getDexData(mint),
    getMintSecurity(mint)
  ]);

  if (!dex) {
    return {
      found: false,
      reason: "No DEX liquidity/pair found"
    };
  }

  const marketCap =
    Number(dex.marketCap || dex.fdv || 0);

  const liquidity =
    Number(dex.liquidity?.usd || 0);

  const volume24h =
    Number(dex.volume?.h24 || 0);

  const buys24h =
    Number(dex.txns?.h24?.buys || 0);

  const sells24h =
    Number(dex.txns?.h24?.sells || 0);

  const totalTxns =
    buys24h + sells24h;

  const buySellRatio =
    sells24h > 0
      ? buys24h / sells24h
      : buys24h;

  const volumeMc =
    marketCap > 0
      ? (volume24h / marketCap) * 100
      : 0;

  const pairCreatedAt =
    dex.pairCreatedAt
      ? Number(dex.pairCreatedAt)
      : null;

  let ageMinutes = null;

  if (pairCreatedAt) {
    ageMinutes =
      (Date.now() - pairCreatedAt) / 60000;
  }

  // ===============================
  // CORE CONDITIONS
  // ===============================

  const earlyLaunch =
    ageMinutes !== null &&
    ageMinutes <= 30;

  const mcInRange =
    marketCap >= 5000 &&
    marketCap <= 10000;

  const liquidityHealthy =
    liquidity > 0 &&
    liquidity <= marketCap;

  const strongVolume =
    volumeMc >= 50;

  const buyPressure =
    buys24h > sells24h;

  // ===============================
  // SCORE
  // ===============================

  let score = 0;

  if (earlyLaunch) score += 20;
  if (mcInRange) score += 20;
  if (liquidityHealthy) score += 15;
  if (strongVolume) score += 20;
  if (buyPressure) score += 15;
  if (security.freezeAuthority === "REVOKED") score += 5;
  if (security.mintAuthority === "REVOKED") score += 5;

  score = Math.min(score, 100);

  // ===============================
  // TOKEN INFO
  // ===============================

  const tokenName =
    asset?.content?.metadata?.name ||
    dex.baseToken?.name ||
    "Unknown Token";

  const symbol =
    asset?.content?.metadata?.symbol ||
    dex.baseToken?.symbol ||
    "UNKNOWN";

  return {
    found: true,

    mint,

    name: tokenName,
    symbol,

    ageMinutes,

    marketCap,
    liquidity,
    volume24h,
    volumeMc,

    buys24h,
    sells24h,
    buySellRatio,

    mintAuthority: security.mintAuthority,
    freezeAuthority: security.freezeAuthority,

    dex: dex.dexId || "Unknown",
    pairAddress: dex.pairAddress || "Unknown",

    score,

    conditions: {
      earlyLaunch,
      mcInRange,
      liquidityHealthy,
      strongVolume,
      buyPressure
    }
  };
}


// ===============================
// FORMAT TELEGRAM ALERT
// ===============================

function formatAlert(data) {

  const age =
    data.ageMinutes !== null
      ? `${data.ageMinutes.toFixed(1)} min`
      : "Unknown";

  const ratio =
    Number(data.buySellRatio || 0).toFixed(2);

  const volumeMc =
    Number(data.volumeMc || 0).toFixed(1);

  return `
🚨 EARLY SOLANA TOKEN DETECTED

🪙 ${data.name} (${data.symbol})

Mint:
${data.mint}

⏱ AGE
${age}

💰 MARKET
MC: $${Number(data.marketCap).toLocaleString()}
Liquidity: $${Number(data.liquidity).toLocaleString()}
Volume 24h: $${Number(data.volume24h).toLocaleString()}
Volume/MC: ${volumeMc}%

📊 BUY / SELL
Buys: ${data.buys24h}
Sells: ${data.sells24h}
Ratio: ${ratio}x

🔐 SECURITY
Mint Authority: ${data.mintAuthority}
Freeze Authority: ${data.freezeAuthority}

🏦 DEX
${data.dex}

🧠 PATTERN SCORE
${data.score}/100

WHY IT MATCHED:
${data.conditions.earlyLaunch ? "✅ Early launch" : "❌ Not early"}
${data.conditions.mcInRange ? "✅ MC $5k-$10k" : "❌ MC outside range"}
${data.conditions.liquidityHealthy ? "✅ Liquidity <= MC" : "❌ Liquidity condition failed"}
${data.conditions.strongVolume ? "✅ Volume >= 50% MC" : "❌ Volume below 50% MC"}
${data.conditions.buyPressure ? "✅ Buy pressure" : "❌ Sell pressure"}

🔗 Pair:
${data.pairAddress}
`;
}


// ===============================
// MANUAL ANALYZE
// ===============================

app.get("/analyze", async (req, res) => {

  const mint = req.query.mint;

  if (!mint) {
    return res.status(400).json({
      success: false,
      message: "Use /analyze?mint=TOKEN_ADDRESS"
    });
  }

  try {

    const result = await analyzeToken(mint);

    if (!result.found) {
      return res.json({
        success: false,
        message: result.reason
      });
    }

    res.json({
      success: true,
      analysis: result
    });

  } catch (error) {

    console.error(
      "Analyze error:",
      error.response?.data || error.message
    );

    res.status(500).json({
      success: false,
      error: error.response?.data || error.message
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

      const tokenTransfers =
        event.tokenTransfers || [];

      if (!tokenTransfers.length) {
        continue;
      }

      const mint =
        tokenTransfers[0].mint;

      if (!mint) {
        continue;
      }

      // Duplicate protection
      const lastSeen = seenMints.get(mint);

      if (
        lastSeen &&
        Date.now() - lastSeen < DUPLICATE_WINDOW
      ) {
        console.log(
          "Duplicate token ignored:",
          mint
        );

        continue;
      }

      seenMints.set(
        mint,
        Date.now()
      );

      console.log(
        "New token detected:",
        mint
      );

      // Wait briefly for DEX data to appear
      await new Promise(resolve =>
        setTimeout(resolve, 5000)
      );

      try {

        const analysis =
          await analyzeToken(mint);

        if (!analysis.found) {

          console.log(
            "No market data yet:",
            mint
          );

          continue;
        }

        await sendTelegram(
          formatAlert(analysis)
        );

        console.log(
          "Analysis alert sent:",
          mint
        );

      } catch (analysisError) {

        console.error(
          "Analysis failed:",
          analysisError.response?.data ||
          analysisError.message
        );

      }
    }

    res.status(200).json({
      success: true
    });

  } catch (error) {

    console.error(
      "Webhook error:",
      error.response?.data ||
      error.message
    );

    res.status(500).json({
      success: false
    });
  }
});


// ===============================
// TEST TELEGRAM
// ===============================

app.get("/test-telegram", async (req, res) => {

  try {

    await sendTelegram(
      "🚨 SOLANA EARLY LAUNCH ANALYZER\n\n" +
      "Telegram Connection: ✅\n" +
      "Backend: ✅\n" +
      "Analysis Engine: ✅\n" +
      "Status: LIVE"
    );

    res.json({
      success: true,
      message: "Telegram test alert sent successfully"
    });

  } catch (error) {

    console.error(
      error.response?.data ||
      error.message
    );

    res.status(500).json({
      success: false,
      message: "Telegram alert failed",
      telegram_error:
        error.response?.data ||
        error.message
    });
  }
});


// ===============================
// START SERVER
// ===============================

app.listen(PORT, () => {
  console.log(
    `Server running on port ${PORT}`
  );
});
