# Spin up a single-node Cassandra container for local integration testing.
# Usage: .\scripts\cassandra-up.ps1

$ContainerName = "csg-cassandra"
$Image = "cassandra:4.1"
$Port = if ($env:CASSANDRA_PORT) { $env:CASSANDRA_PORT } else { "9042" }
$MaxAttempts = 30

function Test-CassandraReady {
    try {
        $out = docker exec $ContainerName cqlsh -e "DESCRIBE KEYSPACES" 2>&1
        return ($LASTEXITCODE -eq 0)
    } catch {
        return $false
    }
}

function Wait-ForCassandra {
    Write-Host "Waiting for Cassandra to accept CQL connections..."
    for ($i = 1; $i -le $MaxAttempts; $i++) {
        if (Test-CassandraReady) {
            Write-Host "Cassandra is ready! (attempt $i/$MaxAttempts)"
            return $true
        }
        Write-Host "  Attempt $i/$MaxAttempts - waiting 5s..."
        Start-Sleep -Seconds 5
    }
    Write-Host "Cassandra did not become ready after $MaxAttempts attempts."
    return $false
}

# Check if the container already exists (running or stopped)
$existing = docker ps -a --format '{{.Names}}' 2>$null | Where-Object { $_ -eq $ContainerName }

if ($existing) {
    # Check if it's running
    $running = docker ps --format '{{.Names}}' 2>$null | Where-Object { $_ -eq $ContainerName }

    if ($running) {
        Write-Host "Container '$ContainerName' is already running. Testing connection..."
    } else {
        Write-Host "Container '$ContainerName' exists but is stopped. Starting it..."
        docker start $ContainerName | Out-Null
    }

    if (Wait-ForCassandra) { exit 0 } else { exit 1 }
}

# No existing container — start fresh
Write-Host "Starting Cassandra ($Image) as '$ContainerName' on port $Port..."
docker run -d `
    --name $ContainerName `
    -p "${Port}:9042" `
    -e CASSANDRA_CLUSTER_NAME=csg-test `
    -e CASSANDRA_DC=datacenter1 `
    -e CASSANDRA_ENDPOINT_SNITCH=GossipingPropertyFileSnitch `
    $Image | Out-Null

if (Wait-ForCassandra) { exit 0 } else { exit 1 }
