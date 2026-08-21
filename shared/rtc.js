/**
 * Camada WebRTC: o vídeo sai do transmissor direto para quem assiste.
 *
 * O relay por WebSocket continua existindo e continua sendo o caminho padrão —
 * este módulo é o atalho. A diferença que importa não é "P2P é mais curto": é
 * que o WebSocket anda sobre TCP, e TCP não tem como descartar um quadro
 * atrasado. Quando a rede aperta, o socket enfileira; a imagem não fica pior,
 * ela fica no passado, e o que se vê é a transmissão andando aos saltos. O
 * WebRTC roda sobre SRTP/UDP, abaixa o bitrate sozinho quando detecta perda e
 * repõe pacote perdido com NACK — degrada a qualidade em vez do tempo.
 *
 * Nada aqui é obrigatório. Se a negociação não fechar (NAT simétrico sem TURN,
 * sandbox que bloqueia, rede corporativa), quem assiste simplesmente continua
 * no relay. É por isso que o WebCodecs não foi removido: ele é o piso.
 */

// STUN público do Google como piso: descobre o endereço externo e resolve a
// maioria dos NATs domésticos. Não cobre NAT simétrico — para esses só TURN
// resolve, e é o servidor quem diz se existe um (veja `/api/ice`).
const ICE_PADRAO = [{ urls: 'stun:stun.l.google.com:19302' }];

let icePromise = null;

/**
 * Servidores ICE, buscados uma vez e reaproveitados.
 *
 * Vem do servidor porque credencial de TURN é temporária e não pode ser
 * embutida no bundle. Falha de rede aqui não é motivo para desistir do WebRTC:
 * cai no STUN público, que já atende quem está atrás de NAT comum.
 */
export function iceServers(base = '') {
  icePromise ??= fetch(`${base}/api/ice`)
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => (Array.isArray(j?.iceServers) && j.iceServers.length ? j.iceServers : ICE_PADRAO))
    .catch(() => ICE_PADRAO);
  return icePromise;
}

/**
 * Tempo máximo esperando a conexão fechar antes de desistir e ficar no relay.
 *
 * Oito segundos é folgado de propósito: em rede boa fecha em menos de um, e o
 * custo de esperar é zero — quem assiste já está vendo pelo relay o tempo
 * todo. Curto demais desistiria de conexões que só estavam lentas.
 */
export const PRAZO_CONEXAO_MS = 8000;

/** Estados dos quais não se volta: aqui a tentativa acabou. */
export const MORTO = new Set(['failed', 'closed', 'disconnected']);

/**
 * Existe RTCPeerConnection aqui?
 *
 * Exigir `typeof === 'function'` custou caro: dentro da atividade do Discord o
 * `typeof` responde `'object'`, e a checagem rejeitava um ambiente que talvez
 * suportasse tudo. Pior, a rejeicao virava a mensagem "sem WebRTC neste
 * navegador" — que dizia uma coisa e escondia outra.
 *
 * Agora a pergunta e so "esta ai". Se estiver e nao der para construir, quem
 * reporta e o `try` de quem construiu, com a mensagem de erro de verdade em
 * vez de um diagnostico chutado por esta funcao.
 */
// O iframe de socorro, quando preciso. Fica vivo pelo resto da sessao de
// proposito: objeto vindo de um quadro removido para de funcionar no Chromium,
// e o peer nasceria morto alguns segundos depois de criado.
let quadroDeSocorro = null;

function doQuadro() {
  if (typeof document === 'undefined') return null;
  try {
    if (!quadroDeSocorro?.isConnected) {
      quadroDeSocorro = document.createElement('iframe');
      quadroDeSocorro.setAttribute('aria-hidden', 'true');
      Object.assign(quadroDeSocorro.style, {
        position: 'fixed',
        width: '0',
        height: '0',
        border: '0',
        opacity: '0',
        pointerEvents: 'none',
      });
      document.body.append(quadroDeSocorro);
    }
    const Classe = quadroDeSocorro.contentWindow?.RTCPeerConnection;
    return typeof Classe === 'function' ? Classe : null;
  } catch {
    return null;
  }
}

