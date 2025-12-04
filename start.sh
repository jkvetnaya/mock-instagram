#!/bin/bash

echo "🚀 Starting Mock Instagram..."
docker compose up -d

echo ""
echo "✅ Services started. Checking status..."
echo ""
docker compose ps

echo ""
echo "Access points:"
echo "  • API Gateway:  http://localhost:8080"
echo "  • RabbitMQ UI:  http://localhost:15672"
echo "  • MinIO Console: http://localhost:9001"
