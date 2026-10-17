"""Browser fingerprint masking & organic input cadence.

Layers actually implemented here (the previous docstring listed 14 and the script
had 13, several of which did not exist — `getShaderPrecisionFormat`, the Battery
API and any JS-side WebRTC handling were all claimed but absent. This list is the
code):

 1. Function.prototype.toString proxy cloaking
 2. navigator.webdriver -> false, on Navigator.prototype
 3. hardwareConcurrency / deviceMemory
 4. platform + userAgentData client hints (per-profile arch/version)
 5. PluginArray / MimeTypeArray with genuine prototype chaining
 6. navigator.languages, kept in sync with the Accept-Language header
 7. WebGL vendor/renderer, with the extension list intersected against reality
 8. Deterministic canvas 2D noise (getImageData / toDataURL / toBlob)
 8b. Deterministic text-metrics noise (measureText, font fingerprinting)
 9. Deterministic AudioContext noise (getFloatFrequencyData / getChannelData)
10. OS-matched SpeechSynthesis voices
11. MediaDevices enumeration
12. Network Information
13. Permissions API, kept consistent with Notification.permission
14. Screen geometry, devicePixelRatio, and window outer/inner chrome offset
15. window.chrome; 16. Web Worker (WorkerNavigator) fingerprint parity

WebRTC local-IP suppression is done with launch flags in browser_session.py, not
here.

Review findings addressed 2026-08-30
------------------------------------
* **Everything is defined on the prototype, not the instance.** Every override used
  to be `Object.defineProperty(navigator, ...)`, which put eight own properties on
  an object that has none in a real browser — `Object.getOwnPropertyNames(navigator)`
  returned `[]` in real Chrome and eight names here. CreepJS checks exactly this.
* **`getExtension` is hooked and the claimed extension list is intersected with the
  real one.** Previously `getSupportedExtensions()` returned a hardcoded desktop-GPU
  list while `getExtension()` was untouched, so asking for an advertised extension
  returned `null` — a self-contradiction available to any probe in one line.
* **The noise is deterministic, as the docstring always claimed.** It was
  `Math.random()`, so two reads of one canvas produced two different hashes. Real
  browsers are stable, and *randomisation is itself the signal* — a detector that
  reads twice and compares finds an anti-fingerprinting browser. Noise is now a pure
  function of (byte index, per-device seed), so a device's canvas hash is constant
  across reads and visits while still differing from the true SwiftShader output.
* **Canvas noise covers every read path.** Only `toDataURL` was hooked, so a
  fingerprinter using `getImageData` read clean pixels — and got a *different*
  answer than `toDataURL`, which is worse than not spoofing at all.
* **`Notification.permission` is aligned with `permissions.query`.** Forcing the
  query result to 'prompt' while leaving `Notification.permission` at 'denied' (its
  value on the headless fallback path) manufactures the textbook headless tell.

Plus organic kinematics: cubic-Bezier mouse movement with Fitts's-law acceleration
and micro-jitter, digraph typing acceleration, and inertial scrolling with reading
dwell.
"""

from __future__ import annotations

import json
import math
import random
import re
from typing import TYPE_CHECKING

from nanoagent.agent.effector.types import Point

if TYPE_CHECKING:
    from nanoagent.agent.effector.stealth.fingerprint_pool import DeviceProfile


