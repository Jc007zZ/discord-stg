# Requirements: Sala de Tela — distribuição P2P em árvore

**Defined:** 2026-08-20
**Core Value:** Uma sala de 10 pessoas assistindo à mesma tela sem estourar a banda do servidor nem a subida de quem transmite — e sem que ninguém fique na tela preta.

## v1 Requirements

Requisitos desta entrega. Cada um mapeia para uma fase do roadmap.

### Prova de viabilidade

O único bloco que pode reformar todos os outros. Roda antes e sozinho.

- [ ] **SPIKE-01**: Uma faixa recebida atravessa um segundo `addTrack` e chega ao neto com imagem, medido em máquina de espectador comum e não em máquina de desenvolvimento
- [ ] **SPIKE-02**: O custo de CPU de um salto de decodificar+recodificar 1080p30 H.264 está medido em porcentagem de núcleo, com e sem encoder de hardware
- [ ] **SPIKE-03**: A latência adicionada por um salto está medida em milissegundos, separando RTT do enlace do buffer de jitter
- [ ] **SPIKE-04**: A perda de qualidade de uma geração de recodificação está registrada de forma comparável (mesma cena, mesmo bitrate, filho contra neto)
- [ ] **SPIKE-05**: O tempo de tela preta de um neto que entra no meio da transmissão está medido, e o PLI do encoder H.264 está confirmado como responsivo (ver `issues.webrtc.org/issues/42220637`)
- [ ] **SPIKE-06**: O teto de latência aceitável para o neto está **decidido**, com o número do SPIKE-03 na mão — a constraint em PROJECT.md que hoje está em aberto

### Interface

Independentes da topologia. Rodam em paralelo com a prova.

- [ ] **UI-01**: Quem transmite pelo site escolhe bitrate e fps antes de compartilhar, por uma seta ao lado do ícone de tela
- [ ] **UI-02**: A escolha de bitrate e fps persiste entre sessões e é aplicada à próxima transmissão
- [ ] **UI-03**: Passar o mouse no ícone de pessoa da lateral mostra quem está na sala, com o mesmo comportamento do ícone da barra de cima

### Plano de controle

Dívida conhecida que a re-paternização transforma em peça de carga. Precede a árvore.

- [ ] **CTRL-01**: Uma rajada de mudanças de espectador não produz um broadcast de estado por mudança para a sala inteira
- [ ] **CTRL-02**: `P2P_ONLY` deixa de desligar o relay para todos silenciosamente; quem entra num modo sem relay sabe disso, e o modo se anuncia no log de inicialização e em `/api/health`
- [ ] **CTRL-03**: Um espectador cuja conexão direta nunca fecha não fica em "Conectando…" indefinidamente — ou o relay assume, ou ele é informado

### Topologia

- [ ] **TOPO-01**: O servidor mantém a árvore da sala: para cada espectador, quem é o pai, quais os filhos, qual o papel e qual a capacidade
- [ ] **TOPO-02**: A profundidade de um nó é sempre derivada da árvore, nunca aceita como entrada de cliente
- [ ] **TOPO-03**: Só existe um caminho de escrita na árvore (`atribuirPai`), e é no servidor
- [ ] **TOPO-04**: Um espectador nunca escolhe o próprio pai
- [ ] **TOPO-05**: A consulta de candidatos a pai é incapaz, por construção, de devolver um nó que já está na profundidade máxima — não há verificação de profundidade a esquecer
- [ ] **TOPO-06**: `escolherPai(candidatos, novoEspectador)` é função pura, sem estado e sem rede, e uma árvore de 10 nós é testável sem abrir um socket
- [ ] **TOPO-07**: Nenhum transmissor abre mais conexões diretas que o teto configurado; quem não couber assiste pelo relay
- [ ] **TOPO-08**: O teto de leque é configurável, e ajustá-lo para 1 faz uma sala de 3 pessoas exercitar repasse, adoção de órfão e transbordo

### Repasse

- [ ] **FWD-01**: Um espectador designado repassador aceita filhos e entrega a eles a tela que está recebendo
- [ ] **FWD-02**: Toda `RTCPeerConnection` criada no caminho de repasse passa pela cascata de escape (`construtorPeer`), e isso é verificado dentro da Activity real, não só em aba de navegador
- [ ] **FWD-03**: O repassador limita a própria saída ao que a capacidade medida do filho suporta, por `setParameters`
- [ ] **FWD-04**: Um neto que entra no meio da transmissão recebe imagem sem depender de pedido de keyframe atravessando a árvore

### Sinalização

- [ ] **SIG-01**: A sinalização roteia por peerId entre quaisquer dois nós, e não assume que quem oferece é sempre a origem
- [ ] **SIG-02**: O servidor diz a um nó qual é o papel dele e quantos filhos pode aceitar
- [ ] **SIG-03**: O servidor diz a um filho de quem esperar oferta; o filho nunca disca
- [ ] **SIG-04**: Um pai pode recusar uma atribuição, e o servidor reatribui na hora em vez de deixar o filho esperando oferta que não vem
- [ ] **SIG-05**: Sair da sala, cair a conexão e trocar de pai são eventos distinguíveis no protocolo, não o mesmo evento genérico

