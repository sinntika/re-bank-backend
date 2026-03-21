// ==========================================
// RE国際銀行 バックエンドサーバー v2
// 個人ローン / 国家ローン / 金利計算 / お知らせ
// ==========================================
const express      = require('express');
const cors         = require('cors');
const crypto       = require('crypto');
const cookieParser = require('cookie-parser');
const {
  Client, GatewayIntentBits, REST, Routes,
  SlashCommandBuilder, EmbedBuilder, Colors,
} = require('discord.js');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── 設定 ──────────────────────────────────
const C = {
  BOT_TOKEN:    process.env.DISCORD_BOT_TOKEN   || '',
  CLIENT_ID:    process.env.DISCORD_CLIENT_ID   || '',
  GUILD_ID:     '1484801069346459720',
  CH_ANNOUNCE:  process.env.DISCORD_ANNOUNCE_CH || '', // 全体お知らせチャンネルID
  SITE_URL:     process.env.SITE_URL            || 'https://rarala.online',
  COOKIE_SEC:   process.env.COOKIE_SECRET       || 'change-this',
  ADMIN_KEY:    process.env.ADMIN_KEY           || 'change-admin',
  TOKEN_EXP:    15,   // ログインURL有効期限(分)
  SESSION_DAYS: 30,
};

// ── 金利定数 ──────────────────────────────
const INTEREST = {
  personal: { rate: 0.20, cycleDays: 10,  deadlineDays: 180, minLoan: 1      },
  national: { rate: 0.20, cycleDays: 30,  deadlineDays: 365, minLoan: 1000000 },
};

// ── DB（メモリ） ───────────────────────────
const db = {
  users:      new Map(), // discordId → User
  loans:      new Map(), // loanId   → Loan
  extensions: new Map(), // extId    → Extension
  notices:    new Map(), // discordId → Notice[]
  tokens:     new Map(),
  sessions:   new Map(),
};

// ── ミドルウェア ──────────────────────────
app.use(cors({ origin: [C.SITE_URL, 'http://localhost'], credentials: true }));
app.use(express.json());
app.use(cookieParser(C.COOKIE_SEC));

// ==========================================
// 金利計算ユーティリティ
// ==========================================
function calcInterest(loan) {
  const rule     = INTEREST[loan.loanType] || INTEREST.personal;
  const now      = Date.now();
  const start    = new Date(loan.appliedAt).getTime();
  const elapsedDays = (now - start) / (1000 * 60 * 60 * 24);
  const cycles   = Math.floor(elapsedDays / rule.cycleDays);
  const interest = Math.floor(loan.principal * rule.rate * cycles);
  const total    = loan.principal + interest;
  const remain   = Math.max(0, total - (loan.paidAmount || 0));

  // 期日
  const deadlineMs = start + rule.deadlineDays * 24 * 60 * 60 * 1000;
  const deadlineDate = new Date(deadlineMs).toLocaleDateString('ja-JP');
  const overdue  = now > deadlineMs && loan.status === 'repaying';

  return { principal: loan.principal, interest, total, remain, cycles, deadlineDate, overdue };
}

