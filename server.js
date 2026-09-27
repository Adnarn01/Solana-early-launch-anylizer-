const express = require("express");
const axios = require("axios");

const app = express();

app.use(
  express.json({
    limit: "2mb"
  })
);

// ============================================================
// ENVIRONMENT
// ============================================================

const PORT = process.env.PORT || 3000;

const TELEGRAM_BOT_TOKEN =
  (process.env.TELEGRAM_BOT_TOKEN || "").trim();

const TELEGRAM_CHAT_ID =
  (process.env.TELEGRAM_CHAT_ID || "").trim();

const HELIUS_API_KEY =
  (process.env.HELIUS_API_KEY || "").trim();

// ============================================================
// EXACT USER FILTERS
// ============================================================

const FILTERS = {
  ageMinMinutes: 5,
  ageMaxMinutes: 10,

  marketCapMin: 5000,
  marketCapMax: 15000,

  liquidityMin: 10000,
  liquidityMax: 20000,

  tradersMin: 100,
  tradersMax: 150,

  whalesMin: 3,
  whalesMax: 5,

  top10MinPercent: 35,
  top10MaxPercent: 40,

  supplyMin: 900_000_000,
  supplyMax: 1_000_000_000,

  riskMin: 40,
  riskMax: 55,

  lpLockedRequired: true,
  devSoldRequired: true,
  paidDexRequired: true,
  solanaRequired: true,
  pumpRequired: true,

  whaleMinSupplyPercent: 1
};

// ============================================================
// QUEUE
// ============================================================

const seenMints = new Map();
const queuedMints = new Set();
const analysisQueue = [];

const DUPLICATE_WINDOW = 15 * 60 * 1000;

let activeAnalyses = 0;

const MAX_CONCURRENT_ANALYSES = 2;
const MAX_RETRIES = 10;
const RETRY_DELAY = 5000;

// ============================================================
// API CONFIG
// ============================================================

const HELIUS_RPC_URL =
  `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(
    HELIUS_API_KEY
  )}`;

const HELIUS_TRANSACTIONS_BASE =
  "https://api.helius.xyz/v0/addresses";

const DEXSCREENER_BASE =
  "https://api.dexscreener.com";

const RUGCHECK_BASE =
  "https://api.rugcheck.xyz/v1";

// ============================================================
// HELPERS
// ============================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function number(value, fallback = 0) {
  const n = Number(value);

  return Number.isFinite(n)
    ? n
    : fallback;
}

