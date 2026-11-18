# City of Steals — a Slop Auckland caper

An open-world crime caper in the browser, set in a 3D simulation of real central Auckland (Tāmaki Makaurau), New
Zealand. You are a washed-up cabbie who owes Aunty Mere for his taxi, caught between Dougie "Two Flats" and the Gull
who runs the wharves: steal cars, outrun the police, take jobs, buy a safehouse, and drive (on the left) from the Sky
Tower over the Harbour Bridge, round Maungawhau / Mt Eden and along the Waitematā waterfront. A cheeky caper, not a
war: there are no guns anywhere in it — driving, chases, the odd scuffle with a cricket bat, and handcuffs.

The city is [Slop Auckland](#what-is-real), a remix of [Slop New York](https://github.com/mrdoob/slop-newyork) by
mrdoob: the same engine (three.js `WebGPURenderer` + TSL materials, traffic, pedestrians, lighting, audio, vehicles),
with the city replaced by Auckland, generated from open data. The game layer is `js/game` (its API reference is the
comment at the top of `js/game/index.js`).

**Play it in the browser: <https://pengqianhan.github.io/slop-auckland/>** (needs WebGPU; `?sandbox` for the free-roam
city without the game).

## Run it

There is no build step. Serve the folder with any static file server and open it in a browser with WebGPU
(a recent Chrome, Edge, Safari or Firefox):

```sh
python -m http.server 8377 --bind 127.0.0.1
# http://127.0.0.1:8377/
```

three.js r187 is loaded from jsDelivr through the import map in `index.html`. The game saves itself in the browser
(`localStorage`): Continue on the title screen picks up where you left off; New game starts over (settings kept).

## What there is to do

- **Ten story jobs** ("Meter Running") for Aunty Mere, Dougie and Jase: repossess a ute, a timed parcel run, tail a
  van without being spotted, a getaway with the cops on you, a street race over the Harbour Bridge, steal a police car,
  put the Gull's vans out of action at the wharves past his bat-swinging guards, a helicopter rescue off Maungawhau,
  run an accountant off the road, and shunt the Gull's cash van off Quay Street before a four-star dash for the last
  ferry. Failed one? Press the interact key while the retry prompt shows.
- **The police** never shoot: they catch you. One to five stars from what they (or phoning bystanders) see: carjacking,
  assault, knocking people out, running them down, smashing property, and above all anything done to an officer; a
  long chase in their sight slowly turns up the heat. One star, a patrol car tails you; two, they ram and officers tackle
  runners; three, roadblocks, a helicopter with a searchlight, and cars that box a slow car in; four, PIT manoeuvres
  and the SUVs; five, the lot, flat out. Stand still beside an officer (or lie there tackled) and the cuffs go on —
  quicker the more of them there are. Break their line of sight until the stars stop flashing, or drive into a
  Spray 'n' Pray.
- **Fists and a cricket bat** (from the sports shops, or lying about): that's the arsenal. The bat swings slower,
  hits harder, knocks people down and dents cars. Knocked-out people lie there a while and are cleared away.
- **Cars** take damage from crashes (and the bat): smoke, heavy smoke, then the engine dies and the car is a stalled,
  smoking wreck — no fireballs.
- **Side hustles** (the phone): taxi fares in any taxi, three street races with medal times, timed challenges (Bumper
  Cars, Wreck-reation, Howzat!), the export list at the wharf crane, 30 golden kiwis hidden round the city.
- **Money**: start nearly broke (NZ$150). Jobs pay; sports shops sell a cricket bat and protective padding (armour),
  food heals; four safehouses (save, heal, a garage that keeps a car); the hospital and the police both take a fee
  (and the police keep your bat).
- **HUD**: radar with GPS routes and blips, wanted stars and an arrest meter, health / armour / stamina, money, fists
  or bat in hand, a focus dot, speedometer, mission timer and objective, subtitles, phone-style notifications,
  first-time tips, pause menu with the map (click to set a waypoint), jobs, stats, settings and controls.
- **Radio**: procedural stations in any car or the helicopter.

## Controls

