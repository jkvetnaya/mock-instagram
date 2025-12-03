const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { createClient } = require('redis');
const amqp = require('amqplib');
const jwt = require('jsonwebtoken');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3004;

// Middleware
app.use(cors());
app.use(helmet());
app.use(morgan('combined'));
app.use(express.json());

// Redis client
let redisClient;

// RabbitMQ
let rabbitChannel;

// Service URLs
const POST_SERVICE_URL = process.env.POST_SERVICE_URL || 'http://post-service:3002';
const USER_SERVICE_URL = process.env.USER_SERVICE_URL || 'http://user-service:3001';

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

// Fan-out post to followers' feeds
async function handlePostCreated(data) {
  const { postId, userId, createdAt } = data;
  
  // Get user's followers from cache or API
  const followersCacheKey = `user:${userId}:followers`;
  let followers = await redisClient.sMembers(followersCacheKey);
  
  if (followers.length === 0) {
    // Fetch from user service (in a real system, you'd have a more efficient way)
    // For now, we'll just add the post to the user's own feed
    followers = [userId];
  }
  
  // Add post to each follower's feed (using sorted set with timestamp as score)
  const timestamp = new Date(createdAt).getTime();
  const feedItem = JSON.stringify({ postId, userId, createdAt });
  
  for (const followerId of followers) {
    const feedKey = `feed:${followerId}`;
    await redisClient.zAdd(feedKey, { score: timestamp, value: feedItem });
    
    // Keep only last 1000 posts in feed
    await redisClient.zRemRangeByRank(feedKey, 0, -1001);
  }
  
  // Also add to user's own feed
  const ownFeedKey = `feed:${userId}`;
  await redisClient.zAdd(ownFeedKey, { score: timestamp, value: feedItem });
  await redisClient.zRemRangeByRank(ownFeedKey, 0, -1001);
  
  console.log(`✅ Added post ${postId} to feeds`);
}

// Remove post from feeds
async function handlePostDeleted(data) {
  const { postId, userId } = data;
  
  // Get all feeds that might have this post
  const keys = await redisClient.keys('feed:*');
  
  for (const feedKey of keys) {
    // Get all items and filter out the deleted post
    const items = await redisClient.zRange(feedKey, 0, -1);
    for (const item of items) {
      try {
        const parsed = JSON.parse(item);
        if (parsed.postId === postId) {
          await redisClient.zRem(feedKey, item);
        }
      } catch (e) {
        // Skip invalid items
      }
    }
  }
  
  console.log(`✅ Removed post ${postId} from feeds`);
}

// When user follows someone, add their recent posts to feed
async function handleUserFollowed(data) {
  const { followerId, followingId } = data;
  
  // Add following to follower's following set
  await redisClient.sAdd(`user:${followerId}:following`, followingId);
  
  // Add follower to following's followers set
  await redisClient.sAdd(`user:${followingId}:followers`, followerId);
  
  // Fetch recent posts from the followed user and add to follower's feed
  try {
    const response = await axios.get(`${POST_SERVICE_URL}/api/posts/user/${followingId}?limit=20`);
    const posts = response.data.posts || [];
    
    const feedKey = `feed:${followerId}`;
    
    for (const post of posts) {
      const timestamp = new Date(post.created_at).getTime();
      const feedItem = JSON.stringify({
        postId: post.id,
        userId: post.user_id,
        createdAt: post.created_at,
      });
      
      await redisClient.zAdd(feedKey, { score: timestamp, value: feedItem });
    }
    
    // Keep only last 1000 posts
    await redisClient.zRemRangeByRank(feedKey, 0, -1001);
    
    console.log(`✅ Added ${posts.length} posts to ${followerId}'s feed after following ${followingId}`);
  } catch (error) {
    console.error('Error fetching posts for follow:', error.message);
  }
}

// When user unfollows someone, remove their posts from feed
async function handleUserUnfollowed(data) {
  const { followerId, followingId } = data;
  
  // Remove from sets
  await redisClient.sRem(`user:${followerId}:following`, followingId);
  await redisClient.sRem(`user:${followingId}:followers`, followerId);
  
  // Remove posts from unfollowed user from feed
  const feedKey = `feed:${followerId}`;
  const items = await redisClient.zRange(feedKey, 0, -1);
  
  for (const item of items) {
    try {
      const parsed = JSON.parse(item);
      if (parsed.userId === followingId) {
        await redisClient.zRem(feedKey, item);
      }
    } catch (e) {
      // Skip invalid items
    }
  }
  
  console.log(`✅ Removed ${followingId}'s posts from ${followerId}'s feed`);
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
  res.json({ status: 'healthy', service: 'feed-service' });
});

