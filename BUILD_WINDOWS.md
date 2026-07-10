# 🪟 Compilar CloudCLI para Windows (.exe)

## ✅ Build ya generado

Este repositorio ya tiene un instalador Windows listo en:

```
release/desktop/cloudcli-desktop-1.35.1-win-x64.exe    (96 MB — instalador NSIS)
release/desktop/win-unpacked/CloudCLI.exe              (201 MB — portable, sin instalador)
```

> El instalador `.exe` es **NSIS self-extracting** — funciona en Windows 10/11 x64.

---

## 🚀 Compilar de nuevo desde este servidor Linux

Ya está todo configurado. Solo ejecuta:

```bash
cd /opt/cloud-cli2026
PATH=/opt/node22/bin:$PATH npm run build       # build frontend + backend
PATH=/opt/node22/bin:$PATH npm run desktop:stage  # prepara estructura
cd .desktop-build/desktop-app
PATH=/opt/node22/bin:$PATH npx electron-builder --win nsis --x64
```

El `.exe` aparece en `release/desktop/`.

---

## ☁️ Compilar automáticamente con GitHub Actions (recomendado para producción)

Ya está creado el workflow en `.github/workflows/build-desktop.yml`.

### Cómo activarlo:

1. **Sube el repo a GitHub** (si aún no está).
2. El workflow se ejecuta automáticamente al hacer push a `main` o al crear un tag `v*` (ej: `v1.35.2`).
3. También puedes dispararlo manual desde la pestaña **Actions → Build Desktop Installers → Run workflow**.

### Resultado:

En cada ejecución, GitHub genera:
- `cloudcli-windows-x64.zip` con el `.exe` (descargable desde la pestaña Actions).
- `cloudcli-macos-x64.zip` con el `.dmg` (solo en push a `main`/tags).

### Para releases oficiales (firmados):

Configura estos **secrets** en GitHub (Settings → Secrets → Actions):
- `MACOS_CERT_P12` — certificado de Developer ID (base64) para firmar el `.dmg`.
- `MACOS_CERT_PASSWORD` — contraseña del certificado.
- `APPLE_ID` y `APPLE_APP_SPECIFIC_PASSWORD` — para notarización Apple.

---

## 🐛 Troubleshooting

### El .exe no abre en Windows

- **SmartScreen lo bloquea**: es normal sin firma digital. El usuario debe hacer clic en "Más información → Ejecutar de todas formas".
- **Falta Visual C++ Redistributable**: Electron 38 requiere VC++ 2019+ (ya viene en Windows 11; en Windows 10 puede requerir actualización).

### El instalador falla a mitad de camino

- Verifica que no haya instancias de `CloudCLI.exe` corriendo antes de reinstalar.
- Borra `%APPDATA%/CloudCLI` y `%LOCALAPPDATA%/CloudCLI` antes de reinstalar.

### Build falla con "wine: required version X not found"

```bash
apt-get install -y wine wine32:i386
wine --version
```

### Errores nativos (better-sqlite3, node-pty)

```bash
PATH=/opt/node22/bin:$PATH npm run fix:native
```

---

## 📦 Distribución

Sube el `.exe` a:
- **GitHub Releases** (en la página del tag).
- Tu web `cloudcli.ai`.
- Microsoft Store (requiere empaquetado `.appx` adicional).