function firstDefined(...values) {
  return values.find(
    value =>
      value !== undefined &&
      value !== null
  );
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// ============================================================
// BASIC ROUTES
// ============================================================

app.get("/", (req, res) => {
  res.json({
    status: "online",
    name: "Solana Early Launch Analyzer",
    version: "7.0"
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    queue: analysisQueue.length,
    activeAnalyses
  });
});

// ============================================================
// HELIUS STATUS
// ============================================================

app.get("/helius-status", async (req, res) => {
  try {
    if (!HELIUS_API_KEY) {
      return res.status(500).json({
        success: false,
        heliusConfigured: false,
        rpcWorking: false,
        message: "HELIUS_API_KEY is missing"
      });
    }

    const result = await heliusRpc(
      "getSlot",
      [],
      "helius-status"
    );

    return res.json({
      success: true,
      heliusConfigured: true,
      rpcWorking: true,
      slot: result
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      heliusConfigured: Boolean(HELIUS_API_KEY),
      rpcWorking: false,
      error:
        error.response?.data ||
        error.message
    });
  }
});

// ============================================================
// TELEGRAM
// ============================================================

async function sendTelegram(message) {
  if (
    !TELEGRAM_BOT_TOKEN ||
    !TELEGRAM_CHAT_ID
  ) {
    throw new Error(
      "Telegram environment variables are missing"
    );
  }

  const url =
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  const response = await axios.post(
    url,
    {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      disable_web_page_preview: true
    },
    {
      timeout: 10000
    }
  );

  if (!response.data?.ok) {
    throw new Error(
      `Telegram API error: ${safeJson(response.data)}`
    );
  }

  return response.data;
}

app.get("/test-telegram", async (req, res) => {
  try {
    await sendTelegram(
      "✅ Solana Early Launch Analyzer Telegram test successful."
    );

    res.json({
      success: true,
      message: "Telegram message sent"
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================================
// HELIUS RPC
// ============================================================

async function heliusRpc(
  method,
  params,
  id = method
) {
  if (!HELIUS_API_KEY) {
    throw new Error(
      "HELIUS_API_KEY is missing"
    );
  }

  try {
    const response = await axios.post(
      HELIUS_RPC_URL,
      {
        jsonrpc: "2.0",
        id,
        method,
        params
      },
      {
        timeout: 15000,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json"
        }
      }
    );

    if (response.data?.error) {
      throw new Error(
        `${method}: ${safeJson(
          response.data.error
        )}`
      );
    }

    return response.data?.result;
  } catch (error) {
    console.error(
      `Helius RPC ${method} error:`,
      safeJson(
        error.response?.data ||
        error.message
      )
    );

    throw error;
  }
}

// ============================================================
// HELIUS ASSET
// ============================================================

async function getHeliusAsset(mint) {
  try {
    return await heliusRpc(
      "getAsset",
      {
        id: mint,
        displayOptions: {
          showFungible: true
        }
      },
      "get-asset"
    );
  } catch (error) {
    console.error(
      "Helius asset error:",
      safeJson(
        error.response?.data ||
        error.message
      )
    );

    return null;
  }
}

// ============================================================
// MINT SECURITY
// ============================================================

async function getMintSecurity(mint) {
  try {
    const result = await heliusRpc(
      "getAccountInfo",
      [
        mint,
        {
          encoding: "jsonParsed"
        }
      ],
      "mint-security"
    );

    const info =
      result?.value?.data?.parsed?.info;

    if (!info) {
      return {
        mintAuthority: "UNKNOWN",
        freezeAuthority: "UNKNOWN"
      };
    }

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
      safeJson(
        error.response?.data ||
        error.message
      )
    );

    return {
      mintAuthority: "UNKNOWN",
      freezeAuthority: "UNKNOWN"
    };
  }
}

// ============================================================
// RUGCHECK
// ============================================================

async function getRugCheckReport(mint) {
  try {
    const response = await axios.get(
      `${RUGCHECK_BASE}/tokens/${mint}/report`,
      {
        timeout: 15000,
        headers: {
          Accept: "application/json",
          "User-Agent":
            "Solana-Early-Launch-Analyzer/7.0"
        }
      }
    );

    return response.data || null;
  } catch (error) {
    console.error(
      "RugCheck error:",
      error.response?.status ||
        error.message
    );

    return null;
  }
}

// ============================================================
// DEXSCREENER
// ============================================================

async function getDexData(mint) {
  try {
    const response = await axios.get(
      `${DEXSCREENER_BASE}/token-pairs/v1/solana/${mint}`,
      {
        timeout: 10000,
        headers: {
          Accept: "application/json",
          "User-Agent":
            "Solana-Early-Launch-Analyzer/7.0"
        }
      }
    );

    const pairs =
      Array.isArray(response.data)
        ? response.data
        : [];

    const validPairs =
      pairs.filter(pair => {
        return (
          pair?.chainId === "solana" &&
          number(
            pair?.liquidity?.usd
          ) > 0
        );
      });

    if (!validPairs.length) {
      return null;
    }

    validPairs.sort(
      (a, b) =>
        number(
          b?.liquidity?.usd
        ) -
        number(
          a?.liquidity?.usd
        )
    );

    return validPairs[0];
  } catch (error) {
    console.error(
      "DEX data error:",
      error.response?.status ||
        error.message
    );

    return null;
  }
}

// ============================================================
// PAID DEX
// ============================================================

async function getPaidDexStatus(mint) {
  try {
    const response = await axios.get(
      `${DEXSCREENER_BASE}/orders/v1/solana/${mint}`,
      {
        timeout: 10000,
        headers: {
          Accept: "application/json",
          "User-Agent":
            "Solana-Early-Launch-Analyzer/7.0"
        }
      }
    );

    const raw = response.data;

    const orders =
      Array.isArray(raw)
        ? raw
        : Array.isArray(raw?.orders)
          ? raw.orders
          : [];

    const paid =
      orders.some(
        order =>
          String(
            order?.status || ""
          ).toLowerCase() ===
          "approved"
      );

    return {
      paid,
      orders
    };
  } catch (error) {
    console.error(
      "Paid DEX check error:",
      error.response?.status ||
        error.message
    );

    return {
      paid: false,
      orders: []
    };
  }
}

// ============================================================
// UNIQUE TRADERS
// ============================================================

async function getUniqueTraders(
  pairAddress,
  pairCreatedAt
) {
  if (
    !pairAddress ||
    !HELIUS_API_KEY
  ) {
    return {
      traders: 0,
      traderWallets: []
    };
  }

  try {
    const createdMilliseconds =
      number(pairCreatedAt);

    const createdSeconds =
      Math.floor(
        createdMilliseconds / 1000
      );

    const nowSeconds =
      Math.floor(
        Date.now() / 1000
      );

    const startSeconds =
      Math.max(
        createdSeconds,
        nowSeconds - 15 * 60
      );

    const url =
      `${HELIUS_TRANSACTIONS_BASE}/${pairAddress}/transactions`;

    const response =
      await axios.get(url, {
        timeout: 15000,
        params: {
          "api-key":
            HELIUS_API_KEY,
          limit: 100,
          type: "SWAP",
          "gte-time":
            startSeconds
        },
        headers: {
          Accept: "application/json",
          "User-Agent":
            "Solana-Early-Launch-Analyzer/7.0"
        }
      });

    const transactions =
      Array.isArray(
        response.data
      )
        ? response.data
        : [];

    const traders =
      new Set();

    for (
      const tx of transactions
    ) {
      const timestamp =
        number(tx?.timestamp);

      if (
        timestamp &&
        timestamp < startSeconds
      ) {
        continue;
      }

      if (
        tx?.type !== "SWAP"
      ) {
        continue;
      }

      if (tx?.feePayer) {
        traders.add(
          tx.feePayer
        );
      }
    }

    return {
      traders: traders.size,
      traderWallets:
        [...traders]
    };
  } catch (error) {
    console.error(
      "Trader analysis error:",
      safeJson(
        error.response?.data ||
        error.message
      )
    );

    return {
      traders: 0,
      traderWallets: []
    };
  }
}

// ============================================================
// ANALYSIS ENGINE
// ============================================================

async function analyzeToken(
  mint,
  existingDex = null
) {
  const dex =
    existingDex ||
    await getDexData(mint);

  if (!dex) {
    return {
      found: false,
      reason:
        "No Solana DEX pool found"
    };
  }

  const [
    asset,
    security,
    rug,
    paidDex
  ] = await Promise.all([
    getHeliusAsset(mint),
    getMintSecurity(mint),
    getRugCheckReport(mint),
    getPaidDexStatus(mint)
  ]);

  if (!rug) {
    return {
      found: false,
      reason:
        "RugCheck report unavailable"
    };
  }

  const marketCap =
    number(
      firstDefined(
        dex.marketCap,
        dex.fdv
      )
    );

  const liquidity =
    number(
      dex?.liquidity?.usd
    );

  const pairCreatedAt =
    number(
      dex?.pairCreatedAt,
      0
    );

  const ageMinutes =
    pairCreatedAt
      ? (
          Date.now() -
          pairCreatedAt
        ) / 60000
      : null;

  const tokenInfo =
    rug.token || {};

  const decimals =
    number(
      tokenInfo.decimals,
      0
    );

  const rawSupply =
    number(
      tokenInfo.supply,
      0
    );

  const supply =
    rawSupply /
    Math.pow(
      10,
      decimals
    );

  const topHolders =
    Array.isArray(
      rug.topHolders
    )
      ? rug.topHolders
      : [];

  const top10Percent =
    topHolders
      .slice(0, 10)
      .reduce(
        (sum, holder) =>
          sum +
          number(holder?.pct),
        0
      );

  const whales =
    topHolders.filter(
      holder =>
        number(holder?.pct) >=
        FILTERS.whaleMinSupplyPercent
    ).length;

  const riskScore =
    number(
      firstDefined(
        rug.score_normalised,
        rug.risk_score_normalised
      ),
      -1
    );

  const lpLockedPct =
    Array.isArray(rug.markets)
      ? Math.max(
          0,
          ...rug.markets.map(
            market =>
              number(
                market?.lp?.lpLockedPct
              )
          )
        )
      : 0;

  const lpLocked =
    lpLockedPct >= 100;

  const creatorBalanceRaw =
    number(
      rug.creatorBalance
    );

  const creatorBalance =
    creatorBalanceRaw /
    Math.pow(
      10,
      decimals
    );

  const devSold =
    creatorBalance <= 0;

  const launchpadPlatform =
    String(
      rug?.launchpad?.platform ||
      ""
    ).toLowerCase();

  const pump =
    launchpadPlatform ===
    "pump_fun";

  const tradersData =
    await getUniqueTraders(
      dex.pairAddress,
      pairCreatedAt
    );

  const traders =
    tradersData.traders;

  const tokenName =
    asset?.content?.metadata?.name ||
    dex?.baseToken?.name ||
    rug?.tokenMeta?.name ||
    "Unknown";

  const symbol =
    asset?.content?.metadata?.symbol ||
    dex?.baseToken?.symbol ||
    rug?.tokenMeta?.symbol ||
    "UNKNOWN";

  const conditions = {
    age:
      ageMinutes !== null &&
      ageMinutes >=
        FILTERS.ageMinMinutes &&
      ageMinutes <=
        FILTERS.ageMaxMinutes,

    marketCap:
      marketCap >=
        FILTERS.marketCapMin &&
      marketCap <=
        FILTERS.marketCapMax,

    liquidity:
      liquidity >=
        FILTERS.liquidityMin &&
      liquidity <=
        FILTERS.liquidityMax,

    traders:
      traders >=
        FILTERS.tradersMin &&
      traders <=
        FILTERS.tradersMax,

    lpLocked:
      FILTERS.lpLockedRequired
        ? lpLocked
        : true,

    whales:
      whales >=
        FILTERS.whalesMin &&
      whales <=
        FILTERS.whalesMax,

    top10:
      top10Percent >=
        FILTERS.top10MinPercent &&
      top10Percent <=
        FILTERS.top10MaxPercent,

    supply:
      supply >=
        FILTERS.supplyMin &&
      supply <=
        FILTERS.supplyMax,

    riskScore:
      riskScore >=
        FILTERS.riskMin &&
      riskScore <=
        FILTERS.riskMax,

    devSold:
      FILTERS.devSoldRequired
        ? devSold
        : true,

    dexPaid:
      FILTERS.paidDexRequired
        ? paidDex.paid
        : true,

    solana:
      FILTERS.solanaRequired
        ? dex.chainId === "solana"
        : true,

    pump:
      FILTERS.pumpRequired
        ? pump
        : true
  };

  const qualifies =
    Object.values(
      conditions
    ).every(Boolean);

  return {
    found: true,
    qualifies,
    mint,
    name: tokenName,
    symbol,
    ageMinutes,
    marketCap,
    liquidity,
    traders,
    lpLocked,
    lpLockedPct,
    whales,
    whaleThresholdPercent:
      FILTERS.whaleMinSupplyPercent,
    top10Percent,
    supply,
    riskScore,
    devSold,
    creatorBalance,
    dexPaid:
      paidDex.paid,
    dex:
      dex.dexId || "Unknown",
    chain:
      dex.chainId || "Unknown",
    launchpad:
      rug?.launchpad?.name ||
      launchpadPlatform ||
      "Unknown",
    pairAddress:
      dex.pairAddress ||
      "Unknown",
    mintAuthority:
      security.mintAuthority,
    freezeAuthority:
      security.freezeAuthority,
    conditions
  };
  }

// ============================================================
// TELEGRAM ALERT
// ============================================================

function formatAlert(data) {
  const age =
    data.ageMinutes !== null
      ? `${data.ageMinutes.toFixed(1)}m`
      : "Unknown";

  return `
🚨 PUMP EARLY LAUNCH MATCH

🪙 ${data.name} (${data.symbol})

Mint:
${data.mint}

⏱ AGE
${age}

💰 MARKET
MC: $${data.marketCap.toLocaleString()}
Liquidity: $${data.liquidity.toLocaleString()}

👥 TRADERS
${data.traders}

🐋 WHALES
${data.whales} (${data.whaleThresholdPercent}%+)

📊 TOP 10
${data.top10Percent.toFixed(1)}%

🪙 SUPPLY
${data.supply.toLocaleString()}

⚠️ RISK SCORE
${data.riskScore}/100

🔒 LP
${data.lpLocked ? "LOCKED" : "NOT LOCKED"}
Locked: ${data.lpLockedPct.toFixed(1)}%

👨‍💻 DEV
${data.devSold ? "SOLD" : "NOT SOLD"}

💳 DEX PAID
${data.dexPaid ? "YES" : "NO"}

🏦 DEX
${data.dex}

🚀 LAUNCH
${data.launchpad}

⛓ CHAIN
${data.chain}

🔐 MINT
${data.mintAuthority}

❄️ FREEZE
${data.freezeAuthority}

🔗 PAIR
${data.pairAddress}
`;
}

// ============================================================
// ANALYSIS QUEUE
// ============================================================

function addToAnalysisQueue(mint) {
  if (
    !mint ||
    queuedMints.has(mint)
  ) {
    return;
  }

  queuedMints.add(mint);

  analysisQueue.push(mint);

  console.log(
    "Token added to analysis queue:",
    mint
  );

  processAnalysisQueue();
}

async function processAnalysisQueue() {
  if (
    activeAnalyses >=
    MAX_CONCURRENT_ANALYSES
  ) {
    return;
  }

  while (
    activeAnalyses <
      MAX_CONCURRENT_ANALYSES &&
    analysisQueue.length > 0
  ) {
    const mint =
      analysisQueue.shift();

    queuedMints.delete(mint);

    activeAnalyses++;

    analyzeQueuedToken(mint)
      .catch(error => {
        console.error(
          "Queue analysis error:",
          error.message
        );
      })
      .finally(() => {
        activeAnalyses--;

        setImmediate(
          processAnalysisQueue
        );
      });
  }
}

// ============================================================
// ANALYZE QUEUED TOKEN
// ============================================================

async function analyzeQueuedToken(mint) {
  console.log(
    "Starting token analysis:",
    mint
  );

  let dex = null;

  for (
    let attempt = 1;
    attempt <= MAX_RETRIES;
    attempt++
  ) {
    dex = await getDexData(mint);

    if (dex) {
      console.log(
        `DEX data ready on attempt ${attempt}:`,
        mint
      );

      break;
    }

    console.log(
      `DEX data not ready (attempt ${attempt}/${MAX_RETRIES}):`,
      mint
    );

    if (
      attempt < MAX_RETRIES
    ) {
      await sleep(
        RETRY_DELAY
      );
    }
  }

  if (!dex) {
    console.log(
      "No market data after retries:",
      mint
    );

    return;
  }

  try {
    const result =
      await analyzeToken(
        mint,
        dex
      );

    if (!result?.found) {
      console.log(
        "Token analysis stopped:",
        mint,
        result?.reason ||
          "Unknown reason"
      );

      return;
    }

    console.log(
      "Analysis result:",
      safeJson({
        mint: result.mint,
        name: result.name,
        symbol: result.symbol,
        qualifies:
          result.qualifies,
        conditions:
          result.conditions
      })
    );

    if (!result.qualifies) {
      console.log(
        "Token does not match all conditions:",
        mint
      );

      return;
    }

    const message =
      formatAlert(result);

    await sendTelegram(
      message
    );

    console.log(
      "Telegram alert sent:",
      mint
    );
  } catch (error) {
    console.error(
      "Token analysis failed:",
      mint,
      safeJson(
        error.response?.data ||
        error.message
      )
    );
  }
}

// ============================================================
// MANUAL ANALYZE ROUTE
// ============================================================

app.get(
  "/analyze",
  async (req, res) => {
    const mint =
      String(
        req.query.mint || ""
      ).trim();

    if (!mint) {
      return res.status(400).json({
        success: false,
        message:
          "Missing ?mint=TOKEN_MINT"
      });
    }

    try {
      const result =
        await analyzeToken(mint);

      return res.json({
        success: true,
        result
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        error:
          error.response?.data ||
          error.message
      });
    }
  }
);

// ============================================================
// HELIUS WEBHOOK
// ============================================================

app.post(
  "/webhook/helius",
  async (req, res) => {
    // Respond immediately so Helius
    // does not wait for analysis.
    res.status(200).json({
      success: true
    });

    try {
      const events =
        Array.isArray(req.body)
          ? req.body
          : [req.body];

      for (
        const event of events
      ) {
        const tokenTransfers =
          Array.isArray(
            event?.tokenTransfers
          )
            ? event.tokenTransfers
            : [];

        const mints = [
          ...new Set(
            tokenTransfers
              .map(
                transfer =>
                  transfer?.mint
              )
              .filter(Boolean)
          )
        ];

        if (!mints.length) {
          console.log(
            "Helius event received without tokenTransfers"
          );

          continue;
        }

        for (
          const mint of mints
        ) {
          const lastSeen =
            seenMints.get(mint);

          if (
            lastSeen &&
            Date.now() -
              lastSeen <
              DUPLICATE_WINDOW
          ) {
            console.log(
              "Duplicate mint ignored:",
              mint
            );

            continue;
          }

          seenMints.set(
            mint,
            Date.now()
          );

          console.log(
            "New token candidate:",
            mint
          );

          addToAnalysisQueue(
            mint
          );
        }
      }
    } catch (error) {
      console.error(
        "Webhook processing error:",
        safeJson(
          error.response?.data ||
          error.message
        )
      );
    }
  }
);

// ============================================================
// CLEAN OLD MINTS
// ============================================================

setInterval(() => {
  const now =
    Date.now();

  for (
    const [
      mint,
      timestamp
    ] of seenMints.entries()
  ) {
    if (
      now - timestamp >
      DUPLICATE_WINDOW
    ) {
      seenMints.delete(
        mint
      );
    }
  }
}, 5 * 60 * 1000);

// ============================================================
// START SERVER
// ============================================================

app.listen(
  PORT,
  () => {
    console.log(
      `Server running on port ${PORT}`
    );

    console.log(
      `Helius API key: ${
        HELIUS_API_KEY
          ? "CONFIGURED"
          : "MISSING"
      }`
    );

    console.log(
      `Telegram bot: ${
        TELEGRAM_BOT_TOKEN
          ? "CONFIGURED"
          : "MISSING"
      }`
    );

    console.log(
      `Telegram chat ID: ${
        TELEGRAM_CHAT_ID
          ? "CONFIGURED"
          : "MISSING"
      }`
    );
  }
);
