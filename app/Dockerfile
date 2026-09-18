
FROM node:20-alpine AS build

WORKDIR /app

# Install dependencies first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci

# Copy the rest of the source.
COPY . .
ARG VITE_API_BASE_URL
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL

# Developer Tools guard. Leave this unset and a production build is guarded,
# which is the intended deployment. Pass --build-arg VITE_DEVTOOLS_GUARD=false
# to ship a build without it. Declared here because an undeclared build arg is
# silently dropped, which would make the off-switch look broken.
ARG VITE_DEVTOOLS_GUARD
ENV VITE_DEVTOOLS_GUARD=$VITE_DEVTOOLS_GUARD

RUN npm run build

# ------------------------------------------------------------------ serve stage
FROM nginx:1.27-alpine AS serve

# Remove the default site and any leftover assets.
RUN rm -f /etc/nginx/conf.d/default.conf \ 
    && rm -rf /usr/share/nginx/html/*

# SPA + reverse-proxy configuration.
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Static build output.
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -qO- http://127.0.0.1/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
 