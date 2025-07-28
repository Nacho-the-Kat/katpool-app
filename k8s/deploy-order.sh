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

# 6. Deploy Victoria Metrics
echo "📈 Deploying Victoria Metrics..."
kubectl apply -f k8s-victoria-metrics-deployment.yaml

# Wait for Victoria Metrics to be ready
echo "⏳ Waiting for Victoria Metrics to be ready..."
kubectl wait --for=condition=ready pod -l app=katpool-victoria-metrics -n katpool --timeout=300s

# 7. Deploy VM Agent
echo "🔍 Deploying VM Agent..."
kubectl apply -f k8s-vmagent-deployment.yaml

# Wait for VM Agent to be ready
echo "⏳ Waiting for VM Agent to be ready..."
kubectl wait --for=condition=ready pod -l app=katpool-vmagent -n katpool --timeout=300s

# 8. Deploy Go App
echo "🔧 Deploying Go App..."
kubectl apply -f k8s-go-app-deployment.yaml

# Wait for Go App to be ready
echo "⏳ Waiting for Go App to be ready..."
kubectl wait --for=condition=ready pod -l app=katpool-go-app -n katpool --timeout=300s

# 9. Deploy Kaspad
echo "⛓️  Deploying Kaspad..."
kubectl apply -f k8s-kaspad-deployment.yaml

# Wait for Kaspad to be ready
echo "⏳ Waiting for Kaspad to be ready..."
kubectl wait --for=condition=ready pod -l app=katpool-kaspad -n katpool --timeout=600s

# 10. Deploy main application
echo "🏗️  Deploying main application..."
kubectl apply -f k8s-deployment.yaml

# 11. Deploy service
echo "🌐 Deploying service..."
kubectl apply -f k8s-service.yaml

# Wait for main app to be ready
echo "⏳ Waiting for main application to be ready..."
kubectl wait --for=condition=ready pod -l app=katpool-app -n katpool --timeout=300s

echo "✅ KatPool deployment completed successfully!"
echo "📊 Check status with: kubectl get pods -n katpool" 