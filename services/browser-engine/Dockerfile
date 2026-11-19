FROM mcr.microsoft.com/playwright:v1.58.2-noble
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.js network-policy.js ./
ENV NODE_ENV=production PORT=8788 HOST=0.0.0.0
EXPOSE 8788
USER pwuser
CMD ["npm", "start"]
