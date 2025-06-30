FROM ubuntu:24.04 AS builder

# Install cron, curl, and unzip
RUN apt-get update && apt-get install -y curl

# Use the official Node.js image
FROM node:20 AS node

# Install Bun
RUN curl -fsSL https://bun.sh/install | bash

# Set /app as the working directory for your application
WORKDIR /app

# Create a directory for the backup scripts and files
RUN mkdir -p /backup -p bun

# Use an official PostgreSQL image as the base but bring Node.js
FROM postgres:latest AS postgres

WORKDIR /app

# Copy everything from the Node.js stage
COPY --from=node /app /app
COPY --from=node /root/.bun /root/.bun

# Add Bun to the PATH again
ENV PATH="/root/.bun/bin:$PATH"
ENV NODE_PATH=/app/node_modules

# Copy the backup script into the container
COPY backup.sh /app/backup.sh
COPY cloudBackup.ts /app/cloudBackup.ts

# Give execution rights on the backup script
RUN chmod +x /app/backup.sh

# Add Bun to the PATH environment variable
ENV PATH="/root/.bun/bin:$PATH"

# Copy the package.json and bun.lockb files to the working directory
COPY package.json /app/

# Install cron in the final image so crontab works
RUN apt-get update && apt-get install -y cron unzip

# Install dependencies
RUN bun install
RUN bun upgrade --canary

# Create a crontab entry for backups
RUN echo "0 * * * * /app/backup.sh >> /var/log/cron.log 2>&1" > /etc/cron.d/backup-cron

# Apply cron job
RUN crontab /etc/cron.d/backup-cron

# Create a log file for cron jobs
RUN touch /var/log/cron.log

# Create the directory where the backups will be stored
VOLUME ["/backup"]

# Run the command on container startup
CMD ["sh", "-c", "printenv > /etc/environment; bun run /app/cloudBackup.ts & cron -f"]
