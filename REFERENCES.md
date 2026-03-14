# Reference Projects

This repo contains four cloned reference projects under `tmp_*` directories. These are not part of our codebase — they exist solely as reference material for understanding the KiwiSDR protocol, waterfall rendering techniques, and the SDR web UI ecosystem.

---

## tmp_kiwisdr

**Repository:** https://github.com/jks-prv/Beagle_SDR_GPS.git

KiwiSDR is the firmware and web application for the KiwiSDR hardware — a BeagleBone-based software-defined radio receiver covering 10 kHz to 30 MHz. This is the server our Go backend connects to as a client. The KiwiSDR exposes two WebSocket endpoints per user channel: `/{ts}/SND` for demodulated audio and `/{ts}/W/F` for waterfall (FFT spectrum) data. The web frontend lives in `web/` and is the primary reference for understanding the W/F binary frame format, the WebSocket initialization sequence, zoom/frequency control commands, and the ADPCM compression codec. The server-side C++ code in `rx/` handles the actual FFT computation and frame generation. KiwiSDR's web UI is a heavily modified fork of the original OpenWebRX frontend (see copyright headers in `web/openwebrx/openwebrx.js`), diverged significantly since 2015 with thousands of lines of KiwiSDR-specific additions.

## tmp_openwebrx

**Repository:** https://github.com/jketterl/openwebrx.git

OpenWebRX is a standalone, open-source web-based SDR receiver application. Originally created by Andras Retzler in 2013-2014, it is now maintained by Jakob Ketterl. Unlike KiwiSDR, OpenWebRX is not tied to specific hardware — it supports many SDR devices (RTL-SDR, SDRplay, HackRF, etc.) and runs its own server-side FFT pipeline in Python. Its web frontend (`htdocs/openwebrx.js`) contains the original waterfall rendering code — canvas management, color mapping, scrolling — that KiwiSDR later forked and modified. We studied this codebase to understand waterfall rendering patterns and to identify performance weaknesses (per-pixel color function calls, multi-canvas DOM churn, no requestAnimationFrame batching) that our implementation improves upon. OpenWebRX has no connection to KiwiSDR at runtime; they share a common frontend ancestor but are otherwise independent projects.

## tmp_kiwiclient

**Repository:** https://github.com/jks-prv/kiwiclient.git

kiwiclient is the official Python client library for the KiwiSDR WebSocket protocol, maintained by the same author as KiwiSDR (John Seamons, ZL4VO). It provides the clearest documentation of the KiwiSDR protocol through working code. The key files are `kiwi/client.py` (connection setup, authentication, frame parsing for both SND and W/F tags, IMA-ADPCM decoding), `kiwirecorder.py` (full-featured recorder with SND and W/F handling, zoom/frequency configuration, waterfall color mapping), and `kiwiwfrecorder.py` (standalone waterfall recorder demonstrating how to pair SND and W/F connections). This library was the primary source for reverse-engineering the W/F binary frame format, initialization commands (`SET zoom`, `SET wf_speed`, `SET wf_comp`, etc.), and the shared-timestamp connection pairing model.

## tmp_tokoeka

**Repository:** https://github.com/vaccovecrana/tokoeka.git

Tokoeka is a third-party Java/Kotlin WebSocket client library for KiwiSDR. It implements handlers for all three KiwiSDR message types: audio (`TkAudioHdl`), waterfall (`TkWaterfallHdl`), and control (`TkControlHdl`). It served as an additional reference for understanding the KiwiSDR protocol from a different language's perspective, and includes test resource files (`sdr-snd-log.json`, `sdr-wf-log.json`) that document example message sequences. Being a smaller, more focused codebase than kiwiclient, it provides a cleaner view of the protocol's structure.

---

## How They Relate

```
OpenWebRX (2013)
  │
  │  KiwiSDR forked the frontend JS in 2015
  │
  ├──────────────────────┐
  │                      │
  ▼                      ▼
OpenWebRX (standalone)   KiwiSDR firmware
jketterl/openwebrx       jks-prv/Beagle_SDR_GPS
  │                      │
  │ (no runtime          │ (defines the WebSocket
  │  connection)         │  protocol we connect to)
  │                      │
  │                      ├── kiwiclient (official Python client)
  │                      │   jks-prv/kiwiclient
  │                      │
  │                      └── tokoeka (third-party Java client)
  │                          vaccovecrana/tokoeka
  │
  └── Our project studies OpenWebRX's
      waterfall rendering techniques
```

OpenWebRX and KiwiSDR share a common frontend ancestor (the original 2013 OpenWebRX JavaScript), but have diverged significantly over 10+ years. At runtime they are completely independent — OpenWebRX talks to local SDR hardware, KiwiSDR is its own hardware platform with its own protocol. kiwiclient and tokoeka are both clients that speak the KiwiSDR protocol, similar to what our Go backend does.
