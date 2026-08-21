const express = require('express');
const { Redis } = require('@upstash/redis');
const NodeCache = require('node-cache');
const dotenv = require('dotenv');
const cors = require('cors');
const morgan = require('morgan');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());

// Initialize Local Cache (L1) - TTL: 60 seconds
// This protects your Redis limits from rapid UI re-renders or multiple users fetching same data within 1 minute.
const localCache = new NodeCache({ stdTTL: 60, checkperiod: 60 });

// Initialize Upstash Redis (L2) - TTL: 5-300 seconds
// This shares cache across all users globally.
let redis;
try {
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
    console.log('✅ Upstash Redis client connected');
  } else {
    console.warn('⚠️ Upstash Redis credentials missing. Running without L2 cache.');
  }
} catch (error) {
  console.error('❌ Failed to initialize Upstash Redis:', error.message);
}

/**
 * Multi-layer Cache Manager
 */
const cacheManager = {
  async get(key) {
    // 1. Try Local Cache (L1)
    const localData = localCache.get(key);
    if (localData) {
      console.log(`[Cache] L1 Hit: ${key}`);
      return localData;
    }

    // 2. Try Upstash Redis (L2)
    if (redis) {
      try {
        const remoteData = await redis.get(key);
        if (remoteData) {
          console.log(`[Cache] L2 Hit: ${key}`);
          // Backfill L1
          localCache.set(key, remoteData);
          return remoteData;
        }
      } catch (error) {
        console.warn(`[Cache] L2 Error: ${error.message}`);
      }
    }

    return null;
  },

  async set(key, value, ttlSeconds = 300) {
    // Set in Local Cache (L1) - Max 60s for L1 to ensure freshness
    localCache.set(key, value, Math.min(ttlSeconds, 60));

    // Set in Upstash Redis (L2)
    if (redis) {
      try {
        await redis.set(key, value, { ex: ttlSeconds });
      } catch (error) {
        console.warn(`[Cache] L2 Write Error: ${error.message}`);
      }
    }
  }
};

// --- External Data Fetchers (The Chaining Logic) ---

const fetchAmarStockQuote = async (symbol) => {
  console.log(`[Fetcher] AmarStock Quote: ${symbol}`);
  const url = `https://api.amarstock.com/api/get/latestPrice?symbol=${symbol}`;
  const response = await fetch(url);
  const data = await response.json();
  if (!data || !data.LastTrade) throw new Error('AmarStock data not found');
  return {
    price: parseFloat(data.LastTrade),
    currency: 'BDT',
    timestamp: Date.now()
  };
};

const searchAmarStock = async (query) => {
  const url = `https://api.amarstock.com/api/get/SymbolList`;
  const response = await fetch(url);
  const symbols = await response.json();
  return symbols
    .filter(s => s.Symbol.includes(query.toUpperCase()) || s.FullName.toUpperCase().includes(query.toUpperCase()))
    .slice(0, 10)
    .map(s => ({
      symbol: s.Symbol,
      name: s.FullName,
      type: 'STOCK',
      currency: 'BDT',
      country: 'BD'
    }));
};

const fetchYahooQuote = async (symbol) => {
  console.log(`[Fetcher] Yahoo Quote: ${symbol}`);
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbol}`;
  const response = await fetch(url);
  const data = await response.json();
  const result = data.quoteResponse.result[0];
  if (!result) throw new Error('Yahoo Symbol not found');
  return {
    price: result.regularMarketPrice,
    currency: result.currency,
    timestamp: Date.now()
  };
};

const fetchFMPQuote = async (symbol) => {
  const apiKey = process.env.FMP_API_KEY;
  console.log(`[Fetcher] FMP Quote: ${symbol}`);
  const url = `https://financialmodelingprep.com/api/v3/quote-short/${symbol}?apikey=${apiKey}`;
  const response = await fetch(url);
  const data = await response.json();
  if (!data || !data[0]) throw new Error('FMP data not found');
  return {
    price: data[0].price,
    currency: 'USD',
    timestamp: Date.now()
  };
};

const fetchFinnhubQuote = async (symbol) => {
  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) throw new Error('Finnhub Key missing');
  console.log(`[Fetcher] Finnhub Quote: ${symbol}`);
  const url = `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${apiKey}`;
  const response = await fetch(url);
  const data = await response.json();
  if (!data || !data.c) throw new Error('Finnhub data not found');
  return {
    price: data.c,
    currency: 'USD',
    timestamp: Date.now()
  };
};