ULTRA_STEALTH_INIT_SCRIPT = r"""
(() => {
  // ─── 0. Prototype-Safe Native Function Cloaker ──────────────────────────────
  const nativeFnMap = new WeakSet();
  const origToString = Function.prototype.toString;

  try {
    const customToString = function toString() {
      if (nativeFnMap.has(this)) {
        const name = this.name || '';
        return `function ${name}() { [native code] }`;
      }
      return origToString.apply(this, arguments);
    };
    nativeFnMap.add(customToString);
    nativeFnMap.add(origToString);
    Object.defineProperty(Function.prototype, 'toString', {
      value: customToString,
      configurable: true,
      writable: true,
    });
  } catch (e) {}

  const makeNative = (fn, name = '', length = 0) => {
    try {
      Object.defineProperty(fn, 'name', { value: name, configurable: true });
      Object.defineProperty(fn, 'length', { value: length, configurable: true });
      nativeFnMap.add(fn);
    } catch (e) {}
    return fn;
  };

  // Every navigator/screen property below goes on the PROTOTYPE, matching where a
  // real browser keeps it. Defining on the instance leaves own properties on an
  // object that has none, which is a one-line detection.
  const navProto = Object.getPrototypeOf(navigator) || Navigator.prototype;
  const defineOn = (target, name, getter) => {
    try {
      Object.defineProperty(target, name, {
        get: makeNative(getter, 'get ' + name),
        configurable: true,
        enumerable: true,
      });
    } catch (e) {}
  };

  // ─── 1. navigator.webdriver ─────────────────────────────────────────────────
  // false, not undefined: a normal Chrome reports false, and `undefined` says
  // "someone deleted this property" just as loudly as `true` says "automated".
  defineOn(navProto, 'webdriver', () => false);

  // ─── 2. Hardware Concurrency & Device Memory ───────────────────────────────
  defineOn(navProto, 'hardwareConcurrency', () => __HW_CONCURRENCY__);
  defineOn(navProto, 'deviceMemory', () => __DEVICE_MEMORY__);

  // ─── 3. Platform & Client Hints (UserAgentData) ─────────────────────────────
  try {
    const brands = [
      { brand: 'Not_A Brand', version: '8' },
      { brand: 'Chromium', version: '__CHROME_MAJOR__' },
      { brand: 'Google Chrome', version: '__CHROME_MAJOR__' },
    ];

    const userAgentData = {
      brands: brands,
      mobile: false,
      platform: '__UA_PLATFORM__',
      getHighEntropyValues: makeNative((hints) => {
        return Promise.resolve({
          architecture: '__ARCHITECTURE__',
          bitness: '__BITNESS__',
          brands: brands,
          mobile: false,
          model: '',
          platform: '__UA_PLATFORM__',
          platformVersion: '__PLATFORM_VERSION__',
          uaFullVersion: '__CHROME_VERSION__',
        });
      }, 'getHighEntropyValues', 1),
      toJSON: makeNative(function () {
        return { brands: brands, mobile: false, platform: '__UA_PLATFORM__' };
      }, 'toJSON', 0),
    };

    defineOn(navProto, 'platform', () => '__PLATFORM__');
    defineOn(navProto, 'userAgentData', () => userAgentData);
  } catch (e) {}

  // ─── 4. Genuine PluginArray & MimeTypeArray Prototype Chaining ─────────────
  try {
    const rawPluginsData = [
      {
        name: 'PDF Viewer',
        filename: 'internal-pdf-viewer',
        description: 'Portable Document Format',
        mimeTypes: [
          { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
          { type: 'text/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
        ],
      },
      {
        name: 'Chrome PDF Viewer',
        filename: 'internal-pdf-viewer',
        description: 'Portable Document Format',
        mimeTypes: [
          { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
          { type: 'text/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
        ],
      },
      {
        name: 'Chromium PDF Viewer',
        filename: 'internal-pdf-viewer',
        description: 'Portable Document Format',
        mimeTypes: [
          { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
          { type: 'text/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
        ],
      },
      {
        name: 'Microsoft Edge PDF Viewer',
        filename: 'internal-pdf-viewer',
        description: 'Portable Document Format',
        mimeTypes: [
          { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
          { type: 'text/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
        ],
      },
      {
        name: 'WebKit built-in PDF',
        filename: 'internal-pdf-viewer',
        description: 'Portable Document Format',
        mimeTypes: [
          { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
          { type: 'text/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
        ],
      },
    ];

    const pluginProto = window.Plugin ? window.Plugin.prototype : Object.prototype;
    const pluginArrayProto = window.PluginArray ? window.PluginArray.prototype : Object.prototype;
    const mimeTypeProto = window.MimeType ? window.MimeType.prototype : Object.prototype;
    const mimeTypeArrayProto = window.MimeTypeArray ? window.MimeTypeArray.prototype : Object.prototype;

    const fakePluginsList = Object.create(pluginArrayProto);
    const fakeMimeTypesList = Object.create(mimeTypeArrayProto);
    const allMimeTypes = [];
    const seenMimeTypes = new Set();

    rawPluginsData.forEach((pData, idx) => {
      const p = Object.create(pluginProto);
      Object.defineProperty(p, 'name', { value: pData.name, enumerable: true });
      Object.defineProperty(p, 'filename', { value: pData.filename, enumerable: true });
      Object.defineProperty(p, 'description', { value: pData.description, enumerable: true });
      Object.defineProperty(p, 'length', { value: pData.mimeTypes.length, enumerable: true });

      pData.mimeTypes.forEach((mData, mIdx) => {
        const m = Object.create(mimeTypeProto);
        Object.defineProperty(m, 'type', { value: mData.type, enumerable: true });
        Object.defineProperty(m, 'suffixes', { value: mData.suffixes, enumerable: true });
        Object.defineProperty(m, 'description', { value: mData.description, enumerable: true });
        Object.defineProperty(m, 'enabledPlugin', { value: p, enumerable: true });
        Object.defineProperty(p, mIdx, { value: m, enumerable: true, configurable: true });
        Object.defineProperty(p, mData.type, { value: m, enumerable: false, configurable: true });
        // Real bug, found 2026-08-30 by running this in a live browser (it predates
        // the hardening pass): every one of the five plugins declares the same two
        // mime types, so this list collected 'application/pdf' five times and the
        // second `Object.defineProperty(fakeMimeTypesList, 'application/pdf', ...)`
        // below threw "Cannot redefine property" on a non-configurable key. That
        // exception aborted this entire section, so navigator.plugins and
        // navigator.mimeTypes were never actually spoofed — the plugin-emulation
        // layer has never once run. A real MimeTypeArray holds each type once.
        if (!seenMimeTypes.has(mData.type)) {
          seenMimeTypes.add(mData.type);
          allMimeTypes.push(m);
        }
      });

      p.item = makeNative(function (index) { return this[index] || null; }, 'item', 1);
      p.namedItem = makeNative(function (name) { return this[name] || null; }, 'namedItem', 1);

      Object.defineProperty(fakePluginsList, idx, { value: p, enumerable: true, configurable: true });
      Object.defineProperty(fakePluginsList, pData.name, { value: p, enumerable: false, configurable: true });
    });

    Object.defineProperty(fakePluginsList, 'length', { value: rawPluginsData.length, enumerable: false });
    fakePluginsList.item = makeNative(function (index) { return this[index] || null; }, 'item', 1);
    fakePluginsList.namedItem = makeNative(function (name) { return this[name] || null; }, 'namedItem', 1);
    fakePluginsList.refresh = makeNative(function () {}, 'refresh', 0);

    allMimeTypes.forEach((m, idx) => {
      Object.defineProperty(fakeMimeTypesList, idx, { value: m, enumerable: true, configurable: true });
      Object.defineProperty(fakeMimeTypesList, m.type, { value: m, enumerable: false, configurable: true });
    });
    Object.defineProperty(fakeMimeTypesList, 'length', { value: allMimeTypes.length, enumerable: false });
    fakeMimeTypesList.item = makeNative(function (index) { return this[index] || null; }, 'item', 1);
    fakeMimeTypesList.namedItem = makeNative(function (name) { return this[name] || null; }, 'namedItem', 1);

    defineOn(navProto, 'plugins', () => fakePluginsList);
    defineOn(navProto, 'mimeTypes', () => fakeMimeTypesList);
  } catch (e) {}

  // ─── 5. navigator.languages ────────────────────────────────────────────────
  // Templated from the same GeoProfile that sets the context's Accept-Language
  // header, so the JS value and the HTTP header cannot disagree.
  try {
    const languages = Object.freeze(__LANGUAGES__);
    defineOn(navProto, 'languages', () => languages);
    defineOn(navProto, 'language', () => languages[0]);
  } catch (e) {}

  // ─── 6. Deterministic noise source ─────────────────────────────────────────
  // Pure function of (index, per-device seed). The same device therefore produces
  // the same canvas/audio hash on every read — which is what a real browser does,
  // and what the previous Math.random() implementation broke.
  const NOISE_SEED = __NOISE_SEED__;
  const noiseAt = (i) => {
    let h = (NOISE_SEED ^ Math.imul(i, 374761393)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) % 3 - 1; // -1, 0, or +1
  };
  // A stable [0,1) float keyed by an arbitrary string — same string, same seed,
  // same value, forever. Used by the text-metrics noise so a device's measured
  // font widths are self-consistent across reads (a real browser's are) while
  // still differing from the true SwiftShader metrics a clean container reports.
  const seededUnit = (str) => {
    let h = NOISE_SEED | 0;
    for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 2654435761) | 0;
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };

  // ─── 7. WebGL Vendor, Renderer & Extensions ────────────────────────────────
  try {
    const rawExtensions = __WEBGL_EXTENSIONS__;
    const claimedExts = Array.isArray(rawExtensions) ? rawExtensions : [];

    const hookWebGL = (proto) => {
      if (!proto) return;
      const getParam = proto.getParameter;
      const origGetSupported = proto.getSupportedExtensions;
      const origGetExtension = proto.getExtension;

      // claimed ∩ real. Intersecting rather than asserting means we can never
      // advertise an extension that getExtension() would then fail to return,
      // and never return an extension object we did not advertise.
      const allowedCache = new WeakMap();
      const allowed = (ctx) => {
        let list = allowedCache.get(ctx);
        if (list) return list;
        let real = [];
        try { real = origGetSupported.call(ctx) || []; } catch (e) {}
        const realSet = new Set(real);
        list = claimedExts.filter((n) => realSet.has(n));
        allowedCache.set(ctx, list);
        return list;
      };

      proto.getParameter = makeNative(function (parameter) {
        if (parameter === 37445) return '__GPU_VENDOR__';
        if (parameter === 37446) return '__GPU_RENDERER__';
        if (parameter === 3379) return 16384; // MAX_TEXTURE_SIZE
        if (parameter === 34076) return 16384; // MAX_CUBE_MAP_TEXTURE_SIZE
        if (parameter === 34921) return 1024; // MAX_VERTEX_UNIFORM_VECTORS
        if (parameter === 35661) return 32; // MAX_COMBINED_TEXTURE_IMAGE_UNITS
        return getParam.apply(this, arguments);
      }, 'getParameter', 1);

      if (claimedExts.length > 0) {
        proto.getSupportedExtensions = makeNative(function () {
          return allowed(this).slice();
        }, 'getSupportedExtensions', 0);

        proto.getExtension = makeNative(function (name) {
          if (allowed(this).indexOf(name) === -1) return null;
          return origGetExtension.apply(this, arguments);
        }, 'getExtension', 1);
      }
    };

    if (typeof WebGLRenderingContext !== 'undefined') {
      hookWebGL(WebGLRenderingContext.prototype);
    }
    if (typeof WebGL2RenderingContext !== 'undefined') {
      hookWebGL(WebGL2RenderingContext.prototype);
    }
  } catch (e) {}

  // ─── 8. Canvas 2D Fingerprint Noise ────────────────────────────────────────
  try {
    const MAX_NOISY_PIXELS = 1000000; // don't walk a huge photo canvas
    const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

    const noiseImageData = (imgData) => {
      const d = imgData.data;
      if (d.length > MAX_NOISY_PIXELS * 4) return imgData;
      for (let i = 0; i < d.length; i += 4) {
        d[i] = clamp(d[i] + noiseAt(i));
        d[i + 1] = clamp(d[i + 1] + noiseAt(i + 1));
        d[i + 2] = clamp(d[i + 2] + noiseAt(i + 2));
      }
      return imgData;
    };

    // Track which context type each canvas was created with. The old hook called
    // this.getContext('2d') unconditionally inside toDataURL — on a WebGL canvas
    // that either returns null or, worse, permanently claims the canvas for 2D.
    const ctxTypes = new WeakMap();
    const origGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = makeNative(function (type) {
      const ctx = origGetContext.apply(this, arguments);
      if (ctx && !ctxTypes.has(this)) {
        try { ctxTypes.set(this, String(type)); } catch (e) {}
      }
      return ctx;
    }, 'getContext', 1);

    const is2d = (canvas) => {
      try { return String(ctxTypes.get(canvas) || '').indexOf('2d') !== -1; } catch (e) { return false; }
    };

    const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = makeNative(function () {
      return noiseImageData(origGetImageData.apply(this, arguments));
    }, 'getImageData', 4);

    if (typeof OffscreenCanvasRenderingContext2D !== 'undefined') {
      const origOffscreenGetImageData = OffscreenCanvasRenderingContext2D.prototype.getImageData;
      OffscreenCanvasRenderingContext2D.prototype.getImageData = makeNative(function () {
        return noiseImageData(origOffscreenGetImageData.apply(this, arguments));
      }, 'getImageData', 4);
    }

    // Render a noised copy for the export paths, reading through the ORIGINAL
    // getImageData so the noise is applied exactly once and both paths agree.
    const noisedClone = (canvas) => {
      const clone = document.createElement('canvas');
      clone.width = canvas.width;
      clone.height = canvas.height;
      const src = origGetContext.call(canvas, '2d');
      const dst = origGetContext.call(clone, '2d');
      if (!src || !dst) return null;
      const data = origGetImageData.call(src, 0, 0, canvas.width, canvas.height);
      dst.putImageData(noiseImageData(data), 0, 0);
      return clone;
    };

    const exportable = (canvas) =>
      is2d(canvas) && canvas.width > 0 && canvas.height > 0 &&
      canvas.width * canvas.height <= MAX_NOISY_PIXELS;

    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = makeNative(function () {
      try {
        if (exportable(this)) {
          const clone = noisedClone(this);
          if (clone) return origToDataURL.apply(clone, arguments);
        }
      } catch (e) {}
      return origToDataURL.apply(this, arguments);
    }, 'toDataURL', 0);

    const origToBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = makeNative(function () {
      try {
        if (exportable(this)) {
          const clone = noisedClone(this);
          if (clone) return origToBlob.apply(clone, arguments);
        }
      } catch (e) {}
      return origToBlob.apply(this, arguments);
    }, 'toBlob', 1);
  } catch (e) {}

  // ─── 8b. Text-metrics (font) fingerprint noise ─────────────────────────────
  // Salvaged from the stage47 plan's §2.2 ("randomize text layout calculations by
  // fractions of a pixel"). measureText() returns the exact rendered width of a
  // string in the current font — install-specific, so fingerprinters read it to
  // enumerate fonts without asking permission. Probed 2026-08-30: our context
  // returned a stable un-noised width straight through, i.e. this surface was open.
  //
  // The perturbation is a fixed fraction of the true width (≈0.02% max), keyed by
  // the string + seed, so it is invisible for any real layout use but shifts the
  // fingerprint hash. It stays DETERMINISTIC per string, because a read-twice-and-
  // compare probe would otherwise catch the randomisation itself — the same trap
  // the canvas noise avoids.
  //
  // Deliberately scoped to canvas measureText, NOT Element.getBoundingClientRect /
  // offsetWidth. Those drive real page layout (sticky bars, virtualised lists, drag
  // math), and this tool's whole job is completing tasks on live sites — noising
  // them trades a marginal fingerprint gain for broken automation, a bad trade.
  try {
    if (typeof CanvasRenderingContext2D !== 'undefined' && typeof TextMetrics !== 'undefined') {
      const METRIC_KEYS = [
        'width', 'actualBoundingBoxLeft', 'actualBoundingBoxRight',
        'actualBoundingBoxAscent', 'actualBoundingBoxDescent',
        'fontBoundingBoxAscent', 'fontBoundingBoxDescent',
        'emHeightAscent', 'emHeightDescent',
        'hangingBaseline', 'alphabeticBaseline', 'ideographicBaseline',
      ];
      const origMeasureText = CanvasRenderingContext2D.prototype.measureText;
      CanvasRenderingContext2D.prototype.measureText = makeNative(function (text) {
        const real = origMeasureText.apply(this, arguments);
        // ±0.02% of the width, fixed per (font+text), centred on zero.
        const factor = 1 + (seededUnit(this.font + '\\u0000' + text) - 0.5) * 0.0004;
        const faked = Object.create(TextMetrics.prototype);
        for (const k of METRIC_KEYS) {
          if (!(k in real)) continue;
          const v = k === 'width' ? real[k] * factor : real[k];
          Object.defineProperty(faked, k, { value: v, enumerable: true, configurable: true });
        }
        return faked;
      }, 'measureText', 1);
    }
  } catch (e) {}

  // ─── 9. AudioContext Noise ─────────────────────────────────────────────────
  try {
    if (typeof AnalyserNode !== 'undefined') {
      const origGetFloatFreq = AnalyserNode.prototype.getFloatFrequencyData;
      AnalyserNode.prototype.getFloatFrequencyData = makeNative(function (array) {
        origGetFloatFreq.apply(this, arguments);
        for (let i = 0; i < array.length; i += 10) {
          array[i] += noiseAt(i) * 0.01;
        }
      }, 'getFloatFrequencyData', 1);
    }

    // The OfflineAudioContext + getChannelData path is what audio fingerprinters
    // actually read. getChannelData hands back a LIVE view into the buffer, so
    // noising it on every call would compound — noise each array exactly once.
    if (typeof AudioBuffer !== 'undefined') {
      const noised = new WeakSet();
      const origGetChannelData = AudioBuffer.prototype.getChannelData;
      AudioBuffer.prototype.getChannelData = makeNative(function () {
        const data = origGetChannelData.apply(this, arguments);
        try {
          if (!noised.has(data)) {
            noised.add(data);
            for (let i = 0; i < data.length; i += 100) {
              data[i] += noiseAt(i) * 1e-7;
            }
          }
        } catch (e) {}
        return data;
      }, 'getChannelData', 1);
    }
  } catch (e) {}

  // ─── 10. MediaDevices Enumeration ──────────────────────────────────────────
  try {
    if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
      const rawMediaDevices = __MEDIA_DEVICES__;
      const deviceList = Array.isArray(rawMediaDevices) ? rawMediaDevices.map(d => ({
        deviceId: d.device_id || d.deviceId || 'default',
        kind: d.kind,
        label: d.label,
        groupId: d.group_id || d.groupId || 'group_1',
      })) : [
        { deviceId: 'default', kind: 'audioinput', label: 'Default - Microphone (Realtek Audio)', groupId: 'group_1' },
        { deviceId: 'comm_default', kind: 'audiooutput', label: 'Default - Speakers (Realtek Audio)', groupId: 'group_1' },
        { deviceId: 'cam_default', kind: 'videoinput', label: 'HD Web Camera (Integrated)', groupId: 'group_2' },
      ];
      Object.getPrototypeOf(navigator.mediaDevices).enumerateDevices = makeNative(
        () => Promise.resolve(deviceList), 'enumerateDevices', 0,
      );
    }
  } catch (e) {}

  // ─── 10b. BatteryManager Virtualization ────────────────────────────────────
  try {
    const batteryTarget = new EventTarget();
    if (typeof BatteryManager !== 'undefined') {
      try { Object.setPrototypeOf(batteryTarget, BatteryManager.prototype); } catch (e) {}
    }
    Object.defineProperty(batteryTarget, 'charging', { value: __BATTERY_CHARGING__, enumerable: true, configurable: true });
    Object.defineProperty(batteryTarget, 'chargingTime', { value: 0, enumerable: true, configurable: true });
    Object.defineProperty(batteryTarget, 'dischargingTime', { value: Infinity, enumerable: true, configurable: true });
    Object.defineProperty(batteryTarget, 'level', { value: __BATTERY_LEVEL__, enumerable: true, configurable: true });
    Object.defineProperty(batteryTarget, 'onchargingchange', { value: null, writable: true, enumerable: true, configurable: true });
    Object.defineProperty(batteryTarget, 'onlevelchange', { value: null, writable: true, enumerable: true, configurable: true });

    const navProto = Object.getPrototypeOf(navigator) || navigator;
    navProto.getBattery = makeNative(() => Promise.resolve(batteryTarget), 'getBattery', 0);
  } catch (e) {}

  // ─── 11. SpeechSynthesis Voices ────────────────────────────────────────────
  try {
    if (window.speechSynthesis) {
      const rawVoiceNames = __VOICES__;
      const voiceList = (Array.isArray(rawVoiceNames) ? rawVoiceNames : []).map((name, idx) => ({
        name,
        lang: 'en-US',
        default: idx === 0,
        localService: true,
        voiceURI: name,
      }));

      Object.getPrototypeOf(window.speechSynthesis).getVoices = makeNative(
        () => voiceList, 'getVoices', 0,
      );
    }
  } catch (e) {}

  // ─── 12. Screen Geometry & Window Chrome ───────────────────────────────────
  try {
    const screenProto = Object.getPrototypeOf(window.screen) || Screen.prototype;
    defineOn(screenProto, 'width', () => __SCREEN_WIDTH__);
    defineOn(screenProto, 'height', () => __SCREEN_HEIGHT__);
    defineOn(screenProto, 'availWidth', () => __SCREEN_AVAIL_WIDTH__);
    defineOn(screenProto, 'availHeight', () => __SCREEN_AVAIL_HEIGHT__);
    defineOn(screenProto, 'availLeft', () => 0);
    defineOn(screenProto, 'availTop', () => 0);
    defineOn(screenProto, 'colorDepth', () => 24);
    defineOn(screenProto, 'pixelDepth', () => 24);
    defineOn(window, 'devicePixelRatio', () => __DEVICE_PIXEL_RATIO__);

    // A real window has browser chrome: tab strip, omnibox, bookmarks bar. With
    // outerHeight === innerHeight the window has no chrome at all, which no
    // interactive browser session ever looks like.
    const CHROME_HEIGHT = 87;
    defineOn(window, 'outerWidth', () => window.innerWidth);
    defineOn(window, 'outerHeight', () => window.innerHeight + CHROME_HEIGHT);
    defineOn(window, 'screenX', () => 0);
    defineOn(window, 'screenY', () => 0);
    defineOn(window, 'screenLeft', () => 0);
    defineOn(window, 'screenTop', () => 0);
  } catch (e) {}

  // ─── 13. Network Information ───────────────────────────────────────────────
  try {
    if (navigator.connection) {
      const connProto = Object.getPrototypeOf(navigator.connection);
      defineOn(connProto, 'rtt', () => __NET_RTT__);
      defineOn(connProto, 'downlink', () => __NET_DOWNLINK__);
      defineOn(connProto, 'effectiveType', () => '__NET_EFFECTIVE_TYPE__');
      defineOn(connProto, 'saveData', () => false);
    }
  } catch (e) {}

  // ─── 14. Permissions API, consistent with Notification.permission ──────────
  try {
    // Pin the source of truth FIRST, then make permissions.query agree with it.
    // Reporting 'prompt' from query() while Notification.permission says 'denied'
    // (its value whenever we fall back to headless) is the classic headless tell,
    // and the old code created it rather than avoiding it.
    let notificationState = 'default';
    if (typeof Notification !== 'undefined') {
      try {
        Object.defineProperty(Notification, 'permission', {
          get: makeNative(() => 'default', 'get permission'),
          configurable: true,
          enumerable: false,
        });
      } catch (e) {
        notificationState = Notification.permission === 'granted' ? 'granted' : 'prompt';
      }
    }
    const queryState = notificationState === 'default' ? 'prompt' : notificationState;

    if (navigator.permissions && navigator.permissions.query) {
      const permProto = Object.getPrototypeOf(navigator.permissions);
      const origQuery = permProto.query || navigator.permissions.query;
      permProto.query = makeNative(function (parameters) {
        if (parameters && (parameters.name === 'notifications' || parameters.name === 'geolocation')) {
          // Real bug, found 2026-08-30 by running this script in a live browser
          // (it predates the hardening pass): the old code built the status with
          // Object.create(PermissionStatus.prototype) and then assigned
          // `status.onchange = null`. That assignment runs PermissionStatus's real
          // setter against an object with none of its internal slots, throwing
          // "Illegal invocation" — so EVERY page calling navigator.permissions
          // .query() got a TypeError. That breaks ordinary sites and is itself a
          // loud signal. Starting from a genuine EventTarget gives the object real
          // slots (so addEventListener works), and every spoofed field is defined
          // as an own data property rather than pushed through a prototype setter.
          const status = new EventTarget();
          if (typeof PermissionStatus !== 'undefined') {
            try { Object.setPrototypeOf(status, PermissionStatus.prototype); } catch (e) {}
          }
          Object.defineProperty(status, 'state', { value: queryState, enumerable: true, configurable: true });
          Object.defineProperty(status, 'name', { value: parameters.name, enumerable: true, configurable: true });
          Object.defineProperty(status, 'onchange', {
            value: null, writable: true, enumerable: true, configurable: true,
          });
          return Promise.resolve(status);
        }
        return origQuery.apply(this, arguments);
      }, 'query', 1);
    }
  } catch (e) {}

  // ─── 15. window.chrome ─────────────────────────────────────────────────────
  // Only filled in if genuinely absent. Real Chromium already provides csi/
  // loadTimes; `chrome.runtime` is deliberately NOT fabricated, since on an
  // ordinary page without an externally_connectable extension it is undefined,
  // and inventing it is its own anomaly.
  try {
    if (!window.chrome) {
      window.chrome = {
        app: { isInstalled: false },
        csi: makeNative(function () { return {}; }, 'csi', 0),
        loadTimes: makeNative(function () { return {}; }, 'loadTimes', 0),
      };
    }
  } catch (e) {}

  // ─── 15b. WebRTC IP leak ────────────────────────────────────────────────────
  //
  // Measured on CreepJS 2026-08-31: the container's REAL public IP
  // appeared in the ICE candidate list, in plain sight, next to a fingerprint claiming
  // a residential device. That is the single most identifying value a detector can
  // collect, and it defeats proxy rotation completely — every "different" identity
  // reports the same origin.
  //
  // The launch flags (--force-webrtc-ip-handling-policy=disable_non_proxied_udp,
  // --enforce-webrtc-ip-permission-check) do NOT cover this: they suppress non-proxied
  // UDP only when a proxy is actually configured, so a direct session leaks anyway.
  // Confirmed by reading the candidates back with both flags set.
  //
  // Filtering candidates would still leak via timing and partial answers, so the whole
  // API is removed instead. A browser without WebRTC is unremarkable — corporate
  // policy and privacy extensions both produce it — while a browser whose WebRTC
  // contradicts its proxy is not.
  try {
    const kill = ['RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection',
                  'RTCDataChannel', 'RTCSessionDescription'];
    for (const name of kill) {
      if (name in window) {
        try { delete window[name]; } catch (e) {}
        try {
          Object.defineProperty(window, name, {
            get: () => undefined, configurable: true,
          });
        } catch (e) {}
      }
    }
    if (navigator.mediaDevices) {
      // getDisplayMedia/getUserMedia stay, but the enumeration path must not become a
      // second route to the same data.
      try {
        Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
          value: () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError')),
          configurable: true,
        });
      } catch (e) {}
    }
  } catch (e) {}

  // ─── 16. Web Worker fingerprint parity ──────────────────────────────────────
  // add_init_script never runs inside a Worker, so WorkerNavigator reports the REAL
  // host. Measured 2026-08-30: the page said 8 cores / Linux while a worker in the
  // same session said 4 cores / Win32 — not just un-spoofed, but a page-vs-worker
  // CONTRADICTION a detector reads directly (fingerprint.js and friends deliberately
  // sample from inside a worker for exactly this reason).
  //
  // Fix: wrap the Worker constructor and prepend a worker-scoped copy of the same
  // 16. Web Worker & Sub-Context Parity (Phase 4).
  // Propagates matching hardwareConcurrency, deviceMemory, platform, and
  // languages to classic workers, ES module workers ({ type: 'module' }),
  // and SharedWorkers so background threads match the main page fingerprint.
  try {
    const OrigWorker = self.Worker;
    if (OrigWorker) {
      const WORKER_SNIPPET = __WORKER_STEALTH_SNIPPET__;
      const WrappedWorker = new Proxy(OrigWorker, {
        construct(target, args) {
          try {
            const url = args[0];
            const opts = args[1];
            const isModule = opts && opts.type === 'module';
            if (typeof url === 'string' && (url.indexOf('blob:') === 0 || url.indexOf('data:') === 0)) {
              if (isModule) {
                const src = WORKER_SNIPPET + '\nimport * as _mod from ' + JSON.stringify(url) + ';';
                const wrappedUrl = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
                return new target(wrappedUrl, opts);
              } else {
                const src = WORKER_SNIPPET + '\nimportScripts(' + JSON.stringify(url) + ');';
                const wrappedUrl = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
                return new target(wrappedUrl, opts);
              }
            }
          } catch (e) {}
          return new target(...args);
        },
      });
      nativeFnMap.add(WrappedWorker);
      self.Worker = WrappedWorker;
    }
  } catch (e) {}

  try {
    const OrigSharedWorker = self.SharedWorker;
    if (OrigSharedWorker) {
      const WORKER_SNIPPET = __WORKER_STEALTH_SNIPPET__;
      const WrappedSharedWorker = new Proxy(OrigSharedWorker, {
        construct(target, args) {
          try {
            const url = args[0];
            const opts = args[1];
            const isModule = opts && opts.type === 'module';
            if (typeof url === 'string' && (url.indexOf('blob:') === 0 || url.indexOf('data:') === 0)) {
              if (isModule) {
                const src = WORKER_SNIPPET + '\nimport * as _mod from ' + JSON.stringify(url) + ';';
                const wrappedUrl = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
                return new target(wrappedUrl, opts);
              } else {
                const src = WORKER_SNIPPET + '\nimportScripts(' + JSON.stringify(url) + ');';
                const wrappedUrl = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
                return new target(wrappedUrl, opts);
              }
            }
          } catch (e) {}
          return new target(...args);
        },
      });
      nativeFnMap.add(WrappedSharedWorker);
      self.SharedWorker = WrappedSharedWorker;
    }
  } catch (e) {}

  try {
    if (navigator && navigator.serviceWorker && navigator.serviceWorker.register) {
      const origRegister = navigator.serviceWorker.register.bind(navigator.serviceWorker);
      const wrappedRegister = function(scriptURL, options) {
        return origRegister(scriptURL, options);
      };
      nativeFnMap.add(wrappedRegister);
      Object.defineProperty(navigator.serviceWorker, 'register', {
        value: wrappedRegister,
        configurable: true,
        writable: true,
      });
    }
  } catch (e) {}
})();
"""

