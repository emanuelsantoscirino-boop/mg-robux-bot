const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

// Variáveis do painel do Render têm prioridade. O arquivo .env/rbx.env só serve para rodar no PC.
const arquivoEnv = fs.existsSync('.env') ? '.env' : (fs.existsSync('rbx.env') ? 'rbx.env' : null);
if (arquivoEnv) require('dotenv').config({ path: arquivoEnv });

const {
  Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, ChannelType, PermissionFlagsBits, SlashCommandBuilder,
  REST, Routes, MessageFlags, Events,
  ModalBuilder, TextInputBuilder, TextInputStyle, AttachmentBuilder
} = require('discord.js');

// ---------- CONFIGURAÇÃO ----------
const CAMINHO_BANNER = path.join(__dirname, 'banner.png');
const NOME_LOJA = 'MG ROBUX';
const corHex = parseInt(String(process.env.COR_MARCA || '00b06b').replace('#', ''), 16);
const COR_MARCA = Number.isNaN(corHex) ? 0x00b06b : corHex;
const COR_ESPERA = 0xe0a030;  // âmbar
const COR_ERRO = 0xc0392b;    // vermelho escuro

// Limite diário de envio do Roblox Plus (em Robux)
const LIMITE_PLUS = 500;

// Pedido mínimo (em Robux)
const PEDIDO_MINIMO = 400;

const METODOS = {
  plus: 'Roblox Plus',
  gamepass: 'Gamepass'
};

const obrigatorias = ['TOKEN', 'CLIENT_ID', 'GUILD_ID', 'STAFF_ROLE', 'LOG_CHANNEL', 'SHARPIFY_CLIENT_ID', 'SHARPIFY_CLIENT_SECRET'];
const faltando = obrigatorias.filter(v => !process.env[v]);
if (faltando.length) {
  console.error(`Faltando nas variáveis de ambiente: ${faltando.join(', ')}`);
  process.exit(1);
}

// ---------- SHARPIFY (pagamento Pix) ----------
const SHARPIFY_URL = 'https://sharpify-pay.com';
const sharpifyHeaders = () => ({
  'Content-Type': 'application/json',
  'x-sharpify-client-id': process.env.SHARPIFY_CLIENT_ID,
  'x-sharpify-client-secret': process.env.SHARPIFY_CLIENT_SECRET
});

