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

// Initialize Local Cache (L1) - TTL: 5 minutes
const localCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

// Initialize Upstash Redis (L2)
let redis;
try {
  redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
  console.log('✅ Upstash Redis client initialized');
} catch (error) {
  console.error('❌ Failed to initialize Upstash Redis:', error.message);
}

/**
 * Multi-layer Cache Manager
 * L1: Node-cache (In-memory, fastest)
 * L2: Upstash Redis (Distributed, fast)
 * Fallback: Graceful handling of Redis failures
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
        console.warn(`[Cache] L2 Error (Fallback to L1/DB): ${error.message}`);
      }
    }

    return null;
  },

  async set(key, value, ttlSeconds = 3600) {
    // Set in Local Cache (L1)
    localCache.set(key, value, Math.min(ttlSeconds, 300)); // L1 usually has shorter TTL

    // Set in Upstash Redis (L2)
    if (redis) {
      try {
        await redis.set(key, value, { ex: ttlSeconds });
      } catch (error) {
        console.warn(`[Cache] L2 Write Error: ${error.message}`);
      }
    }
  },

  async del(key) {
    localCache.del(key);
    if (redis) {
      try {
        await redis.del(key);
      } catch (error) {
        console.warn(`[Cache] L2 Delete Error: ${error.message}`);
      }
    }
  }
};

// --- Mock Database / Data Source ---
const fetchUserFromDB = async (id) => {
  console.log(`[DB] Fetching user ${id} from database...`);
  // Simulate DB latency
  await new Promise(resolve => setTimeout(resolve, 300));
  return {
    id,
    name: `User ${id}`,
    email: `user${id}@example.com`,
    timestamp: new Date().toISOString()
  };
};

// --- Routes ---

app.get('/api/users/:id', async (req, res) => {
  const { id } = req.params;
  const cacheKey = `user:${id}`;

  try {
    // 1. Try to get from Cache (Multi-layer)
    const cachedUser = await cacheManager.get(cacheKey);
    if (cachedUser) {
      return res.json({ source: 'cache', data: cachedUser });
    }

    // 2. Cache Miss: Fetch from DB
    const user = await fetchUserFromDB(id);

    // 3. Populate Caches
    await cacheManager.set(cacheKey, user, 3600); // 1 hour TTL for Redis

    res.json({ source: 'database', data: user });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    l1: localCache.getStats(),
    l2: redis ? 'configured' : 'not_configured'
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Multi-layer cache server running at http://localhost:${PORT}`);
});
