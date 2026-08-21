# Sala de Tela — distribuição P2P em árvore

## What This Is

Discord Activity (e site avulso) para compartilhar tela com som numa sala,
construída sobre WebCodecs, um relay WebSocket e WebRTC. Quem transmite captura
a tela no navegador, codifica em H.264 e entrega os quadros aos espectadores —
hoje por conexão direta quando ela fecha, e pelo relay do servidor quando não
fecha.

Este milestone muda a **topologia de distribuição**: sair da estrela (uma
conexão do transmissor para cada espectador, sem teto) para uma **árvore de um
salto de repasse**, em que alguns espectadores repassam a tela para outros, com
o servidor decidindo quem é pai de quem.

## Core Value

Uma sala de 10 pessoas assistindo à mesma tela sem estourar a banda do servidor
nem a subida de quem transmite — e sem que ninguém fique na tela preta.

## Business Context

- **Customer**: comunidades do Discord que assistem tela juntas; produção em discordbr.live
- **Revenue model**: não monetizado — o custo é banda de servidor, e é ele que aperta
- **Success metric**: GB/hora de servidor por transmissão, hoje ~11 GB/h com 10 espectadores
- **Strategy notes**: 100 GB consumidos em poucas horas foi o gatilho deste trabalho

## Requirements

### Validated

<!-- Já existe no código e é confiado. Ver .planning/codebase/. -->

- ✓ Captura de tela e câmera com WebCodecs `VideoEncoder` — existing
- ✓ Seleção de codec/perfil/nível H.264 pelo tamanho e taxa do quadro (`nivelH264`, `candidatos`) — existing
- ✓ Grade de ritmo + histerese de backpressure no encoder (estabilidade a 60 fps) — existing
- ✓ Relay WebSocket com salas, slots, keyframe sob demanda e limite de buffer — existing
- ✓ Malha WebRTC estrela com sinalização pelo próprio WebSocket (`rtc-want`, `rtc`, `rtc-bye`, `rtc-ativo`) — existing
- ✓ Queda silenciosa de conexão direta para relay, decidida por quem assiste — existing
- ✓ Corte do fluxo do relay quando todos os espectadores estão em conexão direta (`atualizarChunks`) — existing
- ✓ Cascata de escape para obter `RTCPeerConnection` dentro da Activity do Discord (`construtorPeer`) — existing
- ✓ Buffer de jitter com reamostragem contra grade ideal no espectador — existing
- ✓ Autenticação Discord OAuth e tokens de sala — existing
- ✓ Suíte de 403 testes com dublês de WebCodecs / WebSocket / RTCPeerConnection, 86% de cobertura no CI — existing

### Active

- [ ] **R1** — Teto de leque no transmissor, com transbordo para o relay: nenhum
      transmissor sobe mais que N × bitrate, e quem não couber assiste pelo relay
      em vez de degradar a sala inteira
- [ ] **R2** — Leque derivado de capacidade medida (`availableOutgoingBitrate`),
      não de constante chutada; encolhe quando as estatísticas do filho mostram perda
- [ ] **R3** — Repasse de faixa: um espectador aceita filhos e repassa a faixa
      recebida sem decodificar nem recodificar
- [ ] **R4** — Servidor dono da topologia: mantém a árvore, atribui pai, detecta
      saída, adota órfão. Filho nunca escolhe o próprio pai (evita ciclo)
- [ ] **R5** — Escolha de pai ponderada, isolada numa função pura
      `escolherPai(candidatos, novoEspectador)`: cortes duros primeiro
      (capacidade, celular, profundidade), depois nota por ASN → faixa de RTT →
      folga → tempo de sala → RTT real medido
- [ ] **R6** — Correção por medição: o filho mede RTT e perda depois de conectar
      e reporta; o servidor re-paterniza com histerese quando o ganho compensa
- [ ] **R7** — Relay permanece como camada de baixo, sempre: órfão volta ao relay
      em menos de um segundo enquanto o servidor rearranja
- [ ] **R8** — `P2P_ONLY` deixa de desligar o relay para todos sem aviso; vira um
      modo de diagnóstico explícito, ou sai
