# Garmin Race Room

Dashboard responsive para explotar datos de Garmin Connect vía MCP y preparar la media maratón del 10 de mayo de 2026.

## Qué incluye

- Wrapper local del servidor MCP de [`Nicolasvegam/garmin-connect-mcp`](https://github.com/Nicolasvegam/garmin-connect-mcp) en [`vendor/garmin-connect-mcp`](/home/oecharri/Oier/projects/garmin-connect/vendor/garmin-connect-mcp)
- Integración principal con [`python-garminconnect`](https://github.com/cyberjunky/python-garminconnect) mediante un bridge Python local
- Backend Express que consulta Garmin a través del MCP y agrega métricas para el frontend
- Frontend React + Recharts con vista responsive
- Panel de consejos para la media
- Plan de entrenamiento de 6 semanas
- Modo degradado si Garmin devuelve rate limit o bloquea la autenticación

## Arranque

1. Revisa `.env` con tus credenciales de Garmin.
2. Ejecuta `npm run garmin:python:install` si todavía no existe `.venv-garmin`.
3. Ejecuta `npm run garmin:python:setup` una vez para crear `~/.garminconnect`.
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

- La integración prueba primero `python-garminconnect` y usa el MCP local como fallback.
- `python-garminconnect` usa `~/.garminconnect` por defecto. Puedes cambiarlo con `GARMINTOKENS`.
- Si necesitas fijar manualmente el consumidor OAuth de `garth`, la API respeta `GARTH_OAUTH_KEY` y `GARTH_OAUTH_SECRET`.
- El flujo recomendado es hacer primero el setup interactivo para guardar tokens y luego dejar que la API reutilice esos tokens; así evitas repetir SSO en cada petición.
- Si Garmin devuelve `429` o `427`, el dashboard entra en modo degradado y te deja refrescar más tarde sin romper la UI.
- El archivo `.cursor/mcp.json` deja el servidor listo para Cursor usando `npm run mcp:garmin`.
