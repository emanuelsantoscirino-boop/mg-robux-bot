const fs = require('fs');
const path = require('path');
// override: true -> o arquivo .env tem prioridade sobre variáveis já existentes no sistema/host
require('dotenv').config({
  path: fs.existsSync('.env') ? '.env' : 'rbx.env',
  override: true
});
const {
  Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, ChannelType, PermissionFlagsBits, SlashCommandBuilder,
  REST, Routes, MessageFlags, Events,
  ModalBuilder, TextInputBuilder, TextInputStyle, AttachmentBuilder
} = require('discord.js');

// ---------- CONFIGURAÇÃO ----------
const CAMINHO_BANNER = path.join(__dirname, 'banner.png');
const NOME_LOJA = 'MG ROBUX';
// Cor da marca: mude no .env com COR_MARCA=#00b06b (hex da cor da sua logo)
const corHex = parseInt(String(process.env.COR_MARCA || '00b06b').replace('#', ''), 16);
const COR_MARCA = Number.isNaN(corHex) ? 0x00b06b : corHex;
const COR_ESPERA = 0xe0a030;  // âmbar
const COR_ERRO = 0xc0392b;    // vermelho escuro

const METODOS = {
  plus: 'Roblox Plus',
  gamepass: 'Gamepass'
};

const obrigatorias = ['TOKEN', 'CLIENT_ID', 'GUILD_ID', 'STAFF_ROLE', 'LOG_CHANNEL'];
const faltando = obrigatorias.filter(v => !process.env[v]);
if (faltando.length) {
  console.error(`Faltando no arquivo .env: ${faltando.join(', ')}`);
  process.exit(1);
}

// ---------- EMOJIS ----------
// O bot procura os emojis pelo NOME no seu servidor (e nos emojis do aplicativo),
// então não depende mais de IDs digitados à mão.
// Nomes esperados no servidor: Robux, Pix, Cartao, Plus
const EMOJI_NOMES = { ROBUX: 'Robux', MONEY: 'Robux', PIX: 'Pix', CARTAO: 'Cartao', PLUS: 'Plus' };
const EMOJI_FALLBACK = { ROBUX: '🪙', MONEY: '🪙', PIX: '💠', CARTAO: '💳', PLUS: '⭐' };
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

// Emoji para botões: objeto { id, name } ou o emoji padrão (unicode)
const emojiBotao = (nome, fallback) => {
  const c = emojiCache[nome];
  return c ? { id: c.id, name: c.name, animated: c.animated } : fallback;
};

// ---------- BANCO DE DADOS (arquivo db.json) ----------
const db = () => JSON.parse(fs.readFileSync('./db.json', 'utf8'));
const save = (d) => fs.writeFileSync('./db.json', JSON.stringify(d, null, 2));

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

  const plus = precoPor1000(d, 'plus');
  const gp = precoPor1000(d, 'gamepass');
  const preco = (qtd) => reais(plus * (qtd / 1000));
  const num = (n) => n.toLocaleString('pt-BR');
  const VAZIO = '\u200b';

  const embeds = [];

  // Embed 1: banner no topo
  if (temBanner) {
    embeds.push(new EmbedBuilder().setColor(COR_MARCA).setImage('attachment://banner.png'));
  }

  // Embed 2: conteúdo
  const principal = new EmbedBuilder()
    .setColor(COR_MARCA)
    .setDescription(
      `# ${R}  ${NOME_LOJA}\n` +
      '### Compre Robux com segurança\n' +
      '-# Atendimento individual por ticket, do pedido até a entrega'
    );

  // --- Formas de entrega ---
  principal.addFields(
    { name: '🚀  FORMAS DE ENTREGA', value: VAZIO, inline: false },
    {
      name: `${PL}  Roblox Plus`,
      value: `**${reais(plus)}** / 1.000\n-# ✨ Recomendado`,
      inline: true
    },
    {
      name: '🎟️  Gamepass',
      value: `**${reais(gp)}** / 1.000\n-# Taxa de 30% inclusa`,
      inline: true
    },
    {
      name: '💳  Pagamento',
      value: `${P} Pix\n${C} Cartão`,
      inline: true
    }
  );

  // --- Pacotes populares ---
  const populares = [1000, 5000, 10000].filter(q => q <= d.estoque);
  if (populares.length) {
    principal.addFields({ name: '🔥  PACOTES POPULARES', value: VAZIO, inline: false });
    populares.forEach(q => principal.addFields({
      name: `${R}  ${num(q)} Robux`,
      value: `**${preco(q)}**`,
      inline: true
    }));
  }

  // --- Melhor oferta ---
  const melhor = [100000, 50000].find(q => q <= d.estoque);
  if (melhor) {
    principal.addFields({
      name: '💰  MELHOR OFERTA',
      value: `${R} **${num(melhor)} Robux** por **${preco(melhor)}**`,
      inline: false
    });
  }

  // --- Como funciona ---
  principal.addFields({
    name: '📋  COMO FUNCIONA',
    value:
      '**1.** Clique em **Comprar Robux**\n' +
      '**2.** Escolha a forma de entrega\n' +
      '**3.** Pague e receba tudo pelo seu ticket',
    inline: false
  });

  // --- Informações ---
  principal.addFields({
    name: '🛡️  INFORMAÇÕES',
    value:
      '• Pedido mínimo de **400 Robux**\n' +
      '• Quantidade máxima = **estoque disponível**\n' +
      '• Nossa equipe __nunca__ pede senha ou códigos de verificação\n' +
      '-# Valores via Roblox Plus. O preço do Gamepass é calculado no ticket.',
    inline: false
  });

  principal
    .setFooter({ text: `${NOME_LOJA}  •  Compre pelo botão abaixo`, iconURL: client.user.displayAvatarURL() })
    .setTimestamp();

  // Logo no canto, só se o bot tiver foto de perfil própria
  if (client.user.avatar) principal.setThumbnail(client.user.displayAvatarURL({ size: 256 }));

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
      '> Envio direto para a sua conta, sem taxa de transação.\n\n' +
      '**Gamepass**\n' +
      '> Você cria um gamepass e nossa equipe o compra. A taxa de 30% do Roblox já é considerada no valor do gamepass.'
    );
}

