FROM node:24-alpine AS build

WORKDIR /app

COPY package*.json /app/
COPY apps/kiosk-ui/package*.json /app/apps/kiosk-ui/
RUN npm ci && npm --prefix apps/kiosk-ui ci

COPY . /app

ARG VITE_CORE_API_URL=/api/core
ARG VITE_AI_API_URL=/api/ai
ARG VITE_MENU_API_URL=/api/core/menu
ARG VITE_ORDERS_API_URL=/api/core/orders

ENV VITE_CORE_API_URL=${VITE_CORE_API_URL}
ENV VITE_AI_API_URL=${VITE_AI_API_URL}
ENV VITE_MENU_API_URL=${VITE_MENU_API_URL}
ENV VITE_ORDERS_API_URL=${VITE_ORDERS_API_URL}

RUN npm run build:ui

FROM nginx:1.27-alpine

COPY deploy/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/kiosk-ui/dist /usr/share/nginx/html

EXPOSE 80
