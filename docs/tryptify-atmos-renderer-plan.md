# Tryptify — Dolby Atmos Renderer + DSP Pipeline Plan

> Implementation plan for the **audio engine** side of Tryptify (the native
> Android hi-fi player: Kotlin 2.1.0 + a C++17 `monochrome_dsp` engine, Media3/
> ExoPlayer, 4-bus mixer, AutoEQ, exclusive USB-DAC, Room, Compose, ProjectM).
>
> This plan covers the part that makes Tryptify special and is **independent of
> where the audio comes from**: a clean-room Dolby Atmos (E-AC-3 JOC) renderer,
> its integration into the DSP chain, playback/ingestion of content the user
> legitimately holds, and the library/UI infra.

---

## 0. Scope & non-goals

**In scope (this plan):**
- A clean-room **E-AC-3 JOC → object → binaural/bed renderer** in `monochrome_dsp`.
- Feeding rendered audio through the existing **4-bus mixer → AutoEQ → bit-perfect USB-DAC** path.
- Playback/ingestion of **content the user legitimately possesses**: local FLAC/ALAC/WAV, user-imported files, DRM-free Atmos (`.ec3`/`.eac3`/Atmos `.m4a`), and **Apple Music streaming via the sanctioned MusicKit path**.
- Library, deep-link, and settings infrastructure.

**Explicitly OUT of scope (not in this plan, by design):**
- Any **FairPlay decryption / DRM circumvention** (no wrapper, no `skd://` key handling, no sample-decrypt socket, no `media-user-token` harvesting). Tryptify renders audio it is given; it does not defeat content protection.
- Server-side transcoding of Atmos (would strip the JOC side-data — see §3).

The renderer's input is an **EC-3 JOC elementary stream or Atmos MP4 that the user already has on-device**. How such a file gets there is the user's responsibility and outside this plan.

---

## 1. Architecture — where it slots into Tryptify

```
tf.monochrome.android/
├── audio/
│   ├── atmos/                    ← NEW: renderer control (Kotlin JNI surface)
│   └── (existing DSP/EQ/USB)
├── player/                       ← Media3 integration (AtmosAudioProcessor / renderer)
├── data/
│   ├── library/                  ← NEW: Room entities for the track library
│   └── import/                   ← NEW: file import + manifest metadata import
├── ui/                           ← NEW Compose screens: library, now-playing, renderer settings
└── cpp/
    ├── monochrome_dsp/           ← existing engine (4 buses, 32 processors)
    └── atmos/                    ← NEW: EC3JOCDecoder + ObjectRenderer + HRTF/VBAP
```

Data flow (Atmos file the user holds → sound):
```
Atmos .m4a/.ec3 (on device)
   │  MediaExtractor → raw EC-3 JOC elementary stream (NO transcode)
   ▼
cpp/atmos/EC3JOCDecoder   (substream walk → EMDF → OAMD + JOC → QMF upmix)
   │  ≤16 object PCM streams + per-frame OAMD positions
   ▼
cpp/atmos/ObjectRenderer
   ├── HRTFBinauralizer  → stereo (headphones)
   └── VBAPBedPanner     → 5.1/7.1/7.1.4 (USB-DAC)
   ▼
monochrome_dsp  (4-bus mixer → AutoEQ → …)
   ▼
Media3 AtmosAudioProcessor → bit-perfect USB-DAC / headphone out
```

---

## 2. Component A — Clean-room Dolby Atmos renderer (`cpp/atmos/`)

This is the hard, differentiating part. Apple/DRM-free Atmos is a single **E-AC-3
(DD+) bitstream** = a 5.1/7.1 **core bed** plus **EMDF side-data** carrying
**OAMD** (object positions) and **JOC** (upmix matrices). Implement clean-room
from the ETSI specs — see §7 licensing.

### A1. `EC3Demux` / bitstream reader
- Parse E-AC-3 syncframe → BSI → 6 audio blocks (1536 samples/frame) → skip field → CRC (ETSI TS 102 366 / ATSC A/52).
- Walk **all** substreams down to independent substream 0 and assemble the **full bed** (7.1 lives in dependent substreams) *before* JOC.
- Detect Atmos via `addbsi` (`flag_ec3_extension_type_a`, `complexity_index`).
- Locate EMDF inside the audio-block **skip field** by the A/52 block walk (not a byte scan).

### A2. `EAC3CoreDecode`
- Option 1 (fastest to stand up): bind **FFmpeg `libavcodec` eac3** (arm64-v8a) for the 5.1/7.1 core **bed PCM only**, and parse EMDF/OAMD/JOC yourself from the raw `.ec3` in parallel.
  - ⚠️ FFmpeg's decoder **discards JOC** and `eac3_core_bsf` strips dependent substreams — use it *only* for bed PCM, never for object data.