/**
 * O RTCPeerConnection utilizavel deste ambiente, custe o que custar.
 *
 * Dentro da atividade do Discord o `RTCPeerConnection` do window vale `null` —
 * anulado de proposito. Mas anular uma propriedade nao remove a capacidade do
 * processo, e sobraram tres portas abertas, medidas no ambiente real:
 *
 *   1. `webkitRTCPeerConnection`, o alias antigo, continua sendo function
 *   2. a propriedade e configuravel e gravavel
 *   3. um iframe filho, de mesma origem, nasce com a API intacta
 *
 * A ordem aqui e por custo. O alias nao cria nada e nao tem ciclo de vida; o
 * iframe e a ultima parada, porque precisa ficar vivo enquanto durar a sessao.
 *
 * Fora da atividade a primeira linha resolve e nada disto acontece.
 */
export function construtorPeer() {
  if (typeof RTCPeerConnection === 'function') return RTCPeerConnection;
  if (typeof globalThis.webkitRTCPeerConnection === 'function') {
    return globalThis.webkitRTCPeerConnection;
  }
  return doQuadro();
}

/** Onde este ambiente achou a API, para o diagnostico saber dizer. */
export function origemDoPeer() {
  if (typeof RTCPeerConnection === 'function') return 'window';
  if (typeof globalThis.webkitRTCPeerConnection === 'function') return 'webkit';
  return doQuadro() ? 'iframe' : 'nenhuma';
}

export function suportaWebRTC() {
  return construtorPeer() !== null;
}

/**
 * Procura uma saida quando o RTCPeerConnection do window foi anulado.
 *
 * Dentro da atividade do Discord ele vale `null` — e `typeof null` e 'object',
 * o que ja custou horas de diagnostico errado aqui. Mas anular uma propriedade
 * do window nao e o mesmo que remover a capacidade do processo: um iframe
 * filho nasce com um window proprio, e se a anulacao foi feita so no objeto de
 * cima, a API pode estar intacta la dentro.
 *
 * Quatro tentativas, da mais barata para a menos provavel. Nenhuma altera
 * comportamento — isto so olha e conta o que viu.
 */
export function diagnosticoWebRTC() {
  const fora = {};

  fora.direto = typeof RTCPeerConnection;
  fora.nulo = typeof RTCPeerConnection === 'object' && RTCPeerConnection === null;

  // Alias antigo. Custa nada perguntar, e nem sempre quem remove um remove o outro.
  fora.webkit = typeof globalThis.webkitRTCPeerConnection;

  // Como a propriedade foi definida: se for gravavel ou configuravel, da para
  // devolve-la a partir de outro lugar. Se for getter fixo, nao da.
  try {
    const d = Object.getOwnPropertyDescriptor(globalThis, 'RTCPeerConnection');
    fora.propriedade = d
      ? `${d.configurable ? 'config' : 'fixa'}/${d.writable ? 'gravavel' : 'somente-leitura'}${d.get ? '/getter' : ''}`
      : 'sem descritor proprio';
  } catch (err) {
    fora.propriedade = `erro: ${err.message}`;
  }

  // A saida que interessa: um window filho, de mesma origem.
  fora.iframe = (() => {
    if (typeof document === 'undefined') return 'sem DOM';
    let quadro = null;
    try {
      quadro = document.createElement('iframe');
      quadro.style.display = 'none';
      document.body.append(quadro);

      const Classe = quadro.contentWindow?.RTCPeerConnection;
      if (typeof Classe !== 'function') return `typeof ${typeof Classe}`;

      const pc = new Classe({ iceServers: [] });
      pc.close();
      return 'function, e constroi';
    } catch (err) {
      return `erro: ${err.message}`;
    } finally {
      quadro?.remove();
    }
  })();

  return fora;
}

/**
 * Constroi um peer descartavel so para ver o que acontece.
 *
 * E o unico jeito honesto de responder "da para usar WebRTC aqui": nem o
 * `typeof` nem a presenca do simbolo dizem se o sandbox deixa construir.
 * Devolve 'ok' ou a mensagem do erro, para o log contar o motivo exato.
 */
