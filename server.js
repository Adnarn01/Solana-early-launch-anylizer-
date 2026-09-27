const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

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

  // Whale definition
  whaleMinSupplyPercent: 1
};

// ============================================================
// DUPLICATE PROTECTION / QUEUE
// ============================================================

const seenMints = new Map();
const DUPLICATE_WINDOW = 15 * 60 * 1000;

const analysisQueue = [];
const queuedMints = new Set();

let activeAnalyses = 0;

const MAX_CONCURRENT_ANALYSES = 2;
const MAX_RETRIES = 10;
const RETRY_DELAY = 5000;

// ============================================================
// BASIC ROUTES
// ============================================================

app.get("/", (req, res) => {
  res.json({
    status: "online",
    name: "Solana Early Launch Analyzer",
    version: "5.0"
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
// HELPERS
// ============================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function number(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function firstDefined(...values) {
  return values.find(
    value => value !== undefined && value !== null
  );
}

// ============================================================
// TELEGRAM
// ============================================================

async function sendTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    throw new Error(
      "Telegram environment variables are missing"
    );
  }

  await axios.post(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      disable_web_page_preview: true
    },
    {
      timeout: 10000
    }
  );
}

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

  const url =
    `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

  const response = await axios.post(
    url,
    {
      jsonrpc: "2.0",
      id,
      method,
      params
    },
    {
      timeout: 15000
    }
  );

  if (response.data?.error) {
    throw new Error(
      `${method}: ${JSON.stringify(
        response.data.error
      )}`
    );
  }

  return response.data?.result;
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
      error.response?.data ||
      error.message
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
      error.response?.data ||
      error.message
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
    const response =
      await axios.get(
        `https://api.rugcheck.xyz/v1/tokens/${mint}/report`,
        {
          timeout: 15000,
          headers: {
            Accept: "application/json",
            "User-Agent":
              "Solana-Early-Launch-Analyzer/5.0"
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
// DEXSCREENER MARKET DATA
// ============================================================

async function getDexData(mint) {
  try {
    const response =
      await axios.get(
        `https://api.dexscreener.com/token-pairs/v1/solana/${mint}`,
        {
          timeout: 10000,
          headers: {
            Accept: "application/json",
            "User-Agent":
              "Solana-Early-Launch-Analyzer/5.0"
          }
        }
      );

    const pairs =
      Array.isArray(response.data)
        ? response.data
        : [];

    const validPairs =
      pairs.filter(pair =>
        pair?.chainId === "solana" &&
        number(
          pair?.liquidity?.usd
        ) > 0
      );

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
// PAID DEX CHECK
// ============================================================

async function getPaidDexStatus(mint) {
  try {
    const response =
      await axios.get(
        `https://api.dexscreener.com/orders/v1/solana/${mint}`,
        {
          timeout: 10000,
          headers: {
            Accept: "application/json",
            "User-Agent":
              "Solana-Early-Launch-Analyzer/5.0"
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

    return {
      paid:
        orders.some(
          order =>
            order?.status === "approved"
        ),

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
    const createdSeconds =
      Math.floor(
        number(pairCreatedAt) / 1000
      );

    const nowSeconds =
      Math.floor(
        Date.now() / 1000
      );

    const startSeconds =
      Math.max(
        createdSeconds,
        nowSeconds -
          15 * 60
      );

    const url =
      `https://api.helius.xyz/v0/addresses/${pairAddress}/transactions`;

    const response =
      await axios.get(
        url,
        {
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
              "Solana-Early-Launch-Analyzer/5.0"
          }
        }
      );

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
        number(
          tx?.timestamp
        );

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

      if (
        tx?.feePayer
      ) {
        traders.add(
          tx.feePayer
        );
      }
    }

    return {
      traders:
        traders.size,

      traderWallets:
        [...traders]
    };

  } catch (error) {
    console.error(
      "Trader analysis error:",
      error.response?.data ||
      error.message
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
  ] =
    await Promise.all([
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

  // ==========================================================
  // MARKET
  // ==========================================================

  const marketCap =
    number(
      firstDefined(
        dex.marketCap,
        dex.fdv
      )
    );

  const liquidity =
    number(
      dex.liquidity?.usd
    );

  const pairCreatedAt =
    number(
      dex.pairCreatedAt,
      0
    );

  const ageMinutes =
    pairCreatedAt
      ? (
          Date.now() -
          pairCreatedAt
        ) / 60000
      : null;

  // ==========================================================
  // SUPPLY
  // ==========================================================

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

  // ==========================================================
  // TOP HOLDERS
  // ==========================================================

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
          number(
            holder?.pct
          ),
        0
      );

  // ==========================================================
  // WHALES
  // ==========================================================

  const whales =
    topHolders.filter(
      holder =>
        number(
          holder?.pct
        ) >=
        FILTERS.whaleMinSupplyPercent
    ).length;

  // ==========================================================
  // RISK
  // ==========================================================

  const riskScore =
    number(
      firstDefined(
        rug.score_normalised,
        rug.risk_score_normalised
      ),
      -1
    );

  // ==========================================================
  // LP
  // ==========================================================

  const lpLockedPct =
    Array.isArray(
      rug.markets
    )
      ? Math.max(
          0,

          ...rug.markets.map(
            market =>
              number(
                market?.lp
                  ?.lpLockedPct
              )
          )
        )
      : 0;

  const lpLocked =
    lpLockedPct >= 100;

  // ==========================================================
  // DEV
  // ==========================================================

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

  // ==========================================================
  // PUMP
  // ==========================================================

  const launchpadPlatform =
    String(
      rug.launchpad?.platform ||
      ""
    ).toLowerCase();

  const pump =
    launchpadPlatform ===
    "pump_fun";

  // ==========================================================
  // TRADERS
  // ==========================================================

  const tradersData =
    await getUniqueTraders(
      dex.pairAddress,
      pairCreatedAt
    );

  const traders =
    tradersData.traders;

  // ==========================================================
  // TOKEN INFO
  // ==========================================================

  const tokenName =
    asset?.content?.metadata?.name ||
    dex.baseToken?.name ||
    rug.tokenMeta?.name ||
    "Unknown";

  const symbol =
    asset?.content?.metadata?.symbol ||
    dex.baseToken?.symbol ||
    rug.tokenMeta?.symbol ||
    "UNKNOWN";

  // ==========================================================
  // EXACT CONDITIONS
  // ==========================================================

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
      dex.chainId ===
      "solana",

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

    name:
      tokenName,

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
      dex.dexId ||
      "Unknown",

    chain:
      dex.chainId ||
      "Unknown",

    launchpad:
      rug.launchpad?.name ||
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
// QUEUE
// ============================================================

function addToAnalysisQueue(mint) {

  if (
    queuedMints.has(mint)
  ) {
    return;
  }

  queuedMints.add(mint);

  analysisQueue.push(
    mint
  );

  console.log(
    "Token added to analysis queue:",
    mint
  );

  processAnalysisQueue();
}

async function processAnalysisQueue() {

  while (
    activeAnalyses <
      MAX_CONCURRENT_ANALYSES &&
    analysisQueue.length
  ) {

    const mint =
      analysisQueue.shift();

    activeAnalyses++;

    processTokenWithRetry(
      mint
    )
      .catch(error => {

        console.error(
          "Queue processing error:",
          error.response?.data ||
          error.message
        );

      })
      .finally(() => {

        queuedMints.delete(
          mint
        );

        activeAnalyses--;

        processAnalysisQueue();

      });
  }
}

// ============================================================
// TOKEN PROCESSING
// ============================================================

async function processTokenWithRetry(
  mint
) {

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

    dex =
      await getDexData(
        mint
      );

    if (dex) {
      break;
    }

    if (
      attempt <
      MAX_RETRIES
    ) {

      console.log(
        `DEX data not ready. Retry ${attempt}/${MAX_RETRIES}`
      );

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

  const analysis =
    await analyzeToken(
      mint,
      dex
    );

  if (!analysis.found) {

    console.log(
      "Analysis unavailable:",
      mint,
      analysis.reason
    );

    return;
  }

  console.log(
    "FILTER RESULT:",
    mint,
    analysis.conditions
  );

  if (
    !analysis.qualifies
  ) {

    console.log(
      "Token did not meet exact filters:",
      mint
    );

    return;
  }

  await sendTelegram(
    formatAlert(
      analysis
    )
  );

  console.log(
    "MATCH ALERT SENT:",
    mint
    );
