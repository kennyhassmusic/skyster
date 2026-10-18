# Build chicago.json for the game from open data.
#
#   Buildings and tower parts: Overture Maps buildings theme (OpenStreetMap footprints with
#   USGS 3DEP lidar heights where OSM has none, Microsoft footprints for the gaps).
#   Streets, rail, river, lake, parks: OpenStreetMap via the Overpass API.
#
# Inputs (fetched separately, see the session notes): building.parquet, building_part.parquet
# from Overture release 2026-09-23.1, and osm.json from Overpass, all for the frame below.
#
# Usage: python build_chicago.py <dir with inputs> <out chicago.json> [old chicago.json to check alignment]
#
# Coordinates: metres from 41.883 N, 87.63 W; x east, z south (same as every earlier build, so the
# hand-placed landmarks, the Loop 'L' and the pickups stay where they were).

import json
import math
import statistics
import sys
from collections import defaultdict

import duckdb
from shapely import wkt as WKT
from shapely.geometry import LineString, MultiLineString, MultiPolygon, Point, Polygon, box
from shapely.ops import linemerge, polygonize, unary_union

LAT0, LON0 = 41.883, -87.63
KZ = 111320.0
KX = 111320.0 * math.cos(math.radians(LAT0))
FRAME = (-87.6680, 41.8530, -87.5950, 41.9080)   # lon/lat of the playable map
LAKE_FRAME = (-9500, -8000, 6500, 8000)          # x0, z0, x1, z1: the lake reaches the horizon

src = sys.argv[1]
out_path = sys.argv[2]
old_path = sys.argv[3] if len(sys.argv) > 3 else None


def to_xz(lon, lat):
    return ((lon - LON0) * KX, -(lat - LAT0) * KZ)


def proj_geom(g):
    import shapely
    return shapely.transform(g, lambda a: a * [KX, -KZ] + [-LON0 * KX, LAT0 * KZ])


fx0, fz1 = to_xz(FRAME[0], FRAME[1])
fx1, fz0 = to_xz(FRAME[2], FRAME[3])
frame = box(fx0, fz0, fx1, fz1)
lake_frame = box(*LAKE_FRAME)
print(f'map frame x {fx0:.0f}..{fx1:.0f}, z {fz0:.0f}..{fz1:.0f}')

r1 = lambda v: round(v, 1)


def ring_out(coords):
    pts = [[r1(x), r1(z)] for x, z in coords]
    if len(pts) > 1 and pts[0] == pts[-1]:
        pts.pop()
    clean = []
    for p in pts:
        if not clean or abs(p[0] - clean[-1][0]) + abs(p[1] - clean[-1][1]) > 0.05:
            clean.append(p)
    return clean


def polys(g):
    if g.is_empty:
        return []
    if isinstance(g, Polygon):
        return [g]
    if isinstance(g, MultiPolygon):
        return list(g.geoms)
    if hasattr(g, 'geoms'):
        return [p for p in g.geoms if isinstance(p, Polygon)]
    return []


# ---------------------------------------------------------------- buildings (Overture)
con = duckdb.connect()
B = con.execute(f"""SELECT id, name, has_parts, subtype, class, height, min_height, num_floors, min_floor,
    roof_color, facade_color, facade_material, is_underground, to_json(sources), wkt FROM '{src}/building.parquet'""").fetchall()
P = con.execute(f"""SELECT id, building_id, name, height, min_height, num_floors, min_floor,
    roof_color, facade_color, facade_material, is_underground, wkt FROM '{src}/building_part.parquet'""").fetchall()
osm = json.load(open(f'{src}/osm.json'))['elements']

MAT = {'glass': 'g', 'metal': 'g', 'brick': 'b', 'stone': 's', 'limestone': 's', 'marble': 's', 'granite': 's',
       'concrete': 's', 'plaster': 's', 'cement_block': 's', 'wood': 'b', 'sandstone': 's'}
CANOPY = {'roof', 'shelter', 'carport', 'canopy'}            # a roof on posts, not a solid block
CLASS_H = {'house': 8.5, 'detached': 8.5, 'semidetached_house': 8.5, 'terrace': 10.5, 'garage': 3.4,
           'garages': 3.4, 'shed': 3.0, 'kiosk': 3.5, 'service': 4.5, 'hut': 3.0, 'toilets': 3.5}
