# Roadmap: Sala de Tela — distribuição P2P em árvore

## Overview

A jornada sai da estrela e chega a uma árvore de um salto, sem nunca tirar o relay
de baixo. Começa por uma prova de custo, sozinha, porque o número que ela devolve
dimensiona tudo que vem depois: se um salto de decodificar+recodificar for caro, a
árvore muda de forma. Em paralelo à prova rodam dois consertos de interface que não
tocam topologia — e a engrenagem de qualidade que eles entregam é o que permite
provocar a capacidade medida mais adiante. Depois vem higiene do plano de controle,
porque `broadcastState()` e `P2P_ONLY` são dívidas conhecidas que a re-paternização
transforma em peça de carga. Só então a árvore: primeiro dado puro e função pura no
servidor, testáveis com dez nós sem abrir um socket; depois o protocolo na rede;
depois mídia atravessando o salto; depois sobrevivência — órfão, relay,
re-paternização. Otimização vem por último, e nessa ordem por propósito: uma árvore
que re-paterniza bem e escolhe mal é apenas subótima; uma que escolhe bem e abandona
órfão está quebrada. Fecha com os números que definem o milestone e com a árvore
visível para quem opera.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: Spike de repasse** - Quanto custa um salto de decodificar+recodificar, medido em máquina de espectador comum
- [ ] **Phase 2: Consertos de interface** - Engrenagem de bitrate/fps no site e lista de quem está na sala de volta na lateral
- [ ] **Phase 3: Higiene do plano de controle** - Rajada de estado deixa de inundar a sala e `P2P_ONLY` para de desligar o relay em silêncio
- [ ] **Phase 4: Estado da árvore no servidor** - O servidor é dono da árvore e é o único que escreve nela
- [ ] **Phase 5: Seleção de pai e teto de leque** - Função pura escolhe o pai e nenhum transmissor passa do teto configurado
- [ ] **Phase 6: Protocolo de controle e roteamento por peerId** - Sinalização liga quaisquer dois nós, com papel e pai ditados pelo servidor
- [ ] **Phase 7: Runtime do repassador** - Mídia atravessa de verdade um salto de repasse
- [ ] **Phase 8: Sobrevivência — órfão, relay e re-paternização** - Ninguém fica na tela preta quando um repassador some
- [ ] **Phase 9: Capacidade medida do repassador** - Leque derivado de subida e CPU medidas, que crescem devagar e encolhem rápido
- [ ] **Phase 10: Escolha ponderada e re-paternização com histerese** - A árvore melhora sozinha com medição, sem ficar remexendo
- [ ] **Phase 11: Instrumentação de banda e TURN** - As medidas que fecham o milestone existem em número
- [ ] **Phase 12: Visibilidade da árvore e transparência** - Uma falha de árvore é legível para quem opera, e a exposição de IP está registrada

## Phase Details

### Phase 1: Spike de repasse
**Goal**: Saber, com número medido em máquina de espectador comum, quanto custa um salto de repasse — e decidir com esse número na mão o teto de latência que hoje está em aberto em PROJECT.md
**Depends on**: Nothing (primeira fase, roda sozinha)
**Requirements**: SPIKE-01, SPIKE-02, SPIKE-03, SPIKE-04, SPIKE-05, SPIKE-06
**Success Criteria** (what must be TRUE):
  1. Uma faixa recebida atravessa um segundo `addTrack` e o neto vê imagem, verificado em máquina de espectador comum e não em máquina de desenvolvimento
  2. Existe número registrado para o custo de um salto a 1080p30 H.264: CPU em porcentagem de núcleo (com e sem encoder de hardware), latência adicionada em milissegundos (RTT do enlace separado do buffer de jitter) e perda de qualidade de uma geração comparada na mesma cena e no mesmo bitrate
  3. O tempo de tela preta de um neto que entra no meio da transmissão está medido, e a responsividade do PLI no encoder H.264 virou teste em vez de suposição (`issues.webrtc.org/issues/42220637`)
  4. O teto de latência aceitável para o neto está escrito em PROJECT.md como número decidido, não como pergunta em aberto
  5. A contingência está registrada antes de qualquer fase de topologia começar: se o custo medido inviabilizar repasse em software, só espectador com encoder de hardware é promovido, e as fases 7 a 10 refletem essa escolha
