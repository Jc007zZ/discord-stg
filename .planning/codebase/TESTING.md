# Testing Patterns

**Analysis Date:** 2026-08-20

## Test Framework

**Runner:**
- Vitest 4.1.11
- Config: `vitest.config.js`

**Assertion Library:**
- Chai (via Vitest)
- Usage: `expect(value).toBe(expected)`, `expect(fn).toHaveBeenCalled()`

**Run Commands:**
```bash
npm test              # Run all tests once
npm run test:watch   # Watch mode with auto-rerun
npm run coverage     # Generate coverage report
```

## Test Environment

**Default Environment:** Node.js

**Setup File:** `vitest.setup.js` runs before any imports:
- Sets `NODE_ENV = 'test'`
- Clears environment variables to prevent `.env` leaking into tests:
  - `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN`
  - `DISCORD_ADMIN_ID`, `PUBLIC_ORIGIN`
  - Sets `SESSION_SECRET` to minimum valid value if not provided
  - Sets `PORT = 0` for automatic free port selection (prevents conflicts between concurrent tests)

**Browser Environment (jsdom):** Required for browser APIs

Specified per-file with directive at top:
```javascript
// @vitest-environment jsdom
```

**Why this matters:** Most server tests run in Node (faster). Only modules testing browser APIs like WebCodecs, WebSocket, or MediaStreamTrackProcessor need jsdom. This split prevents performance penalty of full jsdom initialization for every server test.

## Test File Organization

**Location:** Co-located with source files

**Naming:**
- `*.test.js` for test files
- Example: `shared/broadcaster.js` paired with `shared/broadcaster.test.js`

**Pattern Matching:**
- `server/**/*.test.js` — all server tests
- `shared/**/*.test.js` — all shared module tests
- `client/src/**/*.test.js` — all client tests

**Structure:**
```
test-file.js
├── import statements
├── helper functions and test doubles (fakes/mocks)
├── beforeEach() setup
├── afterEach() teardown
├── describe() suites
│   ├── it() test cases
│   └── nested describe() if organizing subtopics
└── vi.spyOn() mocks cleared in afterEach()
```

## Test Structure

**Suite Organization:**

```javascript
/**
 * Detailed comment explaining what is being tested and WHY.
 *
 * This module does X, and the test verifies Y because of Z bug history.
 * What we really test is the logic, not the external APIs.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Test doubles and helpers come first
class FakeSomething { /* ... */ }
function helperFunction() { /* ... */ }

// Lifecycle hooks
beforeEach(() => {
  // Initialize mocks, stubs, counters
  vi.stubGlobal('SomeGlobal', FakeClass);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  // Clean up
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// Actual tests
describe('Module name or feature', () => {
  it('does something when conditions are met', () => {
    // Arrange
    const input = { /* ... */ };
    
    // Act
    const result = functionUnderTest(input);
    
    // Assert
    expect(result).toMatchObject({ expected: 'value' });
  });

  describe('edge case category', () => {
    it('handles edge case X', () => {
      // ...
    });
  });
});
```

**Example from `shared/broadcaster.test.js`:**

```javascript
describe('nivelH264', () => {
  /**
   * The bug that cost the most in this codebase: the codec name requested
   * level 3.0 fixed, and level 3.0 supports 1620 macroblocks per frame.
   * A 1080p screen has 8160. The browser refused, fell back to VP8, and
   * VP8 at 1080p has no hardware encoder — frame rate dropped by half and
   * nobody knew why.
   */
  it('não cabe uma tela 1080p no nivel que este arquivo pedia', () => {
    expect(nivelH264(1920, 1080, 30)).toBeGreaterThan(0x1e);
  });

  it('escolhe 4.0 para 1080p a 30 quadros', () => {
    // 8160 macroblocks fit in 8192 of level 4.0, and 244800 per second fit
    // in 245760. Tight fit — so 60 fps won't.
    expect(nivelH264(1920, 1080, 30)).toBe(0x28);
  });
});
```

## Mocking Strategy

**Framework:** `vi` object from Vitest