// Senha do webhook derivada do Client Secret (não precisa configurar nada extra).
const WEBHOOK_SECRET = crypto.createHash('sha256').update(`wh:${process.env.SHARPIFY_CLIENT_SECRET}`).digest('hex');
// No Render, RENDER_EXTERNAL_URL já vem pronta. Se quiser forçar outra, use PUBLIC_URL.
const segredoConfere = (recebido) => {
  const a = Buffer.from(String(recebido || ''));
  const b = Buffer.from(WEBHOOK_SECRET);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const URL_BRUTA = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
// A Sharpify recusa URL com porta explícita, localhost ou IP.
const urlValida = (u) => {
  try {
    const x = new URL(u);
    return /^https?:$/.test(x.protocol) && !x.port && x.hostname !== 'localhost'
      && !/^\d{1,3}(\.\d{1,3}){3}$/.test(x.hostname) && !x.hostname.includes(':');
  } catch { return false; }
};
const PUBLIC_URL = urlValida(URL_BRUTA) ? URL_BRUTA : '';
if (URL_BRUTA && !PUBLIC_URL) console.warn(`URL pública inválida para a Sharpify (${URL_BRUTA}). Use https://dominio, sem porta e sem IP.`);

async function criarPagamento(id, valor, quantidade) {
  const body = {
    name: `Pedido #${id} - ${quantidade} Robux`,
    description: `${NOME_LOJA} | Pedido #${id}`,
    amount: valor,
    gatewayMethod: 'PIX'
  };
  if (PUBLIC_URL) {
    body.webhook = {
      callbackURL: `${PUBLIC_URL}/sharpify-webhook`,
      headers: [{ key: 'x-webhook-secret', value: WEBHOOK_SECRET }]
    };
  }
  const res = await fetch(`${SHARPIFY_URL}/api/v1/gateway/payment/create-paymnet`, {
    method: 'POST',
    headers: sharpifyHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || !json.data) {
    throw new Error(`Sharpify respondeu ${res.status}: ${JSON.stringify(json)}`);
  }
  return json.data; // PaymentLinkProps
}

async function consultarPagamento(linkId) {
  const res = await fetch(
    `${SHARPIFY_URL}/api/v1/gateway/payment/get-payment?paymentLinkId=${encodeURIComponent(linkId)}`,
    { headers: sharpifyHeaders(), signal: AbortSignal.timeout(15000) }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return json.data || json;
}

// O QR Code pode vir como link, base64 (imagem) ou o próprio texto do Pix.
function interpretarQr(qr) {
  if (!qr || typeof qr !== 'string') return null;
  if (/^https?:\/\//i.test(qr)) return { url: qr };
  const b64 = qr.replace(/^data:image\/\w+;base64,/, '').replace(/\s/g, '');
  if (b64.length > 200 && /^[A-Za-z0-9+/=]+$/.test(b64)) return { buffer: Buffer.from(b64, 'base64') };
  return null;
}

// ---------- EMOJIS ----------
const EMOJI_NOMES = { ROBUX: 'Robux', MONEY: 'Robux', PIX: 'Pix', CARTAO: 'Cartao', PLUS: 'Plus', GAMEPASS: 'gamepass' };
const EMOJI_FALLBACK = { ROBUX: '🪙', MONEY: '🪙', PIX: '💠', CARTAO: '💳', PLUS: '⭐', GAMEPASS: '🎮' };
const emojiCache = {};

async function carregarEmojis() {
  const encontrados = new Map();
  try {
    const guild = await client.guilds.fetch(process.env.GUILD_ID);
    const lista = await guild.emojis.fetch();
    lista.forEach(e => encontrados.set(e.name.toLowerCase(), e));
  } catch (e) {
    console.error('Não consegui ler os emojis do servidor:', e.message);
  }
  try {
    const lista = await client.application.emojis.fetch();
    lista.forEach(e => { if (!encontrados.has(e.name.toLowerCase())) encontrados.set(e.name.toLowerCase(), e); });
  } catch (e) {
    // emojis do aplicativo são opcionais
  }

  for (const [chave, nome] of Object.entries(EMOJI_NOMES)) {
    const e = encontrados.get(nome.toLowerCase());
    if (e) emojiCache[chave] = { id: e.id, name: e.name, animated: !!e.animated };
  }

  console.log('Emojis existentes no servidor:', [...encontrados.values()].map(e => e.name).join(', ') || '(nenhum)');
  const faltam = Object.entries(EMOJI_NOMES).filter(([k]) => !emojiCache[k]).map(([, n]) => n);
  if (faltam.length) console.warn('Emojis NÃO encontrados (usando padrão): ' + [...new Set(faltam)].join(', '));
}

const emoji = (nome) => {
  const c = emojiCache[nome];
  return c ? `<${c.animated ? 'a' : ''}:${c.name}:${c.id}>` : (EMOJI_FALLBACK[nome] || '');
};
const comEmoji = (nome, texto) => `${emoji(nome)} ${texto}`;

const emojiBotao = (nome, fallback) => {
  const c = emojiCache[nome];
  return c ? { id: c.id, name: c.name, animated: c.animated } : fallback;
};

// ---------- BANCO DE DADOS ----------
// Com MONGODB_URI: os dados ficam no MongoDB (não somem quando o Render reinicia).
// Sem MONGODB_URI: usa o db.json (só para testes no PC).
// Os dados ficam em memória; db() lê rápido e save() grava no banco em segundo plano.
let cache = null;
let colecao = null;
let gravando = Promise.resolve();

const lerArquivo = () => JSON.parse(fs.readFileSync('./db.json', 'utf8'));

async function iniciarBanco() {
  if (!process.env.MONGODB_URI) {
    cache = lerArquivo();
    console.warn('ATENÇÃO: sem MONGODB_URI. Usando db.json, que é APAGADO quando o Render reinicia.');
    return;
  }
  const { MongoClient } = require('mongodb');
  const mongo = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  await mongo.connect();
  colecao = mongo.db(process.env.MONGODB_DB || 'mgrobux').collection('loja');

  const doc = await colecao.findOne({ _id: 'principal' });
  if (doc) {
    const { _id, ...dados } = doc;
    cache = dados;
    console.log('Banco: dados carregados do MongoDB.');
  } else {
    // Primeira vez: usa o db.json do GitHub como ponto de partida.
    cache = lerArquivo();
    await colecao.insertOne({ _id: 'principal', ...cache });
    console.log('Banco: MongoDB estava vazio, criado a partir do db.json.');
  }
}

const db = () => {
  if (!cache) throw new Error('Banco ainda não carregou');
  return structuredClone(cache);
};

const save = (d) => {
  cache = d;
  if (!colecao) {
    fs.writeFileSync('./db.json', JSON.stringify(d, null, 2));
    return;
  }
  const copia = structuredClone(d);
  gravando = gravando
    .then(() => colecao.replaceOne({ _id: 'principal' }, copia, { upsert: true }))
    .catch((e) => console.error('FALHA ao gravar no MongoDB:', e.message));
};

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ---------- UTILIDADES ----------
const precoGamepass = (robuxLiquido) => Math.ceil(robuxLiquido / 0.7);
const reais = (n) => `R$ ${n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const ephemeral = MessageFlags.Ephemeral;
const lerNumero = (txt) => Number(String(txt).trim().replace(/\./g, '').replace(',', '.'));
const ehStaff = (i) => i.member.roles.cache.has(process.env.STAFF_ROLE);
const agora = () => `<t:${Math.floor(Date.now() / 1000)}:f>`;

const precoPor1000 = (d, metodo) =>
  metodo === 'plus' && typeof d.precoPlusPor1000 === 'number' ? d.precoPlusPor1000 : d.precoPor1000;

// ---------- MENSAGENS EFÊMERAS (só o cliente vê) ----------
// Cada mensagem dessas some sozinha depois de um tempo, e também some quando a pessoa
// abre outra coisa no painel. Assim o painel principal fica sempre fácil de achar.
// (O Discord só deixa apagar essas mensagens nos primeiros 15 minutos.)
const TEMPO_MENU = 2 * 60 * 1000;   // menu "Forma de entrega" (cliente precisa de tempo para escolher)
const TEMPO_INFO = 60 * 1000;       // preços, cálculo de gamepass
const TEMPO_AVISO = 30 * 1000;      // "Seu ticket foi criado" e avisos de erro

const efemeras = new Map(); // userId -> { i, timer }

function esquecerEfemera(userId) {
  const x = efemeras.get(userId);
  if (x) { clearTimeout(x.timer); efemeras.delete(userId); }
  return x;
}

function apagarEfemera(userId) {
  const x = esquecerEfemera(userId);
  if (x) x.i.deleteReply().catch(() => {});
}

// Marca a mensagem atual da pessoa para sumir daqui a "ms".
function agendarEfemera(i, ms) {
  const userId = i.user.id;
  esquecerEfemera(userId);
  const timer = setTimeout(() => {
    const atual = efemeras.get(userId);
    if (atual && atual.i === i) efemeras.delete(userId);
    i.deleteReply().catch(() => {});
  }, ms);
  efemeras.set(userId, { i, timer });
}

// Envia uma mensagem efêmera nova, apagando a anterior da mesma pessoa.
async function responderEfemera(i, payload, ms = TEMPO_INFO) {
  apagarEfemera(i.user.id);
  await i.reply({ ...payload, flags: ephemeral });
  agendarEfemera(i, ms);
}

// O formulário de compra é aberto a partir da mensagem efêmera "Forma de entrega".
const veioDeEfemera = (i) => i.isFromMessage() && i.message.flags.has(MessageFlags.Ephemeral);

// Mostra um erro de formulário. Se veio da mensagem "Forma de entrega", mostra o aviso nela mesma
// (com os botões de volta) em vez de criar mais uma mensagem.
async function erroModal(i, texto) {
  if (veioDeEfemera(i)) {
    await i.update({ content: `⚠️ ${texto}`, embeds: [escolhaMetodoEmbed()], components: [escolhaMetodoBotoes()] });
    agendarEfemera(i, TEMPO_MENU);
    return;
  }
  return responderEfemera(i, { content: texto }, TEMPO_AVISO);
}

// Dá mais tempo para a mensagem atual da pessoa (ex.: enquanto ela preenche o formulário).
function prolongarEfemera(userId, ms) {
  const x = efemeras.get(userId);
  if (x) agendarEfemera(x.i, ms);
}

// Edita a resposta atual com um texto final (ticket criado / erro) e agenda a remoção.
async function finalizarEfemera(i, texto) {
  await i.editReply({ content: texto, embeds: [], components: [] });
  agendarEfemera(i, TEMPO_AVISO);
}

// ---------- CUPONS ----------
// d.cupons = { CODIGO: { tipo: 'percentual' | 'fixo', valor, usosMax (0 = ilimitado), usos, expiraEm, criadoPor, criadoEm } }
const VALOR_MINIMO_PIX = 1; // o Pix nunca fica abaixo de R$ 1,00
const arredondar = (n) => Math.round(n * 100) / 100;
const normalizarCupom = (t) => String(t || '').trim().toUpperCase().replace(/\s+/g, '');
const descricaoCupom = (c) => (c.tipo === 'percentual' ? `${c.valor}%` : reais(c.valor));

function validarCupom(d, codigo) {
  const c = d.cupons && d.cupons[codigo];
  if (!c) return { ok: false, msg: 'Cupom inválido. Confira o código e tente de novo.' };
  if (c.expiraEm && Date.now() > c.expiraEm) return { ok: false, msg: 'Esse cupom já expirou.' };
  if (c.usosMax > 0 && c.usos >= c.usosMax) return { ok: false, msg: 'Esse cupom atingiu o limite de usos.' };
  return { ok: true, cupom: c };
}

function aplicarDesconto(valor, c) {
  let desc = c.tipo === 'percentual' ? valor * (c.valor / 100) : c.valor;
  desc = Math.max(0, Math.min(desc, valor - VALOR_MINIMO_PIX));
  desc = arredondar(desc);
  return { desconto: desc, final: arredondar(valor - desc) };
}

// Devolve o uso do cupom quando o pedido é cancelado.
function liberarCupom(d, p) {
  const c = p.cupom && d.cupons && d.cupons[p.cupom];
  if (c && c.usos > 0) c.usos -= 1;
}

async function log(titulo, descricao, cor = COR_MARCA) {
  try {
    const canal = await client.channels.fetch(process.env.LOG_CHANNEL);
    const embed = new EmbedBuilder()
      .setColor(cor)
      .setTitle(titulo)
      .setDescription(`${descricao}\n\n${agora()}`)
      .setFooter({ text: `${NOME_LOJA} | Registro` });
    await canal.send({ embeds: [embed] });
  } catch (e) {
    console.error('Não consegui enviar log:', e.message);
  }
}

// ---------- VISUAL (embeds e botões) ----------
const LINHA = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';

function painelEmbeds(d, temBanner) {
  const R = emoji('ROBUX');
  const P = emoji('PIX');
  const C = emoji('CARTAO');
  const PL = emoji('PLUS');
  const GP = emoji('GAMEPASS');

  const plus = precoPor1000(d, 'plus');
  const gp = precoPor1000(d, 'gamepass');
  const preco = (qtd) => reais(plus * (qtd / 1000));
  const num = (n) => n.toLocaleString('pt-BR');
  const VAZIO = '\u200b';

  const embeds = [];

  const principal = new EmbedBuilder()
    .setColor(COR_MARCA)
    .setDescription(
      `# ${R}  ${NOME_LOJA}\n` +
      '### Compre Robux com segurança\n' +
      '-# Atendimento individual por ticket, do pedido até a entrega'
    );

  principal.addFields(
    { name: '🚀  FORMAS DE ENTREGA', value: VAZIO, inline: false },
    {
      name: `${PL}  Roblox Plus`,
      value: `**Envio direto**\n> Sem taxa de transação\n-# ⚠️ Limite de ${LIMITE_PLUS} Robux/dia`,
      inline: true
    },
    {
      name: `${GP}  Gamepass`,
      value: '**Sem limite diário**\n> Você cria, nós compramos\n-# Taxa de 30% inclusa',
      inline: true
    },
    {
      name: `${P}  Pagamento`,
      value: '**Pix automático**\n> Aprovação em instantes\n-# Sem enviar comprovante',
      inline: true
    }
  );

  const populares = [1000, 5000, 10000].filter(q => q <= d.estoque);
  if (populares.length) {
    principal.addFields({ name: '🔥  PACOTES POPULARES', value: VAZIO, inline: false });
    populares.forEach(q => principal.addFields({
      name: `${R}  ${num(q)} Robux`,
      value: `**${preco(q)}**`,
      inline: true
    }));
  }

  const melhor = [100000, 50000].find(q => q <= d.estoque);
  if (melhor) {
    principal.addFields({
      name: '💰  MELHOR OFERTA',
      value: `${R} **${num(melhor)} Robux** por **${preco(melhor)}**`,
      inline: false
    });
  }

  principal.addFields({
    name: '📋  COMO FUNCIONA',
    value:
      '**1.** Clique em **Comprar Robux**\n' +
      '**2.** Escolha a forma de entrega\n' +
      '**3.** Pague o Pix gerado no seu ticket e receba por lá',
    inline: false
  });

  principal.addFields({
    name: '🛡️  INFORMAÇÕES',
    value:
      `• Pedido mínimo de **${PEDIDO_MINIMO} Robux**\n` +
      `• Via Roblox Plus: máximo de **${LIMITE_PLUS} Robux por dia**\n` +
      '• Quantidade máxima = **estoque disponível**\n' +
      '• Nossa equipe __nunca__ pede senha ou códigos de verificação\n' +
      '-# Valores via Roblox Plus. O preço do Gamepass é calculado no ticket.',
    inline: false
  });

  principal
    .setFooter({ text: `${NOME_LOJA}  •  Compre pelo botão abaixo`, iconURL: client.user.displayAvatarURL() })
    .setTimestamp();

  if (client.user.avatar) principal.setThumbnail(client.user.displayAvatarURL({ size: 256 }));

  // O banner fica no fim do mesmo embed (mesma mensagem, sem separação).
  if (temBanner) principal.setImage('attachment://banner.png');

  embeds.push(principal);
  return embeds;
}

function painelBotoes() {
  const botaoPrecos = process.env.PRECOS_CHANNEL
    ? new ButtonBuilder()
        .setLabel('Ver preços')
        .setEmoji('💰')
        .setStyle(ButtonStyle.Link)
        .setURL(`https://discord.com/channels/${process.env.GUILD_ID}/${process.env.PRECOS_CHANNEL}`)
    : new ButtonBuilder().setCustomId('painel:precos').setLabel('Ver preços').setEmoji('💰').setStyle(ButtonStyle.Secondary);

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('painel:comprar').setLabel('Comprar Robux').setEmoji(emojiBotao('ROBUX', '🪙')).setStyle(ButtonStyle.Success),
    botaoPrecos,
    new ButtonBuilder().setCustomId('painel:gamepass').setLabel('Calcular gamepass').setEmoji('🧮').setStyle(ButtonStyle.Secondary)
  );
}

function escolhaMetodoEmbed() {
  return new EmbedBuilder()
    .setColor(COR_MARCA)
    .setDescription(
      '## 📦 Forma de entrega\n' +
      '-# Selecione como deseja receber seus Robux\n\n' +
      `**Roblox Plus** ${emoji('PLUS')}\n` +
      '> Envio direto para a sua conta, sem taxa de transação.\n' +
      `> ⚠️ **Limite diário de envio: ${LIMITE_PLUS} Robux por dia.** Pedidos via Plus podem ter no máximo ${LIMITE_PLUS} Robux.\n\n` +
      `**Gamepass** ${emoji('GAMEPASS')}\n` +
      '> Você cria um gamepass e nossa equipe o compra. A taxa de 30% do Roblox já é considerada no valor do gamepass.'
    );
}

function escolhaMetodoBotoes() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('metodo:plus').setLabel('Roblox Plus').setEmoji(emojiBotao('PLUS', '⭐')).setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('metodo:gamepass').setLabel('Gamepass').setEmoji(emojiBotao('GAMEPASS', '🎮')).setStyle(ButtonStyle.Secondary)
  );
}

