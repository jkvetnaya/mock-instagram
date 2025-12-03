const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const multer = require('multer');
const sharp = require('sharp');
const Minio = require('minio');
const amqp = require('amqplib');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3003;

// Middleware
app.use(cors());
app.use(helmet());
app.use(morgan('combined'));
app.use(express.json());

// Multer configuration for file uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedMimes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'video/quicktime'];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type'), false);
    }
  },
});

// MinIO client
const minioClient = new Minio.Client({
  endPoint: process.env.MINIO_ENDPOINT || 'minio',
  port: parseInt(process.env.MINIO_PORT) || 9000,
  useSSL: false,
  accessKey: process.env.MINIO_ACCESS_KEY || 'minioadmin',
  secretKey: process.env.MINIO_SECRET_KEY || 'minioadmin123',
});

const BUCKET_NAME = process.env.MINIO_BUCKET || 'instagram-media';

// RabbitMQ
let rabbitChannel;

// Initialize connections
async function initializeConnections() {
  // Ensure bucket exists
  const bucketExists = await minioClient.bucketExists(BUCKET_NAME);
  if (!bucketExists) {
    await minioClient.makeBucket(BUCKET_NAME);
    console.log(`✅ Created bucket: ${BUCKET_NAME}`);
    
    // Set bucket policy to allow public read
    const policy = {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: { AWS: ['*'] },
          Action: ['s3:GetObject'],
          Resource: [`arn:aws:s3:::${BUCKET_NAME}/*`],
        },
      ],
    };
    await minioClient.setBucketPolicy(BUCKET_NAME, JSON.stringify(policy));
  }
  console.log('✅ Connected to MinIO');

  // RabbitMQ
  const rabbitConn = await amqp.connect(process.env.RABBITMQ_URL);
  rabbitChannel = await rabbitConn.createChannel();
  await rabbitChannel.assertExchange('instagram_events', 'topic', { durable: true });
  console.log('✅ Connected to RabbitMQ');
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

// Image processing options
const IMAGE_SIZES = {
  thumbnail: { width: 150, height: 150 },
  small: { width: 320, height: 320 },
  medium: { width: 640, height: 640 },
  large: { width: 1080, height: 1080 },
};

// ==================
// Routes
// ==================

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'media-service' });
});

// Upload single image
app.post('/api/media/upload', authMiddleware, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    const fileId = uuidv4();
    const fileExt = path.extname(req.file.originalname) || '.jpg';
    const isImage = req.file.mimetype.startsWith('image/');
    const isVideo = req.file.mimetype.startsWith('video/');

    const uploadedUrls = {};

    if (isImage) {
      // Process and upload different sizes
      for (const [size, dimensions] of Object.entries(IMAGE_SIZES)) {
        const processedBuffer = await sharp(req.file.buffer)
          .resize(dimensions.width, dimensions.height, {
            fit: 'cover',
            position: 'center',
          })
          .jpeg({ quality: 85 })
          .toBuffer();

        const objectName = `images/${req.user.userId}/${fileId}_${size}.jpg`;
        
        await minioClient.putObject(
          BUCKET_NAME,
          objectName,
          processedBuffer,
          processedBuffer.length,
          { 'Content-Type': 'image/jpeg' }
        );

        uploadedUrls[size] = `http://localhost:9000/${BUCKET_NAME}/${objectName}`;
      }

      // Also upload original
      const originalName = `images/${req.user.userId}/${fileId}_original${fileExt}`;
      await minioClient.putObject(
        BUCKET_NAME,
        originalName,
        req.file.buffer,
        req.file.size,
        { 'Content-Type': req.file.mimetype }
      );
      uploadedUrls.original = `http://localhost:9000/${BUCKET_NAME}/${originalName}`;

    } else if (isVideo) {
      // Upload video as-is
      const videoName = `videos/${req.user.userId}/${fileId}${fileExt}`;
      await minioClient.putObject(
        BUCKET_NAME,
        videoName,
        req.file.buffer,
        req.file.size,
        { 'Content-Type': req.file.mimetype }
      );
      uploadedUrls.video = `http://localhost:9000/${BUCKET_NAME}/${videoName}`;
    }

    // Publish event
    publishEvent('media.uploaded', {
      fileId,
      userId: req.user.userId,
      urls: uploadedUrls,
      type: isImage ? 'image' : 'video',
    });

    res.status(201).json({
      id: fileId,
      type: isImage ? 'image' : 'video',
      urls: uploadedUrls,
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Failed to upload file' });
  }
});

