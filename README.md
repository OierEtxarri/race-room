# Garmin Race Room

Dashboard responsive para explotar datos de Garmin Connect desde Codex y preparar la media maratón del 10 de mayo de 2026.

## Vista rápida

<p align="center">
  <img src="docs/screenshots/dashboard-desktop.png" alt="Garmin Race Room en escritorio" width="880" />
</p>

<p align="center">
  <img src="docs/screenshots/dashboard-mobile.png" alt="Garmin Race Room en formato móvil" width="280" />
</p>

## Qué incluye

- Wrapper local del servidor MCP de [`Nicolasvegam/garmin-connect-mcp`](https://github.com/Nicolasvegam/garmin-connect-mcp) en [`vendor/garmin-connect-mcp`](/home/oecharri/Oier/projects/garmin-connect/vendor/garmin-connect-mcp)
- Integración principal con [`python-garminconnect`](https://github.com/cyberjunky/python-garminconnect) mediante un bridge Python local
- Backend Express que consulta Garmin a través del MCP y agrega métricas para el frontend
- Frontend React + Recharts con vista responsive
- Refresco automático del dashboard con caché viva en backend
- Reautenticación automática al arrancar si faltan tokens MCP válidos
- Panel de consejos para la media basado en recuperación, carga y sesiones recientes
- Plan de entrenamiento de 6 semanas que se reajusta solo con cada sync de Garmin
- Envío de entrenamientos futuros del plan a Garmin desde la propia app
- Modo degradado si Garmin devuelve rate limit o bloquea la autenticación

## Arranque

1. Revisa `.env` con tus credenciales de Garmin.
2. Ejecuta `npm run garmin:python:install` si todavía no existe `.venv-garmin`.
3. Ejecuta `npm run mcp:garmin:setup` una vez para crear `~/.garmin-mcp`.
4. Ejecuta `npm run dev`.
5. Abre la URL que muestre Vite.

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
- Si existen tokens en `~/.garmin-mcp`, el backend y el bridge Python priorizan ese almacén.
- `python-garminconnect` sigue disponible como respaldo, como vía de escritura y como referencia de autenticación.
- `python-garminconnect` usa `~/.garminconnect` por defecto. Puedes cambiarlo con `GARMINTOKENS`.
- Si necesitas fijar manualmente el consumidor OAuth de `garth`, la API respeta `GARTH_OAUTH_KEY` y `GARTH_OAUTH_SECRET`.
- El backend refresca la caché Garmin automáticamente cada 2 minutos y el frontend consulta la API local cada 30 segundos.
- Si faltan tokens o caducan, el backend intenta autenticarse de nuevo por sí solo con `GARMIN_EMAIL` y `GARMIN_PASSWORD`.
- El plan adapta ritmos, volumen y consejo con señales como ACWR, readiness, sueño, tirada larga reciente y calidad de los últimos 14 días.
- Los entrenamientos que no sean descanso, fuerza o carrera se pueden subir a Garmin para días futuros desde el panel semanal.
- Si Garmin devuelve `429` o `427`, el dashboard entra en modo degradado y te deja refrescar más tarde sin romper la UI.