- Option 2 (tighter QMF integration, more work): self-written core decoder à la Cavern.

### A3. `EMDFParser` (ETSI TS 102 366 Annex H)
- Parse `version/key_id → {payload id, size, config, bytes}* → emdf_protection`.
- OAMD = payload **id 11**, JOC = payload **id 14**.
- **Skip/loose-validate** `emdf_protection` — its MAC is undocumented proprietary crypto and is a wall for *encoding* acceptance only. A renderer only reads EMDF; do **not** spend effort here.

### A4. `OAMDParser` (ETSI TS 103 420 clause 5)
- Object count (5-bit, extended to 12 if ==31); split **bed** (speaker-anchored) vs **dynamic** objects.
- Positions in normalised `[0,1]³` cube, **differential** (3 signed bits/axis, `xyScale=1/62`, `zScale=1/15`) or **absolute** (X,Y 6-bit; Z sign+4-bit). Map to render space `(X·2−1, Z, Y·−2+1)`.
- Gain (2-bit + optional 6-bit ext; apply ×0.707/−3 dB anti-clip; negative = reuse-previous), distance table, anchor type, screen/depth factors, sample offset + object-info-block ramps.

### A5. `QMFFilterBank`
- Complex/hybrid quadrature-mirror **analysis** (forward on core channels) + **synthesis** (inverse on reconstructed objects). Must be **bit-aligned to the spec's subband count** or the JOC matrices won't register. NEON-accelerated.

### A6. `JOCDecoder` + `JOCUpmixApplier` (ETSI TS 103 420 clause 6)
- Parse per-object parameter-band mapping, `dataPoints` (1 or 2 temporal), sparse-vector vs coarse matrix coding, dequant (`gainStep = 0.2 − q·0.1`), Huffman tables **re-derived from the spec**.
- Apply per timeslot, per subband: `object[b] = Σ_ch core[ch] · mixMatrix[ch][b]`, with **linear matrix interpolation** across the frame (direct-copy on steep slopes). Optional decorrelators.
- Output ≤16 object PCM streams + their OAMD positions.

### A7. `ObjectRenderer` → two back-ends
- **`HRTFBinauralizer`** (headphones): OAMD position → az/el/dist → pick+interpolate HRIR pair → partitioned overlap-save convolution per ear → sum to stereo.
  - Reuse: **libmysofa** (SOFA loader/interpolation, NDK-friendly) + **PFFFT/PFFASTCONV** (NEON, alloc-free) or **3dti_AudioToolkit** / **libspatialaudio** as the convolution engine.
  - Cost cap: pan objects to a **fixed virtual loudspeaker layout** then binauralise that layout — bounds convolution count vs. 16×2 per-object.
  - **Leverages your existing AutoEQ/HRTF measurement infra** — binaural Atmos *is* HRTF convolution of positioned objects.
- **`VBAPBedPanner`** (USB-DAC multichannel): object → speaker gains for 5.1/7.1/7.1.4 via **Vector Base Amplitude Panning** (reuse `drbafflegab/vbap` — C17, alloc-free — or `pierreguillot/vbap`).

### A8. `monochrome_dsp` integration
- Register the renderer as a processor ahead of AutoEQ + USB output, within the per-bus model (≤16 processors/bus).
- Renderer-mode toggle in settings: **B** (full object render, this plan) with a **C** fallback (decode bed + your HRTF) for non-Atmos-capable paths.

---

## 3. Component B — DSP / playback integration (`player/`)

- **Do NOT transcode/remux the Atmos stream** anywhere — FFmpeg's eac3 path strips JOC (jellyfin-ffmpeg #584). `MediaExtractor` the container, hand the **raw EC-3 elementary stream** to `EC3JOCDecoder`.
- **`AtmosAudioProcessor`** (Media3 `AudioProcessor`) — the renderer produces PCM that flows through `monochrome_dsp`'s mixer/AutoEQ; this keeps Atmos in *your* chain rather than the platform decoder.
- **Bypass-to-`AudioTrack`** alternative for exclusive USB-DAC: push rendered multichannel PCM straight to an `AudioTrack` in exclusive/`MODE_STREAM` with the DAC's native rate/bit-depth, skipping the mixer resample — decide per output device.
- Reuse the existing exclusive USB-DAC path (libusb UAC1/UAC2) for bit-perfect output.

---

## 4. Component C — Source ingestion (`data/import/`, `player/`)