| | Keyboard & mouse | Gamepad | Touch |
| --- | --- | --- | --- |
| Move / look | `W` `A` `S` `D`, mouse (click the view to lock it) | left stick, right stick | left joystick, drag the view |
| Sprint / jump / crouch | `Shift` / `Space` / `C` | L3 / A / — | Run (toggle) / — / — |
| Swing (fists / bat) | left button (also without mouse lock) | RT (on foot) | Swing |
| Focus (square up, the camera over the shoulder) | right button | LT (on foot) | Focus (toggle) |
| Fists / bat | `Q` `E`, wheel, `1` `2` | LB / RB (on foot) | ⇄ |
| Get in / out, carjack | `F` | Y | ⏏ |
| Interact (shops, safehouses, retry, taxi duty) | `G` | B | — |
| Drive / steer | `W` `S` / `A` `D` | RT LT / left stick | left joystick |
| Fly the helicopter | `W` `A` `S` `D`, `Space` climb, `Q` descend | left stick, RT climb, LT descend | left joystick |
| Horn / radio station | `B` / `,` `.` | — / LB RB (in a vehicle) | — |
| Phone | `T` | D-pad → | — |
| Map / pause | `M` / `Esc` or `P` | Back / Start | tap the radar / ❚❚ |
| Camera / hide HUD / sound | `V` / `H` / `N` | D-pad ← / — / — | pinch to zoom |
| Menus | arrows, `Enter`, `Esc`, `Q` `E` for tabs | D-pad or stick, A, B, LB RB | tap |

## In the address bar

| | |
| --- | --- |
| `?sandbox` | the free-roam toy as it was before the game: no player, no police; `1`–`4` walk / drive / cycle / fly, `K` a kiwi (person-sized, and flying), `V` cycles the camera, `M` opens the map (click to teleport), the pin menu jumps to places |
| `?debug` | `window.akl` (scene, systems, `akl.game`, `akl.view = { from, to }` for a fixed camera), skips the title screen, an fps readout, Shift-click on the map teleports, a Cheats page on the phone |
| `?title` | with `?debug`: the title screen anyway (`?notitle` skips it without debug) |
| `?show=fx` | every effect in a loop in front of the player |
| `?range` | bat practice: the cricket bat in hand and waves of thugs with bats and fists around you |
| `?show=audio` | the audio self-test on screen and a round of sounds every few seconds |
| `?q=medium` / `high` / `ultra` | forces a graphics level (below); `?dynres=0` pins the resolution on Auto |

## Graphics quality

By default the picture is the one Slop New York draws, and it is never reduced to gain frame rate: the window's full
resolution, 4x MSAA, screen-space reflections, everything drawn to its full distance. That is **Ultra**.

The frame is bound by the GPU, mostly by the number of pixels it shades, so for small graphics cards the gauge button
in the toolbar offers lower levels, chosen by hand only (`js/quality.js`):

| | Resolution | Anti-aliasing | Reflections | Trees and suburbs drawn to | Sun shadow redrawn |
| --- | --- | --- | --- | --- | --- |
| Ultra (default) | 100% | 4x MSAA | on | all of it | every frame |
| High | 100%, at most 2.3 MP | 4x MSAA | on | all of it | every other frame, unless the camera moved |
| Medium | 85%, at most 1.5 MP | none | on | three quarters | every other frame |

("The camera moved" is more than 15 cm or 1.2° since the last frame; Auto redraws the shadow as High does.)

A level keeps its resolution. **Auto** is the one that moves: it guesses High or Medium from the graphics card, lets
the resolution follow the measured frame time (down when a frame takes over 21.5 ms, to 60% at the lowest; back up when
it stays under 17.4 ms — after a wait of 4 s, doubled with each step down, up to 60 s, so it doesn't see-saw), and
steps down from High to Medium when the lowest resolution still cannot hold 38 fps. The level and the resolution are
shown beside the frame rate. `?q=medium|high|ultra` in the address forces a level;
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

## Project layout

| Path | What it holds |
| --- | --- |
| `index.html`, `css/` | the page, the import map for three.js, the toolbar, title screen, HUD and menu styles |
| `js/main.js` | boots the renderer, the city and the game (or the sandbox) |
| `js/*.js` | the city engine: terrain, roads, buildings, houses, trees, landmarks, traffic, pedestrians, vehicles and their physics, lighting, post-processing, audio, cameras, quality and performance (`perf.js`) |
| `js/game/` | the game: player, combat and the bat, wanted level and police, missions (`missions/` — story, steps, phone, stats), activities, economy and safehouses, pickups, radio, music and sound effects, HUD (`hud/` — radar, GPS, cards, tips), menus, saving |
| `js/*-geodata*`, `js/region-*` | the generated city data (see below) |
| `tools/` | Node scripts that fetch OpenStreetMap and LINZ data and build the files above; `tools/debug/` draws intermediate results |

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
