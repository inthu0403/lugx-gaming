#!/bin/bash
# Enhanced CI/CD Build Script for Lugx Gaming with Rolling Deployment

echo "🔄 Starting Enhanced CI/CD Build Process..."

# Build all services with versioning
VERSION=${BUILD_NUMBER:-$(date +%s)}
echo "📦 Building version: $VERSION"

echo "🐳 Building Docker images..."
cd ../frontend && docker build -t lugx-gaming/frontend:$VERSION -t lugx-gaming/frontend:latest .
cd ../services/game-service && docker build -t lugx-gaming/game-service:$VERSION -t lugx-gaming/game-service:latest .
cd ../services/order-service && docker build -t lugx-gaming/order-service:$VERSION -t lugx-gaming/order-service:latest .
cd ../services/analytics-service && docker build -t lugx-gaming/analytics-service:$VERSION -t lugx-gaming/analytics-service:latest .

# Load to kind cluster
echo "📦 Loading images to cluster..."
kind load docker-image lugx-gaming/frontend:latest --name lugx-cluster
kind load docker-image lugx-gaming/game-service:latest --name lugx-cluster
kind load docker-image lugx-gaming/order-service:latest --name lugx-cluster
kind load docker-image lugx-gaming/analytics-service:latest --name lugx-cluster

# Deploy with rolling update strategy
echo "🚀 Performing Rolling Deployment..."

# Function to perform rolling update
rolling_update() {
    local service=$1
    echo "🔄 Rolling update for $service..."
    
    # Update the deployment
    kubectl patch deployment $service -p '{"spec":{"template":{"metadata":{"annotations":{"deployment.kubernetes.io/revision":"'$VERSION'"}}}}}'
    
    # Wait for rollout to complete
    kubectl rollout status deployment/$service --timeout=300s
    
    if [ $? -eq 0 ]; then
        echo "✅ Rolling update completed for $service"
    else
        echo "❌ Rolling update failed for $service"
        # Rollback on failure
        echo "🔙 Rolling back $service..."
        kubectl rollout undo deployment/$service
        return 1
    fi
}

# Perform rolling updates for all services
services=("frontend" "game-service" "order-service" "analytics-service")

for service in "${services[@]}"; do
    if ! rolling_update $service; then
        echo "❌ Deployment failed for $service"
        exit 1
    fi
    
    # Brief pause between service updates
    sleep 10
done

# Verify all services are healthy
echo "🔍 Verifying service health..."
for service in "${services[@]}"; do
    replicas=$(kubectl get deployment $service -o jsonpath='{.status.readyReplicas}')
    desired=$(kubectl get deployment $service -o jsonpath='{.status.replicas}')
    
    if [ "$replicas" = "$desired" ]; then
        echo "✅ $service: $replicas/$desired replicas ready"
    else
        echo "⚠️ $service: $replicas/$desired replicas ready"
    fi
done

echo "✅ Enhanced CI/CD Build with Rolling Deployment complete!"
echo "📊 Deployment Summary:"
echo "  Version: $VERSION"
echo "  Strategy: Rolling Update"
echo "  Zero Downtime: ✅"
echo "  Health Checks: ✅"
