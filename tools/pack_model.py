# Wrap a .glb as an ES module (base64), because artifacts serve scripts but not .glb files.
# Usage: python3 tools/pack_model.py assets/roadster.glb js/roadster-model.js
import base64, sys
src, dst = sys.argv[1], sys.argv[2]
data = base64.b64encode(open(src, 'rb').read()).decode('ascii')
with open(dst, 'w') as f:
    f.write('// Kenny\'s Roadster model (glTF binary, meshopt + WebP), base64. Built by tools/pack_model.py.\n')
    f.write('export default "' + data + '";\n')
print(dst, len(data) / 1e6, 'MB')
