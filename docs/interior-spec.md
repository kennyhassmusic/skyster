# Roadster interior: spec for the cockpit view

The game (Roadster Chicago, three.js) gets a driver's-eye camera. Please model the cabin as a
separate **`roadster_interior.glb`** that lines up with `roadster_master.glb`. The game loads it
only when the player switches to the cockpit camera, steers the yoke, and draws a live Track Mode
screen onto the centre display.

Reference: Kenny's four interior photos (yoke with white suede grips, hexagonal black hub with the
Roadster badge, floating red Track Mode screen right of the yoke on a silver-framed stalk, dark
Alcantara dash, carbon-fibre lower dash and tunnel, white perforated seats, red ambient strips in
the doors, triangular rear-view mirror pod).

## Coordinate frame: same as roadster_master.glb

- metres, +Y up, **+Z forward** (nose at +Z), **+X = the car's left**. Same origin as the exterior
  file; no transform on the root node.
- Left-hand drive: the driver sits on **+X**.
- Measured from the exterior shell (outer surface):
  - body: x ±1.15, y 0.01 to 1.27, z ±2.35; front axle z = +1.27, rear axle z = -1.54
  - roof outer surface at x = 0: y 1.24 at z = -0.1; 1.20 at z = +0.4; 1.13 at +0.6; 0.99 at +1.0;
    0.83 at +1.4 (windshield and hood are one continuous slope); 1.15 at z = -1.2; 0.98 at -1.8
  - roof at the driver's x = 0.37 is about 1 cm lower than at the centre line
  - half-width of the shell at z = 0: 0.95 at y 0.7 (shoulder), 0.79 at y 0.9, 0.73 at y 1.0,
    0.65 at y 1.1, 0.58 at y 1.2 (strong tumblehome)
- Everything must stay inside that shell (allow about 2 cm for the skin).

## What the player sees

From inside, the exterior shell is invisible (its faces point outward and are culled). So the
interior has to supply every surface the driver should see that isn't glass: dash, door cards,
sills, pillars and any opaque roof. Wherever the exterior has glass, leave the interior open.
Faces of the cabin should point inward, toward the driver.

## Named nodes (exact names; the game looks them up)

| Node | What it is |
|---|---|
| `Interior` | root, identity transform |
| `DriverEye` | empty at the driver's eye, looking along +Z. Expected near (0.37, 1.02, -0.35); move it to wherever the seat puts the eye |
| `Yoke_Pivot` | empty on the steering column axis at the yoke's centre. Its **local +Z points along the column, from the dash toward the driver**. The game steers by rotating this node about its local Z (positive = turning left) |
| `Yoke` | yoke meshes, children of `Yoke_Pivot`: white suede grips with the thin outer rim, chrome spokes, black hexagonal hub with the badge, scroll buttons |
| `Paddle_L`, `Paddle_R` | shift paddles behind the yoke, children of `Yoke_Pivot` (optional) |
| `Screen_Display` | the centre screen's glass: **one quad (2 triangles)**, UVs (0,0) bottom-left to (1,1) top-right, aspect 16:10, own material named `ScreenDisplay`. The game replaces its material with a live canvas |
| `Screen_Bezel` | the screen's frame and stalk |
| `Dash`, `Console`, `Seat_L`, `Seat_R`, `DoorCard_L`, `DoorCard_R`, `Floor`, `Pedals`, `Mirror`, `Pillars` | the rest; split however suits you, these names just help |
| `Ambient_L`, `Ambient_R` | red ambient strips in the door cards, material named `AmbientRed` (the game brightens it at night) |

## Materials and budget

- Alcantara dark grey (around #2a2a2c, rough), carbon fibre (weave texture or normal map),
  white perforated leather for the seats, white suede yoke grips, gloss black hub, brushed
  aluminium / chrome trim, gold-tone paddles, black screen bezel.
- Under about 80k triangles total; textures up to 2048 px (the game recompresses with
  gltf-transform: meshopt + webp, so keep node names unique and don't merge the named nodes).
- Most of the frame is the yoke, the screen and the dash top, all within a metre of the eye:
  spend the detail there. Seats and floor are mostly out of view.

## Delivery

Save as `roadster_interior.glb` (Downloads is fine) and tell Kenny. The game shows a simpler
stand-in cabin until the file arrives.