// ==========================================
// ヘルパー
// ==========================================
function genId(prefix) {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${prefix}-${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}-${Math.floor(Math.random()*9000+1000)}`;
}

function genToken(discordId) {
  const tok = crypto.randomBytes(32).toString('hex');
  db.tokens.set(tok, { discordId, expiresAt: Date.now() + C.TOKEN_EXP * 60000 });
  return tok;
}

function createSession(res, discordId) {
  const sid = crypto.randomBytes(32).toString('hex');
  db.sessions.set(sid, { discordId, expiresAt: Date.now() + C.SESSION_DAYS * 86400000 });
  res.cookie('re_session', sid, {
    httpOnly: true, secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax', maxAge: C.SESSION_DAYS * 86400000, signed: true,
  });
}

function getUser(req) {
  const sid = req.signedCookies?.re_session;
  if (!sid) return null;
  const s = db.sessions.get(sid);
  if (!s || s.expiresAt < Date.now()) { db.sessions.delete(sid); return null; }
  return db.users.get(s.discordId) || null;
}

// 個人通知をDBに保存（ダッシュボード表示用）
function pushNotice(discordId, { title, body, color = 'blue', loanId = null }) {
  if (!db.notices.has(discordId)) db.notices.set(discordId, []);
  const list = db.notices.get(discordId);
  list.unshift({ id: crypto.randomBytes(8).toString('hex'), title, body, color, loanId, createdAt: new Date().toISOString(), read: false });
  if (list.length > 50) list.pop(); // 最大50件
}

// ==========================================
// Discord BOT
// ==========================================
const bot = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages, GatewayIntentBits.GuildMessages],
});

// スラッシュコマンド登録
async function registerCommands() {
  const cmds = [
    new SlashCommandBuilder().setName('login').setDescription('ダッシュボードのログインURLをDMで受け取る').toJSON(),
    new SlashCommandBuilder().setName('balance').setDescription('残高・金利・返済期限を確認する').toJSON(),
    new SlashCommandBuilder()
      .setName('announce')
      .setDescription('【運営専用】全体お知らせを投稿する')
      .addStringOption(o => o.setName('title').setDescription('タイトル').setRequired(true))
      .addStringOption(o => o.setName('message').setDescription('本文').setRequired(true))
      .addStringOption(o => o.setName('color').setDescription('色').setRequired(false)
        .addChoices(
          { name: '青（通常）', value: 'blue' },
          { name: '緑（良報）', value: 'green' },
          { name: '赤（警告）', value: 'red' },
          { name: '金（重要）', value: 'gold' },
        ))
      .toJSON(),
  ];
  const rest = new REST({ version: '10' }).setToken(C.BOT_TOKEN);
  try {
    await rest.put(Routes.applicationGuildCommands(C.CLIENT_ID, C.GUILD_ID), { body: cmds });
    console.log('✅ コマンド登録完了');
  } catch (e) { console.error('❌ コマンド登録失敗:', e.message); }
}

bot.once('ready', async () => { console.log(`✅ BOT起動: ${bot.user.tag}`); await registerCommands(); });

// ── 全体お知らせ投稿 ──
async function postGlobalAnnounce(embed) {
  if (!C.CH_ANNOUNCE) return;
  try { const ch = await bot.channels.fetch(C.CH_ANNOUNCE); await ch?.send({ embeds: [embed] }); }
  catch (e) { console.error('全体お知らせ失敗:', e.message); }
}

// ── 個人DM送信 ──
async function sendDM(discordId, embed) {
  try { const u = await bot.users.fetch(discordId); await u.send({ embeds: [embed] }); return true; }
  catch (e) { console.error('DM失敗:', e.message); return false; }
}

// ── ログインURL送信 ──
async function sendLoginDM(discordId) {
  const user = db.users.get(discordId);
  if (!user) return { ok: false, error: 'アカウントが見つかりません。先に申請してください。' };
  const token = genToken(discordId);
  const url   = `${C.SITE_URL}/dashboard.html?token=${token}`;
  const embed = new EmbedBuilder()
    .setColor(Colors.Blue).setTitle('🔑 ログインURL')
    .setDescription(`有効期限 **${C.TOKEN_EXP}分**`)
    .addFields({ name: 'プレイヤー', value: user.playerName, inline: true }, { name: '所属', value: user.country, inline: true }, { name: 'URL', value: url })
    .setFooter({ text: 'RE国際銀行 | rarala.online' }).setTimestamp();
  const ok = await sendDM(discordId, embed);
  return ok ? { ok: true } : { ok: false, error: 'DMを送れませんでした。DMを受け取れる設定か確認してください。' };
}

// ==========================================
// スラッシュコマンド処理
// ==========================================
bot.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  // /login
  if (interaction.commandName === 'login') {
    await interaction.deferReply({ ephemeral: true });
    const r = await sendLoginDM(interaction.user.id);
    await interaction.editReply({ content: r.ok ? '✅ DMにログインURLを送りました！' : `❌ ${r.error}` });
  }

  // /balance
  if (interaction.commandName === 'balance') {
    await interaction.deferReply({ ephemeral: true });
    const user = db.users.get(interaction.user.id);
    if (!user) return interaction.editReply({ content: '❌ アカウントがありません。まず申請してください。' });

    const myLoans = [...db.loans.values()].filter(l => l.discordId === interaction.user.id && !['rejected','completed'].includes(l.status));
    if (!myLoans.length) return interaction.editReply({ content: '📊 現在アクティブなローンはありません。' });

    const fields = myLoans.flatMap(loan => {
      const ci = calcInterest(loan);
      const typeLabel = loan.loanType === 'national' ? '🏛️ 国家' : '👤 個人';
      return [
        { name: `${typeLabel} \`${loan.loanId}\``, value: '\u200b', inline: false },
        { name: '元金',      value: `${ci.principal.toLocaleString()} G`, inline: true },
        { name: '利息',      value: `${ci.interest.toLocaleString()} G`,  inline: true },
        { name: '残返済額',  value: `${ci.remain.toLocaleString()} G`,    inline: true },
        { name: '返済期限',  value: ci.deadlineDate + (ci.overdue ? ' ⚠️期限超過' : ''), inline: true },
        { name: '金利サイクル', value: `${ci.cycles} サイクル経過`, inline: true },
      ];
    });

    const embed = new EmbedBuilder()
      .setColor(Colors.Blue).setTitle(`📊 ${user.playerName} の残高`)
      .addFields(fields)
      .setFooter({ text: 'RE国際銀行 | rarala.online' }).setTimestamp();
    await interaction.editReply({ embeds: [embed] });
  }

  // /announce（運営専用）
  if (interaction.commandName === 'announce') {
    await interaction.deferReply({ ephemeral: true });
    if (!interaction.member?.permissions?.has('ManageGuild'))
      return interaction.editReply({ content: '❌ 運営のみ使用できます。' });

    const colorMap = { blue: Colors.Blue, green: Colors.Green, red: Colors.Red, gold: Colors.Gold };
    const color = interaction.options.getString('color') || 'blue';
    const embed = new EmbedBuilder()
      .setColor(colorMap[color])
      .setTitle(`📢 ${interaction.options.getString('title')}`)
      .setDescription(interaction.options.getString('message'))
      .setFooter({ text: `RE国際銀行 | 投稿: ${interaction.user.username}` }).setTimestamp();

    await postGlobalAnnounce(embed);
    await interaction.editReply({ content: '✅ 全体お知らせを投稿しました！' });
  }
});

