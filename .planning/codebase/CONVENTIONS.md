# Coding Conventions

**Analysis Date:** 2026-08-20

## Naming Patterns

**Domain Logic — Brazilian Portuguese:**
All identifiers for domain logic use Brazilian Portuguese naming. This is mandatory and consistent throughout:
- `enviarChunks`, `atualizarChunks` (relay operations)
- `desistirDoRtc` (abandoning WebRTC)
- `nivelH264`, `NIVEIS_H264` (H.264 level constants)
- `afogado` (encoder flooded/backpressured state)
- `proximaMarca` (next timing grid mark)
- `relogioDeCaptura` (capture clock)
- `somBloqueado` (audio blocked)
- `temSom`, `temViewer` (boolean checks)
- `transmitindo`, `restituicoesEspera` (state queries)

**Web API Surface — English:**
Web API names, global object names, and public function parameters remain in English:
- `WebCodecs`, `WebSocket`, `RTCPeerConnection` (browser APIs)
- `getVideoTracks()`, `getAudioTracks()` (standard methods)
- `fetch`, `MediaStreamTrackProcessor` (browser APIs)
- Function parameters and options use English (`bitrate`, `fps`, `codec`, `wsUrl`)

**Files:**
- `*.test.js` for test files (co-located with source)
- `*.mjs` for Node.js script files in `/scripts`
- `*.js` for ES modules in server, client, and shared
- `*.config.js` for configuration files (eslint.config.js, vitest.config.js)

**Functions:**
- camelCase: `createBroadcaster`, `pickConfig`, `prepararSom`, `atualizarChunks`
- Predicates use `tem` prefix for "has" checks: `temViewer`, `temSom`
- Constants: UPPER_SNAKE_CASE: `NIVEIS_H264`, `MAX_BROADCASTERS`, `KEYFRAME_EVERY_MS`

**Variables:**
- camelCase for mutable state and local variables
- Underscore prefix for unused parameters (ESLint enforced): `_unused`, `_event`
- Module-level state: camelCase (e.g., `proximoPeerId`, `afogado`)

**Types:**
- No TypeScript, but JSDoc for function signatures
- `@param {type} name description`
- `@return {type} description`

## Code Style

**Formatting:**
- Tool: Prettier 3.9.6
- `singleQuote: true` — single quotes for strings
- `printWidth: 100` — line length limit
- `endOfLine: lf` — Unix line endings (critical for cross-platform CI)

**Linting:**
- Tool: ESLint 10.8.1 (flat config in `eslint.config.js`)
- Base: `@eslint/js:recommended`
- ECMAScript: 2024 (latest standard features)
- Module source type: `module` (ES6 imports/exports)
- `no-unused-vars` rule: error with `^_` pattern to allow unused parameters prefixed with underscore
- Config separates concerns:
  - `server/**/*.js` + `scripts/**/*.mjs` use Node globals
  - `client/src/**/*.js` + `shared/**/*.js` use browser + worker globals
  - Prettier config disables conflicting ESLint rules (last in config)

**Indentation:**
- 2 spaces (Prettier enforced)
- No tabs

## Comment Style

**Philosophy: WHY over WHAT**

Comments are **essayistic and explain reasoning**, including the history of bugs that motivated the code. This is mandatory. Terse descriptive comments would violate the codebase convention.

**Example from `shared/broadcaster.js`:**

```javascript
/**
 * Níveis do H.264, do mais baixo ao mais alto, com os dois tetos que decidem.
 *
 * Nome de codec do H.264 carrega o nível nos dois últimos dígitos, e nível não
 * é enfeite: é um contrato sobre o tamanho do quadro e sobre quantos
 * macroblocos por segundo o decodificador precisa aguentar. Pedir um nível que
 * não cabe faz o navegador recusar a configuração inteira — e, no nosso caso,
 * cair em VP8, que a 1080p não tem encoder por hardware em máquina nenhuma
 * comum e derruba a taxa de quadros pela metade.
 *
 * Este arquivo pediu `avc1.42E01E` — nível 3.0 — desde sempre. Nível 3.0 aguenta
 * 1620 macroblocos por quadro, uns 720×576. Uma tela 1080p tem 8160. O H.264
 * nunca esteve disponível para compartilhamento de tela; só para câmera, que
 * captura pequeno o bastante para caber. Ninguém tinha por que desconfiar,
 * porque a transmissão funcionava — só que em software.
 */
const NIVEIS_H264 = [
  { nivel: 0x1e, maxFS: 1620, maxMBPS: 40500 }, // 3.0
  { nivel: 0x1f, maxFS: 3600, maxMBPS: 108000 }, // 3.1
  // ... more levels
];
```

