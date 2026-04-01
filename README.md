# Garmin Race Room

Dashboard responsive para explotar datos de Garmin Connect y Strava desde Codex, ajustar objetivos dinámicos y generar planes de entrenamiento por usuario.

## Vista rápida

<p align="center">
  <img src="docs/screenshots/dashboard-desktop.png" alt="Garmin Race Room en escritorio" width="880" />
</p>

<p align="center">
  <img src="docs/screenshots/dashboard-mobile.png" alt="Garmin Race Room en formato móvil" width="280" />
</p>

## Qué incluye

- Wrapper local del servidor MCP de [`Nicolasvegam/garmin-connect-mcp`](https://github.com/Nicolasvegam/garmin-connect-mcp) en [`vendor/garmin-connect-mcp`](vendor/garmin-connect-mcp)
- Integración principal con [`python-garminconnect`](https://github.com/cyberjunky/python-garminconnect) mediante un bridge Python local
- Backend Express que consulta Garmin a través del MCP o Python API y Strava vía OAuth + REST API
- Frontend React + Recharts con vista responsive, login dual dentro de la app y objetivo editable
- Refresco automático del dashboard con caché viva en backend y restauración inicial desde snapshot persistido
- Reautenticación automática cuando caducan los tokens mientras existan credenciales activas en la sesión del usuario
- Panel de consejos basado en recuperación, carga, cumplimiento y sesiones recientes
- Plan dinámico según fecha objetivo, distancia y rendimiento reciente
- Envío de entrenamientos futuros del plan a Garmin desde la propia app
- Persistencia ligera en SQLite del objetivo y del último dashboard/plan por usuario
- Modo degradado si Garmin devuelve rate limit o bloquea la autenticación
- Frontend preparado para desplegarse en GitHub Pages con `VITE_API_BASE_URL`

## Arranque

1. Ejecuta `npm run garmin:python:install` si todavía no existe `.venv-garmin`.
2. Ejecuta `npm run dev`.
3. Abre la URL que muestre Vite.
4. Haz login desde la propia app con Garmin o Strava.
5. Ajusta el objetivo con fecha y distancia; la app persistirá ese objetivo y el último plan en `data/garmin-connect.sqlite`.

## Scripts útiles

- `npm run dev`: frontend + backend
- `npm run start:api`: solo API
- `npm run build`: typecheck + build del frontend
- `npm run garmin:python:install`: crea el entorno Python e instala `garminconnect`
- `npm run garmin:python:setup`: hace el primer login interactivo usando tus credenciales de `.env` y guarda tokens en `~/.garminconnect`
- `npm run mcp:garmin`: arranca el servidor MCP local
- `npm run mcp:garmin:setup`: setup interactivo del MCP para guardar tokens en `~/.garmin-mcp/`

## Notas

- El flujo principal en este proyecto es Codex + app local. No depende de Cursor.
- El login ya no depende de dejar `GARMIN_EMAIL` y `GARMIN_PASSWORD` en `.env` para usar la app. Esas variables quedan solo para scripts manuales.
- Para Strava necesitas registrar una app y definir `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET` y `STRAVA_REDIRECT_URI` en el backend.
- Cada sesión de usuario guarda sus tokens de Garmin en un directorio temporal aislado y sus credenciales viven solo en memoria del backend.
- Las sesiones de Strava guardan `access_token` y `refresh_token` solo en memoria del backend y refrescan OAuth automáticamente mientras la sesión siga viva.
- `python-garminconnect` sigue disponible como respaldo, como vía de escritura y como referencia de autenticación.
- El backend persiste por email el último objetivo y dashboard/plan en SQLite para servir primero esa versión y refrescar Garmin después.
- Si necesitas fijar manualmente el consumidor OAuth de `garth`, la API respeta `GARTH_OAUTH_KEY` y `GARTH_OAUTH_SECRET`.
- El backend refresca la caché del proveedor activo automáticamente cada 2 minutos y el frontend consulta la API local cada 30 segundos.
- Si faltan tokens o caducan, el backend intenta autenticarse de nuevo por sí solo con las credenciales activas de la sesión actual.
- El plan adapta ritmos, volumen y consejo con señales como ACWR, readiness, sueño, tirada larga reciente, cumplimiento y calidad de los últimos 14 días.
- Los entrenamientos que no sean descanso, fuerza o carrera se pueden subir a Garmin para días futuros desde el panel semanal. En Strava el plan es de lectura y ajuste; no hay push de workouts.
- Si Garmin devuelve `429` o `427`, el dashboard entra en modo degradado y te deja refrescar más tarde sin romper la UI.
- GitHub Pages solo sirve el frontend. Para producción necesitas desplegar también la API en otro host y definir `FRONTEND_ORIGIN` en el backend y `VITE_API_BASE_URL` en el build del frontend.
- No voy a persistir tokens OAuth de usuarios en el repositorio ni en GitHub Pages. Eso no es seguro y Pages no puede ejecutar el backend que necesita el login de Garmin. La opción mantenible es: frontend en Pages y API+SQLite en un host pequeño aparte.
- El workflow de Pages está en `.github/workflows/deploy-pages.yml` y usa `VITE_APP_BASE=/garmin-interactive/`. Configura `VITE_API_BASE_URL` como variable del repositorio en GitHub.
