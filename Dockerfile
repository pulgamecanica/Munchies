# Gateway + API (the public entrypoint)
FROM node:24-alpine
WORKDIR /app
COPY --chmod=644 server.js admin.html seed-recipes.json default-tags.json ./
RUN mkdir -p data && chown node:node data
ENV NODE_ENV=production
USER node
EXPOSE 3000
CMD ["node", "server.js"]
