#!/usr/bin/env bash
# Build para Vercel: compila la API (Nest) y la consola (Angular), y deja los
# estáticos en `<cwd inicial>/.vercel-out` (lo que declara outputDirectory).
#
# Está escrito para funcionar sin importar cómo esté configurado el proyecto
# en Vercel, porque cada variante rompe de una forma distinta:
#   - Root Directory = raíz del repo  → caso normal.
#   - Root Directory = apps/api o apps/console → Vercel arranca dentro de un
#     workspace e instala SOLO sus dependencias; el binario del otro workspace
#     no existe (`npx: could not determine executable to run`).
# Por eso: se localiza la raíz, se asegura el install completo del monorepo y
# los binarios se invocan por ruta absoluta (nunca con npx).
set -euo pipefail

start="$(pwd)"
echo "▶ cwd inicial: $start"

# --- 1. Localizar la raíz del monorepo (la que contiene ambos workspaces) ---
root="$start"
for _ in 1 2 3 4; do
  if [ -d "$root/apps/api" ] && [ -d "$root/apps/console" ]; then break; fi
  root="$(dirname "$root")"
done

if [ ! -d "$root/apps/api" ] || [ ! -d "$root/apps/console" ]; then
  echo "✖ No encontré la raíz del monorepo (apps/api + apps/console) desde $start" >&2
  exit 1
fi

cd "$root"
echo "▶ raíz del monorepo: $root"

# --- 2. Buscar un binario en la raíz o en cualquiera de los workspaces ---
find_bin() {
  local name="$1" candidate
  for candidate in \
    "$root/node_modules/.bin/$name" \
    "$root/apps/api/node_modules/.bin/$name" \
    "$root/apps/console/node_modules/.bin/$name"; do
    if [ -x "$candidate" ]; then echo "$candidate"; return 0; fi
  done
  return 1
}

# --- 3. Asegurar las dependencias de TODO el monorepo ---
# Si Vercel instaló solo las de un workspace, falta el compilador del otro.
if ! find_bin nest >/dev/null || ! find_bin ng >/dev/null; then
  echo "▶ faltan dependencias del monorepo; instalando desde la raíz…"
  npm install --no-audit --no-fund
fi

NEST="$(find_bin nest)" || { echo "✖ No encontré el binario 'nest'" >&2; exit 1; }
NG="$(find_bin ng)" || { echo "✖ No encontré el binario 'ng'" >&2; exit 1; }
echo "▶ nest: $NEST"
echo "▶ ng:   $NG"

# --- 4. Compilar ---
echo "▶ compilando API (nest build)…"
(cd "$root/apps/api" && "$NEST" build)

echo "▶ compilando consola (ng build)…"
(cd "$root/apps/console" && "$NG" build)

# --- 5. Publicar los estáticos donde Vercel los busca ---
# Nombre propio (.vercel-out) para no chocar con los `dist/` de nest ni de ng,
# y vía temporal porque el destino puede contener a la carpeta origen.
out="$start/.vercel-out"
echo "▶ publicando estáticos en $out…"
tmp="$(mktemp -d)"
cp -R "$root/apps/console/dist/console/browser/." "$tmp/"
rm -rf "$out"
mkdir -p "$out"
cp -R "$tmp/." "$out/"
rm -rf "$tmp"

echo "✔ build completo:"
ls -la "$root/apps/api/dist/app.module.js"
ls -la "$out/index.html"
