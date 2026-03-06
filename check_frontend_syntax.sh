#!/usr/bin/env bash
set -euo pipefail

python3 - <<'PY'
from pathlib import Path
html = Path('index.html').read_text(encoding='utf-8')
start = html.find('<script>')
end = html.rfind('</script>')
if start == -1 or end == -1 or end <= start:
    raise SystemExit('Bloco <script> não encontrado em index.html')
Path('/tmp/index_script.js').write_text(html[start+8:end], encoding='utf-8')
print('Extracted frontend script to /tmp/index_script.js')
PY

node --check /tmp/index_script.js
printf 'OK: frontend script syntax\n'