STEALTH_INIT_SCRIPT = ULTRA_STEALTH_INIT_SCRIPT

_DEFAULT_LANGUAGES: tuple[str, ...] = ("en-US", "en")


def _build_worker_snippet(profile: DeviceProfile, langs: tuple[str, ...]) -> str:
    """The worker-scoped half of the fingerprint (section 16 of the init script).

    Runs inside WorkerGlobalScope, where only WorkerNavigator exists — no window,
    document, screen, WebGL prototypes, etc. — so it covers just the navigator
    fields that leak there, and takes its values from the SAME profile as the page
    so the two can never disagree. Kept as a compact single-line IIFE because it is
    concatenated ahead of the worker's real source at construction time.
    """
    return (
        "(function(){"
        "var np=Object.getPrototypeOf(navigator)||navigator;"
        "function def(n,v){try{Object.defineProperty(np,n,"
        "{get:function(){return v;},configurable:true,enumerable:true});}catch(e){}}"
        f"def('hardwareConcurrency',{int(profile.hardware_concurrency)});"
        f"def('deviceMemory',{int(profile.device_memory)});"
        f"def('platform',{json.dumps(profile.platform)});"
        f"var L={json.dumps(list(langs))};"
        "def('languages',Object.freeze(L));def('language',L[0]);"
        # Measured live 2026-08-31: the main thread reported navigator.webdriver ===
        # false while a Worker reported null, because this snippet never defined it.
        # A real browser answers false in BOTH scopes, so the disagreement was itself
        # the tell — and a cheaper one to check than anything it was masking.
        "def('webdriver',false);"
        "})();"
    )