function catalogoEmbed(d) {
  const pPlus = precoPor1000(d, 'plus');
  const pGp = precoPor1000(d, 'gamepass');
  const linha = (qtd) =>
    `${qtd.toLocaleString('pt-BR').padEnd(8)}${reais(pPlus * (qtd / 1000)).padEnd(14)}${reais(pGp * (qtd / 1000))}`;
  const tabela =
    '```\n' +
    `${'Robux'.padEnd(8)}${'Roblox Plus'.padEnd(14)}Gamepass\n` +
    `${'-'.repeat(34)}\n` +
    [PEDIDO_MINIMO, 500, 1000, 5000, 10000].map(linha).join('\n') +
    '\n```';
  return new EmbedBuilder()
    .setColor(COR_MARCA)
    .setDescription(
      '## 💰 Tabela de preços\n' +
      '-# Valores por quantidade de Robux\n\n' +
      `${tabela}\n` +
      `> **Estoque disponível:** ${d.estoque.toLocaleString('pt-BR')} Robux\n` +
      `> **Limite via Roblox Plus:** ${LIMITE_PLUS} Robux por dia\n` +
      '-# O valor do gamepass é calculado no ticket, considerando a taxa de 30% do Roblox.'
    )
    .setFooter({ text: `${NOME_LOJA}  |  Pedido mínimo: ${PEDIDO_MINIMO} Robux` });
}

function modalCompra(metodo) {
  const modal = new ModalBuilder()
    .setCustomId(`modal_comprar:${metodo}`)
    .setTitle(`Comprar Robux | ${METODOS[metodo]}`)
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('quantidade')
          .setLabel(metodo === 'plus'
            ? `Quantidade de Robux (${PEDIDO_MINIMO} a ${LIMITE_PLUS})`
            : `Quantidade de Robux (mínimo ${PEDIDO_MINIMO})`)
          .setStyle(TextInputStyle.Short)
          .setPlaceholder(metodo === 'plus' ? `Ex: ${LIMITE_PLUS}` : 'Ex: 1000')
          .setRequired(true)
          .setMaxLength(8)
      )
    );

  if (metodo === 'plus') {
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('usuario')
          .setLabel('Seu nome de usuário no Roblox')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Ex: NomeDeUsuario123')
          .setRequired(true)
          .setMinLength(3)
          .setMaxLength(20)
      )
    );
  }
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('cupom')
        .setLabel('Cupom de desconto (opcional)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('Deixe em branco se não tiver')
        .setRequired(false)
        .setMaxLength(20)
    )
  );
  return modal;
}

function modalGamepass() {
  return new ModalBuilder()
    .setCustomId('modal_gamepass')
    .setTitle('Calcular gamepass')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('quantidade')
          .setLabel('Quantos Robux você quer receber?')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Ex: 1000')
          .setRequired(true)
          .setMaxLength(8)
      )
    );
}