function escolhaMetodoBotoes() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('metodo:plus').setLabel('Roblox Plus (recomendado)').setEmoji(emojiBotao('PLUS', '⭐')).setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('metodo:gamepass').setLabel('Gamepass').setEmoji('🎟️').setStyle(ButtonStyle.Secondary)
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
    [100, 500, 1000, 5000, 10000].map(linha).join('\n') +
    '\n```';
  return new EmbedBuilder()
    .setColor(COR_MARCA)
    .setDescription(
      '## 💰 Tabela de preços\n' +
      '-# Valores por quantidade de Robux\n\n' +
      `${tabela}\n` +
      `> **Estoque disponível:** ${d.estoque.toLocaleString('pt-BR')} Robux\n` +
      '-# O valor do gamepass é calculado no ticket, considerando a taxa de 30% do Roblox.'
    )
    .setFooter({ text: `${NOME_LOJA}  |  Pedido mínimo: 100 Robux` });
}

function modalCompra(metodo) {
  const modal = new ModalBuilder()
    .setCustomId(`modal_comprar:${metodo}`)
    .setTitle(`Comprar Robux | ${METODOS[metodo]}`)
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('quantidade')
          .setLabel('Quantidade de Robux (mínimo 100)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Ex: 1000')
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

function botoesTicket(status, id) {
  const row = new ActionRowBuilder();
  if (status === 'aguardando_pagamento') {
    row.addComponents(
      new ButtonBuilder().setCustomId(`pago:${id}`).setLabel('Já paguei').setEmoji('💳').setStyle(ButtonStyle.Success)
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
    .addIntegerOption(o => o.setName('estoque').setDescription('Estoque atual de Robux').setMinValue(0))
    .addStringOption(o => o.setName('pix').setDescription('Chave Pix')),

  new SlashCommandBuilder()
    .setName('entregar')
    .setDescription('[STAFF] Confirma entrega de um pedido')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addStringOption(o => o.setName('pedido').setDescription('Número do pedido, ex: 0001').setRequired(true))
].map(c => c.toJSON());

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
  console.log('Emojis em uso:', {
    ROBUX: emoji('ROBUX'),
    PIX: emoji('PIX'),
    CARTAO: emoji('CARTAO'),
    PLUS: emoji('PLUS')
  });
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
        '-# Este canal será apagado em 1 minuto.'
      )
      .setFooter({ text: `${NOME_LOJA}  |  Pedido #${id}` });
    await canal.send({ content: `<@${p.userId}>`, embeds: [embed] });
    setTimeout(() => canal.delete().catch(() => {}), 60_000);
  }
  return { ok: true, msg: `Pedido #${id} marcado como entregue.` };
}