// Get user's feed
app.get('/api/feed', authMiddleware, async (req, res) => {
  try {
    const { limit = 20, offset = 0 } = req.query;
    const feedKey = `feed:${req.user.userId}`;
    
    // Get feed items from Redis (sorted by timestamp, descending)
    const start = parseInt(offset);
    const end = start + parseInt(limit) - 1;
    
    const feedItems = await redisClient.zRange(feedKey, start, end, { REV: true });
    
    if (feedItems.length === 0) {
      return res.json({ posts: [], hasMore: false });
    }
    
    // Parse feed items and fetch full post data
    const postIds = feedItems.map(item => {
      try {
        return JSON.parse(item).postId;
      } catch (e) {
        return null;
      }
    }).filter(Boolean);
    
    // Fetch posts from post service
    const posts = [];
    for (const postId of postIds) {
      try {
        const response = await axios.get(`${POST_SERVICE_URL}/api/posts/${postId}`, {
          headers: { Authorization: req.headers.authorization },
        });
        posts.push(response.data);
      } catch (error) {
        // Post might have been deleted, skip it
        console.log(`Post ${postId} not found, skipping`);
      }
    }
    
    // Check if there are more items
    const totalItems = await redisClient.zCard(feedKey);
    const hasMore = (start + posts.length) < totalItems;
    
    res.json({
      posts,
      hasMore,
      offset: start + posts.length,
    });
  } catch (error) {
    console.error('Get feed error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get explore/discover feed (posts from users you don't follow)
app.get('/api/feed/explore', authMiddleware, async (req, res) => {
  try {
    const { limit = 20, offset = 0 } = req.query;
    
    // Get users that this user follows
    const following = await redisClient.sMembers(`user:${req.user.userId}:following`);
    following.push(req.user.userId); // Exclude own posts too
    
    // For simplicity, we'll use a cached explore feed
    // In production, you'd have a more sophisticated algorithm
    const exploreKey = 'feed:explore';
    
    const start = parseInt(offset);
    const end = start + parseInt(limit) - 1;
    
    const feedItems = await redisClient.zRange(exploreKey, start, end, { REV: true });
    
    // Filter out posts from followed users and fetch full data
    const posts = [];
    for (const item of feedItems) {
      try {
        const parsed = JSON.parse(item);
        if (!following.includes(parsed.userId)) {
          const response = await axios.get(`${POST_SERVICE_URL}/api/posts/${parsed.postId}`, {
            headers: { Authorization: req.headers.authorization },
          });
          posts.push(response.data);
        }
      } catch (error) {
        // Skip invalid items
      }
      
      if (posts.length >= parseInt(limit)) break;
    }
    
    res.json({
      posts,
      offset: start + posts.length,
    });
  } catch (error) {
    console.error('Get explore feed error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Refresh feed (force rebuild)
app.post('/api/feed/refresh', authMiddleware, async (req, res) => {
  try {
    const feedKey = `feed:${req.user.userId}`;
    
    // Get list of users this user follows
    const following = await redisClient.sMembers(`user:${req.user.userId}:following`);
    
    // Clear current feed
    await redisClient.del(feedKey);
    
    // Fetch recent posts from each followed user
    for (const userId of following) {
      try {
        const response = await axios.get(`${POST_SERVICE_URL}/api/posts/user/${userId}?limit=50`);
        const posts = response.data.posts || [];
        
        for (const post of posts) {
          const timestamp = new Date(post.created_at).getTime();
          const feedItem = JSON.stringify({
            postId: post.id,
            userId: post.user_id,
            createdAt: post.created_at,
          });
          
          await redisClient.zAdd(feedKey, { score: timestamp, value: feedItem });
        }
      } catch (error) {
        console.error(`Error fetching posts for user ${userId}:`, error.message);
      }
    }
    
    // Also add user's own posts
    try {
      const response = await axios.get(`${POST_SERVICE_URL}/api/posts/user/${req.user.userId}?limit=50`);
      const posts = response.data.posts || [];
      
      for (const post of posts) {
        const timestamp = new Date(post.created_at).getTime();
        const feedItem = JSON.stringify({
          postId: post.id,
          userId: post.user_id,
          createdAt: post.created_at,
        });
        
        await redisClient.zAdd(feedKey, { score: timestamp, value: feedItem });
      }
    } catch (error) {
      console.error('Error fetching own posts:', error.message);
    }
    
    // Keep only last 1000 posts
    await redisClient.zRemRangeByRank(feedKey, 0, -1001);
    
    const feedSize = await redisClient.zCard(feedKey);
    
    res.json({ 
      message: 'Feed refreshed successfully',
      itemCount: feedSize,
    });
  } catch (error) {
    console.error('Refresh feed error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get feed stats
app.get('/api/feed/stats', authMiddleware, async (req, res) => {
  try {
    const feedKey = `feed:${req.user.userId}`;
    const followingKey = `user:${req.user.userId}:following`;
    
    const [feedSize, followingCount] = await Promise.all([
      redisClient.zCard(feedKey),
      redisClient.sCard(followingKey),
    ]);
    
    res.json({
      feedSize,
      followingCount,
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
    });
  })
  .catch((error) => {
    console.error('Failed to initialize:', error);
    process.exit(1);
  });
