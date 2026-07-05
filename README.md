# cloud-cli2026

Fork personalizado de [`@cloudcli-ai/cloudcli`](https://github.com/siteboon/claudecodeui) — la UI web que envuelve los CLIs de coding agents — adaptado para correr como proceso propio bajo pm2 con i18n extendido y el panel de Git etiquetado en español.

## Qué es este fork

Es una capa de presentación web para cinco agentes de coding que ya funcionan como CLI en la máquina: Claude Code, Cursor CLI, Codex, Gemini CLI y OpenCode. La app los envuelve en una UI única con sidebar, chat, terminal, explorador de archivos, panel de git y un driver de navegador vía MCP — los CLIs son los mismos que el usuario ya corre, no se reemplazan ni se duplican.

El fork existe por tres razones concretas:

- **Internacionalización al español.** Extensión de los archivos en `src/i18n/locales/es/` y traducción de la entrada de Git como "Control de versiones".
- **Módulo de Git custom.** El panel de Control de versiones se ajusta a cómo se usa acá (rama actual, cambios sin commitear, commits, reversión).
- **Despliegue propio.** El proceso corre bajo pm2 con un wrapper de Node 22 porque los binarios nativos se compilaron contra ese ABI.

## Qué tiene de distinto al upstream

- **11 idiomas en la UI:** `de`, `en`, `es`, `fr`, `it`, `ja`, `ko`, `ru`, `tr`, `zh-CN`, `zh-TW`. Todos viven bajo `src/i18n/locales/`. El árbol `es/` suma `auth`, `chat`, `codeEditor`, `common`, `settings`, `sidebar` y `tasks`.
- **Etiqueta "Control de versiones".** La pestaña de Git del sidebar aparece con esa etiqueta cuando el locale activo es español (`src/i18n/locales/es/common.json`).
- **pm2 en lugar de `npm start`.** El proceso se levanta con `ecosystem.config.cjs`, que define la app `cloud-cli2026`. El config carga `.env` de forma inline porque el daemon de pm2 corre antes que el loader de variables de la app.
- **Pin de Node 22.** `better-sqlite3` y `node-pty` están compilados contra el ABI de Node 22. Si el sistema trae Node 24 por defecto, hay que apuntar `exec_interpreter` al binario de Node 22 vía `NODE_BINARY` en `.env` — usar Node 24 rompe los nativos al `dlopen`.

## Módulos de la app

Cinco pestañas en la sidebar, en el orden de la UI:

- **Chats.** Sesión con el agente activo. Selección de modelo, envío en streaming, render de tool calls, menciones con `@archivo`. Vive en `src/components/chat/`.
- **Consola CLI.** Terminal PTY integrada (xterm.js sobre node-pty) con atajos, scrollback y selección táctil para mobile. Vive en `src/components/shell/`.
- **Archivos.** Árbol de archivos con syntax highlighting y editor CodeMirror embebido, drag-and-drop para subir, vista previa binaria, diffs en línea. Vive en `src/components/file-tree/` y `src/components/code-editor/`.
- **Control de versiones.** Panel de Git: rama actual, cambios sin commitear, historial, commit y revert. En español aparece etiquetado "Control de versiones" (en otros locales, "Git"). Vive en `src/components/git-panel/`.
- **Navegador.** Browser-Use: driver MCP que automatiza un navegador real desde la UI. Útil para probar cambios visuales o ejecutar flujos web. Vive en `src/components/browser-use-panel/` y se enchufa por `server/browser-use-mcp.ts`.

## Plugins activos

Dos plugins habilitados desde **Settings → Plugins**:

- **Project Stats.** Métricas del proyecto activo: conteo de archivos, líneas totales, breakdown por extensión, archivos más grandes, recientemente modificados.
- **Terminal.** Pestaña de terminal xterm.js multi-pestaña corriendo como plugin (independiente de la Consola CLI principal).

La carpeta `plugins/starter/` del repo es la plantilla base para agregar plugins propios.

## Estructura del repo

```
src/                  # Frontend Vite + React 18 + Tailwind
server/               # Backend Express + better-sqlite3 + ws
electron/             # Shell de escritorio (no usado en este deployment)
shared/               # Utilidades compartidas cliente/servidor
plugins/starter/      # Plantilla local de plugin
ecosystem.config.cjs  # Config de pm2
.env.example          # Variables de entorno reconocidas
package.json          # Scripts npm, engines, metadata
```

## Desarrollo local

Requisitos: Node 22 (recomendado vía `nvm` usando el `.nvmrc` del repo) y npm.

```bash
npm ci              # instalar dependencias
npm run dev         # backend (tsx watch) + frontend Vite en paralelo
```

Abrir `http://localhost:5173`. Vite proxea `/api`, `/ws`, `/shell` y `/plugin-ws` al backend en `:3001`. Para chequear tipos y lint:

```bash
npm run typecheck   # tsc sobre frontend + backend
npm run lint        # ESLint sobre src/ y server/
```

## Producción con pm2 (la vía de este fork)

Compilar:

```bash
npm run build       # vite build + tsc -p server/tsconfig.json
```

Si Node 22 no está primero en `PATH`, setear `NODE_BINARY` en `.env`:

```bash
echo 'NODE_BINARY=/opt/node22/bin/node' >> .env
```

Levantar y operar:

```bash
pm2 start ecosystem.config.cjs        # arranca "cloud-cli2026"
pm2 status                            # ver estado
pm2 logs cloud-cli2026                # tail de logs
pm2 restart cloud-cli2026             # tras un build nuevo
pm2 save                              # persistir el proceso al reboot
```

El wrapper `exec_interpreter` del config apunta a `process.env.NODE_BINARY || 'node'`. Cuando Node 24 es el default del sistema y los binarios nativos fueron compilados contra Node 22, setear `NODE_BINARY` no es opcional.

El proceso se reinicia solo (`autorestart: true`) con backoff exponencial, hasta 10 restarts, hasta 512 MB de RSS — si pasa eso, queda caído y hay que ver los logs.

## Configuración

Las variables reconocidas están en [`.env.example`](.env.example). Las más usadas:

| Variable | Default | Para qué |
|---|---|---|
| `SERVER_PORT` | `3001` | Puerto del backend Express + WebSocket |
| `VITE_PORT` | `5173` | Puerto de Vite (solo desarrollo) |
| `HOST` | `0.0.0.0` | Bind; usar `127.0.0.1` para limitar a localhost |
| `CLAUDE_CLI_PATH` | `claude` | Override del binario de Claude Code |
| `CONTEXT_WINDOW` | `160000` | Denominador de tokens por sesión |
| `DATABASE_PATH` | `~/.cloudcli/auth.db` | Ubicación del SQLite |
| `NODE_BINARY` | (no set) | Path del binario de Node 22 (pm2) |

## Agentes CLI soportados

Los cinco CLIs con los que la app habla. Cada uno tiene su carpeta en `server/modules/providers/list/` y expone cinco facets — `auth`, `mcp`, `skills`, `sessions`, `sessionSynchronizer` — definidos en `server/shared/interfaces.ts`.

- **Claude Code** (Anthropic). SDK: `@anthropic-ai/claude-agent-sdk`. Override del binario con `CLAUDE_CLI_PATH`.
- **Gemini CLI** (Google). Lee variables `GEMINI_AUTH_ENV_KEYS`.
- **Cursor CLI**. Wrapper propio en `server/cursor-cli.js`.
- **Codex** (OpenAI). SDK: `@openai/codex-sdk`.
- **OpenCode**. Open-source coding agent.

Para detalles del contrato entre providers ver [`server/modules/providers/README.md`](server/modules/providers/README.md).

## Internacionalización

Locales disponibles en `src/i18n/locales/`. Para agregar uno nuevo:

1. Copiar la carpeta `en/` con el nuevo code del idioma (ej.: `pt-BR/`).
2. Traducir los siete JSON: `auth`, `chat`, `codeEditor`, `common`, `settings`, `sidebar`, `tasks`.
3. Registrar el locale en el setup de `i18next` (`src/i18n/index.js` o similar).

Este fork tiene dos archivos `tasks.json` no commiteados todavía: `es/tasks.json` y `zh-TW/tasks.json`.

## Módulo "Control de versiones"

Panel de Git accesible desde la sidebar. Funciones: ver rama actual, ver cambios sin commitear (con archivos en categorías `M`/`A`/`D`/`?`), escribir mensajes de commit, ver historial con diff, revertir cambios locales. Estructura estándar del repo:

```
src/components/git-panel/
├── view/         # Componentes React
├── hooks/        # Custom hooks (useGitPanelController, useRevertLocalCommit…)
├── types/        # Tipos compartidos
└── utils/        # Helpers (buildFilePathCandidates, cleanCommitMessage…)
```

## Tests

Los tests están colocalizados con el código (`*.test.ts` o `*.test.js` al lado del archivo que cubren). No hay un `npm test`; se corren con `tsx` o `node --test` directamente:

```bash
npx tsx --test server/modules/database/tests/projects.db.integration.test.ts
node --test server/services/tests/notification-orchestrator.test.js
```

## Contribuciones y commits

Convención de commits: [Conventional Commits](https://www.conventionalcommits.org/) — el tipo (`feat`, `fix`, `perf`, `refactor`, `docs`, `chore`, `ci`, `test`, `build`) sale del archivo `.gitmessage` del repo y dispara el bump correspondiente al hacer `npm run release`.

Antes de abrir un PR conviene leer [`CONTRIBUTING.md`](CONTRIBUTING.md). Contexto de arquitectura y convenciones por módulo está en [`CLAUDE.md`](CLAUDE.md).

## Licencia

[GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later)](LICENSE) — ver el archivo para el texto completo, incluyendo los términos adicionales bajo Section 7. Si se modifica este software y se lo corre como servicio de red, hay que publicar el código modificado a los usuarios de ese servicio.