// status: 'aguardando_pagamento' -> link de pagamento (se houver) + confirmar pagamento (staff) + cancelar
//         'pago'                 -> confirmar entrega (staff) + cancelar
function botoesTicket(status, id, linkPagamento) {
  const row = new ActionRowBuilder();
  if (status === 'aguardando_pagamento') {
    if (linkPagamento && /^https?:\/\//i.test(linkPagamento)) {
      row.addComponents(
        new ButtonBuilder().setLabel('Abrir página de pagamento').setEmoji('💠').setStyle(ButtonStyle.Link).setURL(linkPagamento)
      );
    }
    row.addComponents(
      new ButtonBuilder().setCustomId(`confirmarpag:${id}`).setLabel('Confirmar pagamento').setEmoji('💰').setStyle(ButtonStyle.Success)
    );
  } else {
    row.addComponents(
      new ButtonBuilder().setCustomId(`entregar:${id}`).setLabel('Confirmar entrega (staff)').setEmoji('✅').setStyle(ButtonStyle.Primary)
    );
  }
  row.addComponents(
    new ButtonBuilder().setCustomId(`cancelar:${id}`).setLabel('Cancelar pedido').setEmoji('🚫').setStyle(ButtonStyle.Danger)
  );
  return row;
}

// ---------- COMANDOS ----------
const commands = [
  new SlashCommandBuilder()
    .setName('painel')
    .setDescription('[STAFF] Envia o painel de compras neste canal')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder().setName('catalogo').setDescription('Mostra preços e estoque'),

  new SlashCommandBuilder()
    .setName('gamepass')
    .setDescription('Calcula o preço do gamepass considerando a taxa de 30%')
    .addIntegerOption(o => o.setName('quantidade')
      .setDescription('Robux que você quer receber').setRequired(true).setMinValue(1)),

  new SlashCommandBuilder()
    .setName('config')
    .setDescription('[STAFF] Configurações da loja')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addNumberOption(o => o.setName('preco').setDescription('Preço por 1000 Robux via Gamepass (R$)').setMinValue(0.01))
    .addNumberOption(o => o.setName('preco_plus').setDescription('Preço por 1000 Robux via Roblox Plus (R$)').setMinValue(0.01))
    .addIntegerOption(o => o.setName('estoque').setDescription('Estoque atual de Robux').setMinValue(0)),

  new SlashCommandBuilder()
    .setName('cupom')
    .setDescription('[STAFF] Gerencia os cupons de desconto')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(s => s
      .setName('criar')
      .setDescription('Cria um cupom de desconto')
      .addStringOption(o => o.setName('codigo').setDescription('Código do cupom, ex: PROMO10').setRequired(true).setMaxLength(20))
      .addStringOption(o => o.setName('tipo').setDescription('Tipo de desconto').setRequired(true)
        .addChoices({ name: 'Porcentagem (%)', value: 'percentual' }, { name: 'Valor fixo (R$)', value: 'fixo' }))
      .addNumberOption(o => o.setName('valor').setDescription('Quanto de desconto (% ou R$, conforme o tipo)').setRequired(true).setMinValue(0.01))
      .addIntegerOption(o => o.setName('usos').setDescription('Limite de usos (0 ou vazio = ilimitado)').setMinValue(0))
      .addIntegerOption(o => o.setName('validade_dias').setDescription('Validade em dias (vazio = sem validade)').setMinValue(1)))
    .addSubcommand(s => s
      .setName('remover')
      .setDescription('Remove um cupom')
      .addStringOption(o => o.setName('codigo').setDescription('Código do cupom').setRequired(true)))
    .addSubcommand(s => s
      .setName('listar')
      .setDescription('Lista os cupons cadastrados')),

  new SlashCommandBuilder()
    .setName('entregar')
    .setDescription('[STAFF] Confirma entrega de um pedido')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addStringOption(o => o.setName('pedido').setDescription('Número do pedido, ex: 0001').setRequired(true))
].map(c => c.toJSON());

// ---------- SERVIDOR WEB (mantém o Render vivo + recebe o webhook da Sharpify) ----------
const servidor = http.createServer((req, res) => {
  const rota = (req.url || '/').split('?')[0];

  if (req.method === 'POST' && rota === '/sharpify-webhook') {
    if (!segredoConfere(req.headers['x-webhook-secret'])) {
      res.writeHead(401);
      return res.end('unauthorized');
    }
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) req.destroy();
    });
    req.on('end', () => {
      let depois = null;
      try {
        depois = processarWebhook(JSON.parse(raw));
      } catch (e) {
        console.error('Erro no webhook:', e);
        res.writeHead(500);
        return res.end('error'); // a Sharpify tenta de novo
      }
      res.writeHead(200);
      res.end('ok');
      if (depois) depois().catch((e) => console.error('Erro ao avisar no Discord:', e));
    });
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Bot online');
});
servidor.listen(process.env.PORT || 3000, () => console.log(`Servidor web na porta ${process.env.PORT || 3000}`));

// Devolve uma função para rodar DEPOIS de responder 2xx à Sharpify
// (ela espera no máximo 15s pela resposta e repete a entrega se demorar).
function processarWebhook(payload) {
  const nome = payload && payload.event && payload.event.name;
  const link = payload && payload.data && payload.data.paymentLink;
  if (!nome || !link) return null;
  // O id do link também vem em event.contextId.
  const dados = { ...link, id: link.id || payload.event.contextId };

  if (nome === 'PAYMENT_LINK_APPROVED') {
    const r = registrarAprovacao(dados);
    return () => notificarAprovacao(r);
  }
  if (nome === 'PAYMENT_LINK_CANCELLED') {
    const r = registrarCancelamento(dados);
    return () => notificarCancelamento(r);
  }
  return null;
}

// ---------- PAGAMENTO CONFIRMADO / CANCELADO ----------
// "registrar" só mexe no db.json (rápido, sem esperas). Por isso é seguro mesmo
// se o webhook for repetido ou chegar junto com a consulta periódica.
function registrarAprovacao(link) {
  const d = db();
  const id = Object.keys(d.pedidos).find(k => d.pedidos[k].paymentLinkId === link.id);
  if (!id) return { tipo: 'sem_pedido', link };

  const p = d.pedidos[id];
  if (p.status === 'pago' || p.status === 'entregue') return null; // já tratado
  if (p.status === 'cancelado') return { tipo: 'pedido_cancelado', id, p };

  p.status = 'pago';
  p.pagoEm = Date.now();
  save(d);
  return { tipo: 'ok', id, p };
}

async function notificarAprovacao(r) {
  if (!r) return;

  if (r.tipo === 'sem_pedido') {
    await log(
      '⚠️ Pagamento sem pedido correspondente',
      `A Sharpify aprovou um pagamento que o bot não encontrou.\n**Link:** \`${r.link.id}\`\n**Nome:** ${r.link.name || 'sem nome'}\n**Valor:** ${r.link.payment ? reais(r.link.payment.amount) : 'desconhecido'}\nConfira em Transações na Sharpify e atenda o cliente manualmente.`,
      COR_ERRO
    );
    return;
  }

  const { id, p } = r;

  if (r.tipo === 'pedido_cancelado') {
    await log(
      `⚠️ Pagamento recebido de pedido cancelado | #${id}`,
      `O cliente <@${p.userId}> pagou ${reais(p.valor)} depois do pedido ser cancelado.\nÉ preciso reembolsar ou refazer o pedido manualmente.`,
      COR_ERRO
    );
    return;
  }

  const canal = await client.channels.fetch(p.canal).catch(() => null);
  if (canal) {
    if (p.mensagemId) {
      const msg = await canal.messages.fetch(p.mensagemId).catch(() => null);
      if (msg) await msg.edit({ components: [botoesTicket('pago', id)] }).catch(() => {});
    }
    const embed = new EmbedBuilder()
      .setColor(COR_MARCA)
      .setDescription(
        '### ✅ Pagamento confirmado\n' +
        `> O pagamento de **${reais(p.valor)}** foi aprovado automaticamente.\n` +
        '-# Nossa equipe vai concluir a entrega em instantes.'
      )
      .setFooter({ text: `${NOME_LOJA}  |  Pedido #${id}` });
    await canal.send({ content: `<@${p.userId}> <@&${process.env.STAFF_ROLE}>`, embeds: [embed] });
  }

  await log(
    `Pagamento confirmado | Pedido #${id}`,
    `**Comprador:** <@${p.userId}>\n**Valor:** ${reais(p.valor)}\n**Quantidade:** ${p.quantidade} Robux (${METODOS[p.metodo || 'gamepass']})\n**Canal:** <#${p.canal}>`
  );
}