STATION = {'train_station', 'transportation', 'station'} | CANOPY
DECK = 6.3                                                     # the 'L' deck height used by the game


def floors_h(nf):
    return nf * 3.6 + 1.2 if nf else None


def width_of(g):
    ex = list(g.minimum_rotated_rectangle.exterior.coords)
    return min(math.dist(ex[0], ex[1]), math.dist(ex[1], ex[2]))


# the elevated CTA lines (the Loop is hand-built in the game at these streets)
L_LOOP = (-318, -312, 312, 690)   # west, north, east, south
elevated = [box(L_LOOP[0] - 5, L_LOOP[1] - 5, L_LOOP[2] + 5, L_LOOP[3] + 5).exterior]
for e in osm:
    t = e.get('tags', {})
    if e['type'] == 'way' and t.get('railway') == 'subway' and not t.get('tunnel') and \
            (t.get('bridge') in ('yes', 'movable', 'viaduct') or str(t.get('layer', '0')) in ('1', '2', '3')):
        elevated.append(LineString([to_xz(q['lon'], q['lat']) for q in e['geometry']]))
elevated_u = unary_union(elevated).buffer(4.0)

bld = []      # dicts: geom, h (or None), m, name, colour, material, roof colour, id, parts
by_id = {}
fixes = defaultdict(int)
for (bid, name, has_parts, subtype, cls, h, mh, nf, mf, rc, fc, fm, ug, srcs, wkt) in B:
    if ug:
        continue
    g = proj_geom(WKT.loads(wkt))
    c = g.representative_point()
    if not frame.contains(c):
        continue
    g = g.simplify(0.25, preserve_topology=True)
    if not g.is_valid:
        g = g.buffer(0)
    if g.area < 12:
        continue
    cls = cls or subtype
    if width_of(g) < 1.8 and cls not in CANOPY:
        fixes['walls and fences dropped'] += 1       # a wall mapped as a building: a weird slab in the game
        continue
    src_list = json.loads(srcs)
    hsrc = next((e.get('dataset') for e in src_list if e.get('property') == '/properties/height'), 'OpenStreetMap' if h else None)
    # a mapped floor count beats a machine-learned height outright, and beats lidar when lidar is far
    # off (a tower finished after the lidar flight reads as its podium; a low block next to a tower
    # can pick up the tower's roof)
    if h and nf and ((hsrc == 'Microsoft ML Buildings' and abs(h - (nf * 3.5 + 1)) > 0.25 * (nf * 3.5 + 1)) or
                     (hsrc == 'USGS Lidar' and (h < nf * 2.2 or h > nf * 6.5 + 6))):
        h = nf * 3.5 + 1.0
        fixes['heights corrected from the floor count'] += 1
    rec = dict(id=bid, g=g, h=h or floors_h(nf), m=mh or (mf * 3.6 if mf else 0), n=name, c=fc, f=MAT.get((fm or '').lower()),
               rc=rc, parts=[], has_parts=bool(has_parts), cls=cls, canopy=cls in CANOPY,
               guess=bool(h) and not nf and hsrc != 'OpenStreetMap')
    # an elevated CTA station sits on the 'L', above the street
    if (cls in STATION or (name and ('CTA' in name or 'Station' in name))) and g.intersects(elevated_u) and \
            g.intersection(elevated_u).area > 0.4 * g.area and 'Union Station' not in (name or ''):
        rec['m'] = DECK + 0.1
        rec['h'] = max(rec['h'] or 0, DECK + 4.2)
        rec['canopy'] = False
        fixes['CTA stations lifted onto the L'] += 1
    bld.append(rec)
    by_id[bid] = rec

for (pid, bid, name, h, mh, nf, mf, rc, fc, fm, ug, wkt) in P:
    if ug or bid not in by_id:
        continue
    g = proj_geom(WKT.loads(wkt)).simplify(0.2, preserve_topology=True)
    if not g.is_valid:
        g = g.buffer(0)
    if g.area < 4:
        continue
    by_id[bid]['parts'].append(dict(g=g, h=h or floors_h(nf), m=mh or (mf * 3.6 if mf else 0), n=name, c=fc,
                                    f=MAT.get((fm or '').lower()), rc=rc))

