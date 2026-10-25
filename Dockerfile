# Battle of Talingchan online server (Render free web service, Docker).
FROM node:22-slim
WORKDIR /app
COPY . .
ENV DATA_DIR=/tmp/talingchan-data
CMD ["node", "--experimental-strip-types", "--no-warnings", "online/server.ts"]
