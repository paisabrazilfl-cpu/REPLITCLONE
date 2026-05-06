FROM node:20-slim

# Install language runtimes
RUN apt-get update && apt-get install -y \
    python3 python3-pip \
    g++ \
    default-jdk \
    ruby \
    golang \
    php-cli \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Rust
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path
ENV PATH="/root/.cargo/bin:${PATH}"

# Install TypeScript runner
RUN npm install -g ts-node typescript

WORKDIR /app/backend

COPY package.json .
RUN npm install --omit=dev

COPY server.js .

# Serve frontend from parent dir
WORKDIR /app
COPY index.html .

WORKDIR /app/backend
RUN mkdir -p data

ENV PORT=3001
EXPOSE 3001

CMD ["node", "server.js"]