# duplicates: two footprints on the same spot at the same height flicker; keep the mapped one
tree_g = [b['g'] for b in bld]
from shapely.strtree import STRtree
tree = STRtree(tree_g)
drop = set()
for i, b in enumerate(bld):
    if i in drop:
        continue
    for j in tree.query(b['g'], predicate='intersects'):
        if j <= i or j in drop:
            continue
        o = bld[j]
        inter = b['g'].intersection(o['g']).area
        small = min(b['g'].area, o['g'].area)
        if inter > 0.8 * small and (b['h'] is None or o['h'] is None or abs((b['h'] or 0) - (o['h'] or 0)) < 1.5):
            loser = j if (b['n'] and not o['n']) or b['has_parts'] or (b['g'].area >= o['g'].area and not o['has_parts']) else i
            drop.add(loser)
            if loser == i:
                break
fixes['duplicate footprints removed'] = len(drop)
bld = [b for k, b in enumerate(bld) if k not in drop]

# a lidar or machine height with no floor count to back it, tall and far above every neighbour, is
# almost always the next tower's roof: bring it down to the block's median
_ref = defaultdict(list)
for b in bld:
    if b['h'] and not b['guess'] and not b['canopy']:
        _ref[(int(b['g'].centroid.x // 100), int(b['g'].centroid.y // 100))].append(b['h'])
for b in bld:
    if not b['guess'] or not b['h'] or b['h'] < 45:
        continue
    cx, cz = int(b['g'].centroid.x // 100), int(b['g'].centroid.y // 100)
    near = [h for ix in range(cx - 1, cx + 2) for iz in range(cz - 1, cz + 2) for h in _ref.get((ix, iz), ())]
    if len(near) >= 4 and b['h'] > 3 * statistics.median(near) and b['h'] > max(near) * 0.9:
        b['h'] = statistics.median(near)
        fixes['stray lidar spikes brought down'] += 1

# fill missing heights: a known building type gets its usual height, otherwise the median of the
# measured neighbours (a canopy is a canopy)
known = [(b['g'].centroid.x, b['g'].centroid.y, b['h']) for b in bld if b['h'] and not b['canopy']]
grid = defaultdict(list)
for x, z, h in known:
    grid[(int(x // 80), int(z // 80))].append((x, z, h))
filled = 0
for b in bld:
    if b['h'] and not b['canopy']:
        continue
    if b['canopy']:
        b['h'] = b['h'] if b['h'] and b['h'] < 14 else 4.6
        b['m'] = max(b['m'], b['h'] - 0.6)
        fixes['canopies drawn as roofs on posts'] += 1
        continue
    c = b['g'].centroid
    if b['cls'] in CLASS_H:
        b['h'] = CLASS_H[b['cls']]
    elif b['g'].area < 70:
        b['h'] = 3.6
    else:
        near = []
        for ix in range(int(c.x // 80) - 1, int(c.x // 80) + 2):
            for iz in range(int(c.y // 80) - 1, int(c.y // 80) + 2):
                for x, z, h in grid.get((ix, iz), ()):
                    if (x - c.x) ** 2 + (z - c.y) ** 2 < 100 ** 2:
                        near.append(h)
        b['h'] = min(40.0, max(6.0, statistics.median(near))) if near else 10.0
    filled += 1

buildings = []


def emit(g, h, m, name=None, colour=None, mat=None, roof=None):
    if h is None or h - m < 0.5:
        return
    for p in polys(g):
        ext = ring_out(p.exterior.coords)
        if len(ext) < 3:
            continue
        o = {'p': ext, 'h': r1(h), 'm': r1(m)}
        holes = [ring_out(i.coords) for i in p.interiors if Polygon(i).area > 25]
        holes = [hh for hh in holes if len(hh) >= 3]
        if holes:
            o['q'] = holes
        if name:
            o['n'] = name
        if colour:
            o['c'] = colour
        if mat:
            o['f'] = mat
        if roof:
            o['r'] = roof
        buildings.append(o)


with_parts = outline_kept = 0
for b in bld:
    parts = b['parts']
    # a lone sliver towering over a low building (a tall part that is the only tall thing, on a small
    # share of the footprint) is a mapping slip, not a tower: towers like Willis, Trump or NEMA have
    # tall pieces covering a real share of the outline and are kept
    if parts and b['h']:
        tall = [p for p in parts if p['h'] and p['h'] > 3 * b['h']]
        if tall and sum(p['g'].area for p in tall) < 0.25 * b['g'].area and all(p['g'].area < 300 for p in tall):
            parts = [p for p in parts if p not in tall]
            fixes['lone slivers dropped'] += len(tall)
    if parts:
        with_parts += 1
        known_parts = [p['h'] for p in parts if p['h']]
        for p in parts:
            ph = p['h']
            if not ph:
                # a part with no height at all: the main mass takes the building's height, a small piece
                # takes the lowest mapped part (or a podium height), never a full-height spike
                if p['g'].area >= 0.35 * b['g'].area:
                    ph = b['h']
                elif known_parts:
                    ph = min(known_parts)
                else:
                    ph = max(6.0, 0.35 * b['h'])
                fixes['tower parts without a height kept low'] += 0 if ph == b['h'] else 1
            emit(p['g'], ph, min(p['m'], ph - 0.5), p['n'] or b['n'], p['c'] or b['c'], p['f'] or b['f'], p['rc'] or b['rc'])
        ground_parts = [p['g'] for p in parts if p['m'] < 1.0]
        cover = unary_union(ground_parts).intersection(b['g']).area / b['g'].area if ground_parts else 0
        if cover < 0.6:
            # parts don't stand on the whole footprint: keep the outline as the base block
            top = min([p['h'] for p in parts if p['h']] + [b['h']])
            emit(b['g'], top if cover > 0.2 else b['h'], b['m'], b['n'], b['c'], b['f'], b['rc'])
            outline_kept += 1
    else:
        emit(b['g'], b['h'], min(b['m'], b['h'] - 0.5), b['n'], b['c'], b['f'], b['rc'])

print(f'buildings: {len(bld)} footprints -> {len(buildings)} blocks; {with_parts} with tower parts '
      f'({outline_kept} kept their outline as a base); {filled} heights estimated')
for k, v in fixes.items():
    print(f'  {k}: {v}')

# ---------------------------------------------------------------- OpenStreetMap layers


def way_line(e):
    return LineString([to_xz(p['lon'], p['lat']) for p in e['geometry']]) if len(e.get('geometry', [])) >= 2 else None


def way_poly(e):
    pts = [to_xz(p['lon'], p['lat']) for p in e.get('geometry', [])]
    if len(pts) >= 4 and pts[0] == pts[-1]:
        p = Polygon(pts)
        return p if p.is_valid else p.buffer(0)
    return None


def rel_poly(e):
    outers, inners = [], []
    for m in e.get('members', []):
        if m.get('type') != 'way' or len(m.get('geometry', [])) < 2:
            continue
        ln = LineString([to_xz(p['lon'], p['lat']) for p in m['geometry']])
        (inners if m.get('role') == 'inner' else outers).append(ln)
    o = unary_union(list(polygonize(linemerge(MultiLineString(outers))))) if outers else Polygon()
    if inners:
        o = o.difference(unary_union(list(polygonize(linemerge(MultiLineString(inners))))))
    return o if o.is_valid else o.buffer(0)


def tagged_polys(pred, clip, min_area):
    out = []
    for e in osm:
        t = e.get('tags', {})
        if not pred(t):
            continue
        g = way_poly(e) if e['type'] == 'way' else rel_poly(e)
        if g is None or g.is_empty:
            continue
        g = g.intersection(clip)
        for p in polys(g):
            if p.area >= min_area:
                out.append(p.simplify(0.4, preserve_topology=True))
    return out


# lake: Lake Michigan's own outline, clipped to the horizon frame
lake = tagged_polys(lambda t: t.get('natural') == 'water' and t.get('water') == 'lake' and t.get('name') == 'Lake Michigan',
                    lake_frame, 1000)
water = tagged_polys(lambda t: (t.get('natural') == 'water' and t.get('name') != 'Lake Michigan') or t.get('waterway') == 'riverbank',
                     frame, 20)
water_u = unary_union(water) if water else Polygon()
green = lambda t: t.get('leisure') in ('park', 'garden') or t.get('landuse') in ('grass', 'recreation_ground', 'village_green')
field = lambda t: t.get('leisure') in ('pitch', 'playground')
# parks drawn under water would show through: cut the water out. Sports fields and playgrounds get no trees.
parks = [(q, 0) for p in tagged_polys(green, frame, 60) for q in polys(p.difference(water_u)) if q.area >= 60]
parks += [(q, 1) for p in tagged_polys(field, frame, 60) for q in polys(p.difference(water_u)) if q.area >= 60]
print(f'lake: {len(lake)} polygons, {sum(len(p.exterior.coords) for p in lake)} points; water {len(water)}; parks {len(parks)}')

ROAD_KINDS = {'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'service',
              'living_street', 'pedestrian'}
DEFAULT_W = {'motorway': 15.4, 'trunk': 14.0, 'primary': 16.0, 'secondary': 15.0, 'tertiary': 13.0,
             'residential': 10.0, 'unclassified': 10.0, 'service': 6.0, 'pedestrian': 7.0}
roads = []
for e in osm:
    t = e.get('tags', {})
    hw = t.get('highway')
    if e['type'] != 'way' or not hw:
        continue
    kind = hw.replace('_link', '')
    if kind == 'living_street':
        kind = 'residential'
    if kind not in ROAD_KINDS or t.get('area') == 'yes':
        continue
    if t.get('tunnel') in ('yes', 'covered', 'building_passage') or t.get('covered') == 'yes':
        continue
    try:
        layer = int(t.get('layer', '0'))
    except ValueError:
        layer = 0
    if layer < 0:
        continue   # Lower Wacker and the other lower-level streets: the game has no underground
    if kind == 'service' and t.get('service') in ('parking_aisle', 'drive-through'):
        continue
    ln = way_line(e)
    if ln is None:
        continue
    g = ln.intersection(frame)
    lines = [g] if isinstance(g, LineString) else [x for x in getattr(g, 'geoms', []) if isinstance(x, LineString)]
    try:
        lanes = int(str(t.get('lanes', '')).split(';')[0])
    except ValueError:
        lanes = 0
    if lanes:
        w = lanes * 3.4 + (2.0 if kind in ('primary', 'secondary', 'tertiary', 'trunk') else 0.6)
        if hw.endswith('_link'):
            w = min(w, 9.0)
        w = max(5.0, min(30.0, w))
    else:
        w = DEFAULT_W[kind] if not hw.endswith('_link') else 8.0
    bridge = 1 if t.get('bridge') in ('yes', 'movable', 'viaduct', 'cantilever') else 0
    for l in lines:
        if l.length < 2:
            continue
        l = l.simplify(0.3)
        roads.append({'p': [[r1(x), r1(z)] for x, z in l.coords], 'w': r1(w), 'b': bridge, 'k': kind})
print(f'roads: {len(roads)}')

# ---------------------------------------------------------------- the street network for traffic
# Ways split at shared OSM nodes into edges between intersections, with one-way direction, lanes and
# width, plus the real traffic signals and stop signs. Alleys and parking aisles are left out: traffic
# and pedestrians use streets.
import os
from collections import Counter
NET_KINDS = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'unclassified']
sig_path = f'{src}/signals.json'
sig_el = json.load(open(sig_path))['elements'] if os.path.exists(sig_path) else []
net_ways = []
for e in osm:
    t = e.get('tags', {})
    hw = t.get('highway')
    if e['type'] != 'way' or not hw or 'nodes' not in e:
        continue
    kind = hw.replace('_link', '')
    if kind == 'living_street':
        kind = 'residential'
    if kind not in NET_KINDS or t.get('area') == 'yes' or t.get('access') in ('no', 'private'):
        continue
    if t.get('tunnel') in ('yes', 'covered', 'building_passage') or t.get('covered') == 'yes':
        continue
    try:
        layer = int(t.get('layer', '0'))
    except ValueError:
        layer = 0
    if layer < 0:
        continue
    ow = t.get('oneway')
    if ow == 'reversible':
        continue
    oneway = 1 if ow in ('yes', '1', 'true') else -1 if ow == '-1' else 0
    if oneway == 0 and ow != 'no' and (kind == 'motorway' or t.get('junction') in ('roundabout', 'circular')):
        oneway = 1
    try:
        lanes = int(str(t.get('lanes', '')).split(';')[0])
    except ValueError:
        lanes = 0
    if lanes:
        w = max(5.0, min(30.0, lanes * 3.4 + (2.0 if kind in ('primary', 'secondary', 'tertiary', 'trunk') else 0.6)))
        if hw.endswith('_link'):
            w = min(w, 9.0)
    else:
        w = DEFAULT_W[kind] if not hw.endswith('_link') else 8.0
        lanes = 1 if hw.endswith('_link') else (2 if oneway else 2) if kind in ('residential', 'unclassified') else (3 if oneway else 4)
    ids = e['nodes']
    pts = [to_xz(q['lon'], q['lat']) for q in e['geometry']]
    if oneway == -1:
        ids, pts, oneway = ids[::-1], pts[::-1], 1
    net_ways.append((ids, pts, NET_KINDS.index(kind), round(w, 1), lanes, oneway,
                     1 if t.get('bridge') in ('yes', 'movable', 'viaduct', 'cantilever') else 0))
use = Counter()
for ids, *_ in net_ways:
    use.update(ids)
    use[ids[0]] += 2
    use[ids[-1]] += 2
vid, nodes_xy, edges = {}, [], []


def vertex(nid, xy):
    if nid not in vid:
        vid[nid] = len(nodes_xy)
        nodes_xy.append([r1(xy[0]), r1(xy[1])])
    return vid[nid]


for ids, pts, k, w, lanes, oneway, bridge in net_ways:
    start = 0
    for i in range(1, len(ids)):
        if use[ids[i]] >= 2 or i == len(ids) - 1:
            seg = pts[start:i + 1]
            if all(frame.contains(Point(x, z)) for x, z in seg) and len(seg) >= 2:
                ln = LineString(seg)
                if ln.length > 1.0:
                    a, b = vertex(ids[start], seg[0]), vertex(ids[i], seg[-1])
                    flat = [c for x, z in ln.simplify(0.4).coords for c in (r1(x), r1(z))]
                    edges.append([a, b, k, w, lanes, oneway, bridge, flat])
            start = i
deg = Counter()
for a, b, *_ in edges:
    deg[a] += 1
    deg[b] += 1
# signals and stop signs onto the nearest intersection (OSM puts them on the junction node, or on
# each approach of a divided street)
vgrid = defaultdict(list)
for i, (x, z) in enumerate(nodes_xy):
    if deg[i] >= 3:
        vgrid[(int(x // 30), int(z // 30))].append(i)
signals, stops = set(), set()
for el in sig_el:
    kind = el.get('tags', {}).get('highway')
    if kind not in ('traffic_signals', 'stop'):
        continue
    x, z = to_xz(el['lon'], el['lat'])
    best, bd = None, 22.0 ** 2
    for ix in range(int(x // 30) - 1, int(x // 30) + 2):
        for iz in range(int(z // 30) - 1, int(z // 30) + 2):
            for i in vgrid.get((ix, iz), ()):
                d = (nodes_xy[i][0] - x) ** 2 + (nodes_xy[i][1] - z) ** 2
                if d < bd:
                    best, bd = i, d
    if best is not None:
        (signals if kind == 'traffic_signals' else stops).add(best)
stops -= signals
# the largest strongly connected part: traffic stays on it so no car drives into a one-way dead end
adj, radj = defaultdict(list), defaultdict(list)
for a, b, k, w, l, o, br, flat in edges:
    adj[a].append(b); radj[b].append(a)
    if not o:
        adj[b].append(a); radj[a].append(b)
order, seen = [], [False] * len(nodes_xy)
for s0 in range(len(nodes_xy)):
    if seen[s0]:
        continue
    stack = [(s0, iter(adj[s0]))]
    seen[s0] = True
    while stack:
        v, it = stack[-1]
        for w_ in it:
            if not seen[w_]:
                seen[w_] = True
                stack.append((w_, iter(adj[w_])))
                break
        else:
            order.append(v)
            stack.pop()
comp = [-1] * len(nodes_xy)
nc = 0
for s0 in reversed(order):
    if comp[s0] >= 0:
        continue
    st = [s0]
    comp[s0] = nc
    while st:
        v = st.pop()
        for w_ in radj[v]:
            if comp[w_] < 0:
                comp[w_] = nc
                st.append(w_)
    nc += 1
main_c = Counter(comp).most_common(1)[0][0]
for e in edges:
    e.append(1 if comp[e[0]] == main_c and comp[e[1]] == main_c else 0)
print(f'connected core: {sum(e[8] for e in edges)} of {len(edges)} edges')
net = {'k': NET_KINDS, 'n': nodes_xy, 'e': edges, 's': sorted(signals), 't': sorted(stops)}
print(f'street network: {len(nodes_xy)} nodes, {len(edges)} edges '
      f'({sum(1 for e in edges if e[5])} one-way), {len(signals)} signalled and {len(stops)} stop-sign intersections')

# the CTA 'L' outside the Loop: elevated structure only (the Loop itself is modelled by hand)
rail = []
for e in osm:
    t = e.get('tags', {})
    if e['type'] != 'way' or t.get('railway') != 'subway' or t.get('tunnel'):
        continue
    try:
        layer = int(t.get('layer', '0'))
    except ValueError:
        layer = 0
    if not (t.get('bridge') in ('yes', 'movable', 'viaduct') or layer >= 1):
        continue
    if t.get('name') == "Loop 'L'":
        continue
    ln = way_line(e)
    if ln is None:
        continue
    g = ln.intersection(frame)
    for l in ([g] if isinstance(g, LineString) else [x for x in getattr(g, 'geoms', []) if isinstance(x, LineString)]):
        if l.length > 5:
            rail.append({'p': [[r1(x), r1(z)] for x, z in l.simplify(0.4).coords], 'n': t.get('name', ''),
                         'm': 1 if t.get('bridge') == 'movable' else 0})
print(f'elevated CTA track ways: {len(rail)}')

data = {
    'origin': [LAT0, LON0],
    'attribution': '© OpenStreetMap contributors (ODbL) · Overture Maps Foundation · USGS 3DEP lidar heights',
    'bounds': [r1(fx0), r1(fz0), r1(fx1), r1(fz1)],
    'buildings': buildings,
    'roads': roads,
    'water': [{'p': ring_out(p.exterior.coords)} for p in water if len(p.exterior.coords) >= 4],
    'lake': [{'p': ring_out(p.exterior.coords), 'q': [ring_out(i.coords) for i in p.interiors if Polygon(i).area > 400]} for p in lake],
    'parks': [dict({'p': ring_out(p.exterior.coords)}, **({'k': 'field'} if f else {})) for p, f in parks if len(p.exterior.coords) >= 4],
    'rail': rail,
    'net': net,
}

# alignment check against the previous build: same named buildings should sit on top of each other
if old_path:
    old = json.load(open(old_path))
    on = {b['n']: b for b in old['buildings'] if b.get('n')}
    d = []
    for b in buildings:
        o = on.get(b.get('n'))
        if not o:
            continue
        cx = sum(p[0] for p in b['p']) / len(b['p']); cz = sum(p[1] for p in b['p']) / len(b['p'])
        ox = sum(p[0] for p in o['p']) / len(o['p']); oz = sum(p[1] for p in o['p']) / len(o['p'])
        if abs(cx - ox) < 50 and abs(cz - oz) < 50:
            d.append((cx - ox, cz - oz))
    if d:
        print(f'alignment vs old build: {len(d)} named matches, median offset x {statistics.median(a for a, _ in d):+.2f} m, '
              f'z {statistics.median(b for _, b in d):+.2f} m')

with open(out_path, 'w') as f:
    json.dump(data, f, separators=(',', ':'))
import os
print(f'wrote {out_path}: {os.path.getsize(out_path) / 1e6:.2f} MB')
hs = sorted((b['h'] for b in buildings), reverse=True)
print('tallest blocks:', [(b.get('n'), b['h']) for b in sorted(buildings, key=lambda b: -b['h'])[:10]])
