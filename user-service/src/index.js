const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { Pool } = require('pg');
const { createClient } = require('redis');
const amqp = require('amqplib');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(helmet());
app.use(morgan('combined'));
app.use(express.json());

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Redis client
let redisClient;

// RabbitMQ connection
let rabbitChannel;

// Initialize connections
async function initializeConnections() {
  // Redis
  redisClient = createClient({ url: process.env.REDIS_URL });
  redisClient.on('error', (err) => console.error('Redis Error:', err));
  await redisClient.connect();
  console.log('✅ Connected to Redis');

  // RabbitMQ
  const rabbitConn = await amqp.connect(process.env.RABBITMQ_URL);
  rabbitChannel = await rabbitConn.createChannel();
  await rabbitChannel.assertExchange('instagram_events', 'topic', { durable: true });
  console.log('✅ Connected to RabbitMQ');

  // Initialize database tables
  await initDatabase();
}

async function initDatabase() {
  const createTableQuery = `
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY,
      username VARCHAR(50) UNIQUE NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      full_name VARCHAR(100),
      bio TEXT,
      profile_picture_url TEXT,
      is_private BOOLEAN DEFAULT false,
      followers_count INTEGER DEFAULT 0,
      following_count INTEGER DEFAULT 0,
      posts_count INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS follows (
      id UUID PRIMARY KEY,
      follower_id UUID REFERENCES users(id) ON DELETE CASCADE,
      following_id UUID REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(follower_id, following_id)
    );

    CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_id);
    CREATE INDEX IF NOT EXISTS idx_follows_following ON follows(following_id);
  `;
  
  await pool.query(createTableQuery);
  console.log('✅ Database tables initialized');
}

// Helper: Publish event to RabbitMQ
function publishEvent(routingKey, data) {
  if (rabbitChannel) {
    rabbitChannel.publish(
      'instagram_events',
      routingKey,
      Buffer.from(JSON.stringify(data))
    );
  }
}

// Helper: Generate JWT
function generateToken(user) {
  return jwt.sign(
    { userId: user.id, username: user.username },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

// Middleware: Auth verification
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ==================
// Routes
// ==================

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'user-service' });
});

// Register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, email, password, fullName } = req.body;

    // Validate input
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Check if user exists
    const existingUser = await pool.query(
      'SELECT id FROM users WHERE username = $1 OR email = $2',
      [username, email]
    );

    if (existingUser.rows.length > 0) {
      return res.status(409).json({ error: 'Username or email already exists' });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 12);

    // Create user
    const userId = uuidv4();
    const result = await pool.query(
      `INSERT INTO users (id, username, email, password_hash, full_name)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, username, email, full_name, created_at`,
      [userId, username, email, passwordHash, fullName]
    );

    const user = result.rows[0];
    const token = generateToken(user);

    // Publish event
    publishEvent('user.created', { userId: user.id, username: user.username });

    // Cache user
    await redisClient.setEx(`user:${user.id}`, 3600, JSON.stringify(user));

    res.status(201).json({ user, token });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    const result = await pool.query(
      'SELECT * FROM users WHERE username = $1 OR email = $1',
      [username]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);

    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = generateToken(user);

    // Remove sensitive data
    delete user.password_hash;

    res.json({ user, token });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get current user profile