// ==========================================
// API — 申請・認証
// ==========================================

// ── 個人ローン申請 ──
app.post('/api/apply/personal', async (req, res) => {
  const { playerName, country, contact, plan, colAmount, screenshotUrl, loanAmount, purpose } = req.body;
  if (!playerName || !country || !contact || !plan || !colAmount || !screenshotUrl || !loanAmount || !purpose)
    return res.status(400).json({ ok: false, error: '必須項目が不足しています。' });

  const discordId = contact?.match(/\d{17,20}/)?.[0];
  if (!discordId) return res.status(400).json({ ok: false, error: '連絡先にDiscord IDが見つかりません。' });

  if (!db.users.has(discordId))
    db.users.set(discordId, { discordId, playerName, country, contact, type: 'personal', createdAt: new Date().toISOString() });

  const loanId    = genId('RE');
  const principal = Number(loanAmount);
  const rule      = INTEREST.personal;
  const deadline  = new Date(Date.now() + rule.deadlineDays * 86400000).toLocaleDateString('ja-JP');

  db.loans.set(loanId, {
    loanId, discordId, playerName, country, loanType: 'personal',
    plan, colAmount: Number(colAmount), colTotal: Number(colAmount) * Number(plan),
    screenshotUrl, principal, loanAmount: principal,
    purpose, status: 'pending',
    appliedAt: new Date().toISOString(),
    paidAmount: 0, note: '',
  });

  // 個人通知保存
  pushNotice(discordId, {
    title: '📋 申請を受け付けました',
    body: `申請ID: ${loanId}\n借入希望額: ${principal.toLocaleString()} G\n返済期限: ${deadline}\n金利: 10日ごとに元金の20%`,
    color: 'blue', loanId,
  });

  // DM通知
  const dmEmbed = new EmbedBuilder()
    .setColor(Colors.Blue).setTitle('📋 個人ローン申請を受け付けました')
    .addFields(
      { name: '申請ID',     value: loanId,                        inline: false },
      { name: '借入希望額', value: `${principal.toLocaleString()} G`, inline: true },
      { name: '返済期限',   value: deadline,                      inline: true },
      { name: '金利',       value: '10日ごとに元金の20%（単利）', inline: false },
      { name: '目的',       value: purpose,                       inline: false },
    )
    .setDescription('審査完了（最大24時間）後にお知らせします。')
    .setFooter({ text: 'RE国際銀行 | rarala.online' }).setTimestamp();
  await sendDM(discordId, dmEmbed);

  res.json({ ok: true, loanId, deadline });
});

