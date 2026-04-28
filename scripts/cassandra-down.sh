#!/usr/bin/env bash
# Stop and remove the Cassandra container used for integration testing.
# Usage: ./scripts/cassandra-down.sh

set -euo pipefail

CONTAINER_NAME="csg-cassandra"

if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
  echo "Stopping and removing '${CONTAINER_NAME}'..."
  docker rm -f "${CONTAINER_NAME}"
  echo "✓ Container removed."
else
  echo "✓ No container named '${CONTAINER_NAME}' found — nothing to do."
fi
