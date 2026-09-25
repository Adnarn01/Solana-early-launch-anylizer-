const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;


// ===============================
// DUPLICATE PROTECTION
// ===============================

const seenMints = new Map();
const DUPLICATE_WINDOW = 15 * 60 * 1000;


// ===============================
// BASIC ROUTES
// ===============================

app.get("/", (req, res) => {
  res.json({
    status: "online",
    name: "Solana Early Launch Analyzer",
    version: "3.0"
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
    id: "get-asset",
    method: "getAsset",
    params: {
      id: mint,
      displayOptions: {
        showFungible: true
      }
    }
  });

  return response.data?.result || null;
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
      id: "mint-security",
      method: "getAccountInfo",
      params: [
        mint,
        {
          encoding: "jsonParsed"
        }
      ]
    });

    const value =
      response.data?.result?.value;

    if (!value?.data?.parsed?.info) {

      return {
        mintAuthority: "UNKNOWN",
        freezeAuthority: "UNKNOWN"
      };
    }

    const info =
      value.data.parsed.info;

    return {

      mintAuthority:
        info.mintAuthority
          ? "ACTIVE"
          : "REVOKED",

      freezeAuthority:
        info.freezeAuthority
          ? "ACTIVE"
          : "REVOKED"
    };

  } catch (error) {

    console.error(
      "Security check error:",
      error.response?.data ||
      error.message
    );

    return {
      mintAuthority: "UNKNOWN",
      freezeAuthority: "UNKNOWN"
    };
  }
}


// ===============================
// HOLDER ANALYSIS
// ===============================

async function getHolderData(mint) {

  try {

    const url =
      `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

    const owners = new Map();

    let page = 1;

    while (page <= 10) {

      const response = await axios.post(url, {

        jsonrpc: "2.0",

        id: "holder-analysis",

        method: "getTokenAccounts",

        params: {
          mint: mint,
          limit: 1000,
          page: page
        }

      });

      const accounts =
        response.data?.result?.token_accounts || [];

      if (!accounts.length) {
        break;
      }

      for (const account of accounts) {

        const owner =
          account.owner;

        const amount =
          Number(account.amount || 0);

        if (!owner || amount <= 0) {
          continue;
        }

        owners.set(
          owner,
          (owners.get(owner) || 0) + amount
        );
      }

      if (accounts.length < 1000) {
        break;
      }

      page++;
    }


    const holders = [...owners.entries()]
      .map(([owner, amount]) => ({
        owner,
        amount
      }))
      .sort((a, b) => b.amount - a.amount);


    const totalSupply =
      holders.reduce(
        (sum, holder) =>
          sum + holder.amount,
        0
      );


    if (!totalSupply) {

      return {
        holders: 0,
        top10Percent: 0
      };
    }


    const top10Amount =
      holders
        .slice(0, 10)
        .reduce(
          (sum, holder) =>
            sum + holder.amount,
          0
        );


    const top10Percent =
      (top10Amount / totalSupply) * 100;


    return {

      holders:
        holders.length,

      top10Percent

    };

  } catch (error) {

    console.error(
      "Holder analysis error:",
      error.response?.data ||
      error.message
    );

    return {

      holders: 0,

      top10Percent: 0

    };
  }
}


// ===============================
// DEXSCREENER MARKET DATA
// ===============================

async function getDexData(mint) {

  try {

    const url =
      `https://api.dexscreener.com/token-pairs/v1/solana/${mint}`;

    const response =
      await axios.get(url);

    const pairs =
      Array.isArray(response.data)
        ? response.data
        : [];


    if (!pairs.length) {

      return null;
    }


    // Only pools with real liquidity
    const validPairs =
      pairs.filter(pair => {

        const liquidity =
          Number(
            pair.liquidity?.usd || 0
          );

        return liquidity > 0;
      });


    if (!validPairs.length) {

      console.log(
        "No pool with valid liquidity:",
        mint
      );

      return null;
    }


    // Highest liquidity pool
    validPairs.sort((a, b) => {

      const liquidityA =
        Number(
          a.liquidity?.usd || 0
        );

      const liquidityB =
        Number(
          b.liquidity?.usd || 0
        );

      return liquidityB - liquidityA;
    });


    const bestPair =
      validPairs[0];


    console.log(
      "Selected pool:",
      {
        dex: bestPair.dexId,
        pair: bestPair.pairAddress,
        liquidity:
          bestPair.liquidity?.usd
      }
    );


    return bestPair;

  } catch (error) {

    console.error(
      "DEX data error:",
      error.response?.data ||
      error.message
    );

    return null;
  }
}


// ===============================
// ANALYSIS ENGINE
// ===============================