- [ ] **R9** — Árvore visível no painel admin (quem é pai de quem, capacidade,
      RTT, motivo da última troca)
- [ ] **R10** — Instrumentação de banda: GB/hora por transmissão, % de
      espectadores em conexão direta, subida máxima do transmissor
- [ ] **R11** — Instrumentação de TURN: quantos pares não fecham sem TURN e
      quanta banda de relay esses casos custam (medir, não implantar)
- [ ] **R12** — Engrenagem de qualidade/fps no site: seta ao lado do ícone de
      tela abrindo bitrate e fps, gravando no localStorage
- [ ] **R13** — Lista de quem está na sala volta ao passar o mouse no ícone de
      pessoa da lateral

### Out of Scope

- **SFU** — mesmo custo de banda de servidor que o relay atual; não resolve o problema que motivou o trabalho
- **TURN em produção** — TURN reencaminha a mídia pelo servidor, ou seja, é a mesma banda do relay com outro protocolo, e o relay já existe e já cobre esses casos. Fica só a instrumentação (R11); `TURN_URL/USER/PASS` continuam funcionando
- **Árvore de profundidade arbitrária** — o custo (órfão em cascata, ciclo, latência acumulada, depuração) é proporcional à profundidade, e o teto de 10 espectadores não exige mais que um salto
- **Troca de pai sem costura** — o usuário aceitou travadinha ou loading na troca; buscar transição invisível não vale o custo
- **UI de "você está repassando"** — decidido invisível; acontece nos bastidores como em qualquer P2P
- **Evitar o alerta de firewall do Windows** — pesquisado: não existe P2P real sem socket UDP, e toda alternativa devolve o custo para o servidor. O alerta é do `discord.exe`, reaparece a cada update do Discord por causa do caminho versionado, e quem bloquear cai no relay
- **Promoção de produção (`origin`/`locutor`)** — o usuário decide quando promover; fora deste roadmap
- **Reescrever o `<video>` fora do DOM** — mapeado como risco BAIXO, funciona porque `srcObject` é setado antes do listener; vira nota de manutenção

## Context

**Ecossistema.** Monorepo npm workspaces (raiz + `client` + `server` + `shared/`),
Node 22, Express 4 + `ws` 8, Vite 6 no cliente, Vitest 4. Deploy na Square Cloud
(`squarecloud.app`), que não instala devDependencies — por isso o `vite` está em
`dependencies`. Mapa completo em `.planning/codebase/`.

**Topologia atual.** Estrela. `watch()` em `server/rooms.js` emite `rtc-want` para
cada espectador; `abrirPeer` em `shared/broadcaster.js` abre um `RTCPeerConnection`
por espectador, cada um levando o bitrate cheio. **Não há teto.** Dez espectadores
a 2,5 Mb/s exigiriam 25 Mb/s de subida de uma conexão doméstica.

**O que motivou.** 100 GB de banda de servidor em poucas horas. A conta: o relay
custa entrada + N × saída, e a 10 espectadores isso é ~11 GB por hora de transmissão.

**Onde estamos.** WebRTC funciona, inclusive dentro da Activity do Discord, depois
de descobrir que o sandbox anula `window.RTCPeerConnection` mas deixa
`webkitRTCPeerConnection` e um iframe filho intactos (`construtorPeer`).

**Diagnóstico já feito.** O sintoma "estou vendo uma tela e mais ninguém consegue
conectar" foi observado **no stg com `P2P_ONLY` ligado** — nesse modo o relay é
desligado para todos e quem não fecha conexão direta fica em "Conectando…" para
sempre. Não é (ou não é só) saturação de subida. Isso rebaixa a urgência do teto
de leque, mas não o elimina.

**Perfil de uso.** O caso comum é 2 ou 3 espectadores; o alvo de projeto é 10. Com
leque 3 e profundidade 2 cabem 12; com leque 4, 20. Em 2 ou 3 espectadores a
árvore **é** a estrela de hoje — profundidade zero, nenhum caminho novo percorrido.

