/**
 * Dois espectadores na mesma tela, ao mesmo tempo.
 *
 * Escrito para responder uma acusação concreta: "só dá para um ver a tela por
 * vez". O mapa do código já apontava que não existe cobertura nenhuma para o
 * comportamento de leque do WebRTC — então este arquivo não testa uma correção,
 * testa se o defeito existe, e de que lado ele mora.
 *
 * Nenhuma asserção aqui olha para o cliente. Se tudo passar, o servidor está
 * limpo e o problema é do navegador; se falhar, achamos.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});

const { server, wss } = await import('./index.js');
const { signToken } = await import('./tokens.js');
const R = await import('./rooms.js');
if (!server.listening) await new Promise((pronto) => server.once('listening', pronto));
const porta = server.address().port;

let sequencia = 0;
const novaSala = () =>
  R.createRoom({
    instance: `dois-${++sequencia}`,
    name: 'Sala',
    ownerId: 'dono',
    ownerName: 'Dono',
  }).room;

const tokenDe = (roomId, role, uid) =>
  signToken({ room: roomId, uid, name: `Pessoa ${uid}`, av: null, role });

const abertos = [];

function conectar(token, extra = {}) {
  const query = new URLSearchParams({ t: token ?? '', ...extra });
  const ws = new WebSocket(`ws://127.0.0.1:${porta}/ws?${query}`);
  ws.recebidas = [];
  ws.binarias = [];
  ws.on('message', (data, isBinary) => {
    if (isBinary) ws.binarias.push(Buffer.from(data));
    else ws.recebidas.push(JSON.parse(data.toString()));
  });
  abertos.push(ws);
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

/**
 * Espera por uma mensagem AINDA NÃO VISTA que satisfaça o predicado.
 *
 * O `ate` do outro arquivo varre o histórico, o que faz duas esperas iguais
 * devolverem a mesma mensagem — exatamente o erro que esconderia "o segundo
 * espectador não gerou nada". Aqui cada espera consome do histórico.
 */
function proxima(ws, predicado, oQue = 'a mensagem esperada') {
  const i = ws.recebidas.findIndex(predicado);
  if (i !== -1) return Promise.resolve(ws.recebidas.splice(i, 1)[0]);

  return new Promise((resolve, reject) => {
    const prazo = setTimeout(() => {
      ws.off('message', ouvir);
      reject(new Error(`tempo esgotado esperando ${oQue}`));
    }, 3000);

    function ouvir(data, isBinary) {
      if (isBinary) return;
      const msg = JSON.parse(data.toString());
      if (!predicado(msg)) return;
      const j = ws.recebidas.findIndex((m) => m.type === msg.type);
      if (j !== -1) ws.recebidas.splice(j, 1);
      clearTimeout(prazo);
      ws.off('message', ouvir);
      resolve(msg);
    }
    ws.on('message', ouvir);
  });
}

const doTipo = (tipo) => (msg) => msg.type === tipo;

function quadro(slot, tipo) {
  const buffer = Buffer.alloc(64);
  buffer[0] = slot;
  buffer[1] = tipo;
  return buffer;
}

/** Um transmissor no ar, sem ninguém assistindo ainda. */
async function noAr() {
  const room = novaSala();
  const transmissor = await conectar(tokenDe(room.id, 'broadcaster', 'quem-transmite'));
  const { slot } = await proxima(transmissor, doTipo('slot'), 'o slot');
  transmissor.send(JSON.stringify({ type: 'start' }));
  return { room, transmissor, slot };
}

/**
 * Liga um espectador e o põe a assistir o slot.
 *
 * Só devolve quando o servidor CONFIRMOU o `watch`, e a confirmação é o estado
 * da sala listando esta pessoa entre quem assiste. Esperar pelo pedido de
 * keyframe não serviria: ele é limitado a um por segundo, então o segundo
 * espectador não gera um — e o teste passaria a medir uma corrida em vez do
 * comportamento.
 */
async function assistindo(room, slot, uid) {
  const ws = await conectar(tokenDe(room.id, 'viewer', uid));
  await proxima(ws, doTipo('stream-start'), `o anúncio para ${uid}`);
  ws.send(JSON.stringify({ type: 'watch', slot }));

  await vi.waitFor(() => {
    const visto = ws.recebidas.some(
      (m) =>
        m.type === 'state' &&
        m.streams?.some((s) => s.slot === slot && s.watchers?.some((w) => w.id === uid)),
    );
    expect(visto).toBe(true);
  });

  return ws;
}

afterAll(async () => {
  for (const ws of abertos) ws.terminate();
  wss.close();
  await new Promise((pronto) => server.close(pronto));
});

