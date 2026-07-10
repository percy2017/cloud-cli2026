# CloudCli v0.2
WebApp en node22 para gestionar agentes cli, proyectos y repositorios

```bash
PATH=/opt/node22/bin:$PATH
```

## Instalacion

```bash
git clone https://github.com/percy2017/cloud-cli2026.git
cp .env.example .env
npm install
```

## Produccion con pm2

```bash
npm run build npm run build 
pm2 start ecosystem.config.cjs
```

## Agentes Cli Disponibles
- Claude Code
- Opencode
- Codex
- Cursos (en desaroollo)
- Gemini (en desaroollo)
- Qwen Code (en desaroollo)

## Caracteristicas
- Multi LLM
- Multi Arnes
- Lecturas de imagenes y Audios
- Gestion de MCP
- Gestion de Skills
- Gestion de plugins