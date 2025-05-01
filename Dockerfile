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

# Step 4: Add Rust's cargo to the PATH using ENV
ENV PATH="/root/.cargo/bin:${PATH}"

# Step 5: Install wasm-pack (tool for building WASM)
RUN cargo install wasm-pack

# Step 6: Add the wasm32-unknown-unknown target for wasm compilation
RUN rustup target add wasm32-unknown-unknown

# Step 7: Clone the rusty-kaspa repository
COPY rusty-kaspa /rusty-kaspa

# Step 8: Change the working directory to `wasm`
WORKDIR /rusty-kaspa

WORKDIR /rusty-kaspa/wasm
# Step 9: Run the build-node script from the `wasm` directory
RUN --mount=type=cache,target=/rusty-kaspa/target \
    ./build-node

# Use the official Node.js image as the base image
FROM node:20

# Install Bun
RUN curl -fsSL https://bun.sh/install | bash

# Set the working directory in the container
WORKDIR /app

COPY --from=builder /rusty-kaspa/wasm/nodejs /app/wasm

# Add Bun to the PATH environment variable
ENV PATH="/root/.bun/bin:$PATH"

# Copy the package.json and bun.lockb files to the working directory
COPY package.json ./

# Install dependencies
RUN bun install
RUN bun upgrade --canary

# Copy the rest of your application code to the working directory
COPY . .

# Expose the port your app runs on
EXPOSE 7777

# Start the application
CMD ["bun", "run", "index.ts"]