**Global Stubs:**
```javascript
// Stub global objects that don't exist in Node
vi.stubGlobal('VideoEncoder', VideoEncoderFalso);
vi.stubGlobal('WebSocket', SocketFalso);
vi.stubGlobal('RTCPeerConnection', PeerFalso);
vi.stubGlobal('fetch', vi.fn(async () => ({ /* response */ })));
```

**Method Spying:**
```javascript
// Spy on and mock console, without affecting actual logging
vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});

// Spy on existing methods
vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
  drawImage: vi.fn(),
});
```

**Function Mocking:**
```javascript
VideoEncoderFalso.isConfigSupported = vi.fn(async (config) => ({
  supported: config.codec.startsWith('avc1.') && Boolean(config.avc),
  config,
}));
```

**Cleanup:**
```javascript
afterEach(() => {
  vi.unstubAllGlobals();  // Remove all global stubs
  vi.restoreAllMocks();   // Restore all spies
  vi.clearAllMocks();     // Clear call history
});
```

## Test Doubles (Fakes)

**Philosophy:** Fakes implement the **contract** of an API, not its actual behavior.

For WebCodecs, WebSocket, RTCPeerConnection — test doubles mimic their public interface and event patterns, not the internal codec/streaming logic.

**Examples from `shared/broadcaster.test.js`:**

### VideoEncoderFalso
```javascript
class VideoEncoderFalso {
  constructor({ output, error }) {
    this.output = output;  // callback for encoded chunks
    this.error = error;
    this.state = 'unconfigured';
    this.encodeQueueSize = 0;
  }
  configure(config) {
    this.state = 'configured';
    this.configuracoes.push(config);
  }
  encode(frame, opcoes) {
    this.codificados.push({ frame, opcoes });
  }
  close() {
    this.state = 'closed';
  }
}
```

This fake doesn't actually encode — it just verifies the module calls these methods with the expected configurations.

### SocketFalso
```javascript
class SocketFalso {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.enviados = [];
    this.ouvintes = {};
  }
  addEventListener(evento, ouvinte) {
    (this.ouvintes[evento] ??= []).push(ouvinte);
  }
  disparar(evento, dado) {
    (this.ouvintes[evento] ?? []).forEach((ouvinte) => ouvinte(dado));
  }
  send(dado) {
    this.enviados.push(dado);  // Collect for assertions
  }
}
```

Allows tests to:
- Trigger events (`ws.disparar('open')`)
- Inspect what was sent (`ws.enviados`, `ws.mensagens()`)
- Control socket state (`readyState`)

### RTCPeerConnection Double (PeerFalso)
```javascript
class PeerFalso {
  constructor(config) {
    this.config = config;
    this.ouvintes = new Map();
    this.faixas = [];
    this.senders = [];
  }
  addEventListener(nome, fn) {
    this.ouvintes.set(nome, fn);  // Store for test to trigger
  }
  disparar(nome, evento) {
    this.ouvintes.get(nome)?.(evento);  // Trigger event from test
  }
  addTrack(track, stream) {
    const sender = { track, replaceTrack: async (nova) => {} };
    this.senders.push(sender);
    return sender;
  }
  async createOffer() {
    return { type: 'offer', sdp: 'v=0 oferta' };
  }
}
```

Enables testing:
- Offer/answer negotiation flow
- ICE candidate handling
- Track replacement without renegotiation

## Coverage

**Provider:** v8

**Coverage Report Files:**
- Text summary in console
- LCOV format in `coverage/lcov.info`
- HTML report in `coverage/lcov-report/index.html`

**Threshold (Enforced in CI):** 86% for lines, statements, functions, branches

**Scope:**
- **Included:** `server/**/*.js`, `shared/**/*.js`
- **Excluded:** `server/public/**`, `client/src/`, `**/*.test.js`

**Why 86%?** Set deliberately below current coverage to prevent CI failures on every new line. If threshold touched current measurement (>86%), adding any new code without 100% coverage would break the build. The floor exists to prevent *regressions*, not to enforce perfection.

**Check Coverage:**
```bash
npm run coverage
```

## Test Count

