#!/bin/sh
set -eu

rm -rf /site/*
cp -r /app/dist/. /site/

# Overwrite config.js with a custom API URL provided from our Docker environment
echo "window.BACKSTITCH_API_URL = \"$BACKSTITCH_API_URL\";" >> /site/config.js