export function testarPeer() {
  const Classe = construtorPeer();
  if (!Classe) return `ausente (typeof ${typeof RTCPeerConnection})`;
  try {
    const pc = new Classe({ iceServers: [] });
    pc.close();
    return `ok via ${origemDoPeer()}`;
  } catch (err) {
    return `nao constroi: ${err.message}`;
  }
}

/**
 * Cria a conexão e liga os avisos. Quem chama decide o que fazer com eles —
 * este módulo não conhece nem sala, nem slot, nem sinalização.
 */
export function criarPeer({ ice, onIce, onEstado, onTrack }) {
  const Classe = construtorPeer();
  if (!Classe) throw new Error('Este navegador nao tem RTCPeerConnection utilizavel.');

  const pc = new Classe({
    iceServers: ice ?? ICE_PADRAO,
    // Junta áudio e vídeo num transporte só. Sem isso são duas negociações de
    // ICE para a mesma conexão, e o dobro de tempo até o primeiro quadro.
    bundlePolicy: 'max-bundle',
  });

  pc.addEventListener('icecandidate', (e) => {
    // O candidato nulo é o fim da lista, não um candidato — repassá-lo faria o
    // outro lado tentar addIceCandidate(null) e lançar.
    if (e.candidate) onIce?.(e.candidate.toJSON());
  });

  const estado = () => onEstado?.(pc.connectionState);
  pc.addEventListener('connectionstatechange', estado);
  // Nem todo navegador emite connectionstatechange em falha de ICE; o estado do
  // ICE chega antes e é o que denuncia a negociação que não vai fechar.
  pc.addEventListener('iceconnectionstatechange', () => {
    if (pc.iceConnectionState === 'failed') onEstado?.('failed');
  });

  if (onTrack) pc.addEventListener('track', (e) => onTrack(e));

  return pc;
}

/**
 * Ajusta como o encoder do WebRTC deve ceder quando a banda não dá.
 *
 * `maintain-resolution` para tela porque texto ilegível é pior que texto que
 * anda a 10 quadros — reduzir a resolução de um terminal apaga a informação.
 * Câmera é o oposto: ninguém lê um rosto, e movimento picado incomoda mais que
 * a imagem mais macia, então lá vale manter o framerate.
 *
 * O teto de bitrate é o mesmo que a pessoa escolheu para o relay: sem ele o
 * WebRTC parte de um chute conservador e leva dezenas de segundos subindo.
 */
export async function ajustarEnvio(pc, { bitrate, fonte = 'tela', fps } = {}) {
  for (const sender of pc.getSenders()) {
    if (!sender.track) continue;
    const params = sender.getParameters();
    params.encodings ??= [{}];
    if (!params.encodings.length) params.encodings.push({});

    if (sender.track.kind === 'video') {
      params.degradationPreference =
        fonte === 'camera' ? 'maintain-framerate' : 'maintain-resolution';
      for (const enc of params.encodings) {
        if (bitrate) enc.maxBitrate = bitrate;
        if (fps) enc.maxFramerate = fps;
      }
    }

    try {
      await sender.setParameters(params);
    } catch {
      // Navegador que não aceita o ajuste transmite com o padrão dele. É pior,
      // não é quebrado — e não há nada a fazer além de seguir.
    }
  }
}

/**
 * Descrição curta do que está acontecendo com a conexão, para o diagnóstico.
 *
 * Só o que dá para agir: o ida-e-volta, e se o caminho passa por TURN — que
 * funciona, mas gasta banda do servidor. O resto do `getStats` é ruído.
 */
export async function resumoPeer(pc) {
  let rtt = null;
  let relay = false;

  try {
    const stats = await pc.getStats();
    const porId = new Map();
    for (const s of stats.values()) porId.set(s.id, s);

    for (const s of stats.values()) {
      if (s.type === 'candidate-pair' && s.state === 'succeeded' && s.nominated !== false) {
        if (typeof s.currentRoundTripTime === 'number')
          rtt = Math.round(s.currentRoundTripTime * 1000);
        const local = porId.get(s.localCandidateId);
        if (local?.candidateType === 'relay') relay = true;
      }
    }
  } catch {
    // getStats falha em navegador antigo; o diagnóstico some, a conexão não.
  }

  return { rtt, relay };
}