// Confirmação manual feita pela staff (botão "Confirmar pagamento" no ticket).
function registrarConfirmacaoManual(id, staffId) {
  const d = db();
  const p = d.pedidos[id];
  if (!p) return { ok: false, msg: 'Pedido não encontrado.' };
  if (p.status === 'pago') return { ok: false, msg: 'O pagamento desse pedido já foi confirmado.' };
  if (p.status === 'entregue') return { ok: false, msg: 'Esse pedido já foi entregue.' };
  if (p.status === 'cancelado') return { ok: false, msg: 'Esse pedido foi cancelado.' };

  p.status = 'pago';
  p.pagoEm = Date.now();
  p.confirmadoManualPor = staffId;
  save(d);
  return { ok: true, id, p };
}

async function notificarConfirmacaoManual(r, staffId, mensagemDoBotao) {
  const { id, p } = r;

  // Troca os botões da mensagem do Pix (agora aparece "Confirmar entrega").
  if (mensagemDoBotao) {
    await mensagemDoBotao.edit({ components: [botoesTicket('pago', id)] }).catch(() => {});
  }

  const canal = await client.channels.fetch(p.canal).catch(() => null);
  if (canal) {
    const embed = new EmbedBuilder()
      .setColor(COR_MARCA)
      .setDescription(
        '### ✅ Pagamento confirmado\n' +
        `> O pagamento de **${reais(p.valor)}** foi confirmado pela equipe (<@${staffId}>).\n` +
        '-# Nossa equipe vai concluir a entrega em instantes.'
      )
      .setFooter({ text: `${NOME_LOJA}  |  Pedido #${id}` });
    await canal.send({ content: `<@${p.userId}>`, embeds: [embed] });
  }

  await log(
    `Pagamento confirmado manualmente | Pedido #${id}`,
    `**Comprador:** <@${p.userId}>\n**Valor:** ${reais(p.valor)}\n**Quantidade:** ${p.quantidade} Robux (${METODOS[p.metodo || 'gamepass']})\n**Confirmado por:** <@${staffId}>\n**Canal:** <#${p.canal}>`
  );
}

function registrarCancelamento(link) {
  const d = db();
  const id = Object.keys(d.pedidos).find(k => d.pedidos[k].paymentLinkId === link.id);
  if (!id) return null;
  const p = d.pedidos[id];
  if (p.status !== 'aguardando_pagamento') return null;

  liberarCupom(d, p);
  p.status = 'cancelado';
  save(d);
  return { id, p };
}

async function notificarCancelamento(r) {
  if (!r) return;
  const { id, p } = r;

  const canal = await client.channels.fetch(p.canal).catch(() => null);
  if (canal) {
    const embed = new EmbedBuilder()
      .setColor(COR_ERRO)
      .setDescription(
        '### 🚫 Pagamento expirado ou cancelado\n' +
        '-# Este canal será apagado em 15 segundos. Abra um novo pedido quando quiser.'
      );
    await canal.send({ content: `<@${p.userId}>`, embeds: [embed] }).catch(() => {});
    setTimeout(() => canal.delete().catch(() => {}), 15_000);
  }
  await log(`Pedido #${id} cancelado (pagamento)`, `**Comprador:** <@${p.userId}>\nO link de pagamento expirou ou foi cancelado.`, COR_ERRO);
}

// Reserva: se o webhook não chegar (Render dormindo, por exemplo), consulta a Sharpify.
let ultimoErroConsulta = '';
async function verificarPendentes() {
  let d;
  try { d = db(); } catch { return; }
  const limite = Date.now() - 24 * 60 * 60 * 1000;
  const pendentes = Object.values(d.pedidos).filter(
    p => p.status === 'aguardando_pagamento' && p.paymentLinkId && p.criadoEm > limite
  );
  for (const p of pendentes) {
    try {
      const link = await consultarPagamento(p.paymentLinkId);
      const dados = { ...link, id: (link && link.id) || p.paymentLinkId };
      if (link && link.status === 'APPROVED') await notificarAprovacao(registrarAprovacao(dados));
      else if (link && link.status === 'CANCELLED') await notificarCancelamento(registrarCancelamento(dados));
      ultimoErroConsulta = '';
    } catch (e) {
      if (e.message !== ultimoErroConsulta) {
        console.error('Consulta de pagamento falhou:', e.message);
        ultimoErroConsulta = e.message;
      }
    }
  }
}

// ---------- REGISTRO ----------
client.once(Events.ClientReady, async () => {
  const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
  await rest.put(
    Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
    { body: commands }
  );
  console.log(`Online como ${client.user.tag}`);
  await carregarEmojis();
  console.log(fs.existsSync(CAMINHO_BANNER) ? `Banner encontrado: ${CAMINHO_BANNER}` : `ATENÇÃO: banner.png NÃO encontrado. Coloque em: ${CAMINHO_BANNER}`);
  console.log(PUBLIC_URL
    ? `Webhook da Sharpify: ${PUBLIC_URL}/sharpify-webhook`
    : 'ATENÇÃO: sem URL pública (RENDER_EXTERNAL_URL/PUBLIC_URL). Só a consulta periódica vai confirmar pagamentos.');
  verificarPendentes().catch(() => {});
  setInterval(() => verificarPendentes().catch(() => {}), 30_000);
});

// ---------- INTERAÇÕES ----------
client.on(Events.InteractionCreate, async (i) => {
  try {
    if (i.isChatInputCommand()) await handleCommand(i);
    else if (i.isButton()) await handleButton(i);
    else if (i.isModalSubmit()) await handleModal(i);
  } catch (err) {
    console.error(err);
    const msg = { content: 'Erro interno. Avise a equipe.', flags: ephemeral };
    if (i.replied || i.deferred) i.followUp(msg).catch(() => {});
    else i.reply(msg).catch(() => {});
  }
});

