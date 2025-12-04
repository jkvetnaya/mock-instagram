# Mock Instagram - Microservices Architecture

A complete Instagram clone built with microservices architecture, running in Docker containers. This document provides comprehensive documentation on how each service operates.

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Service Details](#service-details)
3. [Data Flow](#data-flow)
4. [Database Schemas](#database-schemas)
5. [Authentication & Authorization](#authentication--authorization)
6. [Event-Driven Architecture](#event-driven-architecture)
7. [Feed Generation Algorithm](#feed-generation-algorithm)
8. [Media Processing Pipeline](#media-processing-pipeline)
9. [Caching Strategy](#caching-strategy)
10. [API Reference](#api-reference)
11. [Quick Start](#quick-start)
12. [Development Commands](#development-commands)
13. [Scaling & Production Considerations](#scaling--production-considerations)
14. [Troubleshooting](#troubleshooting)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              CLIENT (Web/Mobile)                             │
└─────────────────────────────────────┬───────────────────────────────────────┘
                                      │ HTTP/HTTPS
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         API GATEWAY (Nginx) :8080                            │
│  • Request routing based on URL path                                         │
│  • Load balancing (round-robin)                                              │
│  • Request/response logging                                                  │
│  • File upload size limits (50MB)                                            │
└────────┬────────────────┬────────────────┬────────────────┬─────────────────┘
         │                │                │                │
         ▼                ▼                ▼                ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ User Service │  │ Post Service │  │ Media Service│  │ Feed Service │
│    :3001     │  │    :3002     │  │    :3003     │  │    :3004     │
│              │  │              │  │              │  │              │
│ • Auth       │  │ • Posts CRUD │  │ • Upload     │  │ • Timeline   │
│ • Profiles   │  │ • Comments   │  │ • Resize     │  │ • Fanout     │
│ • Follows    │  │ • Likes      │  │ • Storage    │  │ • Ranking    │
└──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘
       │                 │                 │                 │
       └─────────────────┴─────────────────┴─────────────────┘
                                   │
    ┌──────────────────────────────┼──────────────────────────────┐
    │                    ┌─────────┴─────────┐                    │
    ▼                    ▼                   ▼                    ▼
┌─────────────┐  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│ PostgreSQL  │  │  ScyllaDB   │    │    Redis    │    │  RabbitMQ   │
│   :5432     │  │   :9042     │    │   :6379     │    │ :5672/:15672│
│             │  │             │    │             │    │             │
│ • Users     │  │ • Feeds     │    │ • Cache     │    │ • Event bus │
│ • Posts     │  │ • Activity  │    │ • Sessions  │    │ • Pub/Sub   │
│ • Relations │  │ • Timelines │    │ • Hot data  │    │ • Async     │
└─────────────┘  └─────────────┘    └─────────────┘    └─────────────┘
                                           │
                        ┌──────────────────┘
                        ▼
              ┌─────────────────┐
              │      MinIO      │
              │  :9000/:9001    │
              │                 │
              │ • Image storage │
              │ • Video storage │
              │ • S3-compatible │
              └─────────────────┘
```

### Services Summary

| Service | Port | Tech Stack | Primary Responsibility |
|---------|------|------------|----------------------|
| API Gateway | 8080 | Nginx | Request routing, load balancing |
| User Service | 3001 | Node.js + Express | Authentication, user profiles, social graph |
| Post Service | 3002 | Node.js + Express | Content management, engagement |
| Media Service | 3003 | Node.js + Sharp | File upload, image processing |
| Feed Service | 3004 | Node.js + Express | Timeline generation, content ranking |
| PostgreSQL | 5432 | PostgreSQL 15 | Persistent relational data |
| ScyllaDB | 9042 | ScyllaDB | Wide-column store for feeds and activity |
| Redis | 6379 | Redis 7 | Caching, sessions, hot data |
| RabbitMQ | 5672 | RabbitMQ 3 | Async messaging, event bus |
| MinIO | 9000 | MinIO | Object storage (S3-compatible) |

### Database Architecture

This project uses a polyglot persistence approach - different databases for different use cases:

| Storage | Type | What It Stores | Why This DB |
|---------|------|----------------|-------------|
| **PostgreSQL** | Relational DB | Users, follows, posts metadata, comments, likes | ACID transactions, complex relationships, joins |
| **ScyllaDB** | Wide-column NoSQL | Feeds, activity logs, timelines | High write throughput, time-series data, horizontal scaling |
| **Redis** | In-memory cache | Session data, hot cache, rate limits | Sub-millisecond reads, ephemeral data |
| **MinIO** | Object storage | Images, videos, profile pictures | Large binary files, CDN-friendly |

### Production Alternatives

In a real production environment, you might use:

| This Project | Production Alternative | Notes |
|--------------|----------------------|-------|
| PostgreSQL | **Amazon RDS**, **Google Cloud SQL**, **CockroachDB** | Managed services reduce operational burden |
| ScyllaDB | **Apache Cassandra**, **Amazon DynamoDB**, **ScyllaDB Cloud** | Cassandra is the original, DynamoDB is fully managed |
| Redis | **Amazon ElastiCache**, **Redis Cloud**, **KeyDB** | Managed Redis with clustering |
| MinIO | **Amazon S3**, **Google Cloud Storage**, **Cloudflare R2** | True cloud object storage with CDN |
| RabbitMQ | **Amazon SQS**, **Apache Kafka**, **Google Pub/Sub** | Kafka for higher throughput, SQS for simplicity |

---

## Service Details

### 1. API Gateway (Nginx)

The API Gateway is the single entry point for all client requests.

**Responsibilities:**
- Route requests to appropriate microservices based on URL patterns
- Handle CORS headers
- Enforce request size limits (50MB for media uploads)
- Log all incoming requests
- Health check endpoint for monitoring

**Routing Rules:**
```
/api/auth/*     → User Service (:3001)
/api/users/*    → User Service (:3001)
/api/posts/*    → Post Service (:3002)
/api/comments/* → Post Service (:3002)
/api/likes/*    → Post Service (:3002)
/api/media/*    → Media Service (:3003)
/api/feed/*     → Feed Service (:3004)
```

**Request Flow:**
```
Client Request → Nginx → Parse URL → Select Upstream → Proxy Request → Return Response
```

---

### 2. User Service

Handles all user-related operations including authentication, profiles, and the social graph (follows).

**Responsibilities:**
- User registration with password hashing (bcrypt, 12 rounds)
- User authentication and JWT token generation
- Profile management (bio, profile picture URL, privacy settings)
- Social graph management (follow/unfollow)
- User search functionality

**Key Operations:**

#### Registration Flow
```
1. Client sends POST /api/auth/register with {username, email, password, fullName}
2. Validate input (check required fields)
3. Check if username/email already exists in PostgreSQL
4. Hash password using bcrypt (12 salt rounds)
5. Generate UUID for user ID
6. Insert user into PostgreSQL
7. Generate JWT token (7-day expiry)
8. Publish 'user.created' event to RabbitMQ
9. Cache user data in Redis (1 hour TTL)
10. Return user object + token to client
```

#### Follow Flow
```
1. Client sends POST /api/users/:username/follow with JWT token
2. Verify JWT token, extract userId
3. Look up target user by username
4. Validate not self-follow
5. Insert follow relationship into 'follows' table
6. Increment follower_count for target user
7. Increment following_count for current user
8. Publish 'user.followed' event to RabbitMQ
9. Invalidate Redis cache for both users
10. Feed Service receives event and updates follower's feed
```

**Database Tables:**
- `users` - User profiles and credentials
- `follows` - Social graph relationships

---

### 3. Post Service

Manages all content-related operations including posts, comments, and likes.

**Responsibilities:**
- Create, read, delete posts
- Comment management
- Like/unlike functionality
- Cursor-based pagination for feeds

**Key Operations:**

#### Create Post Flow
```
1. Client uploads media to Media Service first, receives URLs
2. Client sends POST /api/posts with {caption, mediaUrls[], location}
3. Verify JWT token
4. Validate at least one media URL provided
5. Generate UUID for post ID
6. Insert post into PostgreSQL
7. Publish 'post.created' event to RabbitMQ with {postId, userId, createdAt}
8. Feed Service receives event and fans out to followers' feeds
9. Invalidate user's posts cache in Redis
10. Return created post to client
```

#### Like Post Flow
```
1. Client sends POST /api/posts/:postId/like with JWT token
2. Verify JWT token
3. Check post exists
4. Insert into 'likes' table (ON CONFLICT DO NOTHING for idempotency)
5. Update likes_count on post (SELECT COUNT for accuracy)
6. Publish 'post.liked' event to RabbitMQ
7. Invalidate post cache in Redis
8. Return success
```

**Database Tables:**
- `posts` - Post content and metadata
- `comments` - Comments on posts
- `likes` - Post likes (user_id, post_id unique constraint)
- `comment_likes` - Comment likes

---

### 4. Media Service

Handles all file uploads and image processing.

**Responsibilities:**
- Accept file uploads (images and videos)
- Process images into multiple sizes using Sharp
- Store files in MinIO (S3-compatible storage)
- Generate presigned URLs for direct uploads
- Delete media files

**Image Processing Pipeline:**
```
1. Client sends POST /api/media/upload with multipart file
2. Multer middleware stores file in memory buffer
3. Validate file type (JPEG, PNG, GIF, WebP, MP4, MOV)
4. Validate file size (max 50MB)
5. Generate UUID for file ID
6. If image:
   a. Process with Sharp into 4 sizes:
      - thumbnail: 150x150 (cover crop)
      - small: 320x320
      - medium: 640x640
      - large: 1080x1080
   b. Convert to JPEG with 85% quality
   c. Upload each size to MinIO
   d. Upload original as well
7. If video:
   a. Upload as-is to MinIO
8. Publish 'media.uploaded' event
9. Return URLs for all sizes
```

**Image Sizes:**
| Size | Dimensions | Use Case |
|------|------------|----------|
| thumbnail | 150x150 | Grid view, avatars |
| small | 320x320 | Mobile feed |
| medium | 640x640 | Tablet/desktop feed |
| large | 1080x1080 | Full-screen view |
| original | As uploaded | Zoom/download |

**Storage Structure in MinIO:**
```
instagram-media/
├── images/
│   └── {userId}/
│       ├── {fileId}_thumbnail.jpg
│       ├── {fileId}_small.jpg
│       ├── {fileId}_medium.jpg
│       ├── {fileId}_large.jpg
│       └── {fileId}_original.{ext}
├── videos/
│   └── {userId}/
│       └── {fileId}.{ext}
└── profiles/
    └── {userId}/
        ├── {fileId}_small.jpg (50x50)
        ├── {fileId}_medium.jpg (150x150)
        └── {fileId}_large.jpg (320x320)
```

---

### 5. Feed Service

Generates and maintains personalized feeds for each user using a fan-out-on-write strategy.

**Responsibilities:**
- Maintain per-user feeds in Redis
- Fan-out new posts to followers
- Remove deleted posts from feeds
- Provide paginated feed retrieval
- Handle follow/unfollow feed updates

**Feed Generation Strategy: Fan-Out on Write**

This system uses "fan-out on write" (also called "push model"):
- When a user creates a post, it's immediately pushed to all followers' feeds
- Reading a feed is fast (just read from Redis)
- Trade-off: More write operations, but faster reads

```
┌─────────────┐     post.created      ┌─────────────────┐
│ Post Service│ ──────────────────────▶│  Feed Service   │
└─────────────┘         event          └────────┬────────┘
                                                │
                                                │ Get followers list
                                                ▼
                                       ┌─────────────────┐
                                       │     Redis       │
                                       │                 │
                                       │ feed:{user1} ◄──┼── Add post
                                       │ feed:{user2} ◄──┼── Add post  
                                       │ feed:{user3} ◄──┼── Add post
                                       │ ...             │
                                       └─────────────────┘
```

**Feed Data Structure in Redis:**
```
Key: feed:{userId}
Type: Sorted Set (ZSET)
Score: Unix timestamp (milliseconds)
Value: JSON string {"postId": "...", "userId": "...", "createdAt": "..."}

Example:
ZADD feed:user123 1699500000000 '{"postId":"abc","userId":"xyz","createdAt":"2024-..."}'
```

**Why Sorted Set?**
- Natural ordering by timestamp
- O(log N) insertion
- O(log N + M) range queries
- Easy pagination with ZRANGE
- Automatic deduplication

**Key Operations:**

#### Get Feed Flow
```
1. Client sends GET /api/feed?limit=20&offset=0 with JWT token
2. Verify JWT token, extract userId
3. Query Redis: ZRANGE feed:{userId} {offset} {offset+limit-1} REV
4. Parse JSON items to get post IDs
5. For each postId, fetch full post from Post Service
6. Filter out any deleted posts (404 responses)
7. Check if more items exist (hasMore)
8. Return {posts[], hasMore, offset}
```

#### Handle Post Created Event
```
1. Receive 'post.created' event from RabbitMQ
2. Extract {postId, userId, createdAt}
3. Get list of followers from Redis set: user:{userId}:followers
4. For each follower:
   a. ZADD feed:{followerId} {timestamp} {postJson}
   b. ZREMRANGEBYRANK feed:{followerId} 0 -1001 (keep only 1000 posts)
5. Also add to author's own feed
6. Acknowledge message
```

#### Handle Follow Event
```
1. Receive 'user.followed' event
2. Fetch last 20 posts from followed user via Post Service
3. Add all posts to follower's feed with original timestamps
4. Update Redis sets:
   - SADD user:{followerId}:following {followingId}
   - SADD user:{followingId}:followers {followerId}
```

---

## Data Flow

### Complete Post Creation Flow

```
┌──────┐         ┌─────────┐         ┌───────┐         ┌──────┐         ┌───────┐
│Client│         │ Gateway │         │ Media │         │ Post │         │ Feed  │
└──┬───┘         └────┬────┘         └───┬───┘         └──┬───┘         └───┬───┘
   │                  │                  │                │                 │
   │ 1. Upload Image  │                  │                │                 │
   │─────────────────▶│                  │                │                 │
   │                  │ 2. Route         │                │                 │
   │                  │─────────────────▶│                │                 │
   │                  │                  │                │                 │
   │                  │                  │ 3. Process &   │                 │
   │                  │                  │    Store       │                 │
   │                  │                  │────┐           │                 │
   │                  │                  │    │ MinIO     │                 │
   │                  │                  │◀───┘           │                 │
   │                  │                  │                │                 │
   │                  │ 4. Return URLs   │                │                 │
   │◀─────────────────│◀─────────────────│                │                 │
   │                  │                  │                │                 │
   │ 5. Create Post   │                  │                │                 │
   │  (with URLs)     │                  │                │                 │
   │─────────────────▶│                  │                │                 │
   │                  │ 6. Route         │                │                 │
   │                  │─────────────────────────────────▶│                 │
   │                  │                  │                │                 │
   │                  │                  │                │ 7. Save to      │
   │                  │                  │                │    PostgreSQL   │
   │                  │                  │                │────┐            │
   │                  │                  │                │◀───┘            │
   │                  │                  │                │                 │
   │                  │                  │                │ 8. Publish      │
   │                  │                  │                │    Event        │
   │                  │                  │                │────────────────▶│
   │                  │                  │                │    (RabbitMQ)   │
   │                  │                  │                │                 │
   │                  │                  │                │                 │ 9. Fan out
   │                  │                  │                │                 │    to feeds
   │                  │                  │                │                 │────┐
   │                  │                  │                │                 │◀───┘
   │                  │                  │                │                 │ (ScyllaDB)
   │                  │ 10. Return Post  │                │                 │
   │◀─────────────────│◀─────────────────────────────────│                 │
   │                  │                  │                │                 │
```

### Authentication Flow

```
┌──────────────────────────────────────────────────────────────────┐
│                        JWT Authentication                         │
└──────────────────────────────────────────────────────────────────┘

1. REGISTRATION
   Client ──POST /api/auth/register──▶ User Service
                                            │
                                            ▼
                                    ┌───────────────┐
                                    │ Validate Input│
                                    └───────┬───────┘
                                            │
                                            ▼
                                    ┌───────────────┐
                                    │ Hash Password │
                                    │ (bcrypt x12)  │
                                    └───────┬───────┘
                                            │
                                            ▼
                                    ┌───────────────┐
                                    │Store in DB    │
                                    └───────┬───────┘
                                            │
                                            ▼
                                    ┌───────────────┐
                                    │ Generate JWT  │
                                    │ (7-day expiry)│
                                    └───────┬───────┘
                                            │
   Client ◀──{user, token}─────────────────┘

2. SUBSEQUENT REQUESTS
   Client ──Authorization: Bearer {token}──▶ Service
                                               │
                                               ▼
                                       ┌───────────────┐
                                       │ Verify JWT    │
                                       │ Signature     │
                                       └───────┬───────┘
                                               │
                                    ┌──────────┴──────────┐
                                    │                     │
                                    ▼                     ▼
                              Valid Token           Invalid Token
                                    │                     │
                                    ▼                     ▼
                              Extract userId        Return 401
                              Continue request      Unauthorized
```

**JWT Payload Structure:**
```json
{
  "userId": "uuid-here",
  "username": "johndoe",
  "iat": 1699500000,
  "exp": 1700104800
}
```

---

## Database Schemas

### User Service Database (instagram_users)

```sql
-- Users table
CREATE TABLE users (
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

-- Follows table (social graph)
CREATE TABLE follows (
    id UUID PRIMARY KEY,
    follower_id UUID REFERENCES users(id) ON DELETE CASCADE,
    following_id UUID REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(follower_id, following_id)  -- Prevent duplicate follows
);

-- Indexes for performance
CREATE INDEX idx_users_username ON users(username);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_follows_follower ON follows(follower_id);
CREATE INDEX idx_follows_following ON follows(following_id);
```

### Post Service Database (instagram_posts)

```sql
-- Posts table
CREATE TABLE posts (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL,  -- References users in user-service DB
    caption TEXT,
    media_urls TEXT[] DEFAULT '{}',  -- Array of image/video URLs
    location VARCHAR(255),
    likes_count INTEGER DEFAULT 0,
    comments_count INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Comments table
CREATE TABLE comments (
    id UUID PRIMARY KEY,
    post_id UUID REFERENCES posts(id) ON DELETE CASCADE,
    user_id UUID NOT NULL,
    content TEXT NOT NULL,
    likes_count INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Likes table
CREATE TABLE likes (
    id UUID PRIMARY KEY,
    post_id UUID REFERENCES posts(id) ON DELETE CASCADE,
    user_id UUID NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(post_id, user_id)  -- One like per user per post
);

-- Comment likes table
CREATE TABLE comment_likes (
    id UUID PRIMARY KEY,
    comment_id UUID REFERENCES comments(id) ON DELETE CASCADE,
    user_id UUID NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(comment_id, user_id)
);

-- Indexes for performance
CREATE INDEX idx_posts_user ON posts(user_id);
CREATE INDEX idx_posts_created ON posts(created_at DESC);
CREATE INDEX idx_comments_post ON comments(post_id);
CREATE INDEX idx_likes_post ON likes(post_id);
CREATE INDEX idx_likes_user ON likes(user_id);
```

### Feed Service Database - ScyllaDB (instagram_feeds)

ScyllaDB uses CQL (Cassandra Query Language). Tables are designed around query patterns:

```cql
-- User feeds: What posts should appear in a user's timeline
-- Partitioned by user_id for fast lookups
-- Clustered by created_at DESC for chronological ordering
CREATE TABLE user_feeds (
    user_id UUID,
    created_at TIMESTAMP,
    post_id UUID,
    author_id UUID,
    PRIMARY KEY (user_id, created_at)
) WITH CLUSTERING ORDER BY (created_at DESC);

-- Query: Get feed for user (fast - single partition scan)
-- SELECT * FROM user_feeds WHERE user_id = ? LIMIT 20;

-- Activity feed: Notifications for likes, comments, follows
CREATE TABLE user_activity (
    user_id UUID,
    created_at TIMESTAMP,
    activity_id UUID,
    activity_type TEXT,      -- 'like', 'comment', 'follow'
    actor_id UUID,           -- Who performed the action
    target_id UUID,          -- Post ID or User ID
    target_type TEXT,        -- 'post', 'comment', 'user'
    metadata TEXT,           -- JSON for extra data
    PRIMARY KEY (user_id, created_at)
) WITH CLUSTERING ORDER BY (created_at DESC);

-- Followers lookup: Who follows a user
CREATE TABLE user_followers (
    user_id UUID,
    follower_id UUID,
    created_at TIMESTAMP,
    PRIMARY KEY (user_id, follower_id)
);

-- Following lookup: Who a user follows
CREATE TABLE user_following (
    user_id UUID,
    following_id UUID,
    created_at TIMESTAMP,
    PRIMARY KEY (user_id, following_id)
);
```

**Why ScyllaDB for Feeds?**

| Feature | Benefit |
|---------|---------|
| Partition by user_id | Each user's feed is stored together |
| Clustering by timestamp | Natural chronological ordering |
| Write-optimized | High throughput for fan-out writes |
| Horizontal scaling | Add nodes as user base grows |
| Time-series friendly | Feeds are inherently time-ordered |

---

## Event-Driven Architecture

### RabbitMQ Configuration

```
Exchange: instagram_events (topic exchange, durable)
Queue: feed_service_queue (bound to feed service)
```

### Event Catalog

| Event | Routing Key | Publisher | Consumer(s) | Payload |
|-------|-------------|-----------|-------------|---------|
| User Created | `user.created` | User Service | - | `{userId, username}` |
| User Updated | `user.updated` | User Service | - | `{userId}` |
| User Followed | `user.followed` | User Service | Feed Service | `{followerId, followingId}` |
| User Unfollowed | `user.unfollowed` | User Service | Feed Service | `{followerId, followingId}` |
| Post Created | `post.created` | Post Service | Feed Service | `{postId, userId, createdAt}` |
| Post Deleted | `post.deleted` | Post Service | Feed Service | `{postId, userId}` |
| Post Liked | `post.liked` | Post Service | - | `{postId, userId}` |
| Post Unliked | `post.unliked` | Post Service | - | `{postId, userId}` |
| Comment Created | `comment.created` | Post Service | - | `{commentId, postId, postOwnerId, commenterId}` |
| Media Uploaded | `media.uploaded` | Media Service | - | `{fileId, userId, urls, type}` |
| Media Deleted | `media.deleted` | Media Service | - | `{fileId, userId}` |
| Profile Picture Updated | `profile.picture_updated` | Media Service | - | `{userId, urls}` |

### Event Flow Diagram

```
┌────────────────┐
│  User Service  │
└───────┬────────┘
        │ user.created
        │ user.followed ─────────────────────┐
        │ user.unfollowed ───────────────────┤
        ▼                                    │
┌────────────────┐                           │
│   RabbitMQ     │                           │
│                │                           ▼
│ ┌────────────┐ │                  ┌────────────────┐
│ │  Exchange  │ │                  │  Feed Service  │
│ │  (topic)   │ │                  │                │
│ └─────┬──────┘ │                  │ • Update feeds │
│       │        │                  │ • Sync follows │
└───────┼────────┘                  └────────────────┘
        │
        │ post.created ──────────────────────┘
        │ post.deleted ──────────────────────┘
        │
┌───────┴────────┐
│  Post Service  │
└────────────────┘
```

---

## Feed Generation Algorithm

### Strategy Comparison

| Strategy | Write Cost | Read Cost | Best For |
|----------|-----------|-----------|----------|
| **Fan-out on Write** (this system) | O(followers) | O(1) | Users with <10K followers |
| Fan-out on Read | O(1) | O(following) | Celebrity accounts |
| Hybrid | Varies | Varies | Mixed user base |

### Our Implementation: Fan-out on Write

When a post is created:

```python
# Pseudocode
def handle_post_created(post_id, user_id, created_at):
    # Get all followers
    followers = redis.smembers(f"user:{user_id}:followers")
    
    # Create feed item
    feed_item = json.dumps({
        "postId": post_id,
        "userId": user_id, 
        "createdAt": created_at
    })
    
    timestamp = parse_timestamp(created_at)
    
    # Fan out to all followers
    for follower_id in followers:
        feed_key = f"feed:{follower_id}"
        
        # Add to sorted set with timestamp as score
        redis.zadd(feed_key, {feed_item: timestamp})
        
        # Trim to keep only latest 1000 posts
        redis.zremrangebyrank(feed_key, 0, -1001)
    
    # Also add to author's own feed
    redis.zadd(f"feed:{user_id}", {feed_item: timestamp})
```

### Feed Retrieval

```python
# Pseudocode
def get_feed(user_id, limit=20, offset=0):
    feed_key = f"feed:{user_id}"
    
    # Get items in reverse chronological order
    items = redis.zrange(feed_key, offset, offset + limit - 1, desc=True)
    
    posts = []
    for item in items:
        data = json.loads(item)
        # Fetch full post from Post Service
        post = post_service.get_post(data["postId"])
        if post:  # Skip deleted posts
            posts.append(post)
    
    total = redis.zcard(feed_key)
    has_more = (offset + len(posts)) < total
    
    return {
        "posts": posts,
        "hasMore": has_more,
        "offset": offset + len(posts)
    }
```

---

## Caching Strategy

### Redis Key Patterns

| Pattern | Data Type | TTL | Purpose |
|---------|-----------|-----|---------|
| `user:{userId}` | String (JSON) | 1 hour | User profile cache |
| `post:{postId}` | String (JSON) | 5 min | Post data cache |
| `feed:{userId}` | Sorted Set | None | User's feed (persistent) |
| `user:{userId}:following` | Set | None | List of followed user IDs |
| `user:{userId}:followers` | Set | None | List of follower user IDs |
| `user:{userId}:posts` | String | 5 min | Cached user posts list |

### Cache Invalidation Strategy

```
Write-Through with Invalidation:

1. On user profile update:
   - Update PostgreSQL
   - DELETE user:{userId} from Redis
   - Next read will cache fresh data

2. On post update:
   - Update PostgreSQL  
   - DELETE post:{postId} from Redis

3. On follow/unfollow:
   - Update PostgreSQL
   - DELETE user caches for both users
   - UPDATE Redis sets (following/followers)
   - UPDATE feeds via events
```

### Cache-Aside Pattern (Read Path)

```
┌────────┐     1. GET user:123     ┌─────────┐
│ Service│ ───────────────────────▶│  Redis  │
└────┬───┘                         └────┬────┘
     │                                  │
     │         2a. Cache HIT ◀──────────┘
     │             Return data
     │
     │         2b. Cache MISS
     │                │
     │                ▼
     │     ┌─────────────────────┐
     │     │  Query PostgreSQL   │
     │     └──────────┬──────────┘
     │                │
     │                ▼
     │     ┌─────────────────────┐
     │     │ SET user:123 (1hr)  │
     │     └──────────┬──────────┘
     │                │
     │◀───────────────┘
     │     Return data
```

---

## API Reference

### Authentication

#### Register User
```http
POST /api/auth/register
Content-Type: application/json

{
  "username": "johndoe",
  "email": "john@example.com",
  "password": "securepassword123",
  "fullName": "John Doe"
}
```

**Response (201 Created):**
```json
{
  "user": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "username": "johndoe",
    "email": "john@example.com",
    "full_name": "John Doe",
    "created_at": "2024-01-15T10:30:00Z"
  },
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

#### Login
```http
POST /api/auth/login
Content-Type: application/json

{
  "username": "johndoe",
  "password": "securepassword123"
}
```

**Response (200 OK):**
```json
{
  "user": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "username": "johndoe",
    "email": "john@example.com",
    "full_name": "John Doe",
    "bio": null,
    "profile_picture_url": null,
    "followers_count": 0,
    "following_count": 0,
    "posts_count": 0
  },
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

### Users

#### Get Current User Profile
```http
GET /api/users/me
Authorization: Bearer {token}
```

#### Get User by Username
```http
GET /api/users/:username
```

#### Update Profile
```http
PUT /api/users/me
Authorization: Bearer {token}
Content-Type: application/json

{
  "fullName": "John D.",
  "bio": "Photography enthusiast 📷",
  "isPrivate": false
}
```

#### Follow User
```http
POST /api/users/:username/follow
Authorization: Bearer {token}
```

#### Unfollow User
```http
DELETE /api/users/:username/follow
Authorization: Bearer {token}
```

#### Get Followers
```http
GET /api/users/:username/followers
```

#### Get Following
```http
GET /api/users/:username/following
```

#### Search Users
```http
GET /api/users?q=john&limit=20
```

### Posts

#### Create Post
```http
POST /api/posts
Authorization: Bearer {token}
Content-Type: application/json

{
  "caption": "Beautiful sunset! 🌅",
  "mediaUrls": [
    "http://localhost:9000/instagram-media/images/user123/abc_large.jpg"
  ],
  "location": "San Francisco, CA"
}
```

**Response (201 Created):**
```json
{
  "id": "660e8400-e29b-41d4-a716-446655440001",
  "user_id": "550e8400-e29b-41d4-a716-446655440000",
  "caption": "Beautiful sunset! 🌅",
  "media_urls": ["http://..."],
  "location": "San Francisco, CA",
  "likes_count": 0,
  "comments_count": 0,
  "created_at": "2024-01-15T18:30:00Z"
}
```

#### Get Post
```http
GET /api/posts/:postId
Authorization: Bearer {token}  # Optional
```

#### Get User's Posts
```http
GET /api/posts/user/:userId?cursor=2024-01-15T00:00:00Z&limit=20
```

#### Delete Post
```http
DELETE /api/posts/:postId
Authorization: Bearer {token}
```

#### Like Post
```http
POST /api/posts/:postId/like
Authorization: Bearer {token}
```

#### Unlike Post
```http
DELETE /api/posts/:postId/like
Authorization: Bearer {token}
```

#### Add Comment
```http
POST /api/posts/:postId/comments
Authorization: Bearer {token}
Content-Type: application/json

{
  "content": "Amazing shot! 🔥"
}
```

#### Get Comments
```http
GET /api/posts/:postId/comments?cursor=2024-01-15T00:00:00Z&limit=20
```

### Media

#### Upload Single File
```http
POST /api/media/upload
Authorization: Bearer {token}
Content-Type: multipart/form-data

file: (binary)
```

**Response (201 Created):**
```json
{
  "id": "770e8400-e29b-41d4-a716-446655440002",
  "type": "image",
  "urls": {
    "thumbnail": "http://localhost:9000/instagram-media/images/user123/770e..._thumbnail.jpg",
    "small": "http://localhost:9000/instagram-media/images/user123/770e..._small.jpg",
    "medium": "http://localhost:9000/instagram-media/images/user123/770e..._medium.jpg",
    "large": "http://localhost:9000/instagram-media/images/user123/770e..._large.jpg",
    "original": "http://localhost:9000/instagram-media/images/user123/770e..._original.jpg"
  }
}
```

#### Upload Multiple Files
```http
POST /api/media/upload/multiple
Authorization: Bearer {token}
Content-Type: multipart/form-data

files: (binary)
files: (binary)
...
```

#### Upload Profile Picture
```http
POST /api/media/profile-picture
Authorization: Bearer {token}
Content-Type: multipart/form-data

file: (binary)
```

### Feed

#### Get User Feed
```http
GET /api/feed?limit=20&offset=0
Authorization: Bearer {token}
```

**Response (200 OK):**
```json
{
  "posts": [
    {
      "id": "...",
      "user_id": "...",
      "caption": "...",
      "media_urls": ["..."],
      "likes_count": 42,
      "comments_count": 5,
      "created_at": "2024-01-15T18:30:00Z",
      "liked_by_user": true
    }
  ],
  "hasMore": true,
  "offset": 20
}
```

#### Get Explore Feed
```http
GET /api/feed/explore?limit=20&offset=0
Authorization: Bearer {token}
```

#### Refresh Feed
```http
POST /api/feed/refresh
Authorization: Bearer {token}
```

#### Get Feed Stats
```http
GET /api/feed/stats
Authorization: Bearer {token}
```

**Response:**
```json
{
  "feedSize": 847,
  "followingCount": 125
}
```

---

## Quick Start

### 1. Start All Services

```bash
# Using the helper script
./start.sh

# Or manually
docker compose up -d --build
```

### 2. Verify Services

```bash
# Check container status
docker compose ps

# Check API gateway health
curl http://localhost:8080/health

# Expected: {"status": "healthy", "service": "api-gateway"}
```

### 3. Test the API

```bash
# Register a user
curl -X POST http://localhost:8080/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "username": "testuser",
    "email": "test@example.com",
    "password": "password123",
    "fullName": "Test User"
  }'

# Save the token from response, then:
TOKEN="your-token-here"

# Get profile
curl http://localhost:8080/api/users/me \
  -H "Authorization: Bearer $TOKEN"

# Create a post
curl -X POST http://localhost:8080/api/posts \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "caption": "Hello Instagram!",
    "mediaUrls": ["http://example.com/image.jpg"]
  }'
```

### 4. Access Management UIs

- **RabbitMQ Management**: http://localhost:15672
  - Username: `instagram`
  - Password: `instagram123`

- **MinIO Console**: http://localhost:9001
  - Username: `minioadmin`
  - Password: `minioadmin123`

- **ScyllaDB**: Connect via cqlsh
  ```bash
  docker compose exec scylladb cqlsh
  ```

---

## Development Commands

### Start/Stop Services

```bash
# Start all services
./start.sh

# Stop all services (keeps data)
./stop.sh

# Stop and remove all data (clean reset)
./stop.sh -v
```

### Logs & Debugging

```bash
# View logs for all services
docker compose logs -f

# View logs for specific service
docker compose logs -f user-service

# Restart a specific service
docker compose restart post-service

# Rebuild a specific service
docker compose build user-service
docker compose up -d user-service

# Execute command in container
docker compose exec postgres psql -U instagram -d instagram_users

# Check Redis data
docker compose exec redis redis-cli
> KEYS *
> GET feed_cache:user123:0:20

# Check RabbitMQ queues
docker compose exec rabbitmq rabbitmqctl list_queues

# Check ScyllaDB data
docker compose exec scylladb cqlsh
> USE instagram_feeds;
> SELECT * FROM user_feeds WHERE user_id = <uuid> LIMIT 10;
> SELECT * FROM user_followers WHERE user_id = <uuid>;
> DESCRIBE TABLES;
```

---

## Scaling & Production Considerations

### Horizontal Scaling

```bash
# Scale post service to 3 instances
docker compose up -d --scale post-service=3
```

For load balancing, update `nginx.conf`:
```nginx
upstream post_service {
    least_conn;  # Use least connections algorithm
    server post-service:3002;
    # Docker Compose automatically load balances
}
```

### Production Checklist

1. **Security**
   - [ ] Change all default passwords
   - [ ] Use strong JWT_SECRET (256+ bits)
   - [ ] Enable HTTPS at gateway
   - [ ] Implement rate limiting
   - [ ] Add input validation/sanitization

2. **Database**
   - [ ] Set up PostgreSQL replication
   - [ ] Configure connection pooling (PgBouncer)
   - [ ] Set up automated backups
   - [ ] Add database indexes based on query patterns

3. **Caching**
   - [ ] Set up Redis Cluster or Sentinel
   - [ ] Tune Redis memory limits
   - [ ] Configure eviction policies

4. **Messaging**
   - [ ] Set up RabbitMQ clustering
   - [ ] Configure message persistence
   - [ ] Add dead letter queues

5. **Storage**
   - [ ] Set up MinIO in distributed mode
   - [ ] Configure CDN for media delivery
   - [ ] Implement storage lifecycle policies

6. **Monitoring**
   - [ ] Add Prometheus metrics
   - [ ] Set up Grafana dashboards
   - [ ] Configure alerting
   - [ ] Add distributed tracing (Jaeger)

7. **Resilience**
   - [ ] Add circuit breakers
   - [ ] Implement retry logic with backoff
   - [ ] Add health checks for all services
   - [ ] Configure container resource limits

---

## Troubleshooting

### Services Not Starting

```bash
# Check logs for errors
docker compose logs

# Check specific service
docker compose logs user-service

# Ensure healthchecks pass
docker compose ps
```

### Database Connection Issues

```bash
# Check if PostgreSQL is ready
docker compose exec postgres pg_isready -U instagram

# Connect to database directly
docker compose exec postgres psql -U instagram -d instagram_users

# List tables
\dt
```

### RabbitMQ Issues

```bash
# Check RabbitMQ status
docker compose exec rabbitmq rabbitmq-diagnostics ping

# List queues and messages
docker compose exec rabbitmq rabbitmqctl list_queues name messages

# Check exchange bindings
docker compose exec rabbitmq rabbitmqctl list_bindings
```

### Redis Issues

```bash
# Connect to Redis CLI
docker compose exec redis redis-cli

# Check memory usage
INFO memory

# List all keys
KEYS *

# Check cache for a user's feed
GET feed_cache:user-id-here:0:20
```

### ScyllaDB Issues

```bash
# Connect to ScyllaDB
docker compose exec scylladb cqlsh

# Check cluster status
docker compose exec scylladb nodetool status

# Check if keyspace exists
USE instagram_feeds;
DESCRIBE KEYSPACE instagram_feeds;

# Check table data
SELECT * FROM user_feeds LIMIT 5;

# Check ScyllaDB logs
docker compose logs scylladb
```

**Note:** ScyllaDB takes ~60 seconds to start up. The healthcheck has a `start_period: 60s` to account for this.

### MinIO Issues

```bash
# Check bucket exists
docker compose exec minio mc ls local/instagram-media

# Check MinIO health
curl http://localhost:9000/minio/health/live
```

### Common Errors

| Error | Cause | Solution |
|-------|-------|----------|
| `ECONNREFUSED` | Service not ready | Wait for healthchecks, check logs |
| `401 Unauthorized` | Invalid/expired token | Re-login to get new token |
| `409 Conflict` | Duplicate username/email | Use different credentials |
| `413 Payload Too Large` | File exceeds 50MB | Compress or resize before upload |
| `500 Internal Server Error` | Service crash | Check logs, restart service |

---

## Project Structure

```
mock-instagram/
├── docker-compose.yml          # Service orchestration
├── README.md                   # This file
├── start.sh                    # Start all services
├── stop.sh                     # Stop all services
├── api-gateway/
│   ├── Dockerfile              # Nginx container
│   └── nginx.conf              # Routing configuration
├── user-service/
│   ├── Dockerfile
│   ├── package.json
│   └── src/
│       └── index.js            # Auth, profiles, follows
├── post-service/
│   ├── Dockerfile
│   ├── package.json
│   └── src/
│       └── index.js            # Posts, comments, likes
├── media-service/
│   ├── Dockerfile
│   ├── package.json
│   └── src/
│       └── index.js            # Upload, processing, storage
├── feed-service/
│   ├── Dockerfile
│   ├── package.json
│   └── src/
│       └── index.js            # Timeline generation
├── docker/
│   └── postgres-init/
│       └── 01-create-databases.sh
└── scripts/
    └── test-api.sh             # API test script
```

---

## License

MIT License - Feel free to use for learning and development.