**Plans**: TBD

### Phase 2: Consertos de interface
**Goal**: Quem transmite pelo site controla bitrate e fps antes de compartilhar, e a lista de quem está na sala volta ao ícone da lateral
**Depends on**: Nothing — não toca topologia, roda em paralelo com a Phase 1
**Requirements**: UI-01, UI-02, UI-03
**Success Criteria** (what must be TRUE):
  1. Uma seta ao lado do ícone de tela abre bitrate e fps antes de compartilhar, e a transmissão sai com os valores escolhidos
  2. Fechar e reabrir o site mantém a última escolha de bitrate e fps, e a próxima transmissão já sai com ela
  3. Passar o mouse no ícone de pessoa da lateral mostra quem está na sala, com o mesmo comportamento do ícone da barra de cima
  4. Dá para variar o bitrate à mão durante uma transmissão de teste — é isso que permite provocar a capacidade medida a reagir nas fases 9 e 10
**Plans**: TBD
**UI hint**: yes

### Phase 3: Higiene do plano de controle
**Goal**: O plano de controle aguenta rajada de mudança de espectador, e nenhum modo desliga o relay sem que ninguém saiba
**Depends on**: Phase 1
**Requirements**: CTRL-01, CTRL-02, CTRL-03
**Success Criteria** (what must be TRUE):
  1. Uma rajada de entradas e saídas de espectador produz um número limitado de broadcasts de estado para a sala, não um por mudança
  2. `P2P_ONLY` se anuncia no log de inicialização e em `/api/health`, e quem entra numa sala sem relay sabe que está nela
  3. Um espectador cuja conexão direta nunca fecha sai de "Conectando…" dentro de um tempo limitado: ou o relay assume, ou ele é informado
  4. O sintoma já diagnosticado no stg — "estou vendo a tela e mais ninguém consegue conectar" com `P2P_ONLY` ligado — não se reproduz mais
**Plans**: TBD

### Phase 4: Estado da árvore no servidor
**Goal**: O servidor é dono da árvore da sala e é o único ponto do código que escreve nela
**Depends on**: Phase 3
**Requirements**: TOPO-01, TOPO-02, TOPO-03, TOPO-04, TOPO-05
**Success Criteria** (what must be TRUE):
  1. Para cada espectador de uma sala dá para ler no servidor quem é o pai, quais são os filhos, qual é o papel e qual é a capacidade
  2. A profundidade de um nó é sempre derivada da árvore; profundidade declarada por cliente é ignorada
  3. Existe um único caminho de escrita na árvore, `atribuirPai`, e ele é no servidor — nenhum outro ponto do código muta a topologia
  4. Um espectador não consegue escolher o próprio pai, nem por mensagem forjada
  5. A consulta de candidatos a pai é incapaz por construção de devolver um nó em profundidade máxima — não existe verificação de profundidade em ponto de chamada que alguém possa esquecer
**Plans**: TBD

### Phase 5: Seleção de pai e teto de leque
**Goal**: A árvore de uma sala de dez pessoas é decidida por uma função pura testável, e nenhum transmissor passa do teto de leque configurado
**Depends on**: Phase 4
**Requirements**: TOPO-06, TOPO-07, TOPO-08
**Success Criteria** (what must be TRUE):
  1. `escolherPai(candidatos, novoEspectador)` é função pura, sem estado e sem rede: uma árvore de 10 nós é montada e verificada em teste sem abrir um socket
  2. Nenhum transmissor abre mais conexões diretas que o teto configurado, e quem não couber assiste pelo relay em vez de degradar a sala inteira
  3. Ajustar o teto para 1 faz uma sala de 3 pessoas exercitar repasse, adoção de órfão e transbordo
  4. Não existe "modo árvore" que liga a partir de um número de espectadores: a mesma mecânica roda com 2 e com 10
**Plans**: TBD