// ---------- ENTREGA ----------
async function entregarPedido(id, staffId) {
  const d = db();
  const p = d.pedidos[id];

  if (!p) return { ok: false, msg: 'Pedido não encontrado.' };
  if (p.status === 'entregue') return { ok: false, msg: 'Esse pedido já foi entregue.' };
  if (p.status === 'cancelado') return { ok: false, msg: 'Esse pedido foi cancelado.' };
  if (p.status !== 'pago') return { ok: false, msg: 'O pagamento desse pedido ainda não foi confirmado.' };
  if (p.quantidade > d.estoque) return { ok: false, msg: 'Estoque insuficiente.' };

  const metodo = p.metodo || 'gamepass';

  d.estoque -= p.quantidade;
  p.status = 'entregue';
  p.entregueEm = Date.now();
  p.entreguePor = staffId;
  save(d);

  await log(
    `Pedido #${id} entregue`,
    `**Comprador:** <@${p.userId}>\n**Quantidade:** ${p.quantidade} Robux\n**Forma de entrega:** ${METODOS[metodo]}\n**Valor:** ${reais(p.valor)}\n**Entregue por:** <@${staffId}>`
  );

  let cargoDado = false;
  if (process.env.CLIENTE_ROLE) {
    try {
      const guild = await client.guilds.fetch(process.env.GUILD_ID);
      const membro = await guild.members.fetch(p.userId);
      await membro.roles.add(process.env.CLIENTE_ROLE);
      cargoDado = true;
    } catch (e) {
      console.error('Não consegui dar o cargo de cliente:', e.message);
    }
  }

  if (process.env.VENDAS_CHANNEL) {
    try {
      const canalVendas = await client.channels.fetch(process.env.VENDAS_CHANNEL);
      const vendaEmbed = new EmbedBuilder()
        .setColor(COR_MARCA)
        .setAuthor({ name: NOME_LOJA, iconURL: client.user.displayAvatarURL() })
        .setDescription(
          '## ✅ Compra realizada\n' +
          `> **Cliente:** <@${p.userId}>\n` +
          `> **Quantidade:** ${comEmoji('ROBUX', `${p.quantidade.toLocaleString('pt-BR')} Robux`)}\n` +
          `> **Entrega:** ${METODOS[metodo]}\n` +
          `> **Pedido:** #${id}\n\n` +
          '-# Obrigado pela confiança'
        )
        .setFooter({ text: `${NOME_LOJA}  |  Vendas` })
        .setTimestamp();
      await canalVendas.send({ embeds: [vendaEmbed] });
    } catch (e) {
      console.error('Não consegui enviar no canal de vendas:', e.message);
    }
  }

  const canal = await client.channels.fetch(p.canal).catch(() => null);
  if (canal) {
    const detalhe = metodo === 'plus'
      ? `Os Robux foram enviados para a conta **${p.usuarioRoblox}** via Roblox Plus.`
      : 'A compra do seu gamepass foi concluída.';
    const embed = new EmbedBuilder()
      .setColor(COR_MARCA)
      .setDescription(
        '# ✅ Pedido entregue\n' +
        `-# Pedido #${id}\n\n` +
        `<@${p.userId}>, seu pedido de ${comEmoji('ROBUX', `**${p.quantidade.toLocaleString('pt-BR')} Robux**`)} foi concluído.\n` +
        `> ${detalhe}\n\n` +
        `Obrigado pela compra.${cargoDado ? `\nVocê recebeu o cargo <@&${process.env.CLIENTE_ROLE}>.` : ''}\n\n` +
        '-# Este canal será apagado em 30 segundos.'
      )
      .setFooter({ text: `${NOME_LOJA}  |  Pedido #${id}` });
    await canal.send({ content: `<@${p.userId}>`, embeds: [embed] });
    setTimeout(() => canal.delete().catch(() => {}), 30_000);
  }
  return { ok: true, msg: `Pedido #${id} marcado como entregue.` };
}

// ---------- CRIAR TICKET ----------
async function criarTicket(i, q, metodo, usuarioRoblox, cupomCodigo) {
  const d0 = db();
  const valorBase = arredondar((q / 1000) * precoPor1000(d0, metodo));
  let valor = valorBase;
  let desconto = 0;
  if (cupomCodigo) {
    const v = validarCupom(d0, cupomCodigo);
    if (!v.ok) throw new Error(`CUPOM:${v.msg}`);
    const r = aplicarDesconto(valorBase, v.cupom);
    valor = r.final;
    desconto = r.desconto;
  }
  const numero = d0.contador + 1;
  const id = String(numero).padStart(4, '0');

  // Reserva o número do pedido antes de qualquer espera.
  d0.contador = numero;
  save(d0);

  // 1) Gera a cobrança Pix na Sharpify. Se falhar, nenhum canal é criado.
  const link = await criarPagamento(id, valor, q);
  const gw = (link.payment && link.payment.gateway && link.payment.gateway.data) || {};
  const qr = interpretarQr(gw.qrCode);
  const codigoPix = gw.code || (!qr && typeof gw.qrCode === 'string' ? gw.qrCode : null);
  const urlPagamento = gw.paymentLink || null;
  const expira = link.payment && link.payment.gateway && link.payment.gateway.expirationDate
    ? Math.floor(new Date(link.payment.gateway.expirationDate).getTime() / 1000)
    : null;

  // 2) Cria o canal do ticket.
  const opcoesCanal = {
    name: `pedido-${id}`,
    type: ChannelType.GuildText,
    topic: `Pedido #${id} | ${q} Robux | ${METODOS[metodo]} | Comprador: ${i.user.tag}`,
    permissionOverwrites: [
      { id: i.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: i.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles] },
      { id: process.env.STAFF_ROLE, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles] },
      { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels] }
    ]
  };

  let canal;
  try {
    canal = await i.guild.channels.create({ ...opcoesCanal, parent: process.env.CATEGORIA_TICKETS || null });
  } catch (e1) {
    canal = await i.guild.channels.create(opcoesCanal);
  }

  // 3) Salva o pedido ligado ao link de pagamento.
  const d = db();
  d.pedidos[id] = {
    userId: i.user.id, quantidade: q, valor, canal: canal.id,
    metodo, usuarioRoblox: usuarioRoblox || null,
    paymentLinkId: link.id,
    cupom: cupomCodigo || null, valorOriginal: valorBase, desconto,
    status: 'aguardando_pagamento', criadoEm: Date.now()
  };
  if (cupomCodigo && d.cupons && d.cupons[cupomCodigo]) d.cupons[cupomCodigo].usos += 1;
  save(d);

  const dados = [
    `> **Quantidade:** ${comEmoji('ROBUX', `${q.toLocaleString('pt-BR')} Robux`)}`,
    `> **Valor a pagar:** ${reais(valor)}`,
    ...(cupomCodigo ? [`> **Cupom:** \`${cupomCodigo}\` (-${reais(desconto)})`] : []),
    `> **Forma de entrega:** ${METODOS[metodo]}${metodo === 'plus' ? ` (limite de ${LIMITE_PLUS} Robux por dia)` : ''}`
  ];

  let passos;
  if (metodo === 'plus') {
    dados.push(`> **Usuário no Roblox:** \`${usuarioRoblox}\``);
    passos =
      '**1.** Pague o Pix acima (QR Code ou copia e cola).\n' +
      '**2.** O pagamento é confirmado **automaticamente**, sem enviar comprovante.\n' +
      '**3.** Após a confirmação, nossa equipe envia os Robux via Roblox Plus.';
  } else {
    dados.push(`> **Preço do gamepass:** ${precoGamepass(q).toLocaleString('pt-BR')} Robux`);
    passos =
      '**1.** Pague o Pix acima (QR Code ou copia e cola).\n' +
      '**2.** O pagamento é confirmado **automaticamente**, sem enviar comprovante.\n' +
      `**3.** Crie um gamepass de **${precoGamepass(q).toLocaleString('pt-BR')} Robux** no Roblox e envie o link neste canal.\n` +
      '**4.** Após a confirmação, nossa equipe comprará o seu gamepass.';
  }

  const blocoPix = codigoPix
    ? `**Pix copia e cola:**\n\`\`\`\n${codigoPix}\n\`\`\`\n`
    : (urlPagamento ? '-# Use o botão **Abrir página de pagamento** abaixo.\n\n' : '-# Aguarde, o código Pix está sendo preparado. Se não aparecer, avise a equipe.\n\n');

  const embed = new EmbedBuilder()
    .setColor(COR_ESPERA)
    .setAuthor({ name: NOME_LOJA, iconURL: client.user.displayAvatarURL() })
    .setDescription(
      `# 🧾 Pedido #${id}\n` +
      `-# Olá, <@${i.user.id}>. Siga as etapas abaixo para concluir a sua compra.\n\n` +
      `${dados.join('\n')}\n\n` +
      `${LINHA}\n\n` +
      `### ${comEmoji('PIX', 'Pagamento via Pix')}\n` +
      blocoPix +
      (expira ? `-# O Pix expira <t:${expira}:R>.\n\n` : '') +
      '### 📌 Próximos passos\n' +
      `${passos}\n\n` +
      '-# Nunca envie sua senha ou códigos de verificação. Nossa equipe __não__ solicita esses dados.'
    )
    .setFooter({ text: `${NOME_LOJA}  |  Pedido #${id}` });

  const envio = {
    content: `<@${i.user.id}>`,
    embeds: [embed],
    components: [botoesTicket('aguardando_pagamento', id, urlPagamento)]
  };
  if (qr && qr.url) {
    embed.setImage(qr.url);
  } else if (qr && qr.buffer) {
    embed.setImage('attachment://qrcode.png');
    envio.files = [new AttachmentBuilder(qr.buffer, { name: 'qrcode.png' })];
  }

  const msg = await canal.send(envio);
  const d2 = db();
  if (d2.pedidos[id]) { d2.pedidos[id].mensagemId = msg.id; save(d2); }

  await log(
    `Pedido #${id} criado`,
    `**Comprador:** <@${i.user.id}>\n**Quantidade:** ${q} Robux\n**Forma de entrega:** ${METODOS[metodo]}\n` +
    `${metodo === 'plus' ? `**Usuário Roblox:** ${usuarioRoblox}\n` : ''}**Valor:** ${reais(valor)}\n${cupomCodigo ? `**Cupom:** ${cupomCodigo} (-${reais(desconto)})\n` : ''}**Canal:** ${canal}`,
    COR_ESPERA
  );

  return canal;
}