### Sobrevivência

- [ ] **SURV-01**: Quando um repassador some, o relay volta para todos os filhos dele no mesmo tick, **antes** de qualquer substituto ser escolhido
- [ ] **SURV-02**: Um órfão recebe imagem de novo em menos de um segundo
- [ ] **SURV-03**: O relay só é desligado para um espectador como confirmação de que o caminho direto já está entregando quadro — nunca como aposta de que vai entregar
- [ ] **SURV-04**: Vários órfãos do mesmo pai não são reatribuídos no mesmo instante, e não convergem todos para o mesmo substituto
- [ ] **SURV-05**: Uma troca de pai custa no máximo uma travadinha ou um loading curto, e nunca deixa a tela preta sem explicação

### Medição

- [ ] **MED-01**: A capacidade de um repassador é medida, e cobre **subida e CPU** — não só rede
- [ ] **MED-02**: A capacidade medida funciona também fora do Chromium, por vazão calculada e perda relatada, com teto mais conservador nesse caso
- [ ] **MED-03**: A capacidade cresce devagar e encolhe rápido: um repassador só fica elegível a mais um filho depois de uma janela de carência, e qualquer relato de perda de um filho zera a folga anunciada na hora
- [ ] **MED-04**: Um filho mede RTT e perda depois de conectar e relata ao servidor
- [ ] **MED-05**: `escolherPai` pondera proximidade e qualidade de conexão, com cortes duros antes da nota
- [ ] **MED-06**: Uma re-paternização só acontece quando o ganho é claramente maior que o custo da troca; o sistema não fica remexendo a árvore sozinho
- [ ] **MED-07**: Espectador em conexão de celular ou com economia de dados declarada não é promovido a repassador onde o sinal existir, e a ausência do sinal não vira promoção cega

### Instrumentação

- [ ] **INST-01**: Dá para saber quantos GB por hora o servidor gasta com uma transmissão
- [ ] **INST-02**: Dá para saber que fração dos espectadores está em conexão direta e que fração está no relay
- [ ] **INST-03**: Dá para saber a subida máxima exigida de quem transmite
- [ ] **INST-04**: Dá para saber quantos pares não fecham conexão direta e quanto de banda de relay esses casos custam
- [ ] **INST-05**: O painel admin mostra a árvore de uma sala: quem é pai de quem, capacidade, RTT e o motivo da última troca

### Transparência

- [ ] **TRANSP-01**: Está registrado, em texto que a pessoa consegue encontrar, que a distribuição é entre pares e que isso expõe o endereço de rede a outros participantes da sala

## v2 Requirements

Reconhecidos, adiados, fora deste roadmap.

### Topologia

- **TOPO-V2-01**: Profundidade maior que 2, para salas acima de 20 espectadores
- **TOPO-V2-02**: Troca de pai sem interrupção visível

### Medição

- **MED-V2-01**: Escolha de pai por RTT sondado antes de conectar, em vez de estimado por ASN e faixa

### Rede

- **NET-V2-01**: TURN em produção, se a instrumentação do INST-04 mostrar que o custo de quem não fecha supera o custo de operar TURN

## Out of Scope

| Feature | Reason |
|---------|--------|
| SFU | Mesmo custo de banda de servidor que o relay atual. Não resolve o problema que motivou o trabalho |
| TURN implantado | Reencaminha a mídia pelo servidor — é a banda do relay com outro protocolo, e o relay já cobre esses casos. Fica só a medição (INST-04) |
| Árvore de profundidade arbitrária | Órfão em cascata, ciclo, latência acumulada e depuração ilegível são todos proporcionais à profundidade. Leque 3 com profundidade 2 já cobre 12 espectadores; leque 4 cobre 20 |
| Troca de pai sem costura | Travadinha ou loading foi explicitamente aceito. Transição invisível não vale o custo |
| UI de "você está repassando" | Papel de repassador decidido invisível |
| Opt-out de virar repassador | Mesma decisão. A transparência é atendida por texto (TRANSP-01), não por controle |
| `RTCRtpScriptTransform` como primitivo de repasse | Roda depois do encoder; não substitui o encoder. A técnica de faixa-portadora com substituição de bytes existe mas é comportamento não especificado, frágil entre versões do Chromium, e contraria a restrição de não adicionar dependência de mídia |
| `p2p-media-loader` e similares | Assumem segmentos HLS/DASH. Este projeto entrega chunks contínuos de WebCodecs; adotar exigiria refazer o pipeline inteiro |
| Evitar o alerta de firewall do Windows | Pesquisado: não existe P2P real sem socket UDP, e toda alternativa devolve o custo ao servidor. O alerta é do `discord.exe` e reaparece a cada update dele pelo caminho versionado |
| Promoção de produção (`origin`/`locutor`) | O usuário decide quando promover, fora deste roadmap |
| Reescrever o `<video>` fora do DOM | Mapeado como risco BAIXO; funciona porque `srcObject` é setado antes do listener |