const fetchAlphaVantageQuote = async (symbol) => {
  const apiKey = process.env.ALPHAVANTAGE_API_KEY;
  if (!apiKey) throw new Error('AlphaVantage Key missing');
  console.log(`[Fetcher] AlphaVantage Quote: ${symbol}`);
  const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${symbol}&apikey=${apiKey}`;
  const response = await fetch(url);
  const data = await response.json();
  const quote = data['Global Quote'];
  if (!quote || !quote['05. price']) throw new Error('AlphaVantage data not found');
  return {
    price: parseFloat(quote['05. price']),
    currency: 'USD',
    timestamp: Date.now()
  };
};

const fetchCryptoFromCoinGecko = async (id) => {
  console.log(`[Fetcher] CoinGecko Quote: ${id}`);
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`;
  const response = await fetch(url);
  const data = await response.json();
  if (!data[id]) throw new Error('Crypto not found');
  return {
    price: data[id].usd,
    currency: 'USD',
    timestamp: Date.now()
  };
};

const searchYahoo = async (query) => {
  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${query}`;
  const response = await fetch(url);
  const data = await response.json();
  return data.quotes.map(q => ({
    symbol: q.symbol,
    name: q.shortname || q.longname,
    type: q.quoteType,
    currency: 'USD',
    country: 'Global'
  }));
};

const searchFMP = async (query) => {
  const apiKey = process.env.FMP_API_KEY;
  const url = `https://financialmodelingprep.com/api/v3/search?query=${query}&limit=10&apikey=${apiKey}`;
  const response = await fetch(url);
  const data = await response.json();
  if (!data || data.Error) return [];
  return data.map(item => ({
    symbol: item.symbol,
    name: item.name,
    type: 'STOCK',
    currency: item.currency || 'USD',
    country: item.stockExchange.includes('India') ? 'IN' : 'Global'
  }));
};

// --- Routes ---

app.get('/api/quote', async (req, res) => {
  const { symbol, type, country } = req.query;
  if (!symbol) return res.status(400).json({ error: 'Symbol required' });

  const cacheKey = `quote:${symbol}`;

  try {
    // 1. Check Cache
    const cached = await cacheManager.get(cacheKey);
    if (cached) return res.json(cached);

    // 2. Multi-Provider Chaining
    let data;
    if (type === 'CRYPTO') {
      data = await fetchCryptoFromCoinGecko(symbol.toLowerCase());
    } else if (symbol.endsWith('.BD') || country === 'BD') {
      data = await fetchAmarStockQuote(symbol.replace('.BD', ''));
    } else {
      // Primary chain for Global/US/India
      try {
        data = await fetchYahooQuote(symbol);
      } catch (e) {
        console.warn('Yahoo failed, trying FMP...');
        try {
          data = await fetchFMPQuote(symbol);
        } catch (e2) {
          console.warn('FMP failed, trying Finnhub...');
          try {
            data = await fetchFinnhubQuote(symbol);
          } catch (e3) {
            console.warn('Finnhub failed, trying AlphaVantage...');
            data = await fetchAlphaVantageQuote(symbol);
          }
        }
      }
    }

    // 3. Populate Caches
    await cacheManager.set(cacheKey, data, 300); // 5 mins global cache
    res.json(data);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/search', async (req, res) => {
  const { query, country } = req.query;
  if (!query) return res.status(400).json({ error: 'Query required' });

  const cacheKey = `search:${query}`;

  try {
    const cached = await cacheManager.get(cacheKey);
    if (cached) return res.json(cached);

    let data = [];

    // Chain searches
    if (query.length <= 6 || country === 'BD') {
      try {
        const bdData = await searchAmarStock(query);
        data = [...data, ...bdData];
      } catch (e) { console.warn('AmarStock search failed'); }
    }

    try {
      const yahooData = await searchYahoo(query);
      data = [...data, ...yahooData];
    } catch (e) { console.warn('Yahoo search failed'); }

    try {
      const fmpData = await searchFMP(query);
      data = [...data, ...fmpData];
    } catch (e) { console.warn('FMP search failed'); }

    // De-duplicate by symbol
    const uniqueData = Array.from(new Map(data.map(item => [item.symbol, item])).values());

    await cacheManager.set(cacheKey, uniqueData, 86400); // 24 hours search cache
    res.json(uniqueData);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    redis: redis ? 'connected' : 'not_connected',
    env: process.env.NODE_ENV
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Zero-Bill Multi-Layer Backend running at http://localhost:${PORT}`);
});
