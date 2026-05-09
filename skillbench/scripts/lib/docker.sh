# docker_cleanup — removes stopped containers and unused networks
docker_cleanup() {
    echo "  Docker cleanup: stopped containers..."
    docker container prune -f 2>/dev/null || true
    echo "  Docker cleanup: unused networks..."
    docker network prune -f 2>/dev/null || true
}