def build_stealth_init_script(
    profile: DeviceProfile,
    languages: tuple[str, ...] | list[str] | None = None,
) -> str:
    """Render the init script for a specific DeviceProfile with matched hardware,
    GPU, client-hint and OS-voice properties.

    `languages` comes from the session's GeoProfile so `navigator.languages` matches
    the Accept-Language header the same context sends; it falls back to en-US for
    callers that have no geo resolution (tests, direct use).
    """
    langs = tuple(languages) if languages else _DEFAULT_LANGUAGES

    script = ULTRA_STEALTH_INIT_SCRIPT
    script = script.replace("__WORKER_STEALTH_SNIPPET__", json.dumps(_build_worker_snippet(profile, langs)))
    script = script.replace("__HW_CONCURRENCY__", str(profile.hardware_concurrency))
    script = script.replace("__DEVICE_MEMORY__", str(profile.device_memory))
    script = script.replace("__PLATFORM__", profile.platform)
    script = script.replace("__UA_PLATFORM__", profile.ua_platform)
    script = script.replace("__PLATFORM_VERSION__", profile.platform_version)
    script = script.replace("__ARCHITECTURE__", profile.architecture)
    script = script.replace("__BITNESS__", profile.bitness)
    script = script.replace("__CHROME_MAJOR__", profile.chrome_version.split(".")[0])
    script = script.replace("__CHROME_VERSION__", profile.chrome_version)
    script = script.replace("__GPU_VENDOR__", profile.gpu_vendor)
    script = script.replace("__GPU_RENDERER__", profile.gpu_renderer)
    script = script.replace("__SCREEN_WIDTH__", str(profile.screen_width))
    script = script.replace("__SCREEN_HEIGHT__", str(profile.screen_height))
    script = script.replace("__SCREEN_AVAIL_WIDTH__", str(profile.screen_avail_width))
    script = script.replace("__SCREEN_AVAIL_HEIGHT__", str(profile.screen_avail_height))
    script = script.replace("__DEVICE_PIXEL_RATIO__", str(profile.device_pixel_ratio))
    script = script.replace("__NOISE_SEED__", str(profile.noise_seed))
    script = script.replace("__WEBGL_EXTENSIONS__", json.dumps(list(profile.webgl_extensions)))
    script = script.replace("__VOICES__", json.dumps(list(profile.voices)))
    script = script.replace("__LANGUAGES__", json.dumps(list(langs)))

    media_devices_data = [
        {"device_id": d.device_id, "kind": d.kind, "label": d.label, "group_id": d.group_id}
        for d in getattr(profile, "media_devices", ())
    ]
    script = script.replace("__MEDIA_DEVICES__", json.dumps(media_devices_data))
    script = script.replace("__BATTERY_CHARGING__", "true" if getattr(profile, "battery_charging", True) else "false")
    script = script.replace("__BATTERY_LEVEL__", str(getattr(profile, "battery_level", 1.0)))
    script = script.replace("__NET_DOWNLINK__", str(getattr(profile, "network_downlink", 10.0)))
    script = script.replace("__NET_RTT__", str(getattr(profile, "network_rtt", 50)))
    script = script.replace("__NET_EFFECTIVE_TYPE__", str(getattr(profile, "network_effective_type", "4g")))
    return script


