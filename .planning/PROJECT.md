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
- [ ] **R2** — Leque derivado de capacidade medida, não de constante chutada;
      mede **subida e CPU**, cresce devagar, encolhe rápido ao primeiro relatório
      de perda. `availableOutgoingBitrate`/`qualityLimitationReason` só existem no
      Chromium — o site precisa de caminho alternativo por `bytesSent` + perda
- [ ] **R3** — Repasse de faixa: um espectador aceita filhos e repassa a faixa
      recebida. **Custa decodificar + recodificar** — não existe passagem crua no
      navegador (ver `.planning/research/STACK.md`)
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
- **Promoção de produção (`origin`/`locutor`)** — o usuário decide quando promover; fora deste roadmap. **Mas registre-se o tamanho do que está parado:** produção (`92ba4f7`) já tem a correção de nível H.264 e já tem a estrela WebRTC — o que ela **não** tem é o `construtorPeer`. Sem ele, `window.RTCPeerConnection` é `null` dentro da Activity e **nenhum espectador que assiste pelo Discord fecha conexão direta**: todos caem no relay, pagando banda cheia. Também falta o corte de banda com zero espectadores. São 527 linhas já escritas e testadas nesta branch. Nenhuma fase deste roadmap entrega tanta economia de banda quanto promover isso
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

**Peça que decide tudo — corrigida pela pesquisa.** Assumimos, ao desenhar, que
um espectador repassaria a faixa recebida via `addTrack` sem decodificar nem
recodificar. **Isso está errado.** O navegador não expõe caminho de passagem: a
faixa remota chega decodificada, e colocá-la numa segunda `RTCPeerConnection`
instancia um encoder novo. É exatamente por isso que SFU existe como categoria
separada de arquitetura. Confirmado por dois agentes independentes, com fonte
primária no exemplo oficial `multiple-relay` do `webrtc/samples` do Google.

Consequências, e nenhuma delas mata a árvore:

- **O objetivo de banda sobrevive intacto.** A subida do transmissor continua
  aliviada; o repassador assume o custo de rede como planejado.
- **Surge um segundo recurso escasso: CPU do repassador.** Decodificar 1080p e
  recodificar 1080p na máquina de quem assiste. Com encoder de hardware é
  viável; em software a 1080p é o mesmo buraco que o `nivelH264` consertou.
- **Há perda de geração.** O neto vê pior que o filho.
- **Em compensação, o problema mais difícil da lista some.** Como o repassador
  tem encoder de verdade, o PLI padrão do WebRTC responde sozinho ao neto que
  entra no meio da transmissão. Keyframe automático, custo zero de protocolo. O
  pedido pelo WebSocket e o keyframe periódico de 3 s viram rede de segurança em
  vez de mecanismo principal. Ressalva: existe issue conhecida no libwebrtc sobre
  encoders H.264 nem sempre honrarem PLI com presteza
  (`issues.webrtc.org/issues/42220637`) — vira teste, não suposição.

A pergunta do spike deixa de ser "é possível?" e passa a ser **"quanto custa um
salto de recodificação?"** — CPU, latência e qualidade, em máquina de espectador
comum. Se o custo for alto, a árvore muda de forma (repassar em resolução menor,
ou só promover quem tem encoder de hardware), mas não deixa de existir.

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
| Capacidade cresce devagar, encolhe rápido | A estimativa de banda do Chrome roda independente por `RTCPeerConnection` e não soma entre filhos; além disso um fluxo novo sobe de ~15% para 100% do alvo ao longo de ~30 s. Ler capacidade logo após um filho conectar e admitir outro é o modo de falha clássico | — Pending |
| Exposição de IP entre espectadores é consequência aceita da árvore | Na estrela só quem transmite via o IP de quem assiste; na árvore o repassador vê o dos filhos. mDNS não cobre (só esconde candidatos de rede local) e o proxy da Activity não cobre (só HTTP, não ICE/UDP). **Decisão do usuário ainda pendente** | — Pending |
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
*Last updated: 2026-08-20 after project research (repasse recodifica — R3 corrigido)*
