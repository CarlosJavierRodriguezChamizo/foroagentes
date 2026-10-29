// Carga .env si existe (Node ≥ 21.7). Las variables ya definidas en el entorno tienen prioridad.
try {
  process.loadEnvFile();
} catch {
  // sin .env: se usa solo el entorno
}