// ── 国家ローン申請 ──
app.post('/api/apply/national', async (req, res) => {
  const { playerName, country, contact, screenshotUrl, proofUrl, loanAmount, purpose } = req.body;
  if (!playerName || !country || !contact || !screenshotUrl || !proofUrl || !loanAmount || !purpose)
    return res.status(400).json({ ok: false, error: '必須項目が不足しています。' });

  const principal = Number(loanAmount);
  if (principal < INTEREST.national.minLoan)
    return res.status(400).json({ ok: false, error: `国家ローンの最低貸出額は ${INTEREST.national.minLoan.toLocaleString()} G です。` });

  const discordId = contact?.match(/\d{17,20}/)?.[0];
  if (!discordId) return res.status(400).json({ ok: false, error: '連絡先にDiscord IDが見つかりません。' });

  if (!db.users.has(discordId))
    db.users.set(discordId, { discordId, playerName, country, contact, type: 'national', createdAt: new Date().toISOString() });

  const loanId   = genId('REN');
  const rule     = INTEREST.national;
  const deadline = new Date(Date.now() + rule.deadlineDays * 86400000).toLocaleDateString('ja-JP');

  db.loans.set(loanId, {
    loanId, discordId, playerName, country, loanType: 'national',
    screenshotUrl, proofUrl,
    principal, loanAmount: principal,
    purpose, status: 'pending_proof', // 証明書審査待ち
    appliedAt: new Date().toISOString(),
    paidAmount: 0, note: '',
  });

  pushNotice(discordId, {
    title: '🏛️ 国家ローン申請を受け付けました',
    body: `申請ID: ${loanId}\n借入希望額: ${principal.toLocaleString()} G\n現在: 証明書審査待ち\n返済期限（承認後）: 12ヶ月以内`,
    color: 'gold', loanId,
  });

  const dmEmbed = new EmbedBuilder()
    .setColor(Colors.Gold).setTitle('🏛️ 国家ローン申請を受け付けました')
    .addFields(
      { name: '申請ID',       value: loanId,                        inline: false },
      { name: '借入希望額',   value: `${principal.toLocaleString()} G`, inline: true },
      { name: '返済期限',     value: '承認後12ヶ月以内',            inline: true },
      { name: '金利',         value: '30日ごとに元金の20%（単利）', inline: false },
      { name: 'ステータス',   value: '⏳ 証明書審査待ち',           inline: false },
    )
    .setDescription('運営が証明書を別途審査します。審査完了後にDMでお知らせします。\n延長については担当者にお問い合わせください。')
    .setFooter({ text: 'RE国際銀行 | rarala.online' }).setTimestamp();
  await sendDM(discordId, dmEmbed);

  res.json({ ok: true, loanId });
});