// ---------- CRIAR TICKET ----------
async function criarTicket(i, q, metodo, usuarioRoblox) {
  const d = db();
  const valor = Math.round((q / 1000) * precoPor1000(d, metodo) * 100) / 100;
  const numero = d.contador + 1;
  const id = String(numero).padStart(4, '0');

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
    try {
      canal = await i.guild.channels.create(opcoesCanal);
    } catch (e2) {
      throw e2;
    }
  }

  d.contador = numero;
  d.pedidos[id] = {
    userId: i.user.id, quantidade: q, valor, canal: canal.id,
    metodo, usuarioRoblox: usuarioRoblox || null,
    status: 'aguardando_pagamento', criadoEm: Date.now()
  };
  save(d);

  const dados = [
    `> **Quantidade:** ${comEmoji('ROBUX', `${q.toLocaleString('pt-BR')} Robux`)}`,
    `> **Valor a pagar:** ${reais(valor)}`,
    `> **Forma de entrega:** ${METODOS[metodo]}`
  ];

  let passos;
  if (metodo === 'plus') {
    dados.push(`> **Usuário no Roblox:** \`${usuarioRoblox}\``);
    passos =
      '**1.** Faça o pagamento no valor exato indicado acima.\n' +
      '**2.** Envie o comprovante neste canal.\n' +
      '**3.** Clique em **Já paguei**. Após conferir o pagamento, nossa equipe enviará os Robux via Roblox Plus.';
  } else {
    dados.push(`> **Preço do gamepass:** ${precoGamepass(q).toLocaleString('pt-BR')} Robux`);
    passos =
      '**1.** Faça o pagamento no valor exato indicado acima.\n' +
      '**2.** Envie o comprovante neste canal.\n' +
      `**3.** Crie um gamepass de **${precoGamepass(q).toLocaleString('pt-BR')} Robux** no Roblox e envie o link neste canal.\n` +
      '**4.** Clique em **Já paguei**. Após conferir o pagamento, nossa equipe comprará o seu gamepass.';
  }

  const embed = new EmbedBuilder()
    .setColor(COR_ESPERA)
    .setAuthor({ name: NOME_LOJA, iconURL: client.user.displayAvatarURL() })
    .setDescription(
      `# 🧾 Pedido #${id}\n` +
      `-# Olá, <@${i.user.id}>. Siga as etapas abaixo para concluir a sua compra.\n\n` +
      `${dados.join('\n')}\n\n` +
      `${LINHA}\n\n` +
      `### ${comEmoji('PIX', 'Pagamento via Pix / Cartão')} ${emoji('CARTAO')}\n` +
      `\`\`\`\n${d.pix}\n\`\`\`\n` +
      '### 📌 Próximos passos\n' +
      `${passos}\n\n` +
      '-# Nunca envie sua senha ou códigos de verificação. Nossa equipe __não__ solicita esses dados.'
    )
    .setFooter({ text: `${NOME_LOJA}  |  Pedido #${id}` });

  await canal.send({ content: `<@${i.user.id}>`, embeds: [embed], components: [botoesTicket('aguardando_pagamento', id)] });

  await log(
    `Pedido #${id} criado`,
    `**Comprador:** <@${i.user.id}>\n**Quantidade:** ${q} Robux\n**Forma de entrega:** ${METODOS[metodo]}\n` +
    `${metodo === 'plus' ? `**Usuário Roblox:** ${usuarioRoblox}\n` : ''}**Valor:** ${reais(valor)}\n**Canal:** ${canal}`,
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
    return i.reply({
      content: `Para receber **${q}** Robux líquidos, crie o gamepass por **${precoGamepass(q)}** Robux.`,
      flags: ephemeral
    });
  }

  if (i.commandName === 'config') {
    const preco = i.options.getNumber('preco');
    const precoPlus = i.options.getNumber('preco_plus');
    const estoque = i.options.getInteger('estoque');
    const pix = i.options.getString('pix');

    if (preco !== null) d.precoPor1000 = preco;
    if (precoPlus !== null) d.precoPlusPor1000 = precoPlus;
    if (estoque !== null) d.estoque = estoque;
    if (pix !== null) d.pix = pix;
    save(d);

    return i.reply({
      content:
        'Configurações atualizadas.\n' +
        `Preço por 1.000 (Gamepass): ${reais(d.precoPor1000)}\n` +
        `Preço por 1.000 (Roblox Plus): ${reais(precoPor1000(d, 'plus'))}\n` +
        `Estoque: ${d.estoque}\nChave/Info Pix: ${d.pix}`,
      flags: ephemeral
    });
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
      return i.reply({ embeds: [escolhaMetodoEmbed()], components: [escolhaMetodoBotoes()], flags: ephemeral });
    }
    if (id === 'gamepass') return i.showModal(modalGamepass());
    if (id === 'precos') return i.reply({ embeds: [catalogoEmbed(db())], flags: ephemeral });
    return;
  }

  if (acao === 'metodo') {
    if (!METODOS[id]) return;
    return i.showModal(modalCompra(id));
  }

  const d = db();
  const p = d.pedidos[id];
  if (!p) return i.reply({ content: 'Pedido não encontrado.', flags: ephemeral });

  if (acao === 'pago') {
    if (i.user.id !== p.userId) {
      return i.reply({ content: 'Somente o comprador pode usar este botão.', flags: ephemeral });
    }
    if (p.status !== 'aguardando_pagamento') {
      return i.reply({ content: 'Esse pedido já está em análise ou finalizado.', flags: ephemeral });
    }
    p.status = 'aguardando_confirmacao';
    save(d);

    await i.update({ components: [botoesTicket('aguardando_confirmacao', id)] });

    const embed = new EmbedBuilder()
      .setColor(COR_ESPERA)
      .setDescription(
        '### ⏳ Pagamento informado\n' +
        `> O comprador informou o pagamento de **${reais(p.valor)}**.\n` +
        '-# Nossa equipe irá conferir e concluir a entrega em breve.'
      )
      .setFooter({ text: `${NOME_LOJA}  |  Pedido #${id}` });
    await i.channel.send({ content: `<@&${process.env.STAFF_ROLE}>`, embeds: [embed] });

    return log(
      `Pagamento informado | Pedido #${id}`,
      `<@${p.userId}> informou o pagamento de **${reais(p.valor)}** (${p.quantidade} Robux, ${METODOS[p.metodo || 'gamepass']}).\n**Canal:** <#${p.canal}>`,
      COR_ESPERA
    );
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
    p.status = 'cancelado';
    save(d);

    const embed = new EmbedBuilder()
      .setColor(COR_ERRO)
      .setDescription(
        '### 🚫 Pedido cancelado\n' +
        '-# Este canal será apagado em 10 segundos.'
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
    return i.reply({ content: 'Digite um número inteiro. Exemplo: 1000', flags: ephemeral });
  }

  if (tipo === 'modal_gamepass') {
    return i.reply({
      content: `Para receber **${q.toLocaleString('pt-BR')}** Robux líquidos, crie o gamepass por **${precoGamepass(q).toLocaleString('pt-BR')}** Robux.`,
      flags: ephemeral
    });
  }

  if (tipo === 'modal_comprar') {
    if (!METODOS[metodo]) return;

    if (q < 100) {
      return i.reply({ content: 'O pedido mínimo é de 100 Robux.', flags: ephemeral });
    }
    if (q > d.estoque) {
      return i.reply({ content: `Estoque insuficiente. Disponível: ${d.estoque.toLocaleString('pt-BR')} Robux.`, flags: ephemeral });
    }

    let usuario = null;
    if (metodo === 'plus') {
      usuario = i.fields.getTextInputValue('usuario').trim();
      if (!/^[A-Za-z0-9_]{3,20}$/.test(usuario)) {
        return i.reply({
          content: 'Nome de usuário inválido. Use apenas letras, números e underline (3 a 20 caracteres).',
          flags: ephemeral
        });
      }
    }

    const aberto = Object.values(d.pedidos).find(
      p => p.userId === i.user.id && ['aguardando_pagamento', 'aguardando_confirmacao'].includes(p.status)
    );
    if (aberto) {
      return i.reply({ content: `Você já possui um pedido em aberto: <#${aberto.canal}>`, flags: ephemeral });
    }

    await i.deferReply({ flags: ephemeral });
    try {
      const canal = await criarTicket(i, q, metodo, usuario);
      return i.editReply(`Seu ticket foi criado: ${canal}`);
    } catch (err) {
      console.error('Erro ao criar o ticket:', err);
      return i.editReply('Não foi possível abrir o seu ticket agora. Avise a equipe, por favor.');
    }
  }
}

client.login(process.env.TOKEN);