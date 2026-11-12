# mozg-spine

The hands for [Spine 2D Animation](https://mozg.sh/b/mozg/spine-2d-animation).

That brain knows how a Spine skeleton is put together — bones, slots, skins,
keyframes, atlases, what breaks a loop. This plugin is what does it: point it at
a cut-up character and it writes a rigged, animated skeleton the runtime plays.

Brain without hands means an agent hand-writing JSON next to a machine that
would have exported it. Hands without the brain means a rig with no opinion
about timing. Install both.

## Install

```bash
/plugin marketplace add bojlahg/svod
/plugin install svod-spine@svod
```

Needs [uv](https://docs.astral.sh/uv/) on the machine; the server and its Python
dependencies are fetched on first run.

## Your Spine licence stays yours

This plugin contains no part of Spine and grants no licence to it. Spine is
commercial software from Esoteric Software, and everyone runs their own
installation under their own licence. The server finds it at
`/Applications/Spine.app/Contents/MacOS/Spine`, or wherever `SPINE_BIN` points:

```bash
export SPINE_BIN="/path/to/your/Spine"          # macOS default needs no setting
export SPINE_BIN="C:\\Program Files\\Spine\\Spine.exe"
```

**It works without one.** Rigging and animating are plain Python — no Spine
process is started. A licence adds three things and nothing else:

| | needs Spine |
|---|---|
| `rig_and_animate` — skeleton, animations, atlas | no |
| `inspect_source`, `preview` | no |
| `pack_atlas` — the Spine packer | yes |
| `make_project` / `export_project` — editable `.spine` | yes |
| `project_info` | yes |

`spine_doctor` reports what it found. Nothing here shares one person's licence
with another, and nothing degrades because somebody else has a different one.

## What the agent gets

| tool | what it does |
|---|---|
| `spine_doctor` | is the Spine CLI there, are the deps installed |
| `inspect_source` | list parts and head-state families before building |
| `rig_and_animate` | `.psd` or PhotoshopToSpine folder → rig + anims + atlas |
| `pack_atlas` | pack a folder of PNGs into `.atlas` + `.png` |
| `make_project` | runtime json → editable `.spine` |
| `export_project` | `.spine` → runtime json + atlas |
| `project_info` | bones, slots, animations of a project or json |
| `preview` | keyframe-montage PNG of a built rig |
| `batch` | rig every subfolder of a roster directory |

Source: <https://github.com/egorfedorov/spine-mcp> (MIT)
