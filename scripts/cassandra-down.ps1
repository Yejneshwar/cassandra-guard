# Stop and remove the Cassandra container used for integration testing.
# Usage: .\scripts\cassandra-down.ps1

$ErrorActionPreference = "Stop"

$ContainerName = "csg-cassandra"

$exists = docker ps -a --format '{{.Names}}' 2>$null | Where-Object { $_ -eq $ContainerName }
if ($exists) {
    Write-Host "Stopping and removing '$ContainerName'..."
    docker rm -f $ContainerName | Out-Null
    Write-Host "Container removed."
} else {
    Write-Host "x No container named '$ContainerName' found - nothing to do."
}