**Another example from `shared/broadcaster.js`, explaining tolerance logic:**

```javascript
/**
 * Quão longe da marca da grade um quadro ainda serve para aquela marca.
 *
 * Meio intervalo para cada lado, e meio não é chute: é a maior tolerância que
 * ainda escolhe um quadro só por marca. Mais que isso e dois quadros disputam
 * a mesma vaga; menos e o tremor normal da captura passa a derrubar quadro bom.
 *
 * Este número já foi 15% do intervalo, e foi um erro caro. A 30 fps sobravam
 * 5 ms de folga e ninguém via nada; a 60 fps sobravam 2,5 — menos que o tremor
 * da própria captura de tela. O freio passou a derrubar quadros ao acaso, e a
 * taxa virou cara ou coroa entre 60 e 30. Era isso que fazia 60 fps tremer.
 */
const TOLERANCIA_GRADE = 0.5;
```

**When to Comment:**
- Every non-trivial constant must explain its purpose and any bugs it prevents
- Tricky logic must explain WHY this approach was chosen over alternatives
- Performance decisions must explain the trade-off
- Bug fixes must explain what was wrong and why it matters
- Historical context is valuable if it explains the current constraint

## Import Organization

**Order:**
1. Node.js built-ins (`import fs from 'node:fs'`)
2. Third-party packages (`import { describe, it } from 'vitest'`)
3. Local imports (`import { createRoom } from './rooms.js'`)

**Path Aliases:**
- Not used in this codebase
- Imports use relative paths with explicit extensions: `'./broadcaster.js'`, `'./rooms.js'`

**Exports:**
- Named exports preferred: `export function name() {}`
- Default exports used for single export modules
- Barrel files (`index.js`) aggregate related exports where appropriate

## Function Design

**Size:** Functions should fit on one screen; complex logic broken into smaller functions

**Parameters:**
- Destructured objects for functions with multiple parameters:
  ```javascript
  export function createBroadcaster({
    wsUrl,
    bitrate,
    fps,
    audio = false,
    fonte = 'tela',
    onStatus,
    onStats,
    onEnd,
  }) {
    // implementation
  }
  ```
- Optional parameters with defaults in destructured objects
- Comments explain defaults when non-obvious

**Return Values:**
- Functions return objects with clear property names
- Promise-returning functions marked with `async`
- Null for "not found" or "not applicable" conditions

## Error Handling

**Patterns:**
- Throw descriptive errors with context: `throw new Error('Nenhum codec de vídeo suportado')`
- Try/catch for async operations that might fail
- Validation before async calls to fail fast
- User-facing errors avoid technical jargon where possible

**Example:**
```javascript
if (!config) {
  cleanup();
  throw new Error('Nenhum codec de vídeo suportado por este navegador.');
}
```

## Module Design

**Entry Points:**
- `server/index.js` — HTTP server and WebSocket relay
- `shared/broadcaster.js` — screen/camera capture pipeline
- `shared/rtc.js` — WebRTC peer management
- `client/src/player.js` — video playback and timing

**Server Structure:**
- `server/rooms.js` — room registry and relay logic (Portuguese identifiers: `createRoom`, `attachViewer`, `attachBroadcaster`)
- `server/admin.js` — admin panel routes
- `server/tokens.js` — session token generation
- `server/system.js` — system info endpoints

**Shared Structure:**
- `shared/broadcaster.js` — unified capture → encode → send pipeline
- `shared/rtc.js` — WebRTC peer connection setup
- Both modules are reused across Activity and external capture page

## Testing Patterns

See TESTING.md for comprehensive testing conventions.

---

*Convention analysis: 2026-08-20*
