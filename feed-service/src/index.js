const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { createClient } = require('redis');
const amqp = require('amqplib');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const cassandra = require('cassandra-driver');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3004;

// Middleware
app.use(cors());
app.use(helmet());
app.use(morgan('combined'));
app.use(express.json());

// Redis client (for caching)
let redisClient;

// ScyllaDB client (for persistent feed storage)
let scyllaClient;

// RabbitMQ
let rabbitChannel;

// Service URLs
const POST_SERVICE_URL = process.env.POST_SERVICE_URL || 'http://post-service:3002';
const USER_SERVICE_URL = process.env.USER_SERVICE_URL || 'http://user-service:3001';

// ScyllaDB configuration
const SCYLLA_HOSTS = (process.env.SCYLLA_HOSTS || 'scylladb').split(',');
const SCYLLA_DATACENTER = process.env.SCYLLA_DATACENTER || 'datacenter1';
const SCYLLA_KEYSPACE = process.env.SCYLLA_KEYSPACE || 'instagram_feeds';

// Initialize connections
async function initializeConnections() {
  // Redis (for caching)
  redisClient = createClient({ url: process.env.REDIS_URL });
  redisClient.on('error', (err) => console.error('Redis Error:', err));
  await redisClient.connect();
  console.log('✅ Connected to Redis (cache layer)');

  // ScyllaDB
  await initializeScylla();
  console.log('✅ Connected to ScyllaDB (persistent storage)');

  // RabbitMQ
  const rabbitConn = await amqp.connect(process.env.RABBITMQ_URL);
  rabbitChannel = await rabbitConn.createChannel();
  
  // Set up exchange and queues
  await rabbitChannel.assertExchange('instagram_events', 'topic', { durable: true });
  
  // Create queue for feed service
  const feedQueue = await rabbitChannel.assertQueue('feed_service_queue', { durable: true });
  
  // Bind to relevant events
  await rabbitChannel.bindQueue(feedQueue.queue, 'instagram_events', 'post.created');
  await rabbitChannel.bindQueue(feedQueue.queue, 'instagram_events', 'post.deleted');
  await rabbitChannel.bindQueue(feedQueue.queue, 'instagram_events', 'user.followed');
  await rabbitChannel.bindQueue(feedQueue.queue, 'instagram_events', 'user.unfollowed');
  
  // Consume messages
  rabbitChannel.consume(feedQueue.queue, handleEvent, { noAck: false });
  
  console.log('✅ Connected to RabbitMQ');
}

// Initialize ScyllaDB and create schema
async function initializeScylla() {
  // First connect without keyspace to create it
  const tempClient = new cassandra.Client({
    contactPoints: SCYLLA_HOSTS,
    localDataCenter: SCYLLA_DATACENTER,
  });

  await tempClient.connect();

  // Create keyspace if not exists
  await tempClient.execute(`
    CREATE KEYSPACE IF NOT EXISTS ${SCYLLA_KEYSPACE}
    WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}
  `);

  await tempClient.shutdown();

  // Now connect with keyspace
  scyllaClient = new cassandra.Client({
    contactPoints: SCYLLA_HOSTS,
    localDataCenter: SCYLLA_DATACENTER,
    keyspace: SCYLLA_KEYSPACE,
  });

  await scyllaClient.connect();

  // Create tables
  // Main feed table - partitioned by user_id, clustered by created_at (descending)
  await scyllaClient.execute(`
    CREATE TABLE IF NOT EXISTS user_feeds (
      user_id UUID,
      created_at TIMESTAMP,
      post_id UUID,
      author_id UUID,
      PRIMARY KEY (user_id, created_at)
    ) WITH CLUSTERING ORDER BY (created_at DESC)
  `);

  // Activity feed table (likes, comments, follows)
  await scyllaClient.execute(`
    CREATE TABLE IF NOT EXISTS user_activity (
      user_id UUID,
      created_at TIMESTAMP,
      activity_id UUID,
      activity_type TEXT,
      actor_id UUID,
      target_id UUID,
      target_type TEXT,
      metadata TEXT,
      PRIMARY KEY (user_id, created_at)
    ) WITH CLUSTERING ORDER BY (created_at DESC)
  `);

  // Followers table for quick lookup
  await scyllaClient.execute(`
    CREATE TABLE IF NOT EXISTS user_followers (
      user_id UUID,
      follower_id UUID,
      created_at TIMESTAMP,
      PRIMARY KEY (user_id, follower_id)
    )
  `);

  // Following table for quick lookup
  await scyllaClient.execute(`
    CREATE TABLE IF NOT EXISTS user_following (
      user_id UUID,
      following_id UUID,
      created_at TIMESTAMP,
      PRIMARY KEY (user_id, following_id)
    )
  `);

  console.log('✅ ScyllaDB schema initialized');
}