Three **legitimate** source paths, all feeding the same renderer/DSP chain:

1. **Local & imported files** — FLAC / ALAC / WAV, and DRM-free Atmos (`.ec3`, `.eac3`, Atmos `.m4a`). Standard `MediaExtractor` + the existing library scanner.
2. **Apple Music streaming via MusicKit (Android)** — the **sanctioned** route: developer token + MusicKit user authorization, playback through Apple's managed player. Note: MusicKit does **not** expose decrypted PCM, so it plays *alongside* the DSP path rather than through it — offered for catalog access, not for routing through the engine.
3. **Library-import from a trypt-hifi manifest (metadata only)** — the `tryptify://job?token=&url=` deep link and `DownloadJobManifest` are used **only to pre-populate a library entry's metadata** (title/artist/artwork/ISRC/quality). The audio bytes for such an entry come from a file the user supplies (path 1) or from MusicKit (path 2). No fetching/decryption of protected streams happens here.

---

## 5. Component D — Library & app infra (`data/library/`, `ui/`)

- **Room schema** (`Track`, `Album`, `Artist`, `RendererProfile`): local file URI, codec/quality tier, channel layout, Atmos flag, source enum (`LOCAL | IMPORTED | MUSICKIT`), metadata, artwork URI.
- **Deep-link handling**: `intent-filter` for `scheme="tryptify"` on an import Activity; parse the token, GET the manifest metadata, create/merge a library entry.
- **Keystore**: store the MusicKit user token (if the user signs in) in the Android Keystore — for the sanctioned MusicKit path only.
- **Compose UI**: library browser, now-playing with object/positional visualization (tie into ProjectM), and a renderer settings screen (mode A/B/C, HRTF profile picker reusing AutoEQ measurement UX, speaker layout for USB-DAC).

---

## 6. Build / NDK

- **Reuse:** PFFFT (`external/pffft`, NEON FFT/conv), libmysofa (SOFA HRTF), a VBAP core (`drbafflegab/vbap`), FFmpeg `libavcodec` eac3 **core-only** (arm64-v8a).
- **Write from scratch (clean-room):** `EMDFParser`, `OAMDParser`, `QMFFilterBank`, `JOCDecoder`, `JOCUpmixApplier`, `ObjectRenderer`, plus the JOC quant/Huffman tables re-derived from TS 103 420.
- CMake targets under `cpp/atmos/`; NEON on `arm64-v8a`; avoid FFTW (GPL/heavy) and GPL-incompatible deps.

---

## 7. Phasing & acceptance criteria

| Phase | Deliverable | Acceptance |
|---|---|---|
| **0** | Local/DRM-free playback through `monochrome_dsp` + USB-DAC | A local FLAC and a DRM-free `.ec3` file play bit-perfect through the mixer/AutoEQ/DAC |
| **1** | EC-3 **core** decode + **Option C** binaural (bed → HRTF) | An Atmos file you hold plays as spatial stereo through your HRTF; no crashes; correct duration |
| **2** | Full **JOC object** decode (A5–A6) | Objects reconstruct; A/B against a reference shows correct object separation on known test content |
| **3** | **Option B** object render — HRTF binaural + VBAP bed | Objects place correctly in headphone binaural and on a 5.1/7.1.4 USB-DAC layout |
| **4** | Library/UI/MusicKit + deep-link metadata import | Library browse, renderer-mode toggle, MusicKit sign-in, manifest metadata import all work |

---

## 8. Legal / licensing notes

- **DRM is out of scope** (see §0). This plan never decrypts protected content.
- **Clean-room requirement:** VoidXH/Cavern and raress96/dolby-atmos-encoder are the best *documentation* of the algorithms, but are non-commercial/share-alike licensed. The shipped renderer must be an **independent reimplementation from ETSI TS 103 420 / TS 102 366** — study them, don't copy them; re-derive the JOC tables from the spec.
- **Dolby patents:** shipping *any* Atmos decoder implicates Dolby's patent/decoder licensing regardless of clean-room provenance. For a distributed product you'd need to address Dolby licensing; for personal/research builds, note the exposure.

---

## 9. Open questions

1. HRTF: ship a default SOFA set, or drive binaural entirely from Tryptify's own AutoEQ measurements?
2. USB-DAC Atmos: expose a user-set speaker layout (5.1 / 7.1 / 7.1.4), or auto-detect channel count from the DAC?
3. Core decoder: bind FFmpeg eac3 for the bed (fast) or write a self-contained core decoder (tighter QMF, no libav dep)?
4. MusicKit: in scope for v1, or defer and ship local/imported + renderer first?
