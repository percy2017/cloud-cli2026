# Visibilidad y orden de proveedores desde `.env`

CloudCLI expone 6 proveedores (`claude`, `codex`, `cursor`, `gemini`, `opencode`, `qwen`) que comparten la misma UI — composer, settings tab, login modal, onboarding. El operador puede controlar **qué proveedores ve el usuario y en qué orden** con una sola variable de entorno, sin recompilar y sin pantalla de settings.

## TL;DR

```env
# .env
PROVIDER_ENABLED_ORDER=claude,codex,opencode,qwen
```

Orden en CSV = orden visible en toda la UI. Cualquier id ausente = oculto. Default: `claude,codex,opencode,qwen` (cursor y gemini ocultos).

## Contrato

**Variable:** `PROVIDER_ENABLED_ORDER`

**Formato:** CSV de `LLMProvider` válidos en minúsculas. Whitespace tolerado.

**Default (cuando no está en `.env` o está malformada):** `claude,codex,opencode,qwen`

**Comportamiento:**

| Caso | Resultado |
|---|---|
| `PROVIDER_ENABLED_ORDER=claude,qwen,codex,opencode` | UI muestra solo esos 4, en ese orden exacto |
| `PROVIDER_ENABLED_ORDER=` (vacío) | Fallback al default + `console.warn` |
| `PROVIDER_ENABLED_ORDER=claude,foo,codex` | `foo` se ignora + `console.warn`; UI muestra `claude, codex` |
| `PROVIDER_ENABLED_ORDER=,,,` (solo separadores) | Fallback al default + `console.warn` |
| Id no listado en el CSV | Oculto en UI + rechazado en API con `403 PROVIDER_DISABLED` |

**No destructivo:** deshabilitar un proveedor bloquea **nuevas** sesiones vía API/UI pero las sesiones ya existentes siguen funcionando. El operador las ve si navega directo a su URL.

## Por qué no `DISABLED_PROVIDERS` (lista negra)

El operador puede deshabilitar de dos formas equivalentes:

- `ENABLED_PROVIDERS=A,B,C` (lista blanca) ← CSV actual
- `DISABLED_PROVIDERS=X,Y` (lista negra)

La lista blanca se eligió porque:
1. **Doble función:** ordenar Y habilitar en una sola línea. Con lista negra hace falta otra var para reordenar.
2. **Cero ambigüedad sobre defaults:** un operador que añade un 7º provider al codebase sabe inmediatamente que está oculto por default. Con lista negra, el 7º provider aparecería visible sin que nadie lo pida.
3. **Mismo coste de mantenimiento:** ambos son CSV de un solo campo.

## Cómo se aplica (filter at the boundary)

Un solo lugar en backend + un solo lugar en frontend filtran la lista. El resto de los ~10 consumidores leen la lista filtrada, no su propio array hardcodeado.

### Backend

```
server/modules/providers/config.ts                                       (NEW — parse + cache)
server/modules/providers/services/provider-visibility.service.ts         (NEW — seam de filtrado)
```

- `config.ts` parsea `process.env.PROVIDER_ENABLED_ORDER` una sola vez al cargar el módulo (mismo patrón que `load-env.js` para `DATABASE_PATH`).
- `providerVisibilityService.assertEnabled(id)` lanza `AppError` con `code: 'PROVIDER_DISABLED', statusCode: 403` si el id no está habilitado.
- `providerVisibilityService.listProviders(registry)` filtra y ordena el `Record<LLMProvider, IProvider>` del registry.
- `providerVisibilityService.listEnabledIds()` devuelve el array en orden.

**Sitios de backend modificados:**

| Sitio | Cambio |
|---|---|
| `server/modules/providers/provider.registry.ts` | `listProviders()` pasa por el seam |
| `server/modules/providers/provider.routes.ts` | `parseProvider()` rechaza con `403 PROVIDER_DISABLED`; `GET /capabilities` filtra la respuesta; nuevo endpoint `GET /enabled` |
| `server/index.js` | Tablas `spawnFns` / `abortFns` del WebSocket filtradas por id |
| `server/routes/agent.js` | Allowlist dinámico en `parseProvider()`; pre-fan-out de modelos respeta la habilitación |