/**
 * Quantos candidatos guardar por conexão antes de começar a descartar.
 *
 * A fila só drena quando a descrição remota entra. Se ela nunca entrar — o
 * outro lado sumiu, a negociação morreu no meio —, sem teto isto cresceria até
 * a aba acabar. Sessenta e quatro é folgado: uma negociação normal traz de
 * meia dúzia a vinte candidatos.
 */
export const MAX_ICE_PENDENTES = 64;

/**
 * Fila de candidatos ICE que chegaram antes de haver onde aplicá-los.
 *
 * Trickle ICE não espera: assim que um lado tem descrição local, ele começa a
 * mandar candidato. Do outro lado, entre receber a oferta (ou o convite) e
 * existir um `RTCPeerConnection` com descrição remota aplicada, há um
 * `await iceServers()` — que é uma busca de rede. Tudo que cai nessa janela
 * seria recusado por `addIceCandidate`.
 *
 * Os dois lados descartavam esses candidatos, cada um com um comentário
 * afirmando que a situação se recuperava sozinha. Não se recuperava: o
 * candidato seguinte é outro candidato, não uma segunda chance do que se
 * perdeu. E os primeiros a chegar são os host — os de rede local, os que fecham
 * conexão mais rápido e com menos esforço.
 *
 * O sintoma era conexão direta inconstante: a mesma pessoa, na mesma rede,
 * fechando numa tentativa e não fechando na outra, conforme a corrida entre a
 * busca do `/api/ice` e a pressa do outro lado. Com o relay ligado ninguém
 * percebia, porque ele cobria o buraco. Com `P2P_ONLY`, virava carregamento
 * eterno.
 *
 * Mora aqui, e não nos dois arquivos que precisam dela, porque escrita duas
 * vezes ela seria consertada uma vez só — e o defeito voltaria de um lado.
 */
export function criarFilaIce({ max = MAX_ICE_PENDENTES } = {}) {
  const filas = new Map();

  return {
    /** Guarda um candidato sob esta chave, respeitando o teto. */
    guardar(chave, candidate) {
      if (!candidate) return false;
      const fila = filas.get(chave) ?? [];
      if (fila.length >= max) return false;
      fila.push(candidate);
      filas.set(chave, fila);
      return true;
    },

    /**
     * Aplica em ordem tudo o que estava guardado.
     *
     * A ordem importa: o ICE tenta os pares na ordem em que os conhece, e os
     * host vêm primeiro justamente por serem os que fecham mais rápido.
     *
     * `aindaVale` é consultado entre um candidato e outro porque aplicar é
     * assíncrono: a conexão pode morrer no meio da drenagem, e continuar
     * despejando candidato num peer fechado só gera exceção.
     */
    async drenar(chave, pc, aindaVale = () => true) {
      const fila = filas.get(chave);
      if (!fila) return 0;
      filas.delete(chave);

      let aplicados = 0;
      for (const candidate of fila) {
        if (!aindaVale()) return aplicados;
        try {
          await pc.addIceCandidate(candidate);
          aplicados++;
        } catch (err) {
          console.warn('[rtc] candidato guardado recusado:', err.message);
        }
      }
      return aplicados;
    },

    /**
     * Esquece a fila desta chave.
     *
     * Chamado ao fechar um peer: candidato guardado descreve um caminho da
     * negociação que está morrendo, e herdá-lo na próxima seria oferecer ao ICE
     * um endereço que já não atende.
     */
    esquecer(chave) {
      filas.delete(chave);
    },

    limpar() {
      filas.clear();
    },

    /** Quantos estão guardados. Só para teste e diagnóstico. */
    tamanho(chave) {
      return filas.get(chave)?.length ?? 0;
    },
  };
}

/**
 * O candidato precisa esperar?
 *
 * Sem peer não há onde aplicar; sem descrição remota, `addIceCandidate` recusa.
 * As duas condições são a mesma janela vista de dois momentos.
 */
export function guardarPorEnquanto(pc) {
  return !pc || !pc.remoteDescription;
}
