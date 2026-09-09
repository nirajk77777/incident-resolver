#!/bin/sh
# The portal container's start: bring the database up to the running code, then hand PID 1
# to portal-api so a `docker stop` reaches its SIGTERM handler and the open SSE streams and
# the connection pool close cleanly. Migrations are idempotent, so this is safe on every boot.
set -e

echo "Applying migrations..."
cd /app/packages/shared
node --import tsx scripts/migrate.ts

# Seeding resets the knowledge tables - the Incidents closed Tickets have written go with
# them - so it never happens on its own. Set it for a first boot against an empty database,
# then unset it again. The seed embeds every record through Cohere, so it needs the key.
if [ "${SEED_KNOWLEDGE_ON_START}" = "true" ]; then
  echo "SEED_KNOWLEDGE_ON_START=true - resetting and seeding the knowledge base..."
  cd /app/packages/mcp-incidents
  node --import tsx scripts/seed.ts
fi

cd /app/apps/portal-api
# Matches the `start` script, minus its --env-file: compose supplies the environment.
exec node --import tsx src/main.ts