// ── 延長申請（個人） ──
app.post('/api/apply/extension', async (req, res) => {
  const { loanId, contact, reason, desiredDays } = req.body;
  if (!loanId || !contact || !reason)
    return res.status(400).json({ ok: false, error: '必須項目が不足しています。' });

  const loan = db.loans.get(loanId);
  if (!loan) return res.status(404).json({ ok: false, error: '申請IDが見つかりません。' });

  const discordId = contact?.match(/\d{17,20}/)?.[0];
  if (!discordId || discordId !== loan.discordId)
    return res.status(403).json({ ok: false, error: '申請者本人のDiscord IDを入力してください。' });

  const extId = genId('EXT');
  db.extensions.set(extId, {
    extId, loanId, discordId,
    reason, desiredDays: Number(desiredDays) || 30,
    status: 'pending',
    appliedAt: new Date().toISOString(),
  });

  pushNotice(discordId, {
    title: '📅 延長申請を受け付けました',
    body: `延長申請ID: ${extId}\n対象ローン: ${loanId}\n理由: ${reason}`,
    color: 'blue', loanId,
  });

  const dmEmbed = new EmbedBuilder()
    .setColor(Colors.Blue).setTitle('📅 延長申請を受け付けました')
    .addFields(
      { name: '延長申請ID', value: extId,    inline: true },
      { name: '対象ローン', value: loanId,   inline: true },
      { name: '希望延長日数', value: `${desiredDays || 30} 日`, inline: true },
      { name: '理由', value: reason, inline: false },
    )
    .setDescription('審査後にDMでお知らせします。')
    .setFooter({ text: 'RE国際銀行 | rarala.online' }).setTimestamp();
  await sendDM(discordId, dmEmbed);

  res.json({ ok: true, extId });
});

// ── Web ログインDMリクエスト ──
app.post('/api/auth/request-login', async (req, res) => {
  const { discordId } = req.body;
  if (!discordId || !/^\d{17,20}$/.test(discordId))
    return res.status(400).json({ ok: false, error: '正しいDiscord IDを入力してください。' });
  const r = await sendLoginDM(discordId);
  res.status(r.ok ? 200 : 400).json(r);
});

// ── トークン検証 ──
app.post('/api/auth/verify-token', (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ ok: false, error: 'トークンがありません。' });
  const rec = db.tokens.get(token);
  if (!rec) return res.status(401).json({ ok: false, error: 'URLが無効です。' });
  if (rec.expiresAt < Date.now()) { db.tokens.delete(token); return res.status(401).json({ ok: false, error: 'URLの有効期限が切れています。' }); }
  db.tokens.delete(token);
  createSession(res, rec.discordId);
  res.json({ ok: true, user: db.users.get(rec.discordId) });
});

app.get('/api/auth/me', (req, res) => {
  const u = getUser(req);
  if (!u) return res.status(401).json({ ok: false });
  res.json({ ok: true, user: u });
});

app.post('/api/auth/logout', (req, res) => {
  const sid = req.signedCookies?.re_session;
  if (sid) db.sessions.delete(sid);
  res.clearCookie('re_session');
  res.json({ ok: true });
});

// ── 自分のローン一覧（金利計算付き） ──
app.get('/api/loans/mine', (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ ok: false, error: 'ログインが必要です。' });
  const loans = [...db.loans.values()]
    .filter(l => l.discordId === user.discordId)
    .sort((a, b) => new Date(b.appliedAt) - new Date(a.appliedAt))
    .map(l => ({ ...l, calc: calcInterest(l) }));
  res.json({ ok: true, loans });
});