// ---------- COMANDOS ----------
async function handleCommand(i) {
  const d = db();

  if (i.commandName === 'painel') {
    const temBanner = fs.existsSync(CAMINHO_BANNER);
    const payload = { embeds: painelEmbeds(d, temBanner), components: [painelBotoes()] };
    if (temBanner) payload.files = [new AttachmentBuilder(CAMINHO_BANNER, { name: 'banner.png' })];
    await i.channel.send(payload);
    return i.reply({
      content: temBanner ? 'Painel enviado neste canal.' : `Painel enviado sem banner (banner.png não encontrado em: ${CAMINHO_BANNER}).`,
      flags: ephemeral
    });
  }

  if (i.commandName === 'catalogo') {
    return i.reply({ embeds: [catalogoEmbed(d)] });
  }

  if (i.commandName === 'gamepass') {
    const q = i.options.getInteger('quantidade');
    return responderEfemera(i, {
      content: `Para receber **${q}** Robux líquidos, crie o gamepass por **${precoGamepass(q)}** Robux.`
    });
  }

  if (i.commandName === 'config') {
    const preco = i.options.getNumber('preco');
    const precoPlus = i.options.getNumber('preco_plus');
    const estoque = i.options.getInteger('estoque');

    if (preco !== null) d.precoPor1000 = preco;
    if (precoPlus !== null) d.precoPlusPor1000 = precoPlus;
    if (estoque !== null) d.estoque = estoque;
    save(d);

    return i.reply({
      content:
        'Configurações atualizadas.\n' +
        `Preço por 1.000 (Gamepass): ${reais(d.precoPor1000)}\n` +
        `Preço por 1.000 (Roblox Plus): ${reais(precoPor1000(d, 'plus'))}\n` +
        `Estoque: ${d.estoque}`,
      flags: ephemeral
    });
  }

  if (i.commandName === 'cupom') {
    if (!ehStaff(i)) {
      return i.reply({ content: 'Somente a equipe pode usar este comando.', flags: ephemeral });
    }
    d.cupons = d.cupons || {};
    const sub = i.options.getSubcommand();

    if (sub === 'criar') {
      const codigo = normalizarCupom(i.options.getString('codigo'));
      const tipo = i.options.getString('tipo');
      const valor = i.options.getNumber('valor');
      const usosMax = i.options.getInteger('usos') ?? 0;
      const dias = i.options.getInteger('validade_dias');

      if (!/^[A-Z0-9_-]{3,20}$/.test(codigo)) {
        return i.reply({ content: 'Código inválido. Use de 3 a 20 caracteres: letras, números, hífen ou underline.', flags: ephemeral });
      }
      if (d.cupons[codigo]) {
        return i.reply({ content: `O cupom \`${codigo}\` já existe. Remova-o antes de criar de novo.`, flags: ephemeral });
      }
      if (tipo === 'percentual' && valor > 100) {
        return i.reply({ content: 'A porcentagem não pode passar de 100.', flags: ephemeral });
      }

      d.cupons[codigo] = {
        tipo, valor, usosMax, usos: 0,
        expiraEm: dias ? Date.now() + dias * 24 * 60 * 60 * 1000 : null,
        criadoPor: i.user.id, criadoEm: Date.now()
      };
      save(d);

      await log(
        `Cupom criado | ${codigo}`,
        `**Desconto:** ${descricaoCupom(d.cupons[codigo])}\n**Limite de usos:** ${usosMax || 'ilimitado'}\n**Validade:** ${dias ? `${dias} dia(s)` : 'sem validade'}\n**Criado por:** <@${i.user.id}>`
      );
      return i.reply({
        content:
          `Cupom \`${codigo}\` criado.\n` +
          `Desconto: ${descricaoCupom(d.cupons[codigo])}\n` +
          `Limite de usos: ${usosMax || 'ilimitado'}\n` +
          `Validade: ${dias ? `${dias} dia(s)` : 'sem validade'}`,
        flags: ephemeral
      });
    }

    if (sub === 'remover') {
      const codigo = normalizarCupom(i.options.getString('codigo'));
      if (!d.cupons[codigo]) {
        return i.reply({ content: 'Cupom não encontrado.', flags: ephemeral });
      }
      delete d.cupons[codigo];
      save(d);
      await log(`Cupom removido | ${codigo}`, `**Removido por:** <@${i.user.id}>`, COR_ERRO);
      return i.reply({ content: `Cupom \`${codigo}\` removido.`, flags: ephemeral });
    }

    if (sub === 'listar') {
      const lista = Object.entries(d.cupons);
      if (!lista.length) {
        return i.reply({ content: 'Nenhum cupom cadastrado.', flags: ephemeral });
      }
      const linhas = lista.map(([codigo, c]) => {
        const usos = `${c.usos}/${c.usosMax || '∞'} usos`;
        const validade = c.expiraEm
          ? (Date.now() > c.expiraEm ? 'expirado' : `expira <t:${Math.floor(c.expiraEm / 1000)}:R>`)
          : 'sem validade';
        return `\`${codigo}\` • ${descricaoCupom(c)} • ${usos} • ${validade}`;
      });
      return i.reply({ content: linhas.join('\n').slice(0, 1900), flags: ephemeral });
    }
    return;
  }

  if (i.commandName === 'entregar') {
    if (!ehStaff(i)) {
      return i.reply({ content: 'Somente a equipe pode usar este comando.', flags: ephemeral });
    }
    const id = i.options.getString('pedido').replace('#', '').padStart(4, '0');
    const r = await entregarPedido(id, i.user.id);
    return i.reply({ content: r.msg, flags: ephemeral });
  }
}