app.get('/api/users/me', authMiddleware, async (req, res) => {
  try {
    // Try cache first
    const cached = await redisClient.get(`user:${req.user.userId}`);
    if (cached) {
      return res.json(JSON.parse(cached));
    }

    const result = await pool.query(
      `SELECT id, username, email, full_name, bio, profile_picture_url,
              is_private, followers_count, following_count, posts_count, created_at
       FROM users WHERE id = $1`,
      [req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = result.rows[0];
    await redisClient.setEx(`user:${user.id}`, 3600, JSON.stringify(user));

    res.json(user);
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get user by username
app.get('/api/users/:username', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, username, full_name, bio, profile_picture_url,
              is_private, followers_count, following_count, posts_count, created_at
       FROM users WHERE username = $1`,
      [req.params.username]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update profile
app.put('/api/users/me', authMiddleware, async (req, res) => {
  try {
    const { fullName, bio, isPrivate } = req.body;

    const result = await pool.query(
      `UPDATE users 
       SET full_name = COALESCE($1, full_name),
           bio = COALESCE($2, bio),
           is_private = COALESCE($3, is_private),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $4
       RETURNING id, username, email, full_name, bio, is_private`,
      [fullName, bio, isPrivate, req.user.userId]
    );

    const user = result.rows[0];

    // Invalidate cache
    await redisClient.del(`user:${user.id}`);

    // Publish event
    publishEvent('user.updated', { userId: user.id });

    res.json(user);
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Follow user
app.post('/api/users/:username/follow', authMiddleware, async (req, res) => {
  try {
    // Get target user
    const targetResult = await pool.query(
      'SELECT id FROM users WHERE username = $1',
      [req.params.username]
    );

    if (targetResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const targetUserId = targetResult.rows[0].id;

    if (targetUserId === req.user.userId) {
      return res.status(400).json({ error: 'Cannot follow yourself' });
    }

    // Create follow relationship
    const followId = uuidv4();
    await pool.query(
      `INSERT INTO follows (id, follower_id, following_id)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [followId, req.user.userId, targetUserId]
    );

    // Update counts
    await pool.query(
      'UPDATE users SET following_count = following_count + 1 WHERE id = $1',
      [req.user.userId]
    );
    await pool.query(
      'UPDATE users SET followers_count = followers_count + 1 WHERE id = $1',
      [targetUserId]
    );

    // Publish event
    publishEvent('user.followed', {
      followerId: req.user.userId,
      followingId: targetUserId,
    });

    // Invalidate caches
    await redisClient.del(`user:${req.user.userId}`);
    await redisClient.del(`user:${targetUserId}`);

    res.json({ message: 'Followed successfully' });
  } catch (error) {
    console.error('Follow error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Unfollow user
app.delete('/api/users/:username/follow', authMiddleware, async (req, res) => {
  try {
    const targetResult = await pool.query(
      'SELECT id FROM users WHERE username = $1',
      [req.params.username]
    );

    if (targetResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const targetUserId = targetResult.rows[0].id;

    const deleteResult = await pool.query(
      'DELETE FROM follows WHERE follower_id = $1 AND following_id = $2 RETURNING id',
      [req.user.userId, targetUserId]
    );

    if (deleteResult.rows.length > 0) {
      // Update counts
      await pool.query(
        'UPDATE users SET following_count = GREATEST(following_count - 1, 0) WHERE id = $1',
        [req.user.userId]
      );
      await pool.query(
        'UPDATE users SET followers_count = GREATEST(followers_count - 1, 0) WHERE id = $1',
        [targetUserId]
      );

      // Publish event
      publishEvent('user.unfollowed', {
        followerId: req.user.userId,
        followingId: targetUserId,
      });

      // Invalidate caches
      await redisClient.del(`user:${req.user.userId}`);
      await redisClient.del(`user:${targetUserId}`);
    }

    res.json({ message: 'Unfollowed successfully' });
  } catch (error) {
    console.error('Unfollow error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get followers
app.get('/api/users/:username/followers', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.username, u.full_name, u.profile_picture_url
       FROM users u
       INNER JOIN follows f ON f.follower_id = u.id
       INNER JOIN users target ON target.id = f.following_id
       WHERE target.username = $1
       ORDER BY f.created_at DESC
       LIMIT 50`,
      [req.params.username]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Get followers error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get following
app.get('/api/users/:username/following', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.username, u.full_name, u.profile_picture_url
       FROM users u
       INNER JOIN follows f ON f.following_id = u.id
       INNER JOIN users source ON source.id = f.follower_id
       WHERE source.username = $1
       ORDER BY f.created_at DESC
       LIMIT 50`,
      [req.params.username]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Get following error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Search users
app.get('/api/users', async (req, res) => {
  try {
    const { q, limit = 20 } = req.query;

    if (!q) {
      return res.status(400).json({ error: 'Search query required' });
    }

    const result = await pool.query(
      `SELECT id, username, full_name, profile_picture_url
       FROM users
       WHERE username ILIKE $1 OR full_name ILIKE $1
       ORDER BY followers_count DESC
       LIMIT $2`,
      [`%${q}%`, parseInt(limit)]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Start server
initializeConnections()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`🚀 User Service running on port ${PORT}`);
    });
  })
  .catch((error) => {
    console.error('Failed to initialize:', error);
    process.exit(1);
  });
