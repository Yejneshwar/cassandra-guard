#!/usr/bin/env bash
# Spin up a single-node Cassandra container for local integration testing.
# Usage: ./scripts/cassandra-up.sh

set -uo pipefail

CONTAINER_NAME="csg-cassandra"
IMAGE="cassandra:4.1"
PORT="${CASSANDRA_PORT:-9042}"
MAX_ATTEMPTS=30

wait_for_cassandra() {
  echo "Waiting for Cassandra to accept CQL connections..."
  for i in $(seq 1 ${MAX_ATTEMPTS}); do
    if docker exec "${CONTAINER_NAME}" cqlsh -e "DESCRIBE KEYSPACES" >/dev/null 2>&1; then
      echo "Cassandra is ready! (attempt ${i}/${MAX_ATTEMPTS})"
      return 0
    fi
    echo "  Attempt ${i}/${MAX_ATTEMPTS} - waiting 5s..."
    sleep 5
  done
  echo "x Cassandra did not become ready after ${MAX_ATTEMPTS} attempts."
  return 1
}

# Check if the container already exists (running or stopped)
if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
  # Check if it's running
  if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    echo "Container '${CONTAINER_NAME}' is already running. Testing connection..."
  else
    echo "Container '${CONTAINER_NAME}' exists but is stopped. Starting it..."
    docker start "${CONTAINER_NAME}" >/dev/null
  fi

  wait_for_cassandra
  exit $?
fi

# No existing container — start fresh
echo "Starting Cassandra (${IMAGE}) as '${CONTAINER_NAME}' on port ${PORT}..."
docker run -d \
  --name "${CONTAINER_NAME}" \
  -p "${PORT}:9042" \
  -e CASSANDRA_CLUSTER_NAME=csg-test \
  -e CASSANDRA_DC=datacenter1 \
  -e CASSANDRA_ENDPOINT_SNITCH=GossipingPropertyFileSnitch \
  "${IMAGE}" >/dev/null

wait_for_cassandra
exit $?
