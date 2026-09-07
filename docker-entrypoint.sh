#!/bin/sh
# The portal container's start: bring the database up to the running code, then hand PID 1
# to portal-api so a `docker stop` reaches its SIGTERM handler and the open SSE streams and
# the connection pool close cleanly. Migrations are idempotent, so this is safe on every boot.
set -e

echo "Applying migrations..."
cd /app/packages/shared
node --import tsx scripts/migrate.ts

cd /app/apps/portal-api
# Matches the `start` script, minus its --env-file: compose supplies the environment.
exec node --import tsx src/main.ts