async def apply_stealth_to_context(
    context,
    profile: DeviceProfile | None = None,
    languages: tuple[str, ...] | list[str] | None = None,
) -> None:
    """Apply fingerprint-masking overrides to every page opened in this context."""
    if profile is None:
        from nanoagent.agent.effector.stealth.fingerprint_pool import DEVICE_PROFILES
        profile = DEVICE_PROFILES[0]
    await context.add_init_script(build_stealth_init_script(profile, languages))


def generate_bezier_trajectory(start: Point, end: Point, steps: int = 20) -> list[Point]:
    """Organic cubic-Bezier mouse trajectory with Fitts's-law acceleration/
    deceleration, physiological micro-tremor hand jitter, and natural micro-overshoot correction."""
    from nanoagent.agent.effector.stealth.kinetics import generate_neuromotor_trajectory
    return generate_neuromotor_trajectory(start, end, steps)


async def human_mouse_move(page, start: Point, end: Point) -> None:
    """Move the mouse along an organic Bezier path with variable inter-frame pauses."""
    path = generate_bezier_trajectory(start, end, 16)
    for i, pt in enumerate(path):
        await page.mouse.move(pt.x, pt.y)
        approaching_end = i > len(path) * 0.8
        frame_delay = (8 + random.randint(0, 11)) if approaching_end else (3 + random.randint(0, 5))
        await page.wait_for_timeout(frame_delay)


