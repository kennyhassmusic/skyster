import * as THREE from 'three';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { TilesRenderer, WGS84_ELLIPSOID } from '3d-tiles-renderer';
import { GoogleCloudAuthPlugin, GLTFExtensionsPlugin, TileCompressionPlugin, UnloadTilesPlugin, ReorientationPlugin } from '3d-tiles-renderer/plugins';

// Photoreal Chicago: Google's Photorealistic 3D Tiles drawn over the open-data city. It only draws.
// The car still drives, rides walls and lands on the Overture / OpenStreetMap footprint colliders that
// city.js builds; those stay exactly as they are while the procedural meshes are hidden. Tiles stream
// from Google with the player's own API key and live only in memory for the frame (no prefetch, no
// storage, no export), as the Map Tiles API policies require.

const D2R = Math.PI / 180;
const ORIGIN = { lat: 41.883, lon: -87.63 }; // chicago.json's origin; the game frame is +x east, +z south
const KX = 111320 * Math.cos(ORIGIN.lat * D2R), KZ = 111320; // chicago.json's metres per degree
const GROUND_H = 147; // Loop street level above the WGS84 ellipsoid (~181 m NAVD88, geoid -34 m); trimmed by calibrate()
const ROOT = 'https://tile.googleapis.com/v1/3dtiles/root.json';
const DRACO = 'https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/libs/draco/gltf/';

