#!/bin/bash

# Mock Instagram API Test Script
# Usage: ./test-api.sh

BASE_URL="http://localhost:8080"
TOKEN=""

echo "🧪 Mock Instagram API Test Suite"
echo "================================="
echo ""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Helper function
test_endpoint() {
    local method=$1
    local endpoint=$2
    local data=$3
    local description=$4
    
    echo -n "Testing: $description... "
    
    if [ "$method" == "GET" ]; then
        if [ -n "$TOKEN" ]; then
            response=$(curl -s -w "\n%{http_code}" -H "Authorization: Bearer $TOKEN" "$BASE_URL$endpoint")
        else
            response=$(curl -s -w "\n%{http_code}" "$BASE_URL$endpoint")
        fi
    else
        if [ -n "$TOKEN" ]; then
            response=$(curl -s -w "\n%{http_code}" -X $method -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" -d "$data" "$BASE_URL$endpoint")
        else
            response=$(curl -s -w "\n%{http_code}" -X $method -H "Content-Type: application/json" -d "$data" "$BASE_URL$endpoint")
        fi
    fi
    
    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | sed '$d')
    
    if [[ "$http_code" =~ ^2 ]]; then
        echo -e "${GREEN}✓ PASS${NC} (HTTP $http_code)"
        echo "$body" | head -c 200
        echo ""
    else
        echo -e "${RED}✗ FAIL${NC} (HTTP $http_code)"
        echo "$body" | head -c 200
        echo ""
    fi
    
    echo ""
}

# Wait for services
echo -e "${YELLOW}Waiting for services to be ready...${NC}"
sleep 2

# Test API Gateway Health
echo "=== API Gateway ==="
test_endpoint "GET" "/health" "" "Gateway health check"

# Test User Registration
echo "=== User Service ==="
RANDOM_USER="testuser_$(date +%s)"
REGISTER_DATA="{\"username\": \"$RANDOM_USER\", \"email\": \"$RANDOM_USER@example.com\", \"password\": \"password123\", \"fullName\": \"Test User\"}"

echo "Registering user: $RANDOM_USER"
response=$(curl -s -X POST -H "Content-Type: application/json" -d "$REGISTER_DATA" "$BASE_URL/api/auth/register")
echo "$response" | head -c 300
echo ""

# Extract token
TOKEN=$(echo "$response" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

if [ -n "$TOKEN" ]; then
    echo -e "${GREEN}✓ Got JWT token${NC}"
    echo ""
else
    echo -e "${RED}✗ Failed to get token${NC}"
    echo ""
fi

# Test Get Profile
test_endpoint "GET" "/api/users/me" "" "Get current user profile"

# Test Update Profile
test_endpoint "PUT" "/api/users/me" '{"bio": "Hello from test script!"}' "Update profile"

# Test Search Users
test_endpoint "GET" "/api/users?q=test" "" "Search users"

# Create a second user for follow tests
RANDOM_USER2="testuser2_$(date +%s)"
REGISTER_DATA2="{\"username\": \"$RANDOM_USER2\", \"email\": \"$RANDOM_USER2@example.com\", \"password\": \"password123\", \"fullName\": \"Test User 2\"}"
curl -s -X POST -H "Content-Type: application/json" -d "$REGISTER_DATA2" "$BASE_URL/api/auth/register" > /dev/null

# Test Follow
test_endpoint "POST" "/api/users/$RANDOM_USER2/follow" "" "Follow user"

# Test Get Following
test_endpoint "GET" "/api/users/$RANDOM_USER/following" "" "Get following list"

echo "=== Post Service ==="

# Create a post (without actual media for simplicity)
test_endpoint "POST" "/api/posts" '{"caption": "Test post from script!", "mediaUrls": ["http://example.com/image.jpg"]}' "Create post"

# Get user's posts
response=$(curl -s -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/posts/user/me")
POST_ID=$(echo "$response" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

if [ -n "$POST_ID" ]; then
    echo "Created post ID: $POST_ID"
    
    # Test Like Post
    test_endpoint "POST" "/api/posts/$POST_ID/like" "" "Like post"
    
    # Test Add Comment
    test_endpoint "POST" "/api/posts/$POST_ID/comments" '{"content": "Great post!"}' "Add comment"
    
    # Test Get Comments
    test_endpoint "GET" "/api/posts/$POST_ID/comments" "" "Get comments"
fi

echo "=== Feed Service ==="
test_endpoint "GET" "/api/feed" "" "Get user feed"
test_endpoint "GET" "/api/feed/stats" "" "Get feed stats"

echo "=== Media Service ==="
test_endpoint "GET" "/health/media" "" "Media service health"

echo "=== All Service Health Checks ==="
test_endpoint "GET" "/health/user" "" "User service health"
test_endpoint "GET" "/health/post" "" "Post service health"
test_endpoint "GET" "/health/feed" "" "Feed service health"

echo ""
echo "================================="
echo -e "${GREEN}Test suite completed!${NC}"
echo ""
echo "Management UIs:"
echo "  - RabbitMQ: http://localhost:15672 (instagram/instagram123)"
echo "  - MinIO: http://localhost:9001 (minioadmin/minioadmin123)"