### Frontend

```
src/components/providers/useEnabledProviders.ts                         (NEW — hook SWR + mapa display names)
```

- Hook SWR con cache a nivel de módulo. Comparte los display names centralizados en `PROVIDER_DISPLAY_NAMES` — reemplaza los 4 mapas hardcodeados (`PROVIDER_META`, `AGENT_NAMES`, `getProviderDisplayName`, `providerCardStyles`).
- Expone `{ enabled, order }` desde `GET /api/providers/enabled`.
- Si `swr` no es dep, se sustituye por `useEffect`+`useState` con cache módulo.

**Sitios de frontend modificados:**

| Sitio | Cambio |
|---|---|
| `useChatProviderState.ts` | Fan-out y selección inicial desde el hook |
| `ProviderSelectionEmptyState.tsx` | `PROVIDER_META` derivado del hook |
| `agents-settings/AgentsSettingsTab.tsx` | `visibleAgents` del hook |
| `onboarding/AgentConnectionsStep.tsx` | `providerKeys` del hook |
| `provider-auth/hooks/useProviderAuthStatus.ts` | Default arg = lista habilitada |

## Migración de `localStorage` (self-healing)

Tres `localStorage` keys son frágiles: `selected-provider`, `<provider>-model`. Política:

1. Al boot, leer `selected-provider`.
2. Si no está en el `enabled` actual (caso típico: el operador ocultó un provider que el usuario tenía activo), reemplazarlo por `enabled[0]` y persistirlo. Un refresh no se vuelve a tropezar.
3. Los `<provider>-model` de providers deshabilitados quedan en `localStorage` pero nunca se vuelven a leer/escribir. Limpieza natural al próximo `Clear site data`.
4. Sesiones del server para providers deshabilitados siguen accesibles vía URL directa pero no aparecen bajo tabs/pills visibles.

Sin script de migración — la app es self-healing en el primer render tras cambiar la config.

## Verificación end-to-end

**Backend:**

```bash
# Default: solo 4 visibles
curl -s http://127.0.0.1:${SERVER_PORT}/api/providers/enabled | jq
# → { "success": true, "data": { "enabled": ["claude","codex","opencode","qwen"], "order": [...] } }

curl -s http://127.0.0.1:${SERVER_PORT}/api/providers/capabilities | jq '.data.providers | map(.provider)'
# → ["claude","codex","opencode","qwen"]

# Intentar lanzar sesión con provider deshabilitado
curl -X POST http://127.0.0.1:${SERVER_PORT}/api/providers/sessions \
  -H "Content-Type: application/json" \
  -d '{"provider":"cursor"}'
# → 403 PROVIDER_DISABLED

# Cambiar el orden
PROVIDER_ENABLED_ORDER=claude,qwen,codex,opencode
# → /api/providers/enabled devuelve ese orden exacto.
```

**Frontend:**

1. DevTools → Network → confirmar `GET /api/providers/enabled` con la respuesta esperada.
2. Empty chat composer: command palette lista exactamente los providers habilitados en orden configurado. Sin los ocultos.
3. Settings → Agents: pills en el mismo orden, sin los ocultos.
4. Onboarding: solo las cards habilitadas.
5. `localStorage.getItem('selected-provider')` queda en uno de los habilitados tras un refresh (incluso si antes era uno oculto — la migración corrió).
6. Sesiones existentes del sidebar: siguen accesibles vía URL directa, pero la pill de ese provider no aparece en la UI.

## Lo que queda fuera de scope

- **No** se tocan rutas específicas de provider (`/api/cursor`, `/api/gemini`). El operador eligió ocultar, no romper. Si quiere bloquear a nivel HTTP, se puede agregar después un middleware `app.use('/api/cursor', guardEnabled('cursor'), …)`.
- **No** se modifica `public/api-docs.html` — ese array se mantiene completo. Cambiarlo a leer del endpoint sería nice-to-have, fuera del brief.
- **No** hay UI de settings nueva para el operador. El operador edita `.env` una vez. Si en el futuro quiere runtime-toggling, se monta `PROVIDER_ENABLED_ORDER` sobre la DB (`appConfigDb`) y se re-parsea en caliente.