// Handle events from RabbitMQ
async function handleEvent(msg) {
  try {
    const routingKey = msg.fields.routingKey;
    const data = JSON.parse(msg.content.toString());

    console.log(`📨 Received event: ${routingKey}`, data);

    switch (routingKey) {
      case 'post.created':
        await handlePostCreated(data);
        break;
      case 'post.deleted':
        await handlePostDeleted(data);
        break;
      case 'user.followed':
        await handleUserFollowed(data);
        break;
      case 'user.unfollowed':
        await handleUserUnfollowed(data);
        break;
    }

    rabbitChannel.ack(msg);
  } catch (error) {
    console.error('Error handling event:', error);
    rabbitChannel.nack(msg, false, true); // Requeue the message
  }
}

// Fan-out post to followers' feeds in ScyllaDB
async function handlePostCreated(data) {
  const { postId, userId, createdAt } = data;
  const timestamp = new Date(createdAt);
  const postUuid = cassandra.types.Uuid.fromString(postId);
  const authorUuid = cassandra.types.Uuid.fromString(userId);

  // Get user's followers from ScyllaDB
  const followersResult = await scyllaClient.execute(
    'SELECT follower_id FROM user_followers WHERE user_id = ?',
    [authorUuid],
    { prepare: true }
  );

  const followers = followersResult.rows.map(row => row.follower_id);
  
  // Also get from Redis as backup (for follows that happened before ScyllaDB)
  const redisFollowers = await redisClient.sMembers(`user:${userId}:followers`);
  
  // Combine and dedupe
  const allFollowers = new Set([
    ...followers.map(f => f.toString()),
    ...redisFollowers,
    userId // Include author's own feed
  ]);

  // Insert into each follower's feed
  const insertQuery = `
    INSERT INTO user_feeds (user_id, created_at, post_id, author_id)
    VALUES (?, ?, ?, ?)
  `;

  const insertPromises = Array.from(allFollowers).map(followerId => {
    try {
      const followerUuid = cassandra.types.Uuid.fromString(followerId);
      return scyllaClient.execute(insertQuery, [followerUuid, timestamp, postUuid, authorUuid], { prepare: true });
    } catch (e) {
      console.error(`Invalid follower UUID: ${followerId}`);
      return Promise.resolve();
    }
  });

  await Promise.all(insertPromises);

  // Invalidate Redis cache for affected users
  for (const followerId of allFollowers) {
    await redisClient.del(`feed_cache:${followerId}`);
  }

  console.log(`✅ Added post ${postId} to ${allFollowers.size} feeds (ScyllaDB)`);
}

// Remove post from feeds
async function handlePostDeleted(data) {
  const { postId, userId } = data;
  const postUuid = cassandra.types.Uuid.fromString(postId);

  // Get all users who might have this post in their feed
  // In production, you'd have a reverse index. For now, we query by author
  const authorUuid = cassandra.types.Uuid.fromString(userId);
  
  // Get followers
  const followersResult = await scyllaClient.execute(
    'SELECT follower_id FROM user_followers WHERE user_id = ?',
    [authorUuid],
    { prepare: true }
  );

  // Delete from each follower's feed
  // Note: This requires knowing the created_at. In production, you'd store this.
  // For simplicity, we'll let old posts age out or be filtered on read.
  
  console.log(`✅ Post ${postId} marked for deletion`);
}