// ── 自分の通知一覧 ──
app.get('/api/notices/mine', (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ ok: false, error: 'ログインが必要です。' });
  const notices = db.notices.get(user.discordId) || [];
  res.json({ ok: true, notices });
});

// ── 通知を既読に ──
app.post('/api/notices/read', (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ ok: false });
  const { id } = req.body;
  const notices = db.notices.get(user.discordId) || [];
  const n = notices.find(n => n.id === id);
  if (n) n.read = true;
  res.json({ ok: true });
});

// ── 運営：全ローン ──
app.get('/api/admin/loans', (req, res) => {
  if (req.headers['x-admin-key'] !== C.ADMIN_KEY) return res.status(403).json({ ok: false });
  const loans = [...db.loans.values()]
    .sort((a, b) => new Date(b.appliedAt) - new Date(a.appliedAt))
    .map(l => ({ ...l, calc: calcInterest(l) }));
  res.json({ ok: true, loans, users: db.users.size });
});

// ── 運営：ステータス更新 + 個人・全体お知らせ ──
app.post('/api/admin/loans/:loanId', async (req, res) => {
  if (req.headers['x-admin-key'] !== C.ADMIN_KEY) return res.status(403).json({ ok: false });
  const loan = db.loans.get(req.params.loanId);
  if (!loan) return res.status(404).json({ ok: false, error: '申請が見つかりません。' });

  const { status, paidAmount, note } = req.body;
  if (status !== undefined)     loan.status     = status;
  if (paidAmount !== undefined) loan.paidAmount = Number(paidAmount);
  if (note !== undefined)       loan.note       = note;

  const ci    = calcInterest(loan);
  const isNat = loan.loanType === 'national';

  const statusConfigs = {
    approved: {
      dmColor: Colors.Green, dmTitle: `✅ ${isNat ? '国家' : '個人'}ローンが承認されました！`,
      dmBody: `ゲーム内で ${loan.principal.toLocaleString()} G を付与しました。\n返済は本店の返済SHOPで行ってください。`,
      noticeColor: 'green',
      annColor: Colors.Green, annTitle: `✅ ${isNat ? '国家' : '個人'}ローン承認`,
    },
    rejected: {
      dmColor: Colors.Red, dmTitle: '❌ 申請が否認されました',
      dmBody: `理由: ${note || '記載なし'}\n担保はゲーム内で返却します。`,
      noticeColor: 'red',
      annColor: Colors.Red, annTitle: '❌ 貸出否認',
    },
    repaying: {
      dmColor: Colors.Yellow, dmTitle: '💸 返済を確認しました',
      dmBody: `返済済み: ${loan.paidAmount.toLocaleString()} G\n残返済額: ${ci.remain.toLocaleString()} G\n（利息込み合計: ${ci.total.toLocaleString()} G）`,
      noticeColor: 'blue',
      annColor: null, annTitle: null,
    },
    completed: {
      dmColor: Colors.Gold, dmTitle: '🎉 完済しました！',
      dmBody: '担保をゲーム内で返却します。ご利用ありがとうございました！',
      noticeColor: 'green',
      annColor: Colors.Gold, annTitle: '🎉 完済',
    },
    pending_proof: {
      dmColor: Colors.Blue, dmTitle: '📋 証明書を受け付けました',
      dmBody: '運営が国の代表者証明を審査します。結果はDMでお知らせします。',
      noticeColor: 'blue',
      annColor: null, annTitle: null,
    },
  };

  const cfg = statusConfigs[status];
  if (cfg) {
    // 個人DM
    const dmEmbed = new EmbedBuilder()
      .setColor(cfg.dmColor).setTitle(cfg.dmTitle)
      .setDescription(cfg.dmBody)
      .addFields({ name: '申請ID', value: loan.loanId, inline: true })
      .setFooter({ text: 'RE国際銀行 | rarala.online' }).setTimestamp();
    await sendDM(loan.discordId, dmEmbed);

    // ダッシュボード通知
    pushNotice(loan.discordId, {
      title: cfg.dmTitle, body: cfg.dmBody,
      color: cfg.noticeColor, loanId: loan.loanId,
    });
  }

  res.json({ ok: true, loan: { ...loan, calc: calcInterest(loan) } });
});