// Google Maps logo (outlined version, for busy backgrounds), from Google's attribution assets
export const LOGO = 'data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0idXRmLTgiPz4KPCEtLSBHZW5lcmF0b3I6IEFkb2JlIElsbHVzdHJhdG9yIDI2LjUuMCwgU1ZHIEV4cG9ydCBQbHVnLUluIC4gU1ZHIFZlcnNpb246IDYuMDAgQnVpbGQgMCkgIC0tPgo8c3ZnIHZlcnNpb249IjEuMSIgaWQ9IkxheWVyXzEiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyIgeG1sbnM6eGxpbms9Imh0dHA6Ly93d3cudzMub3JnLzE5OTkveGxpbmsiIHg9IjBweCIgeT0iMHB4IgoJIHdpZHRoPSIxMDVweCIgaGVpZ2h0PSIyMnB4IiB2aWV3Qm94PSIwIDAgMTA1IDIyIiBlbmFibGUtYmFja2dyb3VuZD0ibmV3IDAgMCAxMDUgMjIiIHhtbDpzcGFjZT0icHJlc2VydmUiPgo8ZyBpZD0iTG9nbyI+Cgk8ZyBpZD0iT3V0bGluZSIgb3BhY2l0eT0iMC44Ij4KCQk8cGF0aCBmaWxsPSIjMUUxRTFFIiBkPSJNNTkuNzcsMTEuNDRsLTAuOTMtMi4zMmMtMC4xNi0wLjQtMC4zNi0wLjgxLTAuNjEtMS4yMmMtMC4yNi0wLjQyLTAuNi0wLjg1LTEuMDEtMS4yNwoJCQljLTAuNDktMC41LTEuMS0wLjktMS44LTEuMmMtMC43MS0wLjMtMS40OS0wLjQ2LTIuMy0wLjQ2Yy0xLjE2LDAtMi4yNSwwLjMtMy4xOSwwLjg3VjAuNDhoLTUuOTh2NC43N0g0MgoJCQljLTAuNTQtMC4xOC0xLjEyLTAuMjctMS43Mi0wLjI3Yy0xLjY4LDAtMy4yMSwwLjY2LTQuNDQsMS45MmMtMC4wOSwwLjA5LTAuMTgsMC4xOS0wLjI2LDAuMjljLTAuMS0wLjEyLTAuMjEtMC4yNC0wLjMzLTAuMzUKCQkJYy0xLjI2LTEuMjMtMi44MS0xLjg2LTQuNi0xLjg2Yy0xLjc3LDAtMy4zNiwwLjY0LTQuNiwxLjg2Yy0wLjExLDAuMTEtMC4yMiwwLjIyLTAuMzIsMC4zNGMtMC4xLTAuMTItMC4yMS0wLjIzLTAuMzItMC4zNAoJCQljLTEuMjYtMS4yMy0yLjgxLTEuODYtNC42LTEuODZjLTEuNTUsMC0yLjkxLDAuNDYtNC4wNiwxLjM4aC0yLjQ3bDIuNDYtMi40NmwtMS40OC0xLjQxQzEzLjUzLDAuODMsMTEuNDYsMCw5LjA4LDAKCQkJQzYuNjIsMCw0LjQ3LDAuODgsMi43LDIuNjJDMC45MSw0LjM4LDAsNi41MSwwLDguOThzMC45MSw0LjYxLDIuNyw2LjM2YzEuNzgsMS43NCwzLjkzLDIuNjIsNi4zOSwyLjYyCgkJCWMyLjU2LDAsNC42OC0wLjg3LDYuMjgtMi41NGMwLjA0LTAuMDQsMC4wOC0wLjA4LDAuMTItMC4xM2MwLjIxLDAuMjksMC40NCwwLjU2LDAuNywwLjgxYzEuMjQsMS4yMiwyLjgzLDEuODYsNC42LDEuODYKCQkJYzEuOCwwLDMuMzQtMC42Miw0LjYtMS44NmMwLjExLTAuMTEsMC4yMi0wLjIyLDAuMzItMC4zNGMwLjEsMC4xMiwwLjIxLDAuMjMsMC4zMiwwLjM0YzEuMjQsMS4yMiwyLjgzLDEuODYsNC42LDEuODYKCQkJYzEuMjYsMCwyLjQtMC4zMSwzLjQtMC45MmwwLjQ1LDEuMDdjMC40MywxLjAyLDEuMTMsMS45MSwyLjA4LDIuNjZjMS4wNCwwLjgxLDIuMywxLjIzLDMuNzUsMS4yM2MxLjc4LDAsMy4yOS0wLjU4LDQuNDctMS43MwoJCQljMC43MS0wLjY5LDEuMjEtMS41NSwxLjUtMi41OGgzLjY0di0wLjY3YzEsMC42MiwyLjE2LDAuOTQsMy40MiwwLjk0YzEuMywwLDIuNDQtMC4zMiwzLjM5LTAuOTRjMC44NS0wLjU1LDEuNTMtMS4yMSwyLjAyLTEuOTQKCQkJbDEuMTEtMS42NmwtMS44Ny0xLjI1TDU5Ljc3LDExLjQ0eiIvPgoJCTxwYXRoIGZpbGw9IiMxRTFFMUUiIGQ9Ik0xMDUsMTAuMTFsLTAuNzQtMS44NGMtMC40Mi0xLjA1LTEuMTMtMS44Ni0yLjEtMi40M2MtMC44OS0wLjUxLTEuODktMC43Ny0yLjk4LTAuNzcKCQkJYy0xLjMxLDAtMi40OCwwLjM1LTMuNDgsMS4wNWMtMC4yNCwwLjE3LTAuNDUsMC4zNi0wLjY1LDAuNTZjLTEuMTEtMS4wNS0yLjQ2LTEuNjEtMy45NS0xLjYxYy0wLjYzLDAtMS4yMiwwLjA5LTEuNzgsMC4yN2gtNC42MwoJCQl2MC42Yy0wLjkzLTAuNTgtMi0wLjg3LTMuMjEtMC44N2MtMS4yNiwwLTIuMzQsMC4zMS0zLjIyLDAuOVYxLjVoLTQuNzNsLTMuMTEsNS40NWwtMy4xLTUuNDVINjIuNnYxNi4xOWg1LjU3VjE1LjFoMC42NWgzLjI0CgkJCWgwLjY1djIuNTloNS41N3YtMC4zN2MwLjc3LDAuNDIsMS42NSwwLjY0LDIuNjIsMC42NGMwLjY0LDAsMS4yMy0wLjA5LDEuNzgtMC4yN2gyLjAzdjMuNjhoNS41N3YtMy40NgoJCQljMC4yNywwLjA0LDAuNTYsMC4wNiwwLjg0LDAuMDZjMS41LDAsMi44Ny0wLjU3LDMuOTgtMS42NGMwLjIsMC4yLDAuNDIsMC4zOSwwLjY1LDAuNTZjMC45NiwwLjcyLDIuMTQsMS4wOCwzLjUxLDEuMDgKCQkJYzEuNDMsMCwyLjY1LTAuNCwzLjYzLTEuMmMxLjA4LTAuODgsMS42Ni0yLjA3LDEuNjYtMy40MmMwLTAuOTctMC4zMi0xLjg5LTAuOTMtMi42NkwxMDUsMTAuMTF6Ii8+Cgk8L2c+Cgk8ZyBpZD0iSW5uZXJfdGV4dCI+CgkJPGc+CgkJCTxwYXRoIGZpbGw9IiNGRkZGRkYiIGQ9Ik05LjA4LDguMzV2MS45aDQuNThjLTAuMTQsMS4wNC0wLjQ4LDEuODQtMS4wNCwyLjRjLTAuOTQsMC45My0yLjExLDEuNC0zLjUzLDEuNAoJCQkJYy0xLjQsMC0yLjU4LTAuNDktMy41NS0xLjQ4Yy0wLjk3LTAuOTgtMS40Ni0yLjE4LTEuNDYtMy41OWMwLTEuNDEsMC40OC0yLjYsMS40NS0zLjU5QzYuNSw0LjQsNy42OCwzLjkxLDkuMDgsMy45MQoJCQkJYzEuMzMsMCwyLjQ3LDAuNDUsMy40NCwxLjM2bDEuMzUtMS4zNUMxMi41MywyLjY0LDEwLjkzLDIsOS4wOCwyQzcuMTUsMiw1LjQ5LDIuNjgsNC4wOSw0LjA1QzIuNyw1LjQyLDIsNy4wNiwyLDguOTgKCQkJCWMwLDEuOTIsMC43LDMuNTYsMi4wOSw0LjkzYzEuNCwxLjM3LDMuMDYsMi4wNSw0Ljk5LDIuMDVjMiwwLDMuNjMtMC42NSw0Ljg3LTEuOTZjMS4xLTEuMSwxLjY1LTIuNTksMS42NS00LjQ2CgkJCQljMC0wLjQ1LTAuMDMtMC44NS0wLjEtMS4xOUg5LjA4eiIvPgoJCQk8cGF0aCBmaWxsPSIjRkZGRkZGIiBkPSJNNDIuNzIsNy45N2gtMC4wN2MtMC4yNC0wLjI5LTAuNTctMC41My0wLjk4LTAuNzJjLTAuNDItMC4xOS0wLjg4LTAuMjktMS4zOS0wLjI5CgkJCQljLTEuMTQsMC0yLjE1LDAuNDQtMy4wMSwxLjMyYy0wLjg2LDAuODgtMS4yOSwxLjk0LTEuMjksMy4xOWMwLDEuMjQsMC40MywyLjMsMS4yOSwzLjE3YzAuODYsMC44NywxLjg2LDEuMzEsMy4wMSwxLjMxCgkJCQljMS4wMiwwLDEuODEtMC4zNCwyLjM3LTEuMDJoMC4wN3YwLjY1YzAsMC44NS0wLjIxLDEuNTEtMC42NCwxLjk2Yy0wLjQyLDAuNDUtMS4wMSwwLjY4LTEuNzYsMC42OGMtMC41NSwwLTEuMDItMC4xNi0xLjQxLTAuNDgKCQkJCWMtMC4zOC0wLjMxLTAuNjctMC42OS0wLjg1LTEuMTJsLTEuNzIsMC43MmMwLjI5LDAuNzEsMC43OCwxLjMzLDEuNDYsMS44NmMwLjY4LDAuNTMsMS41MiwwLjgsMi41MiwwLjgKCQkJCWMxLjI1LDAsMi4yNy0wLjM5LDMuMDctMS4xN2MwLjgtMC43OCwxLjItMS45NSwxLjItMy41MlY3LjI0aC0xLjg3VjcuOTd6IE00Mi4xNiwxMy40MmMtMC40NiwwLjUxLTEuMDMsMC43Ny0xLjcxLDAuNzcKCQkJCWMtMC42OSwwLTEuMjgtMC4yNi0xLjc3LTAuNzhjLTAuNDktMC41MS0wLjczLTEuMTYtMC43My0xLjkzYzAtMC43OCwwLjI0LTEuNDQsMC43My0xLjk2YzAuNDktMC41MiwxLjA4LTAuNzgsMS43Ny0wLjc4CgkJCQljMC42OCwwLDEuMjUsMC4yNiwxLjcxLDAuNzljMC40NiwwLjUyLDAuNjksMS4xOCwwLjY5LDEuOTZDNDIuODUsMTIuMjYsNDIuNjIsMTIuOSw0Mi4xNiwxMy40MnoiLz4KCQkJPHBhdGggZmlsbD0iI0ZGRkZGRiIgZD0iTTIwLjgsNi45N2MtMS4yNiwwLTIuMzMsMC40My0zLjIsMS4yOXMtMS4zMSwxLjkzLTEuMzEsMy4yMWMwLDEuMjgsMC40NCwyLjM1LDEuMzEsMy4yMQoJCQkJczEuOTQsMS4yOSwzLjIsMS4yOXMyLjMzLTAuNDMsMy4yLTEuMjljMC44OC0wLjg2LDEuMzEtMS45MywxLjMxLTMuMjFjMC0xLjI4LTAuNDQtMi4zNS0xLjMxLTMuMjFTMjIuMDYsNi45NywyMC44LDYuOTd6CgkJCQkgTTIyLjU5LDEzLjQyYy0wLjUsMC41MS0xLjEsMC43Ny0xLjc5LDAuNzdzLTEuMjktMC4yNS0xLjc5LTAuNzdjLTAuNS0wLjUyLTAuNzUtMS4xNy0wLjc1LTEuOTVjMC0wLjgsMC4yNS0xLjQ1LDAuNzQtMS45NgoJCQkJYzAuNS0wLjUxLDEuMS0wLjc3LDEuOC0wLjc3UzIyLjEsOSwyMi42LDkuNTFjMC40OSwwLjUxLDAuNzQsMS4xNywwLjc0LDEuOTZDMjMuMzQsMTIuMjUsMjMuMDksMTIuOSwyMi41OSwxMy40MnoiLz4KCQkJPHJlY3QgeD0iNDUuOTUiIHk9IjIuNDgiIGZpbGw9IiNGRkZGRkYiIHdpZHRoPSIxLjk4IiBoZWlnaHQ9IjEzLjIxIi8+CgkJCTxwYXRoIGZpbGw9IiNGRkZGRkYiIGQ9Ik01My4zNCwxNC4yYy0wLjk5LDAtMS43MS0wLjQ1LTIuMTgtMS4zNmw2LjAxLTIuNDlsLTAuMi0wLjUxYy0wLjExLTAuMy0wLjI2LTAuNTktMC40NC0wLjg5CgkJCQljLTAuMTgtMC4yOS0wLjQyLTAuNi0wLjczLTAuOTFjLTAuMzEtMC4zMi0wLjY5LTAuNTctMS4xNi0wLjc3Yy0wLjQ3LTAuMi0wLjk3LTAuMy0xLjUyLTAuM2MtMS4xOSwwLTIuMTksMC40Mi0zLjAxLDEuMjYKCQkJCWMtMC44MiwwLjg0LTEuMjMsMS45Mi0xLjIzLDMuMjRjMCwxLjI3LDAuNDMsMi4zNCwxLjI4LDMuMmMwLjg1LDAuODYsMS45MSwxLjI5LDMuMTgsMS4yOWMwLjkxLDAsMS42OC0wLjIsMi4yOS0wLjYKCQkJCWMwLjYzLTAuNDEsMS4xMS0wLjg3LDEuNDUtMS4zOGwtMS41My0xLjAyQzU0Ljk5LDEzLjc5LDU0LjI1LDE0LjIsNTMuMzQsMTQuMnogTTUxLjU2LDkuNDNjMC41MS0wLjQ4LDEuMDUtMC43MiwxLjYzLTAuNzIKCQkJCWMwLjM5LDAsMC43MywwLjA4LDEuMDQsMC4yNmMwLjMxLDAuMTgsMC41MiwwLjQxLDAuNjMsMC42OWwtNC4wMiwxLjY3QzUwLjgyLDEwLjU0LDUxLjA2LDkuOSw1MS41Niw5LjQzeiIvPgoJCQk8cGF0aCBmaWxsPSIjRkZGRkZGIiBkPSJNMzAuNjUsNi45N2MtMS4yNiwwLTIuMzMsMC40My0zLjIsMS4yOXMtMS4zMSwxLjkzLTEuMzEsMy4yMWMwLDEuMjgsMC40NCwyLjM1LDEuMzEsMy4yMQoJCQkJczEuOTQsMS4yOSwzLjIsMS4yOWMxLjI2LDAsMi4zMy0wLjQzLDMuMi0xLjI5YzAuODctMC44NiwxLjMxLTEuOTMsMS4zMS0zLjIxYzAtMS4yOC0wLjQ0LTIuMzUtMS4zMS0zLjIxUzMxLjkxLDYuOTcsMzAuNjUsNi45NwoJCQkJeiBNMzIuNDQsMTMuNDJjLTAuNSwwLjUxLTEuMSwwLjc3LTEuNzksMC43N3MtMS4yOS0wLjI1LTEuNzktMC43N2MtMC41LTAuNTItMC43NS0xLjE3LTAuNzUtMS45NWMwLTAuOCwwLjI1LTEuNDUsMC43NC0xLjk2CgkJCQljMC41LTAuNTEsMS4xLTAuNzcsMS44LTAuNzdjMC43MSwwLDEuMzEsMC4yNiwxLjgsMC43N3MwLjc0LDEuMTcsMC43NCwxLjk2QzMzLjE5LDEyLjI1LDMyLjk0LDEyLjksMzIuNDQsMTMuNDJ6Ii8+CgkJPC9nPgoJCTxnPgoJCQk8cG9seWdvbiBmaWxsPSIjRkZGRkZGIiBwb2ludHM9IjcwLjQ4LDEwLjkyIDcwLjQxLDEwLjkyIDY2LjE3LDMuNSA2NC42LDMuNSA2NC42LDE1LjY5IDY2LjE3LDE1LjY5IDY2LjE3LDguNDUgNjYuMSw2LjQxIAoJCQkJNjYuMTcsNi40MSA2OS45OCwxMy4xIDcwLjksMTMuMSA3NC43Miw2LjQxIDc0Ljc5LDYuNDEgNzQuNzIsOC40NSA3NC43MiwxNS42OSA3Ni4yOSwxNS42OSA3Ni4yOSwzLjUgNzQuNzIsMy41IAkJCSIvPgoJCQk8cGF0aCBmaWxsPSIjRkZGRkZGIiBkPSJNODEuNSw3LjA3Yy0wLjkzLDAtMS42OCwwLjIxLTIuMjUsMC42NFM3OC4zLDguNiw3OC4xMSw5LjFsMS40NCwwLjYxYzAuMTQtMC4zOCwwLjM5LTAuNjcsMC43Ni0wLjg5CgkJCQljMC4zNi0wLjIxLDAuNzgtMC4zMiwxLjIzLTAuMzJjMC42MSwwLDEuMTMsMC4xOCwxLjU1LDAuNTVjMC40MiwwLjM3LDAuNjMsMC44NiwwLjYzLDEuNDd2MC4yNGMtMC41OS0wLjM0LTEuMzQtMC41MS0yLjI2LTAuNTEKCQkJCWMtMS4wNCwwLTEuOTEsMC4yNS0yLjYxLDAuNzdjLTAuNzEsMC41Mi0xLjA2LDEuMjMtMS4wNiwyLjE0YzAsMC44NCwwLjI5LDEuNTIsMC44OSwyLjAzYzAuNTksMC41MSwxLjMzLDAuNzcsMi4yMiwwLjc3CgkJCQljMS4yMSwwLDIuMTItMC40NywyLjc1LTEuNDNoMC4wN3YxLjE2aDEuNXYtNS4wNGMwLTEuMTQtMC4zNi0yLjAyLTEuMDYtMi42NEM4My40NSw3LjM4LDgyLjU3LDcuMDcsODEuNSw3LjA3eiBNODIuOTIsMTMuODEKCQkJCWMtMC41MywwLjQ4LTEuMTEsMC43Mi0xLjc2LDAuNzJjLTAuNDYsMC0wLjg2LTAuMTItMS4yMS0wLjM1Yy0wLjM1LTAuMjQtMC41My0wLjU2LTAuNTMtMC45N2MwLTAuNDQsMC4xOS0wLjgzLDAuNTgtMS4xNgoJCQkJczAuOTYtMC40OSwxLjcyLTAuNDljMC44OCwwLDEuNTUsMC4xOCwxLjk5LDAuNTRDODMuNzEsMTIuNzYsODMuNDUsMTMuMzMsODIuOTIsMTMuODF6Ii8+CgkJCTxwYXRoIGZpbGw9IiNGRkZGRkYiIGQ9Ik05MS4xMiw3LjA4Yy0wLjYzLDAtMS4yLDAuMTQtMS43MSwwLjQxYy0wLjUsMC4yNy0wLjg4LDAuNjEtMS4xMywxLjAyaC0wLjA3VjcuMzVoLTEuNXYxMi4wMmgxLjU3di0zLjY4CgkJCQlsLTAuMDctMS4xNmgwLjA3YzAuMjUsMC40MSwwLjYyLDAuNzUsMS4xMywxLjAyYzAuNSwwLjI3LDEuMDcsMC40MSwxLjcxLDAuNDFjMS4wOCwwLDIuMDEtMC40MiwyLjc5LTEuMjYKCQkJCWMwLjc5LTAuODUsMS4xOC0xLjkxLDEuMTgtMy4xN2MwLTEuMjYtMC40LTIuMzItMS4xOC0zLjE3QzkzLjEzLDcuNTEsOTIuMiw3LjA4LDkxLjEyLDcuMDh6IE05Mi43MywxMy43CgkJCQljLTAuNTIsMC41NS0xLjE0LDAuODMtMS44NywwLjgzYy0wLjczLDAtMS4zNi0wLjI3LTEuODgtMC44MmMtMC41MS0wLjU1LTAuNzctMS4yOC0wLjc3LTIuMnMwLjI1LTEuNjYsMC43Ny0yLjIKCQkJCWMwLjUxLTAuNTUsMS4xNC0wLjgyLDEuODgtMC44MmMwLjcyLDAsMS4zNSwwLjI4LDEuODcsMC44M2MwLjUyLDAuNTUsMC43OCwxLjI4LDAuNzgsMi4xOUM5My41MSwxMi40Miw5My4yNSwxMy4xNSw5Mi43MywxMy43eiIKCQkJCS8+CgkJCTxwYXRoIGZpbGw9IiNGRkZGRkYiIGQ9Ik0xMDEuOTYsMTEuODRjLTAuMzgtMC40NS0wLjk2LTAuNzYtMS43NC0wLjk0bC0xLjY1LTAuMzljLTAuNzQtMC4xNy0xLjExLTAuNDktMS4xMS0wLjk3CgkJCQljMC0wLjMzLDAuMTYtMC41OSwwLjQ4LTAuNzhzMC43MS0wLjI5LDEuMTgtMC4yOWMwLjk3LDAsMS42LDAuMzcsMS45MSwxLjExbDEuMzYtMC41NmMtMC4yNS0wLjYzLTAuNjYtMS4xLTEuMjQtMS40NAoJCQkJYy0wLjU4LTAuMzMtMS4yNC0wLjUtMS45OC0wLjVjLTAuODksMC0xLjY3LDAuMjMtMi4zMiwwLjY5Yy0wLjY1LDAuNDYtMC45OCwxLjA2LTAuOTgsMS44YzAsMC42NSwwLjI0LDEuMTYsMC43MiwxLjU0CgkJCQlzMC45OSwwLjYzLDEuNTIsMC43N2wxLjY5LDAuNDFjMC43NiwwLjIsMS4xNCwwLjU3LDEuMTQsMS4xMWMwLDAuMzUtMC4xNiwwLjYzLTAuNDcsMC44NWMtMC4zMSwwLjIxLTAuNzEsMC4zMi0xLjIsMC4zMgoJCQkJYy0xLjA2LDAtMS44Mi0wLjUzLTIuMjYtMS41N2wtMS40LDAuNThjMC4yOSwwLjY4LDAuNzMsMS4yNSwxLjM0LDEuN2MwLjYxLDAuNDUsMS4zOCwwLjY4LDIuMzEsMC42OGMwLjk2LDAsMS43NS0wLjI1LDIuMzQtMC43NQoJCQkJYzAuNjEtMC41LDAuOTItMS4xMiwwLjkyLTEuODdDMTAyLjUyLDEyLjc4LDEwMi4zMywxMi4yOCwxMDEuOTYsMTEuODR6Ii8+CgkJPC9nPgoJPC9nPgo8L2c+Cjwvc3ZnPgo=';

