FROM node:22-alpine AS build

WORKDIR /app

# Cache the install (only runs if dependencies change)
COPY package*.json ./
RUN npm ci

# Copy the rest of stuff (runs if other stuff is changed)
COPY . .
# Intentionally do not set VITE_BACKSTITCH_API_URL here
RUN npm run build

FROM alpine:3.22

COPY docker/entrypoint.sh /usr/local/bin/webviewer-entrypoint.sh
RUN chmod +x /usr/local/bin/webviewer-entrypoint.sh

# entrypoint.sh handles copying from dist to /site at startup.
# The reason for this is to ensure on an image update, we overwrite the volume contents.
# This also allows us to set the BACKSTITCH_API_URL environment variable in config.js.
COPY --from=build /app/dist /app/dist

VOLUME ["/site"]

ENTRYPOINT ["/usr/local/bin/webviewer-entrypoint.sh"]