// Upload multiple images
app.post('/api/media/upload/multiple', authMiddleware, upload.array('files', 10), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files provided' });
    }

    const uploadResults = [];

    for (const file of req.files) {
      const fileId = uuidv4();
      const fileExt = path.extname(file.originalname) || '.jpg';
      const isImage = file.mimetype.startsWith('image/');

      const uploadedUrls = {};

      if (isImage) {
        // Process and upload different sizes
        for (const [size, dimensions] of Object.entries(IMAGE_SIZES)) {
          const processedBuffer = await sharp(file.buffer)
            .resize(dimensions.width, dimensions.height, {
              fit: 'cover',
              position: 'center',
            })
            .jpeg({ quality: 85 })
            .toBuffer();

          const objectName = `images/${req.user.userId}/${fileId}_${size}.jpg`;
          
          await minioClient.putObject(
            BUCKET_NAME,
            objectName,
            processedBuffer,
            processedBuffer.length,
            { 'Content-Type': 'image/jpeg' }
          );

          uploadedUrls[size] = `http://localhost:9000/${BUCKET_NAME}/${objectName}`;
        }
      } else {
        // Upload video
        const videoName = `videos/${req.user.userId}/${fileId}${fileExt}`;
        await minioClient.putObject(
          BUCKET_NAME,
          videoName,
          file.buffer,
          file.size,
          { 'Content-Type': file.mimetype }
        );
        uploadedUrls.video = `http://localhost:9000/${BUCKET_NAME}/${videoName}`;
      }

      uploadResults.push({
        id: fileId,
        type: isImage ? 'image' : 'video',
        urls: uploadedUrls,
      });
    }

    // Publish event
    publishEvent('media.batch_uploaded', {
      userId: req.user.userId,
      count: uploadResults.length,
    });

    res.status(201).json({ uploads: uploadResults });
  } catch (error) {
    console.error('Multiple upload error:', error);
    res.status(500).json({ error: 'Failed to upload files' });
  }
});

// Upload profile picture
app.post('/api/media/profile-picture', authMiddleware, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    if (!req.file.mimetype.startsWith('image/')) {
      return res.status(400).json({ error: 'Profile picture must be an image' });
    }

    const fileId = uuidv4();
    const uploadedUrls = {};

    // Create profile picture sizes
    const profileSizes = {
      small: { width: 50, height: 50 },
      medium: { width: 150, height: 150 },
      large: { width: 320, height: 320 },
    };

    for (const [size, dimensions] of Object.entries(profileSizes)) {
      const processedBuffer = await sharp(req.file.buffer)
        .resize(dimensions.width, dimensions.height, {
          fit: 'cover',
          position: 'center',
        })
        .jpeg({ quality: 90 })
        .toBuffer();

      const objectName = `profiles/${req.user.userId}/${fileId}_${size}.jpg`;
      
      await minioClient.putObject(
        BUCKET_NAME,
        objectName,
        processedBuffer,
        processedBuffer.length,
        { 'Content-Type': 'image/jpeg' }
      );

      uploadedUrls[size] = `http://localhost:9000/${BUCKET_NAME}/${objectName}`;
    }

    // Publish event
    publishEvent('profile.picture_updated', {
      userId: req.user.userId,
      urls: uploadedUrls,
    });

    res.status(201).json({
      id: fileId,
      urls: uploadedUrls,
    });
  } catch (error) {
    console.error('Profile picture upload error:', error);
    res.status(500).json({ error: 'Failed to upload profile picture' });
  }
});

// Delete media
app.delete('/api/media/:fileId', authMiddleware, async (req, res) => {
  try {
    const { fileId } = req.params;
    const prefix = `images/${req.user.userId}/${fileId}`;

    // List and delete all objects with this prefix
    const objectsStream = minioClient.listObjects(BUCKET_NAME, prefix, true);
    const objectsToDelete = [];

    for await (const obj of objectsStream) {
      objectsToDelete.push(obj.name);
    }

    // Also check videos
    const videoPrefix = `videos/${req.user.userId}/${fileId}`;
    const videosStream = minioClient.listObjects(BUCKET_NAME, videoPrefix, true);

    for await (const obj of videosStream) {
      objectsToDelete.push(obj.name);
    }

    if (objectsToDelete.length === 0) {
      return res.status(404).json({ error: 'Media not found' });
    }

    // Delete all objects
    await minioClient.removeObjects(BUCKET_NAME, objectsToDelete);

    // Publish event
    publishEvent('media.deleted', {
      fileId,
      userId: req.user.userId,
    });

    res.json({ message: 'Media deleted successfully' });
  } catch (error) {
    console.error('Delete media error:', error);
    res.status(500).json({ error: 'Failed to delete media' });
  }
});

// Get presigned URL for direct upload (advanced usage)
app.post('/api/media/presigned-url', authMiddleware, async (req, res) => {
  try {
    const { filename, contentType } = req.body;

    if (!filename || !contentType) {
      return res.status(400).json({ error: 'filename and contentType are required' });
    }

    const fileId = uuidv4();
    const fileExt = path.extname(filename);
    const objectName = `uploads/${req.user.userId}/${fileId}${fileExt}`;

    const presignedUrl = await minioClient.presignedPutObject(
      BUCKET_NAME,
      objectName,
      60 * 60 // 1 hour expiry
    );

    res.json({
      uploadUrl: presignedUrl,
      fileId,
      objectName,
    });
  } catch (error) {
    console.error('Presigned URL error:', error);
    res.status(500).json({ error: 'Failed to generate presigned URL' });
  }
});

// Error handler for multer
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large. Maximum size is 50MB' });
    }
    return res.status(400).json({ error: error.message });
  }
  
  if (error.message === 'Invalid file type') {
    return res.status(400).json({ error: 'Invalid file type. Allowed: JPEG, PNG, GIF, WebP, MP4, MOV' });
  }

  console.error('Unhandled error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
initializeConnections()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`🚀 Media Service running on port ${PORT}`);
    });
  })
  .catch((error) => {
    console.error('Failed to initialize:', error);
    process.exit(1);
  });