**Peça que decide tudo.** Um espectador consegue repassar a faixa recebida para
uma nova `RTCPeerConnection` via `addTrack`, sem decodificar e sem recodificar.
Se isso não se sustentar, a árvore inteira cai e o escopo vira R1+R2 apenas.
É o primeiro item a provar.

**Lacunas de teste herdadas.** Não existe cobertura para o comportamento de
fan-out do WebRTC, `P2P_ONLY` não é exercitado no CI, e não há teste de
integração para o corte de banda com zero espectadores. A fase da árvore precisa
construir esse arcabouço antes de mexer na topologia.

## Constraints

- **Performance**: latência acumula um salto no neto (RTT do enlace + buffer de jitter, hoje `BUFFER_MS = 80`). O teto aceitável **ainda não está definido** — é pergunta a responder com número medido no spike, não a chutar agora
- **Compatibility**: precisa funcionar dentro do iframe da Activity do Discord, onde `window.RTCPeerConnection` é `null` e todo tráfego passa por `/.proxy`
- **Tech stack**: sem dependência nova de mídia; a árvore é construída sobre o `RTCPeerConnection` e o WebSocket que já existem
- **Testing**: 86% de cobertura no CI é piso, não meta — a queda foi corrigida antes escrevendo teste de verdade, não baixando o limiar
- **Convenções**: identificadores e comentários de domínio em português; comentários explicam **por quê**, incluindo a história do bug que motivou o código. Ver `.planning/codebase/CONVENTIONS.md`
- **Deploy**: `stg` (`github.com/Jc007zZ/discord-stg`) tem autorização aberta para push. `origin` e `locutor` servem produção e **exigem pedido explícito** a cada vez
- **Não testar em produção**: há usuários demais ao vivo; validação acontece no stg

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Árvore de um salto (profundidade máx. 2) em vez de profundidade arbitrária | Leque 3 cobre 12 espectadores, leque 4 cobre 20 — muito além do alvo de 10. Órfão em cascata, ciclo e latência acumulada são proporcionais à profundidade e somem quase todos ao travá-la em 2 | — Pending |
| Uma só mecânica, sem "modo árvore" que liga | `if (espectadores > 5) ligarArvore()` cria caminho que só roda no caso raro — e caminho que só roda no caso raro está sempre quebrado quando finalmente roda. Com K configurável, a árvore inteira é exercitada com 3 pessoas | — Pending |
| Servidor é dono da topologia; filho nunca escolhe pai | Filho escolhendo pai produz ciclo, e ciclo em árvore de mídia é um pedaço da sala em preto sem mensagem de erro | — Pending |
| Escolha de pai isolada em função pura, boba na v1 | Sem estado e sem protocolo, dá para testar árvore de 10 pessoas sem subir uma conexão, e trocar boba por ponderada não é migração | — Pending |
| Relay permanece como camada de baixo, sempre | É o relay que torna a árvore sobrevivível: órfão volta em menos de um segundo enquanto o servidor rearranja. Não são alternativas, são camadas | — Pending |
| Troca de pai pode piscar | Usuário aceitou travadinha ou loading; libera re-paternização agressiva e evita complexidade de transição sem costura | — Pending |
| Papel de repassador invisível para quem assiste | Decisão do usuário: acontece nos bastidores como em qualquer P2P | — Pending |
| TURN só instrumentado, não implantado | TURN reencaminha mídia pelo servidor — é a mesma banda do relay com outro protocolo, e o relay já cobre esses casos. Medir quantos pares não fecham antes de gastar | — Pending |
| Capacidade medida, nunca chutada | Leque chutado é o que faz a árvore ficar pior que o relay: um pai que aceita 3 filhos com subida para 1 arrasta os três junto | — Pending |
| Histerese na re-paternização | Mesma lição do backpressure do encoder: limiar seco em cima do limite produz oscilação, e oscilação se vê como tranco. Só troca quando o ganho for claramente maior que o custo | — Pending |
| Bugs de UI entram cedo, em fase própria | São independentes da topologia e a engrenagem de qualidade é necessária para testar o leque medido — sem variar bitrate não dá para ver a capacidade reagir | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-08-20 after initialization*