async def human_type(page, text: str, min_delay_ms: int = 35, max_delay_ms: int = 110) -> None:
    """Humanized typing with QWERTY physical layout distance matrices, digraph flight times,
    and Gaussian neuromotor variance."""
    from nanoagent.agent.effector.stealth.kinetics import calculate_digraph_flight_delay

    for i, char in enumerate(text):
        prev_char = text[i - 1] if i > 0 else ""
        delay = calculate_digraph_flight_delay(prev_char, char, min_delay_ms, max_delay_ms)
        await page.keyboard.type(char, delay=delay)


async def human_scroll(page, delta_y: int, steps: int = 8) -> None:
    """Inertial scrolling with acceleration/deceleration curves, subtle horizontal
    micro-drift, and post-scroll reading dwell time."""
    if abs(delta_y) < 10:
        await page.mouse.wheel(0, delta_y)
        return

    sign = 1 if delta_y > 0 else -1
    total_abs = abs(delta_y)
    adaptive_steps = max(5, min(25, round(steps * (total_abs / 400))))

    accumulated = 0
    for i in range(adaptive_steps):
        t = (i + 1) / adaptive_steps
        # Ease-out cubic curve
        curve_val = 1 - math.pow(1 - t, 3)
        target_step_acc = round(total_abs * curve_val)
        step_delta = target_step_acc - accumulated
        accumulated = target_step_acc

        if step_delta > 0:
            drift_x = round((random.random() - 0.5) * 2) if i % 2 == 0 else 0
            await page.mouse.wheel(drift_x, step_delta * sign)

        delay = random.randint(12, 28)
        await page.wait_for_timeout(delay)

    # Human reading dwell pause after scroll
    dwell = random.randint(150, 450)
    await page.wait_for_timeout(dwell)


def is_challenge_page(url: str, title: str, body_text: str) -> bool:
    """Detect whether the page is stuck on an anti-bot challenge / Cloudflare /
    DataDome / Kasada / Arkose verification screen.

    Wired into react_loop.py's perception phase as of 2026-08-30 — before that it
    was tested but had no production caller, so an interstitial was invisible to
    the loop and the agent burned its whole turn budget snapshotting "Just a
    moment...".
    """
    lower_url = url.lower()
    lower_title = title.lower()
    lower_body = body_text.lower()
    return (
        "just a moment" in lower_title
        or "attention required" in lower_title
        or "security challenge" in lower_title
        or "verify you are human" in lower_body
        or "cf-turnstile" in lower_body
        or "challenges.cloudflare.com" in lower_url
        or "cloudflare ray id" in lower_body
        or "datadome" in lower_body
        or "geo.captcha-delivery.com" in lower_url
        or "kpsdk" in lower_body
        or "arkoselabs" in lower_body
        or "funcaptcha" in lower_body
        or "access denied" in lower_body
        or "bot detection" in lower_body
        or "unusual activity" in lower_body
    )