**Total test files:** 11
```
client/src/player.test.js          — playback timing and scheduling
server/admin.test.js               — admin panel routes
server/index-admin.test.js         — admin setup with Discord auth
server/index-ws.test.js            — WebSocket relay endpoints
server/index.test.js               — HTTP routes without credentials
server/rooms-limpeza.test.js       — room cleanup/expiration logic
server/rooms.test.js               — room registry and relay core
server/system.test.js              — system info endpoints
server/tokens.test.js              — session token generation
shared/broadcaster.test.js         — capture → encode → send pipeline
shared/rtc.test.js                 — WebRTC peer setup and negotiation
```

**Test Philosophy:**
- Tests verify *logic decisions*, not API wrapping
- Each test suite includes explanatory comments on WHY that module needs testing
- Integration tests (server index tests) use real server instance
- Unit tests use doubles for external APIs (WebCodecs, WebSocket, WebRTC)

## Async Testing

**Pattern:**

```javascript
it('does something async', async () => {
  const result = await asyncFunction();
  expect(result).toBe(expected);
});
```

**Yielding Control:** Many tests need to yield to event loop before assertions:

```javascript
const respirar = async (voltas = 4) => {
  for (let i = 0; i < voltas; i++) await new Promise((pronto) => setTimeout(pronto, 0));
};

it('sends message when socket opens', async () => {
  const promessa = broadcaster.start();
  await respirar();  // Let pending promises run
  socket.abrir();    // Trigger event
  await promessa;    // Wait for start to complete
  expect(ws.mensagens()).toContainEqual({ type: 'start' });
});
```

This pattern (named `respirar` — "breathe") lets asynchronous operations settle without artificial delays.

## Fake Time Testing

**Pattern (when needed):**

```javascript
it('sends stats every second', () => {
  vi.useFakeTimers();
  try {
    const onStats = vi.fn();
    broadcaster = createBroadcaster({ onStats });
    
    vi.advanceTimersByTimeAsync(1000);
    expect(onStats).toHaveBeenCalledWith(expect.objectContaining({ mbps: expect.any(Number) }));
  } finally {
    vi.useRealTimers();
  }
});
```

Used sparingly for timing-sensitive tests; most tests use real timers with the `respirar` helper.

## Error Testing

**Pattern:**

```javascript
it('throws when codec is unsupported', async () => {
  VideoEncoderFalso.isConfigSupported.mockResolvedValue({ supported: false });
  
  await expect(createBroadcaster(opts).start()).rejects.toThrow(/Nenhum codec/);
});

it('rejects without audio when surface is unreliable', async () => {
  const { b } = await noAr({ audio: true }, streamWithUnknownSurface);
  
  await expect(b.trocarSom()).rejects.toThrow(/de onde vinha esse som/);
});
```

## Test Data & Fixtures

**Inline Helpers:** Most test data is created inline with helper functions

Example from `server/rooms.test.js`:
```javascript
const pessoa = (id, extra = {}) => ({ id, name: `Pessoa ${id}`, ...extra });

const quadro = (slot, tipo, tamanho = 64) => {
  const buffer = Buffer.alloc(tamanho);
  buffer[0] = slot;
  buffer[1] = tipo;
  return buffer;
};
```

**No Separate Fixtures:** Test data factories are defined in test files, not in separate fixtures. This keeps tests self-contained and readable.

## Common Patterns

**Setup Helpers (from `shared/broadcaster.test.js`):**
```javascript
/** Runs event loop iterations to let async code settle. */
const respirar = async (voltas = 4) => {
  for (let i = 0; i < voltas; i++) await new Promise((pronto) => setTimeout(pronto, 0));
};

/** Starts a broadcast up to the socket opening. */
async function noAr(extra = {}, stream = telaSimples()) {
  prepararCaptura(stream);
  const b = createBroadcaster(opcoes(extra));
  const promessa = b.start();
  await respirar();
  sockets.at(-1).abrir();
  await promessa;
  return { b, ws: sockets.at(-1), encoder: encoders.at(-1), stream };
}
```

**State Isolation:** Tests use unique identifiers to stay isolated:
```javascript
let sequencia = 0;
const instancia = () => `canal-${++sequencia}`;  // Each test gets unique ID
```

---

*Testing analysis: 2026-08-20*