// ── 運営：延長申請一覧 ──
app.get('/api/admin/extensions', (req, res) => {
  if (req.headers['x-admin-key'] !== C.ADMIN_KEY) return res.status(403).json({ ok: false });
  const exts = [...db.extensions.values()].sort((a, b) => new Date(b.appliedAt) - new Date(a.appliedAt));
  res.json({ ok: true, extensions: exts });
});

// ── 運営：延長申請を処理 ──
app.post('/api/admin/extensions/:extId', async (req, res) => {
  if (req.headers['x-admin-key'] !== C.ADMIN_KEY) return res.status(403).json({ ok: false });
  const ext = db.extensions.get(req.params.extId);
  if (!ext) return res.status(404).json({ ok: false });

  const { approved, addDays, note } = req.body;
  ext.status = approved ? 'approved' : 'rejected';
  ext.note   = note || '';

  if (approved && addDays) {
    const loan = db.loans.get(ext.loanId);
    if (loan) {
      // 期限を延長（appliedAtを基準日にしているので別途deadlineExtendedを持つ）
      loan.deadlineExtended = (loan.deadlineExtended || 0) + Number(addDays);
    }
  }

  const loan = db.loans.get(ext.loanId);
  const msg  = approved
    ? `延長申請が承認されました。${addDays} 日延長します。`
    : `延長申請が否認されました。理由: ${note || '記載なし'}`;

  pushNotice(ext.discordId, { title: approved ? '📅 延長承認' : '📅 延長否認', body: msg, color: approved ? 'green' : 'red', loanId: ext.loanId });

  await sendDM(ext.discordId, new EmbedBuilder()
    .setColor(approved ? Colors.Green : Colors.Red)
    .setTitle(approved ? '📅 延長申請が承認されました' : '📅 延長申請が否認されました')
    .setDescription(msg)
    .addFields({ name: '対象ローン', value: ext.loanId, inline: true })
    .setFooter({ text: 'RE国際銀行 | rarala.online' }).setTimestamp());

  res.json({ ok: true, extension: ext });
});

// ── 運営：手動お知らせ（個人指定 or 全体） ──
app.post('/api/admin/announce', async (req, res) => {
  if (req.headers['x-admin-key'] !== C.ADMIN_KEY) return res.status(403).json({ ok: false });
  const { title, message, color, targetDiscordId } = req.body;
  if (!message) return res.status(400).json({ ok: false, error: 'messageが必要です。' });

  const colorMap = { blue: Colors.Blue, green: Colors.Green, red: Colors.Red, gold: Colors.Gold };
  const embed = new EmbedBuilder()
    .setColor(colorMap[color] || Colors.Blue)
    .setTitle(`📢 ${title || 'RE国際銀行 お知らせ'}`)
    .setDescription(message)
    .setFooter({ text: 'RE国際銀行 | rarala.online' }).setTimestamp();

  if (targetDiscordId) {
    // 個人宛て
    pushNotice(targetDiscordId, { title: title || 'お知らせ', body: message, color: color || 'blue' });
    await sendDM(targetDiscordId, embed);
    res.json({ ok: true, type: 'personal' });
  } else {
    // 全体
    await postGlobalAnnounce(embed);
    res.json({ ok: true, type: 'global' });
  }
});

// ==========================================
// 起動
// ==========================================
app.listen(PORT, () => console.log(`🚀 サーバー起動 → http://localhost:${PORT}`));
bot.login(C.BOT_TOKEN);