### Phase 6: Protocolo de controle e roteamento por peerId
**Goal**: A sinalização liga quaisquer dois nós da sala, com o servidor ditando papel, pai e limite — verificado dentro do iframe da Activity real no stg
**Depends on**: Phase 5
**Requirements**: SIG-01, SIG-02, SIG-03, SIG-04, SIG-05
**Success Criteria** (what must be TRUE):
  1. Uma oferta roteia por peerId entre dois espectadores, e o protocolo não assume que quem oferece é sempre a origem
  2. O servidor diz a cada nó qual é o papel dele e quantos filhos pode aceitar
  3. Um filho sabe de quem esperar a oferta e nunca disca sozinho
  4. Um pai pode recusar uma atribuição e o servidor reatribui na hora, em vez de deixar o filho esperando oferta que não vem
  5. Sair da sala, cair a conexão e trocar de pai chegam como eventos distinguíveis no protocolo, não como o mesmo evento genérico
**Plans**: TBD

### Phase 7: Runtime do repassador
**Goal**: Mídia atravessa de verdade um salto de repasse: um espectador entrega aos próprios filhos a tela que está recebendo
**Depends on**: Phase 6
**Requirements**: FWD-01, FWD-02, FWD-03, FWD-04
**Success Criteria** (what must be TRUE):
  1. Um espectador designado repassador aceita filhos, e eles veem a tela que ele está recebendo
  2. Toda `RTCPeerConnection` criada no caminho de repasse passa pela cascata de escape `construtorPeer`, verificado dentro da Activity real no stg e não só em aba de navegador
  3. O repassador limita a própria saída por `setParameters` ao que a capacidade medida do filho suporta, em vez de mandar o bitrate cheio
  4. Um neto que entra no meio da transmissão recebe imagem sem depender de pedido de keyframe atravessando a árvore
  5. Existe cobertura de teste para o comportamento de fan-out do WebRTC — que hoje é zero — e o piso de 86% do CI continua de pé sem baixar limiar
**Plans**: TBD

### Phase 8: Sobrevivência — órfão, relay e re-paternização
**Goal**: Ninguém fica na tela preta quando um repassador some: o relay volta antes de qualquer substituto ser escolhido
**Depends on**: Phase 7
**Requirements**: SURV-01, SURV-02, SURV-03, SURV-04, SURV-05
**Success Criteria** (what must be TRUE):
  1. Quando um repassador some, o relay volta para todos os filhos dele no mesmo tick, antes de qualquer substituto ser escolhido
  2. Um órfão volta a receber imagem em menos de um segundo
  3. O relay só é desligado para um espectador como confirmação de que o caminho direto já está entregando quadro, nunca como aposta de que vai entregar
  4. Vários órfãos do mesmo pai não são reatribuídos no mesmo instante e não convergem todos para o mesmo substituto
  5. Uma troca de pai custa no máximo uma travadinha ou um loading curto, e nunca deixa a tela preta sem explicação
**Plans**: TBD

### Phase 9: Capacidade medida do repassador
**Goal**: O leque de um repassador vem de capacidade medida — subida e CPU — que cresce devagar e encolhe rápido, nunca de constante chutada
**Depends on**: Phase 8
**Requirements**: MED-01, MED-02, MED-03, MED-07
**Success Criteria** (what must be TRUE):
  1. A capacidade de um repassador é medida e cobre subida e CPU, não só rede
  2. Fora do Chromium a capacidade sai de vazão calculada e perda relatada, com teto mais conservador nesse caso — o site não fica sem caminho
  3. Um repassador só fica elegível a mais um filho depois de uma janela de carência, e qualquer relato de perda de um filho zera a folga anunciada na hora
  4. Espectador em conexão de celular ou com economia de dados declarada não é promovido a repassador onde o sinal existir, e a ausência do sinal não vira promoção cega
**Plans**: TBD