describe('dois espectadores na mesma tela', () => {
  it('o transmissor é convidado a abrir conexão com CADA um, com nomes distintos', async () => {
    const { room, transmissor, slot } = await noAr();

    await assistindo(room, slot, 'ana');
    const primeiro = await proxima(transmissor, doTipo('rtc-want'), 'o convite da Ana');

    await assistindo(room, slot, 'bruno');
    const segundo = await proxima(transmissor, doTipo('rtc-want'), 'o convite do Bruno');

    expect(primeiro.peer).toBeTruthy();
    expect(segundo.peer).toBeTruthy();
    // Se o servidor reusasse o nome, o transmissor descartaria o segundo por
    // `peers.has(peerId)` e o Bruno esperaria uma oferta que nunca vem.
    expect(segundo.peer).not.toBe(primeiro.peer);
  });

  it('os dois recebem o mesmo quadro pelo relay', async () => {
    const { room, transmissor, slot } = await noAr();
    const ana = await assistindo(room, slot, 'ana');
    const bruno = await assistindo(room, slot, 'bruno');
    await proxima(transmissor, doTipo('need-keyframe'), 'o pedido de keyframe');

    transmissor.send(quadro(slot, 1));

    await vi.waitFor(() => {
      expect(ana.binarias.length).toBeGreaterThan(0);
      expect(bruno.binarias.length).toBeGreaterThan(0);
    });
  });

  it('a Ana indo para a conexão direta NÃO corta o relay do Bruno', async () => {
    const { room, transmissor, slot } = await noAr();
    const ana = await assistindo(room, slot, 'ana');
    const bruno = await assistindo(room, slot, 'bruno');
    await proxima(transmissor, doTipo('need-keyframe'), 'o pedido de keyframe');

    // Keyframe primeiro: sem ele o relay descarta tudo até o próximo.
    transmissor.send(quadro(slot, 1));
    await vi.waitFor(() => expect(bruno.binarias.length).toBeGreaterThan(0));

    ana.send(JSON.stringify({ type: 'rtc-ativo', slot, on: true }));
    await new Promise((pronto) => setTimeout(pronto, 100));

    const antesAna = ana.binarias.length;
    const antesBruno = bruno.binarias.length;
    transmissor.send(quadro(slot, 1));
    transmissor.send(quadro(slot, 2));

    // O Bruno continua recebendo...
    await vi.waitFor(() => expect(bruno.binarias.length).toBeGreaterThan(antesBruno));
    // ...e a Ana não recebe em duplicidade, porque já está na direta.
    expect(ana.binarias.length).toBe(antesAna);
  });

  it('o relay não é desligado enquanto UM dos dois ainda depende dele', async () => {
    const { room, transmissor, slot } = await noAr();
    const ana = await assistindo(room, slot, 'ana');
    await assistindo(room, slot, 'bruno');
    await proxima(transmissor, doTipo('need-keyframe'), 'o pedido de keyframe');

    // Drena o histórico de `chunks` antes de afirmar sobre o futuro. Há um
    // `chunks:false` legítimo lá desde o `start`: transmissão sem plateia não
    // sobe nada. Confundi-lo com um corte indevido foi o primeiro resultado
    // deste teste, e teria acusado o servidor de um defeito que não é dele.
    await proxima(
      transmissor,
      (m) => m.type === 'chunks' && m.on === false,
      'o corte de sala vazia',
    );
    await proxima(transmissor, (m) => m.type === 'chunks' && m.on === true, 'a religada');
    transmissor.recebidas = transmissor.recebidas.filter((m) => m.type !== 'chunks');

    ana.send(JSON.stringify({ type: 'rtc-ativo', slot, on: true }));

    // Agora sim: um `chunks:false` seria o defeito — o Bruno ficaria sem
    // imagem porque a Ana conseguiu conexão direta.
    await expect(
      proxima(transmissor, (m) => m.type === 'chunks' && m.on === false, 'um corte indevido'),
    ).rejects.toThrow(/tempo esgotado/);
  });

  it('sinalização de um espectador não vaza para o outro', async () => {
    const { room, transmissor, slot } = await noAr();
    const ana = await assistindo(room, slot, 'ana');
    const bruno = await assistindo(room, slot, 'bruno');

    const paraAna = await proxima(transmissor, doTipo('rtc-want'), 'o convite da Ana');
    const paraBruno = await proxima(transmissor, doTipo('rtc-want'), 'o convite do Bruno');

    transmissor.send(
      JSON.stringify({ type: 'rtc', peer: paraBruno.peer, payload: { kind: 'offer', sdp: 'x' } }),
    );

    const recebida = await proxima(bruno, doTipo('rtc'), 'a oferta do Bruno');
    expect(recebida.slot).toBe(slot);
    expect(ana.recebidas.filter(doTipo('rtc'))).toHaveLength(0);
    expect(paraAna.peer).not.toBe(paraBruno.peer);
  });

  it('o terceiro, o quarto e o quinto também entram', async () => {
    const { room, transmissor, slot } = await noAr();
    const nomes = ['ana', 'bruno', 'carla', 'davi', 'elis'];
    const espectadores = [];
    for (const nome of nomes) espectadores.push(await assistindo(room, slot, nome));

    const convites = new Set();
    for (const nome of nomes) {
      const msg = await proxima(transmissor, doTipo('rtc-want'), `o convite de ${nome}`);
      convites.add(msg.peer);
    }
    expect(convites.size).toBe(5);

    await proxima(transmissor, doTipo('need-keyframe'), 'o pedido de keyframe');
    transmissor.send(quadro(slot, 1));

    await vi.waitFor(() => {
      for (const ws of espectadores) expect(ws.binarias.length).toBeGreaterThan(0);
    });
  });
});
