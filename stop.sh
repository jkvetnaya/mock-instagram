#!/bin/bash

echo "🛑 Stopping Mock Instagram..."

# Check for -v flag to also remove volumes
if [ "$1" == "-v" ]; then
    echo "   (removing volumes too)"
    docker compose down -v
else
    docker compose down
fi

echo ""
echo "✅ All Mock Instagram services stopped."