// ---------- BOTÕES ----------
async function handleButton(i) {
  const [acao, id] = i.customId.split(':');

  if (acao === 'painel') {
    if (id === 'comprar') {
      return responderEfemera(i, { embeds: [escolhaMetodoEmbed()], components: [escolhaMetodoBotoes()] }, TEMPO_MENU);
    }
    if (id === 'gamepass') return i.showModal(modalGamepass());
    if (id === 'precos') return responderEfemera(i, { embeds: [catalogoEmbed(db())] });
    return;
  }

  if (acao === 'metodo') {
    if (!METODOS[id]) return;
    prolongarEfemera(i.user.id, 5 * 60 * 1000); // não deixa o menu sumir enquanto o formulário está aberto
    return i.showModal(modalCompra(id));
  }

  // Botão antigo "Já paguei" (tickets criados antes da Sharpify)
  if (acao === 'pago') {
    return i.reply({ content: 'O pagamento agora é confirmado automaticamente. Aguarde alguns instantes.', flags: ephemeral });
  }

  const d = db();
  const p = d.pedidos[id];
  if (!p) return i.reply({ content: 'Pedido não encontrado.', flags: ephemeral });

  if (acao === 'confirmarpag') {
    if (!ehStaff(i)) {
      return i.reply({ content: 'Somente a equipe pode confirmar o pagamento.', flags: ephemeral });
    }
    const r = registrarConfirmacaoManual(id, i.user.id);
    if (!r.ok) return i.reply({ content: r.msg, flags: ephemeral });

    await i.reply({ content: `Pagamento do pedido #${id} confirmado.`, flags: ephemeral });
    await notificarConfirmacaoManual(r, i.user.id, i.message);
    return;
  }

  if (acao === 'entregar') {
    if (!ehStaff(i)) {
      return i.reply({ content: 'Somente a equipe pode confirmar a entrega.', flags: ephemeral });
    }
    const r = await entregarPedido(id, i.user.id);
    return i.reply({ content: r.msg, flags: ephemeral });
  }

  if (acao === 'cancelar') {
    if (i.user.id !== p.userId && !ehStaff(i)) {
      return i.reply({ content: 'Você não tem permissão para isso.', flags: ephemeral });
    }
    if (p.status === 'entregue') {
      return i.reply({ content: 'Pedido já entregue, não é possível cancelar.', flags: ephemeral });
    }
    if (p.status === 'cancelado') {
      return i.reply({ content: 'Esse pedido já foi cancelado.', flags: ephemeral });
    }
    if (p.status === 'pago' && !ehStaff(i)) {
      return i.reply({ content: 'O pagamento já foi confirmado. Chame a equipe se precisar cancelar.', flags: ephemeral });
    }
    liberarCupom(d, p);
    p.status = 'cancelado';
    save(d);

    const embed = new EmbedBuilder()
      .setColor(COR_ERRO)
      .setDescription(
        '### 🚫 Pedido cancelado\n' +
        '-# Este canal será apagado em 10 segundos.\n' +
        '-# Não pague o Pix deste pedido: ele foi cancelado.'
      );
    await i.reply({ embeds: [embed] });

    await log(`Pedido #${id} cancelado`, `**Cancelado por:** <@${i.user.id}>\n**Comprador:** <@${p.userId}>`, COR_ERRO);
    setTimeout(() => i.channel.delete().catch(() => {}), 10_000);
  }
}

// ---------- JANELAS (MODAIS) ----------
async function handleModal(i) {
  const d = db();
  const [tipo, metodo] = i.customId.split(':');
  const q = lerNumero(i.fields.getTextInputValue('quantidade'));

  if (!Number.isInteger(q) || q < 1) {
    return erroModal(i, 'Digite um número inteiro. Exemplo: 1000');
  }

  if (tipo === 'modal_gamepass') {
    return responderEfemera(i, {
      content: `Para receber **${q.toLocaleString('pt-BR')}** Robux líquidos, crie o gamepass por **${precoGamepass(q).toLocaleString('pt-BR')}** Robux.`
    });
  }

  if (tipo === 'modal_comprar') {
    if (!METODOS[metodo]) return;

    if (q < PEDIDO_MINIMO) {
      return erroModal(i, `O pedido mínimo é de ${PEDIDO_MINIMO} Robux.`);
    }
    if (metodo === 'plus' && q > LIMITE_PLUS) {
      return erroModal(i, `O Roblox Plus tem limite diário de envio de **${LIMITE_PLUS} Robux**. Peça até ${LIMITE_PLUS} Robux ou escolha a entrega via **Gamepass** para quantidades maiores.`);
    }
    if (q > d.estoque) {
      return erroModal(i, `Estoque insuficiente. Disponível: ${d.estoque.toLocaleString('pt-BR')} Robux.`);
    }

    let usuario = null;
    if (metodo === 'plus') {
      usuario = i.fields.getTextInputValue('usuario').trim();
      if (!/^[A-Za-z0-9_]{3,20}$/.test(usuario)) {
        return erroModal(i, 'Nome de usuário inválido. Use apenas letras, números e underline (3 a 20 caracteres).');
      }
    }

    let cupomTxt = '';
    try { cupomTxt = i.fields.getTextInputValue('cupom'); } catch { /* campo ausente */ }
    const cupom = normalizarCupom(cupomTxt);
    if (cupom) {
      const v = validarCupom(d, cupom);
      if (!v.ok) return erroModal(i, v.msg);
    }

    const aberto = Object.values(d.pedidos).find(
      p => p.userId === i.user.id && ['aguardando_pagamento', 'aguardando_confirmacao', 'pago'].includes(p.status)
    );
    if (aberto) {
      return erroModal(i, `Você já possui um pedido em aberto: <#${aberto.canal}>`);
    }

    // Troca a mensagem "Forma de entrega" (só o cliente vê) por um aviso curto,
    // que depois vira o link do ticket.
    if (veioDeEfemera(i)) {
      await i.update({ content: 'Criando o seu ticket...', embeds: [], components: [] });
    } else {
      await i.deferReply({ flags: ephemeral });
    }
    try {
      const canal = await criarTicket(i, q, metodo, usuario, cupom || null);
      return finalizarEfemera(i, `Seu ticket foi criado: ${canal}`);
    } catch (err) {
      if (String(err.message).startsWith('CUPOM:')) {
        return finalizarEfemera(i, err.message.slice(6));
      }
      console.error('Erro ao criar o ticket:', err);
      return finalizarEfemera(i, 'Não foi possível gerar o seu Pix agora. Tente de novo em instantes ou avise a equipe.');
    }
  }
}
// COMANDO TABELA DE PREÇOS (NÃO ALTERA NADA DO SEU CÓDIGO)
client.on('messageCreate', async (message) => {
  if (message.content === '!enviartabela') {
    if (!message.member.permissions.has('Administrator')) return;
    
const tabela = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# :Roblox: TABELA DE PREÇOS — ROBUX :Robux:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

> :Money: **Valor base:** **R$ 35,00** a cada **1.000 Robux**!
> ⚠️ **Pedido mínimo:** **400 Robux**

---

### 📊 Tabela de Valores

• :Robux: **400 Robux** ── :Pix: **R$ 14,00** *(Pedido Mínimo)*
• :Robux: **800 Robux** ── :Pix: **R$ 28,00**
• :Robux: **1.000 Robux** ── :Pix: **R$ 35,00**
• :Robux: **2.000 Robux** ── :Pix: **R$ 70,00**
• :Robux: **5.000 Robux** ── :Pix: **R$ 175,00**
• :Robux: **10.000 Robux** ── :Pix: **R$ 350,00**

> 🧮 *Quer outra quantidade? Calculamos proporcionalmente (R$ 0,035 por Robux).*

---

### 🛒 Como Comprar?

1️⃣ Vá até o canal de tickets
2️⃣ Abra um ticket de atendimento
3️⃣ Digite a quantidade de :Robux: que deseja e faça o pagamento via :Pix:!

---
⚡ *Entrega rápida e 100% segura no seu :Roblox:*`;

    await message.delete().catch(() => {});
    await message.channel.send(tabela);
  }
});

iniciarBanco()
  .then(() => client.login(process.env.TOKEN))
  .catch((e) => {
    console.error('Falha ao iniciar:', e.message);
    process.exit(1);
  });
