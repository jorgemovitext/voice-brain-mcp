#!/usr/bin/env bash
# Build para Vercel: compila la API (Nest) y la consola (Angular).
#
# Deliberadamente NO usa `npm run --workspace`: Vercel puede ejecutar el
# buildCommand desde un subdirectorio (p. ej. apps/console si lo tomó como
# Root Directory), y ahí npm responde `No workspaces found`. Acá se localiza
# la raíz del monorepo y se invocan los binarios directamente con npx, que
# los resuelve tanto si npm hizo hoisting a la raíz como si no.
set -euo pipefail

# Vercel busca `outputDirectory` relativo a ESTE directorio, sea cual sea.
start="$(pwd)"
echo "▶ cwd inicial: $start"

# Subir hasta la raíz del monorepo (la que contiene ambos workspaces).
root="$(pwd)"
for _ in 1 2 3 4; do
  if [ -d "$root/apps/api" ] && [ -d "$root/apps/console" ]; then break; fi
  root="$(dirname "$root")"
done

if [ ! -d "$root/apps/api" ] || [ ! -d "$root/apps/console" ]; then
  echo "✖ No encontré la raíz del monorepo (apps/api + apps/console) desde $(pwd)" >&2
  echo "  Revisá el Root Directory del proyecto en Vercel: debe ser la raíz del repo." >&2
  exit 1
fi

cd "$root"
echo "▶ raíz del monorepo: $(pwd)"

echo "▶ compilando API (nest build)…"
(cd apps/api && npx nest build)

echo "▶ compilando consola (ng build)…"
(cd apps/console && npx ng build)

# La consola queda en `<cwd inicial>/dist`, que es lo que declara
# `outputDirectory`. Copiarla evita que un Root Directory distinto al esperado
# deje a Vercel sirviendo un directorio vacío (404 NOT_FOUND).
echo "▶ publicando estáticos en $start/dist…"
# Vía un temporal: si el cwd inicial es apps/console, el destino ($start/dist)
# contiene a la carpeta origen y borrarlo antes de copiar la destruiría.
tmp="$(mktemp -d)"
cp -R apps/console/dist/console/browser/. "$tmp/"
rm -rf "$start/dist"
mkdir -p "$start/dist"
cp -R "$tmp/." "$start/dist/"
rm -rf "$tmp"

echo "✔ build completo:"
ls -la apps/api/dist/app.module.js
ls -la "$start/dist/index.html"
