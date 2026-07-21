# Apple Music ALAC + Dolby Atmos inside Tryptify — Technical Design

> Deep-dive on integrating an Apple Music decryption **wrapper** and a Dolby Atmos
> **renderer** directly into **Tryptify** (the native Android hi-fi player:
> Kotlin + C++17 `monochrome_dsp` engine, Media3/ExoPlayer, USB-DAC, 4-bus mixer).
>
> This is a design/planning document, not a shipped feature. See the
> **Legal reality** section before doing anything public-facing.

---

## 0. TL;DR

There are **two separable problems**, and people conflate them:

| Problem | What it is | Where it runs in Tryptify | Difficulty |
|---|---|---|---|
| **Wrapper / decryption** | Turn a DRM-encrypted Apple stream into a raw ALAC or EC-3 elementary stream | A sidecar decryption agent on the same Android device | **Solved** — mature FOSS wrappers exist |
| **Atmos renderer** | Turn the EC-3 **JOC** bitstream into binaural/multichannel audio you can actually hear | Tryptify's C++17 DSP engine | **Hard** — the decoder is proprietary; this is the real work |

The wrapper is a plumbing job. The **renderer is the project.** Everything below
builds toward that.

---

## 1. What Apple Music "Atmos" actually is on the wire

This is the single most important fact for the renderer design:

- Apple Music Spatial Audio is delivered as **E-AC-3 (EC-3 / Dolby Digital Plus)
  carrying JOC** — *Joint Object Coding*, aka **DD+JOC**.
- The stream is a normal **5.1 (or 7.1) channel bed** *plus* a **JOC side-data
  payload**. A legacy decoder reads only the bed and plays 5.1; an Atmos decoder
  reads the JOC side data and **reconstructs the object scene**.
- JOC squeezes the mix's up-to-128 objects down into **16 transported objects** —
  a lossy compromise, but that's what ships.
- On an Apple device, the OS does a **real-time binaural render** of that object
  scene for headphones. *That render is the thing you are re-implementing.*

In the download tools these streams are identified as `audio-atmos` / `audio-ec3`.
The lossless (non-Atmos) stream is `audio-alac-stereo` (ALAC). Also present:
`audio-stereo` / `aac-lc` / `aac-binaural` (AAC variants).

**Key consequence:** decrypting the Atmos stream gives you an `.ec3`/`.eac3`
elementary stream. That is *not playable as immersive audio* until something
decodes the JOC and renders the objects. FFmpeg **cannot** do this — its E-AC-3
decoder reads the 5.1 core and **discards the JOC side data**. See §4.

---

## 2. How the existing wrappers work (the part that's solved)

All the popular tools — `zhaarey/apple-music-downloader`,
`WorldObservationLog/AppleMusicDecrypt`, and the many `*-alac-atmos-downloader`
forks — use the **same client–server decryption model**:

```
downloader (Go/Python)  ──TCP socket──►  wrapper (patched Apple Music runtime)
      │  sends encrypted CDN segments             │  holds the FairPlay keys,
      │                                            │  returns decrypted PCM/ALAC/EC3
      ▼                                            ▼
  muxes with MP4Box/ffmpeg                    runs the real Apple Music app code
```

Concretely:

- **The wrapper is a patched Apple Music app** (the Android APK's decrypt path,
  run under an emulated/instrumented Android userspace). It is the only component
  that can produce FairPlay keys, because those keys only exist inside Apple's own
  runtime. **No amount of your own code replaces it** — that's why every project
  ships a wrapper as a separate process.
- The downloader talks to it over **localhost TCP** (Docker examples use
  `--network host` precisely because the wrapper listens on local ports).
- `WorldObservationLog`'s wrapper-manager quotes **~40 MB/s per instance**, so
  throughput is not a bottleneck.
- **Auth:** a `media-user-token` (from a paid Apple Music account) is required for
  premium formats, lyrics, and covers. It lives in `config.yaml` / `config.toml`.
- **Deps for muxing:** `MP4Box` (GPAC) on PATH; `mp4decrypt` (Bento4) only for
  music videos; `ffmpeg` for container/tagging work.

### 2.1 Why this maps cleanly onto Android / Tryptify

The wrapper is *already an Android component*. Tryptify is a native Android app.
So "the wrapper runs inside Tryptify" is realistic in a way it never is for a
web app: you bundle the wrapper as an **on-device sidecar** (a bound
`Service`/foreground process, or a packaged binary invoked over a local socket)
and Tryptify's Kotlin layer speaks to it on `127.0.0.1:<port>`. No emulator on a
server, no external service the user has to run — it's all on the handset.

---

## 3. The renderer — the actual engineering problem

You have an encrypted-then-decrypted **EC-3 JOC** stream. You need audible,
immersive output on:

1. **Headphones** → binaural render (HRTF), the common case for a phone.
2. **USB-DAC multichannel** → object-to-speaker render for a bed layout
   (Tryptify already does exclusive USB-DAC output, so this is on the table).

There is **no fully open-source Dolby Atmos object renderer**, because the JOC
decode + Object Audio Renderer are proprietary Dolby IP. Your realistic options:

### Option A — Android platform decoder (`EAC3-JOC`) — easiest, least control
- Android exposes a **`MimeTypes.AUDIO_E_AC3_JOC`** codec and you can query
  `AudioManager`/`MediaCodecList` for hardware `EAC3-JOC` support.
- On a **Dolby-licensed device** (many flagships), the platform decoder + the
  device's Atmos renderer will play the stream and binauralize for headphones.
- Media3/ExoPlayer (which Tryptify already uses) can feed EC-3 to the platform
  decoder via `MediaCodec`.
- **Cost:** you get Dolby's render but **zero DSP control** — the audio is
  rendered by the platform *after* your `monochrome_dsp` chain, so it bypasses
  your mixer, AutoEQ, and bit-perfect USB path. On non-licensed devices it
  **falls back to the 5.1 core or fails**. This defeats the point of Tryptify.

### Option B — Clean-room object renderer in your C++ engine — hardest, best fit
- Decode E-AC-3 to its channel/object substreams yourself, parse the **JOC/OAMD
  metadata** (the object positions + gains), and render objects → binaural via
  **your own HRTF** — inside `monochrome_dsp`, *before* AutoEQ and USB output.
- Reference points that prove it's tractable clean-room:
  - **[VoidXH/Cavern](https://github.com/VoidXH/Cavern)** — an object-based audio
    engine + codec pack that **decodes and renders Dolby Atmos** (incl. E-AC-3
    JOC), with HRTF binaural and room correction. .NET, so not a drop-in for C++
    Android, but it is the best existing map of the algorithm and metadata layout.
  - **[raress96/dolby-atmos-encoder](https://github.com/raress96/dolby-atmos-encoder)**
    — PoC that documents the **OAMD (ETSI TS 103 420)**, **JOC matrices over the
    5-channel core**, and **EMDF container (ETSI TS 102 366 Annex H)**. Reading
    the *encoder* tells you exactly what the *decoder* must invert.
- The spec stack you'd implement against: **ETSI TS 102 366** (AC-3/E-AC-3 +
  Annex H EMDF), **ETSI TS 103 420** (OAMD object metadata), and the JOC
  upmix matrices.
- **Cost:** real DSP + reverse-engineering effort. But this is the *only* option
  that lets Atmos flow through Tryptify's mixer/EQ/USB-DAC — i.e. the only one
  that makes Tryptify's existence justified for Atmos.

### Option C — Hybrid: platform decode, your render — pragmatic middle
- Use the platform/`ffmpeg` E-AC-3 decoder to get the **decoded channel bed +
  (where exposed) object PCM**, then do **your own HRTF binauralization** of those
  channels in `monochrome_dsp`. You lose true object precision (you're rendering
  the bed, not the 16 objects) but keep it inside your DSP chain and it works on
  any device.
- Good **Phase 1** target: ship "Atmos-sourced, engine-rendered" spatial audio
  now; upgrade to full object render (Option B) later.

**Recommendation:** ship **C** first (works everywhere, stays in your engine),
build toward **B** (the real Atmos renderer, your differentiator). Treat **A** as
a device-capability fallback you can offer as a toggle.

> **DECISION (locked): Option B.** Tryptify implements the clean-room
> OAMD/JOC object decode + object→HRTF render in `monochrome_dsp`. This is the
> only path where Atmos flows through the mixer/AutoEQ/USB-DAC.
>
> **Hard constraint this places on trypt-hifi (the catalog layer):** the
> download/handoff must deliver the **untouched EC-3 JOC elementary stream**
> (`audio-atmos` / `audio-ec3`). trypt-hifi must **never** transcode or remux the
> Atmos stream server-side — FFmpeg (and any DD+ remux) **strips the JOC
> side-data** the Option B renderer depends on (see §4). trypt-hifi packages the
> raw stream reference + metadata into the handoff manifest; **all** decode/render
> happens on-device in Tryptify.

---

## 4. Why FFmpeg alone is not "the renderer"

Stated plainly so it doesn't get assumed away later:

- FFmpeg's `eac3` decoder produces the **5.1 core only** and **strips JOC**.
  (This is a known issue class — e.g. JOC being lost on remux/transcode in
  jellyfin-ffmpeg #584.)
- So an FFmpeg-only path gives you **surround-from-the-bed**, never the object
  scene, and never a *correct* binaural Atmos render.
- FFmpeg is still the right tool for the **non-Atmos** paths (ALAC handling,
  container muxing, metadata/artwork tagging) and for feeding decoded PCM into
  Option C.

---

## 5. End-to-end on-device pipeline

```
┌────────────────────────────── Tryptify (Android) ──────────────────────────────┐
│                                                                                 │
│  Kotlin UI (Compose)                                                            │
│     │  paste/search Apple Music link, pick codec (ALAC / Atmos / AAC)           │
│     ▼                                                                           │
│  AppleMusicClient (Kotlin)  ── media-user-token, metadata query ──►  Apple CDN  │
│     │  encrypted segments                                                       │
│     ▼                                                                           │
│  Wrapper sidecar  (127.0.0.1:<port>, patched Apple runtime)  ◄── decrypt ──►    │
│     │  raw ALAC  OR  EC-3(JOC) elementary stream                                │
│     ▼                                                                           │
│  ┌───────────────┬─────────────────────────────────────────────┐               │
│  │  ALAC path    │  Atmos path                                  │               │
│  │  (lossless)   │  EC-3 JOC → [Renderer §3]                    │               │
│  │  ffmpeg mux   │    A) platform EAC3-JOC   B) C++ object      │               │
│  │               │    C) bed + your HRTF     render (OAMD/JOC)  │               │
│  └───────┬───────┴──────────────────────┬──────────────────────┘               │
│          ▼                               ▼                                       │
│               monochrome_dsp  (4-bus mixer, AutoEQ, 32 processors)              │
│          (Option B/C feed here; Option A bypasses it — that's its downside)      │
│                              │                                                   │
│                              ▼                                                   │
│              Media3 render  →  bit-perfect USB-DAC / headphone out               │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 6. Integration points in Tryptify's existing architecture

Mapping onto the structure the repo already has:

| New piece | Lives near | Notes |
|---|---|---|
| `AppleMusicClient` (metadata, URL parse, token) | `data/` | Mirrors how the local library `data/` layer is organized; talks HTTPS to Apple + the local wrapper socket. |
| **Wrapper sidecar** | new `wrapper/` module or bundled binary | Bound foreground `Service`; exposes local TCP; ships the patched Apple runtime. |
| **Atmos renderer** | `app/src/main/cpp/` (`monochrome_dsp`) | New processor: `EC3JOCDecoder` + `ObjectRenderer` + `HRTFBinauralizer`. Slots into the existing per-bus processor model (up to 16/bus). |
| Media3 source | `player/` | A custom `MediaSource`/`DataSource` that pulls decrypted PCM from the wrapper instead of a file. Option A uses a `MediaCodec` EAC3-JOC path; B/C feed PCM into the C++ engine. |
| Codec/HRTF settings | `ui/` + settings store | Codec picker, renderer mode (A/B/C), HRTF profile — reuse the AutoEQ measurement UX pattern. |

The **AutoEQ + HRTF** work you already do is a real head start: a binaural Atmos
renderer is *exactly* HRTF convolution of positioned objects, and you already
have measurement-driven filtering infrastructure to build on.

---

## 7. Config, auth, and dependencies

- **`media-user-token`** — required for premium/Atmos. Store securely
  (Android Keystore), never in plaintext prefs. One paid Apple Music account.
- **Wrapper config** — port, storefront/region, quality selection
  (`audio-alac-stereo` vs `audio-atmos`). Model it after `config.yaml`/`config.toml`.
- **Native deps** — GPAC `MP4Box` and `ffmpeg` cross-compiled for `arm64-v8a`
  (you already ship native libs via NDK, so this fits your build). `mp4decrypt`
  (Bento4) only if you add music-video support.
- **Codec detection** — at runtime query `MediaCodecList` for `audio/eac3-joc`
  to decide whether Option A is even available on the device.

---

## 8. Recommended phased plan

1. **Phase 0 — ALAC first.** Wire the wrapper sidecar + `AppleMusicClient`, ship
   **lossless ALAC** playback through `monochrome_dsp`. This validates the entire
   decrypt→engine path with zero Atmos complexity. Highest value/effort ratio.
2. **Phase 1 — Atmos via Option C.** Decode EC-3 to the bed, binauralize with your
   HRTF inside the engine. "Spatial audio that runs through Tryptify's DSP,"
   works on every device.
3. **Phase 2 — Option A toggle.** On EAC3-JOC-capable devices, offer the platform
   render as an alternative for users who want Dolby's exact binaural (accepting
   the DSP-bypass tradeoff).
4. **Phase 3 — Option B, the real renderer.** Clean-room OAMD/JOC object decode +
   object→HRTF render in C++. This is the differentiator and the hard research
   track; use Cavern and the encoder PoC as the algorithmic map.

---

## 9. Legal reality (read before anything ships publicly)

Unlike the Qobuz path (which routes through a fairly open API), **every** Apple
Music method here works by **circumventing FairPlay DRM**. That:

- Violates the Apple Music **Terms of Service**, and
- Implicates **DMCA §1201 anti-circumvention** (and equivalents elsewhere),
  independently of any copyright on the music itself.

A patched-Apple-Music **wrapper bundled into a shipped app** is materially more
exposed than a personal CLI a single user runs. Keep this personal/research, and
do not distribute the wrapper or a build that embeds it. This document describes
how the technology works; it is not a recommendation to publish it.

---

## Sources

- Apple Atmos = EC-3 JOC / DD+JOC — Dolby: *What is Dolby Digital Plus JOC*,
  Avid *Encoding and Delivering Dolby Atmos Music*.
- Wrappers: `zhaarey/apple-music-downloader`, `WorldObservationLog/AppleMusicDecrypt`.
- Renderer references: `VoidXH/Cavern`, `raress96/dolby-atmos-encoder`,
  mpv-player discussion #14765 (EAC3-JOC HW decode on Android),
  jellyfin-ffmpeg #584 (JOC stripped by ffmpeg remux).
