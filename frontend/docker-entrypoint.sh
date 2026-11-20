#!/bin/sh
set -eu
cd /app
if [ ! -x node_modules/.bin/ng ]; then
  npm ci
fi
exec npx ng serve --host 0.0.0.0 --port 4200 --poll 2000
