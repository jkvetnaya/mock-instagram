const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { Pool } = require('pg');
const { createClient } = require('redis');
const amqp = require('amqplib');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3002;

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

// RabbitMQ
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
    CREATE TABLE IF NOT EXISTS posts (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL,
      caption TEXT,
      media_urls TEXT[] DEFAULT '{}',
      location VARCHAR(255),
      likes_count INTEGER DEFAULT 0,
      comments_count INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS comments (
      id UUID PRIMARY KEY,
      post_id UUID REFERENCES posts(id) ON DELETE CASCADE,
      user_id UUID NOT NULL,
      content TEXT NOT NULL,
      likes_count INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS likes (
      id UUID PRIMARY KEY,
      post_id UUID REFERENCES posts(id) ON DELETE CASCADE,
      user_id UUID NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(post_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS comment_likes (
      id UUID PRIMARY KEY,
      comment_id UUID REFERENCES comments(id) ON DELETE CASCADE,
      user_id UUID NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(comment_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_posts_user ON posts(user_id);
    CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);
    CREATE INDEX IF NOT EXISTS idx_likes_post ON likes(post_id);
    CREATE INDEX IF NOT EXISTS idx_likes_user ON likes(user_id);
  `;

  await pool.query(createTableQuery);
  console.log('✅ Database tables initialized');
}

// Helper: Publish event
function publishEvent(routingKey, data) {
  if (rabbitChannel) {
    rabbitChannel.publish(
      'instagram_events',
      routingKey,
      Buffer.from(JSON.stringify(data))
    );
  }
}

// Middleware: Auth verification
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production');
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// Optional auth (for viewing posts)
function optionalAuth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (token) {
    try {
      req.user = jwt.verify(token, process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production');
    } catch (error) {
      // Ignore invalid token
    }
  }
  next();
}

// ==================
// Routes
// ==================

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'post-service' });
});

// Create post
app.post('/api/posts', authMiddleware, async (req, res) => {
  try {
    const { caption, mediaUrls, location } = req.body;

    if (!mediaUrls || mediaUrls.length === 0) {
      return res.status(400).json({ error: 'At least one media URL is required' });
    }

    const postId = uuidv4();
    const result = await pool.query(
      `INSERT INTO posts (id, user_id, caption, media_urls, location)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [postId, req.user.userId, caption, mediaUrls, location]
    );

    const post = result.rows[0];

    // Publish event for feed service
    publishEvent('post.created', {
      postId: post.id,
      userId: post.user_id,
      createdAt: post.created_at,
    });

    // Invalidate user's posts cache
    await redisClient.del(`user:${req.user.userId}:posts`);

    res.status(201).json(post);
  } catch (error) {
    console.error('Create post error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get single post
app.get('/api/posts/:postId', optionalAuth, async (req, res) => {
  try {
    const { postId } = req.params;

    // Try cache
    const cached = await redisClient.get(`post:${postId}`);
    if (cached) {
      const post = JSON.parse(cached);
      if (req.user) {
        // Check if user liked
        const likeResult = await pool.query(
          'SELECT id FROM likes WHERE post_id = $1 AND user_id = $2',
          [postId, req.user.userId]
        );
        post.liked_by_user = likeResult.rows.length > 0;
      }
      return res.json(post);
    }

    const result = await pool.query(
      'SELECT * FROM posts WHERE id = $1',
      [postId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }

    const post = result.rows[0];

    // Cache post
    await redisClient.setEx(`post:${postId}`, 300, JSON.stringify(post));

    // Check if user liked
    if (req.user) {
      const likeResult = await pool.query(
        'SELECT id FROM likes WHERE post_id = $1 AND user_id = $2',
        [postId, req.user.userId]
      );
      post.liked_by_user = likeResult.rows.length > 0;
    }

    res.json(post);
  } catch (error) {
    console.error('Get post error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get posts by user
app.get('/api/posts/user/:userId', optionalAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    const { cursor, limit = 20 } = req.query;

    let query = `
      SELECT * FROM posts
      WHERE user_id = $1
    `;
    const params = [userId];

    if (cursor) {
      query += ` AND created_at < $2`;
      params.push(cursor);
    }

    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
    params.push(parseInt(limit));

    const result = await pool.query(query, params);

    res.json({
      posts: result.rows,
      nextCursor: result.rows.length > 0 ? result.rows[result.rows.length - 1].created_at : null,
    });
  } catch (error) {
    console.error('Get user posts error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete post
app.delete('/api/posts/:postId', authMiddleware, async (req, res) => {
  try {
    const { postId } = req.params;

    const result = await pool.query(
      'DELETE FROM posts WHERE id = $1 AND user_id = $2 RETURNING id',
      [postId, req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Post not found or not authorized' });
    }

    // Publish event
    publishEvent('post.deleted', { postId, userId: req.user.userId });

    // Invalidate caches
    await redisClient.del(`post:${postId}`);
    await redisClient.del(`user:${req.user.userId}:posts`);

    res.json({ message: 'Post deleted successfully' });
  } catch (error) {
    console.error('Delete post error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Like post
app.post('/api/posts/:postId/like', authMiddleware, async (req, res) => {
  try {
    const { postId } = req.params;

    // Check if post exists
    const postResult = await pool.query('SELECT id FROM posts WHERE id = $1', [postId]);
    if (postResult.rows.length === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }

    const likeId = uuidv4();
    await pool.query(
      `INSERT INTO likes (id, post_id, user_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (post_id, user_id) DO NOTHING`,
      [likeId, postId, req.user.userId]
    );

    // Update likes count
    await pool.query(
      'UPDATE posts SET likes_count = (SELECT COUNT(*) FROM likes WHERE post_id = $1) WHERE id = $1',
      [postId]
    );

    // Publish event
    publishEvent('post.liked', { postId, userId: req.user.userId });

    // Invalidate cache
    await redisClient.del(`post:${postId}`);

    res.json({ message: 'Post liked' });
  } catch (error) {
    console.error('Like post error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Unlike post
app.delete('/api/posts/:postId/like', authMiddleware, async (req, res) => {
  try {
    const { postId } = req.params;

    await pool.query(
      'DELETE FROM likes WHERE post_id = $1 AND user_id = $2',
      [postId, req.user.userId]
    );

    // Update likes count
    await pool.query(
      'UPDATE posts SET likes_count = (SELECT COUNT(*) FROM likes WHERE post_id = $1) WHERE id = $1',
      [postId]
    );

    // Publish event
    publishEvent('post.unliked', { postId, userId: req.user.userId });

    // Invalidate cache
    await redisClient.del(`post:${postId}`);

    res.json({ message: 'Post unliked' });
  } catch (error) {
    console.error('Unlike post error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get post likes
app.get('/api/posts/:postId/likes', async (req, res) => {
  try {
    const { postId } = req.params;
    const { limit = 50 } = req.query;

    const result = await pool.query(
      `SELECT user_id, created_at FROM likes
       WHERE post_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [postId, parseInt(limit)]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Get likes error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Add comment
app.post('/api/posts/:postId/comments', authMiddleware, async (req, res) => {
  try {
    const { postId } = req.params;
    const { content } = req.body;

    if (!content || content.trim().length === 0) {
      return res.status(400).json({ error: 'Comment content is required' });
    }

    // Check if post exists
    const postResult = await pool.query('SELECT id, user_id FROM posts WHERE id = $1', [postId]);
    if (postResult.rows.length === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }

    const commentId = uuidv4();
    const result = await pool.query(
      `INSERT INTO comments (id, post_id, user_id, content)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [commentId, postId, req.user.userId, content.trim()]
    );

    // Update comments count
    await pool.query(
      'UPDATE posts SET comments_count = comments_count + 1 WHERE id = $1',
      [postId]
    );

    // Publish event
    publishEvent('comment.created', {
      commentId: result.rows[0].id,
      postId,
      postOwnerId: postResult.rows[0].user_id,
      commenterId: req.user.userId,
    });

    // Invalidate cache
    await redisClient.del(`post:${postId}`);

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Add comment error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get comments for a post
app.get('/api/posts/:postId/comments', async (req, res) => {
  try {
    const { postId } = req.params;
    const { cursor, limit = 20 } = req.query;

    let query = `
      SELECT * FROM comments
      WHERE post_id = $1
    `;
    const params = [postId];

    if (cursor) {
      query += ` AND created_at < $2`;
      params.push(cursor);
    }

    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
    params.push(parseInt(limit));

    const result = await pool.query(query, params);

    res.json({
      comments: result.rows,
      nextCursor: result.rows.length > 0 ? result.rows[result.rows.length - 1].created_at : null,
    });
  } catch (error) {
    console.error('Get comments error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete comment
app.delete('/api/comments/:commentId', authMiddleware, async (req, res) => {
  try {
    const { commentId } = req.params;

    const result = await pool.query(
      'DELETE FROM comments WHERE id = $1 AND user_id = $2 RETURNING post_id',
      [commentId, req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Comment not found or not authorized' });
    }

    const postId = result.rows[0].post_id;

    // Update comments count
    await pool.query(
      'UPDATE posts SET comments_count = GREATEST(comments_count - 1, 0) WHERE id = $1',
      [postId]
    );

    // Invalidate cache
    await redisClient.del(`post:${postId}`);

    res.json({ message: 'Comment deleted successfully' });
  } catch (error) {
    console.error('Delete comment error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Start server
initializeConnections()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`🚀 Post Service running on port ${PORT}`);
    });
  })
  .catch((error) => {
    console.error('Failed to initialize:', error);
    process.exit(1);
  });