// The photographs already carry their light, so the tiles are unlit. The game tone-maps everything
// with ACES at the time of day's exposure; the tiles pass through the exact inverse of that curve
// first, so they come out looking like the photographs, then take a time-of-day tint.
const shared = { uTint: { value: new THREE.Color(1, 1, 1) }, uExpo: { value: 0.72 } };
const TINT = { golden: [1.0, 0.93, 0.84], dusk: [0.46, 0.48, 0.62], night: [0.15, 0.16, 0.22] };
function patchTile(shader) {
  shader.uniforms.uTint = shared.uTint;
  shader.uniforms.uExpo = shared.uExpo;
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>
uniform vec3 uTint;
uniform float uExpo;
vec3 undoAces(vec3 y) {
  const mat3 outInv = mat3(vec3(0.64304, 0.05927, 0.00596), vec3(0.31119, 0.93144, 0.06393), vec3(0.04578, 0.00929, 0.93012));
  const mat3 inInv = mat3(vec3(1.76474, -0.14703, -0.03634), vec3(-0.67578, 1.16025, -0.16244), vec3(-0.08896, -0.01322, 1.19877));
  y = clamp(outInv * y, 0.0, 0.85);
  vec3 a = 1.0 - 0.983729 * y, b = 0.0245786 - 0.432951 * y, c = -(0.000090537 + 0.238081 * y);
  return inInv * ((-b + sqrt(b * b - 4.0 * a * c)) / (2.0 * a)) * (0.6 / uExpo);
}`)
    .replace('#include <map_fragment>', `#include <map_fragment>
  diffuseColor.rgb = undoAces(diffuseColor.rgb * uTint);`);
}

// Google's root request answers with JSON either way; the stock plugin turns a refusal into a bare
// TypeError, so this keeps Google's own words ("API key not valid", "Map Tiles API has not been used
// in project …", a blocked referrer) for the pause menu.
class GoogleAuth extends GoogleCloudAuthPlugin {
  async fetchData(url, options) {
    if (this.auth.sessionToken !== null || !String(url).startsWith(ROOT)) return super.fetchData(url, options);
    const u = new URL(url);
    u.searchParams.set('key', this.apiToken);
    const res = await fetch(u, options);
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.root) {
      const err = new Error(json?.error?.message || `HTTP ${res.status}`);
      err.status = res.status;
      err.google = true;
      throw err;
    }
    this.auth.sessionToken = sessionOf(json.root);
    return json;
  }
}

function sessionOf(root) {
  const stack = [root];
  while (stack.length) {
    const t = stack.pop();
    const uri = t?.content?.uri;
    if (uri && uri.includes('session=')) return new URL(uri, ROOT).searchParams.get('session');
    if (t?.children) stack.push(...t.children);
  }
  return null;
}

export class Photoreal {
  // key: the player's Google Maps Platform key. test: a public 3D Tiles URL, for checking the
  // pipeline without Google (placed at the origin, no geo-alignment).
  constructor({ scene, renderer, camera, key = '', test = null, onStatus = () => {} }) {
    this.scene = scene;
    this.renderer = renderer;
    this.camera = camera;
    this.onStatus = onStatus;
    this.test = test;
    this.visible = false;
    this.calibrated = false;
    this.calT = 0;
    this.offset = 0;
    this.loads = []; // first downloads with their distance from the camera, to check near-first loading
    this.failed = 0;

    // game frame: chicago.json is an equirectangular projection with a flat 111,320 m per degree;
    // the ellipsoid's tangent plane here is 0.15 % longer east-west and 0.22 % shorter north-south
    this.wrap = new THREE.Group();
    this.wrap.name = 'photoreal';
    this.wrap.visible = false;
    scene.add(this.wrap);

    const tiles = new TilesRenderer(test || undefined);
    this.tiles = tiles;
    this.draco = new DRACOLoader().setDecoderPath(DRACO);
    if (!test) tiles.registerPlugin(new GoogleAuth({ apiToken: key, autoRefreshToken: true }));
    tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader: this.draco }));
    tiles.registerPlugin(new TileCompressionPlugin());
    tiles.registerPlugin(new UnloadTilesPlugin());
    if (test) tiles.registerPlugin(new ReorientationPlugin({ up: '-z', recenter: true }));
    // spend the detail budget near the car: distant tiles may be a few pixels coarser
    tiles.errorFalloff = 10;
    tiles.errorFalloffDensity = 1 / 1800;
    tiles.setCamera(camera);
    tiles.setResolutionFromRenderer(camera, renderer);
    this.wrap.add(tiles.group);
    if (!test) this.place();

    tiles.addEventListener('load-model', ({ scene: model, tile }) => this.dress(model, tile));
    tiles.addEventListener('tile-download-start', ({ tile }) => {
      if (this.loads.length < 400) this.loads.push({ d: tile.traversal?.distanceFromCamera ?? -1, e: tile.traversal?.error ?? 0, depth: tile.internal?.depth ?? 0 });
    });
    tiles.addEventListener('load-root-tileset', () => onStatus({ state: 'on' }));
    tiles.addEventListener('load-error', ({ tile, error }) => {
      if (!tile) onStatus({ state: 'error', status: error?.status || 0, text: error?.message || 'unknown error', google: !!error?.google });
      else if (++this.failed === 25) onStatus({ state: 'warn', text: 'Many tiles failed to load; the session may have expired. Turn Photoreal off and on to start a new one.' });
    });

    // the car's own shadow on the photographed streets (the procedural ground that took it is hidden)
    this.catcher = new THREE.Mesh(new THREE.PlaneGeometry(420, 420).rotateX(-Math.PI / 2),
      new THREE.ShadowMaterial({ opacity: 0.42, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -6 }));
    this.catcher.receiveShadow = true;
    this.catcher.renderOrder = 3;
    this.catcher.visible = false;
    scene.add(this.catcher);

    this.ray = new THREE.Raycaster();
    this.hits = [];
    onStatus({ state: 'connecting' });
  }

  // ECEF -> east-north-up at the origin -> game axes (x east, y up, z south), scaled to chicago.json
  place() {
    const lat = ORIGIN.lat * D2R, lon = ORIGIN.lon * D2R;
    const enu = WGS84_ELLIPSOID.getEastNorthUpFrame(lat, lon, GROUND_H, new THREE.Matrix4());
    const m = new THREE.Matrix4().makeRotationX(-Math.PI / 2).multiply(enu.invert());
    const g = this.tiles.group;
    m.decompose(g.position, g.quaternion, g.scale);
    const a = 6378137, f = 1 / 298.257223563, e2 = f * (2 - f), s2 = Math.sin(lat) ** 2;
    const N = a / Math.sqrt(1 - e2 * s2), M = a * (1 - e2) / (1 - e2 * s2) ** 1.5;
    this.wrap.scale.set(KX / (N * Math.cos(lat) * D2R), 1, KZ / (M * D2R));
  }

  // Where a lat/lon/height lands in the game frame (for alignment checks against chicago.json)
  toGame(latDeg, lonDeg, h = GROUND_H) {
    const p = WGS84_ELLIPSOID.getCartographicToPosition(latDeg * D2R, lonDeg * D2R, h, new THREE.Vector3());
    this.wrap.updateMatrixWorld(true);
    return p.applyMatrix4(this.tiles.group.matrixWorld);
  }

  dress(model, tile) {
    model.traverse((c) => {
      if (!c.isMesh) return;
      const old = c.material;
      const m = new THREE.MeshBasicMaterial({ map: old.map || null, side: old.side });
      if (!old.map && old.color) m.color.copy(old.color);
      m.onBeforeCompile = patchTile; // one shared function, so every tile shares one program
      c.material = m;
      tile.engineData.materials?.push(m); // the renderer disposes it with the tile
      c.castShadow = c.receiveShadow = false;
      if (c.geometry.attributes.normal) c.geometry.deleteAttribute('normal'); // unlit: normals are dead weight
    });
  }

  setVisible(on) {
    this.visible = on;
    this.wrap.visible = on;
    this.catcher.visible = on;
  }

  setTime(name) {
    shared.uTint.value.setRGB(...(TINT[name] || TINT.golden));
  }

  // Once per frame, after the camera has its final pose for the frame.
  update(dt, car) {
    if (!this.visible) return;
    shared.uExpo.value = this.renderer.toneMappingExposure;
    this.camera.updateMatrixWorld();
    this.tiles.setResolutionFromRenderer(this.camera, this.renderer);
    this.tiles.update();
    if (car) {
      this.catcher.position.set(car.pos.x, 0.02, car.pos.z);
      if ((this.calT -= dt) <= 0 && car.grounded && car.sup?.kind === 'ground' && car.pos.y < 1) {
        this.calT = 0.4;
        this.calibrate(car.pos.x, car.pos.z);
      }
    }
  }

  // The game's ground is flat at y = 0, Chicago's is not quite. Keep the photographed street under
  // the car at y = 0: the first fix uses tall rays and the lowest surface (so the L tracks overhead or
  // a tree don't count), later ones short rays from just above the road, eased in.
  calibrate(x, z) {
    const ray = this.ray, hits = this.hits;
    const first = !this.calibrated;
    const top = first ? 80 : 2.5, far = first ? 160 : 8;
    const ys = [];
    ray.far = far;
    ray.firstHitOnly = !first;
    for (let i = 0; i < 7; i++) {
      const a = i * 2.39996, r = i ? 2.5 : 0;
      ray.set(new THREE.Vector3(x + Math.cos(a) * r, top, z + Math.sin(a) * r), new THREE.Vector3(0, -1, 0));
      hits.length = 0;
      ray.intersectObject(this.tiles.group, true, hits);
      if (!hits.length) continue;
      ys.push(first ? Math.min(...hits.map((h) => h.point.y)) : hits[0].point.y);
    }
    if (ys.length < 4) return;
    ys.sort((p, q) => p - q);
    const err = ys[ys.length >> 1];
    const step = first ? err : THREE.MathUtils.clamp(err, -2, 2) * 0.35;
    this.offset = THREE.MathUtils.clamp(this.offset - step, -40, 40);
    this.wrap.position.y = this.offset;
    this.calibrated = true;
  }

  attributions() {
    return this.tiles.getAttributions().filter((a) => a.type === 'string' && a.value).map((a) => a.value).join('; ');
  }

  stats() {
    const s = this.tiles.stats;
    return { visible: s.visible, downloading: s.downloading, parsing: s.parsing, loaded: s.loaded, failed: s.failed, queued: s.queued,
      cachedMB: Math.round((this.tiles.lruCache.cachedBytes || 0) / 1048576), offset: +this.offset.toFixed(2), calibrated: this.calibrated,
      scale: [+this.wrap.scale.x.toFixed(5), +this.wrap.scale.z.toFixed(5)] };
  }

  dispose() {
    this.tiles.dispose();
    this.draco.dispose();
    this.scene.remove(this.wrap, this.catcher);
    this.catcher.geometry.dispose();
    this.catcher.material.dispose();
  }
}