### Phase 10: Escolha ponderada e re-paternização com histerese
**Goal**: A árvore melhora sozinha com medição de verdade, e fica parada quando não há ganho que compense a troca
**Depends on**: Phase 9
**Requirements**: MED-04, MED-05, MED-06
**Success Criteria** (what must be TRUE):
  1. Um filho mede RTT e perda depois de conectar e relata ao servidor
  2. `escolherPai` aplica os cortes duros — capacidade, celular, profundidade — antes de qualquer nota, e a nota pondera ASN, faixa de RTT, folga, tempo de sala e RTT real medido
  3. Uma re-paternização só acontece quando o ganho é claramente maior que o custo da troca; o sistema não fica remexendo a árvore sozinho
  4. Os limiares de histerese e a janela de carência escolhidos estão registrados junto com a evidência que os justificou, e não herdados como número folclórico
**Plans**: TBD

### Phase 11: Instrumentação de banda e TURN
**Goal**: As medidas que fecham o milestone existem em número consultável, não em impressão
**Depends on**: Phase 10
**Requirements**: INST-01, INST-02, INST-03, INST-04
**Success Criteria** (what must be TRUE):
  1. Dá para saber quantos GB por hora o servidor gasta com uma transmissão, comparável com a linha de base de hoje (~11 GB/h com 10 espectadores)
  2. Dá para saber que fração dos espectadores está em conexão direta e que fração está no relay
  3. Dá para saber a subida máxima exigida de quem transmite, e conferir que o teto de leque é respeitado
  4. Dá para saber quantos pares não fecham conexão direta e quanta banda de relay esses casos custam, fatiado por profundidade — medido, sem implantar TURN
**Plans**: TBD

### Phase 12: Visibilidade da árvore e transparência
**Goal**: Uma falha de árvore é legível para quem opera, e a exposição de endereço de rede entre espectadores está registrada onde a pessoa consegue encontrar
**Depends on**: Phase 11
**Requirements**: INST-05, TRANSP-01
**Success Criteria** (what must be TRUE):
  1. O painel admin mostra a árvore de uma sala: quem é pai de quem, capacidade, RTT e o motivo da última troca
  2. Diante de um relato de "travou", dá para abrir o painel e ver a forma da árvore naquele momento, sem ler log cru
  3. Está registrado, em texto que a pessoa consegue encontrar, que a distribuição é entre pares e que isso expõe o endereço de rede a outros participantes da sala
**Plans**: TBD
**UI hint**: yes

## Notas de execução

- **A prova roda primeiro e sozinha.** A Phase 1 pode reformar as fases 7 a 10 e
  não deve ser paralelizada contra trabalho que ela é capaz de invalidar. A única
  fase que pode rodar junto é a Phase 2, que não toca topologia.
- **Profundidade travada em 2.** Um salto de repasse. Nenhuma fase propõe mais.
- **O relay é camada permanente**, nunca removida e nunca condicional.
- **Sobrevivência antes de otimização.** A Phase 8 (órfão e convivência com o relay)
  precede as fases 9 e 10 (capacidade ponderada e histerese) por decisão, não por
  conveniência.
- **Nenhuma fase promove para produção.** `stg` tem push liberado; `origin` e
  `locutor` servem produção e exigem pedido explícito a cada vez. Toda validação em
  ambiente implantado acontece no stg.
- **Cobertura.** O piso de 86% do CI é piso, não meta. As fases 4 a 8 mexem em
  topologia e precisam construir o arcabouço de teste de fan-out do WebRTC, que hoje
  não existe.

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12
(A Phase 2 pode rodar em paralelo com a Phase 1.)

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Spike de repasse | 0/TBD | Not started | - |
| 2. Consertos de interface | 0/TBD | Not started | - |
| 3. Higiene do plano de controle | 0/TBD | Not started | - |
| 4. Estado da árvore no servidor | 0/TBD | Not started | - |
| 5. Seleção de pai e teto de leque | 0/TBD | Not started | - |
| 6. Protocolo de controle e roteamento por peerId | 0/TBD | Not started | - |
| 7. Runtime do repassador | 0/TBD | Not started | - |
| 8. Sobrevivência — órfão, relay e re-paternização | 0/TBD | Not started | - |
| 9. Capacidade medida do repassador | 0/TBD | Not started | - |
| 10. Escolha ponderada e re-paternização com histerese | 0/TBD | Not started | - |
| 11. Instrumentação de banda e TURN | 0/TBD | Not started | - |
| 12. Visibilidade da árvore e transparência | 0/TBD | Not started | - |
