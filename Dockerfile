# Step 1: Use the latest Ubuntu 24.04 LTS image as the base for building the wasm module
FROM ubuntu:24.04 AS builder

# Step 2: Install necessary dependencies for building the wasm module
RUN apt-get update && apt-get install -y \
    curl \
    git \
    build-essential \
    libssl-dev \
    pkg-config \
    protobuf-compiler \
    libprotobuf-dev \
    clang-format \
    clang-tidy \
    clang-tools \
    clang \
    clangd \
    libc++-dev \
    libc++1 \
    libc++abi-dev \
    libc++abi1 \
    libclang-dev \
    libclang1 \
    liblldb-dev \
    libllvm-ocaml-dev \
    libomp-dev \
    libomp5 \
    lld \
    lldb \
    llvm-dev \
    llvm-runtime \
    llvm \
    python3-clang \
    wget \
    unzip \
    bash \
    && rm -rf /var/lib/apt/lists/*

# Step 3: Install rustup (for installing Rust)
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | bash -s -- -y

# Step 3b: Install a specific version of Rust (e.g., 1.82.0)
RUN . "$HOME/.cargo/env" && rustup install 1.82.0 && rustup default 1.82.0

# Step 4: Add Rust's cargo to the PATH using ENV
ENV PATH="/root/.cargo/bin:${PATH}"

# Step 5: Install wasm-pack (tool for building WASM)
RUN cargo install wasm-pack

# Step 6: Add the wasm32-unknown-unknown target for wasm compilation
RUN rustup target add wasm32-unknown-unknown

# Step 7: Clone the rusty-kaspa repository (this layer will be cached unless the git ref changes)
RUN git clone https://github.com/kaspanet/rusty-kaspa /rusty-kaspa && \
    cd /rusty-kaspa && \
    git checkout v1.0.0

# Step 8: Build WASM (this expensive step will be cached)
WORKDIR /rusty-kaspa/wasm
RUN --mount=type=cache,target=/root/.cargo/registry \
    --mount=type=cache,target=/root/.cargo/git \
    --mount=type=cache,target=/rusty-kaspa/target \
    ./build-node

# Use the official Node.js image as the base image
FROM node:20

# Install Bun
RUN curl -fsSL https://bun.sh/install | bash

# Add Bun to the PATH environment variable
ENV PATH="/root/.bun/bin:$PATH"

# Set the working directory in the container
WORKDIR /app

# Copy WASM build output from builder stage
COPY --from=builder /rusty-kaspa/wasm/nodejs /app/wasm

# Copy package.json first for better layer caching
COPY package.json ./

# Install dependencies (this layer will be cached unless package.json changes)
RUN bun install && bun upgrade --canary

# Copy the rest of your application code to the working directory
COPY . .

# Expose the port your app runs on
EXPOSE 7777

# Start the application
CMD ["bun", "run", "index.ts"]