## Traceability

Cada requisito v1 mapeia para exatamente uma fase. Sem órfão, sem duplicata.

| Requirement | Phase | Status |
|-------------|-------|--------|
| SPIKE-01 | Phase 1 — Spike de repasse | Pending |
| SPIKE-02 | Phase 1 — Spike de repasse | Pending |
| SPIKE-03 | Phase 1 — Spike de repasse | Pending |
| SPIKE-04 | Phase 1 — Spike de repasse | Pending |
| SPIKE-05 | Phase 1 — Spike de repasse | Pending |
| SPIKE-06 | Phase 1 — Spike de repasse | Pending |
| UI-01 | Phase 2 — Consertos de interface | Pending |
| UI-02 | Phase 2 — Consertos de interface | Pending |
| UI-03 | Phase 2 — Consertos de interface | Pending |
| CTRL-01 | Phase 3 — Higiene do plano de controle | Pending |
| CTRL-02 | Phase 3 — Higiene do plano de controle | Pending |
| CTRL-03 | Phase 3 — Higiene do plano de controle | Pending |
| TOPO-01 | Phase 4 — Estado da árvore no servidor | Pending |
| TOPO-02 | Phase 4 — Estado da árvore no servidor | Pending |
| TOPO-03 | Phase 4 — Estado da árvore no servidor | Pending |
| TOPO-04 | Phase 4 — Estado da árvore no servidor | Pending |
| TOPO-05 | Phase 4 — Estado da árvore no servidor | Pending |
| TOPO-06 | Phase 5 — Seleção de pai e teto de leque | Pending |
| TOPO-07 | Phase 5 — Seleção de pai e teto de leque | Pending |
| TOPO-08 | Phase 5 — Seleção de pai e teto de leque | Pending |
| SIG-01 | Phase 6 — Protocolo de controle e roteamento por peerId | Pending |
| SIG-02 | Phase 6 — Protocolo de controle e roteamento por peerId | Pending |
| SIG-03 | Phase 6 — Protocolo de controle e roteamento por peerId | Pending |
| SIG-04 | Phase 6 — Protocolo de controle e roteamento por peerId | Pending |
| SIG-05 | Phase 6 — Protocolo de controle e roteamento por peerId | Pending |
| FWD-01 | Phase 7 — Runtime do repassador | Pending |
| FWD-02 | Phase 7 — Runtime do repassador | Pending |
| FWD-03 | Phase 7 — Runtime do repassador | Pending |
| FWD-04 | Phase 7 — Runtime do repassador | Pending |
| SURV-01 | Phase 8 — Sobrevivência | Pending |
| SURV-02 | Phase 8 — Sobrevivência | Pending |
| SURV-03 | Phase 8 — Sobrevivência | Pending |
| SURV-04 | Phase 8 — Sobrevivência | Pending |
| SURV-05 | Phase 8 — Sobrevivência | Pending |
| MED-01 | Phase 9 — Capacidade medida do repassador | Pending |
| MED-02 | Phase 9 — Capacidade medida do repassador | Pending |
| MED-03 | Phase 9 — Capacidade medida do repassador | Pending |
| MED-07 | Phase 9 — Capacidade medida do repassador | Pending |
| MED-04 | Phase 10 — Escolha ponderada e histerese | Pending |
| MED-05 | Phase 10 — Escolha ponderada e histerese | Pending |
| MED-06 | Phase 10 — Escolha ponderada e histerese | Pending |
| INST-01 | Phase 11 — Instrumentação de banda e TURN | Pending |
| INST-02 | Phase 11 — Instrumentação de banda e TURN | Pending |
| INST-03 | Phase 11 — Instrumentação de banda e TURN | Pending |
| INST-04 | Phase 11 — Instrumentação de banda e TURN | Pending |
| INST-05 | Phase 12 — Visibilidade da árvore e transparência | Pending |
| TRANSP-01 | Phase 12 — Visibilidade da árvore e transparência | Pending |

**Coverage:**
- v1 requirements: 47 total
- Mapped to phases: 47
- Unmapped: 0

> Correção de contagem: este documento declarava 46 requisitos v1 na inicialização.
> A contagem por ID devolve 47 (SPIKE 6 + UI 3 + CTRL 3 + TOPO 8 + FWD 4 + SIG 5 +
> SURV 5 + MED 7 + INST 5 + TRANSP 1). Nenhum requisito foi adicionado nem removido —
> só o total estava errado.

## Definition of Done

O milestone fecha quando as quatro medidas escolhidas pelo usuário respondem:

1. **GB/hora de servidor por transmissão** cai de forma mensurável contra a linha de base de hoje (~11 GB/h com 10 espectadores)
2. **Fração de espectadores em conexão direta** é conhecida e não é zero
3. **Uma sala de 10 pessoas funciona** sem ninguém travando, verificado com gente de verdade
4. **A subida exigida de quem transmite tem teto**, e o teto é respeitado

---
*Requirements defined: 2026-08-20*
*Last updated: 2026-08-20 after roadmap creation (47/47 mapeados em 12 fases)*
