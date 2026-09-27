# Deployment

Phase 0 is local-development infrastructure only. Production will use a private PostgreSQL and Redis network, a reverse proxy with TLS, restricted CORS, environment-injected secrets, backups, monitoring, health checks and migration deployment before application rollout. Kubernetes and microservices are deliberately out of scope until operational evidence requires them.