// When user follows someone
async function handleUserFollowed(data) {
  const { followerId, followingId } = data;
  const timestamp = new Date();
  
  let followerUuid, followingUuid;
  try {
    followerUuid = cassandra.types.Uuid.fromString(followerId);
    followingUuid = cassandra.types.Uuid.fromString(followingId);
  } catch (e) {
    console.error('Invalid UUID in follow event:', e);
    return;
  }

  // Store follow relationship in ScyllaDB
  await scyllaClient.execute(
    'INSERT INTO user_followers (user_id, follower_id, created_at) VALUES (?, ?, ?)',
    [followingUuid, followerUuid, timestamp],
    { prepare: true }
  );

  await scyllaClient.execute(
    'INSERT INTO user_following (user_id, following_id, created_at) VALUES (?, ?, ?)',
    [followerUuid, followingUuid, timestamp],
    { prepare: true }
  );

  // Also store in Redis for backward compatibility
  await redisClient.sAdd(`user:${followerId}:following`, followingId);
  await redisClient.sAdd(`user:${followingId}:followers`, followerId);

  // Fetch recent posts from followed user and add to follower's feed
  try {
    const response = await axios.get(`${POST_SERVICE_URL}/api/posts/user/${followingId}?limit=20`);
    const posts = response.data.posts || [];

    const insertQuery = `
      INSERT INTO user_feeds (user_id, created_at, post_id, author_id)
      VALUES (?, ?, ?, ?)
    `;

    for (const post of posts) {
      const postTimestamp = new Date(post.created_at);
      const postUuid = cassandra.types.Uuid.fromString(post.id);
      
      await scyllaClient.execute(insertQuery, [followerUuid, postTimestamp, postUuid, followingUuid], { prepare: true });
    }

    // Invalidate cache
    await redisClient.del(`feed_cache:${followerId}`);

    console.log(`✅ Added ${posts.length} posts to ${followerId}'s feed after following ${followingId}`);
  } catch (error) {
    console.error('Error fetching posts for follow:', error.message);
  }
}

// When user unfollows someone
async function handleUserUnfollowed(data) {
  const { followerId, followingId } = data;

  let followerUuid, followingUuid;
  try {
    followerUuid = cassandra.types.Uuid.fromString(followerId);
    followingUuid = cassandra.types.Uuid.fromString(followingId);
  } catch (e) {
    console.error('Invalid UUID in unfollow event:', e);
    return;
  }

  // Remove follow relationship from ScyllaDB
  await scyllaClient.execute(
    'DELETE FROM user_followers WHERE user_id = ? AND follower_id = ?',
    [followingUuid, followerUuid],
    { prepare: true }
  );

  await scyllaClient.execute(
    'DELETE FROM user_following WHERE user_id = ? AND following_id = ?',
    [followerUuid, followingUuid],
    { prepare: true }
  );

  // Remove from Redis
  await redisClient.sRem(`user:${followerId}:following`, followingId);
  await redisClient.sRem(`user:${followingId}:followers`, followerId);

  // Invalidate cache
  await redisClient.del(`feed_cache:${followerId}`);

  console.log(`✅ Removed follow relationship: ${followerId} -> ${followingId}`);
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

// ==================
// Routes
// ==================

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'feed-service', storage: 'scylladb' });
});

