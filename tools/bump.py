# Stamp a build number everywhere it matters, including a ?v= query on every local module import so a
# reload of the published page cannot keep an older module from the browser cache.
# Usage: python3 tools/bump.py 2.6
import re, sys, pathlib
v = sys.argv[1]
for p in pathlib.Path('js').glob('*.js'):
    s = p.read_text()
    s2 = re.sub(r"from '\./([a-z]+)\.js(?:\?v=[0-9.]+)?'", lambda m: f"from './{m.group(1)}.js?v={v}'", s)
    if p.name == 'main.js':
        s2 = re.sub(r"const BUILD = '[0-9.]+';", f"const BUILD = '{v}';", s2)
    if s2 != s: p.write_text(s2); print('stamped', p)
h = pathlib.Path('index.html'); s = h.read_text()
s2 = re.sub(r'src="js/main\.js(?:\?v=[0-9.]+)?"', f'src="js/main.js?v={v}"', s)
s2 = re.sub(r'build [0-9.]+</p>', f'build {v}</p>', s2)
if s2 != s: h.write_text(s2); print('stamped', h)
