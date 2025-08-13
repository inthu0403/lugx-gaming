#!/bin/bash
# Rolling Deployment Helper Script

set -e

SERVICE_NAME=${1:-"all"}
NEW_IMAGE_TAG=${2:-"latest"}

echo "🚀 LUGX Gaming Rolling Deployment"
echo "=================================="
echo "Service: $SERVICE_NAME"
echo "Image Tag: $NEW_IMAGE_TAG"
echo ""

# Function to update a single service
update_service() {
    local service=$1
    local image_tag=$2
    
    echo "🔄 Rolling update for $service..."
    
    # Update image tag
    kubectl set image deployment/$service $service=lugx-gaming/$service:$image_tag
    
    # Annotate with timestamp for forced update
    kubectl annotate deployment $service deployment.kubernetes.io/revision="$(date +%s)" --overwrite
    
    # Wait for rollout
    echo "⏳ Waiting for $service rollout..."
    if kubectl rollout status deployment/$service --timeout=300s; then
        echo "✅ $service rolled out successfully"
        
        # Verify health
        replicas=$(kubectl get deployment $service -o jsonpath='{.status.readyReplicas}')
        desired=$(kubectl get deployment $service -o jsonpath='{.status.replicas}')
        echo "📊 $service: $replicas/$desired replicas ready"
        
        return 0
    else
        echo "❌ $service rollout failed"
        echo "🔙 Rolling back $service..."
        kubectl rollout undo deployment/$service
        return 1
    fi
}

# Update services
if [ "$SERVICE_NAME" = "all" ]; then
    services=("frontend" "game-service" "order-service" "analytics-service")
    
    for service in "${services[@]}"; do
        if ! update_service $service $NEW_IMAGE_TAG; then
            echo "❌ Rolling deployment failed at $service"
            exit 1
        fi
        echo "⏸️ Waiting 15 seconds before next service..."
        sleep 15
    done
    
    echo "🎉 All services rolled out successfully!"
else
    if ! update_service $SERVICE_NAME $NEW_IMAGE_TAG; then
        echo "❌ Rolling deployment failed for $SERVICE_NAME"
        exit 1
    fi
    echo "🎉 Service $SERVICE_NAME rolled out successfully!"
fi

echo ""
echo "📊 Final Status:"
kubectl get deployments | grep -E "(frontend|game-service|order-service|analytics-service)" || kubectl get deployments
echo ""
echo "🌐 Service URLs:"
echo "  Frontend: http://localhost:31080"
echo "  Game API: http://localhost:31081"
echo "  Order API: http://localhost:31082"
echo "  Analytics API: http://localhost:31083"
