# Slop Auckland

A 3D simulation of central Auckland (Tāmaki Makaurau), New Zealand, in the browser: walk, drive (on the left), cycle or
fly from the Sky Tower over the Harbour Bridge, around Maungawhau / Mt Eden and along the Waitematā waterfront.

It is a remix of [Slop New York](https://github.com/mrdoob/slop-newyork) by mrdoob: the same engine (three.js
`WebGPURenderer` + TSL materials, traffic, pedestrians, lighting, audio, vehicles), with the city replaced by Auckland,
generated from open data.

## Run it

There is no build step. Serve the folder with any static file server and open it in a browser with WebGPU
(a recent Chrome, Edge, Safari or Firefox):

```sh
python -m http.server 8377 --bind 127.0.0.1
# http://127.0.0.1:8377/
```

three.js r187 is loaded from jsDelivr through the import map in `index.html`.

Controls are shown on screen: `1`–`4` walk / drive / cycle / fly, `K` a kiwi (person-sized, and flying: it starts
40 m up among the towers, well under the helicopter, and runs where it is set down), `V` cycles the camera, `M` opens the map (click to
teleport), the pin menu jumps to places (Sky Tower, Queen Street, Viaduct, Harbour Bridge, Ponsonby, Newmarket, …).
`?debug` in the URL exposes `window.akl` (scene, systems, `akl.view = { from, to }` for a fixed camera).

## Graphics quality

By default the picture is the one Slop New York draws, and it is never reduced to gain frame rate: the window's full
resolution, 4x MSAA, screen-space reflections, everything drawn to its full distance. That is **Ultra**.

The frame is bound by the GPU, mostly by the number of pixels it shades, so for small graphics cards the gauge button
in the toolbar offers lower levels, chosen by hand only (`js/quality.js`):

| | Resolution | Anti-aliasing | Reflections | Trees and suburbs drawn to |
| --- | --- | --- | --- | --- |
| Ultra (default) | 100% | 4x MSAA | on | all of it |
| High | 100%, at most 2.3 MP | 4x MSAA | on | all of it |
| Medium | 85%, at most 1.5 MP | none | on | three quarters |

A level keeps its resolution. **Auto** is the one that moves: it guesses High or Medium from the graphics card, lets
the resolution follow the measured frame time (down when a frame takes over 21.5 ms, to 60% at the lowest; back up when
it stays under 17.4 ms), and steps down from High to Medium when the lowest resolution still cannot hold 38 fps. The
level and the resolution are shown beside the frame rate. `?q=medium|high|ultra` in the address forces a level;
`?dynres=0` pins the resolution on Auto.

Measured on a Quadro P600 (2 GB) in a 1864 × 949 window: 7–10 fps on Ultra.

## What is real

| | Source |
| --- | --- |
| Coastline, wharves, streets (widths, lanes, one-ways, signals), parks, paths, railways, place names | OpenStreetMap |
| Building footprints (6,800 larger buildings, 11,300 houses in the detailed centre; 92,800 boxes around it) | OpenStreetMap (largely LINZ / Auckland Council imports) |
| Terrain: 5 m grid for the centre, 32 m for the region (volcanic cones, North Shore, Rangitoto) | LINZ Auckland LiDAR 1 m DEM |
| Building heights, bridge and viaduct deck profiles | LINZ LiDAR DSM − DEM |
| Motorways (SH1, SH16, the Central Motorway Junction): in their cuttings, on their viaducts, through the Victoria Park Tunnel | OpenStreetMap + LiDAR |

The detailed area runs from Herne Bay and Ponsonby to Parnell and south to Newmarket (about 5.4 × 4.7 km). Around
it, out to roughly 6 km, the suburbs are a land-cover map and plain building boxes; beyond that, terrain and coast only.

World frame: 1 unit = 1 m, x east, z south, origin at the Sky Tower; height 0 is 3.0 m above NZVD2016.

## What is made up

Facades, roofs, trees' exact positions inside parks and gardens, street furniture, the Sky Tower and Harbour Bridge
models (built by hand from their real dimensions), and everything that moves. Building heights are missing for a few
hundred footprints and guessed from their size; outside the detailed area all heights are guesses unless tagged.
The vehicle models are the original project's, repainted: white cabs with a roof light (the company on their doors is
invented), police cars in blue and yellow Battenburg checks, buses in AT Metro blue or the Link services' green, red,
amber and teal, and black-on-white plates.

## Rebuilding the data

The generated files in `js/` (`akl-geodata.js`, `*-geodata.bin.gz`, `region-*`) are committed, so this is only needed to
change the area or refresh the data. Requires Node 20+.

```sh
cd tools && npm install && cd ..
node tools/fetch-osm.mjs                # Overpass extracts -> tools/data/ (≈18 MB)
node tools/fetch-terrain.mjs            # LINZ LiDAR from the public s3://nz-elevation bucket -> tools/data/ (≈17 MB)
node --max-old-space-size=8192 tools/build-geodata.mjs   # the detailed city
node --max-old-space-size=6144 tools/build-region.mjs    # the surroundings
node tools/check-modules.mjs            # every module parses, imports resolve, index.html preloads them all
```

The extents live in `tools/akl-frame.mjs`. `tools/debug/` has scripts that draw the intermediate results
(`network.mjs` builds the traffic network outside the browser and reports how much of the street graph it uses).

## How it differs from Slop New York

- No street grid: every street is a centreline from the map, cut into the ground as a raster; blocks are whatever is
  left between the roadways.
- Real relief. The ground is a height field, streets drape over it, buildings stand on the lowest ground under them,
  and bridges are a second surface above it.
- Traffic keeps left (`KEEP = -1` in `js/city-config.js`), on a network of straight runs fitted to each street's line.
  Roads that leave the detailed area take vehicles off the map there. The number of vehicles follows the amount of
  road around the camera.
- Houses: the inner suburbs' villas and bungalows are merged boxes with hipped or gabled roofs.

## Known limitations

- Cul-de-sacs carry no AI traffic (nothing makes U-turns), and a few awkward junctions are skipped by it.
- One-lane-each-way streets with short blocks jam now and then; vehicles that have stood for a minute and a half out
  of sight are taken off the road.
- Outside the detailed area there are no trees or street objects and the ground cannot be driven on meaningfully.
- No ferries, trains or boats yet.

## Credits and licences

- Code: MIT, see `LICENSE`. Slop New York © Mr.doob; the Auckland adaptation is published under the same terms.
- Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), available under the
  [Open Database License](https://opendatacommons.org/licenses/odbl/). The files derived from it (`js/akl-geodata.js`,
  `js/building-geodata.bin.gz`, `js/tree-geodata.bin.gz`, `js/region-*`) are a produced work / derivative database
  under the same licence.
- Elevation: Auckland LiDAR 1 m DEM and DSM, sourced from the
  [LINZ Data Service](https://data.linz.govt.nz/) and licensed for reuse under
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) (`js/terrain-geodata.bin.gz`, building heights, deck
  profiles).
- [three.js](https://threejs.org/) (MIT).

This is a toy, not a map: do not navigate by it.
