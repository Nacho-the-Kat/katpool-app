#!/bin/bash

# Deployment order script for KatPool Kubernetes deployment
# This ensures dependencies are deployed in the correct order

set -e

echo "🚀 Starting KatPool Kubernetes deployment..."

# 1. Create namespace
echo "📦 Creating namespace..."
kubectl apply -f k8s-namespace.yaml

# 2. Create secrets and configmaps
echo "🔐 Creating secrets and configmaps..."
kubectl apply -f k8s-secret.yaml
kubectl apply -f k8s-configmap.yaml

# 3. Deploy database first
echo "🗄️  Deploying database..."
kubectl apply -f k8s-database-deployment.yaml

# Wait for database to be ready
echo "⏳ Waiting for database to be ready..."
kubectl wait --for=condition=ready pod -l app=katpool-db -n katpool --timeout=300s

# 4. Deploy Redis
echo "🔴 Deploying Redis..."
kubectl apply -f k8s-redis-deployment.yaml

# Wait for Redis to be ready
echo "⏳ Waiting for Redis to be ready..."
kubectl wait --for=condition=ready pod -l app=redis -n katpool --timeout=300s

# 5. Deploy monitor
echo "📊 Deploying monitor..."
kubectl apply -f k8s-monitor-deployment.yaml

# Wait for monitor to be ready
echo "⏳ Waiting for monitor to be ready..."
kubectl wait --for=condition=ready pod -l app=katpool-monitor -n katpool --timeout=300s

# 6. Deploy main application
echo "🏗️  Deploying main application..."
kubectl apply -f k8s-deployment.yaml

# 7. Deploy service
echo "🌐 Deploying service..."
kubectl apply -f k8s-service.yaml

# Wait for main app to be ready
echo "⏳ Waiting for main application to be ready..."
kubectl wait --for=condition=ready pod -l app=katpool-app -n katpool --timeout=300s

echo "✅ KatPool deployment completed successfully!"
echo "📊 Check status with: kubectl get pods -n katpool" 