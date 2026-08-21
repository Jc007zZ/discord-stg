/**
 * A camada WebRTC, com dublês no lugar do navegador.
 *
 * Nada disto existe fora de um navegador de verdade, e o que este módulo faz
 * não é negociar — é ligar os fios certos e traduzir o que o RTCPeerConnection
 * conta. Os dublês daqui imitam o contrato dessa API, que é o que o módulo
 * realmente depende: quais eventos ele escuta, o que ele repassa, e o que ele
 * decide quando a resposta não vem.
 *
 * O que se prova aqui é sobretudo a rede de segurança: candidato nulo que não
 * pode ser repassado, ICE que falha sem emitir mudança de estado, navegador
 * que recusa o ajuste de bitrate, `getStats` que lança. Nenhuma dessas
 * situações quebra a transmissão hoje — e é justamente por isso que uma
 * regressão nelas passaria despercebida.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ajustarEnvio,
  criarFilaIce,
  criarPeer,
  guardarPorEnquanto,
  MAX_ICE_PENDENTES,
  MORTO,
  PRAZO_CONEXAO_MS,
  resumoPeer,
} from './rtc.js';

const STUN = 'stun:stun.l.google.com:19302';

/** Um RTCPeerConnection de mentira: guarda os ouvintes para o teste disparar. */
class PeerFalso {
  constructor(config) {
    this.config = config;
    this.ouvintes = new Map();
    this.senders = [];
    this.estatisticas = new Map();
    this.fechado = false;
    PeerFalso.criados.push(this);
  }
  addEventListener(nome, fn) {
    this.ouvintes.set(nome, fn);
  }
  disparar(nome, evento) {
    this.ouvintes.get(nome)?.(evento);
  }
  getSenders() {
    return this.senders;
  }
  async getStats() {
    return this.estatisticas;
  }
  close() {
    this.fechado = true;
  }
}
PeerFalso.criados = [];

/** Um sender no formato que `ajustarEnvio` espera. */
function sender(kind, { encodings, recusa = false } = {}) {
  return {
    track: kind ? { kind } : null,
    parametros: { encodings },
    aplicados: [],
    getParameters() {
      return this.parametros;
    },
    async setParameters(p) {
      if (recusa) throw new Error('nao suportado');
      this.aplicados.push(p);
    },
  };
}

