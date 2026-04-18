FROM node:24-alpine AS build

WORKDIR /app

COPY package*.json /app/
COPY apps/kiosk-ui/package*.json /app/apps/kiosk-ui/
RUN npm ci && npm --prefix apps/kiosk-ui ci

COPY . /app

# Dùng đường dẫn tương đối để trình duyệt luôn gọi qua cùng origin (nginx /api/core, /api/ai).
# Tránh bake http://...:8011|:8012 — resolveBrowserSafe* có nhánh same-origin sẽ giữ URL tuyệt đối và bỏ qua reverse proxy.
ARG VITE_CORE_API_URL=/api/core
ARG VITE_AI_API_URL=/api/ai
ARG VITE_MENU_API_URL=/api/core/menu
ARG VITE_ORDERS_API_URL=/api/core/orders

ENV VITE_CORE_API_URL=${VITE_CORE_API_URL}
ENV VITE_AI_API_URL=${VITE_AI_API_URL}
ENV VITE_MENU_API_URL=${VITE_MENU_API_URL}
ENV VITE_ORDERS_API_URL=${VITE_ORDERS_API_URL}

RUN npm run build:ui

FROM node:24-alpine AS runtime

WORKDIR /app

COPY --from=build /app/apps/kiosk-ui/dist ./dist
COPY --from=build /app/apps/kiosk-ui/package*.json ./
COPY --from=build /app/apps/kiosk-ui/vite.config.ts ./vite.config.ts
RUN npm ci

EXPOSE 3000
CMD ["npx", "vite", "preview", "--host", "0.0.0.0", "--port", "3000"]