// Get user's feed
app.get('/api/feed', authMiddleware, async (req, res) => {
  try {
    const { limit = 20, offset = 0 } = req.query;
    const limitInt = parseInt(limit);
    const offsetInt = parseInt(offset);
    
    // Try Redis cache first
    const cacheKey = `feed_cache:${req.user.userId}:${offsetInt}:${limitInt}`;
    const cached = await redisClient.get(cacheKey);
    
    if (cached) {
      console.log('📦 Feed served from Redis cache');
      return res.json(JSON.parse(cached));
    }

    // Query ScyllaDB
    let userUuid;
    try {
      userUuid = cassandra.types.Uuid.fromString(req.user.userId);
    } catch (e) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    // Fetch from ScyllaDB with pagination
    // Note: Cassandra doesn't support OFFSET, so we use token-based pagination in production
    const query = `
      SELECT post_id, author_id, created_at 
      FROM user_feeds 
      WHERE user_id = ? 
      LIMIT ?
    `;
    
    const result = await scyllaClient.execute(query, [userUuid, limitInt + offsetInt + 1], { prepare: true });
    
    // Skip offset rows (simple approach for demo - use paging state in production)
    const feedItems = result.rows.slice(offsetInt, offsetInt + limitInt);

    if (feedItems.length === 0) {
      return res.json({ posts: [], hasMore: false });
    }

    // Fetch full post data from Post Service
    const posts = [];
    for (const item of feedItems) {
      try {
        const response = await axios.get(`${POST_SERVICE_URL}/api/posts/${item.post_id.toString()}`, {
          headers: { Authorization: req.headers.authorization },
        });
        posts.push(response.data);
      } catch (error) {
        // Post might have been deleted, skip it
        console.log(`Post ${item.post_id} not found, skipping`);
      }
    }

    const hasMore = result.rows.length > offsetInt + limitInt;

    const responseData = {
      posts,
      hasMore,
      offset: offsetInt + posts.length,
    };

    // Cache in Redis for 2 minutes
    await redisClient.setEx(cacheKey, 120, JSON.stringify(responseData));

    res.json(responseData);
  } catch (error) {
    console.error('Get feed error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get activity feed (likes, comments, follows)
app.get('/api/feed/activity', authMiddleware, async (req, res) => {
  try {
    const { limit = 20 } = req.query;
    
    let userUuid;
    try {
      userUuid = cassandra.types.Uuid.fromString(req.user.userId);
    } catch (e) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    const query = `
      SELECT activity_id, activity_type, actor_id, target_id, target_type, metadata, created_at
      FROM user_activity
      WHERE user_id = ?
      LIMIT ?
    `;

    const result = await scyllaClient.execute(query, [userUuid, parseInt(limit)], { prepare: true });

    const activities = result.rows.map(row => ({
      id: row.activity_id.toString(),
      type: row.activity_type,
      actorId: row.actor_id.toString(),
      targetId: row.target_id.toString(),
      targetType: row.target_type,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
      createdAt: row.created_at,
    }));

    res.json({ activities });
  } catch (error) {
    console.error('Get activity feed error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get explore/discover feed
app.get('/api/feed/explore', authMiddleware, async (req, res) => {
  try {
    const { limit = 20 } = req.query;

    // Get users that this user follows
    let userUuid;
    try {
      userUuid = cassandra.types.Uuid.fromString(req.user.userId);
    } catch (e) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    const followingResult = await scyllaClient.execute(
      'SELECT following_id FROM user_following WHERE user_id = ?',
      [userUuid],
      { prepare: true }
    );

    const followingIds = new Set(followingResult.rows.map(r => r.following_id.toString()));
    followingIds.add(req.user.userId);

    // For explore, we'd typically use a recommendation engine
    // For now, return popular recent posts (simplified)
    const response = {
      posts: [],
      message: 'Explore feed - would show recommended posts from users you don\'t follow',
    };

    res.json(response);
  } catch (error) {
    console.error('Get explore feed error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Refresh feed (force rebuild from ScyllaDB)
app.post('/api/feed/refresh', authMiddleware, async (req, res) => {
  try {
    // Invalidate all cached feeds for this user
    const keys = await redisClient.keys(`feed_cache:${req.user.userId}:*`);
    if (keys.length > 0) {
      await redisClient.del(keys);
    }

    res.json({ message: 'Feed cache cleared. Next request will fetch fresh data.' });
  } catch (error) {
    console.error('Refresh feed error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get feed stats
app.get('/api/feed/stats', authMiddleware, async (req, res) => {
  try {
    let userUuid;
    try {
      userUuid = cassandra.types.Uuid.fromString(req.user.userId);
    } catch (e) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    // Count feed items (note: COUNT is expensive in Cassandra, use sparingly)
    const feedCountResult = await scyllaClient.execute(
      'SELECT COUNT(*) as count FROM user_feeds WHERE user_id = ?',
      [userUuid],
      { prepare: true }
    );

    const followingCountResult = await scyllaClient.execute(
      'SELECT COUNT(*) as count FROM user_following WHERE user_id = ?',
      [userUuid],
      { prepare: true }
    );

    const followersCountResult = await scyllaClient.execute(
      'SELECT COUNT(*) as count FROM user_followers WHERE user_id = ?',
      [userUuid],
      { prepare: true }
    );

    res.json({
      feedSize: parseInt(feedCountResult.rows[0].count.toString()),
      followingCount: parseInt(followingCountResult.rows[0].count.toString()),
      followersCount: parseInt(followersCountResult.rows[0].count.toString()),
      storage: 'scylladb',
      cache: 'redis',
    });
  } catch (error) {
    console.error('Get feed stats error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Start server
initializeConnections()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`🚀 Feed Service running on port ${PORT}`);
      console.log(`   📊 ScyllaDB: ${SCYLLA_HOSTS.join(', ')}`);
      console.log(`   📦 Redis: ${process.env.REDIS_URL}`);
    });
  })
  .catch((error) => {
    console.error('Failed to initialize:', error);
    process.exit(1);
  });