async function analyzeToken(mint) {

  const [
    asset,
    dex,
    security,
    holderData
  ] = await Promise.all([

    getHeliusAsset(mint),

    getDexData(mint),

    getMintSecurity(mint),

    getHolderData(mint)

  ]);


  // No usable DEX pool
  if (!dex) {

    return {

      found: false,

      reason:
        "No DEX liquidity/pair found"
    };
  }


  // ===============================
  // MARKET DATA
  // ===============================

  const marketCap =
    Number(
      dex.marketCap ||
      dex.fdv ||
      0
    );


  const liquidity =
    Number(
      dex.liquidity?.usd ||
      0
    );


  const volume24h =
    Number(
      dex.volume?.h24 ||
      0
    );


  const buys24h =
    Number(
      dex.txns?.h24?.buys ||
      0
    );


  const sells24h =
    Number(
      dex.txns?.h24?.sells ||
      0
    );


  const buySellRatio =
    sells24h > 0
      ? buys24h / sells24h
      : buys24h;


  const volumeMc =
    marketCap > 0
      ? (volume24h / marketCap) * 100
      : 0;


  // ===============================
  // TOKEN AGE
  // ===============================

  const pairCreatedAt =
    dex.pairCreatedAt
      ? Number(dex.pairCreatedAt)
      : null;


  let ageMinutes = null;


  if (pairCreatedAt) {

    ageMinutes =
      (Date.now() - pairCreatedAt) /
      60000;
  }


  // ===============================
  // CONDITIONS
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


  const holderTarget =
    holderData.holders >= 100;


  const top10Healthy =
    holderData.top10Percent <= 40;


  // ===============================
  // SCORE
  // ===============================

  let score = 0;


  if (earlyLaunch)
    score += 15;


  if (mcInRange)
    score += 20;


  if (liquidityHealthy)
    score += 15;


  if (strongVolume)
    score += 15;


  if (buyPressure)
    score += 10;


  if (holderTarget)
    score += 10;


  if (top10Healthy)
    score += 5;


  if (
    security.freezeAuthority ===
    "REVOKED"
  )
    score += 5;


  if (
    security.mintAuthority ===
    "REVOKED"
  )
    score += 5;


  score =
    Math.min(score, 100);


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


  // ===============================
  // RESULT
  // ===============================

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

    holders:
      holderData.holders,

    top10Percent:
      holderData.top10Percent,

    mintAuthority:
      security.mintAuthority,

    freezeAuthority:
      security.freezeAuthority,

    dex:
      dex.dexId ||
      "Unknown",

    pairAddress:
      dex.pairAddress ||
      "Unknown",

    score,

    conditions: {

      earlyLaunch,

      mcInRange,

      liquidityHealthy,

      strongVolume,

      buyPressure,

      holderTarget,

      top10Healthy

    }

  };
}


// ===============================
// STRICT ALERT FILTER
// ===============================

function qualifiesForAlert(analysis) {

  if (!analysis || !analysis.found) {
    return false;
  }

  return (
    analysis.conditions.earlyLaunch &&
    analysis.conditions.mcInRange &&
    analysis.conditions.liquidityHealthy &&
    analysis.conditions.strongVolume &&
    analysis.conditions.buyPressure &&
    analysis.conditions.holderTarget &&
    analysis.conditions.top10Healthy
  );
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
    Number(
      data.buySellRatio || 0
    ).toFixed(2);


  const volumeMc =
    Number(
      data.volumeMc || 0
    ).toFixed(1);


  const top10 =
    Number(
      data.top10Percent || 0
    ).toFixed(1);


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

👥 HOLDERS
Holders: ${data.holders}
Top 10: ${top10}%

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
${data.conditions.holderTarget ? "✅ 100+ holders" : "❌ Holders below 100"}
${data.conditions.top10Healthy ? "✅ Top 10 concentration healthy" : "❌ Top 10 concentration high"}

🔗 Pair:
${data.pairAddress}
`;
}


// ===============================
// MANUAL ANALYZE
// ===============================

app.get("/analyze", async (req, res) => {

  const mint =
    req.query.mint;


  if (!mint) {

    return res.status(400).json({

      success: false,

      message:
        "Use /analyze?mint=TOKEN_ADDRESS"

    });
  }


  try {

    const result =
      await analyzeToken(mint);


    if (!result.found) {

      return res.json({

        success: false,

        message:
          result.reason

      });
    }


    // Manual analysis returns the
    // analysis even if it does not
    // qualify for Telegram alert.
    res.json({

      success: true,

      analysis: result

    });

  } catch (error) {

    console.error(

      "Analyze error:",

      error.response?.data ||
      error.message

    );


    res.status(500).json({

      success: false,

      error:
        error.response?.data ||
        error.message

    });
  }
});


// ===============================
// HELIUS WEBHOOK
// ===============================

app.post(
  "/webhook/helius",
  async (req, res) => {

    try {

      const events =
        Array.isArray(req.body)
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


        // ===============================
        // DUPLICATE PROTECTION
        // ===============================

        const lastSeen =
          seenMints.get(mint);


        if (
          lastSeen &&
          Date.now() - lastSeen <
            DUPLICATE_WINDOW
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


        // ===============================
        // WAIT FOR MARKET DATA
        // ===============================

        await new Promise(
          resolve =>
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


          // ===============================
          // STRICT 7-CONDITION FILTER
          // ===============================

          const qualifies =
            qualifiesForAlert(
              analysis
            );


          if (!qualifies) {

            console.log(
              "Token did not meet alert criteria:",
              mint
            );

            continue;
          }


          // ===============================
          // SEND TELEGRAM ONLY IF
          // ALL CONDITIONS ARE TRUE
          // ===============================

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
  }
);


// ===============================
// TEST TELEGRAM
// ===============================

app.get(
  "/test-telegram",
  async (req, res) => {

    try {

      await sendTelegram(

        "🚨 SOLANA EARLY LAUNCH ANALYZER\n\n" +

        "Telegram Connection: ✅\n" +

        "Backend: ✅\n" +

        "Holder Analysis: ✅\n" +

        "DEX Analysis: ✅\n" +

        "Security Analysis: ✅\n\n" +

        "Status: LIVE"

      );


      res.json({

        success: true,

        message:
          "Telegram test alert sent successfully"

      });


    } catch (error) {

      console.error(

        error.response?.data ||
        error.message

      );


      res.status(500).json({

        success: false,

        message:
          "Telegram alert failed",

        telegram_error:
          error.response?.data ||
          error.message

      });
    }
  }
);


// ===============================
// START SERVER
// ===============================

app.listen(
  PORT,
  () => {

    console.log(
      `Server running on port ${PORT}`
    );

  }
);
