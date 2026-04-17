FROM node:24-alpine AS build

WORKDIR /app

COPY package*.json /app/
COPY apps/kiosk-ui/package*.json /app/apps/kiosk-ui/
RUN npm ci && npm --prefix apps/kiosk-ui ci

COPY . /app

ARG VITE_CORE_API_URL=http://localhost:8011
ARG VITE_AI_API_URL=http://localhost:8012
ARG VITE_MENU_API_URL=http://localhost:8011/menu
ARG VITE_ORDERS_API_URL=http://localhost:8011/orders

ENV VITE_CORE_API_URL=${VITE_CORE_API_URL}
ENV VITE_AI_API_URL=${VITE_AI_API_URL}
ENV VITE_MENU_API_URL=${VITE_MENU_API_URL}
ENV VITE_ORDERS_API_URL=${VITE_ORDERS_API_URL}

RUN npm run build:ui

FROM node:24-alpine AS runtime

WORKDIR /app

COPY --from=build /app/apps/kiosk-ui/dist ./dist
COPY --from=build /app/apps/kiosk-ui/package*.json ./
RUN npm ci --omit=dev

EXPOSE 3000
CMD ["npx", "vite", "preview", "--host", "0.0.0.0", "--port", "3000"]