beforeEach(() => {
  PeerFalso.criados = [];
  vi.stubGlobal('RTCPeerConnection', PeerFalso);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('iceServers', () => {
  /**
   * O módulo guarda a lista numa promessa de módulo, para buscá-la uma vez por
   * sessão. Isso obriga a reimportar a cada caso — sem isso o primeiro teste
   * decidiria o resultado dos outros.
   */
  async function comFetch(implementacao) {
    vi.resetModules();
    vi.stubGlobal('fetch', vi.fn(implementacao));
    const { iceServers } = await import('./rtc.js');
    return iceServers;
  }

  it('usa a lista que o servidor mandou', async () => {
    const iceServers = await comFetch(async () => ({
      ok: true,
      json: async () => ({ iceServers: [{ urls: 'turn:exemplo.test', username: 'u' }] }),
    }));

    expect(await iceServers()).toEqual([{ urls: 'turn:exemplo.test', username: 'u' }]);
  });

  it('busca uma vez só, por mais que perguntem', async () => {
    const iceServers = await comFetch(async () => ({
      ok: true,
      json: async () => ({ iceServers: [{ urls: STUN }] }),
    }));

    await Promise.all([iceServers(), iceServers(), iceServers()]);

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('respeita o prefixo do proxy da Activity', async () => {
    const iceServers = await comFetch(async () => ({ ok: true, json: async () => ({}) }));

    await iceServers('/.proxy');

    expect(globalThis.fetch).toHaveBeenCalledWith('/.proxy/api/ice');
  });

  it('cai no STUN público quando a rede falha', async () => {
    // Ficar sem lista não pode significar ficar sem conexão direta: o STUN
    // público sozinho já resolve a maioria das casas.
    const iceServers = await comFetch(async () => {
      throw new Error('sem rede');
    });

    expect(await iceServers()).toEqual([{ urls: STUN }]);
  });

  it('cai no STUN público quando o servidor recusa', async () => {
    const iceServers = await comFetch(async () => ({ ok: false }));

    expect(await iceServers()).toEqual([{ urls: STUN }]);
  });

  it('cai no STUN público quando a lista vem vazia', async () => {
    const iceServers = await comFetch(async () => ({
      ok: true,
      json: async () => ({ iceServers: [] }),
    }));

    expect(await iceServers()).toEqual([{ urls: STUN }]);
  });
});

describe('achar um RTCPeerConnection utilizavel', () => {
  /**
   * Um `document` de mentira com um iframe que devolve a classe pedida.
   *
   * O caminho do iframe nao da para testar em Node de outro jeito, e ele e
   * justamente a ultima linha de defesa: se o Discord fechar o alias antigo
   * um dia, e ele que segura o P2P dentro da atividade.
   */
  function documentoComQuadro(Classe) {
    const quadro = {
      style: {},
      isConnected: false,
      setAttribute() {},
      contentWindow: { RTCPeerConnection: Classe },
      remove() {
        this.isConnected = false;
      },
    };
    return {
      quadro,
      doc: {
        createElement: () => quadro,
        body: {
          append() {
            quadro.isConnected = true;
          },
        },
      },
    };
  }

  /** Reimporta o modulo: o iframe de socorro fica guardado entre chamadas. */
  async function comAmbiente({ janela, webkit, doc }) {
    vi.resetModules();
    vi.stubGlobal('RTCPeerConnection', janela);
    vi.stubGlobal('webkitRTCPeerConnection', webkit);
    if (doc) vi.stubGlobal('document', doc);
    return import('./rtc.js');
  }

  it('usa o do window quando ele esta la', async () => {
    const rtc = await comAmbiente({ janela: PeerFalso });

    expect(rtc.suportaWebRTC()).toBe(true);
    expect(rtc.origemDoPeer()).toBe('window');
    expect(rtc.construtorPeer()).toBe(PeerFalso);
  });

  it('cai no alias antigo quando o window foi anulado', async () => {
    // O caso da atividade do Discord: `RTCPeerConnection` vale null — e
    // `typeof null` e 'object', o que ja custou horas de diagnostico errado —
    // mas anularam um e esqueceram `webkitRTCPeerConnection`.
    const rtc = await comAmbiente({ janela: null, webkit: PeerFalso });

    expect(rtc.suportaWebRTC()).toBe(true);
    expect(rtc.origemDoPeer()).toBe('webkit');
    expect(rtc.construtorPeer()).toBe(PeerFalso);
  });

  it('cai no iframe quando nem o alias sobrou', async () => {
    const { doc } = documentoComQuadro(PeerFalso);
    const rtc = await comAmbiente({ janela: null, webkit: undefined, doc });

    expect(rtc.origemDoPeer()).toBe('iframe');
    expect(rtc.construtorPeer()).toBe(PeerFalso);
  });

  it('reaproveita o mesmo iframe, em vez de criar um por peer', async () => {
    // Objeto vindo de quadro removido para de funcionar no Chromium, e criar
    // um por conexao encheria o DOM de quadros vivos.
    const { doc, quadro } = documentoComQuadro(PeerFalso);
    const rtc = await comAmbiente({ janela: null, webkit: undefined, doc });
    rtc.construtorPeer(); // a primeira vez cria mesmo
    const criar = vi.spyOn(doc, 'createElement');

    rtc.construtorPeer();
    rtc.construtorPeer();

    expect(criar).not.toHaveBeenCalled();
    expect(quadro.isConnected).toBe(true);
  });

  it('desiste quando nao ha nenhuma das tres portas', async () => {
    const rtc = await comAmbiente({ janela: null, webkit: undefined, doc: undefined });

    expect(rtc.suportaWebRTC()).toBe(false);
    expect(rtc.origemDoPeer()).toBe('nenhuma');
    expect(rtc.testarPeer()).toMatch(/ausente/);
  });

  it('diz por qual porta entrou quando o teste passa', async () => {
    const rtc = await comAmbiente({ janela: null, webkit: PeerFalso });

    expect(rtc.testarPeer()).toBe('ok via webkit');
  });

  it('devolve o erro de verdade quando existe mas nao constroi', async () => {
    const rtc = await comAmbiente({
      janela: class {
        constructor() {
          throw new TypeError('Illegal constructor');
        }
      },
    });

    expect(rtc.testarPeer()).toBe('nao constroi: Illegal constructor');
  });
});

describe('criarPeer', () => {
  it('junta áudio e vídeo num transporte só', async () => {
    // Sem isto são duas negociações de ICE para a mesma conexão, e o dobro de
    // tempo até o primeiro quadro.
    criarPeer({ ice: [{ urls: STUN }] });

    expect(PeerFalso.criados[0].config).toMatchObject({ bundlePolicy: 'max-bundle' });
  });

  it('repassa o candidato já convertido', async () => {
    const onIce = vi.fn();
    const pc = criarPeer({ ice: [], onIce });

    pc.disparar('icecandidate', { candidate: { toJSON: () => ({ candidate: 'a=1' }) } });

    expect(onIce).toHaveBeenCalledWith({ candidate: 'a=1' });
  });

  it('não repassa o candidato nulo, que é o fim da lista', async () => {
    // Repassá-lo faria o outro lado chamar addIceCandidate(null) e lançar.
    const onIce = vi.fn();
    const pc = criarPeer({ ice: [], onIce });

    pc.disparar('icecandidate', { candidate: null });

    expect(onIce).not.toHaveBeenCalled();
  });

  it('avisa a mudança de estado da conexão', async () => {
    const onEstado = vi.fn();
    const pc = criarPeer({ ice: [], onEstado });
    pc.connectionState = 'connected';

    pc.disparar('connectionstatechange');

    expect(onEstado).toHaveBeenCalledWith('connected');
  });

  it('trata a falha de ICE como falha, mesmo sem mudança de conexão', async () => {
    // Nem todo navegador emite connectionstatechange quando o ICE desiste; sem
    // isto a tentativa ficaria pendurada até o prazo estourar.
    const onEstado = vi.fn();
    const pc = criarPeer({ ice: [], onEstado });
    pc.iceConnectionState = 'failed';

    pc.disparar('iceconnectionstatechange');

    expect(onEstado).toHaveBeenCalledWith('failed');
  });

  it('ignora estado de ICE que não é falha', async () => {
    const onEstado = vi.fn();
    const pc = criarPeer({ ice: [], onEstado });
    pc.iceConnectionState = 'checking';

    pc.disparar('iceconnectionstatechange');

    expect(onEstado).not.toHaveBeenCalled();
  });

  it('só escuta faixas quando alguém quer recebê-las', async () => {
    expect(criarPeer({ ice: [] }).ouvintes.has('track')).toBe(false);
    expect(criarPeer({ ice: [], onTrack: vi.fn() }).ouvintes.has('track')).toBe(true);
  });

  it('reconhece os estados dos quais não se volta', async () => {
    expect([...MORTO]).toEqual(expect.arrayContaining(['failed', 'closed', 'disconnected']));
    expect(MORTO.has('connected')).toBe(false);
    expect(PRAZO_CONEXAO_MS).toBeGreaterThan(0);
  });
});

describe('ajustarEnvio', () => {
  it('põe teto de bitrate e de taxa na faixa de vídeo', async () => {
    // Sem o teto o WebRTC parte de um chute conservador e leva dezenas de
    // segundos subindo até a qualidade que a pessoa já escolheu.
    const video = sender('video', { encodings: [{}] });
    const pc = criarPeer({ ice: [] });
    pc.senders = [video];

    await ajustarEnvio(pc, { bitrate: 2_500_000, fps: 30 });

    expect(video.aplicados[0].encodings[0]).toMatchObject({
      maxBitrate: 2_500_000,
      maxFramerate: 30,
    });
  });

  it('mantém a resolução na tela, porque texto ilegível é pior que texto lento', async () => {
    const video = sender('video', { encodings: [{}] });
    const pc = criarPeer({ ice: [] });
    pc.senders = [video];

    await ajustarEnvio(pc, { bitrate: 1, fonte: 'tela' });

    expect(video.aplicados[0].degradationPreference).toBe('maintain-resolution');
  });

  it('mantém a taxa na câmera, porque ninguém lê um rosto', async () => {
    const video = sender('video', { encodings: [{}] });
    const pc = criarPeer({ ice: [] });
    pc.senders = [video];

    await ajustarEnvio(pc, { bitrate: 1, fonte: 'camera' });

    expect(video.aplicados[0].degradationPreference).toBe('maintain-framerate');
  });

  it('cria a lista de encodings quando o navegador não trouxe nenhuma', async () => {
    const semLista = sender('video', { encodings: undefined });
    const vazia = sender('video', { encodings: [] });
    const pc = criarPeer({ ice: [] });
    pc.senders = [semLista, vazia];

    await ajustarEnvio(pc, { bitrate: 900 });

    expect(semLista.aplicados[0].encodings[0].maxBitrate).toBe(900);
    expect(vazia.aplicados[0].encodings[0].maxBitrate).toBe(900);
  });

  it('não mexe no teto da faixa de som', async () => {
    const audio = sender('audio', { encodings: [{}] });
    const pc = criarPeer({ ice: [] });
    pc.senders = [audio];

    await ajustarEnvio(pc, { bitrate: 2_500_000 });

    expect(audio.aplicados[0].encodings[0]).not.toHaveProperty('maxBitrate');
    expect(audio.aplicados[0]).not.toHaveProperty('degradationPreference');
  });

  it('ignora o sender sem faixa', async () => {
    const orfao = sender(null);
    const pc = criarPeer({ ice: [] });
    pc.senders = [orfao];

    await ajustarEnvio(pc, { bitrate: 1 });

    expect(orfao.aplicados).toHaveLength(0);
  });

  it('segue transmitindo quando o navegador recusa o ajuste', async () => {
    // Transmitir com o padrão do navegador é pior; não é quebrado.
    const teimoso = sender('video', { encodings: [{}], recusa: true });
    const pc = criarPeer({ ice: [] });
    pc.senders = [teimoso];

    await expect(ajustarEnvio(pc, { bitrate: 1 })).resolves.toBeUndefined();
  });
});

describe('resumoPeer', () => {
  const par = (extra = {}) => ({
    id: 'par',
    type: 'candidate-pair',
    state: 'succeeded',
    localCandidateId: 'local',
    currentRoundTripTime: 0.042,
    ...extra,
  });

  function comEstatisticas(entradas) {
    const pc = criarPeer({ ice: [] });
    pc.estatisticas = new Map(entradas.map((e) => [e.id, e]));
    return pc;
  }

  it('traduz o ida-e-volta para milissegundos', async () => {
    const pc = comEstatisticas([
      par(),
      { id: 'local', type: 'local-candidate', candidateType: 'srflx' },
    ]);

    expect(await resumoPeer(pc)).toMatchObject({ rtt: 42, relay: false });
  });

  it('acusa quando a conexão está passando por TURN', async () => {
    // TURN encaminha o vídeo de verdade: é banda paga por alguém, e quem olha
    // o diagnóstico precisa saber que está nesse caminho.
    const pc = comEstatisticas([
      par(),
      { id: 'local', type: 'local-candidate', candidateType: 'relay' },
    ]);

    expect(await resumoPeer(pc)).toMatchObject({ relay: true });
  });

  it('ignora o par que não foi escolhido', async () => {
    const pc = comEstatisticas([par({ id: 'a', state: 'failed' })]);

    expect(await resumoPeer(pc)).toMatchObject({ rtt: null, relay: false });
  });

  it('devolve só o que dá para agir: ida-e-volta e se passa por TURN', async () => {
    // Sem taxa de chegada de proposito. Ela existiu aqui por um tempo, lendo
    // `bytesReceived` — que e um acumulado desde o inicio, nao uma taxa. Um
    // numero com nome de velocidade e valor de total engana quem le o painel
    // mais do que a ausencia dele.
    const pc = comEstatisticas([
      par(),
      { id: 'local', type: 'local-candidate', candidateType: 'srflx' },
      { id: 'in', type: 'inbound-rtp', kind: 'video', bytesReceived: 4242 },
    ]);

    expect(Object.keys(await resumoPeer(pc)).sort()).toEqual(['relay', 'rtt']);
  });

  it('some o diagnóstico, e não a conexão, quando getStats lança', async () => {
    const pc = criarPeer({ ice: [] });
    pc.getStats = async () => {
      throw new Error('sem suporte');
    };

    expect(await resumoPeer(pc)).toEqual({ rtt: null, relay: false });
  });
});

/**
 * A fila de candidatos ICE.
 *
 * Ela existe por causa de um defeito que se escondia bem: candidato que chegava
 * antes da descrição remota era descartado, com um comentário — meu — afirmando
 * que a situação se recuperava sozinha. Não se recuperava. O sintoma era
 * conexão direta que fecha numa tentativa e não fecha na seguinte, na mesma
 * rede e com a mesma pessoa.
 */
describe('fila de candidatos ICE', () => {
  const peerFalso = () => {
    const aplicados = [];
    return {
      aplicados,
      addIceCandidate: async (c) => {
        aplicados.push(c);
      },
    };
  };

  it('guarda enquanto não há peer, e enquanto não há descrição remota', () => {
    expect(guardarPorEnquanto(null)).toBe(true);
    expect(guardarPorEnquanto(undefined)).toBe(true);
    expect(guardarPorEnquanto({ remoteDescription: null })).toBe(true);
    expect(guardarPorEnquanto({ remoteDescription: { type: 'answer' } })).toBe(false);
  });

  it('devolve na drenagem o que guardou, em ordem', async () => {
    const fila = criarFilaIce();
    const pc = peerFalso();
    // Ordem importa: o ICE tenta os pares na ordem em que os conhece, e os host
    // vêm primeiro justamente por fecharem mais rápido.
    for (const nome of ['host', 'srflx', 'relay']) fila.guardar('p1', { candidate: nome });

    expect(await fila.drenar('p1', pc)).toBe(3);
    expect(pc.aplicados.map((c) => c.candidate)).toEqual(['host', 'srflx', 'relay']);
  });

  it('drenar duas vezes não aplica duas vezes', async () => {
    const fila = criarFilaIce();
    const pc = peerFalso();
    fila.guardar('p1', { candidate: 'a' });

    await fila.drenar('p1', pc);
    await fila.drenar('p1', pc);

    expect(pc.aplicados).toHaveLength(1);
  });

  it('cada chave tem a própria fila', async () => {
    const fila = criarFilaIce();
    const um = peerFalso();
    const outro = peerFalso();
    fila.guardar('p1', { candidate: 'do-p1' });
    fila.guardar('p2', { candidate: 'do-p2' });

    await fila.drenar('p1', um);
    await fila.drenar('p2', outro);

    expect(um.aplicados).toEqual([{ candidate: 'do-p1' }]);
    expect(outro.aplicados).toEqual([{ candidate: 'do-p2' }]);
  });

  it('para de crescer no teto, para não consumir a aba quando a resposta não vem', () => {
    const fila = criarFilaIce({ max: 3 });
    for (let i = 0; i < 50; i++) fila.guardar('p1', { candidate: `c${i}` });

    expect(fila.tamanho('p1')).toBe(3);
  });

  it('o teto padrão é o exportado, para o número morar num lugar só', () => {
    const fila = criarFilaIce();
    for (let i = 0; i < MAX_ICE_PENDENTES + 10; i++) fila.guardar('p1', { candidate: `c${i}` });

    expect(fila.tamanho('p1')).toBe(MAX_ICE_PENDENTES);
  });

  it('esquecer apaga a fila de uma negociação que morreu', async () => {
    const fila = criarFilaIce();
    const pc = peerFalso();
    fila.guardar('p1', { candidate: 'velho' });

    fila.esquecer('p1');
    await fila.drenar('p1', pc);

    // Herdar o candidato na negociação seguinte seria oferecer ao ICE um
    // endereço que já não atende.
    expect(pc.aplicados).toHaveLength(0);
  });

  it('para no meio da drenagem quando a conexão morre', async () => {
    const fila = criarFilaIce();
    const pc = peerFalso();
    for (const nome of ['a', 'b', 'c']) fila.guardar('p1', { candidate: nome });

    let vivo = true;
    pc.addIceCandidate = async (c) => {
      pc.aplicados.push(c);
      vivo = false;
    };

    // Aplicar é assíncrono; sem esta checagem entre um e outro, continuaríamos
    // despejando candidato num peer já fechado.
    expect(await fila.drenar('p1', pc, () => vivo)).toBe(1);
    expect(pc.aplicados).toHaveLength(1);
  });

  it('um candidato recusado não impede os seguintes', async () => {
    const fila = criarFilaIce();
    const pc = peerFalso();
    for (const nome of ['ruim', 'bom']) fila.guardar('p1', { candidate: nome });
    pc.addIceCandidate = async (c) => {
      if (c.candidate === 'ruim') throw new Error('malformado');
      pc.aplicados.push(c);
    };

    expect(await fila.drenar('p1', pc)).toBe(1);
    expect(pc.aplicados).toEqual([{ candidate: 'bom' }]);
  });

  it('candidato vazio não ocupa vaga na fila', () => {
    const fila = criarFilaIce();
    fila.guardar('p1', null);
    fila.guardar('p1', undefined);

    expect(fila.tamanho('p1')).toBe(0);
  });

  it('limpar zera tudo de uma vez, para quando a transmissão acaba', () => {
    const fila = criarFilaIce();
    fila.guardar('p1', { candidate: 'a' });
    fila.guardar('p2', { candidate: 'b' });

    fila.limpar();

    expect(fila.tamanho('p1')).toBe(0);
    expect(fila.tamanho('p2')).toBe(0);
  });
});
