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

  // Technical definition of a whale:
  // wallet owns at least 1% of total supply.
  whaleMinSupplyPercent: 1
};

// ============================================================
// QUEUE / DUPLICATE PROTECTION
// ============================================================

const seenMints = new Map();

const DUPLICATE_WINDOW =
  15 * 60 * 1000;

const analysisQueue = [];

const queuedMints = new Set();

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
// BASIC HELPERS
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
    version: "6.0"
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
    const details =
      error.response?.data ||
      error.message;

    console.error(
      `Helius RPC ${method} error:`,
      safeJson(details)
    );

    throw error;
  }
}

// ============================================================
// HELIUS ASSET
// ============================================================

async function getHeliusAsset(mint) {
  try {
    const result = await heliusRpc(
      "getAsset",
      {
        id: mint,

        displayOptions: {
          showFungible: true
        }
      },
      "get-asset"
    );

    return result || null;
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
            "Solana-Early-Launch-Analyzer/6.0"
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

    if (error.response?.data) {
      console.error(
        "RugCheck response:",
        safeJson(error.response.data)
      );
    }

    return null;
  }
}

// ============================================================
// DEXSCREENER MARKET DATA
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
            "Solana-Early-Launch-Analyzer/6.0"
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

    // Select the pair with the highest
    // available liquidity.
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
    const response = await axios.get(
      `${DEXSCREENER_BASE}/orders/v1/solana/${mint}`,
      {
        timeout: 10000,

        headers: {
          Accept: "application/json",
          "User-Agent":
            "Solana-Early-Launch-Analyzer/6.0"
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
          order?.status ===
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
        nowSeconds -
          15 * 60
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
          Accept:
            "application/json",

          "User-Agent":
            "Solana-Early-Launch-Analyzer/6.0"
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
        number(
          tx?.timestamp
        );

      if (
        timestamp &&
        timestamp <
          startSeconds
      ) {
        continue;
      }

      if (
        tx?.type !==
        "SWAP"
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
  // LP LOCK
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
  // DEV SOLD
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
  // PUMP.FUN
  // ==========================================================

  const launchpadPlatform =
    String(
      rug?.launchpad
        ?.platform ||
        ""
    ).toLowerCase();

  const pump =
    launchpadPlatform ===
    "pump_fun";

  // ==========================================================
  // UNIQUE TRADERS
  // ==========================================================

  const tradersData =
    await getUniqueTraders(
      dex.pairAddress,
      pairCreatedAt
    );

  const traders =
    tradersData.traders;

  // ==========================================================
  // TOKEN NAME / SYMBOL
  // ==========================================================

  const tokenName =
    asset?.content
      ?.metadata
      ?.name ||
    dex?.baseToken?.name ||
    rug?.tokenMeta?.name ||
    "Unknown";

  const symbol =
    asset?.content
      ?.metadata
      ?.symbol ||
    dex?.baseToken?.symbol ||
    rug?.tokenMeta?.symbol ||
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
      FILTERS.solanaRequired
        ? dex.chainId ===
          "solana"
        : true,

    pump:
      FILTERS.pumpRequired
        ? pump
        : true
  };

  const qualifies =
    Object.values(
      conditions
   
